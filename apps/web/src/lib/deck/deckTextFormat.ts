/** Helpers for the deck's floating text toolbar: PowerPoint's size steps, the
 * point size of slide text, and keeping a selection across a re-render of a
 * text box (formatting re-renders the box from the deck model).
 *
 * The stage draws the 960×540 slide at 1px per point, so slide text sizes
 * are written as px and read back 1:1 (deckFromDocument's run reader does the
 * same). A text box carries its layout's size and color as the custom
 * properties --l0-size … --l2-size and --l0-color … --l2-color. */

/** PowerPoint's font size list, in points; the deck model holds 8–96. */
export const DECK_TEXT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96];

/** The next size up or down from `current`, like PowerPoint's Increase and
 * Decrease Font Size. */
export function stepDeckTextSize(current: number, direction: 1 | -1): number {
  if (direction > 0) return DECK_TEXT_SIZES.find((size) => size > current + 0.25) ?? DECK_TEXT_SIZES[DECK_TEXT_SIZES.length - 1];
  for (let index = DECK_TEXT_SIZES.length - 1; index >= 0; index -= 1) {
    if (DECK_TEXT_SIZES[index] < current - 0.25) return DECK_TEXT_SIZES[index];
  }
  return DECK_TEXT_SIZES[0];
}

export type DeckTextOffsets = { start: number; end: number };

/** Counts line breaks in slide text, in document order: every bullet after
 * the first, every <br>, and every block line after the first (the lines the
 * run reader keeps). Counting them keeps "end of one bullet" and "start of
 * the next" apart, and a first line counts the same as a list or as lines. */
function lineBreakCounter() {
  let seenItem = false;
  return (node: Node): boolean => {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = (node as Element).tagName;
    if (tag === "LI") {
      const counts = seenItem;
      seenItem = true;
      return counts;
    }
    if (tag === "BR") return true;
    return (tag === "DIV" || tag === "P") && Boolean(node.previousSibling);
  };
}

/** Position of a boundary point in a root's text, counting line breaks. */
function textPosition(root: Node, container: Node, offset: number): number {
  const document = root.ownerDocument;
  if (!document) return 0;
  // A point just before an element (a bullet, a line) is the start of that
  // element's text, which counts its line break.
  while (container.nodeType === Node.ELEMENT_NODE && offset < container.childNodes.length) {
    const child = container.childNodes[offset];
    if (child.nodeType !== Node.ELEMENT_NODE || (child as Element).tagName === "BR") break;
    container = child;
    offset = 0;
  }
  const point = document.createRange();
  point.setStart(container, offset);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const isLineBreak = lineBreakCounter();
  let position = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (point.comparePoint(node, 0) > 0) break;
    if (node.nodeType === Node.TEXT_NODE) {
      if (node === container) return position + offset;
      position += (node as Text).length;
    } else if (isLineBreak(node)) {
      position += 1;
    }
  }
  return position;
}

/** Offsets of `range` within `root`: characters plus line breaks. */
export function deckTextOffsets(root: Node, range: Range): DeckTextOffsets | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = textPosition(root, range.startContainer, range.startOffset);
  const end = range.collapsed ? start : textPosition(root, range.endContainer, range.endOffset);
  return { start, end: Math.max(start, end) };
}

/** A range over the same text after `root` was re-rendered; offsets past
 * the end clamp to the end of the text. */
export function deckRangeFromOffsets(root: Node, offsets: DeckTextOffsets): Range | null {
  const document = root.ownerDocument;
  if (!document) return null;
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const texts: Array<{ node: Text; at: number }> = [];
  const isLineBreak = lineBreakCounter();
  let position = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      texts.push({ node: node as Text, at: position });
      position += (node as Text).length;
    } else if (isLineBreak(node)) {
      position += 1;
    }
  }
  if (!texts.length) {
    range.selectNodeContents(root);
    range.collapse(true);
    return range;
  }
  // On a boundary between two text nodes a start belongs to the next one and
  // an end to the previous, so the range covers no stray empty edges.
  const locate = (target: number, forward: boolean): [Text, number] => {
    let found: [Text, number] | null = null;
    for (const { node, at } of texts) {
      if (target < at) break;
      if (target <= at + node.length) {
        found = [node, target - at];
        if (!forward || target < at + node.length) return found;
      }
    }
    if (found) return found;
    const next = texts.find(({ at }) => at >= target);
    if (next) return [next.node, 0];
    const last = texts[texts.length - 1];
    return [last.node, last.node.length];
  };
  const collapsed = offsets.end <= offsets.start;
  const [startNode, startOffset] = locate(offsets.start, true);
  const [endNode, endOffset] = collapsed ? [startNode, startOffset] : locate(offsets.end, false);
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/** A slide point size in an inline font-size value: "24px" (the stage's 1px
 * per point), or CSS points from pasted text (4/3 px each). */
export function deckSizeFromStyle(value: string): number | null {
  const pixels = /([\d.]+)px/i.exec(value);
  if (pixels) return Math.round(Number(pixels[1]));
  const points = /([\d.]+)pt/i.exec(value);
  if (points) return Math.round((Number(points[1]) * 4) / 3);
  return null;
}

/** Layout point size of the outline level `node` sits at, read from the
 * region's per-level custom properties (see deckRegionStyle). */
function layoutSizeAt(node: Node, block: HTMLElement): number | null {
  let level = -1;
  for (let element = node.parentElement; element && element !== block; element = element.parentElement) {
    if (element.tagName === "UL" || element.tagName === "OL") level += 1;
  }
  const value = block.style.getPropertyValue(`--l${Math.max(0, Math.min(2, level))}-size`);
  return value ? deckSizeFromStyle(value) : null;
}

/** The point size slide text renders at before the box's autofit scale: the
 * innermost explicit run size, else the layout's size for its level. */
export function deckTextSizeAt(node: Node, block: HTMLElement): number | null {
  for (
    let element: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
    element && element !== block;
    element = element.parentElement
  ) {
    // The attribute, not the parsed style: engines differ on calc() with var().
    const declared = /(?:^|;)\s*font-size\s*:\s*([^;]+)/i.exec(element.getAttribute("style") ?? "");
    const size = declared ? deckSizeFromStyle(declared[1]) : null;
    if (size) return size;
  }
  return layoutSizeAt(node, block);
}

/** The layout's own size for the text at `node`, ignoring run overrides. */
export function deckLayoutSizeAt(node: Node, block: HTMLElement): number | null {
  return layoutSizeAt(node, block);
}

/** True when a range covers at least one character of a text node (not just
 * touches its edge). */
function rangeCoversText(range: Range, text: Text): boolean {
  if (!range.intersectsNode(text)) return false;
  const start = text === range.startContainer ? range.startOffset : 0;
  const end = text === range.endContainer ? range.endOffset : text.length;
  return end > start;
}

/** One size for the text a range covers, or null when it mixes sizes. With
 * a collapsed range (or none) the whole box is measured. */
export function deckTextSizeOf(block: HTMLElement, range: Range | null): number | null {
  const document = block.ownerDocument;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const sizes = new Set<number>();
  const whole = !range || range.collapsed;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    if (!whole && !rangeCoversText(range, node as Text)) continue;
    const size = deckTextSizeAt(node, block);
    if (size) sizes.add(size);
  }
  if (sizes.size === 1) return [...sizes][0];
  if (sizes.size === 0) {
    const fallback = layoutSizeAt(block.firstChild ?? block, block);
    return fallback;
  }
  return null;
}

export type DeckSizeChange = { size: number } | { step: 1 | -1 } | { reset: true };

/** Wraps each piece of text a range covers in its own styled span (the
 * innermost style wins), so a format works across bullets without
 * restructuring the list. `styleFor` returns the style for one piece, or null
 * to leave it. Returns the number of pieces styled. */
export function styleDeckTextPieces(
  block: HTMLElement,
  range: Range,
  styleFor: (node: Text) => Record<string, string> | null,
): number {
  const document = block.ownerDocument;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const pieces: Array<{ node: Text; start: number; end: number }> = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.length || !range.intersectsNode(text)) continue;
    const start = text === range.startContainer ? range.startOffset : 0;
    const end = text === range.endContainer ? range.endOffset : text.length;
    if (end <= start || !text.data.slice(start, end).trim()) continue;
    pieces.push({ node: text, start, end });
  }
  let styled = 0;
  for (const { node, start, end } of pieces) {
    const style = styleFor(node);
    if (!style) continue;
    let piece = node;
    if (end < piece.length) piece.splitText(end);
    if (start > 0) piece = piece.splitText(start);
    const span = document.createElement("span");
    for (const [property, value] of Object.entries(style)) span.style.setProperty(property, value);
    piece.parentNode?.insertBefore(span, piece);
    span.appendChild(piece);
    styled += 1;
  }
  return styled;
}

/** Sizes the text a range covers. A step moves each piece from its own size
 * the way PowerPoint does with mixed sizes; reset sizes a piece to its
 * layout size, which the run reader then drops as no override. */
export function applyDeckTextSize(block: HTMLElement, range: Range, change: DeckSizeChange): number {
  return styleDeckTextPieces(block, range, (node) => {
    const layoutSize = layoutSizeAt(node, block);
    const size =
      "size" in change
        ? change.size
        : "step" in change
          ? stepDeckTextSize(deckTextSizeAt(node, block) ?? layoutSize ?? 18, change.step)
          : layoutSize;
    return size ? { "font-size": `${size}px` } : null;
  });
}

/** Theme color of the outline level a node sits at. */
function layoutColorAt(node: Node, block: HTMLElement): string | null {
  let level = -1;
  for (let element = node.parentElement; element && element !== block; element = element.parentElement) {
    if (element.tagName === "UL" || element.tagName === "OL") level += 1;
  }
  return block.style.getPropertyValue(`--l${Math.max(0, Math.min(2, level))}-color`).trim() || null;
}

/** Returns the text a range covers to each level's theme color (the run
 * reader drops a color equal to the region's own). */
export function resetDeckTextColor(block: HTMLElement, range: Range): number {
  return styleDeckTextPieces(block, range, (node) => {
    const color = layoutColorAt(node, block);
    return color ? { color } : null;
  });
}
