/** Sizes a new pivot table's columns to its labels and values, the way Excel
 * auto-fits a pivot when it is created. Columns only ever grow. */

import { columnLabel } from "./address";
import { isError } from "./formula/values";
import { formatCellValue } from "./numberFormat";
import { computeWorkbook } from "./recalc";
import { DEFAULT_COL_WIDTH, type Workbook } from "./sheetModel";
import { setColumnWidth } from "./sheetOps";

const CHAR_PX = 7.2;

export function fitPivotColumns(workbook: Workbook, sheetId: string, pivotId: string): Workbook {
  const engine = computeWorkbook(workbook);
  const result = engine.pivotResult(sheetId, pivotId);
  const sheet = workbook.sheets.find((item) => item.id === sheetId);
  if (!sheet || !result.range || !result.output || isError(result.output)) return workbook;
  let next = workbook;
  for (let col = result.range.c1; col <= Math.min(result.range.c2, result.range.c1 + 40); col += 1) {
    let chars = 6;
    for (let row = result.range.r1; row <= Math.min(result.range.r2, result.range.r1 + 400); row += 1) {
      const value = engine.value(sheetId, row, col);
      if (value === null) continue;
      chars = Math.max(chars, formatCellValue(value, engine.pivotCellFormat(sheetId, row, col)).text.length);
    }
    const wanted = Math.round(Math.min(320, Math.max(70, chars * CHAR_PX + 18)));
    const current = sheet.cols?.[columnLabel(col)]?.w ?? DEFAULT_COL_WIDTH;
    if (wanted > current) next = setColumnWidth(next, sheetId, col, col, wanted);
  }
  return next;
}
