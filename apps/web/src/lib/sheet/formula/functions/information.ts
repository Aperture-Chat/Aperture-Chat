import type { FormulaNode } from "../parser";
import type { CallContext, FunctionSpec } from "../types";
import { ERR, type ErrorCode, type Scalar, type Value, isError, isMatrix, toNumber } from "../values";
import { define, liftScalar } from "./helpers";

const info = define("Information");

const ERROR_NUMBERS: Partial<Record<ErrorCode, number>> = {
  "#NULL!": 1,
  "#DIV/0!": 2,
  "#VALUE!": 3,
  "#REF!": 4,
  "#NAME?": 5,
  "#NUM!": 6,
  "#N/A": 7,
  "#SPILL!": 9,
  "#CALC!": 14,
};

/** A test on one value that lifts over arrays and never propagates errors. */
function test(predicate: (value: Scalar) => Scalar) {
  return { fn: liftScalar(([value]) => predicate(value)) };
}

function parity(remainder: 0 | 1) {
  return test((value) => {
    if (typeof value === "boolean") return ERR.value;
    const number = toNumber(value);
    return isError(number) ? number : Math.abs(Math.trunc(number)) % 2 === remainder;
  });
}

function typeCode(value: Value): number {
  if (isMatrix(value)) return 64;
  if (typeof value === "string") return 2;
  if (typeof value === "boolean") return 4;
  return isError(value) ? 16 : 1;
}

function isRef(args: FormulaNode[], ctx: CallContext): Value {
  const ref = ctx.reference(args[0]);
  return ref !== null && !isError(ref);
}

const passError = (value: Scalar, otherwise: Scalar): Scalar => (isError(value) ? value : otherwise);

export const INFORMATION_FUNCTIONS: Record<string, FunctionSpec> = {
  ISBLANK: info("value", "Returns TRUE when a cell is empty.", test((value) => value === null)),
  ISNUMBER: info("value", "Returns TRUE when a value is a number.", test((value) => typeof value === "number")),
  ISTEXT: info("value", "Returns TRUE when a value is text.", test((value) => typeof value === "string")),
  ISNONTEXT: info("value", "Returns TRUE when a value is not text.", test((value) => typeof value !== "string")),
  ISLOGICAL: info("value", "Returns TRUE when a value is TRUE or FALSE.", test((value) => typeof value === "boolean")),
  ISERROR: info("value", "Returns TRUE when a value is any error.", test((value) => isError(value))),
  ISERR: info("value", "Returns TRUE when a value is an error other than #N/A.", test((value) => isError(value) && value.code !== "#N/A")),
  ISNA: info("value", "Returns TRUE when a value is #N/A.", test((value) => isError(value) && value.code === "#N/A")),
  ISEVEN: info("number", "Returns TRUE when a number is even.", parity(0)),
  ISODD: info("number", "Returns TRUE when a number is odd.", parity(1)),
  ISREF: info("value", "Returns TRUE when the argument is a cell reference.", { lazy: isRef }),
  NA: info("", "Returns the #N/A error, meaning no value is available.", { fn: () => ERR.na }),
  "ERROR.TYPE": info("error_val", "Returns the number of an error type, or #N/A for a value that is not an error.", test((value) => (isError(value) ? (ERROR_NUMBERS[value.code] ?? ERR.na) : ERR.na))),
  TYPE: info("value", "Returns the type of a value: 1 number, 2 text, 4 logical, 16 error, 64 array.", { fn: (args) => typeCode(args[0]) }),
  N: info("value", "Converts a value to a number: text becomes 0 and TRUE becomes 1.", test((value) => passError(value, typeof value === "number" ? value : value === true ? 1 : 0))),
  T: info("value", "Returns text unchanged and an empty string for anything else.", test((value) => passError(value, typeof value === "string" ? value : ""))),
};
