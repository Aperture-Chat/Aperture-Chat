import type { FormulaNode } from "../parser";
import type { CallContext, FunctionSpec } from "../types";
import { ERR, type Matrix, type Scalar, type SheetError, type Value, compareScalars, isError, isMatrix, sheetError, toBoolean } from "../values";
import { define, elementAt, liftScalar } from "./helpers";
import { bool, scalar } from "./scalar";

const logical = define("Logical");

/** IF's branch for a truth value: a missing branch returns the truth value
 * itself, an empty one (=IF(A1,,2)) returns 0. */
function branch(args: FormulaNode[], ctx: CallContext, truth: boolean): Value {
  const node = truth ? args[1] : args[2];
  if (!node) return truth;
  return node.type === "empty" ? 0 : ctx.evaluate(node);
}

function ifArray(test: Matrix, yes: Value, no: Value): Matrix {
  return test.map((row, r) => row.map((item, c) => {
    const truth = toBoolean(item);
    return isError(truth) ? truth : elementAt(truth ? yes : no, r, c);
  }));
}

function ifFn(args: FormulaNode[], ctx: CallContext): Value {
  const test = ctx.evaluate(args[0]);
  if (isMatrix(test)) return ifArray(test, branch(args, ctx, true), branch(args, ctx, false));
  const truth = toBoolean(test);
  return isError(truth) ? truth : branch(args, ctx, truth);
}

/** IFERROR and IFNA: the fallback is evaluated only when it is needed. */
function fallbackWhen(caught: (error: SheetError) => boolean) {
  return (args: FormulaNode[], ctx: CallContext): Value => {
    const value = ctx.evaluate(args[0]);
    const fails = (item: Scalar) => isError(item) && caught(item);
    if (!isMatrix(value)) return fails(value) ? ctx.evaluate(args[1]) : value;
    let fallback: Value | undefined;
    return value.map((row, r) => row.map((item, c) => {
      if (!fails(item)) return item;
      fallback ??= ctx.evaluate(args[1]);
      return elementAt(fallback, r, c);
    }));
  };
}

/** Evaluates every argument and applies `pick` element by element; used when
 * a test or expression turns out to be an array. */
function elementwise(args: FormulaNode[], ctx: CallContext, pick: (items: Scalar[]) => Scalar): Value {
  return liftScalar(pick)(args.map((node) => ctx.evaluate(node)));
}

function ifsPick(items: Scalar[]): Scalar {
  for (let index = 0; index < items.length; index += 2) {
    const truth = toBoolean(items[index]);
    if (isError(truth)) return truth;
    if (truth) return items[index + 1];
  }
  return ERR.na;
}

function ifs(args: FormulaNode[], ctx: CallContext): Value {
  if (args.length % 2) return sheetError("#VALUE!", "IFS needs a value for every test.");
  for (let index = 0; index < args.length; index += 2) {
    const test = ctx.evaluate(args[index]);
    if (isMatrix(test)) return elementwise(args, ctx, ifsPick);
    const truth = toBoolean(test);
    if (isError(truth)) return truth;
    if (truth) return ctx.evaluate(args[index + 1]);
  }
  return ERR.na;
}

function same(a: Scalar, b: Scalar): boolean {
  return typeof a === typeof b && compareScalars(a, b) === 0;
}

function switchPick(items: Scalar[]): Scalar {
  const [expression, ...cases] = items;
  if (isError(expression)) return expression;
  for (let index = 0; index + 1 < cases.length; index += 2) if (same(expression, cases[index])) return cases[index + 1];
  return cases.length % 2 ? cases[cases.length - 1] : ERR.na;
}

function switchFn(args: FormulaNode[], ctx: CallContext): Value {
  const expression = ctx.evaluate(args[0]);
  if (isMatrix(expression)) return elementwise(args, ctx, switchPick);
  if (isError(expression)) return expression;
  const cases = args.slice(1);
  for (let index = 0; index + 1 < cases.length; index += 2) {
    const candidate = ctx.evaluate(cases[index]);
    if (!isMatrix(candidate) && same(expression, candidate)) return ctx.evaluate(cases[index + 1]);
  }
  return cases.length % 2 ? ctx.evaluate(cases[cases.length - 1]) : ERR.na;
}

/** TRUE/FALSE values for AND, OR, and XOR: references and arrays skip text
 * and blanks; typed arguments must read as TRUE or FALSE. */
function logicals(args: Value[], ctx: CallContext): boolean[] | SheetError {
  const out: boolean[] = [];
  for (const [index, arg] of args.entries()) {
    const failure = isMatrix(arg) || ctx.refs[index] !== undefined ? referenceLogicals(arg, out) : typedLogical(arg, out);
    if (failure) return failure;
  }
  return out.length ? out : sheetError("#VALUE!", "There are no TRUE or FALSE values to test.");
}

function typedLogical(arg: Scalar, out: boolean[]): SheetError | null {
  const truth = toBoolean(arg);
  if (isError(truth)) return truth;
  out.push(truth);
  return null;
}

function referenceLogicals(arg: Value, out: boolean[]): SheetError | null {
  for (const item of isMatrix(arg) ? arg.flat() : [arg]) {
    if (isError(item)) return item;
    if (typeof item === "boolean" || typeof item === "number") out.push(Boolean(item));
  }
  return null;
}

function combine(reduce: (values: boolean[]) => boolean) {
  return (args: Value[], ctx: CallContext): Value => {
    const values = logicals(args, ctx);
    return isError(values) ? values : reduce(values);
  };
}

function letFn(args: FormulaNode[], ctx: CallContext): Value {
  if (args.length % 2 === 0) return sheetError("#VALUE!", "LET needs a final calculation after its names and values.");
  const bindings = new Map<string, Value>();
  for (let index = 0; index + 1 < args.length; index += 2) {
    const node = args[index];
    if (node.type !== "name") return sheetError("#VALUE!", "LET needs a name before each value.");
    bindings.set(node.name, ctx.evaluateWith(bindings, args[index + 1]));
  }
  return ctx.evaluateWith(bindings, args[args.length - 1]);
}

export const LOGICAL_FUNCTIONS: Record<string, FunctionSpec> = {
  IF: logical("logical_test, [value_if_true], [value_if_false]", "Returns one value when a condition is TRUE and another when it is FALSE.", { lazy: ifFn }),
  IFERROR: logical("value, value_if_error", "Returns a fallback when a value is an error.", { lazy: fallbackWhen(() => true) }),
  IFNA: logical("value, value_if_na", "Returns a fallback when a value is #N/A.", { lazy: fallbackWhen((error) => error.code === "#N/A") }),
  IFS: logical("logical_test1, value_if_true1, ...", "Returns the value for the first condition that is TRUE.", { lazy: ifs }),
  SWITCH: logical("expression, value1, result1, [default_or_value2], [result2], ...", "Returns the result for the first value that matches the expression.", { lazy: switchFn }),
  AND: logical("logical1, [logical2], ...", "Returns TRUE when every argument is TRUE.", { fn: combine((values) => values.every(Boolean)) }),
  OR: logical("logical1, [logical2], ...", "Returns TRUE when any argument is TRUE.", { fn: combine((values) => values.some(Boolean)) }),
  XOR: logical("logical1, [logical2], ...", "Returns TRUE when an odd number of arguments are TRUE.", { fn: combine((values) => values.filter(Boolean).length % 2 === 1) }),
  NOT: logical("logical", "Reverses TRUE and FALSE.", { fn: scalar([bool], (truth) => !truth) }),
  TRUE: logical("", "Returns TRUE.", { fn: () => true }),
  FALSE: logical("", "Returns FALSE.", { fn: () => false }),
  LET: logical("name1, name_value1, calculation_or_name2, ...", "Names values inside a formula, then calculates with those names.", { lazy: letFn }),
};
