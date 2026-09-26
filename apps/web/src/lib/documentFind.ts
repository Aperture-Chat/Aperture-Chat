/**
 * Find & replace for the Drafts document canvas. Matches are found in the
 * visible text, including across formatting runs inside one paragraph
 * ("twelve <b>percent</b>"), but never across paragraph boundaries, and never
 * inside non-editable islands such as figures and citations.
 */

export type FindOptions = { matchCase: boolean; wholeWord: boolean };

const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,pre,dt,dd,figcaption,div,section";

type Segment = { node: Text; start: number };

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The regular expression a query compiles to, or null for an empty query. */
export function findPattern(query: string, { matchCase, wholeWord }: FindOptions) {
  if (!query) return null;
  const body = escapeRegExp(query);
  // \b only works when the query starts/ends with word characters.
  const lead = wholeWord && /^\w/.test(query) ? "\\b" : "";
  const tail = wholeWord && /\w$/.test(query) ? "\\b" : "";
  return new RegExp(`${lead}${body}${tail}`, matchCase ? "g" : "gi");
}

/** Every match of `query` in `root`, as DOM ranges in document order. */
export function findTextRanges(root: HTMLElement, query: string, options: FindOptions, limit = 2000): Range[] {
  const pattern = findPattern(query, options);
  if (!pattern) return [];
  const segments: Segment[] = [];
  let flat = "";
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('[contenteditable="false"]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode() as Text | null;
  while (node) {
    const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? root;
    // A separator no query can match keeps matches inside one block.
    if (lastBlock && block !== lastBlock) flat += "\u0000";
    lastBlock = block;
    segments.push({ node, start: flat.length });
    flat += node.data;
    node = walker.nextNode() as Text | null;
  }
  const ranges: Range[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(flat)) && ranges.length < limit) {
    if (!match[0]) {
      pattern.lastIndex += 1;
      continue;
    }
    const range = rangeForSpan(segments, match.index, match.index + match[0].length);
    if (range) ranges.push(range);
  }
  return ranges;
}

function locate(segments: Segment[], offset: number, preferEnd: boolean) {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const end = segment.start + segment.node.data.length;
    if (offset > segment.start || (offset === segment.start && !preferEnd)) {
      if (offset <= end) return { node: segment.node, offset: offset - segment.start };
    }
  }
  return null;
}

function rangeForSpan(segments: Segment[], start: number, end: number) {
  const from = locate(segments, start, false);
  const to = locate(segments, end, true);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/** Replaces a match's text, keeping the formatting of the run it starts in.
 * Returns the text node holding the replacement. */
export function replaceRangeText(range: Range, replacement: string) {
  const text = document.createTextNode(replacement);
  range.deleteContents();
  range.insertNode(text);
  text.parentElement?.normalize();
  return text;
}
