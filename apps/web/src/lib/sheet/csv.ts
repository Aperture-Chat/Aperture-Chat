/** CSV and TSV for the Drafts spreadsheet editor.
 *
 * Import reads RFC 4180 text (quoted fields, doubled quotes, line breaks
 * inside quotes), detects the delimiter, and types each field the way typing
 * it into a cell would. Text that starts with "=" stays literal text: a CSV
 * is data, so opening one must never create formulas (CSV injection).
 *
 * Export writes the displayed text of the used range with CRLF line ends and,
 * by default, a UTF-8 byte-order mark so Excel reads accented text correctly.
 * Any field that a spreadsheet would read as a formula (one starting with
 * = + - @, tab, or carriage return, unless it is plainly a number such as
 * "-12.5" or "-$1,200") gets a leading apostrophe, the OWASP mitigation for
 * CSV formula injection, so opening the file elsewhere cannot run it.
 */

import { type CellRange, MAX_SHEET_COLS, MAX_SHEET_ROWS, cellKey, columnLabel, parseCellKey } from "./address";
import { parseCellInput } from "./numberFormat";
import {
  type CellLiteral,
  type Sheet,
  type SheetCell,
  type SheetColumn,
  type Workbook,
  MAX_WORKBOOK_CELLS,
  SHEET_SCHEMA_VERSION,
  parseWorkbook,
  uniqueSheetName,
} from "./sheetModel";

const BOM = "﻿";
const DELIMITERS = [",", ";", "\t", "|"] as const;
const SAMPLE_LINES = 10;
const MIN_IMPORT_COL_WIDTH = 64;
const MAX_IMPORT_COL_WIDTH = 400;

/* ------------------------------------------------------------------ parsing */

type Field = { value: string; next: number };

function isFieldEnd(ch: string, delimiter: string): boolean {
  return ch === delimiter || ch === "\n" || ch === "\r";
}

function readBare(source: string, start: number, delimiter: string): Field {
  let index = start;
  while (index < source.length && !isFieldEnd(source[index], delimiter)) index += 1;
  return { value: source.slice(start, index), next: index };
}

/** A quoted field; text after the closing quote (malformed input) is kept. */
function readQuoted(source: string, open: number, delimiter: string): Field {
  let value = "";
  let index = open + 1;
  for (;;) {
    const quote = source.indexOf('"', index);
    if (quote < 0) return { value: value + source.slice(index), next: source.length };
    value += source.slice(index, quote);
    if (source[quote + 1] !== '"') {
      const tail = readBare(source, quote + 1, delimiter);
      return { value: value + tail.value, next: tail.next };
    }
    value += '"';
    index = quote + 2;
  }
}

function readField(source: string, start: number, delimiter: string): Field {
  return source[start] === '"' ? readQuoted(source, start, delimiter) : readBare(source, start, delimiter);
}

function skipLineBreak(source: string, index: number): number {
  if (source[index] === "\r" && source[index + 1] === "\n") return index + 2;
  return source[index] === "\r" || source[index] === "\n" ? index + 1 : index;
}

function readRecord(source: string, start: number, delimiter: string): { fields: string[]; next: number } {
  const fields: string[] = [];
  let index = start;
  for (;;) {
    const field = readField(source, index, delimiter);
    fields.push(field.value);
    index = field.next;
    if (source[index] !== delimiter) break;
    index += 1;
  }
  return { fields, next: skipLineBreak(source, index) };
}

/** Delimiter counts outside quotes for each of the first lines. */
function sampleLineCounts(source: string): Record<string, number>[] {
  const lines: Record<string, number>[] = [];
  let counts: Record<string, number> = {};
  let quoted = false;
  for (let index = 0; index < source.length && lines.length < SAMPLE_LINES; index += 1) {
    const ch = source[index];
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === "\n") {
      lines.push(counts);
      counts = {};
    } else if ((DELIMITERS as readonly string[]).includes(ch)) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  if (Object.keys(counts).length) lines.push(counts);
  return lines;
}

/** Lines that agree with the first line's count matter most; the count
 * itself breaks ties. A delimiter missing from the first line scores 0. */
function delimiterScore(counts: number[]): number {
  const first = counts[0] ?? 0;
  if (!first) return 0;
  return counts.filter((count) => count === first).length * 1000 + first;
}

function detectDelimiter(source: string): string {
  const lines = sampleLineCounts(source);
  let best: string = ",";
  let bestScore = 0;
  for (const candidate of DELIMITERS) {
    const score = delimiterScore(lines.map((counts) => counts[candidate] ?? 0));
    if (score > bestScore) [best, bestScore] = [candidate, score];
  }
  return best;
}

/** Splits delimited text into rows of fields. Without a delimiter, the most
 * consistent of comma, semicolon, tab, and pipe in the first lines wins. */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const source = text.startsWith(BOM) ? text.slice(1) : text;
  const separator = delimiter ?? detectDelimiter(source);
  const rows: string[][] = [];
  let index = 0;
  while (index < source.length) {
    const record = readRecord(source, index, separator);
    rows.push(record.fields);
    index = record.next;
  }
  return rows;
}

/* ------------------------------------------------------------------ import */

export type DelimitedImport = { workbook: Workbook; warnings: string[] };

function nonEmptyCount(row: string[]): number {
  return row.reduce((total, field) => total + (field.trim() ? 1 : 0), 0);
}

/** Keeps what fits the sheet and workbook limits, warning for each cut. */
function fitGrid(grid: string[][], warnings: string[]): string[][] {
  if (grid.length > MAX_SHEET_ROWS) warnings.push(`Only the first ${MAX_SHEET_ROWS.toLocaleString("en-US")} rows were imported.`);
  if (grid.some((row) => row.length > MAX_SHEET_COLS)) warnings.push(`Only the first ${MAX_SHEET_COLS} columns (A–${columnLabel(MAX_SHEET_COLS - 1)}) were imported.`);
  const rows = grid.slice(0, MAX_SHEET_ROWS).map((row) => row.slice(0, MAX_SHEET_COLS));
  let budget = MAX_WORKBOOK_CELLS;
  for (const [index, row] of rows.entries()) {
    budget -= nonEmptyCount(row);
    if (budget < 0) {
      warnings.push(`Only the first ${index.toLocaleString("en-US")} rows fit the ${MAX_WORKBOOK_CELLS.toLocaleString("en-US")}-cell workbook limit.`);
      return rows.slice(0, index);
    }
  }
  return rows;
}

/** A field typed as if entered in a cell; formula-looking text stays text. */
function cellFromField(field: string): SheetCell | undefined {
  const parsed = parseCellInput(field);
  if (parsed.kind === "empty") return undefined;
  if (parsed.kind === "formula") return { v: field };
  return parsed.format ? { v: parsed.value, s: { format: parsed.format } } : { v: parsed.value };
}

function typedRow(row: string[]): (CellLiteral | undefined)[] {
  return row.map((field) => cellFromField(field)?.v);
}

/** A header: some text, nothing but text, over a row holding a number. */
function looksLikeHeader(grid: string[][]): boolean {
  if (grid.length < 2) return false;
  const first = typedRow(grid[0]).filter((value) => value !== undefined);
  if (!first.length || first.some((value) => typeof value !== "string")) return false;
  return typedRow(grid[1]).some((value) => typeof value === "number");
}

function cellsFromGrid(grid: string[][]): Record<string, SheetCell> {
  const cells: Record<string, SheetCell> = {};
  grid.forEach((row, rowIndex) =>
    row.forEach((field, colIndex) => {
      const cell = cellFromField(field);
      if (cell) cells[cellKey(rowIndex, colIndex)] = cell;
    }),
  );
  return cells;
}

function boldFirstRow(cells: Record<string, SheetCell>, width: number): void {
  for (let col = 0; col < width; col += 1) {
    const cell = cells[cellKey(0, col)];
    if (cell) cell.s = { ...cell.s, bold: true };
  }
}

function longestLine(field: string): number {
  return Math.max(...field.split(/\r\n|\r|\n/).map((line) => line.length));
}

function columnWidths(grid: string[][]): Record<string, SheetColumn> | undefined {
  const longest: number[] = [];
  grid.forEach((row) => row.forEach((field, col) => {
    if (field.trim()) longest[col] = Math.max(longest[col] ?? 0, longestLine(field));
  }));
  const cols: Record<string, SheetColumn> = {};
  longest.forEach((chars, col) => {
    cols[columnLabel(col)] = { w: Math.min(MAX_IMPORT_COL_WIDTH, Math.max(MIN_IMPORT_COL_WIDTH, Math.round(chars * 7 + 16))) };
  });
  return Object.keys(cols).length ? cols : undefined;
}

function sheetNameFor(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/, "").replace(/[:\\/?*[\]]/g, " ").trim();
  return base ? uniqueSheetName(base, []) : "Sheet1";
}

/** One sheet holding the delimited text, typed and sized for reading. */
export function workbookFromDelimited(name: string, text: string): DelimitedImport {
  const warnings: string[] = [];
  const grid = fitGrid(parseDelimited(text), warnings);
  const cells = cellsFromGrid(grid);
  if (looksLikeHeader(grid)) boldFirstRow(cells, grid[0].length);
  const sheet: Sheet = { id: "sheet-1", name: sheetNameFor(name), cells, cols: columnWidths(grid) };
  const parsed = parseWorkbook({ schema: SHEET_SCHEMA_VERSION, sheets: [sheet] });
  if (!parsed.ok) throw new Error(parsed.error);
  return { workbook: parsed.workbook, warnings: [...warnings, ...parsed.warnings] };
}

/* ------------------------------------------------------------------ export */

export type DelimitedExportOptions = {
  /** Field separator; "," by default. */
  delimiter?: string;
  /** Prefix a UTF-8 byte-order mark (default true). */
  bom?: boolean;
  /** Range to write; by default A1 through the last filled cell. Callers pass
   * this to include spilled or pivot output beyond the stored cells. */
  range?: CellRange;
};

function usedRange(sheet: Sheet): CellRange | null {
  let lastRow = -1;
  let lastCol = -1;
  for (const [key, cell] of Object.entries(sheet.cells)) {
    const point = parseCellKey(key);
    if (!point || (cell.v === undefined && cell.f === undefined)) continue;
    lastRow = Math.max(lastRow, point.row);
    lastCol = Math.max(lastCol, point.col);
  }
  return lastRow < 0 ? null : { r1: 0, c1: 0, r2: lastRow, c2: lastCol };
}

const INJECTION_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?[$€£¥]?(\d[\d,]*\.?\d*|\.\d+)(e[+-]?\d+)?%?$/i;

/** Prefixes an apostrophe when a spreadsheet would read the text as a formula. */
function neutralizeFormula(text: string): string {
  return INJECTION_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
}

function exportField(text: string, delimiter: string): string {
  const safe = neutralizeFormula(text);
  const quote = safe.includes(delimiter) || /["\r\n]/.test(safe);
  return quote ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The sheet as delimited text: `valueOf` supplies each cell's displayed text. */
export function sheetToDelimited(
  sheet: Sheet,
  valueOf: (row: number, col: number) => { text: string },
  options: DelimitedExportOptions = {},
): string {
  const delimiter = options.delimiter ?? ",";
  const range = options.range ?? usedRange(sheet);
  let out = options.bom === false ? "" : BOM;
  if (!range) return out;
  for (let row = range.r1; row <= range.r2; row += 1) {
    const fields: string[] = [];
    for (let col = range.c1; col <= range.c2; col += 1) fields.push(exportField(valueOf(row, col).text, delimiter));
    out += `${fields.join(delimiter)}\r\n`;
  }
  return out;
}
