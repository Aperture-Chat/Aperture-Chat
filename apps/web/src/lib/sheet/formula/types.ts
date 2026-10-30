/** Contracts between the formula evaluator, its host workbook, and the
 * function library. Every spreadsheet function is a FunctionSpec in
 * ./functions; the evaluator never special-cases a function by name. */

import type { FormulaNode } from "./parser";
import type { Matrix, Scalar, SheetError, Value } from "./values";

/** Where a reference argument points: lets ROW, ROWS, INDEX, OFFSET, and the
 * *IF family see the declared shape even when the matrix was trimmed to the
 * used area (a whole-column reference arrives as only its used rows). */
export type RangeRef = {
  sheet: string | null;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
};

/** A reference returned by OFFSET, INDEX, or INDIRECT. */
export type RefResult = { ref: RangeRef };

export interface EvalHost {
  /** Value of one cell; evaluates its formula (and precedents) on demand. */
  cell(sheet: string | null, row: number, col: number): Scalar;
  /** Values of a rectangle, trimmed to the sheet's used rows and columns. */
  range(ref: RangeRef): Matrix | SheetError;
  /** A defined name or table name as a reference, or null when unknown. */
  resolveName(name: string): RangeRef | null;
  /** A structured table reference (Table[Column], Table[#All]...). */
  resolveTable(table: string, spec: string, here: { row: number; col: number }): RangeRef | SheetError;
  /** The cell being calculated (sheet name and 0-based position). */
  readonly current: { sheet: string; row: number; col: number };
  /** Excel serial for "now", fixed for one recalculation. */
  readonly now: number;
  random(): number;
}

export interface CallContext {
  host: EvalHost;
  /** For each argument that was a reference, where it points. */
  refs: (RangeRef | undefined)[];
  /** Evaluate a node in the current cell (lazy functions only). */
  evaluate(node: FormulaNode): Value;
  /** The reference a node denotes, if it is one (lazy functions only). */
  reference(node: FormulaNode): RangeRef | SheetError | null;
  /** Evaluate a node with extra local names bound (LET). */
  evaluateWith(bindings: Map<string, Value>, node: FormulaNode): Value;
}

export type FunctionSpec = {
  /** Minimum and maximum argument counts (Infinity for variadic). */
  min: number;
  max: number;
  /** Eager: arguments are evaluated first, in order. */
  fn?: (args: Value[], ctx: CallContext) => Value;
  /** Lazy: receives the argument nodes (IF, IFERROR, CHOOSE, ROW, OFFSET...).
   * Reference functions (OFFSET, INDEX, INDIRECT) return a RefResult so
   * ROWS(OFFSET(...)) and SUM(A1:INDEX(...)) see a reference, not values. */
  lazy?: (args: FormulaNode[], ctx: CallContext) => Value | RefResult;
  /** NOW, TODAY, RAND: recalculated every time. */
  volatile?: boolean;
  /** May return a multi-cell array that spills (FILTER, SORT, SEQUENCE...). */
  array?: boolean;
  /** One-line description for the formula autocomplete. */
  description: string;
  /** Argument hint, e.g. "number1, [number2], ...". */
  signature: string;
  category: FunctionCategory;
};

export type FunctionCategory =
  | "Math"
  | "Statistical"
  | "Logical"
  | "Lookup"
  | "Text"
  | "Date & time"
  | "Financial"
  | "Information"
  | "Array";
