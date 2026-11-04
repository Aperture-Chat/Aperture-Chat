/**
 * Three-way merge for drafts two people edit at once.
 *
 * Every live save names the copy it started from (`base`). When someone else
 * saved first (`theirs`), the local edits (`mine`) are merged onto theirs:
 *
 * - documents (sanitized HTML) merge by block, then by word inside a block
 *   both people touched, with tags kept whole so markup never splits;
 * - decks and spreadsheets (JSON) merge by structure: objects key by key,
 *   lists of objects with an `id` (slides, sheets, charts…) item by item.
 *
 * Where both people changed the same thing, `mine` wins, except that two
 * insertions at the same spot keep both (theirs first). The person whose
 * save lost the race is the one merging, and their next save carries the
 * result to everyone, so every editor converges on the same copy.
 */

export type MergeResult<T> = { value: T; conflicts: number };

export type ConflictRegion<T> = { base: T[]; mine: T[]; theirs: T[] };

type Diff3Options<T> = {
  equal: (a: T, b: T) => boolean;
  /** Resolves a region both sides changed differently. */
  conflict: (region: ConflictRegion<T>) => T[];
};

/** A base range [baseStart, baseEnd) one side replaced with side[sideStart, sideEnd). */
type Hunk = { baseStart: number; baseEnd: number; sideStart: number; sideEnd: number; side: 0 | 1 };

/** Beyond this many edits the diff stops and treats the middle as one change. */
const MAX_EDIT_DISTANCE = 1500;

/**
 * Matched index pairs of a longest common subsequence (Myers O(ND)), after
 * trimming the shared prefix and suffix. Falls back to "everything between
 * the prefix and suffix changed" past MAX_EDIT_DISTANCE.
 */
export function commonSubsequence<T>(
  a: T[],
  b: T[],
  equal: (x: T, y: T) => boolean,
  maxEdits = MAX_EDIT_DISTANCE,
): Array<[number, number]> {
  let start = 0;
  while (start < a.length && start < b.length && equal(a[start], b[start])) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && equal(a[endA - 1], b[endB - 1])) {
    endA -= 1;
    endB -= 1;
  }
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index < start; index += 1) pairs.push([index, index]);
  pairs.push(...myersMiddle({ a, b, a0: start, b0: start, n: endA - start, m: endB - start, equal, maxEdits }));
  for (let offset = 0; endA + offset < a.length; offset += 1) pairs.push([endA + offset, endB + offset]);
  return pairs;
}

type MyersRun<T> = {
  a: T[];
  b: T[];
  a0: number;
  b0: number;
  n: number;
  m: number;
  equal: (x: T, y: T) => boolean;
  maxEdits: number;
};

/** Whether the path onto diagonal k comes down from k+1 (else right from k-1). */
function comesDown(furthest: (k: number) => number, k: number, d: number): boolean {
  return k === -d || (k !== d && furthest(k - 1) < furthest(k + 1));
}

/** Follows matching items diagonally from (x, x-k). */
function slide<T>(run: MyersRun<T>, x: number, k: number): number {
  let end = x;
  while (end < run.n && end - k < run.m && run.equal(run.a[run.a0 + end], run.b[run.b0 + end - k])) end += 1;
  return end;
}

/** Forward pass: per edit count d, the furthest x reached on each diagonal
 * before step d. Null when the edit distance passes the cap. */
function myersTrace<T>(run: MyersRun<T>): Int32Array[] | null {
  const max = Math.min(run.n + run.m, run.maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const furthest = (k: number) => v[offset + k];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const x = slide(run, comesDown(furthest, k, d) ? furthest(k + 1) : furthest(k - 1) + 1, k);
      v[offset + k] = x;
      if (x >= run.n && x - k >= run.m) return trace;
    }
  }
  return null;
}

/** Walks the trace back from (n, m); each step's diagonal run is a match. */
function myersMatches<T>(run: MyersRun<T>, trace: Int32Array[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = run.n;
  let y = run.m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const step = trace[d];
    const furthest = (k: number) => step[k + d + 1];
    const k = x - y;
    const prevK = comesDown(furthest, k, d) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : furthest(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    for (; x > prevX && y > prevY; x -= 1, y -= 1) pairs.push([run.a0 + x - 1, run.b0 + y - 1]);
    x = prevX;
    y = prevY;
  }
  return pairs.reverse();
}

function myersMiddle<T>(run: MyersRun<T>): Array<[number, number]> {
  const trace = myersTrace(run);
  return trace ? myersMatches(run, trace) : [];
}

/** Matched index pairs of a longest common subsequence by Myers' O(ND)
 * algorithm alone, without the prefix and suffix trim (for tests). */
export function myersCommonSubsequence<T>(
  a: T[],
  b: T[],
  equal: (x: T, y: T) => boolean,
  maxEdits = MAX_EDIT_DISTANCE,
): Array<[number, number]> {
  return myersMiddle({ a, b, a0: 0, b0: 0, n: a.length, m: b.length, equal, maxEdits });
}

function hunksOf<T>(base: T[], side: T[], sideIndex: 0 | 1, equal: (x: T, y: T) => boolean): Hunk[] {
  const hunks: Hunk[] = [];
  let baseAt = 0;
  let sideAt = 0;
  const close = (baseEnd: number, sideEnd: number) => {
    if (baseEnd > baseAt || sideEnd > sideAt) {
      hunks.push({ baseStart: baseAt, baseEnd, sideStart: sideAt, sideEnd, side: sideIndex });
    }
  };
  for (const [baseIndex, sideIdx] of commonSubsequence(base, side, equal)) {
    close(baseIndex, sideIdx);
    baseAt = baseIndex + 1;
    sideAt = sideIdx + 1;
  }
  close(base.length, side.length);
  return hunks;
}

/** The slice of one side that corresponds to base[groupStart, groupEnd). */
function sideSlice<T>(base: T[], side: T[], hunks: Hunk[], groupStart: number, groupEnd: number): T[] {
  if (!hunks.length) return base.slice(groupStart, groupEnd);
  const first = hunks[0];
  const last = hunks[hunks.length - 1];
  return side.slice(first.sideStart - (first.baseStart - groupStart), last.sideEnd + (groupEnd - last.baseEnd));
}

/** Standard diff3 over item sequences. */
export function diff3<T>(base: T[], mine: T[], theirs: T[], options: Diff3Options<T>): { items: T[]; conflicts: number } {
  // Insertions sort before a change starting at the same spot, so "typed
  // just before the word they edited" is two separate, clean edits.
  const all = [...hunksOf(base, mine, 0, options.equal), ...hunksOf(base, theirs, 1, options.equal)].sort(
    (left, right) => left.baseStart - right.baseStart || left.baseEnd - right.baseEnd || left.side - right.side,
  );
  const items: T[] = [];
  let conflicts = 0;
  let position = 0;
  for (const group of groupHunks(all)) {
    const groupStart = Math.min(...group.map((hunk) => hunk.baseStart));
    const groupEnd = Math.max(...group.map((hunk) => hunk.baseEnd));
    items.push(...base.slice(position, groupStart));
    const mineHunks = group.filter((hunk) => hunk.side === 0);
    const theirHunks = group.filter((hunk) => hunk.side === 1);
    const mineSlice = sideSlice(base, mine, mineHunks, groupStart, groupEnd);
    const theirSlice = sideSlice(base, theirs, theirHunks, groupStart, groupEnd);
    if (!theirHunks.length) {
      items.push(...mineSlice);
    } else if (!mineHunks.length || sameItems(mineSlice, theirSlice, options.equal)) {
      items.push(...theirSlice);
    } else {
      conflicts += 1;
      items.push(...options.conflict({ base: base.slice(groupStart, groupEnd), mine: mineSlice, theirs: theirSlice }));
    }
    position = groupEnd;
  }
  items.push(...base.slice(position));
  return { items, conflicts };
}

/** Sorted hunks into runs that touch the same base items. */
function groupHunks(sorted: Hunk[]): Hunk[][] {
  const groups: Hunk[][] = [];
  let start = 0;
  let end = 0;
  for (const hunk of sorted) {
    const current = groups[groups.length - 1];
    if (current && overlaps(hunk, start, end)) {
      current.push(hunk);
      end = Math.max(end, hunk.baseEnd);
    } else {
      groups.push([hunk]);
      start = hunk.baseStart;
      end = hunk.baseEnd;
    }
  }
  return groups;
}

/** Ranges overlap when they share a base item; insertions overlap only an
 * insertion at the same spot or a change that spans them. */
function overlaps(next: Hunk, groupStart: number, groupEnd: number): boolean {
  if (next.baseStart < groupEnd) return true;
  return next.baseStart === groupEnd && next.baseStart === next.baseEnd && groupStart === groupEnd;
}

function sameItems<T>(left: T[], right: T[], equal: (x: T, y: T) => boolean): boolean {
  return left.length === right.length && left.every((item, index) => equal(item, right[index]));
}

/** Both inserted at one spot: keep both, theirs first. Otherwise mine wins. */
function keepBothInsertionsElseMine<T>(region: ConflictRegion<T>): T[] {
  return region.base.length === 0 ? [...region.theirs, ...region.mine] : region.mine;
}

/* --------------------------------------------------------------- documents */

// The last alternative keeps a stray "<" (never in serialized HTML) so
// tokenizing is always lossless.
const TOKEN = /<[^>]*>|[^\S\n]+|\n+|[^\s<]+|</g;
const BLOCK_END = /^<\/(p|h[1-6]|li|ul|ol|table|thead|tbody|tr|blockquote|section|div|pre|figure|figcaption)\s*>$/i;
const VOID_BLOCK = /^<(hr|br)\b[^>]*>$/i;

/** Tags as whole tokens; text as words, runs of spaces, and line breaks. */
export function tokenizeHtml(html: string): string[] {
  return Array.from(html.matchAll(TOKEN), (match) => match[0]);
}

/** Tokens grouped into blocks, each ending at a block's closing tag or a rule/break. */
export function htmlBlocks(tokens: string[]): string[] {
  const blocks: string[] = [];
  let current = "";
  for (const token of tokens) {
    current += token;
    if (BLOCK_END.test(token) || VOID_BLOCK.test(token)) {
      blocks.push(current);
      current = "";
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

const sameString = (left: string, right: string) => left === right;

export function mergeDraftHtml(base: string, mine: string, theirs: string): MergeResult<string> {
  if (mine === theirs || base === theirs) return { value: mine, conflicts: 0 };
  if (base === mine) return { value: theirs, conflicts: 0 };
  let conflicts = 0;
  const blocks = diff3(htmlBlocks(tokenizeHtml(base)), htmlBlocks(tokenizeHtml(mine)), htmlBlocks(tokenizeHtml(theirs)), {
    equal: sameString,
    // Both people changed the same blocks: merge those blocks word by word.
    conflict: (region) => {
      const words = diff3(tokenizeHtml(region.base.join("")), tokenizeHtml(region.mine.join("")), tokenizeHtml(region.theirs.join("")), {
        equal: sameString,
        conflict: keepBothInsertionsElseMine,
      });
      conflicts += words.conflicts;
      return [words.items.join("")];
    },
  });
  return { value: blocks.items.join(""), conflicts };
}

/* ----------------------------------------------------------- decks, sheets */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameJson(left[key], right[key]));
  }
  return false;
}

function hasIds(list: unknown): list is JsonObject[] {
  return Array.isArray(list) && list.every((item) => isObject(item) && typeof item.id === "string");
}

type JsonMerge = { conflicts: number };

function mergeValue(base: unknown, mine: unknown, theirs: unknown, state: JsonMerge): unknown {
  if (sameJson(mine, theirs) || sameJson(base, theirs)) return mine;
  if (sameJson(base, mine)) return theirs;
  return mergeBothChanged(base, mine, theirs, state);
}

/** Both sides changed this value: merge inside it when it has structure. */
function mergeBothChanged(base: unknown, mine: unknown, theirs: unknown, state: JsonMerge): unknown {
  const objects = sameShape(isObject, base, mine, theirs);
  if (objects) return mergeObject(objects[0] ?? {}, objects[1], objects[2], state);
  const lists = sameShape(isList, base, mine, theirs);
  if (lists) return mergeList(lists[0] ?? [], lists[1], lists[2], state);
  state.conflicts += 1;
  return mine;
}

function isList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** The three values when both sides have the shape and the base has it too
 * (or did not exist); otherwise null. */
function sameShape<T>(
  is: (value: unknown) => value is T,
  base: unknown,
  mine: unknown,
  theirs: unknown,
): [T | undefined, T, T] | null {
  if (!is(mine) || !is(theirs)) return null;
  if (base !== undefined && !is(base)) return null;
  return [base as T | undefined, mine, theirs];
}

function mergeList(base: unknown[], mine: unknown[], theirs: unknown[], state: JsonMerge): unknown[] {
  if (hasIds(mine) && hasIds(theirs) && hasIds(base)) return mergeById(base, mine, theirs, state);
  const merged = diff3(base, mine, theirs, { equal: sameJson, conflict: keepBothInsertionsElseMine });
  state.conflicts += merged.conflicts;
  return merged.items;
}

function mergeObject(base: JsonObject, mine: JsonObject, theirs: JsonObject, state: JsonMerge): JsonObject {
  const merged: JsonObject = {};
  const keys = [...Object.keys(mine), ...Object.keys(theirs).filter((key) => !(key in mine))];
  for (const key of keys) {
    const value = mergeValue(base[key], mine[key], theirs[key], state);
    if (value !== undefined) merged[key] = value as Json;
  }
  return merged;
}

/** Lists of things with ids: order merges like text, each item merges by key.
 * An item one side deleted stays deleted. */
function mergeById(base: JsonObject[], mine: JsonObject[], theirs: JsonObject[], state: JsonMerge): JsonObject[] {
  const idsOf = (list: JsonObject[]) => list.map((item) => item.id as string);
  const order = diff3(idsOf(base), idsOf(mine), idsOf(theirs), { equal: sameString, conflict: keepBothInsertionsElseMine });
  state.conflicts += order.conflicts;
  const byId = (list: JsonObject[]) => new Map(list.map((item) => [item.id as string, item]));
  const baseById = byId(base);
  const mineById = byId(mine);
  const theirsById = byId(theirs);
  const seen = new Set<string>();
  const merged: JsonObject[] = [];
  for (const id of order.items) {
    if (seen.has(id)) continue;
    seen.add(id);
    const inBase = baseById.get(id);
    const inMine = mineById.get(id);
    const inTheirs = theirsById.get(id);
    if (inBase && (!inMine || !inTheirs)) continue;
    merged.push(mergeValue(inBase, inMine ?? inTheirs, inTheirs ?? inMine, state) as JsonObject);
  }
  return merged;
}

export function mergeDraftJson(base: unknown, mine: unknown, theirs: unknown): MergeResult<unknown> {
  const state: JsonMerge = { conflicts: 0 };
  return { value: mergeValue(base, mine, theirs, state), conflicts: state.conflicts };
}

/* ------------------------------------------------------------------ entry */

export type MergeableKind = "document" | "deck" | "spreadsheet";

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Merge serialized draft content of any kind. JSON results are plain
 * `JSON.stringify` text; callers re-canonicalize through their model. */
export function mergeDraftContent(kind: MergeableKind, base: string, mine: string, theirs: string): MergeResult<string> {
  if (mine === theirs || base === theirs) return { value: mine, conflicts: 0 };
  if (base === mine) return { value: theirs, conflicts: 0 };
  if (kind === "document") return mergeDraftHtml(base, mine, theirs);
  const parsed = [parseJson(base), parseJson(mine), parseJson(theirs)];
  if (!parsed.every((item) => item.ok)) return { value: mine, conflicts: 1 };
  const [b, m, t] = parsed.map((item) => (item as { value: unknown }).value);
  const merged = mergeDraftJson(b, m, t);
  return { value: JSON.stringify(merged.value), conflicts: merged.conflicts };
}
