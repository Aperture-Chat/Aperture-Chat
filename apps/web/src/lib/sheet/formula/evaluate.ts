/** Walks a parsed formula against an EvalHost. Operators broadcast over
 * arrays the way Excel's dynamic arrays do, so =A1:A5*2 yields five values
 * that the recalculation engine spills into the cells below. */

import type { FormulaNode } from "./parser";
import type { CallContext, EvalHost, FunctionSpec, RangeRef, RefResult } from "./types";
import {
  ERR,
  type Matrix,
  type Scalar,
  type SheetError,
  type Value,
  broadcast2,
  compareScalars,
  isError,
  isMatrix,
  mapValue,
  sheetError,
  toNumber,
  toText,
} from "./values";

export type FunctionTable = Record<string, FunctionSpec>;

type NumberOp = (x: number, y: number) => number | SheetError;

function divide(x: number, y: number): number | SheetError {
  return y === 0 ? ERR.div0 : x / y;
}

/** "^", which is also what any other operator falls back to. */
function power(x: number, y: number): number | SheetError {
  if (x === 0 && y === 0) return ERR.num;
  if (x === 0 && y < 0) return ERR.div0;
  return x ** y;
}

const NUMBER_OPS = new Map<string, NumberOp>([
  ["+", (x, y) => x + y],
  ["-", (x, y) => x - y],
  ["*", (x, y) => x * y],
  ["/", divide],
]);

function arithmetic(op: string, a: Scalar, b: Scalar): Scalar {
  if (isError(a)) return a;
  if (isError(b)) return b;
  const x = toNumber(a);
  if (isError(x)) return x;
  const y = toNumber(b);
  if (isError(y)) return y;
  const result = (NUMBER_OPS.get(op) ?? power)(x, y);
  return isError(result) || Number.isFinite(result) ? result : ERR.num;
}

function comparison(op: string, a: Scalar, b: Scalar): Scalar {
  if (isError(a)) return a;
  if (isError(b)) return b;
  const order = compareScalars(a, b);
  switch (op) {
    case "=":
      return order === 0;
    case "<>":
      return order !== 0;
    case "<":
      return order < 0;
    case ">":
      return order > 0;
    case "<=":
      return order <= 0;
    default:
      return order >= 0;
  }
}

function concat(a: Scalar, b: Scalar): Scalar {
  const x = toText(a);
  if (isError(x)) return x;
  const y = toText(b);
  if (isError(y)) return y;
  return x + y;
}

const COMPARISON_OPS = new Set(["=", "<>", "<", ">", "<=", ">="]);
/** Functions whose lazy form can hand back a reference rather than values. */
const REFERENCE_FUNCTIONS = new Set(["OFFSET", "INDEX", "INDIRECT"]);
/** Argument nodes that point at cells, whose reference eager functions also get. */
const REFERENCE_NODES = new Set<FormulaNode["type"]>(["ref", "range", "name", "struct"]);

type NodeOf<T extends FormulaNode["type"]> = Extract<FormulaNode, { type: T }>;

function literalValue(node: NodeOf<"num" | "str" | "bool" | "err" | "empty">): Value {
  switch (node.type) {
    case "err":
      return sheetError(node.code);
    case "empty":
      return null;
    default:
      return node.value;
  }
}

function argumentCountError(name: string, spec: FunctionSpec): SheetError {
  const range = spec.min === spec.max ? `${spec.min}` : spec.max === Infinity ? `at least ${spec.min}` : `${spec.min} to ${spec.max}`;
  return sheetError("#VALUE!", `${name} takes ${range} argument${spec.min === 1 && spec.max === 1 ? "" : "s"}.`);
}

export class Evaluator {
  private readonly host: EvalHost;
  private readonly functions: FunctionTable;
  private depth = 0;
  /** LET bindings, innermost last; names resolve here before defined names. */
  private readonly scopes: Map<string, Value>[] = [];

  constructor(host: EvalHost, functions: FunctionTable) {
    this.host = host;
    this.functions = functions;
  }

  evaluate(node: FormulaNode): Value {
    this.depth += 1;
    try {
      if (this.depth > 400) return sheetError("#CALC!", "The formula nests too deeply.");
      return this.evaluateNode(node);
    } finally {
      this.depth -= 1;
    }
  }

  /** The reference a node denotes, or null when it is not a reference. */
  reference(node: FormulaNode): RangeRef | ReturnType<typeof sheetError> | null {
    switch (node.type) {
      case "ref":
        return { sheet: node.sheet, r1: node.row, c1: node.col, r2: node.row, c2: node.col };
      case "range":
        return { sheet: node.sheet, r1: node.r1, c1: node.c1, r2: node.r2, c2: node.c2 };
      case "name":
        return this.host.resolveName(node.name);
      case "struct":
        return this.host.resolveTable(node.table, node.spec, this.host.current);
      case "call":
        return this.lazyReference(node);
      default:
        return null;
    }
  }

  /** OFFSET, INDEX, and INDIRECT can stand for a reference, as in A1:INDEX(...). */
  private lazyReference(node: NodeOf<"call">): RangeRef | null {
    const spec = this.functions[node.name];
    if (!spec?.lazy || !REFERENCE_FUNCTIONS.has(node.name)) return null;
    const result = spec.lazy(node.args, this.context([]));
    return isRefResult(result) ? result.ref : null;
  }

  private context(refs: (RangeRef | undefined)[]): CallContext {
    return {
      host: this.host,
      refs,
      evaluate: (node) => this.evaluate(node),
      reference: (node) => this.reference(node),
      evaluateWith: (bindings, node) => {
        this.scopes.push(new Map(Array.from(bindings, ([name, value]) => [name.toLowerCase(), value])));
        try {
          return this.evaluate(node);
        } finally {
          this.scopes.pop();
        }
      },
    };
  }

  private readRef(ref: RangeRef): Value {
    if (ref.r1 === ref.r2 && ref.c1 === ref.c2) return this.host.cell(ref.sheet, ref.r1, ref.c1);
    return this.host.range(ref);
  }

  private evaluateNode(node: FormulaNode): Value {
    switch (node.type) {
      case "array":
        return this.arrayValue(node);
      case "unary":
        return this.unaryValue(node);
      case "binary":
        return this.binaryValue(node);
      case "call":
        return this.call(node.name, node.args);
      default:
        return this.leafValue(node);
    }
  }

  private leafValue(node: NodeOf<"num" | "str" | "bool" | "err" | "empty" | "ref" | "range" | "name" | "struct">): Value {
    switch (node.type) {
      case "ref":
        return this.host.cell(node.sheet, node.row, node.col);
      case "range":
        return this.host.range({ sheet: node.sheet, r1: node.r1, c1: node.c1, r2: node.r2, c2: node.c2 });
      case "name":
        return this.nameValue(node.name);
      case "struct": {
        const ref = this.host.resolveTable(node.table, node.spec, this.host.current);
        return isError(ref) ? ref : this.readRef(ref);
      }
      default:
        return literalValue(node);
    }
  }

  /** LET bindings (innermost first), then defined names and tables. */
  private nameValue(name: string): Value {
    const bound = this.boundValue(name.toLowerCase());
    if (bound !== undefined) return bound;
    const ref = this.host.resolveName(name);
    return ref ? this.readRef(ref) : sheetError("#NAME?", `"${name}" is not a known name.`);
  }

  private boundValue(lower: string): Value | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const bound = this.scopes[index].get(lower);
      if (bound !== undefined) return bound;
    }
    return undefined;
  }

  /** Array constants hold one value per item; an item that is an array keeps its first value. */
  private arrayValue(node: NodeOf<"array">): Value {
    return node.rows.map((row) => row.map((item) => {
      const value = this.evaluate(item);
      return isMatrix(value) ? value[0][0] : value;
    }));
  }

  private unaryValue(node: NodeOf<"unary">): Value {
    const value = this.evaluate(node.arg);
    if (node.op === "+") return value;
    return mapValue(value, (item) => {
      const number = toNumber(item);
      if (isError(number)) return number;
      return node.op === "-" ? -number : number / 100;
    });
  }

  private binaryValue(node: NodeOf<"binary">): Value {
    const left = this.evaluate(node.left);
    const right = this.evaluate(node.right);
    if (node.op === "&") return broadcast2(left, right, concat);
    if (COMPARISON_OPS.has(node.op)) return broadcast2(left, right, (a, b) => comparison(node.op, a, b));
    return broadcast2(left, right, (a, b) => arithmetic(node.op, a, b));
  }

  private call(name: string, args: FormulaNode[]): Value {
    const spec = this.functions[name];
    if (!spec) return sheetError("#NAME?", `${name} is not a function Aperture knows.`);
    if (args.length < spec.min || args.length > spec.max) return argumentCountError(name, spec);
    if (spec.lazy) {
      const result = spec.lazy(args, this.context([]));
      return isRefResult(result) ? this.readRef(result.ref) : result;
    }
    const refs: (RangeRef | undefined)[] = [];
    const values: Value[] = args.map((arg, index) => this.argumentValue(arg, index, refs));
    return spec.fn ? spec.fn(values, this.context(refs)) : ERR.calc;
  }

  /** Evaluates an eager argument, noting where a reference argument points. */
  private argumentValue(arg: FormulaNode, index: number, refs: (RangeRef | undefined)[]): Value {
    if (REFERENCE_NODES.has(arg.type)) {
      const ref = this.reference(arg);
      if (ref && !isError(ref)) refs[index] = ref;
    }
    return this.evaluate(arg);
  }
}

export function isRefResult(value: unknown): value is RefResult {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && "ref" in (value as object) && !isError(value);
}

export function evaluateFormula(node: FormulaNode, host: EvalHost, functions: FunctionTable): Value {
  return new Evaluator(host, functions).evaluate(node);
}

export type { Matrix };
