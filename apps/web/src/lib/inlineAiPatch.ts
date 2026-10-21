/**
 * Format-preserving apply for inline AI edits.
 *
 * A content edit (fill in the blanks, correct a name, tighten a sentence)
 * should change words, not formatting. Swapping the highlight for the model's
 * reply drops every tab stop, underline, font run, and blank the reply did not
 * reproduce, and a plain-text reply reproduces none of them. Instead the
 * highlight's words are diffed against the reply's words, and only the changed
 * words are written into the original text runs: untouched words keep every
 * element and style they had, and new words take on the run they land in, plus
 * any emphasis the model gave them.
 */
import { sanitizeDocumentHtml } from "./draftRedline";

/** Blocks a highlight's words are grouped by (the editor's own block list). */
export const INLINE_TEXT_BLOCK_SELECTOR =
  "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,dt,dd,figcaption,td,th";

/** Elements an emptied run never removes: blocks, lists, pages, the editor. */
const CONTAINER_SELECTOR = `${INLINE_TEXT_BLOCK_SELECTOR},ul,ol,table,thead,tbody,tr,section,article,div,[contenteditable]`;
const TAB_SELECTOR = ".document-tab";
const RULE_SELECTOR = ".document-signature-line";

/** Every fill-in blank shares one token key, so a blank the model reproduced
 * at a different length, or as plain underscores, still lines up. */
const BLANK_KEY = "\u0000blank";
/** Words, with underscore runs split off: "____PMA" is a blank, then a word. */
const TOKEN_PATTERN = /_{3,}|(?:(?!_{3})\S)+/g;
const UNDERSCORE_RUN = /^_{3,}$/;
/** Largest word-by-word comparison worth running for one block. */
const MAX_DIFF_CELLS = 1_000_000;

/** Inline wrappers a new word may carry over from the reply. Anything else the
 * reply wrapped it in (spans, blanks, tab stops) is the reply's echo of the
 * original markup, which the original runs already provide. */
const EMPHASIS_TAGS: Record<string, string> = {
  strong: "strong",
  b: "strong",
  em: "em",
  i: "em",
  u: "u",
  s: "s",
  del: "s",
  strike: "s",
  sup: "sup",
  sub: "sub",
  code: "code",
  mark: "mark",
  a: "a",
};

type PieceKind = "text" | "tab" | "rule" | "break";

/** A slice of one text node (or a line break) inside a block. */
type Piece = {
  node: Text | null;
  /** The selected slice of `node.data`. */
  start: number;
  end: number;
  /** Where the slice starts in the block's text. */
  at: number;
  kind: PieceKind;
};

type Token = { key: string; from: number; to: number; piece: number };

type TextBlock = { block: Element; text: string; pieces: Piece[]; tokens: Token[] };

type Change = { a0: number; a1: number; b0: number; b1: number; equal: boolean };

type Edit = {
  original: TextBlock;
  reply: TextBlock;
  /** Original text removed (empty for a pure insertion). */
  from: number;
  to: number;
  /** Where the new words go, and which side of a run boundary they favor. */
  at: number;
  bias: "before" | "after";
  /** Reply text inserted (empty for a pure deletion). */
  insertFrom: number;
  insertTo: number;
  /** A space the reply has between words where the original had none. */
  lead: boolean;
  trail: "" | "inside" | "outside";
};

export type FormatPreservingPlan = {
  /** Number of separate changes; zero means the reply matches the highlight. */
  changes: number;
  /** Writes the changes into the page. `wrap` receives each run of new words
   * and returns the element to insert (the AI edit mark). Returns the inserted
   * elements in document order. */
  apply: (wrap: (content: DocumentFragment) => HTMLElement) => HTMLElement[];
};

/**
 * Plans the reply as word edits on the highlighted runs. Returns null when the
 * reply does not map onto the highlight word for word: a different number of
 * paragraphs or list items, or a rewrite that shares few words with the
 * highlight and is much shorter or longer (a summary, an expansion). Those
 * replies are structural, and replace the highlight instead.
 */
export function planFormatPreservingEdit(
  root: Element,
  range: Range | null,
  replyHtml: string,
): FormatPreservingPlan | null {
  if (typeof document === "undefined") return null;
  const original = collectTextBlocks(root, range).filter((block) => block.tokens.length);
  const holder = document.createElement("div");
  holder.innerHTML = replyHtml;
  const reply = collectTextBlocks(holder, null).filter((block) => block.tokens.length);
  if (!original.length || original.length !== reply.length) return null;

  const edits: Edit[] = [];
  let matched = 0;
  let originalWords = 0;
  let replyWords = 0;
  for (let index = 0; index < original.length; index += 1) {
    splitGluedTokens(original[index], reply[index]);
    const changes = diffTokens(original[index].tokens, reply[index].tokens);
    if (!changes) return null;
    originalWords += original[index].tokens.length;
    replyWords += reply[index].tokens.length;
    changes.forEach((change) => {
      if (change.equal) matched += change.a1 - change.a0;
      else edits.push(...editsForChange(original[index], reply[index], change));
    });
  }
  const matchRatio = matched / originalWords;
  const lengthRatio = replyWords / originalWords;
  if (matchRatio < 0.5 && (lengthRatio < 0.6 || lengthRatio > 1.6)) return null;
  if (edits.some((edit) => !editIsPlaceable(edit))) return null;

  return {
    changes: edits.length,
    apply(wrap) {
      const inserted: HTMLElement[] = [];
      const touched = new Set<Text>();
      // Right to left, so every earlier offset stays valid while later text
      // in the same node changes.
      const ordered = edits
        .map((edit, order) => ({ edit, order }))
        .sort((left, right) => right.order - left.order);
      ordered.forEach(({ edit }) => {
        const marker = applyEdit(edit, wrap, touched);
        if (marker) inserted.unshift(marker);
      });
      touched.forEach(removeIfEmptied);
      return inserted;
    },
  };
}

/** The reply as it would land with the highlight's formatting kept, for the
 * review panel. Null when the reply is structural (see the planner). */
export function formatPreservingPreviewHtml(range: Range, replyHtml: string) {
  if (typeof document === "undefined") return null;
  const holder = document.createElement("div");
  try {
    holder.appendChild(range.cloneContents());
  } catch {
    return null;
  }
  const plan = planFormatPreservingEdit(holder, null, replyHtml);
  if (!plan) return null;
  plan.apply((content) => {
    const mark = document.createElement("span");
    mark.className = "ai-composer-new";
    mark.appendChild(content);
    return mark;
  });
  return sanitizeDocumentHtml(holder.innerHTML).trim();
}

// ---------------------------------------------------------------------------
// Reading blocks
// ---------------------------------------------------------------------------

function collectTextBlocks(root: Element, range: Range | null): TextBlock[] {
  const blocks: TextBlock[] = [];
  const blockFor = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    const block = element?.closest(INLINE_TEXT_BLOCK_SELECTOR) ?? null;
    return block && block !== root && root.contains(block) ? block : root;
  };
  const push = (block: Element, piece: Omit<Piece, "at">, text: string) => {
    let current = blocks[blocks.length - 1];
    if (!current || current.block !== block) {
      current = { block, text: "", pieces: [], tokens: [] };
      blocks.push(current);
    }
    current.pieces.push({ ...piece, at: current.text.length });
    current.text += text;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (range && !range.intersectsNode(node)) continue;
    if (node instanceof Element) {
      if (node.tagName === "BR" || node.tagName === "IMG") {
        push(blockFor(node), { node: null, start: 0, end: 0, kind: "break" }, node.tagName === "BR" ? "\n" : " ");
      }
      continue;
    }
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = node as Text;
    const start = range && text === range.startContainer ? range.startOffset : 0;
    const end = range && text === range.endContainer ? range.endOffset : text.data.length;
    if (end <= start) continue;
    const parent = text.parentElement;
    const kind: PieceKind = parent?.closest(TAB_SELECTOR)
      ? "tab"
      : parent?.closest(RULE_SELECTOR)
        ? "rule"
        : "text";
    push(blockFor(text), { node: text, start, end, kind }, text.data.slice(start, end));
  }
  blocks.forEach(tokenize);
  return blocks;
}

function pieceLength(piece: Piece) {
  return piece.end - piece.start;
}

/** Straight and curly quotes compare equal, so a model that straightened the
 * typography does not count as changing the words. */
function tokenKey(text: string) {
  if (UNDERSCORE_RUN.test(text)) return BLANK_KEY;
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

/** A ruled line nobody has written on yet. */
function isBlankRule(block: TextBlock, piece: Piece) {
  return piece.kind === "rule" && !/[^\s_]/.test(block.text.slice(piece.at, piece.at + pieceLength(piece)));
}

function tokenize(block: TextBlock) {
  const { pieces, text } = block;
  let index = 0;
  while (index < pieces.length) {
    const piece = pieces[index];
    if (piece.kind === "break") {
      index += 1;
      continue;
    }
    if (isBlankRule(block, piece)) {
      // A ruled line is one blank, whatever characters draw it.
      block.tokens.push({ key: BLANK_KEY, from: piece.at, to: piece.at + pieceLength(piece), piece: index });
      index += 1;
      continue;
    }
    let last = index;
    while (
      last + 1 < pieces.length &&
      pieces[last + 1].kind !== "break" &&
      !isBlankRule(block, pieces[last + 1])
    ) {
      last += 1;
    }
    const runStart = pieces[index].at;
    const runText = text.slice(runStart, pieces[last].at + pieceLength(pieces[last]));
    let pieceIndex = index;
    for (const match of runText.matchAll(TOKEN_PATTERN)) {
      const from = runStart + (match.index ?? 0);
      while (pieceIndex < last && from >= pieces[pieceIndex].at + pieceLength(pieces[pieceIndex])) pieceIndex += 1;
      block.tokens.push({ key: tokenKey(match[0]), from, to: from + match[0].length, piece: pieceIndex });
    }
    index = last + 1;
  }
}

function pieceIndexAt(block: TextBlock, position: number) {
  const index = block.pieces.findIndex(
    (piece) => piece.node && position >= piece.at && position < piece.at + pieceLength(piece),
  );
  return Math.max(0, index);
}

/** A model that lost a tab stop writes "4.1SITE" for "4.1", tab, "SITE". A
 * reply word that is exactly two neighboring original words is read as those
 * two words, so the tab stop between them stays where it was. */
function splitGluedTokens(original: TextBlock, reply: TextBlock) {
  const singles = new Set(original.tokens.map((token) => token.key));
  const pairs = new Map<string, number>();
  original.tokens.forEach((token, index) => {
    const next = original.tokens[index + 1];
    if (!next || next.from === token.to || token.key === BLANK_KEY || next.key === BLANK_KEY) return;
    pairs.set(token.key + next.key, token.key.length);
  });
  if (!pairs.size) return;
  reply.tokens = reply.tokens.flatMap((token) => {
    const split = singles.has(token.key) ? undefined : pairs.get(token.key);
    if (split === undefined) return [token];
    const middle = token.from + split;
    return [
      { ...token, key: tokenKey(reply.text.slice(token.from, middle)), to: middle },
      {
        key: tokenKey(reply.text.slice(middle, token.to)),
        from: middle,
        to: token.to,
        piece: pieceIndexAt(reply, middle),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Diffing words
// ---------------------------------------------------------------------------

/** Longest-common-subsequence word diff, as alternating equal and changed
 * runs, with chance matches ("the", "of") between real changes folded into the
 * change around them so a rewrite is not scattered across the old runs. */
function diffTokens(a: Token[], b: Token[]): Change[] | null {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix].key === b[prefix].key) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix].key === b[b.length - 1 - suffix].key
  ) {
    suffix += 1;
  }
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;

  // lengths[i][j]: LCS of a[prefix + i..] and b[prefix + j..].
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        a[prefix + i].key === b[prefix + j].key
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }

  const changes: Change[] = [];
  const push = (equal: boolean, aStep: number, bStep: number) => {
    const last = changes[changes.length - 1];
    if (last && last.equal === equal) {
      last.a1 += aStep;
      last.b1 += bStep;
      return;
    }
    const a0 = last ? last.a1 : 0;
    const b0 = last ? last.b1 : 0;
    changes.push({ equal, a0, a1: a0 + aStep, b0, b1: b0 + bStep });
  };
  for (let k = 0; k < prefix; k += 1) push(true, 1, 1);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[prefix + i].key === b[prefix + j].key) {
      push(true, 1, 1);
      i += 1;
      j += 1;
    } else if (j >= m || (i < n && lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
      push(false, 1, 0);
      i += 1;
    } else {
      push(false, 0, 1);
      j += 1;
    }
  }
  for (let k = 0; k < suffix; k += 1) push(true, 1, 1);
  return foldChanceMatches(changes, a);
}

function foldChanceMatches(changes: Change[], a: Token[]) {
  const size = (change: Change) => Math.max(change.a1 - change.a0, change.b1 - change.b0);
  // Filling a blank is a precise local edit; the words between two fills are
  // the sentence the writer kept, never chance.
  const fillsBlank = (change: Change) =>
    change.a1 > change.a0 && a.slice(change.a0, change.a1).every((token) => token.key === BLANK_KEY);
  let folded = true;
  while (folded) {
    folded = false;
    for (let index = 1; index < changes.length - 1; index += 1) {
      const equal = changes[index];
      const before = changes[index - 1];
      const after = changes[index + 1];
      if (!equal.equal || before.equal || after.equal) continue;
      const length = equal.a1 - equal.a0;
      // A blank that stayed a blank is a real anchor, never chance.
      const anchorsBlank = a.slice(equal.a0, equal.a1).some((token) => token.key === BLANK_KEY);
      if (anchorsBlank || fillsBlank(before) || fillsBlank(after)) continue;
      if (length > size(before) || length > size(after)) continue;
      changes.splice(index - 1, 3, {
        equal: false,
        a0: before.a0,
        a1: after.a1,
        b0: before.b0,
        b1: after.b1,
      });
      folded = true;
      break;
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Turning changes into edits
// ---------------------------------------------------------------------------

function gap(block: TextBlock, left: Token | undefined, right: Token | undefined) {
  return left && right ? block.text.slice(left.to, right.from) : null;
}

/** True when every piece the range touches is ordinary text, so its
 * whitespace can be removed without deleting a tab stop or line break. */
function plainBetween(block: TextBlock, from: number, to: number) {
  return block.pieces.every((piece) => {
    const end = piece.at + pieceLength(piece);
    const overlaps = piece.kind === "break" ? piece.at >= from && piece.at < to : piece.at < to && end > from;
    return !overlaps || piece.kind === "text";
  });
}

/** The element a token's text sits in: words in the same run share it. */
function runOf(block: TextBlock, token: Token) {
  const piece = block.pieces[token.piece];
  return piece.kind === "rule" ? piece : piece.node?.parentElement ?? null;
}

/** The emphasis a token carries, as a comparable key. */
function emphasisOf(block: TextBlock, token: Token) {
  const piece = block.pieces[token.piece];
  const tags = new Set<string>();
  if (token.key === BLANK_KEY || piece.kind === "rule") tags.add("blank");
  for (
    let element = piece.node?.parentElement ?? null;
    element && element !== block.block;
    element = element.parentElement
  ) {
    const tag = EMPHASIS_TAGS[element.tagName.toLowerCase()];
    if (tag) tags.add(tag);
    if (element.classList.contains("document-blank")) tags.add("blank");
  }
  return Array.from(tags).sort().join(",");
}

function editsForChange(original: TextBlock, reply: TextBlock, change: Change): Edit[] {
  const a = original.tokens;
  const b = reply.tokens;
  const prevA = a[change.a0 - 1];
  const nextA = a[change.a1];
  const prevB = b[change.b0 - 1];
  const nextB = b[change.b1];
  const base = { original, reply, lead: false, trail: "" as Edit["trail"] };

  if (change.a0 === change.a1) {
    const first = b[change.b0];
    const last = b[change.b1 - 1];
    if (prevA) {
      const glued = gap(original, prevA, nextA) === "";
      return [
        {
          ...base,
          from: prevA.to,
          to: prevA.to,
          at: prevA.to,
          bias: "before",
          insertFrom: first.from,
          insertTo: last.to,
          lead: Boolean(gap(reply, prevB, first)),
          trail: glued && gap(reply, last, nextB) ? "inside" : "",
        },
      ];
    }
    return [
      {
        ...base,
        from: nextA.from,
        to: nextA.from,
        at: nextA.from,
        bias: "after",
        insertFrom: first.from,
        insertTo: last.to,
        trail: gap(reply, last, nextB) ? "inside" : "",
      },
    ];
  }

  if (change.b0 === change.b1) return [deletion(original, reply, change.a0, change.a1)];

  // A replacement across several runs (the underlined heading, then plain
  // text, then a blank) is split so each run gets its share of the new words
  // and keeps its own formatting.
  const runs: Array<[number, number]> = [];
  let runStart = change.a0;
  for (let index = change.a0 + 1; index <= change.a1; index += 1) {
    if (index === change.a1 || runOf(original, a[index]) !== runOf(original, a[index - 1])) {
      runs.push([runStart, index]);
      runStart = index;
    }
  }
  const chunks = chunkReplyWords(original, reply, change, runs);
  const edits: Edit[] = [];
  runs.forEach(([r0, r1], index) => {
    const [c0, c1] = chunks[index];
    if (c0 === c1) {
      edits.push(deletion(original, reply, r0, r1));
      return;
    }
    const isFirst = index === 0;
    const isLast = index === runs.length - 1;
    const nextOriginal = a[r1];
    const nextReply = isLast ? nextB : b[c1];
    const glued = gap(original, a[r1 - 1], nextOriginal) === "";
    edits.push({
      ...base,
      from: a[r0].from,
      to: a[r1 - 1].to,
      at: a[r0].from,
      bias: "after",
      insertFrom: b[c0].from,
      insertTo: b[c1 - 1].to,
      lead: isFirst && gap(original, prevA, a[r0]) === "" && Boolean(gap(reply, prevB, b[c0])),
      trail: glued && nextReply && gap(reply, b[c1 - 1], nextReply) ? (isLast ? "outside" : "inside") : "",
    });
  });
  return edits;
}

/** Splits a replacement's new words among the original runs it spans: by the
 * reply's own emphasis when it mirrors the runs, otherwise in proportion. */
function chunkReplyWords(
  original: TextBlock,
  reply: TextBlock,
  change: Change,
  runs: Array<[number, number]>,
): Array<[number, number]> {
  if (runs.length === 1) return [[change.b0, change.b1]];
  const groups: Array<{ key: string; range: [number, number] }> = [];
  for (let index = change.b0; index < change.b1; index += 1) {
    const key = emphasisOf(reply, reply.tokens[index]);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.range[1] = index + 1;
    else groups.push({ key, range: [index, index + 1] });
  }
  const mirrored =
    groups.length === runs.length &&
    groups.every((group, index) => group.key === emphasisOf(original, original.tokens[runs[index][0]]));
  if (mirrored) return groups.map((group) => group.range);

  // In proportion to the characters each run held, snapped to matching
  // punctuation nearby: a caption ending "scope:" ends at the reply word
  // ending ":", whatever language the reply is in.
  const charsOf = (block: TextBlock, from: number, to: number) =>
    block.tokens.slice(from, to).reduce((sum, token) => sum + token.to - token.from, 0);
  const total = charsOf(original, change.a0, change.a1);
  const replyTotal = charsOf(reply, change.b0, change.b1);
  let covered = 0;
  let previous = change.b0;
  return runs.map(([r0, r1], index) => {
    covered += charsOf(original, r0, r1);
    let boundary = change.b1;
    if (index < runs.length - 1) {
      const target = (replyTotal * covered) / total;
      let best = previous;
      let bestDistance = Infinity;
      for (let end = previous; end <= change.b1; end += 1) {
        const distance = Math.abs(charsOf(reply, change.b0, end) - target);
        if (distance < bestDistance) {
          best = end;
          bestDistance = distance;
        }
      }
      boundary = best;
      const closing = punctuationEnd(original, original.tokens[r1 - 1]);
      if (closing) {
        for (let offset = 0; offset <= 2; offset += 1) {
          const candidates = [best + offset, best - offset].filter(
            (end) => end > previous && end <= change.b1 && punctuationEnd(reply, reply.tokens[end - 1]) === closing,
          );
          if (candidates.length) {
            boundary = candidates[0];
            break;
          }
        }
      }
    }
    const chunk: [number, number] = [previous, Math.max(previous, boundary)];
    previous = chunk[1];
    return chunk;
  });
}

/** Closing punctuation of a word (":" of "scope:"), or "" for none. */
function punctuationEnd(block: TextBlock, token: Token | undefined) {
  if (!token) return "";
  const last = block.text.charAt(token.to - 1);
  return /[:;.,!?)\]”"]/.test(last) ? last : "";
}

/** Removes words, with the space beside them, so no double space is left. */
function deletion(original: TextBlock, reply: TextBlock, a0: number, a1: number): Edit {
  const a = original.tokens;
  const prev = a[a0 - 1];
  const next = a[a1];
  let from = a[a0].from;
  let to = a[a1 - 1].to;
  const after = next ? original.text.slice(to, next.from) : null;
  const before = prev ? original.text.slice(prev.to, from) : null;
  if (after && before !== "" && plainBetween(original, to, next.from)) to = next.from;
  else if (before && (after === null || after !== "") && plainBetween(original, prev.to, from)) from = prev.to;
  return {
    original,
    reply,
    from,
    to,
    at: from,
    bias: "after",
    insertFrom: 0,
    insertTo: 0,
    lead: false,
    trail: "",
  };
}

// ---------------------------------------------------------------------------
// Writing edits
// ---------------------------------------------------------------------------

type Spot = { node: Text; offset: number; piece: Piece };

/** The text node and offset at a block position. "after" names the character
 * at `position`; "before" the one just before it, so new words join the run
 * they follow. Tab stops never take new words. */
function locate(block: TextBlock, position: number, bias: "before" | "after"): Spot | null {
  for (const piece of block.pieces) {
    if (!piece.node || piece.kind === "tab") continue;
    const end = piece.at + pieceLength(piece);
    const inside = bias === "after" ? position >= piece.at && position < end : position > piece.at && position <= end;
    if (inside) return { node: piece.node, offset: piece.start + position - piece.at, piece };
  }
  return null;
}

function editIsPlaceable(edit: Edit) {
  if (!locate(edit.original, edit.at, edit.bias)) return false;
  if (edit.insertTo > edit.insertFrom) {
    if (!locate(edit.reply, edit.insertFrom, "after") || !locate(edit.reply, edit.insertTo, "before")) return false;
  }
  if (edit.trail === "outside" && !locate(edit.original, edit.to, "after")) return false;
  return true;
}

function applyEdit(
  edit: Edit,
  wrap: (content: DocumentFragment) => HTMLElement,
  touched: Set<Text>,
): HTMLElement | null {
  const spot = locate(edit.original, edit.at, edit.bias);
  if (!spot) return null;
  const inserting = edit.insertTo > edit.insertFrom;
  if (inserting && edit.trail === "outside") {
    // The space after a filled blank belongs to the text after it, not to the
    // blank's underline.
    const after = locate(edit.original, edit.to, "after");
    after?.node.insertData(after.offset, " ");
  }
  removeText(edit.original, edit.from, edit.to, touched);
  if (!inserting) return null;
  const content = replyContent(edit.reply, edit.insertFrom, edit.insertTo, spot.node);
  if (edit.lead) content.insertBefore(document.createTextNode(" "), content.firstChild);
  if (edit.trail === "inside") content.appendChild(document.createTextNode(" "));
  const marker = wrap(content);
  insertAt(spot.node, spot.offset, marker);
  touched.add(spot.node);
  // A filled ruled line becomes the value itself: the rule was the blank.
  const rule = marker.parentElement?.closest(RULE_SELECTOR);
  if (rule && spot.piece.kind === "rule") {
    const kept = Array.from(rule.childNodes).filter(
      (node) => node.nodeType !== Node.TEXT_NODE || /[^\s ]/.test(node.textContent ?? ""),
    );
    rule.replaceWith(...kept);
  }
  return marker;
}

function removeText(block: TextBlock, from: number, to: number, touched: Set<Text>) {
  if (to <= from) return;
  for (let index = block.pieces.length - 1; index >= 0; index -= 1) {
    const piece = block.pieces[index];
    if (!piece.node || piece.kind === "tab") continue;
    const start = Math.max(from, piece.at);
    const end = Math.min(to, piece.at + pieceLength(piece));
    if (end <= start) continue;
    piece.node.deleteData(piece.start + start - piece.at, end - start);
    touched.add(piece.node);
  }
}

function insertAt(node: Text, offset: number, content: Node) {
  if (offset <= 0) node.before(content);
  else if (offset >= node.data.length) node.after(content);
  else node.splitText(offset).before(content);
}

/** The reply's words for an insertion, keeping only the emphasis the run they
 * land in does not already have. */
function replyContent(reply: TextBlock, from: number, to: number, context: Text) {
  const start = locate(reply, from, "after");
  const end = locate(reply, to, "before");
  const fragment = document.createDocumentFragment();
  if (!start || !end) return fragment;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  fragment.appendChild(range.cloneContents());

  const inherited = new Set<string>();
  let insideRule = false;
  for (let element = context.parentElement; element; element = element.parentElement) {
    if (element.matches(INLINE_TEXT_BLOCK_SELECTOR)) break;
    const tag = EMPHASIS_TAGS[element.tagName.toLowerCase()];
    if (tag) inherited.add(tag);
    if (element.matches(RULE_SELECTOR)) insideRule = true;
  }
  Array.from(fragment.querySelectorAll("*"))
    .reverse()
    .forEach((element) => {
      const name = element.tagName.toLowerCase();
      if (name === "br") return;
      if (element.matches(RULE_SELECTOR) && !insideRule) return;
      const tag = EMPHASIS_TAGS[name];
      if (tag && !inherited.has(tag)) return;
      element.replaceWith(...Array.from(element.childNodes));
    });
  return fragment;
}

/** Drops a text node the edit emptied, and any inline wrapper it leaves
 * empty, so a removed blank leaves no bare span behind. */
function removeIfEmptied(node: Text) {
  if (!node.isConnected || node.data) return;
  let parent = node.parentElement;
  node.remove();
  while (
    parent &&
    !parent.matches(CONTAINER_SELECTOR) &&
    !parent.textContent &&
    !parent.querySelector("img,br,hr,table,figure")
  ) {
    const next = parent.parentElement;
    parent.remove();
    parent = next;
  }
}

