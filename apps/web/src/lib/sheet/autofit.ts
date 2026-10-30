/** Excel's AutoFit and header-edge resizing, as pure functions: which
 * columns or rows a header edge acts on, and the height a row's text needs. */
import { type CellRange, MAX_SHEET_COLS, MAX_SHEET_ROWS, columnLabel } from "./address";
import type { Scalar } from "./formula/values";
import { formatCellValue } from "./numberFormat";
import { type CellStyle, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, type Sheet, type Workbook } from "./sheetModel";
import { effectiveStyle, mergeAt, setRowHeight } from "./sheetOps";

export type HeaderAxis = "cols" | "rows";

/** Width of a cell's displayed text in pixels at 100% zoom. */
export type MeasureText = (text: string, style: CellStyle | undefined) => number;

/** The columns (or rows) a header-edge drag or double-click acts on: the
 * whole selected run when the edge belongs to a selection of entire columns
 * (rows), otherwise just that one, as in Excel. */
export function headerSpan(axis: HeaderAxis, index: number, range: CellRange): [number, number] {
  const whole = axis === "cols"
    ? range.r1 === 0 && range.r2 === MAX_SHEET_ROWS - 1 && index >= range.c1 && index <= range.c2
    : range.c1 === 0 && range.c2 === MAX_SHEET_COLS - 1 && index >= range.r1 && index <= range.r2;
  if (!whole) return [index, index];
  return axis === "cols" ? [range.c1, range.c2] : [range.r1, range.r2];
}

/** Height a row needs for one cell's text: a line per line break and, with
 * wrap on, as many lines as the text takes in its column. */
export function fittedRowHeight(text: string, style: CellStyle | undefined, columnWidth: number, measure: MeasureText): number {
  const lineHeight = (((style?.size ?? 10) * 4) / 3) * 1.2;
  const room = columnWidth - 8;
  const parts = text.split("\n");
  const lines = style?.wrap ? parts.reduce((sum, part) => sum + Math.max(1, Math.ceil(measure(part, style) / room)), 0) : parts.length;
  return Math.ceil(lines * lineHeight + 8);
}

/** Sets each row to the height its tallest cell needs; a row that fits the
 * default height drops its custom height. Merged cells are skipped. */
export function fitRowHeights(
  workbook: Workbook,
  sheet: Sheet,
  rows: { r1: number; r2: number; lastCol: number },
  valueAt: (row: number, col: number) => Scalar,
  measure: MeasureText,
): Workbook {
  let next = workbook;
  for (let row = rows.r1; row <= rows.r2; row += 1) {
    let height = DEFAULT_ROW_HEIGHT;
    for (let col = 0; col <= rows.lastCol; col += 1) {
      if (mergeAt(sheet, row, col)) continue;
      const style = effectiveStyle(sheet, row, col);
      const width = sheet.cols?.[columnLabel(col)]?.w ?? DEFAULT_COL_WIDTH;
      height = Math.max(height, fittedRowHeight(formatCellValue(valueAt(row, col), style?.format).text, style, width, measure));
    }
    next = setRowHeight(next, sheet.id, row, row, height === DEFAULT_ROW_HEIGHT ? null : height);
  }
  return next;
}
