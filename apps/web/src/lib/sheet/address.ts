/** A1-style addressing for the Drafts spreadsheet editor.
 *
 * Rows and columns are 0-based everywhere inside the app; only the A1 text
 * ("B12", "A:C", "'Q1 Sales'!B2:D9") is 1-based, exactly as Excel writes it.
 */

export const MAX_SHEET_ROWS = 20_000;
export const MAX_SHEET_COLS = 256; // A..IV

export type CellPoint = { row: number; col: number };

/** Inclusive rectangle; r1 <= r2 and c1 <= c2 always hold. */
export type CellRange = { r1: number; c1: number; r2: number; c2: number };

export function columnLabel(col: number): string {
  let label = "";
  let n = col + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/** "A" -> 0, "AA" -> 26. Returns -1 for anything that is not letters. */
export function columnIndex(label: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(label)) return -1;
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function cellKey(row: number, col: number): string {
  return `${columnLabel(col)}${row + 1}`;
}

const CELL_RE = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;

/** Parses "B12" or "$B$12"; null when the text is not an in-bounds cell. */
export function parseCellKey(text: string): CellPoint | null {
  const match = CELL_RE.exec(text.trim());
  if (!match) return null;
  const col = columnIndex(match[1]);
  const row = Number(match[2]) - 1;
  if (col < 0 || col >= MAX_SHEET_COLS || row < 0 || row >= MAX_SHEET_ROWS) return null;
  return { row, col };
}

export function normalizeRange(a: CellPoint, b: CellPoint): CellRange {
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.col, b.col),
  };
}

export function singleCellRange(point: CellPoint): CellRange {
  return { r1: point.row, c1: point.col, r2: point.row, c2: point.col };
}

/** Parses "A1:C5", "C5:A1", "B2", "A:C" (whole columns), or "2:4" (whole rows). */
export function parseRangeRef(text: string): CellRange | null {
  const trimmed = text.trim();
  const parts = trimmed.split(":");
  if (parts.length === 1) {
    const point = parseCellKey(parts[0]);
    return point ? singleCellRange(point) : null;
  }
  if (parts.length !== 2) return null;
  const [left, right] = parts.map((part) => part.replace(/\$/g, ""));
  if (/^[A-Za-z]{1,3}$/.test(left) && /^[A-Za-z]{1,3}$/.test(right)) {
    const a = columnIndex(left);
    const b = columnIndex(right);
    if (a < 0 || b < 0 || a >= MAX_SHEET_COLS || b >= MAX_SHEET_COLS) return null;
    return { r1: 0, c1: Math.min(a, b), r2: MAX_SHEET_ROWS - 1, c2: Math.max(a, b) };
  }
  if (/^[0-9]{1,7}$/.test(left) && /^[0-9]{1,7}$/.test(right)) {
    const a = Number(left) - 1;
    const b = Number(right) - 1;
    if (a < 0 || b < 0 || a >= MAX_SHEET_ROWS || b >= MAX_SHEET_ROWS) return null;
    return { r1: Math.min(a, b), c1: 0, r2: Math.max(a, b), c2: MAX_SHEET_COLS - 1 };
  }
  const start = parseCellKey(left);
  const end = parseCellKey(right);
  return start && end ? normalizeRange(start, end) : null;
}

export function formatRangeRef(range: CellRange): string {
  const start = cellKey(range.r1, range.c1);
  if (range.r1 === range.r2 && range.c1 === range.c2) return start;
  if (range.r1 === 0 && range.r2 === MAX_SHEET_ROWS - 1) {
    return `${columnLabel(range.c1)}:${columnLabel(range.c2)}`;
  }
  if (range.c1 === 0 && range.c2 === MAX_SHEET_COLS - 1) return `${range.r1 + 1}:${range.r2 + 1}`;
  return `${start}:${cellKey(range.r2, range.c2)}`;
}

export function rangeContains(range: CellRange, row: number, col: number): boolean {
  return row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2;
}

export function rangesIntersect(a: CellRange, b: CellRange): boolean {
  return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
}

export function rangeSize(range: CellRange): { rows: number; cols: number } {
  return { rows: range.r2 - range.r1 + 1, cols: range.c2 - range.c1 + 1 };
}

/** Sheet names that need no quotes in a formula: letters, digits, "_", ".",
 * not starting with a digit, and not readable as a cell or R1C1 address. */
export function quoteSheetName(name: string): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !parseCellKey(name) && !/^R[0-9]*C[0-9]*$/i.test(name);
  return plain ? name : `'${name.replace(/'/g, "''")}'`;
}

/** Splits "'Q1 Sales'!B2:D9" into its sheet name and range text. */
export function splitSheetQualifiedRef(text: string): { sheet: string | null; ref: string } {
  const trimmed = text.trim();
  const bang = trimmed.lastIndexOf("!");
  if (bang < 0) return { sheet: null, ref: trimmed };
  let sheet = trimmed.slice(0, bang);
  if (sheet.startsWith("'") && sheet.endsWith("'") && sheet.length >= 2) {
    sheet = sheet.slice(1, -1).replace(/''/g, "'");
  }
  return { sheet, ref: trimmed.slice(bang + 1) };
}

export function forEachCellInRange(range: CellRange, visit: (row: number, col: number) => void): void {
  for (let row = range.r1; row <= range.r2; row += 1) {
    for (let col = range.c1; col <= range.c2; col += 1) visit(row, col);
  }
}
