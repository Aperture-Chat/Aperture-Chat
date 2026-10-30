/** Visual layers computed from the workbook rather than stored on cells:
 * table banding, pivot table styling, conditional formats, and autofilter
 * results. The grid draws them over each cell's own style; the .xlsx export
 * writes the same rules natively so Excel shows the same thing. */

import { MAX_SHEET_COLS, type CellRange, columnIndex, columnLabel, forEachCellInRange, parseRangeRef, rangeContains } from "./address";
import { evaluateFormula } from "./formula/evaluate";
import { SHEET_FUNCTIONS } from "./formula/functions";
import { parseFormula } from "./formula/parser";
import { shiftFormula } from "./formula/references";
import type { EvalHost } from "./formula/types";
import { type Scalar, compareScalars, isError, isMatrix, parseNumericText, toBoolean } from "./formula/values";
import { SHEET_ACCENTS } from "./palette";
import type { WorkbookEngine } from "./recalc";
import { tableRanges } from "./recalc";
import type { PivotOutput } from "./pivot";
import type { TableRanges } from "./recalc";
import { TEXT_OPERATORS } from "./sheetModel";
import type { CellOperator, ConditionalRule, ConditionalRuleType, ConditionalStyle, Sheet, SheetFilter, SheetFilterCriteria, SheetTable } from "./sheetModel";

export type CellDecoration = {
  fill?: string;
  color?: string;
  bold?: boolean;
  /** Data bar fill fraction 0..1 and its colour. */
  bar?: { fraction: number; color: string };
  /** Accent line under a header row or above a totals row. */
  lineBottom?: string;
  lineTop?: string;
  /** Header cell with a filter button. */
  filterButton?: { active: boolean };
};

const cellId = (row: number, col: number) => row * MAX_SHEET_COLS + col;

/** Layers a decoration over whatever earlier layers left on the cell. */
function paint(out: Map<number, CellDecoration>, row: number, col: number, decoration: CellDecoration): void {
  out.set(cellId(row, col), { ...out.get(cellId(row, col)), ...decoration });
}

function isBlankValue(value: Scalar): boolean {
  return value === null || value === "";
}

export function mixColors(a: string, b: string, weight: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((value, i) => Math.round(value * (1 - weight) + pb[i] * weight).toString(16).padStart(2, "0")).join("")}`;
}

/** The editor surface the virtual styles blend into ("#ffffff" in light mode). */
const DARK_SURFACE = "#0d1c27";

/** Table colours by tone, from one accent (mirrors Excel's built-in styles).
 * In dark mode the tints mix toward the dark surface instead of white, so a
 * banded table reads as part of the dark canvas; exports always use light. */
export function tablePalette(table: Pick<SheetTable, "accent" | "tone">, dark = false): { header: string; headerText: string; band: string; line: string } {
  const accent = SHEET_ACCENTS[table.accent];
  if (dark) {
    if (table.tone === "light") return { header: mixColors(accent, DARK_SURFACE, 0.72), headerText: mixColors(accent, "#ffffff", 0.55), band: mixColors(accent, DARK_SURFACE, 0.86), line: accent };
    if (table.tone === "dark") return { header: mixColors(accent, "#000000", 0.45), headerText: "#ffffff", band: mixColors(accent, DARK_SURFACE, 0.7), line: mixColors(accent, "#000000", 0.2) };
    return { header: mixColors(accent, DARK_SURFACE, 0.2), headerText: "#ffffff", band: mixColors(accent, DARK_SURFACE, 0.8), line: accent };
  }
  if (table.tone === "light") return { header: mixColors(accent, "#ffffff", 0.86), headerText: mixColors(accent, "#000000", 0.35), band: mixColors(accent, "#ffffff", 0.93), line: accent };
  if (table.tone === "dark") return { header: mixColors(accent, "#000000", 0.35), headerText: "#ffffff", band: mixColors(accent, "#ffffff", 0.72), line: mixColors(accent, "#000000", 0.35) };
  return { header: accent, headerText: "#ffffff", band: mixColors(accent, "#ffffff", 0.84), line: accent };
}

type TableColors = ReturnType<typeof tablePalette>;

function decorateTables(sheet: Sheet, out: Map<number, CellDecoration>, dark: boolean): void {
  for (const table of sheet.tables ?? []) {
    const ranges = tableRanges(table);
    if (!ranges) continue;
    const colors = tablePalette(table, dark);
    forEachCellInRange(ranges.all, (row, col) => paint(out, row, col, tableCellDecoration(table, ranges, colors, row, col)));
  }
}

function tableCellDecoration(table: SheetTable, ranges: TableRanges, colors: TableColors, row: number, col: number): CellDecoration {
  if (row === ranges.header.r1) {
    return { fill: colors.header, color: colors.headerText, bold: true, lineBottom: colors.line, ...(table.filterButtons ? { filterButton: { active: false } } : {}) };
  }
  if (ranges.totals && row === ranges.totals.r1) return { bold: true, lineTop: colors.line };
  return tableBodyDecoration(table, ranges, colors, row, col);
}

function tableBodyDecoration(table: SheetTable, ranges: TableRanges, colors: TableColors, row: number, col: number): CellDecoration {
  const decoration: CellDecoration = {};
  if (table.banded && (row - ranges.data.r1) % 2 === 0) decoration.fill = colors.band;
  if (table.firstColumn && col === ranges.all.c1) decoration.bold = true;
  return decoration;
}

function decoratePivots(sheet: Sheet, engine: WorkbookEngine, out: Map<number, CellDecoration>, dark: boolean): void {
  for (const pivot of sheet.pivots ?? []) {
    const result = engine.pivotResult(sheet.id, pivot.id);
    if (!result.range || !result.output || isError(result.output)) continue;
    const range = result.range;
    const output = result.output;
    const colors = pivotColors(dark);
    forEachCellInRange(range, (row, col) => paint(out, row, col, pivotCellDecoration(range, output, colors, row, col)));
  }
}

type PivotColors = { header: string; total: string };

function pivotColors(dark: boolean): PivotColors {
  const base = dark ? DARK_SURFACE : "#ffffff";
  return { header: mixColors(SHEET_ACCENTS[1], base, dark ? 0.7 : 0.82), total: mixColors(SHEET_ACCENTS[1], base, dark ? 0.82 : 0.9) };
}

function pivotCellDecoration(range: CellRange, output: PivotOutput, colors: PivotColors, row: number, col: number): CellDecoration {
  const headerEnd = range.r1 + output.headerRows;
  if (row < headerEnd) return { fill: colors.header, bold: true, ...(row === headerEnd - 1 ? { lineBottom: SHEET_ACCENTS[1] } : {}) };
  if (output.totalRow && row === range.r2) return { bold: true, lineTop: SHEET_ACCENTS[1], fill: colors.total };
  return col < range.c1 + output.labelCols ? { bold: false } : {};
}

function numericValue(value: Scalar): number | null {
  if (typeof value === "number") return value;
  return null;
}

function styleDecoration(style: ConditionalStyle): CellDecoration {
  return { ...(style.fill ? { fill: style.fill } : {}), ...(style.color ? { color: style.color } : {}), ...(style.bold ? { bold: true } : {}) };
}

function operandNumber(text: string): number | null {
  return parseNumericText(text);
}

/** How a value orders against an operand: numerically when both are numbers, else as Excel compares. */
function compareOperand(value: Scalar, operand: string, parsed: number | null): number {
  return parsed !== null && typeof value === "number" ? value - parsed : compareScalars(value, operand);
}

/** Single-operand comparisons, by the order of the value against the operand. */
const ORDER_TESTS = new Map<CellOperator, (order: number) => boolean>([
  ["gt", (order) => order > 0],
  ["gte", (order) => order >= 0],
  ["lt", (order) => order < 0],
  ["lte", (order) => order <= 0],
  ["eq", (order) => order === 0],
  ["neq", (order) => order !== 0],
]);

function matchesCellRule(rule: Extract<ConditionalRule, { type: "cell" }>, value: Scalar): boolean {
  if (value === null) return false;
  const order = compareOperand(value, rule.value, operandNumber(rule.value));
  if (rule.op === "between" || rule.op === "notBetween") return matchesBetween(rule, value, order);
  return ORDER_TESTS.get(rule.op)?.(order) ?? false;
}

/** Between is inclusive at both ends; the order against the lower bound is already known. */
function matchesBetween(rule: Extract<ConditionalRule, { type: "cell" }>, value: Scalar, order: number): boolean {
  const upper = rule.value2 !== undefined ? operandNumber(rule.value2) : null;
  const inside = order >= 0 && compareOperand(value, rule.value2 ?? "", upper) <= 0;
  return rule.op === "between" ? inside : !inside;
}

function matchesTextRule(rule: Extract<ConditionalRule, { type: "text" }>, value: Scalar): boolean {
  if (value === null || isError(value)) return false;
  const text = String(value).toLowerCase();
  const needle = rule.text.toLowerCase();
  switch (rule.op) {
    case "contains": return text.includes(needle);
    case "notContains": return !text.includes(needle);
    case "begins": return text.startsWith(needle);
    case "ends": return text.endsWith(needle);
  }
}

function scaleColor(rule: Extract<ConditionalRule, { type: "scale" }>, value: number, min: number, max: number): string {
  if (max === min) return rule.mid ?? rule.max;
  const t = (value - min) / (max - min);
  if (rule.mid) return t < 0.5 ? mixColors(rule.min, rule.mid, t * 2) : mixColors(rule.mid, rule.max, (t - 0.5) * 2);
  return mixColors(rule.min, rule.max, t);
}

/** Cells of a rule's range that hold values (bounded to the used range). */
function ruleCells(range: CellRange, used: CellRange | null, valueAt: (row: number, col: number) => Scalar) {
  const cells: { row: number; col: number; value: Scalar }[] = [];
  if (!used) return cells;
  const bounded = { r1: range.r1, c1: range.c1, r2: Math.min(range.r2, used.r2), c2: Math.min(range.c2, used.c2) };
  if (bounded.r2 < bounded.r1 || bounded.c2 < bounded.c1) return cells;
  forEachCellInRange(bounded, (row, col) => cells.push({ row, col, value: valueAt(row, col) }));
  return cells;
}

function evaluateRuleFormula(rule: Extract<ConditionalRule, { type: "formula" }>, engine: WorkbookEngine, sheet: Sheet, origin: CellRange, row: number, col: number): boolean {
  // Relative references in a rule formula are written for the range's
  // top-left cell, as in Excel, and shift for every other cell.
  const parsed = parseFormula(shiftFormula(rule.formula, row - origin.r1, col - origin.c1));
  if (!parsed.ok) return false;
  const host: EvalHost = {
    cell: (name, r, c) => engine.cell(name ?? sheet.name, r, c),
    range: (ref) => engine.range({ ...ref, sheet: ref.sheet ?? sheet.name }),
    resolveName: (name) => engine.resolveName(name),
    resolveTable: (table, spec, here) => engine.resolveTable(table, spec, here),
    current: { sheet: sheet.name, row, col },
    now: engine.now,
    random: () => Math.random(),
  };
  const result = evaluateFormula(parsed.ast, host, SHEET_FUNCTIONS);
  const scalar = isMatrix(result) ? result[0]?.[0] ?? null : result;
  const truth = toBoolean(scalar);
  return truth === true;
}

type RuleCell = { row: number; col: number; value: Scalar };
type NumericCell = { row: number; col: number; value: number };

/** What every rule type works from: its range, the valued cells in it, and the numeric ones. */
type RuleScope = {
  sheet: Sheet;
  engine: WorkbookEngine;
  out: Map<number, CellDecoration>;
  range: CellRange;
  used: CellRange | null;
  cells: RuleCell[];
  numeric: NumericCell[];
  numbers: number[];
};

type RuleOf<K extends ConditionalRuleType> = ConditionalRule & { type: K };
type RuleDecorators = { [K in ConditionalRuleType]: (rule: RuleOf<K>, scope: RuleScope) => void };

function decorateRule(rule: ConditionalRule, sheet: Sheet, engine: WorkbookEngine, out: Map<number, CellDecoration>): void {
  const range = parseRangeRef(rule.ref);
  if (!range) return;
  const used = engine.usedRange(sheet.id);
  const cells = ruleCells(range, used, (row, col) => engine.value(sheet.id, row, col));
  const numeric = cells.flatMap((cell) => numericCell(cell));
  runDecorator(rule.type, rule, { sheet, engine, out, range, used, cells, numeric, numbers: numeric.map((cell) => cell.value) });
}

function numericCell(cell: RuleCell): NumericCell[] {
  const value = numericValue(cell.value);
  return value === null ? [] : [{ row: cell.row, col: cell.col, value }];
}

function runDecorator<K extends ConditionalRuleType>(type: K, rule: RuleOf<K>, scope: RuleScope): void {
  if (Object.hasOwn(RULE_DECORATORS, type)) RULE_DECORATORS[type](rule, scope);
}

/** Paints the rule's style on each cell that passes the test. */
function paintWhere<C extends RuleCell | NumericCell>(scope: RuleScope, cells: C[], style: ConditionalStyle, test: (cell: C) => boolean): void {
  for (const cell of cells) if (test(cell)) paint(scope.out, cell.row, cell.col, styleDecoration(style));
}

function decorateScale(rule: RuleOf<"scale">, scope: RuleScope): void {
  if (!scope.numbers.length) return;
  const min = Math.min(...scope.numbers);
  const max = Math.max(...scope.numbers);
  for (const cell of scope.numeric) paint(scope.out, cell.row, cell.col, { fill: scaleColor(rule, cell.value, min, max) });
}

function decorateBar(rule: RuleOf<"bar">, scope: RuleScope): void {
  if (!scope.numbers.length) return;
  const max = Math.max(...scope.numbers.map(Math.abs)) || 1;
  for (const cell of scope.numeric) {
    paint(scope.out, cell.row, cell.col, { bar: { fraction: Math.max(0, Math.min(1, Math.abs(cell.value) / max)), color: rule.color } });
  }
}

function decorateCellRule(rule: RuleOf<"cell">, scope: RuleScope): void {
  paintWhere(scope, scope.cells, rule.style, (cell) => matchesCellRule(rule, cell.value));
}

function decorateTextRule(rule: RuleOf<"text">, scope: RuleScope): void {
  paintWhere(scope, scope.cells, rule.style, (cell) => matchesTextRule(rule, cell.value));
}

/** Top/bottom N (or N percent) values, ties at the threshold included. */
function decorateRank(rule: RuleOf<"top" | "bottom">, scope: RuleScope): void {
  const top = rule.type === "top";
  const sorted = scope.numbers.slice().sort((a, b) => (top ? b - a : a - b));
  const count = rule.percent ? Math.max(1, Math.floor((sorted.length * rule.count) / 100)) : rule.count;
  const threshold = sorted[Math.min(count, sorted.length) - 1];
  if (threshold === undefined) return;
  paintWhere(scope, scope.numeric, rule.style, (cell) => (top ? cell.value >= threshold : cell.value <= threshold));
}

/** Text compares case-insensitively; other values by their text form. */
function valueKey(value: Scalar): string {
  return typeof value === "string" ? value.toLowerCase() : String(value);
}

function decorateRepeats(rule: RuleOf<"duplicate" | "unique">, scope: RuleScope): void {
  const filled = scope.cells.filter((cell) => !isBlankValue(cell.value));
  const counts = new Map<string, number>();
  for (const cell of filled) counts.set(valueKey(cell.value), (counts.get(valueKey(cell.value)) ?? 0) + 1);
  paintWhere(scope, filled, rule.style, (cell) => {
    const count = counts.get(valueKey(cell.value)) ?? 0;
    return rule.type === "duplicate" ? count > 1 : count === 1;
  });
}

function decorateAverage(rule: RuleOf<"above" | "below">, scope: RuleScope): void {
  if (!scope.numbers.length) return;
  const mean = scope.numbers.reduce((total, item) => total + item, 0) / scope.numbers.length;
  paintWhere(scope, scope.numeric, rule.style, (cell) => (rule.type === "above" ? cell.value > mean : cell.value < mean));
}

/** Blank tests cover empty cells too, so they walk the range (bounded to the used area). */
function decorateBlanks(rule: RuleOf<"blank" | "notBlank">, scope: RuleScope): void {
  const { range, used } = scope;
  const bounded = used ? { ...range, r2: Math.min(range.r2, used.r2), c2: Math.min(range.c2, used.c2) } : range;
  forEachCellInRange(bounded, (row, col) => {
    const blank = isBlankValue(scope.engine.value(scope.sheet.id, row, col));
    if (rule.type === "blank" ? blank : !blank) paint(scope.out, row, col, styleDecoration(rule.style));
  });
}

function decorateFormula(rule: RuleOf<"formula">, scope: RuleScope): void {
  paintWhere(scope, scope.cells, rule.style, (cell) => evaluateRuleFormula(rule, scope.engine, scope.sheet, scope.range, cell.row, cell.col));
}

const RULE_DECORATORS: RuleDecorators = {
  scale: decorateScale,
  bar: decorateBar,
  cell: decorateCellRule,
  text: decorateTextRule,
  top: decorateRank,
  bottom: decorateRank,
  duplicate: decorateRepeats,
  unique: decorateRepeats,
  above: decorateAverage,
  below: decorateAverage,
  blank: decorateBlanks,
  notBlank: decorateBlanks,
  formula: decorateFormula,
};

export function computeDecorations(sheet: Sheet, engine: WorkbookEngine, filter: FilterResult | null, dark = false): Map<number, CellDecoration> {
  const out = new Map<number, CellDecoration>();
  decorateTables(sheet, out, dark);
  decoratePivots(sheet, engine, out, dark);
  // Later rules win, matching the order they are listed in the rules panel.
  for (const rule of sheet.conditional ?? []) decorateRule(rule, sheet, engine, out);
  if (filter) {
    for (let col = filter.range.c1; col <= filter.range.c2; col += 1) paint(out, filter.range.r1, col, { filterButton: { active: filter.activeColumns.has(col) } });
  }
  return out;
}

export function decorationAt(map: Map<number, CellDecoration>, row: number, col: number): CellDecoration | undefined {
  return map.get(cellId(row, col));
}

/* ------------------------------------------------------------------ autofilter */

export type FilterResult = { range: CellRange; hiddenRows: Set<number>; activeColumns: Set<number> };

export function filterValueLabel(value: Scalar): string {
  if (value === null || value === "") return "(Blanks)";
  if (isError(value)) return value.code;
  return String(value);
}

/** Rows a sheet filter hides, from its criteria and the computed values. */
export function computeFilter(filter: SheetFilter | undefined, sheetId: string, engine: WorkbookEngine): FilterResult | null {
  if (!filter) return null;
  const range = parseRangeRef(filter.ref);
  if (!range) return null;
  const used = engine.usedRange(sheetId);
  const lastRow = Math.min(range.r2, used?.r2 ?? range.r1);
  const hiddenRows = new Set<number>();
  const checks = filterChecks(filter, range);
  if (checks.length) {
    for (let row = range.r1 + 1; row <= lastRow; row += 1) {
      if (checks.some((check) => !check.test(engine.value(sheetId, row, check.col)))) hiddenRows.add(row);
    }
  }
  return { range: { ...range, r2: Math.max(lastRow, range.r1) }, hiddenRows, activeColumns: new Set(checks.map((check) => check.col)) };
}

type FilterCheck = { col: number; test: (value: Scalar) => boolean };

/** One check per criteria column inside the filter range. */
function filterChecks(filter: SheetFilter, range: CellRange): FilterCheck[] {
  const checks: FilterCheck[] = [];
  for (const [letter, criteria] of Object.entries(filter.criteria)) {
    const col = columnIndex(letter);
    if (col >= range.c1 && col <= range.c2) checks.push({ col, test: criteriaTest(criteria) });
  }
  return checks;
}

/** A value passes when it is one of the allowed values (if listed) and meets the condition (if set). */
function criteriaTest(criteria: SheetFilterCriteria): (value: Scalar) => boolean {
  const allowed = criteria.values ? new Set(criteria.values.map((item) => item.toLowerCase())) : null;
  const condition = criteria.condition;
  return (value) => {
    if (allowed && !allowed.has(filterValueLabel(value).toLowerCase())) return false;
    return condition ? matchesCondition(condition, value) : true;
  };
}

const TEXT_CONDITIONS: readonly string[] = TEXT_OPERATORS;

function matchesCondition(condition: NonNullable<SheetFilterCriteria["condition"]>, value: Scalar): boolean {
  if (TEXT_CONDITIONS.includes(condition.op)) {
    return matchesTextRule({ id: "f", ref: "A1", type: "text", op: condition.op as "contains", text: condition.value, style: {} }, value);
  }
  return matchesCellRule({ id: "f", ref: "A1", type: "cell", op: condition.op as "gt", value: condition.value, value2: condition.value2, style: {} }, value);
}

/** Distinct values of a filter column for the filter menu, with counts. */
export function filterColumnValues(range: CellRange, col: number, sheetId: string, engine: WorkbookEngine): { label: string; count: number }[] {
  const counts = new Map<string, { label: string; count: number; sample: Scalar }>();
  const used = engine.usedRange(sheetId);
  const last = Math.min(range.r2, used?.r2 ?? range.r1);
  for (let row = range.r1 + 1; row <= last; row += 1) {
    const value = engine.value(sheetId, row, col);
    const label = filterValueLabel(value);
    const key = label.toLowerCase();
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { label, count: 1, sample: value });
  }
  return Array.from(counts.values())
    .sort((a, b) => (a.label === "(Blanks)" ? 1 : b.label === "(Blanks)" ? -1 : compareScalars(a.sample, b.sample)))
    .map(({ label, count }) => ({ label, count }));
}

/** The contiguous data region around a cell (Excel's Ctrl+A / current region). */
export function currentRegion(sheetId: string, engine: WorkbookEngine, row: number, col: number): CellRange {
  const filled = (r: number, c: number) => r >= 0 && c >= 0 && !isBlankValue(engine.value(sheetId, r, c));
  let range: CellRange = { r1: row, c1: col, r2: row, c2: col };
  for (let guard = 0; guard < 200; guard += 1) {
    const next = grownRegion(range, filled);
    if (sameRange(next, range)) break;
    range = { r1: Math.max(0, next.r1), c1: Math.max(0, next.c1), r2: next.r2, c2: next.c2 };
  }
  return range;
}

/** The range pushed out one row or column on each side that touches a filled cell (diagonals included). */
function grownRegion(range: CellRange, filled: (row: number, col: number) => boolean): CellRange {
  const next = { ...range };
  for (let c = Math.max(0, range.c1 - 1); c <= range.c2 + 1; c += 1) {
    if (filled(range.r1 - 1, c)) next.r1 = range.r1 - 1;
    if (filled(range.r2 + 1, c)) next.r2 = range.r2 + 1;
  }
  for (let r = Math.max(0, range.r1 - 1); r <= range.r2 + 1; r += 1) {
    if (filled(r, range.c1 - 1)) next.c1 = range.c1 - 1;
    if (filled(r, range.c2 + 1)) next.c2 = range.c2 + 1;
  }
  return next;
}

function sameRange(a: CellRange, b: CellRange): boolean {
  return a.r1 === b.r1 && a.r2 === b.r2 && a.c1 === b.c1 && a.c2 === b.c2;
}

export function rangeHasHeader(range: CellRange, sheetId: string, engine: WorkbookEngine): boolean {
  if (range.r2 <= range.r1) return false;
  let textHeaders = 0;
  let numericBelow = 0;
  for (let col = range.c1; col <= range.c2; col += 1) {
    const head = engine.value(sheetId, range.r1, col);
    const below = engine.value(sheetId, range.r1 + 1, col);
    if (typeof head === "string" && head.trim()) textHeaders += 1;
    if (typeof below === "number") numericBelow += 1;
  }
  const width = range.c2 - range.c1 + 1;
  return textHeaders === width || (textHeaders > 0 && numericBelow > 0);
}

export function columnHeaderLabel(range: CellRange, col: number, sheetId: string, engine: WorkbookEngine, hasHeader: boolean): string {
  if (hasHeader) {
    const value = engine.value(sheetId, range.r1, col);
    if (value !== null && value !== "" && !isError(value)) return String(value);
  }
  return `Column ${columnLabel(col)}`;
}

export function inRange(range: CellRange | null, row: number, col: number): boolean {
  return Boolean(range && rangeContains(range, row, col));
}
