/** Recalculates a whole workbook.
 *
 * Evaluation is lazy and memoized: reading a cell evaluates its formula (and
 * that formula's precedents) once, and a cell that is still being evaluated
 * when it is read again is a circular reference. Two kinds of producers fill
 * cells they do not own: dynamic-array formulas that spill, and pivot tables.
 * Before an empty cell reads as empty, every unsettled producer above and to
 * the left of it is evaluated, so a spill is never missed because of the
 * order cells happened to be visited in.
 */

import { MAX_SHEET_COLS, MAX_SHEET_ROWS, type CellRange, cellKey, columnIndex, columnLabel, parseCellKey, parseRangeRef, splitSheetQualifiedRef } from "./address";
import { Evaluator } from "./formula/evaluate";
import { SHEET_FUNCTIONS } from "./formula/functions";
import { liftsOverArrays } from "./formula/functions/helpers";
import { type FormulaNode, parseFormula } from "./formula/parser";
import type { EvalHost, RangeRef } from "./formula/types";
import { type Matrix, type Scalar, SheetError, dateToSerial, isError, isMatrix, sheetError, timeToFraction } from "./formula/values";
import { computePivot, type PivotOutput } from "./pivot";
import type { Sheet, SheetCell, SheetPivot, SheetTable, Workbook } from "./sheetModel";

const ARRAY_PASS_THROUGH = new Set(["IF", "IFERROR", "IFNA", "IFS", "SWITCH", "CHOOSE", "INDEX", "OFFSET", "INDIRECT", "LET"]);

/** Nodes that can name several cells at once. */
const ARRAY_NODES = new Set<FormulaNode["type"]>(["range", "array", "name", "struct"]);

/** Whether a formula's top-level result can be a multi-cell array. */
export function mayReturnArray(node: FormulaNode): boolean {
  if (ARRAY_NODES.has(node.type)) return true;
  switch (node.type) {
    case "call":
      return callMayReturnArray(node);
    case "unary":
      return mayReturnArray(node.arg);
    case "binary":
      return mayReturnArray(node.left) || mayReturnArray(node.right);
    default:
      return false;
  }
}

/** Array functions always may; wrappers like IF and functions that lift a
 * scalar over their arguments (=LEN(A2:A9)) may when an argument may. */
function callMayReturnArray(node: Extract<FormulaNode, { type: "call" }>): boolean {
  const spec = SHEET_FUNCTIONS[node.name];
  if (spec?.array) return true;
  const passesArrays = ARRAY_PASS_THROUGH.has(node.name) || liftsOverArrays(spec?.fn);
  return passesArrays && node.args.some(mayReturnArray);
}

const key = (row: number, col: number) => row * MAX_SHEET_COLS + col;
const rowOf = (k: number) => Math.floor(k / MAX_SHEET_COLS);
const colOf = (k: number) => k % MAX_SHEET_COLS;

export type DerivedSource = { kind: "spill"; row: number; col: number } | { kind: "pivot"; pivotId: string };

export type FormulaProblem = { sheetId: string; sheetName: string; address: string; formula: string; error: SheetError };

type PivotState = {
  spec: SheetPivot;
  row: number;
  col: number;
  status: 0 | 1 | 2;
  output: PivotOutput | SheetError | null;
};

type SheetState = {
  sheet: Sheet;
  cells: Map<number, SheetCell>;
  maxRow: number;
  maxCol: number;
  values: Map<number, Scalar>;
  status: Map<number, 1 | 2>;
  spillTargets: Map<number, { anchor: number; value: Scalar }>;
  spillExtent: Map<number, CellRange>;
  unsettled: Set<number>;
  pivots: PivotState[];
  pivotCells: Map<number, { pivot: PivotState; value: Scalar }>;
};

const CIRCULAR = () => sheetError("#REF!", "Circular reference: this formula depends on its own result.");

function inSheet(row: number, col: number): boolean {
  return row >= 0 && col >= 0 && row < MAX_SHEET_ROWS && col < MAX_SHEET_COLS;
}

/** A typed value or formula sits in the cell (a style or note alone does not count). */
function isFilled(state: SheetState, k: number): boolean {
  const cell = state.cells.get(k);
  return Boolean(cell && (cell.f !== undefined || cell.v !== undefined));
}

/** A spill or a pivot already writes into the cell. */
function isDerived(state: SheetState, k: number): boolean {
  return state.spillTargets.has(k) || state.pivotCells.has(k);
}

function derivedEntry(state: SheetState, k: number): { value: Scalar } | undefined {
  return state.spillTargets.get(k) ?? state.pivotCells.get(k);
}

function formulaMaySpill(formula: string): boolean {
  const parsed = parseFormula(formula);
  return parsed.ok && mayReturnArray(parsed.ast);
}

function pivotStates(sheet: Sheet): PivotState[] {
  return (sheet.pivots ?? []).flatMap((spec) => {
    const point = parseCellKey(spec.at);
    return point ? [{ spec, row: point.row, col: point.col, status: 0 as const, output: null }] : [];
  });
}

/** Why a spill of rows × cols from (row, col) cannot land, or null when it can. */
function spillProblem(state: SheetState, row: number, col: number, rows: number, cols: number): SheetError | null {
  if (row + rows > MAX_SHEET_ROWS || col + cols > MAX_SHEET_COLS) {
    return sheetError("#SPILL!", "The result runs past the edge of the sheet.");
  }
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const problem = r || c ? spillCellProblem(state, row + r, col + c, rows, cols) : null;
      if (problem) return problem;
    }
  }
  return null;
}

function spillCellProblem(state: SheetState, row: number, col: number, rows: number, cols: number): SheetError | null {
  const target = key(row, col);
  if (isFilled(state, target)) return sheetError("#SPILL!", `The result needs ${rows}×${cols} cells, but ${cellKey(row, col)} is not empty.`);
  if (isDerived(state, target)) return sheetError("#SPILL!", `The result would overlap other results at ${cellKey(row, col)}.`);
  return null;
}

function writeSpill(state: SheetState, anchor: number, matrix: Matrix, rows: number, cols: number): void {
  const row = rowOf(anchor);
  const col = colOf(anchor);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (r || c) state.spillTargets.set(key(row + r, col + c), { anchor, value: matrix[r][c] });
    }
  }
  state.spillExtent.set(anchor, { r1: row, c1: col, r2: row + rows - 1, c2: col + cols - 1 });
}

/** A pivot needs every cell of its output free of typed values, spills, and other pivots. */
function pivotBlocked(state: SheetState, pivot: PivotState, output: PivotOutput): boolean {
  return output.values.some((line, r) => line.some((_, c) => {
    const target = key(pivot.row + r, pivot.col + c);
    return isFilled(state, target) || isDerived(state, target);
  }));
}

function columnFormat(sheet: Sheet, col: number): string | undefined {
  return sheet.cols?.[columnLabel(col)]?.s?.format;
}

/** A source field's number format: its first data cell's, else its column's. */
function sourceFieldFormat(sourceState: SheetState | null, range: CellRange | null): (fieldIndex: number) => string | undefined {
  return (fieldIndex) => {
    if (!sourceState || !range) return undefined;
    const col = range.c1 + fieldIndex;
    return sourceState.cells.get(key(range.r1 + 1, col))?.s?.format ?? columnFormat(sourceState.sheet, col);
  };
}

function localNow(date: Date): number {
  return (
    dateToSerial(date.getFullYear(), date.getMonth() + 1, date.getDate()) +
    timeToFraction(date.getHours(), date.getMinutes(), date.getSeconds())
  );
}

export class WorkbookEngine implements EvalHost {
  readonly workbook: Workbook;
  readonly now: number;
  private readonly states = new Map<string, SheetState>();
  private readonly byName = new Map<string, SheetState>();
  private readonly stack: { state: SheetState; row: number; col: number }[] = [];
  private readonly evaluator: Evaluator;
  private readonly problems: FormulaProblem[] = [];
  private readonly tables = new Map<string, { table: SheetTable; state: SheetState }>();

  constructor(workbook: Workbook, options: { now?: Date } = {}) {
    this.workbook = workbook;
    this.now = localNow(options.now ?? new Date());
    this.evaluator = new Evaluator(this, SHEET_FUNCTIONS);
    for (const sheet of workbook.sheets) {
      const state = this.createState(sheet);
      this.states.set(sheet.id, state);
      this.byName.set(sheet.name.toLowerCase(), state);
      for (const table of sheet.tables ?? []) this.tables.set(table.name.toLowerCase(), { table, state });
    }
  }

  private createState(sheet: Sheet): SheetState {
    const cells = new Map<number, SheetCell>();
    let maxRow = -1;
    let maxCol = -1;
    const unsettled = new Set<number>();
    for (const [address, cell] of Object.entries(sheet.cells)) {
      const point = parseCellKey(address);
      if (!point) continue;
      const k = key(point.row, point.col);
      cells.set(k, cell);
      if (cell.f !== undefined || cell.v !== undefined) {
        maxRow = Math.max(maxRow, point.row);
        maxCol = Math.max(maxCol, point.col);
      }
      if (cell.f && formulaMaySpill(cell.f)) unsettled.add(k);
    }
    const pivots = pivotStates(sheet);
    return {
      sheet,
      cells,
      maxRow,
      maxCol,
      values: new Map(),
      status: new Map(),
      spillTargets: new Map(),
      spillExtent: new Map(),
      unsettled,
      pivots,
      pivotCells: new Map(),
    };
  }

  /* ---------------------------------------------------------- EvalHost */

  get current(): { sheet: string; row: number; col: number } {
    const top = this.stack.at(-1);
    return top ? { sheet: top.state.sheet.name, row: top.row, col: top.col } : { sheet: this.workbook.sheets[0].name, row: 0, col: 0 };
  }

  random(): number {
    return Math.random();
  }

  private stateFor(sheet: string | null): SheetState | null {
    if (sheet === null) return this.stack.at(-1)?.state ?? this.states.get(this.workbook.sheets[0].id) ?? null;
    return this.byName.get(sheet.toLowerCase()) ?? null;
  }

  cell(sheet: string | null, row: number, col: number): Scalar {
    const state = this.stateFor(sheet);
    if (!state) return sheetError("#REF!", `There is no sheet named "${sheet}".`);
    return this.read(state, row, col);
  }

  range(ref: RangeRef): Matrix | SheetError {
    const state = this.stateFor(ref.sheet);
    if (!state) return sheetError("#REF!", `There is no sheet named "${ref.sheet}".`);
    if (ref.r2 > state.maxRow || ref.c2 > state.maxCol) this.settle(state, ref.r2, ref.c2);
    const bounds = this.extent(state);
    const r2 = Math.min(ref.r2, Math.max(bounds.maxRow, ref.r1));
    const c2 = Math.min(ref.c2, Math.max(bounds.maxCol, ref.c1));
    const out: Matrix = [];
    for (let row = ref.r1; row <= r2; row += 1) {
      const line: Scalar[] = [];
      for (let col = ref.c1; col <= c2; col += 1) line.push(this.read(state, row, col));
      out.push(line);
    }
    return out;
  }

  resolveName(name: string): RangeRef | null {
    const lower = name.toLowerCase();
    const defined = this.workbook.names?.find((item) => item.name.toLowerCase() === lower);
    if (defined) {
      const { sheet, ref } = splitSheetQualifiedRef(defined.ref);
      const range = parseRangeRef(ref);
      return range ? { sheet, ...range } : null;
    }
    const table = this.tables.get(lower);
    if (table) {
      const range = tableRanges(table.table);
      return range ? { sheet: table.state.sheet.name, ...range.data } : null;
    }
    return null;
  }

  resolveTable(name: string, spec: string, here: { sheet?: string; row: number; col: number }): RangeRef | SheetError {
    const entry = name ? this.tables.get(name.toLowerCase()) : this.tableAround(here);
    if (!entry) return sheetError("#REF!", name ? `There is no table named "${name}".` : "A reference without a table name only works inside a table.");
    const ranges = tableRanges(entry.table);
    if (!ranges) return sheetError("#REF!");
    const headers = this.tableHeaders(entry.state, ranges.all);
    const result = resolveStructuredSpec(spec, ranges, headers, here);
    return isError(result) ? result : { sheet: entry.state.sheet.name, ...result };
  }

  /** The table the formula at `here` sits in, for references that leave the table name out. */
  private tableAround(here: { sheet?: string; row: number; col: number }) {
    const sheet = this.workbook.sheets.find((item) => item.name === here.sheet);
    const table = sheet ? tableAt(sheet.tables, here.row, here.col) : null;
    return table ? this.tables.get(table.name.toLowerCase()) : undefined;
  }

  private tableHeaders(state: SheetState, all: CellRange): string[] {
    const headers: string[] = [];
    for (let col = all.c1; col <= all.c2; col += 1) {
      const value = this.read(state, all.r1, col);
      headers.push(value === null || isError(value) ? "" : String(value));
    }
    return headers;
  }

  /* ---------------------------------------------------------- evaluation */

  private read(state: SheetState, row: number, col: number): Scalar {
    if (!inSheet(row, col)) return sheetError("#REF!");
    const k = key(row, col);
    const cell = state.cells.get(k);
    if (cell?.f) return this.evaluateCell(state, k, cell.f);
    if (cell?.v !== undefined) return cell.v;
    const derived = derivedEntry(state, k);
    if (derived) return derived.value;
    if (!this.settle(state, row, col)) return null;
    const late = derivedEntry(state, k);
    return late ? late.value : null;
  }

  /** Evaluates unsettled producers at or above-left of (row, col). Returns
   * whether any producer finished, so the caller knows to look again. */
  private settle(state: SheetState, row: number, col: number): boolean {
    const formulas = this.settleFormulas(state, row, col);
    const pivots = this.settlePivots(state, row, col);
    return formulas || pivots;
  }

  private settleFormulas(state: SheetState, row: number, col: number): boolean {
    let changed = false;
    if (!state.unsettled.size) return changed;
    for (const k of Array.from(state.unsettled)) {
      if (rowOf(k) > row || colOf(k) > col || state.status.get(k) === 1) continue;
      const cell = state.cells.get(k);
      if (cell?.f) this.evaluateCell(state, k, cell.f);
      changed = true;
    }
    return changed;
  }

  private settlePivots(state: SheetState, row: number, col: number): boolean {
    let changed = false;
    for (const pivot of state.pivots) {
      if (pivot.status !== 0 || pivot.row > row || pivot.col > col) continue;
      this.computePivotState(state, pivot);
      changed = true;
    }
    return changed;
  }

  private extent(state: SheetState): { maxRow: number; maxCol: number } {
    let { maxRow, maxCol } = state;
    for (const range of state.spillExtent.values()) {
      maxRow = Math.max(maxRow, range.r2);
      maxCol = Math.max(maxCol, range.c2);
    }
    for (const k of state.pivotCells.keys()) {
      maxRow = Math.max(maxRow, rowOf(k));
      maxCol = Math.max(maxCol, colOf(k));
    }
    return { maxRow, maxCol };
  }

  private evaluateCell(state: SheetState, k: number, formula: string): Scalar {
    const status = state.status.get(k);
    if (status === 2) return state.values.get(k) ?? null;
    if (status === 1) return CIRCULAR();
    state.status.set(k, 1);
    const row = rowOf(k);
    const col = colOf(k);
    this.stack.push({ state, row, col });
    let result: Scalar;
    try {
      const parsed = parseFormula(formula);
      if (!parsed.ok) {
        result = sheetError("#NAME?", `The formula could not be read: ${parsed.error}`);
      } else {
        const value = this.evaluator.evaluate(parsed.ast);
        result = isMatrix(value) ? this.spill(state, k, value) : value;
      }
    } catch (error) {
      result = sheetError("#CALC!", error instanceof Error ? error.message : "The calculation failed.");
    } finally {
      this.stack.pop();
    }
    state.values.set(k, result);
    state.status.set(k, 2);
    state.unsettled.delete(k);
    if (isError(result)) {
      this.problems.push({ sheetId: state.sheet.id, sheetName: state.sheet.name, address: cellKey(row, col), formula, error: result });
    }
    return result;
  }

  private spill(state: SheetState, anchor: number, matrix: Matrix): Scalar {
    const rows = matrix.length;
    const cols = matrix[0]?.length ?? 0;
    if (!rows || !cols) return sheetError("#CALC!", "The result is an empty array.");
    if (rows === 1 && cols === 1) return matrix[0][0];
    const problem = spillProblem(state, rowOf(anchor), colOf(anchor), rows, cols);
    if (problem) return problem;
    writeSpill(state, anchor, matrix, rows, cols);
    return matrix[0][0];
  }

  private computePivotState(state: SheetState, pivot: PivotState): void {
    pivot.status = 1;
    this.stack.push({ state, row: pivot.row, col: pivot.col });
    try {
      pivot.output = this.pivotOutput(pivot.spec);
    } finally {
      this.stack.pop();
    }
    pivot.status = 2;
    const output = pivot.output;
    if (!output || isError(output)) return;
    if (pivotBlocked(state, pivot, output)) {
      pivot.output = sheetError("#SPILL!", "The pivot table needs empty cells for its results.");
      return;
    }
    output.values.forEach((line, r) => line.forEach((value, c) => {
      state.pivotCells.set(key(pivot.row + r, pivot.col + c), { pivot, value });
    }));
  }

  private pivotOutput(spec: SheetPivot): PivotOutput | SheetError {
    const { sheet, ref } = splitSheetQualifiedRef(spec.source);
    const range = parseRangeRef(ref);
    const source = range ? this.range({ sheet, ...range }) : sheetError("#REF!", "The pivot table's source range is not valid.");
    if (isError(source)) return source;
    return computePivot(spec, source, sourceFieldFormat(this.stateFor(sheet), range));
  }

  /* ---------------------------------------------------------- results */

  /** Evaluates every formula and pivot so all values and problems are known. */
  computeAll(): this {
    for (const state of this.states.values()) {
      for (const pivot of state.pivots) if (pivot.status === 0) this.computePivotState(state, pivot);
      for (const [k, cell] of state.cells) if (cell.f) this.evaluateCell(state, k, cell.f);
    }
    return this;
  }

  value(sheetId: string, row: number, col: number): Scalar {
    const state = this.states.get(sheetId);
    if (!state) return null;
    const k = key(row, col);
    const cell = state.cells.get(k);
    if (cell?.f) return this.evaluateCell(state, k, cell.f);
    if (cell?.v !== undefined) return cell.v;
    return shownDerivedValue(state, k);
  }

  /** Where a derived (read-only) cell's value comes from, if it is one. */
  derivedSource(sheetId: string, row: number, col: number): DerivedSource | null {
    const state = this.states.get(sheetId);
    if (!state) return null;
    const spilled = state.spillTargets.get(key(row, col));
    if (spilled) return { kind: "spill", row: rowOf(spilled.anchor), col: colOf(spilled.anchor) };
    const pivot = state.pivotCells.get(key(row, col));
    return pivot ? { kind: "pivot", pivotId: pivot.pivot.spec.id } : null;
  }

  spillRange(sheetId: string, row: number, col: number): CellRange | null {
    return this.states.get(sheetId)?.spillExtent.get(key(row, col)) ?? null;
  }

  pivotResult(sheetId: string, pivotId: string): { range: CellRange | null; output: PivotOutput | SheetError | null } {
    const state = this.states.get(sheetId);
    const pivot = state?.pivots.find((item) => item.spec.id === pivotId);
    if (!pivot || !pivot.output) return { range: null, output: null };
    if (isError(pivot.output)) return { range: { r1: pivot.row, c1: pivot.col, r2: pivot.row, c2: pivot.col }, output: pivot.output };
    const rows = pivot.output.values.length;
    const cols = pivot.output.values[0]?.length ?? 1;
    return { range: { r1: pivot.row, c1: pivot.col, r2: pivot.row + rows - 1, c2: pivot.col + cols - 1 }, output: pivot.output };
  }

  /** Number format of a pivot output cell, taken from its source field. */
  pivotCellFormat(sheetId: string, row: number, col: number): string | undefined {
    const state = this.states.get(sheetId);
    const entry = state?.pivotCells.get(key(row, col));
    const output = entry?.pivot.output;
    if (!entry || !output || isError(output)) return undefined;
    if (row - entry.pivot.row < output.headerRows) return undefined;
    return output.columnFormats[col - entry.pivot.col];
  }

  /** Every formula that ended in an error, in evaluation order. */
  formulaProblems(): FormulaProblem[] {
    return this.problems.slice();
  }

  /** Used extent including spilled and pivot results; null for an empty sheet. */
  usedRange(sheetId: string): CellRange | null {
    const state = this.states.get(sheetId);
    if (!state) return null;
    const { maxRow, maxCol } = this.extent(state);
    return maxRow < 0 || maxCol < 0 ? null : { r1: 0, c1: 0, r2: maxRow, c2: maxCol };
  }
}

/** A pivot cell shows nothing once its pivot failed; a spilled cell shows its value. */
function shownDerivedValue(state: SheetState, k: number): Scalar {
  const pivot = state.pivotCells.get(k);
  if (pivot) {
    const output = pivot.pivot.output;
    return output && !isError(output) ? pivot.value : null;
  }
  return state.spillTargets.get(k)?.value ?? null;
}

export function computeWorkbook(workbook: Workbook, options: { now?: Date } = {}): WorkbookEngine {
  return new WorkbookEngine(workbook, options).computeAll();
}

/* ------------------------------------------------------------------ tables */

export type TableRanges = { all: CellRange; header: CellRange; data: CellRange; totals: CellRange | null };

/** The table whose cells include (row, col), if any. */
export function tableAt(tables: SheetTable[] | undefined, row: number, col: number): SheetTable | null {
  for (const table of tables ?? []) {
    const all = parseRangeRef(table.ref);
    if (all && row >= all.r1 && row <= all.r2 && col >= all.c1 && col <= all.c2) return table;
  }
  return null;
}

export function tableRanges(table: SheetTable): TableRanges | null {
  const all = parseRangeRef(table.ref);
  if (!all || all.r2 <= all.r1) return null;
  const header = { ...all, r2: all.r1 };
  const lastData = table.totals ? all.r2 - 1 : all.r2;
  const data = { ...all, r1: all.r1 + 1, r2: Math.max(all.r1 + 1, lastData) };
  const totals = table.totals ? { ...all, r1: all.r2 } : null;
  return { all, header, data, totals };
}

/** The rows a structured reference covers, whether it means the current row, and the columns it names. */
type SpecParts = { rows: CellRange; thisRow: boolean; columns: string[] };

const TABLE_SECTIONS = new Map<string, (ranges: TableRanges) => CellRange | null>([
  ["#all", (ranges) => ranges.all],
  ["#data", (ranges) => ranges.data],
  ["#headers", (ranges) => ranges.header],
  ["#totals", (ranges) => ranges.totals],
]);

/** Resolves the bracket part of Table[...]: "#All", "#Data", "#Headers",
 * "#Totals", "Column", "@Column", "[#This Row],[Column]", "[A]:[C]". */
export function resolveStructuredSpec(
  spec: string,
  ranges: TableRanges,
  headers: string[],
  here: { row: number; col: number },
): CellRange | SheetError {
  const { body: trimmed, thisRow } = thisRowMarker(spec.trim());
  const colonSpan = /^\[([^\]]+)\]\s*:\s*\[([^\]]+)\]$/.exec(trimmed);
  const parts: SpecParts | SheetError = colonSpan ? { rows: ranges.data, thisRow: false, columns: [] } : specParts(trimmed, ranges);
  if (isError(parts)) return parts;
  if (thisRow) parts.thisRow = true;
  const columns = colonSpan ? spanColumns(colonSpan[1].trim(), colonSpan[2].trim(), ranges, headers) : namedColumns(parts.columns, ranges, headers);
  if (isError(columns)) return columns;
  if (!parts.thisRow) return { r1: parts.rows.r1, r2: parts.rows.r2, c1: columns.c1, c2: columns.c2 };
  if (here.row < ranges.data.r1 || here.row > ranges.data.r2) return sheetError("#VALUE!", "[@Column] only works on a row inside the table.");
  return { r1: here.row, r2: here.row, c1: columns.c1, c2: columns.c2 };
}

/** Excel writes "this row" as @Qty, @[Qty], or [@[Qty]]; the bracketed two
 * come back as the spec without the marker. "@Qty" is read as an item. */
function thisRowMarker(spec: string): { body: string; thisRow: boolean } {
  const nested = /^\[\s*@\s*(\[.*\])\s*\]$/.exec(spec);
  if (nested) return { body: nested[1], thisRow: true };
  // "@[Qty]": the bracketed items are read and the text around them ignored.
  return { body: spec, thisRow: /^@\s*\[/.test(spec) };
}

function specParts(trimmed: string, ranges: TableRanges): SpecParts | SheetError {
  const items = trimmed.includes("[") ? Array.from(trimmed.matchAll(/\[([^\]]*)\]/g), (match) => match[1].trim()) : [trimmed];
  const parts: SpecParts = { rows: ranges.data, thisRow: false, columns: [] };
  for (const item of items) {
    const problem = addSpecItem(parts, item, ranges);
    if (problem) return problem;
  }
  return parts;
}

/** Reads one bracketed item: a section, "#This Row", "@Column", or a column name. */
function addSpecItem(parts: SpecParts, raw: string, ranges: TableRanges): SheetError | null {
  const atRow = raw.startsWith("@");
  if (atRow) parts.thisRow = true;
  const item = atRow ? raw.slice(1).trim() : raw;
  if (!item) return null;
  const lower = item.toLowerCase();
  const section = TABLE_SECTIONS.get(lower);
  if (section) {
    const rows = section(ranges);
    if (!rows) return sheetError("#REF!", "This table has no totals row.");
    parts.rows = rows;
  } else if (lower === "#this row") parts.thisRow = true;
  else parts.columns.push(item.replace(/'(.)/g, "$1"));
  return null;
}

function headerIndex(headers: string[], name: string): number {
  return headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
}

/** [First]:[Last] covers every column between the two, in either order. */
function spanColumns(first: string, last: string, ranges: TableRanges, headers: string[]): { c1: number; c2: number } | SheetError {
  const a = headerIndex(headers, first);
  const b = headerIndex(headers, last);
  if (a < 0 || b < 0) return sheetError("#REF!", "The table has no column with that name.");
  return { c1: ranges.all.c1 + Math.min(a, b), c2: ranges.all.c1 + Math.max(a, b) };
}

/** The named columns' extent, or the whole table width when none are named. */
function namedColumns(columns: string[], ranges: TableRanges, headers: string[]): { c1: number; c2: number } | SheetError {
  if (!columns.length) return { c1: ranges.all.c1, c2: ranges.all.c2 };
  const indexes = columns.map((name) => headerIndex(headers, name));
  const missing = indexes.findIndex((index) => index < 0);
  if (missing >= 0) return sheetError("#REF!", `The table has no column named "${columns[missing]}".`);
  return { c1: ranges.all.c1 + Math.min(...indexes), c2: ranges.all.c1 + Math.max(...indexes) };
}

export function columnOfLetter(letter: string): number {
  return columnIndex(letter);
}
