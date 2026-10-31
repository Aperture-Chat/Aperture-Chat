/**
 * Finds a cited passage in the text a page actually shows.
 *
 * The indexed excerpt and the page's text come from different extractors, so
 * they disagree on whitespace, line-end hyphens, ligatures, quotes, and
 * sometimes reading order. Both sides are reduced to a fingerprint of letters
 * and digits, each fingerprint unit remembering where it came from, and the
 * match runs on fingerprints. A match never reaches into text the excerpt does
 * not contain, so a wrong highlight is rarer than a missing one: when the page
 * cannot be matched the caller shows the excerpt instead of guessing.
 */

export type PassageRange = { part: number; start: number; end: number };
export type PassageLocation = { chunk: PassageRange[]; passage: PassageRange[] };
export type MarkLevel = "none" | "tint" | "solid";
export type LayeredPiece = { text: string; level: MarkLevel };

/** Shortest stretch accepted as evidence when the whole excerpt is not there. */
const MIN_RUN = 20;
/** Total evidence required before a partial match may be highlighted. */
const MIN_MATCHED = 60;

const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const COMBINING_MARK = /\p{M}/u;

type Origin = { part: number; start: number; end: number };
type Fingerprint = { text: string; origins: Origin[] };
/** A stretch of the page, and where the same words begin in what was sought. */
type Run = { start: number; end: number; wantedAt: number };

/** Compatibility decomposition splits ligatures and pulls accents off as marks,
 * which the filter drops, so "é" and "e" plus a combining accent agree. */
function foldCharacter(character: string): string {
  return Array.from(character.normalize("NFKD").toLowerCase())
    .filter((unit) => WORD_CHARACTER.test(unit))
    .join("");
}

function fingerprint(parts: readonly string[]): Fingerprint {
  const units: string[] = [];
  const origins: Origin[] = [];
  parts.forEach((part, index) => {
    let offset = 0;
    for (const character of part) {
      const end = offset + character.length;
      const folded = foldCharacter(character);
      units.push(folded);
      for (let unit = 0; unit < folded.length; unit += 1) origins.push({ part: index, start: offset, end });
      offset = end;
    }
  });
  return { text: units.join(""), origins };
}

function seedIndex(text: string): Map<string, number[]> {
  const seeds = new Map<string, number[]>();
  for (let at = 0; at + MIN_RUN <= text.length; at += 1) {
    const seed = text.slice(at, at + MIN_RUN);
    const positions = seeds.get(seed);
    if (positions) positions.push(at);
    else seeds.set(seed, [at]);
  }
  return seeds;
}

function sharedLength(page: string, pageAt: number, wanted: string, wantedAt: number): number {
  let length = 0;
  while (wantedAt + length < wanted.length && page[pageAt + length] === wanted[wantedAt + length]) length += 1;
  return length;
}

/** The longest stretch from `wantedAt`; the earliest wins a tie. */
function longestRunAt(page: string, wanted: string, wantedAt: number, candidates: number[]): Run {
  return candidates
    .map((pageAt) => ({ start: pageAt, end: pageAt + sharedLength(page, pageAt, wanted, wantedAt), wantedAt }))
    .reduce((best, run) => (run.end - run.start > best.end - best.start ? run : best));
}

/** Evidence runs of the excerpt on this page, or nothing when too little of it
 * is here to be sure. The excerpt may spill onto another page, or a running
 * header may split it. */
function partialRuns(page: string, wanted: string): Run[] {
  const seeds = seedIndex(page);
  const runs: Run[] = [];
  let at = 0;
  while (at + MIN_RUN <= wanted.length) {
    const candidates = seeds.get(wanted.slice(at, at + MIN_RUN));
    if (!candidates) {
      at += 1;
      continue;
    }
    const run = longestRunAt(page, wanted, at, candidates);
    runs.push(run);
    at += run.end - run.start;
  }
  const matched = runs.reduce((total, run) => total + run.end - run.start, 0);
  return matched >= MIN_MATCHED ? runs : [];
}

function isWordAt(text: string, index: number): boolean {
  return WORD_CHARACTER.test(text.charAt(index));
}

/** A range never ends between a letter and its combining accent. */
function pastAccents(text: string, end: number): number {
  let at = end;
  while (COMBINING_MARK.test(text.charAt(at))) at += 1;
  return at;
}

/** Stored chunks overlap by character count, so one can start or stop inside a
 * word. A mark moves to the next whole word in, never out into uncited text. */
function snapStart(text: string, start: number): number {
  if (!isWordAt(text, start - 1) || !isWordAt(text, start)) return start;
  let at = start;
  while (isWordAt(text, at)) at += 1;
  while (at < text.length && !isWordAt(text, at)) at += 1;
  return at;
}

function snapEnd(text: string, end: number): number {
  if (!isWordAt(text, end)) return end;
  let at = end;
  while (isWordAt(text, at - 1)) at -= 1;
  while (at > 0 && !isWordAt(text, at - 1)) at -= 1;
  return at;
}

/** Where a range ends: on a whole word, with its accents. */
function closingEdge(text: string, end: number): number {
  return pastAccents(text, snapEnd(text, end));
}

/** Spans fully inside a run are marked edge to edge, so the punctuation the
 * fingerprint dropped does not leave holes in the highlight. */
function rangesForRun(parts: readonly string[], origins: Origin[], run: Run): PassageRange[] {
  const first = origins[run.start];
  const last = origins[run.end - 1];
  const opening = snapStart(parts[first.part], first.start);
  if (first.part === last.part) return [{ part: first.part, start: opening, end: closingEdge(parts[last.part], last.end) }];
  const ranges: PassageRange[] = [{ part: first.part, start: opening, end: parts[first.part].length }];
  for (let part = first.part + 1; part < last.part; part += 1) {
    ranges.push({ part, start: 0, end: parts[part].length });
  }
  ranges.push({ part: last.part, start: 0, end: closingEdge(parts[last.part], last.end) });
  return ranges;
}

function mergeRanges(ranges: PassageRange[]): PassageRange[] {
  const ordered = ranges.filter((range) => range.end > range.start).sort((a, b) => a.part - b.part || a.start - b.start);
  const merged: PassageRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && previous.part === range.part && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function foldedText(text: string): string {
  return fingerprint([text]).text;
}

function runsFor(page: string, wanted: string): Run[] {
  if (!wanted) return [];
  const exact = page.indexOf(wanted);
  return exact >= 0 ? [{ start: exact, end: exact + wanted.length, wantedAt: 0 }] : partialRuns(page, wanted);
}

/** The parts of a chunk's stretches on this page that fall inside `[from, to)`
 * of the chunk. Each stretch has already earned its place as evidence, so a
 * sentence's short tail on the next page needs no evidence of its own. */
function clipRuns(chunk: Run[], from: number, to: number): Run[] {
  return chunk.flatMap((run) => {
    const first = Math.max(run.wantedAt, from);
    const last = Math.min(run.wantedAt + run.end - run.start, to);
    if (first >= last) return [];
    const start = run.start + first - run.wantedAt;
    return [{ start, end: start + last - first, wantedAt: first }];
  });
}

/** The cited sentence, found through the chunk it came from: a phrase can repeat
 * on a page, and a sentence can cross one. Searched for directly only when the
 * chunk is not on this page or does not hold it. */
function sentenceRuns(page: string, excerpt: string, sentence: string, chunk: Run[]): Run[] {
  if (!sentence) return [];
  const at = chunk.length ? excerpt.indexOf(sentence) : -1;
  return at >= 0 ? clipRuns(chunk, at, at + sentence.length) : runsFor(page, sentence);
}

function rangesFor(parts: readonly string[], page: Fingerprint, runs: Run[]): PassageRange[] {
  return mergeRanges(runs.flatMap((run) => rangesForRun(parts, page.origins, run)));
}

/** Where `excerpt` sits in `parts`, in reading order. Empty means not found. */
export function findPassage(parts: readonly string[], excerpt: string): PassageRange[] {
  const page = fingerprint(parts);
  return rangesFor(parts, page, runsFor(page.text, foldedText(excerpt)));
}

/** Where a chunk sits on a page, and the sentence of it that was cited. */
export function locatePassage(parts: readonly string[], excerpt: string, passage: string | null): PassageLocation {
  const page = fingerprint(parts);
  const wanted = foldedText(excerpt);
  const chunk = runsFor(page.text, wanted);
  const sentence = passage === null ? [] : sentenceRuns(page.text, wanted, foldedText(passage), chunk);
  return { chunk: rangesFor(parts, page, chunk), passage: rangesFor(parts, page, sentence) };
}

/** Marked pieces of a page as one readable line. A page's text layer spells words
 * properly where extraction left "Sta ff ord", but keeps its line-end hyphens. */
export function readableMarks(pieces: readonly string[]): string {
  const joined = pieces.reduce((text, piece) => {
    const next = piece.trim();
    if (!text || !next) return text || next;
    const hyphenated = /\p{L}-$/u.test(text) && /^\p{Ll}/u.test(next);
    return hyphenated ? `${text.slice(0, -1)}${next}` : `${text} ${next}`;
  }, "");
  return joined.replace(/\s+/g, " ");
}

/** True when `passage` really is part of `excerpt`. A stored citation is
 * untrusted, so only text the server's own excerpt holds is ever shown. */
export function passageWithin(excerpt: string, passage: string): boolean {
  const wanted = foldedText(passage);
  return wanted.length > 0 && foldedText(excerpt).includes(wanted);
}

type Span = { start: number; end: number };

/** Cuts one text into plain, tinted, and solid pieces. A solid range wins. */
export function layerPieces(text: string, tint: readonly Span[], solid: readonly Span[]): LayeredPiece[] {
  const edges = [...tint, ...solid].flatMap(({ start, end }) => [start, end]);
  const cuts = [...new Set([0, text.length, ...edges])].sort((a, b) => a - b);
  const covers = (ranges: readonly Span[], at: number) => ranges.some(({ start, end }) => at >= start && at < end);
  const level = (at: number): MarkLevel => (covers(solid, at) ? "solid" : covers(tint, at) ? "tint" : "none");
  return cuts.slice(1).map((end, index) => ({ text: text.slice(cuts[index], end), level: level(cuts[index]) }));
}
