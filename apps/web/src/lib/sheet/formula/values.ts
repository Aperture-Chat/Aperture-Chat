/** Runtime values for the spreadsheet formula engine and Excel's coercion rules.
 *
 * A scalar is a number, text, boolean, error, or null (an empty cell). A range
 * or array evaluates to a matrix: rows of scalars, always rectangular and never
 * empty. Dates are Excel serial numbers (days since 1899-12-30), so they take
 * part in arithmetic exactly as they do in Excel.
 */

export const ERROR_CODES = [
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
  "#SPILL!",
  "#CALC!",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class SheetError {
  readonly code: ErrorCode;
  /** Plain-English reason shown in the cell's tooltip and to the AI fixer. */
  readonly message?: string;
  constructor(code: ErrorCode, message?: string) {
    this.code = code;
    this.message = message;
  }
  toString(): string {
    return this.code;
  }
}

export const ERR = {
  null: new SheetError("#NULL!"),
  div0: new SheetError("#DIV/0!", "Division by zero."),
  value: new SheetError("#VALUE!", "A value has the wrong type."),
  ref: new SheetError("#REF!", "The formula refers to a cell that does not exist."),
  name: new SheetError("#NAME?", "Unknown function or name."),
  num: new SheetError("#NUM!", "The number is out of range."),
  na: new SheetError("#N/A", "No value is available."),
  spill: new SheetError("#SPILL!", "The result needs empty cells to spill into."),
  calc: new SheetError("#CALC!", "The calculation could not finish."),
} as const;

export function sheetError(code: ErrorCode, message?: string): SheetError {
  return new SheetError(code, message);
}

export type Scalar = number | string | boolean | SheetError | null;
export type Matrix = Scalar[][];
export type Value = Scalar | Matrix;

export function isError(value: unknown): value is SheetError {
  return value instanceof SheetError;
}

export function isMatrix(value: Value): value is Matrix {
  return Array.isArray(value);
}

/** Top-left of a matrix (Excel's implicit intersection fallback), or the scalar. */
export function toScalar(value: Value): Scalar {
  if (!isMatrix(value)) return value;
  return value[0]?.[0] ?? null;
}

export function asMatrix(value: Value): Matrix {
  return isMatrix(value) ? value : [[value]];
}

export function matrixSize(value: Matrix): { rows: number; cols: number } {
  return { rows: value.length, cols: value[0]?.length ?? 0 };
}

/** Every scalar of every argument, row by row. */
export function flatten(values: Value[]): Scalar[] {
  const out: Scalar[] = [];
  for (const value of values) {
    if (isMatrix(value)) for (const row of value) for (const item of row) out.push(item);
    else out.push(value);
  }
  return out;
}

export function firstError(values: Iterable<Scalar>): SheetError | null {
  for (const value of values) if (isError(value)) return value;
  return null;
}

const NUMERIC_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

/** Text Excel would read as a number in arithmetic: "1,234", "$5", "12%", "(3)". */
export function parseNumericText(text: string): number | null {
  let body = text.trim();
  if (!body) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(body)) {
    sign = -1;
    body = body.slice(1, -1).trim();
  }
  let scale = 1;
  if (body.endsWith("%")) {
    scale = 0.01;
    body = body.slice(0, -1).trim();
  }
  if (body.startsWith("-")) {
    sign *= -1;
    body = body.slice(1).trim();
  } else if (body.startsWith("+")) {
    body = body.slice(1).trim();
  }
  body = body.replace(/^[$€£¥]/, "").trim();
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(body)) body = body.replace(/,/g, "");
  if (!NUMERIC_TEXT.test(body)) return null;
  const value = Number(body) * sign * scale;
  return Number.isFinite(value) ? value : null;
}

export function toNumber(value: Scalar): number | SheetError {
  if (typeof value === "number") return value;
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (isError(value)) return value;
  const parsed = parseNumericText(value);
  if (parsed !== null) return parsed;
  const date = parseDateText(value);
  return date ?? sheetError("#VALUE!", `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}" is not a number.`);
}

export function toBoolean(value: Scalar): boolean | SheetError {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value === null) return false;
  if (isError(value)) return value;
  const upper = value.trim().toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  return sheetError("#VALUE!", `"${value}" is not TRUE or FALSE.`);
}

/** Excel's text form of a number in formulas: up to 15 significant digits. */
export function formatGeneralNumber(value: number): string {
  if (!Number.isFinite(value)) return "#NUM!";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e15 || abs < 1e-9) {
    const [mantissa, exponent] = value.toExponential(14).split("e");
    const trimmed = mantissa.replace(/\.?0+$/, "");
    const exp = Number(exponent);
    return `${trimmed}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const precise = Number(value.toPrecision(15));
  return String(precise).includes("e") ? precise.toFixed(20).replace(/\.?0+$/, "") : String(precise);
}

export function toText(value: Scalar): string | SheetError {
  if (typeof value === "string") return value;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (isError(value)) return value;
  return formatGeneralNumber(value);
}

/* ------------------------------------------------------------------ dates */

/** Serial 1 is 1900-01-01. Excel counts a fictional 1900-02-29 (serial 60), so
 * serials from 61 on are one day ahead of a plain day count from 1899-12-31. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export function dateToSerial(year: number, month: number, day: number): number {
  const utc = Date.UTC(year, month - 1, day);
  const serial = Math.round((utc - EXCEL_EPOCH_UTC) / DAY_MS);
  return serial < 61 ? serial - 1 : serial;
}

export function serialToDate(serial: number): { year: number; month: number; day: number; weekday: number } {
  const whole = Math.floor(serial);
  // Excel's calendar before March 1900 is shifted by its fictional
  // 1900-02-29: serial 0 is "January 0, 1900" (a Saturday) and serial 1,
  // 1900-01-01, is a Sunday, one weekday earlier than the real calendar.
  if (whole === 0) return { year: 1900, month: 1, day: 0, weekday: 6 };
  if (whole === 60) return { year: 1900, month: 2, day: 29, weekday: 3 };
  const adjusted = whole < 61 ? whole + 1 : whole;
  const date = new Date(EXCEL_EPOCH_UTC + adjusted * DAY_MS);
  const weekday = whole > 0 && whole < 60 ? (date.getUTCDay() + 6) % 7 : date.getUTCDay();
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday };
}

export function timeToFraction(hours: number, minutes: number, seconds: number): number {
  return (hours * 3600 + minutes * 60 + seconds) / 86_400;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Reads the date and time text people type: "3/15/2027", "2027-03-15",
 * "15-Mar-2027", "Mar 15, 2027", optionally followed by "14:30" or "2:30 PM". */
export function parseDateText(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 40) return null;
  const timeMatch = /(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?$/i.exec(trimmed);
  let time = 0;
  let datePart = trimmed;
  if (timeMatch) {
    let hours = Number(timeMatch[1]);
    const meridiem = timeMatch[4]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    if (hours > 23 || Number(timeMatch[2]) > 59 || Number(timeMatch[3] ?? 0) > 59) return null;
    time = timeToFraction(hours, Number(timeMatch[2]), Number(timeMatch[3] ?? 0));
    datePart = trimmed.slice(0, timeMatch.index).trim();
    if (!datePart) return time;
  }
  let year: number;
  let month: number;
  let day: number;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(datePart))) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(datePart))) {
    [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (year < 100) year += year < 30 ? 2000 : 1900;
  } else if ((match = /^(\d{1,2})[\s-]([a-z]{3,9})[\s-,]+(\d{4})$/i.exec(datePart))) {
    day = Number(match[1]);
    month = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase()) + 1;
    year = Number(match[3]);
  } else if ((match = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(datePart))) {
    month = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
    day = Number(match[2]);
    year = Number(match[3]);
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || year < 1900 || year > 9999) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1) return null;
  return dateToSerial(year, month, day) + time;
}

/* ------------------------------------------------------------------ comparison */

function typeRank(value: Scalar): number {
  if (typeof value === "number") return 0;
  if (typeof value === "string") return 1;
  if (typeof value === "boolean") return 2;
  return 3;
}

/** Excel ordering for comparison operators and sorting: numbers < text <
 * booleans, text compares case-insensitively, and an empty cell behaves as
 * 0, "", or FALSE depending on what it is compared with. */
export function compareScalars(left: Scalar, right: Scalar): number {
  let a = left;
  let b = right;
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA - rankB;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return 0;
}

/** Applies `fn` element-wise, broadcasting a 1x1, 1xN, or Nx1 operand. */
export function broadcast2(left: Value, right: Value, fn: (a: Scalar, b: Scalar) => Scalar): Value {
  if (!isMatrix(left) && !isMatrix(right)) return fn(left, right);
  const a = asMatrix(left);
  const b = asMatrix(right);
  const rows = Math.max(a.length, b.length);
  const cols = Math.max(a[0].length, b[0].length);
  const pick = (m: Matrix, row: number, col: number): Scalar => {
    const r = m.length === 1 ? 0 : row;
    const c = m[0].length === 1 ? 0 : col;
    return r < m.length && c < m[0].length ? m[r][c] : ERR.na;
  };
  const out: Matrix = [];
  for (let row = 0; row < rows; row += 1) {
    const line: Scalar[] = [];
    for (let col = 0; col < cols; col += 1) line.push(fn(pick(a, row, col), pick(b, row, col)));
    out.push(line);
  }
  return out;
}

export function mapValue(value: Value, fn: (item: Scalar) => Scalar): Value {
  return isMatrix(value) ? value.map((row) => row.map(fn)) : fn(value);
}
