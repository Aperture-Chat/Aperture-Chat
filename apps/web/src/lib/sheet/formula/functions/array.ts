/** Dynamic-array functions. Each returns a matrix that the recalculation
 * engine spills into the cells below and to the right; a scalar argument is
 * treated as a 1x1 array. An empty result is #CALC!, as in Excel. */

import type { CallContext, FunctionSpec } from "../types";
import { ERR, type Matrix, type Scalar, type SheetError, type Value, asMatrix, compareScalars, flatten, isError, sheetError, toBoolean, toNumber, toScalar } from "../values";
import { argAt, define } from "./helpers";
import { type Arg, bool, int, num, opt, optBlank } from "./scalar";

const arr = define("Array");

const MAX_ARRAY_CELLS = 2_000_000;
const EMPTY = () => sheetError("#CALC!", "The result is an empty array.");
const TOO_BIG = () => sheetError("#NUM!", "The array would be too large.");

/** Reads optional arguments in order, stopping at the first error. */
function readArgs<T extends unknown[]>(args: Value[], from: number, kinds: { [K in keyof T]: Arg<T[K]> }): T | SheetError {
  const out: unknown[] = [];
  for (const [offset, kind] of (kinds as Arg<unknown>[]).entries()) {
    const value = kind(argAt(args, from + offset));
    if (isError(value)) return value;
    out.push(value);
  }
  return out as T;
}

function transpose(matrix: Matrix): Matrix {
  return matrix[0].map((_, col) => matrix.map((row) => row[col]));
}

function nonEmpty(matrix: Matrix): Value {
  return matrix.length && matrix[0].length ? matrix : EMPTY();
}

/* ------------------------------------------------------------------ FILTER */

function truthy(value: Scalar): boolean | SheetError {
  if (typeof value === "string") return ERR.value;
  return toBoolean(value);
}

function flags(values: Scalar[]): boolean[] | SheetError {
  const out: boolean[] = [];
  for (const value of values) {
    const flag = truthy(value);
    if (isError(flag)) return flag;
    out.push(flag);
  }
  return out;
}

/** FILTER's include: a column as tall as the array, or a row as wide. */
function filterMask(source: Matrix, include: Matrix): { byRows: boolean; keep: boolean[] } | SheetError {
  const byRows = include[0].length === 1 && include.length === source.length;
  const byCols = include.length === 1 && include[0].length === source[0].length;
  if (!byRows && !byCols) return ERR.value;
  const keep = flags(byRows ? include.map((row) => row[0]) : include[0]);
  return isError(keep) ? keep : { byRows, keep };
}

function filter(args: Value[]): Value {
  const source = asMatrix(args[0]);
  const mask = filterMask(source, asMatrix(args[1]));
  if (isError(mask)) return mask;
  const { byRows, keep } = mask;
  const kept = byRows ? source.filter((_, index) => keep[index]) : source.map((row) => row.filter((_, index) => keep[index]));
  if (kept.length && kept[0].length) return kept;
  return args.length > 2 ? args[2] : sheetError("#CALC!", "No rows match the filter.");
}

/* ------------------------------------------------------------------ sorting */

type SortKey = { values: Scalar[]; descending: boolean };

function compareRows(keys: SortKey[], a: number, b: number): number {
  for (const key of keys) {
    const order = compareScalars(key.values[a], key.values[b]);
    if (order) return key.descending ? -order : order;
  }
  return 0;
}

function sortedRows(matrix: Matrix, keys: SortKey[]): Matrix {
  const order = matrix.map((_, index) => index).sort((a, b) => compareRows(keys, a, b));
  return order.map((index) => matrix[index]);
}

function orders(value: Value | undefined, count: number): boolean[] | SheetError {
  const items = value === undefined ? [1] : flatten([value]);
  const out: boolean[] = [];
  for (let index = 0; index < count; index += 1) {
    const raw = items[Math.min(index, items.length - 1)] ?? null;
    const order = raw === null ? 1 : toNumber(raw);
    if (isError(order)) return order;
    if (order !== 1 && order !== -1) return ERR.value;
    out.push(order === -1);
  }
  return out;
}

/** SORT's sort_index and sort_order, which may each be arrays. */
function sortKeys(matrix: Matrix, args: Value[]): SortKey[] | SheetError {
  const columns: Scalar[] = args.length > 1 && toScalar(args[1]) !== null ? flatten([args[1]]) : [1];
  const descending = orders(args[2], columns.length);
  if (isError(descending)) return descending;
  const keys: SortKey[] = [];
  for (const [index, column] of columns.entries()) {
    const at = int(column);
    if (isError(at)) return at;
    if (at < 1 || at > matrix[0].length) return ERR.value;
    keys.push({ values: matrix.map((row) => row[at - 1]), descending: descending[index] });
  }
  return keys;
}

function sort(args: Value[]): Value {
  const byCol = opt(bool, false)(argAt(args, 3));
  if (isError(byCol)) return byCol;
  const matrix = byCol ? transpose(asMatrix(args[0])) : asMatrix(args[0]);
  const keys = sortKeys(matrix, args);
  if (isError(keys)) return keys;
  const sorted = sortedRows(matrix, keys);
  return byCol ? transpose(sorted) : sorted;
}

function byKey(by: Matrix, order: Value | undefined, count: number, byCol: boolean): SortKey | SheetError {
  const values = byCol ? by[0] : by.map((row) => row[0]);
  if ((byCol ? by.length : by[0].length) !== 1 || values.length !== count) return ERR.value;
  const descending = orders(order, 1);
  return isError(descending) ? descending : { values, descending: descending[0] };
}

/** SORTBY's by-arrays: columns as tall as the array, or rows as wide. */
function sortBy(args: Value[]): Value {
  const matrix = asMatrix(args[0]);
  const first = asMatrix(args[1]);
  const byCol = first.length === 1 && first[0].length > 1;
  const target = byCol ? transpose(matrix) : matrix;
  const keys: SortKey[] = [];
  for (let index = 1; index < args.length; index += 2) {
    const key = byKey(asMatrix(args[index]), args[index + 1], target.length, byCol);
    if (isError(key)) return key;
    keys.push(key);
  }
  const sorted = sortedRows(target, keys);
  return byCol ? transpose(sorted) : sorted;
}

function keyOf(value: Scalar): string {
  if (value === null) return "z";
  if (isError(value)) return `e${value.code}`;
  return typeof value === "string" ? `s${value.toLowerCase()}` : `${typeof value}${String(value)}`;
}

function unique(args: Value[]): Value {
  const options = readArgs<[boolean, boolean]>(args, 1, [opt(bool, false), opt(bool, false)]);
  if (isError(options)) return options;
  const [byCol, exactlyOnce] = options;
  const lines = byCol ? transpose(asMatrix(args[0])) : asMatrix(args[0]);
  const counts = new Map<string, { line: Scalar[]; count: number }>();
  for (const line of lines) {
    const key = line.map(keyOf).join("\u0001");
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { line, count: 1 });
  }
  const kept = Array.from(counts.values()).filter((entry) => !exactlyOnce || entry.count === 1).map((entry) => entry.line);
  if (!kept.length) return EMPTY();
  return byCol ? transpose(kept) : kept;
}

/* ------------------------------------------------------------------ generating */

function grid(rows: number, cols: number, fill: (row: number, col: number) => Scalar): Value {
  if (rows < 0 || cols < 0) return ERR.value;
  if (rows * cols > MAX_ARRAY_CELLS) return TOO_BIG();
  return nonEmpty(Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (__, col) => fill(row, col))));
}

function sequence(args: Value[]): Value {
  const values = readArgs<[number, number, number, number]>(args, 0, [int, opt(int, 1), opt(num, 1), opt(num, 1)]);
  if (isError(values)) return values;
  const [rows, cols, start, step] = values;
  return grid(rows, cols, (row, col) => start + (row * cols + col) * step);
}

function randArray(args: Value[], ctx: CallContext): Value {
  const values = readArgs<[number, number, number, number, boolean]>(args, 0, [optBlank(int, 1), optBlank(int, 1), optBlank(num, 0), optBlank(num, 1), opt(bool, false)]);
  if (isError(values)) return values;
  const [rows, cols, low, high, whole] = values;
  if (low > high || (whole && (!Number.isInteger(low) || !Number.isInteger(high)))) return ERR.value;
  const draw = () => (whole ? low + Math.floor(ctx.host.random() * (high - low + 1)) : low + ctx.host.random() * (high - low));
  return grid(rows, cols, draw);
}

/* ------------------------------------------------------------------ stacking */

function padded(line: Scalar[], width: number, pad: Scalar): Scalar[] {
  return line.length >= width ? line : [...line, ...new Array<Scalar>(width - line.length).fill(pad)];
}

function vstack(args: Value[]): Value {
  const parts = args.map(asMatrix);
  const width = Math.max(...parts.map((part) => part[0].length));
  return parts.flatMap((part) => part.map((line) => padded(line, width, ERR.na)));
}

function hstack(args: Value[]): Value {
  const parts = args.map((arg) => transpose(asMatrix(arg)));
  return transpose(vstack(parts) as Matrix);
}

/** TOCOL and TOROW's ignore: 1 skips blanks, 2 skips errors, 3 skips both. */
function kept(ignore: number): (item: Scalar) => boolean {
  const skipBlanks = (ignore & 1) !== 0;
  const skipErrors = (ignore & 2) !== 0;
  return (item) => !(skipBlanks && item === null) && !(skipErrors && isError(item));
}

function flattenArgs(args: Value[], toRow: boolean): Value {
  const options = readArgs<[number, boolean]>(args, 1, [opt(int, 0), opt(bool, false)]);
  if (isError(options)) return options;
  const [ignore, byColumn] = options;
  if (ignore < 0 || ignore > 3) return ERR.value;
  const source = byColumn ? transpose(asMatrix(args[0])) : asMatrix(args[0]);
  const items = source.flat().filter(kept(ignore));
  if (!items.length) return EMPTY();
  return toRow ? [items] : items.map((item) => [item]);
}

/* ------------------------------------------------------------------ slicing */

type Span = [number, number];

function takeSpan(length: number, count: number | null): Span | null {
  if (count === null) return [0, length];
  if (count === 0) return null;
  return count > 0 ? [0, Math.min(count, length)] : [Math.max(length + count, 0), length];
}

/** Dropping everything leaves an empty slice, which nonEmpty turns into #CALC!. */
function dropSpan(length: number, count: number | null): Span | null {
  if (count === null) return [0, length];
  return count >= 0 ? [Math.min(count, length), length] : [0, Math.max(length + count, 0)];
}

const countArg: Arg<number | null> = (value) => (value === undefined || value === null ? null : int(value));

function slicer(spanOf: (length: number, count: number | null) => Span | null) {
  return (args: Value[]): Value => {
    const counts = readArgs<[number | null, number | null]>(args, 1, [countArg, countArg]);
    if (isError(counts)) return counts;
    const matrix = asMatrix(args[0]);
    const rows = spanOf(matrix.length, counts[0]);
    const cols = spanOf(matrix[0].length, counts[1]);
    if (!rows || !cols) return EMPTY();
    return nonEmpty(matrix.slice(rows[0], rows[1]).map((line) => line.slice(cols[0], cols[1])));
  };
}

/** CHOOSEROWS and CHOOSECOLS positions: 1-based, negatives count from the end. */
function positions(args: Value[], length: number): number[] | SheetError {
  const out: number[] = [];
  for (const item of flatten(args.slice(1))) {
    const number = toNumber(item);
    if (isError(number)) return number;
    const at = Math.trunc(number);
    if (at === 0 || Math.abs(at) > length) return ERR.value;
    out.push(at > 0 ? at - 1 : length + at);
  }
  return out;
}

function chooser(columns: boolean) {
  return (args: Value[]): Value => {
    const matrix = columns ? transpose(asMatrix(args[0])) : asMatrix(args[0]);
    const picks = positions(args, matrix.length);
    if (isError(picks)) return picks;
    const chosen = picks.map((index) => matrix[index]);
    return columns ? transpose(chosen) : chosen;
  };
}

function expand(args: Value[]): Value {
  const matrix = asMatrix(args[0]);
  const sizes = readArgs<[number | null, number | null]>(args, 1, [countArg, countArg]);
  if (isError(sizes)) return sizes;
  const rows = sizes[0] ?? matrix.length;
  const cols = sizes[1] ?? matrix[0].length;
  if (rows < matrix.length || cols < matrix[0].length) return ERR.value;
  const pad = argAt(args, 3) ?? ERR.na;
  return grid(rows, cols, (row, col) => (row < matrix.length && col < matrix[0].length ? matrix[row][col] : pad));
}

function wrap(byRows: boolean) {
  return (args: Value[]): Value => {
    const matrix = asMatrix(args[0]);
    if (matrix.length !== 1 && matrix[0].length !== 1) return ERR.value;
    const count = int(argAt(args, 1));
    if (isError(count)) return count;
    if (count < 1) return ERR.num;
    const items = matrix.flat();
    const pad = argAt(args, 2) ?? ERR.na;
    const lines: Matrix = [];
    for (let start = 0; start < items.length; start += count) lines.push(padded(items.slice(start, start + count), count, pad));
    return byRows ? lines : transpose(lines);
  };
}

const sliceOf = (fn: (matrix: Matrix) => Value) => (args: Value[]) => fn(asMatrix(args[0]));

export const ARRAY_FUNCTIONS: Record<string, FunctionSpec> = {
  FILTER: arr("array, include, [if_empty]", "Returns the rows or columns of an array that meet a condition.", { array: true, fn: filter }),
  SORT: arr("array, [sort_index], [sort_order], [by_col]", "Sorts an array by one or more of its columns or rows.", { array: true, fn: sort }),
  SORTBY: arr("array, by_array1, [sort_order1], [by_array2, sort_order2], ...", "Sorts an array by other arrays.", { array: true, fn: sortBy }),
  UNIQUE: arr("array, [by_col], [exactly_once]", "Returns the distinct rows or columns of an array.", { array: true, fn: unique }),
  SEQUENCE: arr("rows, [columns], [start], [step]", "Returns a grid of evenly spaced numbers.", { array: true, fn: sequence }),
  RANDARRAY: arr("[rows], [columns], [min], [max], [whole_number]", "Returns an array of random numbers.", { array: true, volatile: true, fn: randArray }),
  TRANSPOSE: arr("array", "Swaps the rows and columns of an array.", { array: true, fn: sliceOf(transpose) }),
  VSTACK: arr("array1, [array2], ...", "Stacks arrays on top of each other.", { array: true, fn: vstack }),
  HSTACK: arr("array1, [array2], ...", "Stacks arrays side by side.", { array: true, fn: hstack }),
  TOCOL: arr("array, [ignore], [scan_by_column]", "Returns an array as one column.", { array: true, fn: (args) => flattenArgs(args, false) }),
  TOROW: arr("array, [ignore], [scan_by_column]", "Returns an array as one row.", { array: true, fn: (args) => flattenArgs(args, true) }),
  TAKE: arr("array, rows, [columns]", "Returns rows or columns from the start or end of an array.", { array: true, fn: slicer(takeSpan) }),
  DROP: arr("array, rows, [columns]", "Removes rows or columns from the start or end of an array.", { array: true, fn: slicer(dropSpan) }),
  CHOOSECOLS: arr("array, col_num1, [col_num2], ...", "Returns the chosen columns of an array.", { array: true, fn: chooser(true) }),
  CHOOSEROWS: arr("array, row_num1, [row_num2], ...", "Returns the chosen rows of an array.", { array: true, fn: chooser(false) }),
  EXPAND: arr("array, rows, [columns], [pad_with]", "Pads an array to a larger size.", { array: true, fn: expand }),
  WRAPROWS: arr("vector, wrap_count, [pad_with]", "Folds a row or column into rows of a given length.", { array: true, fn: wrap(true) }),
  WRAPCOLS: arr("vector, wrap_count, [pad_with]", "Folds a row or column into columns of a given length.", { array: true, fn: wrap(false) }),
};
