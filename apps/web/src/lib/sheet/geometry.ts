/** Grid geometry for the spreadsheet editor: column and row offsets (with
 * hidden and filtered rows at zero height), hit testing, and the size of the
 * displayed grid, which grows past the used range as the author scrolls. */

import { MAX_SHEET_COLS, MAX_SHEET_ROWS, type CellRange, columnLabel } from "./address";
import { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, type Sheet } from "./sheetModel";

export const HEADER_WIDTH = 48;
export const HEADER_HEIGHT = 26;

export type GridGeometry = {
  rows: number;
  cols: number;
  zoom: number;
  /** offsets[i] is the top (left) edge of row (column) i; length is count + 1. */
  rowOffsets: Float64Array;
  colOffsets: Float64Array;
  hiddenRows: Set<number>;
  hiddenCols: Set<number>;
  freezeRows: number;
  freezeCols: number;
};

export function displayedSize(used: CellRange | null, minRows: number, minCols: number): { rows: number; cols: number } {
  const rows = Math.min(MAX_SHEET_ROWS, Math.max(minRows, (used?.r2 ?? -1) + 60, 100));
  const cols = Math.min(MAX_SHEET_COLS, Math.max(minCols, (used?.c2 ?? -1) + 8, 26));
  return { rows, cols };
}

export function buildGeometry(
  sheet: Sheet,
  size: { rows: number; cols: number },
  filteredRows: Set<number>,
  zoom: number,
): GridGeometry {
  const hiddenRows = new Set(filteredRows);
  const hiddenCols = new Set<number>();
  for (const [label, row] of Object.entries(sheet.rows ?? {})) if (row.hidden) hiddenRows.add(Number(label) - 1);
  const rowOffsets = new Float64Array(size.rows + 1);
  for (let row = 0; row < size.rows; row += 1) {
    const height = hiddenRows.has(row) ? 0 : (sheet.rows?.[String(row + 1)]?.h ?? DEFAULT_ROW_HEIGHT) * zoom;
    rowOffsets[row + 1] = rowOffsets[row] + height;
  }
  const colOffsets = new Float64Array(size.cols + 1);
  for (let col = 0; col < size.cols; col += 1) {
    const entry = sheet.cols?.[columnLabel(col)];
    if (entry?.hidden) hiddenCols.add(col);
    const width = entry?.hidden ? 0 : (entry?.w ?? DEFAULT_COL_WIDTH) * zoom;
    colOffsets[col + 1] = colOffsets[col] + width;
  }
  return {
    rows: size.rows,
    cols: size.cols,
    zoom,
    rowOffsets,
    colOffsets,
    hiddenRows,
    hiddenCols,
    freezeRows: Math.min(sheet.freeze?.rows ?? 0, size.rows - 1),
    freezeCols: Math.min(sheet.freeze?.cols ?? 0, size.cols - 1),
  };
}

/** The grid's four panes: frozen rows sit in "top", frozen columns in "left". */
export type PaneKey = "main" | "top" | "left" | "corner";

/** Every pane a box (in sheet pixels) shows in. A floating object such as a
 * chart that crosses the freeze line is drawn in each pane it reaches, so its
 * frozen part stays put and the rest scrolls, as Excel draws it. Order
 * matches the grid's panes. */
export function panesForRect(geometry: GridGeometry, rect: { x: number; y: number; w: number; h: number }): PaneKey[] {
  const splitX = geometry.colOffsets[geometry.freezeCols];
  const splitY = geometry.rowOffsets[geometry.freezeRows];
  const left = rect.x < splitX;
  const right = rect.x + rect.w > splitX;
  const top = rect.y < splitY;
  const bottom = rect.y + rect.h > splitY;
  const panes: [PaneKey, boolean][] = [["main", right && bottom], ["top", right && top], ["left", left && bottom], ["corner", left && top]];
  return panes.filter(([, shows]) => shows).map(([key]) => key);
}

/** The index whose span contains `position` (binary search over offsets). */
export function indexAt(offsets: Float64Array, position: number): number {
  const count = offsets.length - 1;
  if (position <= 0) return 0;
  if (position >= offsets[count]) return count - 1;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= position) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function rangeRect(geometry: GridGeometry, range: CellRange): { x: number; y: number; w: number; h: number } {
  const r2 = Math.min(range.r2, geometry.rows - 1);
  const c2 = Math.min(range.c2, geometry.cols - 1);
  const x = geometry.colOffsets[Math.min(range.c1, geometry.cols - 1)];
  const y = geometry.rowOffsets[Math.min(range.r1, geometry.rows - 1)];
  return { x, y, w: geometry.colOffsets[c2 + 1] - x, h: geometry.rowOffsets[r2 + 1] - y };
}

/** Next visible index from `index` moving by `step`, staying in bounds. */
export function nextVisible(hidden: Set<number>, index: number, step: number, count: number): number {
  let next = index + step;
  while (next >= 0 && next < count && hidden.has(next)) next += step > 0 ? 1 : -1;
  if (next < 0 || next >= count) return index;
  return next;
}
