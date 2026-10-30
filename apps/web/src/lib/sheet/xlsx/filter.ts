/** The sheet-level filter as an `<autoFilter>`. Excel does not re-run a
 * filter when it opens a file; it trusts the hidden flags on the rows, so the
 * rows this filter hides are worked out here, with Excel's matching rules,
 * and hidden in sheetData. */

import { columnIndex, parseRangeRef, type CellRange } from "../address";
import type { Scalar } from "../formula/values";
import { formatCellValue } from "../numberFormat";
import type { CellOperator, SheetFilter, SheetFilterCriteria, TextOperator } from "../sheetModel";
import { effectiveStyle } from "../sheetOps";
import { overlapsAny, rangeText, type ExportContext, type SheetPlan } from "./context";
import { attrs } from "./xml";

export type FilterPlan = { range: CellRange; xml: string; hiddenRows: Set<number> };

type Condition = { op: CellOperator | TextOperator; value: string; value2?: string };

/** One column's filter: its XML body and whether a cell (value and shown text) passes. */
type Criterion = { body: string; passes: (value: Scalar, shown: string) => boolean };

type Comparison = { operator: string; holds: (order: number) => boolean };

/** Single comparisons; between and notBetween are pairs of them (RANGES). */
const COMPARISONS: Partial<Record<CellOperator, Comparison>> = {
  gt: { operator: "greaterThan", holds: (order) => order > 0 },
  gte: { operator: "greaterThanOrEqual", holds: (order) => order >= 0 },
  lt: { operator: "lessThan", holds: (order) => order < 0 },
  lte: { operator: "lessThanOrEqual", holds: (order) => order <= 0 },
  eq: { operator: "equal", holds: (order) => order === 0 },
  neq: { operator: "notEqual", holds: (order) => order !== 0 },
};

type Range = { both: boolean; low: Comparison; high: Comparison };

/** Excel writes between as two inclusive bounds that must both hold, and
 * notBetween as two exclusive ones either of which may. */
const RANGES: Partial<Record<CellOperator, Range>> = {
  between: { both: true, low: COMPARISONS.gte as Comparison, high: COMPARISONS.lte as Comparison },
  notBetween: { both: false, low: COMPARISONS.lt as Comparison, high: COMPARISONS.gt as Comparison },
};

type TextMatch = { operator: string; pattern: (text: string) => string; holds: (shown: string, needle: string) => boolean };

const TEXT_MATCHES: Record<TextOperator, TextMatch> = {
  contains: { operator: "equal", pattern: (text) => `*${text}*`, holds: (shown, needle) => shown.includes(needle) },
  notContains: { operator: "notEqual", pattern: (text) => `*${text}*`, holds: (shown, needle) => !shown.includes(needle) },
  begins: { operator: "equal", pattern: (text) => `${text}*`, holds: (shown, needle) => shown.startsWith(needle) },
  ends: { operator: "equal", pattern: (text) => `*${text}`, holds: (shown, needle) => shown.endsWith(needle) },
};

const escapeWildcards = (text: string) => text.replace(/[*?~]/g, "~$&");

function customFilterXml(operator: string, val: string): string {
  return `<customFilters><customFilter${attrs({ operator, val })}/></customFilters>`;
}

/** Excel compares a numeric operand with numbers only (text passes only "not
 * equal"); a text operand compares with the shown text, ignoring case. */
function compares(comparison: Comparison, operand: string, value: Scalar, shown: string): boolean {
  const number = Number(operand);
  if (operand.trim() !== "" && Number.isFinite(number)) {
    return typeof value === "number" ? comparison.holds(Math.sign(value - number)) : comparison.operator === "notEqual";
  }
  return comparison.holds(shown.toLowerCase().localeCompare(operand.toLowerCase()));
}

function rangeCriterion(condition: Condition): Criterion | null {
  const range = RANGES[condition.op as CellOperator];
  const { value: lower, value2: upper } = condition;
  if (!range || upper === undefined) return null;
  const filters = [[range.low, lower], [range.high, upper]] as const;
  const body = `<customFilters${attrs({ and: range.both })}>${filters.map(([comparison, val]) => `<customFilter${attrs({ operator: comparison.operator, val })}/>`).join("")}</customFilters>`;
  return {
    body,
    passes: (value, shown) => {
      const holds = filters.map(([comparison, val]) => compares(comparison, val, value, shown));
      return range.both ? holds.every(Boolean) : holds.some(Boolean);
    },
  };
}

function conditionCriterion(condition: Condition): Criterion | null {
  const text = TEXT_MATCHES[condition.op as TextOperator];
  if (text) {
    const needle = condition.value.toLowerCase();
    return { body: customFilterXml(text.operator, text.pattern(escapeWildcards(condition.value))), passes: (_, shown) => text.holds(shown.toLowerCase(), needle) };
  }
  const comparison = COMPARISONS[condition.op as CellOperator];
  if (!comparison) return rangeCriterion(condition);
  return { body: customFilterXml(comparison.operator, condition.value), passes: (value, shown) => compares(comparison, condition.value, value, shown) };
}

function valuesCriterion(values: string[]): Criterion {
  const allowed = new Set(values.map((value) => value.toLowerCase()));
  const blank = values.includes("") ? ` blank="1"` : "";
  const body = `<filters${blank}>${values.filter(Boolean).map((value) => `<filter${attrs({ val: value })}/>`).join("")}</filters>`;
  return { body, passes: (_, shown) => allowed.has(shown.toLowerCase()) };
}

/** A value list wins over a condition: one filterColumn holds one filter. */
function criterionFor(criteria: SheetFilterCriteria): Criterion | null {
  if (criteria.values) return valuesCriterion(criteria.values);
  return criteria.condition ? conditionCriterion(criteria.condition) : null;
}

type ColumnTest = Criterion & { col: number; xml: string };

function columnTests(ctx: ExportContext, sheetName: string, filter: SheetFilter, range: CellRange): ColumnTest[] {
  const tests: ColumnTest[] = [];
  for (const [letter, criteria] of Object.entries(filter.criteria)) {
    const col = columnIndex(letter);
    if (col < range.c1 || col > range.c2) continue;
    const criterion = criterionFor(criteria);
    if (criterion) tests.push({ ...criterion, col, xml: `<filterColumn colId="${col - range.c1}">${criterion.body}</filterColumn>` });
    else ctx.log.add(`The filter on column ${letter} of ${sheetName} could not be exported.`);
  }
  return tests.sort((a, b) => a.col - b.col);
}

function rowPasses(ctx: ExportContext, plan: SheetPlan, row: number, test: ColumnTest): boolean {
  const value = ctx.engine.value(plan.sheet.id, row, test.col);
  const shown = value === null ? "" : formatCellValue(value, effectiveStyle(plan.sheet, row, test.col)?.format).text;
  return test.passes(value, shown);
}

function sortStateXml(filter: SheetFilter, range: CellRange): string {
  const { sort } = filter;
  if (!sort) return "";
  const col = columnIndex(sort.col);
  if (col < range.c1 || col > range.c2 || range.r2 <= range.r1) return "";
  const data = { ...range, r1: range.r1 + 1 };
  return `<sortState ref="${rangeText(data)}"><sortCondition${attrs({ descending: sort.desc, ref: rangeText({ ...data, c1: col, c2: col }) })}/></sortState>`;
}

export function planFilter(ctx: ExportContext, plan: SheetPlan): FilterPlan | null {
  const { filter } = plan.sheet;
  if (!filter) return null;
  const range = parseRangeRef(filter.ref);
  if (!range) return null;
  if (overlapsAny(range, plan.tables)) {
    ctx.log.add(`The filter on ${plan.sheet.name} overlaps a table, which has its own filter, so it was left out.`);
    return null;
  }
  const tests = columnTests(ctx, plan.sheet.name, filter, range);
  const hiddenRows = new Set<number>();
  for (let row = range.r1 + 1; row <= range.r2; row += 1) {
    if (!tests.every((test) => rowPasses(ctx, plan, row, test))) hiddenRows.add(row);
  }
  const xml = `<autoFilter ref="${rangeText(range)}">${tests.map((test) => test.xml).join("")}${sortStateXml(filter, range)}</autoFilter>`;
  return { range, xml, hiddenRows };
}
