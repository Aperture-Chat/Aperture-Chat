/** One table of console rows as a real Excel workbook. Text is stored as text,
 * so a prompt that starts with "=" can never run as a formula. */

import { cellKey, columnLabel } from "./sheet/address";
import { dateToSerial } from "./sheet/formula/values";
import { SHEET_SCHEMA_VERSION, type Sheet, type SheetCell, type Workbook } from "./sheet/sheetModel";
import { buildXlsxWorkbook, type XlsxExportResult } from "./sheet/xlsxExport";
import { exportHeaderLabel, type ExportColumn, type ExportValue } from "./tabularExport";

export type ExcelExportRequest<T> = {
  sheetName: string;
  rows: T[];
  columns: Array<ExportColumn<T>>;
};

const DATE_FORMAT = "mmm d, yyyy h:mm:ss AM/PM";
const SECONDS_PER_DAY = 86_400;
const MIN_COLUMN_PX = 80;
const MAX_COLUMN_PX = 420;
const PX_PER_CHARACTER = 8;
/** Room for the filter button in the header cell. */
const HEADER_PADDING_PX = 36;
const WIDTH_SAMPLE_ROWS = 200;
const MAX_SHEET_NAME_CHARS = 31;

/** Excel dates carry no time zone, so a timestamp is written as the local time the console shows. */
function excelDateTime(value: string): number | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const secondsToday = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  return dateToSerial(date.getFullYear(), date.getMonth() + 1, date.getDate()) + secondsToday / SECONDS_PER_DAY;
}

function exportCell<T>(column: ExportColumn<T>, value: ExportValue): SheetCell | null {
  if (value === null || value === undefined || value === "") return null;
  if (column.kind === "datetime" && typeof value === "string") {
    const serial = excelDateTime(value);
    if (serial !== null) return { v: serial, s: { format: DATE_FORMAT } };
  }
  return { v: value };
}

function columnWidth<T>(column: ExportColumn<T>, rows: T[]) {
  let longest = exportHeaderLabel(column.header).length * PX_PER_CHARACTER + HEADER_PADDING_PX;
  for (const row of rows.slice(0, WIDTH_SAMPLE_ROWS)) {
    longest = Math.max(longest, String(column.value(row) ?? "").length * PX_PER_CHARACTER);
  }
  return Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, longest));
}

function safeSheetName(name: string) {
  const cleaned = name.replace(/[:\\/?*[\]]/g, "").slice(0, MAX_SHEET_NAME_CHARS).trim();
  return cleaned.replace(/^'+|'+$/g, "") || "Export";
}

export function buildExportWorkbook<T>({ sheetName, rows, columns }: ExcelExportRequest<T>): Workbook {
  const cells: Sheet["cells"] = {};
  const cols: NonNullable<Sheet["cols"]> = {};
  columns.forEach((column, col) => {
    cells[cellKey(0, col)] = { v: exportHeaderLabel(column.header) };
    cols[columnLabel(col)] = { w: columnWidth(column, rows) };
    rows.forEach((row, index) => {
      const cell = exportCell(column, column.value(row));
      if (cell) cells[cellKey(index + 1, col)] = cell;
    });
  });
  const sheet: Sheet = { id: "export", name: safeSheetName(sheetName), cells, cols, freeze: { rows: 1, cols: 0 } };
  // Excel repairs a table with no data row, so an empty export is the header alone.
  if (rows.length > 0) {
    const ref = `A1:${cellKey(rows.length, columns.length - 1)}`;
    sheet.tables = [
      { id: "export-table", name: "ApertureExport", ref, accent: 1, tone: "medium", banded: true, totals: false, filterButtons: true },
    ];
  }
  return { schema: SHEET_SCHEMA_VERSION, sheets: [sheet] };
}

export function buildExportXlsx<T>(request: ExcelExportRequest<T>): XlsxExportResult {
  return buildXlsxWorkbook(buildExportWorkbook(request), { title: request.sheetName });
}
