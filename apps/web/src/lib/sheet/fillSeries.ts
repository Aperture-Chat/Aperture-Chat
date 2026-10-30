/** The fill handle: extends a selection down, up, right, or left the way
 * Excel's AutoFill does. Numbers follow their linear trend, a single date
 * steps by a day (monthly or yearly when the examples do), "Item 3" counts
 * on, month and weekday names cycle, formulas shift their relative
 * references, and anything else repeats. Styles repeat with the pattern. */

import { type CellRange, cellKey } from "./address";
import { shiftFormula } from "./formula/references";
import { dateToSerial, serialToDate } from "./formula/values";
import { isDateFormat } from "./numberFormat";
import { getCell, updateSheet, writeCells } from "./sheetOps";
import type { Sheet, SheetCell, Workbook } from "./sheetModel";

export type FillDirection = "down" | "up" | "right" | "left";

const MONTHS_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTHS_LONG = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAYS_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAYS_LONG = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const CYCLES = [MONTHS_LONG, MONTHS_SHORT, DAYS_LONG, DAYS_SHORT];

function matchCase(template: string, word: string): string {
  if (template === template.toUpperCase()) return word.toUpperCase();
  if (template[0] === template[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

function cycleIndex(text: string): { cycle: string[]; index: number } | null {
  const lower = text.trim().toLowerCase();
  for (const cycle of CYCLES) {
    const index = cycle.indexOf(lower);
    if (index >= 0) return { cycle, index };
  }
  return null;
}

const QUARTER = /^(Q|Qtr\s?|Quarter\s)([1-4])$/i;
const TRAILING_NUMBER = /^(.*?)(\d+)$/;

type Generator = (step: number) => SheetCell;
type Offsets = { dRow: number; dCol: number };
/** A source cell holding a typed value (no formula). */
type LiteralCell = SheetCell & { v: string | number | boolean };
/** Writes a generated value into the source cell the pattern lines up with. */
type ValueWriter = (value: string | number, index: number) => SheetCell;

/** Builds a generator for one line of source cells (in fill order). `step` is
 * 1 for the first cell past the source, 2 for the next, and so on. */
function seriesFor(cells: (SheetCell | undefined)[], offsets: Offsets): Generator {
  const repeat = repeatSeries(cells, offsets);
  if (!cells.every((cell): cell is LiteralCell => cell !== undefined && cell.f === undefined && cell.v !== undefined)) return repeat;
  const values = cells.map((cell) => cell.v);
  const withValue = valueWriter(cells);
  if (values.every((value): value is number => typeof value === "number")) return numberSeries(cells, values, withValue) ?? repeat;
  if (values.every((value): value is string => typeof value === "string")) return textSeries(values, withValue) ?? repeat;
  return repeat;
}

/** Repeats the source cells in order, shifting formulas by how far each copy lands. */
function repeatSeries(cells: (SheetCell | undefined)[], offsets: Offsets): Generator {
  const n = cells.length;
  return (step) => {
    const index = (n + step - 1) % n;
    const cell = cells[index];
    if (!cell) return {};
    const distance = n + step - 1 - index;
    return shiftedCopy(cell, offsets.dRow * distance, offsets.dCol * distance);
  };
}

function shiftedCopy(cell: SheetCell, dRow: number, dCol: number): SheetCell {
  return cell.f ? { ...cell, f: shiftFormula(cell.f, dRow, dCol) } : { ...cell };
}

function valueWriter(cells: LiteralCell[]): ValueWriter {
  const n = cells.length;
  const style = cells[n - 1].s;
  return (value, index) => {
    const template = cells[(index + n) % n];
    return { ...template, v: value, ...(template.s ?? style ? { s: template.s ?? style } : {}) };
  };
}

function numberSeries(cells: LiteralCell[], numbers: number[], withValue: ValueWriter): Generator | null {
  if (isDateFormat(cells[0].s?.format)) return dateSeries(numbers, withValue);
  if (numbers.length === 1) return null;
  return trendSeries(numbers, withValue);
}

/** Dates step by month or year when the examples share a day of the month, else by days. */
function dateSeries(numbers: number[], withValue: ValueWriter): Generator {
  const n = numbers.length;
  const parts = numbers.map((serial) => serialToDate(serial));
  const stepMonths = monthStep(parts);
  if (stepMonths !== null) return monthSeries(parts, numbers, stepMonths, withValue);
  const stepDays = n >= 2 ? numbers[n - 1] - numbers[n - 2] : 1;
  return (step) => withValue(numbers[n - 1] + stepDays * step, n - 1 + step);
}

type DateParts = ReturnType<typeof serialToDate>;

/** Months between the first two examples when they step by whole months or years; null otherwise. */
function monthStep(parts: DateParts[]): number | null {
  if (parts.length < 2) return null;
  const yearly = parts.every((part) => part.day === parts[0].day && part.month === parts[0].month);
  const years = (parts[1].year - parts[0].year) * 12;
  if (yearly) return years;
  const monthly = parts.every((part) => part.day === parts[0].day) && parts.some((part, i) => i > 0 && part.month !== parts[i - 1].month);
  return monthly ? years + parts[1].month - parts[0].month : null;
}

/** Steps whole months from the last example, keeping its day (clamped to short months) and time. */
function monthSeries(parts: DateParts[], numbers: number[], stepMonths: number, withValue: ValueWriter): Generator {
  const n = parts.length;
  const last = parts[n - 1];
  return (step) => {
    const total = last.month - 1 + stepMonths * step;
    const year = last.year + Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12 + 1;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return withValue(dateToSerial(year, month, Math.min(last.day, daysInMonth)) + (numbers[n - 1] % 1), n - 1 + step);
  };
}

/** Least-squares trend, as Excel's AutoFill uses for 2+ numbers. */
function trendSeries(numbers: number[], withValue: ValueWriter): Generator {
  const n = numbers.length;
  const meanX = (n - 1) / 2;
  const meanY = numbers.reduce((total, item) => total + item, 0) / n;
  let num = 0;
  let den = 0;
  numbers.forEach((y, x) => { num += (x - meanX) * (y - meanY); den += (x - meanX) ** 2; });
  const slope = den ? num / den : 0;
  const intercept = meanY - slope * meanX;
  return (step) => withValue(Number((intercept + slope * (n - 1 + step)).toPrecision(15)), n - 1 + step);
}

function textSeries(texts: string[], withValue: ValueWriter): Generator | null {
  return cycleSeries(texts, withValue) ?? quarterSeries(texts, withValue) ?? numberedSeries(texts, withValue);
}

/** Month or weekday names from one cycle, stepping by the gap between the last two. */
function cycleSeries(texts: string[], withValue: ValueWriter): Generator | null {
  const n = texts.length;
  const cycles = texts.map(cycleIndex);
  if (!cycles.every((item) => item && item.cycle === cycles[0]!.cycle)) return null;
  const indexes = cycles.map((item) => item!.index);
  const cycle = cycles[0]!.cycle;
  const size = cycle.length;
  const stepSize = n >= 2 ? (((indexes[n - 1] - indexes[n - 2]) % size) + size) % size || 1 : 1;
  return (step) => withValue(matchCase(texts[n - 1], cycle[(indexes[n - 1] + stepSize * step) % size]), n - 1 + step);
}

function quarterSeries(texts: string[], withValue: ValueWriter): Generator | null {
  const quarters = texts.map((text) => QUARTER.exec(text.trim()));
  if (!quarters.every(Boolean)) return null;
  const last = quarters[texts.length - 1]!;
  return (step) => withValue(`${last[1]}${((Number(last[2]) - 1 + step) % 4) + 1}`, texts.length - 1 + step);
}

/** "Item 3" counts on by the last gap, keeping zero padding and never going below 0. */
function numberedSeries(texts: string[], withValue: ValueWriter): Generator | null {
  const n = texts.length;
  const numbered = texts.map((text) => TRAILING_NUMBER.exec(text));
  if (!numbered.every(Boolean) || !numbered.every((match) => match![1] === numbered[0]![1])) return null;
  const counts = numbered.map((match) => Number(match![2]));
  const stepSize = n >= 2 ? counts[n - 1] - counts[n - 2] : 1;
  const digits = numbered[n - 1]![2];
  return (step) => {
    const next = Math.max(0, counts[n - 1] + stepSize * step);
    const shown = digits.startsWith("0") ? String(next).padStart(digits.length, "0") : String(next);
    return withValue(`${numbered[0]![1]}${shown}`, n - 1 + step);
  };
}

/** Extends `source` to cover `target` (which must contain it and differ along
 * one axis). Returns the new workbook. */
export function fillRange(workbook: Workbook, sheetId: string, source: CellRange, target: CellRange): Workbook {
  const direction: FillDirection | null =
    target.r2 > source.r2 ? "down" : target.r1 < source.r1 ? "up" : target.c2 > source.c2 ? "right" : target.c1 < source.c1 ? "left" : null;
  if (!direction) return workbook;
  return updateSheet(workbook, sheetId, (sheet) => fillSheet(sheet, source, target, direction));
}

/** How each fill direction walks the grid. */
type FillAxis = {
  /** Lines are columns (true) or rows (false). */
  vertical: boolean;
  /** Source cells are read from the far end first (up and left). */
  reversed: boolean;
  unit: Offsets;
  span: (source: CellRange, target: CellRange) => number;
  at: (source: CellRange, line: number, step: number) => { row: number; col: number };
};

const FILL_AXES: Record<FillDirection, FillAxis> = {
  down: { vertical: true, reversed: false, unit: { dRow: 1, dCol: 0 }, span: (source, target) => target.r2 - source.r2, at: (source, line, step) => ({ row: source.r2 + step, col: line }) },
  up: { vertical: true, reversed: true, unit: { dRow: -1, dCol: 0 }, span: (source, target) => source.r1 - target.r1, at: (source, line, step) => ({ row: source.r1 - step, col: line }) },
  right: { vertical: false, reversed: false, unit: { dRow: 0, dCol: 1 }, span: (source, target) => target.c2 - source.c2, at: (source, line, step) => ({ row: line, col: source.c2 + step }) },
  left: { vertical: false, reversed: true, unit: { dRow: 0, dCol: -1 }, span: (source, target) => source.c1 - target.c1, at: (source, line, step) => ({ row: line, col: source.c1 - step }) },
};

function fillSheet(sheet: Sheet, source: CellRange, target: CellRange, direction: FillDirection): Sheet {
  const axis = FILL_AXES[direction];
  const updates: { row: number; col: number; cell: SheetCell | null }[] = [];
  const [first, last] = axis.vertical ? [source.c1, source.c2] : [source.r1, source.r2];
  const span = axis.span(source, target);
  for (let line = first; line <= last; line += 1) {
    const generate = seriesFor(lineCells(sheet, source, line, axis), axis.unit);
    for (let step = 1; step <= span; step += 1) {
      const cell = generate(step);
      updates.push({ ...axis.at(source, line, step), cell: Object.keys(cell).length ? cell : null });
    }
  }
  return writeCells(sheet, updates);
}

/** One line of source cells, in fill order. */
function lineCells(sheet: Sheet, source: CellRange, line: number, axis: FillAxis): (SheetCell | undefined)[] {
  const indexes = axis.vertical ? spanIndexes(source.r1, source.r2) : spanIndexes(source.c1, source.c2);
  const ordered = axis.reversed ? indexes.reverse() : indexes;
  return ordered.map((index) => (axis.vertical ? getCell(sheet, index, line) : getCell(sheet, line, index)));
}

function spanIndexes(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Ctrl+D / Ctrl+R: copy the first row (or column) of a range into the rest. */
export function fillFromEdge(workbook: Workbook, sheetId: string, range: CellRange, axis: "down" | "right"): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => {
    const updates: { row: number; col: number; cell: SheetCell | null }[] = [];
    for (let row = range.r1; row <= range.r2; row += 1) {
      for (let col = range.c1; col <= range.c2; col += 1) {
        const fromRow = axis === "down" ? range.r1 : row;
        const fromCol = axis === "right" ? range.c1 : col;
        if (row === fromRow && col === fromCol) continue;
        const cell = sheet.cells[cellKey(fromRow, fromCol)];
        updates.push({ row, col, cell: cell ? shiftedCopy(cell, row - fromRow, col - fromCol) : null });
      }
    }
    return writeCells(sheet, updates);
  });
}
