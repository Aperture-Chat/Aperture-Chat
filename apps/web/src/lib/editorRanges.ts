/**
 * Range utilities shared by the Drafts document editor: painting ranges with
 * the CSS Custom Highlight API (AI edit target, find matches), and saving the
 * caret as a text offset so undo/redo can put it back after the editor HTML
 * is replaced wholesale.
 */

type HighlightCtor = new (...ranges: Range[]) => Highlight;

function highlightRegistry(): HighlightRegistry | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return null;
  const Ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return Ctor ? CSS.highlights : null;
}

/** Paints `ranges` under `name` (styled with `::highlight(name)`), or clears
 * the name when there is nothing to paint. Silently does nothing in browsers
 * without the API: the painting is a visual aid, never the source of truth. */
export function paintRanges(name: string, ranges: Range[]) {
  const registry = highlightRegistry();
  if (!registry) return;
  const live = ranges.filter((range) => !range.collapsed);
  if (!live.length) {
    registry.delete(name);
    return;
  }
  const Ctor = (globalThis as unknown as { Highlight: HighlightCtor }).Highlight;
  registry.set(name, new Ctor(...live));
}

export function clearPaint(name: string) {
  highlightRegistry()?.delete(name);
}

/** Characters of text between the start of `root` and the caret (the start of
 * the current selection), or null when the selection is outside `root`. */
export function caretTextOffset(root: HTMLElement): number | null {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  try {
    const probe = document.createRange();
    probe.selectNodeContents(root);
    probe.setEnd(range.startContainer, range.startOffset);
    return probe.toString().length;
  } catch {
    return null;
  }
}

/** Puts a collapsed caret `offset` characters into `root`'s text. */
export function placeCaretAtTextOffset(root: HTMLElement, offset: number) {
  const selection = window.getSelection?.();
  if (!selection) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode();
  let last: Node | null = null;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
    last = node;
    node = walker.nextNode();
  }
  const range = document.createRange();
  if (last) range.setStart(last, last.textContent?.length ?? 0);
  else range.selectNodeContents(root);
  range.collapse(!last);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** A viewport rectangle for a range. A collapsed caret in an empty block has
 * no client rect of its own, so its block stands in for it. */
export function rangeViewportRect(range: Range | null) {
  if (!range || typeof range.getBoundingClientRect !== "function") return null;
  // A triple-click selection ends at offset 0 of the next block, which adds
  // an empty rect on the following line; only rects with width count.
  const rects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
  const inked = rects.filter((item) => item.width > 1);
  if (inked.length) {
    return {
      top: Math.min(...inked.map((item) => item.top)),
      bottom: Math.max(...inked.map((item) => item.bottom)),
      left: Math.min(...inked.map((item) => item.left)),
      right: Math.max(...inked.map((item) => item.right)),
    };
  }
  let rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height && rects.length) rect = rects[rects.length - 1];
  if (!rect.width && !rect.height) {
    const node = range.startContainer;
    const element = node instanceof Element ? node : node.parentElement;
    const child = element?.childNodes[range.startOffset];
    const target = child instanceof Element ? child : element;
    if (target) rect = target.getBoundingClientRect();
  }
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

/** The top-level block (a direct child of the editor or of one of its page
 * sections) that holds `node`. */
export function topLevelEditorBlock(node: Node, editor: HTMLElement): HTMLElement | null {
  let element: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
  while (element && element !== editor) {
    const parent: HTMLElement | null = element.parentElement;
    if (parent === editor || (parent?.matches("section.document-page") && parent.parentElement === editor)) {
      return element;
    }
    element = parent;
  }
  return null;
}

/** A collapsed range at the very end of the editor's last block. */
export function endOfEditorRange(editor: HTMLElement) {
  const pages = editor.querySelectorAll<HTMLElement>(":scope > section.document-page");
  const container = pages.length ? pages[pages.length - 1] : editor;
  const last = container.lastElementChild ?? container;
  const range = document.createRange();
  range.selectNodeContents(last);
  range.collapse(false);
  return range;
}

/** The character right before a collapsed range inside its block, or "". */
export function characterBeforeRange(range: Range, block: HTMLElement | null) {
  if (!block) return "";
  try {
    const probe = document.createRange();
    probe.selectNodeContents(block);
    probe.setEnd(range.startContainer, range.startOffset);
    return probe.toString().slice(-1);
  } catch {
    return "";
  }
}
