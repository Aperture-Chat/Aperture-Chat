/** Typed scalar functions. Each argument is converted with Excel's coercion
 * rules (errors propagate left to right), numeric results that overflow
 * become #NUM!, and the whole function lifts over arrays, so
 * =LEFT(A2:A9, 3) and =ROUND(B2:B9*1.1, 2) spill. */

import { type Scalar, type SheetError, type Value, isError, toBoolean, toNumber, toText } from "../values";
import { finite, liftScalar } from "./helpers";

/** Converts one argument; `undefined` means the argument was left out. */
export type Arg<T> = (value: Scalar | undefined) => T | SheetError;

export const num: Arg<number> = (value) => toNumber(value ?? null);
export const text: Arg<string> = (value) => toText(value ?? null);
export const bool: Arg<boolean> = (value) => toBoolean(value ?? null);
/** A whole number, truncated toward zero the way Excel reads counts. */
export const int: Arg<number> = (value) => {
  const number = toNumber(value ?? null);
  return isError(number) ? number : Math.trunc(number);
};

/** An optional argument with the value Excel uses when it is left out. */
export function opt<T>(arg: Arg<T>, fallback: T): Arg<T> {
  return (value) => (value === undefined ? fallback : arg(value));
}

/** Like opt, but an empty argument (=TEXTBEFORE(A1,"-",,1)) or an empty cell
 * also takes the fallback, where 0 would be invalid. */
export function optBlank<T>(arg: Arg<T>, fallback: T): Arg<T> {
  return (value) => (value === undefined || value === null ? fallback : arg(value));
}

function convertAll(kinds: readonly Arg<unknown>[], values: Scalar[]): unknown[] | SheetError {
  const out: unknown[] = [];
  for (const [index, kind] of kinds.entries()) {
    const converted = kind(values[index]);
    if (isError(converted)) return converted;
    out.push(converted);
  }
  return out;
}

export function scalar<T extends unknown[]>(
  kinds: { [K in keyof T]: Arg<T[K]> },
  fn: (...args: T) => Scalar,
): (args: Value[]) => Value {
  return liftScalar((values) => {
    const converted = convertAll(kinds as readonly Arg<unknown>[], values);
    if (isError(converted)) return converted;
    const result = fn(...(converted as T));
    return typeof result === "number" ? finite(result) : result;
  });
}
