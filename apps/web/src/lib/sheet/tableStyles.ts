/** Table styles as Excel's gallery applies them: format a range as a table in
 * a picked style, and restyle one table or every table. A cell's own fill or
 * text color wins over a table style (in Excel too), so picking a style clears
 * those inside the table, as Excel's "Apply and Clear Formatting" does. */

import { type CellPoint, type CellRange, MAX_SHEET_COLS, MAX_SHEET_ROWS, formatRangeRef, parseCellKey, parseRangeRef, rangeContains, rangesIntersect } from "./address";
import { currentRegion } from "./decorations";
import type { WorkbookEngine } from "./recalc";
import type { AccentSlot, Sheet, SheetTable, TableTone, Workbook } from "./sheetModel";
import { type TableStylePatch, applyStyle, restyleTables, updateSheet } from "./sheetOps";

export type TableLook = { accent: AccentSlot; tone: TableTone };

/** One table by id, or (left out) every table in the workbook. */
export type TableScope = { sheetId: string; tableId: string } | undefined;

/** The first "TableN" no table in the workbook uses, compared without case as Excel does. */
export function nextTableName(workbook: Workbook): string {
  const taken = new Set(workbook.sheets.flatMap((sheet) => (sheet.tables ?? []).map((table) => table.name.toLowerCase())));
  let n = 1;
  while (taken.has(`table${n}`)) n += 1;
  return `Table${n}`;
}

/** The sheet ranges a restyle reaches. */
export function tableTargets(workbook: Workbook, only?: TableScope): { sheetId: string; range: CellRange }[] {
  return workbook.sheets.flatMap((sheet) =>
    (sheet.tables ?? [])
      .filter((table) => !only || (sheet.id === only.sheetId && table.id === only.tableId))
      .flatMap((table) => {
        const range = parseRangeRef(table.ref);
        return range ? [{ sheetId: sheet.id, range }] : [];
      }),
  );
}

/** Whether any cell in the range carries its own fill or text color. */
export function hasOwnColors(sheet: Sheet, range: CellRange): boolean {
  return Object.entries(sheet.cells).some(([address, cell]) => {
    const point = parseCellKey(address);
    return Boolean(point && rangeContains(range, point.row, point.col) && (cell.s?.fill || cell.s?.color));
  });
}

/** Clears cell fills and text colors in a range (a table about to be made there). */
export function clearOwnColors(workbook: Workbook, sheetId: string, range: CellRange): Workbook {
  return applyStyle(workbook, sheetId, range, { fill: null, color: null });
}

/** Clears cell fills and text colors inside one table or every table, so the
 * table style shows; number formats, bold, borders, and alignment stay. */
export function clearTableFills(workbook: Workbook, only?: TableScope): Workbook {
  return tableTargets(workbook, only).reduce((book, target) => clearOwnColors(book, target.sheetId, target.range), workbook);
}

/** The style every table shares, for marking it in the gallery; null when they differ or there are none. */
export function sharedTableLook(workbook: Workbook): TableLook | null {
  const tables = workbook.sheets.flatMap((sheet) => sheet.tables ?? []);
  const first = tables[0];
  if (!first || tables.some((table) => table.accent !== first.accent || table.tone !== first.tone)) return null;
  return { accent: first.accent, tone: first.tone };
}

/** Formats a range as a table in the picked style: its first row is the
 * header. Null when the range has no data row or overlaps a table. */
export function formatRangeAsTable(workbook: Workbook, sheetId: string, range: CellRange, look: TableLook): Workbook | null {
  if (range.r2 <= range.r1) return null;
  const sheet = workbook.sheets.find((item) => item.id === sheetId);
  const overlaps = (sheet?.tables ?? []).some((table) => {
    const ref = parseRangeRef(table.ref);
    return ref !== null && rangesIntersect(ref, range);
  });
  if (!sheet || overlaps) return null;
  const name = nextTableName(workbook);
  const table: SheetTable = { id: name, name, ref: formatRangeRef(range), ...look, banded: true, totals: false, filterButtons: true };
  const tabled = updateSheet(workbook, sheetId, (current) => ({ ...current, tables: [...(current.tables ?? []), table] }));
  return clearOwnColors(tabled, sheetId, range);
}

/** The workbook a table style change writes into: a new accent or tone clears
 * the fills that would hide it; an option (banded rows, filter buttons) does not. */
export function clearedForStyle(workbook: Workbook, patch: TableStylePatch, only?: TableScope): Workbook {
  return patch.accent === undefined && patch.tone === undefined ? workbook : clearTableFills(workbook, only);
}

/** A Table styles pick, applied. */
export function restyledWorkbook(workbook: Workbook, patch: TableStylePatch, only?: TableScope): Workbook {
  return clearedForStyle(restyleTables(workbook, patch, only), patch, only);
}

function spansSheet(range: CellRange): boolean {
  return range.r2 - range.r1 >= MAX_SHEET_ROWS - 1 || range.c2 - range.c1 >= MAX_SHEET_COLS - 1;
}

/** The range Format as table would use, as Excel picks it: the selection when
 * it spans cells, else the data around the cursor; null without a data row. */
export function regionForTable(engine: WorkbookEngine, sheetId: string, selection: CellRange, active: CellPoint): CellRange | null {
  const single = selection.r1 === selection.r2 && selection.c1 === selection.c2;
  const region = single || spansSheet(selection) ? currentRegion(sheetId, engine, active.row, active.col) : selection;
  return region.r2 > region.r1 ? region : null;
}

/** Whether a picked style would land on cells with their own colors: in the
 * cursor's table, else in every table, else in the data it would format. */
export function styleMeetsOwnColors(workbook: Workbook, sheetId: string, table: SheetTable | null, region: CellRange | null): boolean {
  const everyTable = tableTargets(workbook);
  const targets = table
    ? tableTargets(workbook, { sheetId, tableId: table.id })
    : everyTable.length ? everyTable : region ? [{ sheetId, range: region }] : [];
  return targets.some((target) => {
    const sheet = workbook.sheets.find((item) => item.id === target.sheetId);
    return Boolean(sheet && hasOwnColors(sheet, target.range));
  });
}
