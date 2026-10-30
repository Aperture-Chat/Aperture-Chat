import { MAX_SHEET_COLS, MAX_SHEET_ROWS, columnLabel, parseRangeRef, quoteSheetName, splitSheetQualifiedRef } from "../../address";
import type { FormulaNode } from "../parser";
import type { CallContext, FunctionSpec, RangeRef, RefResult } from "../types";
import { ERR, type Matrix, type Scalar, type SheetError, type Value, asMatrix, isError, isMatrix, sheetError, toBoolean, toNumber, toScalar, toText } from "../values";
import { argAt, define, elementAt, liftScalar, numberArg } from "./helpers";
import { bool, int, num, opt, optBlank, scalar, text } from "./scalar";
import { approximateIndex, exactMatcher, matchIndex, xIndex } from "./search";

const look = define("Lookup");

type Shape = { rows: number; cols: number };

/** The declared shape of an argument: its reference's, else its value's. */
function shapeOf(value: Value, ref: RangeRef | null | undefined): Shape {
  if (ref) return { rows: ref.r2 - ref.r1 + 1, cols: ref.c2 - ref.c1 + 1 };
  const matrix = asMatrix(value);
  return { rows: matrix.length, cols: matrix[0].length };
}

function wholeNumber(value: Value): number | SheetError {
  const number = numberArg(value);
  return isError(number) ? number : Math.trunc(number);
}

/** The lookup value lifts: =VLOOKUP(A2:A9, ...) gives one result per item. */
function eachLookup(value: Value, find: (lookup: Scalar) => Value): Value {
  if (!isMatrix(value)) return isError(value) ? value : find(value);
  return value.map((row) => row.map((item) => (isError(item) ? item : toScalar(find(item)))));
}

/** A one-row or one-column array as a list; null for a two-way table. */
function vectorOf(value: Value): Scalar[] | null {
  const matrix = asMatrix(value);
  if (matrix.length === 1) return matrix[0];
  return matrix[0].length === 1 ? matrix.map((row) => row[0]) : null;
}

/* ------------------------------------------------------------------ V/H/LOOKUP */

/** VLOOKUP's col_index_num or HLOOKUP's row_index_num, checked against the
 * table's declared size (a whole-column table arrives trimmed). */
function lineIndex(args: Value[], ctx: CallContext, horizontal: boolean): number | SheetError {
  const index = wholeNumber(args[2]);
  if (isError(index)) return index;
  const shape = shapeOf(args[1], ctx.refs[1]);
  if (index < 1) return ERR.value;
  return index > (horizontal ? shape.rows : shape.cols) ? ERR.ref : index;
}

function cellOf(matrix: Matrix, row: number, col: number): Scalar {
  return matrix[row]?.[col] ?? null;
}

function tableLookup(horizontal: boolean) {
  return (args: Value[], ctx: CallContext): Value => {
    const index = lineIndex(args, ctx, horizontal);
    if (isError(index)) return index;
    const approximate = opt(bool, true)(argAt(args, 3));
    if (isError(approximate)) return approximate;
    const table = asMatrix(args[1]);
    const keys = horizontal ? table[0] : table.map((row) => row[0]);
    const find = approximate ? (item: Scalar) => approximateIndex(keys, item, false) : (item: Scalar) => keys.findIndex(exactMatcher(item, true));
    return eachLookup(args[0], (item) => {
      const at = find(item);
      if (at < 0) return ERR.na;
      return horizontal ? cellOf(table, index - 1, at) : cellOf(table, at, index - 1);
    });
  };
}

function lookup(args: Value[]): Value {
  const source = asMatrix(args[1]);
  const wide = source[0].length > source.length;
  const keys = args.length > 2 ? source.flat() : wide ? source[0] : source.map((row) => row[0]);
  const found = args.length > 2 ? asMatrix(args[2]).flat() : wide ? source[source.length - 1] : source.map((row) => row[row.length - 1]);
  return eachLookup(args[0], (item) => {
    const at = approximateIndex(keys, item, false);
    return at < 0 ? ERR.na : (found[at] ?? ERR.na);
  });
}

function match(args: Value[]): Value {
  const values = vectorOf(args[1]);
  if (!values) return ERR.na;
  const type = opt(num, 1)(argAt(args, 2));
  if (isError(type)) return type;
  return eachLookup(args[0], (item) => {
    const at = matchIndex(values, item, Math.sign(type) as -1 | 0 | 1);
    return at < 0 ? ERR.na : at + 1;
  });
}

/* ------------------------------------------------------------------ XLOOKUP */

function xModes(args: Value[], from: number): { matchMode: number; searchMode: number } | SheetError {
  const matchMode = optBlank(int, 0)(argAt(args, from));
  if (isError(matchMode)) return matchMode;
  const searchMode = optBlank(int, 1)(argAt(args, from + 1));
  return isError(searchMode) ? searchMode : { matchMode, searchMode };
}

function xmatch(args: Value[]): Value {
  const values = vectorOf(args[1]);
  if (!values) return ERR.value;
  const modes = xModes(args, 2);
  if (isError(modes)) return modes;
  return eachLookup(args[0], (item) => {
    const at = xIndex(values, item, modes.matchMode, modes.searchMode);
    return isError(at) ? at : at < 0 ? ERR.na : at + 1;
  });
}

function single(matrix: Matrix): Value {
  return matrix.length === 1 && matrix[0].length === 1 ? matrix[0][0] : matrix;
}

type Layout = { keys: Scalar[]; resultAt: (at: number) => Value };

/** The lookup and return arrays line up along rows (a lookup column) or
 * along columns (a lookup row); the result is that row or column. */
function isHorizontal(lookup: Shape, result: Shape): boolean | SheetError {
  const horizontal = lookup.rows === 1 && lookup.cols > 1;
  if (!horizontal && lookup.cols !== 1) return ERR.value;
  const aligned = horizontal ? lookup.cols === result.cols : lookup.rows === result.rows;
  return aligned ? horizontal : ERR.value;
}

function xlookupLayout(args: Value[], ctx: CallContext): Layout | SheetError {
  const horizontal = isHorizontal(shapeOf(args[1], ctx.refs[1]), shapeOf(args[2], ctx.refs[2]));
  if (isError(horizontal)) return horizontal;
  const returns = asMatrix(args[2]);
  const blankRow = new Array<Scalar>(returns[0].length).fill(null);
  const resultAt = horizontal
    ? (at: number) => single(returns.map((row) => [row[at] ?? null]))
    : (at: number) => single([returns[at] ?? blankRow]);
  return { keys: vectorOf(args[1]) ?? [], resultAt };
}

function xlookup(args: Value[], ctx: CallContext): Value {
  const layout = xlookupLayout(args, ctx);
  if (isError(layout)) return layout;
  const modes = xModes(args, 4);
  if (isError(modes)) return modes;
  const notFound: Value = args.length > 3 && args[3] !== null ? args[3] : ERR.na;
  return eachLookup(args[0], (item) => {
    const at = xIndex(layout.keys, item, modes.matchMode, modes.searchMode);
    if (isError(at)) return at;
    return at < 0 ? notFound : layout.resultAt(at);
  });
}

/* ------------------------------------------------------------------ references */

function evaluateInt(ctx: CallContext, node: FormulaNode | undefined, fallback: number): number | SheetError {
  if (!node) return fallback;
  const value = toScalar(ctx.evaluate(node));
  return value === null && node.type === "empty" ? fallback : wholeNumber(value);
}

/** INDEX's row and column: 0 means the whole row or column; a single row
 * or column is indexed by row_num alone. */
function indexSpan(shape: Shape, row: number, col: number, hasCol: boolean): { r: number; c: number } | SheetError {
  const [r, c] = !hasCol && shape.rows === 1 ? [1, row] : !hasCol && shape.cols === 1 ? [row, 1] : [row, col];
  if (r < 0 || c < 0) return ERR.value;
  if (r > shape.rows || c > shape.cols) return ERR.ref;
  return { r, c };
}

type At = { row: number; col: number };

/** Evaluates whole-number arguments; an empty or missing one takes its default. */
function evaluateInts(ctx: CallContext, nodes: (FormulaNode | undefined)[], defaults: number[]): number[] | SheetError {
  const numbers = defaults.map((fallback, index) => evaluateInt(ctx, nodes[index], fallback));
  return numbers.find(isError) ?? (numbers as number[]);
}

function indexPosition(args: FormulaNode[], ctx: CallContext): At | SheetError {
  const numbers = evaluateInts(ctx, [args[1], args[2], args[3]], [0, 0, 1]);
  if (isError(numbers)) return numbers;
  const [row, col, area] = numbers;
  return area === 1 ? { row, col } : ERR.ref;
}

function indexValue(value: Value, at: At, hasCol: boolean): Value {
  if (isError(value)) return value;
  const span = indexSpan(shapeOf(value, null), at.row, at.col, hasCol);
  if (isError(span)) return span;
  const matrix = asMatrix(value);
  const rows = span.r ? [matrix[span.r - 1]] : matrix;
  return rows.map((line) => (span.c ? [line[span.c - 1]] : line));
}

function index(args: FormulaNode[], ctx: CallContext): Value | RefResult {
  const at = indexPosition(args, ctx);
  if (isError(at)) return at;
  const ref = ctx.reference(args[0]);
  if (!ref) return indexValue(ctx.evaluate(args[0]), at, args.length > 2);
  if (isError(ref)) return ref;
  const span = indexSpan(shapeOf(null, ref), at.row, at.col, args.length > 2);
  return isError(span) ? span : { ref: subReference(ref, span.r, span.c) };
}

function subReference(ref: RangeRef, r: number, c: number): RangeRef {
  return {
    sheet: ref.sheet,
    r1: r ? ref.r1 + r - 1 : ref.r1,
    r2: r ? ref.r1 + r - 1 : ref.r2,
    c1: c ? ref.c1 + c - 1 : ref.c1,
    c2: c ? ref.c1 + c - 1 : ref.c2,
  };
}

/** One side of an OFFSET: a negative size extends up or to the left. */
function offsetSpan(start: number, size: number, limit: number): [number, number] | null {
  if (size === 0) return null;
  const [low, high] = size > 0 ? [start, start + size - 1] : [start + size + 1, start];
  return low < 0 || high >= limit ? null : [low, high];
}

function offset(args: FormulaNode[], ctx: CallContext): Value | RefResult {
  const ref = ctx.reference(args[0]);
  if (!ref) return ERR.value;
  if (isError(ref)) return ref;
  const numbers = evaluateInts(ctx, args.slice(1, 5), [0, 0, ref.r2 - ref.r1 + 1, ref.c2 - ref.c1 + 1]);
  if (isError(numbers)) return numbers;
  const [rows, cols, height, width] = numbers;
  const vertical = offsetSpan(ref.r1 + rows, height, MAX_SHEET_ROWS);
  const across = offsetSpan(ref.c1 + cols, width, MAX_SHEET_COLS);
  if (!vertical || !across) return ERR.ref;
  return { ref: { sheet: ref.sheet, r1: vertical[0], r2: vertical[1], c1: across[0], c2: across[1] } };
}

function indirect(args: FormulaNode[], ctx: CallContext): Value | RefResult {
  const address = toText(toScalar(ctx.evaluate(args[0])));
  if (isError(address)) return address;
  const a1 = args[1] ? toBoolean(toScalar(ctx.evaluate(args[1]))) : true;
  if (isError(a1)) return a1;
  if (!a1) return sheetError("#REF!", "INDIRECT reads A1-style text only, not R1C1.");
  const { sheet, ref } = splitSheetQualifiedRef(address);
  const range = parseRangeRef(ref);
  if (range) return { ref: { sheet, ...range } };
  const named = sheet === null ? ctx.host.resolveName(address.trim()) : null;
  return named ? { ref: named } : ERR.ref;
}

function choose(args: FormulaNode[], ctx: CallContext): Value {
  const picked = ctx.evaluate(args[0]);
  const values = new Map<number, Value>();
  const option = (which: Scalar): Value => {
    const number = toNumber(which);
    if (isError(number)) return number;
    const at = Math.trunc(number);
    if (at < 1 || at >= args.length) return ERR.value;
    if (!values.has(at)) values.set(at, ctx.evaluate(args[at]));
    return values.get(at)!;
  };
  if (!isMatrix(picked)) return option(picked);
  return picked.map((row, r) => row.map((item, c) => elementAt(option(item), r, c)));
}

/** ROW and COLUMN: the current cell, one number, or a spilled list. */
function position(vertical: boolean) {
  return (args: FormulaNode[], ctx: CallContext): Value => {
    if (!args.length) return (vertical ? ctx.host.current.row : ctx.host.current.col) + 1;
    const ref = ctx.reference(args[0]);
    if (!ref) return ERR.value;
    if (isError(ref)) return ref;
    const [first, last] = vertical ? [ref.r1, ref.r2] : [ref.c1, ref.c2];
    const numbers = Array.from({ length: last - first + 1 }, (_, offsetBy) => first + offsetBy + 1);
    if (numbers.length === 1) return numbers[0];
    return vertical ? numbers.map((item) => [item]) : [numbers];
  };
}

function size(vertical: boolean) {
  return (args: FormulaNode[], ctx: CallContext): Value => {
    const ref = ctx.reference(args[0]);
    if (ref && isError(ref)) return ref;
    const value = ref ? null : ctx.evaluate(args[0]);
    if (isError(value)) return value;
    const shape = shapeOf(value, ref);
    return vertical ? shape.rows : shape.cols;
  };
}

/** ADDRESS's abs_num: which parts of the address are absolute. */
const ABSOLUTE: Record<number, { row: boolean; col: boolean }> = {
  1: { row: true, col: true },
  2: { row: true, col: false },
  3: { row: false, col: true },
  4: { row: false, col: false },
};

// ADDRESS describes Excel's grid, which is larger than the Drafts sheet.
const EXCEL_ROWS = 1_048_576;
const EXCEL_COLS = 16_384;

function a1Address(row: number, col: number, mode: { row: boolean; col: boolean }): string {
  return `${mode.col ? "$" : ""}${columnLabel(col - 1)}${mode.row ? "$" : ""}${row}`;
}

function r1c1Address(row: number, col: number, mode: { row: boolean; col: boolean }): string {
  const part = (absolute: boolean, n: number) => (absolute ? `${n}` : `[${n}]`);
  return `R${part(mode.row, row)}C${part(mode.col, col)}`;
}

function address(row: number, col: number, absolute: number, a1: boolean, sheet: string): string | SheetError {
  const mode = ABSOLUTE[absolute];
  if (!mode || row < 1 || col < 1 || row > EXCEL_ROWS || col > EXCEL_COLS) return ERR.value;
  const cell = a1 ? a1Address(row, col, mode) : r1c1Address(row, col, mode);
  return sheet ? `${quoteSheetName(sheet)}!${cell}` : cell;
}

function hyperlink([link, name]: Scalar[]): Scalar {
  if (isError(link)) return link;
  return name === undefined ? link : name;
}

export const LOOKUP_FUNCTIONS: Record<string, FunctionSpec> = {
  VLOOKUP: look("lookup_value, table_array, col_index_num, [range_lookup]", "Looks down the first column of a table and returns a value from another column.", { fn: tableLookup(false) }),
  HLOOKUP: look("lookup_value, table_array, row_index_num, [range_lookup]", "Looks across the first row of a table and returns a value from another row.", { fn: tableLookup(true) }),
  XLOOKUP: look("lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode]", "Finds a value in one array and returns the matching item, row, or column of another.", { array: true, fn: xlookup }),
  LOOKUP: look("lookup_value, lookup_vector, [result_vector]", "Finds a value in a sorted vector and returns the matching item.", { fn: lookup }),
  MATCH: look("lookup_value, lookup_array, [match_type]", "Returns the position of a value in a list.", { fn: match }),
  XMATCH: look("lookup_value, lookup_array, [match_mode], [search_mode]", "Returns the position of a value in a list, with more match options.", { fn: xmatch }),
  INDEX: look("array, row_num, [column_num], [area_num]", "Returns the value or reference at a row and column; 0 picks the whole row or column.", { lazy: index }),
  OFFSET: look("reference, rows, cols, [height], [width]", "Returns a reference moved and resized from a starting reference.", { volatile: true, array: true, lazy: offset }),
  INDIRECT: look("ref_text, [a1]", "Returns the reference named by A1-style text.", { volatile: true, array: true, lazy: indirect }),
  CHOOSE: look("index_num, value1, [value2], ...", "Returns the value at a position in a list of arguments.", { lazy: choose }),
  ROW: look("[reference]", "Returns the row number of a reference, or of this cell.", { array: true, lazy: position(true) }),
  COLUMN: look("[reference]", "Returns the column number of a reference, or of this cell.", { array: true, lazy: position(false) }),
  ROWS: look("array", "Returns the number of rows in a reference or array.", { lazy: size(true) }),
  COLUMNS: look("array", "Returns the number of columns in a reference or array.", { lazy: size(false) }),
  ADDRESS: look("row_num, column_num, [abs_num], [a1], [sheet_text]", "Returns a cell address as text.", { fn: scalar([int, int, opt(int, 1), opt(bool, true), opt(text, "")], address) }),
  HYPERLINK: look("link_location, [friendly_name]", "Returns a link's friendly name, or the link itself.", { fn: (args) => liftScalar(hyperlink)(args) }),
};
