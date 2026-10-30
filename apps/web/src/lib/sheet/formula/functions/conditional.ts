/** The engine behind SUMIF(S), COUNTIF(S), AVERAGEIF(S), MAXIFS, and MINIFS.
 *
 * An Area pairs the values a reference produced (trimmed to the used rows)
 * with the shape the formula declared, so =COUNTIF(A:A,"") still counts the
 * blank cells below the data, and SUMIF's sum_range can be resized from its
 * top-left cell to the criteria range's shape the way Excel does. */

import type { CallContext, RangeRef } from "../types";
import { ERR, type Matrix, type Scalar, type SheetError, type Value, asMatrix, isError } from "../values";
import { makeCriterion, type Criterion } from "./criteria";
import { largest, liftScalar, smallest, total } from "./helpers";

export type Area = { values: Matrix; rows: number; cols: number };

function isSingleCell(ref: RangeRef): boolean {
  return ref.r1 === ref.r2 && ref.c1 === ref.c2;
}

/** The argument as an Area; a failed multi-cell reference stays an error. */
export function areaOf(value: Value, ref: RangeRef | undefined): Area | SheetError {
  if (isError(value) && !(ref && isSingleCell(ref))) return value;
  const values = asMatrix(value);
  if (!ref) return { values, rows: values.length, cols: values[0].length };
  return { values, rows: ref.r2 - ref.r1 + 1, cols: ref.c2 - ref.c1 + 1 };
}

export function cellAt(area: Area, row: number, col: number): Scalar {
  return area.values[row]?.[col] ?? null;
}

/** SUMIF/AVERAGEIF's result range: same top-left, the criteria's shape.
 * Rows past the sheet's edge read as blank, since the host trims them. */
export function resizedArea(value: Value, ref: RangeRef | undefined, shape: Area, ctx: CallContext): Area | SheetError {
  const area = areaOf(value, ref);
  if (isError(area) || !ref || (area.rows === shape.rows && area.cols === shape.cols)) return area;
  const resized: RangeRef = { sheet: ref.sheet, r1: ref.r1, c1: ref.c1, r2: ref.r1 + shape.rows - 1, c2: ref.c1 + shape.cols - 1 };
  return areaOf(ctx.host.range(resized), resized);
}

type Matches = { values: Scalar[]; blankTail: number };

function sameShape(areas: Area[]): boolean {
  return areas.every((area) => area.rows === areas[0].rows && area.cols === areas[0].cols);
}

/** Values of `target` where every test holds, plus how many cells beyond the
 * used area (blank in every range) also satisfy every test. */
function collectMatches(areas: Area[], tests: Criterion[], target: Area | null): Matches {
  const all = target ? [...areas, target] : areas;
  const rows = Math.max(...all.map((area) => area.values.length));
  const cols = Math.max(...all.map((area) => area.values[0].length));
  const values: Scalar[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (tests.every((test, index) => test(cellAt(areas[index], row, col)))) values.push(target ? cellAt(target, row, col) : null);
    }
  }
  const tail = areas[0].rows * areas[0].cols - rows * cols;
  return { values, blankTail: tests.every((test) => test(null)) ? tail : 0 };
}

export type Reduce = (matches: Matches) => Scalar;

/** Applies the conditions; an array of criteria gives an array of results. */
export function conditional(areas: Area[], criteria: Value[], target: Area | null, reduce: Reduce): Value {
  if (!sameShape(target ? [...areas, target] : areas)) return ERR.value;
  return liftScalar((items) => reduce(collectMatches(areas, items.map(makeCriterion), target)))(criteria);
}

/** Reads (range, criteria) pairs starting at `from`. */
export function criteriaPairs(args: Value[], ctx: CallContext, from: number): { areas: Area[]; criteria: Value[] } | SheetError {
  if (args.slice(from).length % 2 !== 0) return ERR.value;
  const areas: Area[] = [];
  const criteria: Value[] = [];
  for (let index = from; index < args.length; index += 2) {
    const area = areaOf(args[index], ctx.refs[index]);
    if (isError(area)) return area;
    areas.push(area);
    criteria.push(args[index + 1]);
  }
  return { areas, criteria };
}

/* ------------------------------------------------------------------ reducers */

function numbersOf(values: Scalar[]): number[] | SheetError {
  const out: number[] = [];
  for (const value of values) {
    if (isError(value)) return value;
    if (typeof value === "number") out.push(value);
  }
  return out;
}

function numericReduce(fn: (numbers: number[]) => Scalar): Reduce {
  return ({ values }) => {
    const numbers = numbersOf(values);
    return isError(numbers) ? numbers : fn(numbers);
  };
}

export const sumOf: Reduce = numericReduce(total);
export const countOf: Reduce = ({ values, blankTail }) => values.length + blankTail;
export const averageOf: Reduce = numericReduce((numbers) => (numbers.length ? total(numbers) / numbers.length : ERR.div0));
export const maxOf: Reduce = numericReduce((numbers) => (numbers.length ? largest(numbers) : 0));
export const minOf: Reduce = numericReduce((numbers) => (numbers.length ? smallest(numbers) : 0));

type SpecFn = (args: Value[], ctx: CallContext) => Value;

/** SUMIF, COUNTIF, AVERAGEIF: (range, criteria, [result_range]). */
export function singleCondition(reduce: Reduce, counts = false): SpecFn {
  return (args, ctx) => {
    const area = areaOf(args[0], ctx.refs[0]);
    if (isError(area)) return area;
    const target = counts ? null : args.length > 2 ? resizedArea(args[2], ctx.refs[2], area, ctx) : area;
    if (isError(target)) return target;
    return conditional([area], [args[1]], target, reduce);
  };
}

/** SUMIFS, AVERAGEIFS, MAXIFS, MINIFS: (result_range, range1, criteria1, ...);
 * COUNTIFS has no result range. */
export function multiCondition(reduce: Reduce, counts = false): SpecFn {
  return (args, ctx) => {
    const target = counts ? null : areaOf(args[0], ctx.refs[0]);
    if (isError(target)) return target;
    const pairs = criteriaPairs(args, ctx, counts ? 0 : 1);
    if (isError(pairs)) return pairs;
    return conditional(pairs.areas, pairs.criteria, target, reduce);
  };
}
