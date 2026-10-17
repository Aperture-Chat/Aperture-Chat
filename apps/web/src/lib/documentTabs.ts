/* Tab stops for documents opened from Word or PDF.
 *
 * HTML has no tab stops, so an imported tab is a fixed-width spacer
 * (span.document-tab) whose classes record the stop it reaches:
 * document-tab-{left|right|center|decimal} and document-tab-at-{twips}, the
 * stop measured from the left edge of the text column (Word's convention).
 * The importer sizes each spacer with its own font metrics; this pass
 * re-measures them against the fonts the browser actually rendered, so a
 * right-aligned page number still ends at the margin and columns still line
 * up when a font is substituted or a word is edited. */

import { DOCUMENT_TAB_CLASS, pxFromPt } from "./documentPageSetup";

const STOP_PATTERN = /\bdocument-tab-at-(\d+)\b/;
const KIND_PATTERN = /\bdocument-tab-(left|right|center|decimal)\b/;
const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, td, th, div";

/** Width of the content after a tab up to the next tab (or the block end). */
function followingWidth(tab: HTMLElement, block: HTMLElement) {
  const range = document.createRange();
  range.setStartAfter(tab);
  let end: Node | null = null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT);
  walker.currentNode = tab;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof HTMLElement && node.classList.contains(DOCUMENT_TAB_CLASS)) {
      end = node;
      break;
    }
  }
  if (end) range.setEndBefore(end);
  else range.setEnd(block, block.childNodes.length);
  const tabTop = tab.getBoundingClientRect().top;
  // Only the part on the tab's own line counts.
  const rects = Array.from(range.getClientRects()).filter((rect) => Math.abs(rect.top - tabTop) < rect.height + 2);
  if (!rects.length) return 0;
  return Math.max(...rects.map((rect) => rect.right)) - Math.min(...rects.map((rect) => rect.left));
}

function decimalOffset(tab: HTMLElement, block: HTMLElement) {
  const range = document.createRange();
  range.setStartAfter(tab);
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let found = false;
  walker.currentNode = tab;
  while ((node = walker.nextNode())) {
    const dot = (node.textContent ?? "").indexOf(".");
    if (dot !== -1) {
      range.setEnd(node, dot);
      found = true;
      break;
    }
  }
  if (!found) return followingWidth(tab, block);
  return range.getBoundingClientRect().width;
}

/** Resizes every recorded tab spacer under root so it reaches its stop.
 * Returns whether any width changed. Needs real layout: in a detached or
 * unrendered tree it does nothing. */
export function relayoutDocumentTabs(root: HTMLElement): boolean {
  if (typeof document === "undefined") return false;
  const tabs = Array.from(root.querySelectorAll<HTMLElement>(`span.${DOCUMENT_TAB_CLASS}`)).filter((tab) =>
    STOP_PATTERN.test(tab.className),
  );
  if (!tabs.length) return false;
  const rootRect = root.getBoundingClientRect();
  if (!rootRect.width || !root.offsetWidth) return false;
  // CSS zoom scales client rects but not the widths we write.
  const scale = rootRect.width / root.offsetWidth || 1;
  const original = tabs.map((tab) => tab.style.width);
  // Collapse first so text after a too-wide spacer is back on its line.
  tabs.forEach((tab) => {
    tab.style.width = "1px";
  });
  let changed = false;
  tabs.forEach((tab, index) => {
    const block = tab.parentElement?.closest<HTMLElement>(BLOCK_SELECTOR);
    const stop = Number(STOP_PATTERN.exec(tab.className)?.[1] ?? Number.NaN);
    if (!block || !Number.isFinite(stop)) {
      tab.style.width = original[index];
      return;
    }
    const kind = KIND_PATTERN.exec(tab.className)?.[1] ?? "left";
    const style = window.getComputedStyle(block);
    const marginLeft = Number.parseFloat(style.marginLeft) || 0;
    const columnLeft = block.getBoundingClientRect().left - marginLeft * scale;
    const target = columnLeft + pxFromPt(stop / 20) * scale;
    const left = tab.getBoundingClientRect().left;
    let width = (target - left) / scale;
    if (kind === "right") width -= followingWidth(tab, block) / scale + 1;
    else if (kind === "center") width -= followingWidth(tab, block) / (2 * scale) + 0.5;
    else if (kind === "decimal") width -= decimalOffset(tab, block) / scale + 0.5;
    // A stop the text already passed still leaves a space's width, as in Word.
    const fontSize = Number.parseFloat(style.fontSize) || 16;
    width = Math.max(fontSize * 0.25, width);
    const rounded = Math.round(width * 100) / 100;
    tab.style.width = `${rounded}px`;
    const before = Number.parseFloat(original[index]);
    if (!Number.isFinite(before) || Math.abs(before - rounded) > 0.3) changed = true;
    else tab.style.width = original[index];
  });
  return changed;
}
