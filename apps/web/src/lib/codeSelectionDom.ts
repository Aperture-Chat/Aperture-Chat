/**
 * Reads a browser text selection inside a numbered code view back into
 * character offsets of the code. Each `.md-code-line` row holds one source
 * line in its `.md-code-line-text` cell (split into highlight spans or not),
 * so a boundary is its row's start offset plus the text before it in that
 * cell. Boundaries on a line number count as the start of that line.
 */
import type { CodeSelection } from "./codeAiEdit";

function lineStartsOf(code: string): number[] {
  const starts = [0];
  for (let index = code.indexOf("\n"); index !== -1; index = code.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function charsBefore(cell: Element, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(cell, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** Characters into its line that a boundary inside `row` falls at; past
 * the text it is Infinity, which the caller clamps to the line's end. */
function columnInRow(row: Element, node: Node, offset: number): number {
  const cell = row.querySelector(".md-code-line-text")!;
  if (cell.contains(node)) return charsBefore(cell, node, offset);
  if (node !== row) return 0;
  return offset > Array.prototype.indexOf.call(row.childNodes, cell) ? Infinity : 0;
}

/** -1 before the view, 0 inside it, 1 after it. */
function sideOf(root: Element, node: Node, offset: number): number {
  const whole = document.createRange();
  whole.selectNodeContents(root);
  return whole.comparePoint(node, offset);
}

function rowOf(node: Node): Element | null {
  return (node instanceof Element ? node : node.parentElement!).closest(".md-code-line");
}

function pointOffset(root: Element, node: Node, offset: number, code: string, starts: number[]): number {
  const side = sideOf(root, node, offset);
  if (side < 0) return 0;
  if (side > 0) return code.length;
  const row = rowOf(node);
  // On the view itself, between rows: the offset counts rows.
  if (!row) return offset < starts.length ? starts[offset]! : code.length;
  const line = [...root.querySelectorAll(".md-code-line")].indexOf(row);
  const lineEnd = line + 1 < starts.length ? starts[line + 1]! - 1 : code.length;
  return Math.min(starts[line]! + columnInRow(row, node, offset), lineEnd);
}

/** The selected code range, or null when the selection is empty or does not
 * touch this code view. */
export function codeSelectionFromDom(root: Element, selection: Selection | null, code: string): CodeSelection | null {
  // A selection with no range at all also reports itself collapsed.
  if (!selection || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(root)) return null;
  const starts = lineStartsOf(code);
  const start = pointOffset(root, range.startContainer, range.startOffset, code, starts);
  const end = pointOffset(root, range.endContainer, range.endOffset, code, starts);
  return end > start ? { start, end } : null;
}
