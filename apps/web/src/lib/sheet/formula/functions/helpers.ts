/** Argument helpers shared by the function library. They encode Excel's
 * rules for which values an aggregate counts: numbers inside references and
 * arrays count, while text and TRUE/FALSE there are skipped; typed arguments
 * (=SUM(1,"2",TRUE)) are coerced, and errors always propagate. */

import type { CallContext, FunctionCategory, FunctionSpec } from "../types";
import { ERR, type Matrix, type Scalar, type SheetError, type Value, asMatrix, isError, isMatrix, toNumber, toScalar } from "../values";

/** Numbers for SUM, AVERAGE, MIN, MAX, PRODUCT, STDEV and friends. */
export function collectNumbers(args: Value[], ctx: CallContext): number[] | SheetError {
  const out: number[] = [];
  for (const [index, arg] of args.entries()) {
    const failure = isMatrix(arg) || ctx.refs[index] !== undefined ? referenceNumbers(arg, out) : typedNumber(arg, out);
    if (failure) return failure;
  }
  return out;
}

function referenceNumbers(arg: Value, out: number[]): SheetError | null {
  for (const item of asMatrix(arg).flat()) {
    if (isError(item)) return item;
    if (typeof item === "number") out.push(item);
  }
  return null;
}

/** One scalar argument as a number (implicit intersection for arrays). */
export function numberArg(value: Value): number | SheetError {
  return toNumber(toScalar(value));
}

/** An optional argument's value (top-left of an array); undefined when the
 * formula left it out. */
export function argAt(args: Value[], index: number): Scalar | undefined {
  return index < args.length ? toScalar(args[index]) : undefined;
}

/** Functions made by liftScalar, so recalc can tell that =LEN(A2:A9) spills. */
const LIFTED = new WeakSet<object>();

/** Whether a function spec's implementation lifts over array arguments. */
export function liftsOverArrays(fn: unknown): boolean {
  return typeof fn === "function" && LIFTED.has(fn);
}

/** Lifts a scalar function over array arguments the way Excel's dynamic
 * arrays do: =LEFT(A2:A9, 3) returns eight values. Array arguments broadcast
 * (1xN against Mx1 gives MxN); a missing element is #N/A. */
export function liftScalar(fn: (args: Scalar[]) => Scalar): (args: Value[]) => Value {
  const lifted = (args: Value[]): Value => {
    if (!args.some(isMatrix)) return fn(args as Scalar[]);
    const matrices = args.filter(isMatrix);
    const rows = Math.max(...matrices.map((m) => m.length));
    const cols = Math.max(...matrices.map((m) => m[0].length));
    const out: Matrix = [];
    for (let row = 0; row < rows; row += 1) {
      const line: Scalar[] = [];
      for (let col = 0; col < cols; col += 1) line.push(fn(args.map((arg) => elementAt(arg, row, col))));
      out.push(line);
    }
    return out;
  };
  LIFTED.add(lifted);
  return lifted;
}

/** A value's item at (row, col) when it is broadcast to a larger array: a
 * scalar, a single row, or a single column repeats; past the end of a
 * larger array the item is #N/A. IF, CHOOSE, and liftScalar all use it. */
export function elementAt(value: Value, row: number, col: number): Scalar {
  if (!isMatrix(value)) return value;
  const r = value.length === 1 ? 0 : row;
  const c = value[0].length === 1 ? 0 : col;
  return r < value.length && c < value[0].length ? value[r][c] : ERR.na;
}

/* ------------------------------------------------------------------ specs */

/** Argument counts read from an Excel signature: bracketed names are
 * optional and a trailing "..." allows up to Excel's 255 arguments. */
export function arity(signature: string): { min: number; max: number } {
  const parts = signature.split(",").map((part) => part.trim()).filter(Boolean);
  const variadic = parts.at(-1) === "...";
  const named = variadic ? parts.slice(0, -1) : parts;
  let depth = 0;
  let min = 0;
  for (const part of named) {
    if (depth === 0 && !part.startsWith("[")) min += 1;
    depth += part.split("[").length - part.split("]").length;
  }
  return { min, max: variadic ? 255 : named.length };
}

type SpecBody = Pick<FunctionSpec, "fn" | "lazy" | "volatile" | "array"> & Partial<Pick<FunctionSpec, "min" | "max">>;

/** A spec builder for one category; the signature sets the argument counts
 * unless the body overrides them. */
export function define(category: FunctionCategory) {
  return (signature: string, description: string, body: SpecBody): FunctionSpec => ({
    ...arity(signature),
    ...body,
    signature,
    description,
    category,
  });
}

/** A number result, with Excel's #NUM! for overflow and NaN and no -0. */
export function finite(value: number): number | SheetError {
  if (!Number.isFinite(value)) return ERR.num;
  return value === 0 ? 0 : value;
}

/** An aggregate over collectNumbers: =STDEV(A1:A9, 4). */
export function numbersFn(fn: (numbers: number[]) => number | SheetError): NonNullable<FunctionSpec["fn"]> {
  return (args, ctx) => {
    const numbers = collectNumbers(args, ctx);
    if (isError(numbers)) return numbers;
    const result = fn(numbers);
    return isError(result) ? result : finite(result);
  };
}

/** Numbers for AVERAGEA, MAXA, and MINA: text in references counts as 0 and
 * TRUE/FALSE as 1/0; empty cells are skipped. */
export function collectNumbersA(args: Value[], ctx: CallContext): number[] | SheetError {
  const out: number[] = [];
  for (const [index, arg] of args.entries()) {
    const failure = isMatrix(arg) || ctx.refs[index] !== undefined ? referenceNumbersA(arg, out) : typedNumber(arg, out);
    if (failure) return failure;
  }
  return out;
}

function typedNumber(arg: Scalar, out: number[]): SheetError | null {
  const number = toNumber(arg);
  if (isError(number)) return number;
  out.push(number);
  return null;
}

function referenceNumbersA(arg: Value, out: number[]): SheetError | null {
  for (const item of asMatrix(arg).flat()) {
    if (isError(item)) return item;
    if (item !== null) out.push(typeof item === "number" ? item : item === true ? 1 : 0);
  }
  return null;
}

/* ------------------------------------------------------------------ numbers */

export function total(numbers: number[]): number {
  let sum = 0;
  for (const item of numbers) sum += item;
  return sum;
}

/** Math.max without spreading, so a 200,000-cell range cannot overflow the stack. */
export function largest(numbers: number[]): number {
  return numbers.reduce((best, item) => Math.max(best, item), -Infinity);
}

export function smallest(numbers: number[]): number {
  return numbers.reduce((best, item) => Math.min(best, item), Infinity);
}
