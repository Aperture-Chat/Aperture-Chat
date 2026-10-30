/** State shared by every part of one .xlsx export: the computed engine, the
 * workbook-wide style and string tables, the warning log, and the hidden
 * sheet that holds dropdown lists too long to write inline. */

import { formatRangeRef, rangesIntersect, type CellRange } from "../address";
import type { WorkbookEngine } from "../recalc";
import type { Sheet, Workbook } from "../sheetModel";
import { DropdownLists } from "./dropdownLists";
import { SharedStrings } from "./sharedStrings";
import { StyleBook } from "./styles";
import { WarningLog } from "./xml";

export type ExportContext = {
  workbook: Workbook;
  engine: WorkbookEngine;
  styles: StyleBook;
  strings: SharedStrings;
  log: WarningLog;
  lists: DropdownLists;
  /** Set once any cell is written as a dynamic array (needs metadata.xml). */
  dynamicArrays: boolean;
};

export function createContext(workbook: Workbook, engine: WorkbookEngine): ExportContext {
  const log = new WarningLog();
  return {
    workbook,
    engine,
    styles: new StyleBook(),
    strings: new SharedStrings(log),
    log,
    lists: new DropdownLists(workbook.sheets),
    dynamicArrays: false,
  };
}

/** The objects on one sheet that constrain where cells may go: tables and
 * merges that survived the overlap checks Excel would otherwise repair. */
export type SheetPlan = {
  sheet: Sheet;
  index: number;
  tables: TablePlan[];
  merges: CellRange[];
};

export type TablePlan = {
  name: string;
  range: CellRange;
  /** Unique, non-empty column names, also written into the header row. */
  columns: string[];
};

export function overlapsAny(range: CellRange, others: { range: CellRange }[] | CellRange[]): boolean {
  return others.some((other) => rangesIntersect(range, "range" in other ? other.range : other));
}

export function rangeText(range: CellRange): string {
  return formatRangeRef(range);
}
