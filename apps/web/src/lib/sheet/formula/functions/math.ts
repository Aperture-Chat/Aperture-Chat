import type { CallContext, FunctionSpec } from "../types";
import { ERR, type Matrix, type Scalar, type SheetError, type Value, asMatrix, isError, matrixSize } from "../values";
import { multiCondition, singleCondition, sumOf } from "./conditional";
import { define, finite, numbersFn, total } from "./helpers";
import { int, num, opt, scalar } from "./scalar";
import { STATISTICAL_FUNCTIONS } from "./statistical";

const math = define("Math");

/** Drops the binary noise Excel never shows (2.675 is stored as 2.67499...). */
export function clean(value: number): number {
  return Number(value.toPrecision(15));
}

/** Rounds |x| at `digits` places with `mode`, keeping the sign: ROUND,
 * ROUNDUP, ROUNDDOWN, and TRUNC all round half away from zero this way. */
export function roundTo(x: number, digits: number, mode: (value: number) => number): number {
  const places = Math.trunc(digits);
  if (places < -308) return 0;
  const shifted = Math.abs(x) * 10 ** places;
  if (!Number.isFinite(shifted)) return x;
  return Math.sign(x) * clean(mode(clean(shifted)) / 10 ** places);
}

function toMultiple(x: number, step: number, mode: (value: number) => number): number {
  return clean(mode(clean(x / step)) * step);
}

function mround(x: number, multiple: number): number | SheetError {
  if (multiple === 0) return 0;
  if (x * multiple < 0) return ERR.num;
  return clean(roundTo(x / multiple, 0, Math.round) * multiple);
}

function mod(x: number, divisor: number): number | SheetError {
  if (divisor === 0) return ERR.div0;
  return clean(x - divisor * Math.floor(x / divisor));
}

function power(base: number, exponent: number): number | SheetError {
  if (base === 0 && exponent === 0) return ERR.num;
  if (base === 0 && exponent < 0) return ERR.div0;
  return base ** exponent;
}

/** LOG; a non-positive number gives NaN or -Infinity, which finite() reports as #NUM!. */
function log(x: number, base: number): number | SheetError {
  if (base === 0) return ERR.num;
  if (base === 1) return ERR.div0;
  if (base === 10) return Math.log10(x);
  if (base === 2) return Math.log2(x);
  return Math.log(x) / Math.log(base);
}

function ceiling(x: number, significance: number): number | SheetError {
  if (significance === 0) return 0;
  if (x > 0 && significance < 0) return ERR.num;
  return toMultiple(x, significance, Math.ceil);
}

function floor(x: number, significance: number): number | SheetError {
  if (significance === 0) return x === 0 ? 0 : ERR.div0;
  if (x > 0 && significance < 0) return ERR.num;
  return toMultiple(x, significance, Math.floor);
}

/** CEILING.MATH and FLOOR.MATH: `mode` flips the direction for negatives. */
function mathRounding(up: boolean) {
  return (x: number, significance: number, mode: number): number => {
    const step = Math.abs(significance);
    if (step === 0) return 0;
    const towardPositive = x >= 0 || mode === 0 ? up : !up;
    return toMultiple(x, step, towardPositive ? Math.ceil : Math.floor);
  };
}

function even(x: number): number {
  const sign = x < 0 ? -1 : 1;
  return sign * Math.ceil(Math.abs(x) / 2) * 2;
}

function odd(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const whole = Math.ceil(Math.abs(x));
  return sign * (whole % 2 === 0 ? whole + 1 : whole);
}

function fact(n: number): number | SheetError {
  if (n < 0) return ERR.num;
  let product = 1;
  for (let item = 2; item <= n; item += 1) product *= item;
  return product;
}

function permut(n: number, chosen: number): number | SheetError {
  if (n < 0 || chosen < 0 || n < chosen) return ERR.num;
  let product = 1;
  for (let index = 0; index < chosen; index += 1) product *= n - index;
  return product;
}

function combin(n: number, chosen: number): number | SheetError {
  if (n < 0 || chosen < 0 || n < chosen) return ERR.num;
  let product = 1;
  for (let index = 1; index <= chosen; index += 1) product = (product * (n - chosen + index)) / index;
  return Math.round(product);
}

function gcdPair(a: number, b: number): number {
  let [x, y] = [a, b];
  while (y) [x, y] = [y, x % y];
  return x;
}

/** GCD and LCM: whole, non-negative numbers from every argument. */
function wholeNumbers(fn: (numbers: number[]) => number) {
  return numbersFn((numbers) => {
    const whole = numbers.map(Math.trunc);
    return whole.some((item) => item < 0) ? ERR.num : fn(whole);
  });
}

const gcd = wholeNumbers((numbers) => numbers.reduce(gcdPair, 0));
const lcm = wholeNumbers((numbers) => numbers.reduce((acc, item) => (acc === 0 || item === 0 ? 0 : (acc * item) / gcdPair(acc, item)), 1));

function quotient(numerator: number, denominator: number): number | SheetError {
  return denominator === 0 ? ERR.div0 : Math.trunc(numerator / denominator);
}

function atan2(x: number, y: number): number | SheetError {
  return x === 0 && y === 0 ? ERR.div0 : Math.atan2(y, x);
}

function randBetween(ctx: CallContext) {
  return scalar([num, num], (bottom, top) => {
    const low = Math.ceil(bottom);
    const high = Math.floor(top);
    return low > high ? ERR.num : low + Math.floor(ctx.host.random() * (high - low + 1));
  });
}

/* ------------------------------------------------------------------ arrays */

function sumProduct(args: Value[]): Value {
  const matrices = args.map(asMatrix);
  const { rows, cols } = matrixSize(matrices[0]);
  if (matrices.some((m) => m.length !== rows || m[0].length !== cols)) return ERR.value;
  const lists = matrices.map((m) => m.flat());
  let sum = 0;
  for (const [index] of lists[0].entries()) {
    let product = 1;
    for (const list of lists) {
      const item = list[index];
      if (isError(item)) return item;
      product *= typeof item === "number" ? item : 0;
    }
    sum += product;
  }
  return finite(sum);
}

function numericMatrix(value: Value): number[][] | SheetError {
  const out: number[][] = [];
  for (const row of asMatrix(value)) {
    const line: number[] = [];
    for (const item of row) {
      if (isError(item)) return item;
      if (typeof item !== "number") return ERR.value;
      line.push(item);
    }
    out.push(line);
  }
  return out;
}

function mmult(args: Value[]): Value {
  const a = numericMatrix(args[0]);
  if (isError(a)) return a;
  const b = numericMatrix(args[1]);
  if (isError(b)) return b;
  if (a[0].length !== b.length) return ERR.value;
  return a.map((row) => b[0].map((_, col) => finite(row.reduce((sum, item, k) => sum + item * b[k][col], 0))) as Scalar[]) as Matrix;
}

const SUBTOTAL_NAMES = ["AVERAGE", "COUNT", "COUNTA", "MAX", "MIN", "PRODUCT", "STDEV", "STDEVP", "SUM", "VAR", "VARP"];

/** SUBTOTAL; 101-111 would also skip hidden rows, which the host does not report. */
function subtotal(args: Value[], ctx: CallContext): Value {
  const code = int(asMatrix(args[0])[0][0]);
  if (isError(code)) return code;
  const name = code >= 101 ? SUBTOTAL_NAMES[code - 101] : SUBTOTAL_NAMES[code - 1];
  const spec = name === undefined ? undefined : { ...STATISTICAL_FUNCTIONS, ...MATH_FUNCTIONS }[name];
  if (!spec?.fn) return ERR.value;
  return spec.fn(args.slice(1), { ...ctx, refs: ctx.refs.slice(1) });
}

const zero = opt(num, 0);

export const MATH_FUNCTIONS: Record<string, FunctionSpec> = {
  SUM: math("number1, [number2], ...", "Adds numbers and ranges.", { fn: numbersFn(total) }),
  SUMIF: math("range, criteria, [sum_range]", "Adds the cells that meet one condition.", { fn: singleCondition(sumOf) }),
  SUMIFS: math("sum_range, criteria_range1, criteria1, [criteria_range2, criteria2], ...", "Adds the cells that meet every condition.", { fn: multiCondition(sumOf) }),
  SUMPRODUCT: math("array1, [array2], ...", "Multiplies matching items of arrays and adds the products.", { fn: sumProduct }),
  SUMSQ: math("number1, [number2], ...", "Adds the squares of numbers.", { fn: numbersFn((numbers) => total(numbers.map((item) => item * item))) }),
  PRODUCT: math("number1, [number2], ...", "Multiplies numbers together.", { fn: numbersFn((numbers) => (numbers.length ? numbers.reduce((acc, item) => acc * item, 1) : 0)) }),
  ROUND: math("number, num_digits", "Rounds a number to a given number of digits.", { fn: scalar([num, num], (x, digits) => roundTo(x, digits, Math.round)) }),
  ROUNDUP: math("number, num_digits", "Rounds a number away from zero.", { fn: scalar([num, num], (x, digits) => roundTo(x, digits, Math.ceil)) }),
  ROUNDDOWN: math("number, num_digits", "Rounds a number toward zero.", { fn: scalar([num, num], (x, digits) => roundTo(x, digits, Math.floor)) }),
  MROUND: math("number, multiple", "Rounds a number to the nearest multiple.", { fn: scalar([num, num], mround) }),
  INT: math("number", "Rounds a number down to the nearest integer.", { fn: scalar([num], Math.floor) }),
  TRUNC: math("number, [num_digits]", "Cuts off the decimal part of a number.", { fn: scalar([num, zero], (x, digits) => roundTo(x, digits, Math.floor)) }),
  MOD: math("number, divisor", "Returns the remainder after division, with the divisor's sign.", { fn: scalar([num, num], mod) }),
  ABS: math("number", "Returns the absolute value of a number.", { fn: scalar([num], Math.abs) }),
  SIGN: math("number", "Returns 1, 0, or -1 for the sign of a number.", { fn: scalar([num], Math.sign) }),
  SQRT: math("number", "Returns the square root of a number.", { fn: scalar([num], Math.sqrt) }),
  POWER: math("number, power", "Raises a number to a power.", { fn: scalar([num, num], power) }),
  EXP: math("number", "Returns e raised to a power.", { fn: scalar([num], Math.exp) }),
  LN: math("number", "Returns the natural logarithm of a number.", { fn: scalar([num], Math.log) }),
  LOG: math("number, [base]", "Returns the logarithm of a number in a base (10 by default).", { fn: scalar([num, opt(num, 10)], log) }),
  LOG10: math("number", "Returns the base-10 logarithm of a number.", { fn: scalar([num], (x) => log(x, 10)) }),
  PI: math("", "Returns the number pi.", { fn: () => Math.PI }),
  RAND: math("", "Returns a random number from 0 up to 1.", { volatile: true, fn: (_args, ctx) => ctx.host.random() }),
  RANDBETWEEN: math("bottom, top", "Returns a random whole number between two numbers.", { volatile: true, fn: (args, ctx) => randBetween(ctx)(args) }),
  CEILING: math("number, significance", "Rounds a number up to a multiple of significance.", { fn: scalar([num, num], ceiling) }),
  "CEILING.MATH": math("number, [significance], [mode]", "Rounds a number up to a multiple; mode rounds negatives away from zero.", { fn: scalar([num, opt(num, 1), zero], mathRounding(true)) }),
  FLOOR: math("number, significance", "Rounds a number down to a multiple of significance.", { fn: scalar([num, num], floor) }),
  "FLOOR.MATH": math("number, [significance], [mode]", "Rounds a number down to a multiple; mode rounds negatives toward zero.", { fn: scalar([num, opt(num, 1), zero], mathRounding(false)) }),
  EVEN: math("number", "Rounds a number away from zero to an even integer.", { fn: scalar([num], even) }),
  ODD: math("number", "Rounds a number away from zero to an odd integer.", { fn: scalar([num], odd) }),
  FACT: math("number", "Returns the factorial of a number.", { fn: scalar([int], fact) }),
  COMBIN: math("number, number_chosen", "Counts the combinations of items chosen from a set.", { fn: scalar([int, int], combin) }),
  PERMUT: math("number, number_chosen", "Counts the ordered arrangements of items chosen from a set.", { fn: scalar([int, int], permut) }),
  GCD: math("number1, [number2], ...", "Returns the greatest common divisor of whole numbers.", { fn: gcd }),
  LCM: math("number1, [number2], ...", "Returns the least common multiple of whole numbers.", { fn: lcm }),
  QUOTIENT: math("numerator, denominator", "Returns the whole-number part of a division.", { fn: scalar([num, num], quotient) }),
  DEGREES: math("angle", "Converts radians to degrees.", { fn: scalar([num], (x) => (x * 180) / Math.PI) }),
  RADIANS: math("angle", "Converts degrees to radians.", { fn: scalar([num], (x) => (x * Math.PI) / 180) }),
  SIN: math("number", "Returns the sine of an angle in radians.", { fn: scalar([num], Math.sin) }),
  COS: math("number", "Returns the cosine of an angle in radians.", { fn: scalar([num], Math.cos) }),
  TAN: math("number", "Returns the tangent of an angle in radians.", { fn: scalar([num], Math.tan) }),
  ASIN: math("number", "Returns the arcsine of a number, in radians.", { fn: scalar([num], Math.asin) }),
  ACOS: math("number", "Returns the arccosine of a number, in radians.", { fn: scalar([num], Math.acos) }),
  ATAN: math("number", "Returns the arctangent of a number, in radians.", { fn: scalar([num], Math.atan) }),
  ATAN2: math("x_num, y_num", "Returns the angle of the point (x, y) from the x-axis, in radians.", { fn: scalar([num, num], atan2) }),
  SUBTOTAL: math("function_num, ref1, [ref2], ...", "Returns a subtotal (1-11, or 101-111) such as SUM or AVERAGE of ranges.", { fn: subtotal }),
  MMULT: math("array1, array2", "Returns the matrix product of two arrays.", { array: true, fn: mmult }),
};
