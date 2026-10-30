/** Workbook data model for the Drafts spreadsheet editor.
 *
 * A workbook is stored as canonical (recursively key-sorted) JSON, the same
 * contract decks use, so identical workbooks always hash identically for CAS
 * sync. `parseWorkbook` is the single validation gate: AI replies, imports,
 * templates, and stored round-trips all pass through it before anything
 * renders, recalculates, or exports. The server mirrors it in
 * services/api/app/models/sheet_document.py; the shared fixture under
 * services/api/tests/fixtures/sheet-v1 pins the limits on both sides.
 *
 * Glossary: a workbook holds sheets; a sheet holds cells keyed by A1 address.
 * A cell stores what the author typed — a literal value (`v`) or a formula
 * (`f`, without the leading "="). Computed values are never stored; the
 * formula engine derives them on load. Spilled array results and pivot table
 * output are derived too, so they can never drift from their source.
 */

import {
  MAX_SHEET_COLS,
  MAX_SHEET_ROWS,
  cellKey,
  columnIndex,
  formatRangeRef,
  parseCellKey,
  parseRangeRef,
  quoteSheetName,
  splitSheetQualifiedRef,
} from "./address";

export const SHEET_SCHEMA_VERSION = "aperture-sheet-v1";
export const SHEET_SANITIZER_VERSION = "sheet-json-v1";
export const MAX_SHEET_CONTENT_BYTES = 8_000_000;
export const MAX_SHEETS = 40;
export const MAX_WORKBOOK_CELLS = 200_000;
export const MAX_CELL_TEXT_CHARS = 32_767;
export const MAX_FORMULA_CHARS = 8_192;
export const MAX_NOTE_CHARS = 2_000;
export const MAX_SHEET_NAME_CHARS = 31;
export const MAX_MERGES_PER_SHEET = 2_000;
export const MAX_OBJECTS_PER_SHEET = 50; // tables, charts, pivots each
export const MAX_RULES_PER_SHEET = 100; // conditional formats, validations each
export const MAX_DEFINED_NAMES = 200;
export const MAX_LIST_ITEMS = 500;
/** Stored length of a range that may name another sheet, quotes included. */
export const MAX_SOURCE_CHARS = 300;
export const MAX_COL_WIDTH = 2_000;
export const MAX_ROW_HEIGHT = 1_000;
export const DEFAULT_COL_WIDTH = 100;
export const DEFAULT_ROW_HEIGHT = 24;
export const MIN_COL_WIDTH = 24;
export const MIN_ROW_HEIGHT = 18;

export { MAX_SHEET_COLS, MAX_SHEET_ROWS };

export type CellLiteral = string | number | boolean;

export type BorderStyle = "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
export const BORDER_STYLES: readonly BorderStyle[] = ["thin", "medium", "thick", "dashed", "dotted", "double"];
export type CellBorder = { style: BorderStyle; color?: string };
export type CellBorders = { top?: CellBorder; right?: CellBorder; bottom?: CellBorder; left?: CellBorder };

export type HorizontalAlign = "left" | "center" | "right";
export type VerticalAlign = "top" | "middle" | "bottom";

export type CellStyle = {
  /** Explicit false matters: a cell can turn off bold that its column sets. */
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Single font-family name. Absent follows the workbook default. */
  font?: string;
  /** Points, 6..72. */
  size?: number;
  /** "#rrggbb" text color. */
  color?: string;
  /** "#rrggbb" background fill. */
  fill?: string;
  align?: HorizontalAlign;
  valign?: VerticalAlign;
  wrap?: boolean;
  /** Indent level 0..10 (Excel's units). */
  indent?: number;
  /** Excel number format code, e.g. "#,##0.00", "0%", "m/d/yyyy". */
  format?: string;
  border?: CellBorders;
};

export type SheetCell = {
  /** The literal the author entered; absent for formulas and empty cells. */
  v?: CellLiteral;
  /** Formula text without the leading "=". */
  f?: string;
  s?: CellStyle;
  /** Note (Excel comment) shown on hover. */
  n?: string;
};

export type SheetColumn = { w?: number; hidden?: boolean; s?: CellStyle };
export type SheetRow = { h?: number; hidden?: boolean; s?: CellStyle };

export const TABLE_TONES = ["light", "medium", "dark"] as const;
export type TableTone = (typeof TABLE_TONES)[number];

/** Accent slots 1..6 map to the workbook palette and to Excel's theme
 * accents in the exported file, so tables look the same in Excel. */
export type AccentSlot = 1 | 2 | 3 | 4 | 5 | 6;

export type SheetTable = {
  id: string;
  /** Excel table name: letter or "_" first, then letters, digits, "_" or ".". */
  name: string;
  /** Includes the header row (and the totals row when `totals` is on). */
  ref: string;
  accent: AccentSlot;
  tone: TableTone;
  banded: boolean;
  totals: boolean;
  /** Show filter buttons in the header row. */
  filterButtons: boolean;
  firstColumn?: boolean;
};

export const CHART_TYPES = ["column", "bar", "line", "area", "pie", "doughnut", "scatter"] as const;
export type SheetChartType = (typeof CHART_TYPES)[number];
export const CHART_LEGENDS = ["right", "bottom", "top", "none"] as const;
export type SheetChartLegend = (typeof CHART_LEGENDS)[number];

export type SheetChart = {
  id: string;
  type: SheetChartType;
  title?: string;
  /** Data range on this sheet: first row holds series names, first column
   * holds categories (or the reverse with seriesBy "rows"). */
  source: string;
  seriesBy: "columns" | "rows";
  stacked?: boolean;
  legend: SheetChartLegend;
  showValues?: boolean;
  xTitle?: string;
  yTitle?: string;
  /** Top-left anchor cell and pixel size on the grid. */
  at: string;
  w: number;
  h: number;
};

export const PIVOT_AGGREGATES = ["sum", "count", "average", "min", "max", "countDistinct"] as const;
export type PivotAggregate = (typeof PIVOT_AGGREGATES)[number];
export type PivotValueField = { field: string; agg: PivotAggregate; label?: string };
export type PivotFilter = { field: string; include: string[] };

export type SheetPivot = {
  id: string;
  name: string;
  /** Source range with field names in its first row; may name another sheet. */
  source: string;
  /** Output top-left cell on the sheet that holds the pivot. */
  at: string;
  rows: string[];
  columns: string[];
  values: PivotValueField[];
  filters: PivotFilter[];
  /** "Grand Total" row under the groups (on by default). */
  rowTotals: boolean;
  /** "Grand Total" column right of the column groups (on by default). */
  columnTotals: boolean;
};

export type ConditionalStyle = { fill?: string; color?: string; bold?: boolean };
export const CELL_OPERATORS = ["gt", "gte", "lt", "lte", "eq", "neq", "between", "notBetween"] as const;
export type CellOperator = (typeof CELL_OPERATORS)[number];
export const TEXT_OPERATORS = ["contains", "notContains", "begins", "ends"] as const;
export type TextOperator = (typeof TEXT_OPERATORS)[number];

export type ConditionalRule = { id: string; ref: string } & (
  | { type: "scale"; min: string; mid?: string; max: string }
  | { type: "bar"; color: string }
  | { type: "cell"; op: CellOperator; value: string; value2?: string; style: ConditionalStyle }
  | { type: "text"; op: TextOperator; text: string; style: ConditionalStyle }
  | { type: "top" | "bottom"; count: number; percent?: boolean; style: ConditionalStyle }
  | { type: "duplicate" | "unique" | "above" | "below" | "blank" | "notBlank"; style: ConditionalStyle }
  | { type: "formula"; formula: string; style: ConditionalStyle }
);
export type ConditionalRuleType = ConditionalRule["type"];

export const VALIDATION_KINDS = ["list", "whole", "decimal", "date", "textLength"] as const;
export type ValidationKind = (typeof VALIDATION_KINDS)[number];

export type SheetValidation = {
  id: string;
  ref: string;
  kind: ValidationKind;
  /** list: the allowed items (or `source`, a range holding them). */
  items?: string[];
  source?: string;
  /** whole/decimal/date/textLength. */
  op?: CellOperator;
  value?: string;
  value2?: string;
  /** Reject entries that break the rule instead of only flagging them. */
  strict: boolean;
  message?: string;
};

/** `value2` is the upper bound of between and notBetween, and only of those. */
export type SheetFilterCriteria = { values?: string[]; condition?: { op: CellOperator | TextOperator; value: string; value2?: string } };

export type SheetFilter = {
  ref: string;
  /** Keyed by absolute column letter. */
  criteria: Record<string, SheetFilterCriteria>;
  sort?: { col: string; desc: boolean };
};

export type Sheet = {
  id: string;
  name: string;
  /** "#rrggbb" tab color. */
  color?: string;
  hidden?: boolean;
  cells: Record<string, SheetCell>;
  /** Keyed by column letter ("A"). */
  cols?: Record<string, SheetColumn>;
  /** Keyed by 1-based row number ("1"). */
  rows?: Record<string, SheetRow>;
  merges?: string[];
  freeze?: { rows: number; cols: number };
  /** Gridlines show unless this is false. */
  gridlines?: boolean;
  filter?: SheetFilter;
  tables?: SheetTable[];
  charts?: SheetChart[];
  pivots?: SheetPivot[];
  conditional?: ConditionalRule[];
  validations?: SheetValidation[];
};

export type DefinedName = { name: string; ref: string };

export type Workbook = {
  schema: typeof SHEET_SCHEMA_VERSION;
  sheets: Sheet[];
  names?: DefinedName[];
};

/* ------------------------------------------------------------------ helpers */

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const OBJECT_ID = /^[\w-]{1,60}$/;
const FONT_NAME = /^[a-z0-9][a-z0-9 \-]{0,58}$/i;
const TABLE_NAME = /^[A-Za-z_\\][A-Za-z0-9_.]{0,254}$/;
const DEFINED_NAME = /^[A-Za-z_\\][A-Za-z0-9_.]{0,254}$/;
const SHEET_NAME_FORBIDDEN = /[:\\/?*[\]]/;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** Excel sheet-name rules, plus uniqueness checked by the caller. */
export function sheetNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the sheet a name.";
  if (trimmed.length > MAX_SHEET_NAME_CHARS) return `Sheet names can be at most ${MAX_SHEET_NAME_CHARS} characters.`;
  if (SHEET_NAME_FORBIDDEN.test(trimmed)) return "Sheet names cannot contain : \\ / ? * [ or ].";
  if (trimmed.startsWith("'") || trimmed.endsWith("'")) return "Sheet names cannot start or end with an apostrophe.";
  if (trimmed.toLowerCase() === "history") return "\"History\" is reserved by Excel.";
  return null;
}

/** Excel rejects names that read as cell addresses ("A1", "R1C1"). */
export function tableNameProblem(name: string): string | null {
  if (!TABLE_NAME.test(name)) return "Use letters, digits, underscores, or periods, starting with a letter.";
  if (parseCellKey(name) || /^R[0-9]*C[0-9]*$/i.test(name) || /^[RC]$/i.test(name)) {
    return "That name reads as a cell address.";
  }
  return null;
}

export function uniqueSheetName(base: string, sheets: Pick<Sheet, "name">[]): string {
  const taken = new Set(sheets.map((sheet) => sheet.name.toLowerCase()));
  const stem = base.trim().replace(SHEET_NAME_FORBIDDEN, " ").replace(/^'+|'+$/g, "").slice(0, MAX_SHEET_NAME_CHARS) || "Sheet";
  if (!taken.has(stem.toLowerCase())) return stem;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${stem.slice(0, MAX_SHEET_NAME_CHARS - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem.slice(0, 20)} ${Date.now() % 100000}`;
}

export function nextObjectId(prefix: string, existing: Iterable<{ id: string }>): string {
  const ids = new Set(Array.from(existing, (item) => item.id));
  for (let n = 1; n < 100_000; n += 1) {
    const candidate = `${prefix}-${n}`;
    if (!ids.has(candidate)) return candidate;
  }
  return `${prefix}-${Date.now()}`;
}

export function createWorksheet(name: string, id: string): Sheet {
  return { id, name, cells: {} };
}

export function blankWorkbook(): Workbook {
  return { schema: SHEET_SCHEMA_VERSION, sheets: [createWorksheet("Sheet1", "sheet-1")] };
}

export function sheetById(workbook: Workbook, id: string): Sheet | undefined {
  return workbook.sheets.find((sheet) => sheet.id === id);
}

export function sheetByName(workbook: Workbook, name: string): Sheet | undefined {
  const wanted = name.toLowerCase();
  return workbook.sheets.find((sheet) => sheet.name.toLowerCase() === wanted);
}

export function workbookCellCount(workbook: Workbook): number {
  return workbook.sheets.reduce((total, sheet) => total + Object.keys(sheet.cells).length, 0);
}

/** Canonical serialization: keys sorted at every depth, undefined dropped. */
export function serializeWorkbook(workbook: Workbook): string {
  return JSON.stringify(sortKeys(workbook));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortKeys(item);
    }
    return out;
  }
  return value;
}

export function contentLooksLikeWorkbook(content: string): boolean {
  return content.trimStart().startsWith("{") && content.includes(`"${SHEET_SCHEMA_VERSION}"`);
}

/* ------------------------------------------------------------------ parsing */

export type ParseWorkbookResult =
  | { ok: true; workbook: Workbook; warnings: string[] }
  | { ok: false; error: string };

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\u0000/g, "");
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function color(value: unknown): string | undefined {
  return isHexColor(value) ? value.toLowerCase() : undefined;
}

/** Trimmed text, or undefined when nothing is left. */
function trimmedText(value: unknown, max: number): string | undefined {
  return text(value, max)?.trim() || undefined;
}

function trueOrUndefined(value: unknown): true | undefined {
  return value === true ? true : undefined;
}

function objectId(value: unknown): string | undefined {
  return typeof value === "string" && OBJECT_ID.test(value) ? value : undefined;
}

/** Parsed items of an array (none for anything else), dropping the ones `parse` rejects. */
function parsedItems<T>(value: unknown, parse: (item: unknown) => T | undefined, max: number): T[] {
  return (Array.isArray(value) ? value : []).map((item: unknown) => parse(item)).filter((item): item is T => item !== undefined).slice(0, max);
}

function compact<T extends Bag>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
}

/** A1 range text on one sheet ("A1:C5"); returns its normalized form. */
function localRange(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const range = parseRangeRef(value);
  return range ? formatRangeRef(range) : undefined;
}

/** Range text that may name another sheet ("'Q1 Data'!A1:F90"). The length
 * limit applies to the stored form, so quoting cannot push it over next time. */
function qualifiedRange(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const { sheet, ref } = splitSheetQualifiedRef(value);
  const range = localRange(ref);
  if (!range || (sheet !== null && sheetNameProblem(sheet))) return undefined;
  const source = sheet === null ? range : `${quoteSheetName(sheet)}!${range}`;
  return source.length <= MAX_SOURCE_CHARS ? source : undefined;
}

/** A single cell in its canonical spelling ("$h$02 " -> "H2"). */
function localCell(value: unknown): string | undefined {
  const point = typeof value === "string" ? parseCellKey(value) : null;
  return point ? cellKey(point.row, point.col) : undefined;
}

/** Formula text without the "=" signs and spaces that lead it, bounded and
 * trimmed so it reads back the same ("  ==A1" -> "A1"; "==" -> none). */
function formulaText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/^[=\s]+/, "").slice(0, max).trimEnd() : "";
}

function parseBorder(value: unknown): CellBorder | undefined {
  if (!isBag(value)) return undefined;
  const style = oneOf(value.style, BORDER_STYLES);
  if (!style) return undefined;
  return compact({ style, color: color(value.color) }) as CellBorder;
}

function parseBorders(value: unknown): CellBorders | undefined {
  if (!isBag(value)) return undefined;
  return compact({ top: parseBorder(value.top), right: parseBorder(value.right), bottom: parseBorder(value.bottom), left: parseBorder(value.left) });
}

function fontName(value: unknown): string | undefined {
  return typeof value === "string" && FONT_NAME.test(value) ? value : undefined;
}

/** An Excel number format code, judged after NUL removal; "General" is the default and is not stored. */
function formatCode(value: unknown): string | undefined {
  const code = typeof value === "string" ? value.replace(/\u0000/g, "") : "";
  return code.length <= 255 && code !== "General" ? code : undefined;
}

export function parseCellStyle(value: unknown): CellStyle | undefined {
  if (!isBag(value)) return undefined;
  return compact({
    bold: bool(value.bold),
    italic: bool(value.italic),
    underline: bool(value.underline),
    strike: bool(value.strike),
    font: fontName(value.font),
    size: clampInt(value.size, 6, 72),
    color: color(value.color),
    fill: color(value.fill),
    align: oneOf(value.align, ["left", "center", "right"] as const),
    valign: oneOf(value.valign, ["top", "middle", "bottom"] as const),
    wrap: bool(value.wrap),
    indent: clampInt(value.indent, 0, 10) || undefined,
    format: formatCode(value.format) || undefined,
    border: parseBorders(value.border),
  } satisfies CellStyle);
}

function parseCell(value: unknown): SheetCell | undefined {
  if (!isBag(value)) return undefined;
  const formula = formulaText(value.f, MAX_FORMULA_CHARS);
  const literal = formula ? undefined : cellLiteral(value.v);
  return compact({ v: literal, f: formula || undefined, s: parseCellStyle(value.s), n: trimmedText(value.n, MAX_NOTE_CHARS) } satisfies SheetCell);
}

/** A typed value; a formula cell keeps none, and text empty after NUL removal is dropped. */
function cellLiteral(value: unknown): CellLiteral | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value + 0 : undefined; // + 0 turns -0 into 0
  if (typeof value === "boolean") return value;
  return text(value, MAX_CELL_TEXT_CHARS) || undefined;
}

function parseTable(value: unknown, taken: Set<string>): SheetTable | undefined {
  if (!isBag(value)) return undefined;
  const ref = localRange(value.ref);
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!ref || !tableNameFree(name, taken)) return undefined;
  const range = parseRangeRef(ref)!;
  if (range.r2 - range.r1 < 1) return undefined; // a table needs a header row and a data row
  taken.add(name.toLowerCase());
  return { id: objectId(value.id) ?? name, name, ref, ...tableStyle(value) };
}

function tableNameFree(name: string, taken: Set<string>): boolean {
  return Boolean(name) && !tableNameProblem(name) && !taken.has(name.toLowerCase());
}

function tableStyle(value: Bag): Omit<SheetTable, "id" | "name" | "ref"> {
  return {
    accent: (clampInt(value.accent, 1, 6) as AccentSlot | undefined) ?? 1,
    tone: oneOf(value.tone, TABLE_TONES) ?? "medium",
    banded: bool(value.banded) ?? true,
    totals: bool(value.totals) ?? false,
    filterButtons: bool(value.filterButtons) ?? true,
    ...(value.firstColumn === true ? { firstColumn: true } : {}),
  };
}

function parseChart(value: unknown): SheetChart | undefined {
  if (!isBag(value)) return undefined;
  const placed = chartPlacement(value);
  if (!placed) return undefined;
  return compact({
    id: placed.id,
    type: placed.type,
    title: trimmedText(value.title, 200),
    source: placed.source,
    seriesBy: value.seriesBy === "rows" ? "rows" : "columns",
    stacked: trueOrUndefined(value.stacked),
    legend: oneOf(value.legend, CHART_LEGENDS) ?? "bottom",
    showValues: trueOrUndefined(value.showValues),
    xTitle: trimmedText(value.xTitle, 120),
    yTitle: trimmedText(value.yTitle, 120),
    at: placed.at,
    w: clampInt(value.w, 200, 1600) ?? 480,
    h: clampInt(value.h, 140, 1200) ?? 300,
  }) as SheetChart;
}

/** The fields a chart cannot do without. */
function chartPlacement(value: Bag): Pick<SheetChart, "id" | "type" | "source" | "at"> | undefined {
  const type = oneOf(value.type, CHART_TYPES);
  const source = qualifiedRange(value.source);
  const at = localCell(value.at);
  const id = objectId(value.id);
  return type && source && at && id ? { id, type, source, at } : undefined;
}

function fieldName(value: unknown): string | undefined {
  return trimmedText(value, 255);
}

function parsePivot(value: unknown): SheetPivot | undefined {
  if (!isBag(value)) return undefined;
  const source = qualifiedRange(value.source);
  const at = localCell(value.at);
  const id = objectId(value.id);
  if (!source || !at || !id) return undefined;
  return {
    id,
    name: trimmedText(value.name, 255) ?? "PivotTable",
    source,
    at,
    rows: parsedItems(value.rows, fieldName, 8),
    columns: parsedItems(value.columns, fieldName, 8),
    values: parsedItems(value.values, parsePivotValue, 8),
    filters: parsedItems(value.filters, parsePivotFilter, 8),
    rowTotals: bool(value.rowTotals) ?? true,
    columnTotals: bool(value.columnTotals) ?? true,
  };
}

function parsePivotValue(value: unknown): PivotValueField | undefined {
  if (!isBag(value)) return undefined;
  const field = fieldName(value.field);
  if (!field) return undefined;
  return compact({ field, agg: oneOf(value.agg, PIVOT_AGGREGATES) ?? "sum", label: trimmedText(value.label, 255) }) as PivotValueField;
}

function parsePivotFilter(value: unknown): PivotFilter | undefined {
  if (!isBag(value)) return undefined;
  const field = fieldName(value.field);
  if (!field || !Array.isArray(value.include)) return undefined;
  const include = value.include.map((entry) => text(entry, 255)).filter((entry): entry is string => entry !== undefined);
  return { field, include: include.slice(0, MAX_LIST_ITEMS) };
}

function parseConditionalStyle(value: unknown): ConditionalStyle {
  if (!isBag(value)) return { fill: "#f8d7da" };
  return compact({ fill: color(value.fill), color: color(value.color), bold: trueOrUndefined(value.bold) }) ?? { fill: "#f8d7da" };
}

type RuleBase = { id: string; ref: string };
type RuleParser = (value: Bag, base: RuleBase) => ConditionalRule | undefined;

function parseConditional(value: unknown): ConditionalRule | undefined {
  if (!isBag(value)) return undefined;
  const id = objectId(value.id);
  const ref = localRange(value.ref);
  if (!id || !ref) return undefined;
  const parse = typeof value.type === "string" ? RULE_PARSERS.get(value.type) : undefined;
  return parse?.(value, { id, ref });
}

function parseScaleRule(value: Bag, base: RuleBase): ConditionalRule | undefined {
  const min = color(value.min);
  const max = color(value.max);
  if (!min || !max) return undefined;
  return compact({ ...base, type: "scale" as const, min, mid: color(value.mid), max }) as ConditionalRule;
}

function parseBarRule(value: Bag, base: RuleBase): ConditionalRule {
  return { ...base, type: "bar", color: color(value.color) ?? "#087d8b" };
}

function parseCellValueRule(value: Bag, base: RuleBase): ConditionalRule | undefined {
  const op = oneOf(value.op, CELL_OPERATORS);
  const operands = op ? comparisonOperands(value, op) : undefined;
  if (!op || !operands) return undefined;
  return compact({ ...base, type: "cell" as const, op, value: operands.first, value2: operands.second, style: parseConditionalStyle(value.style) }) as ConditionalRule;
}

/** A comparison's operand text; between and notBetween need a second one. */
function comparisonOperands(value: Bag, op: CellOperator): { first: string; second: string | undefined } | undefined {
  const first = text(String(value.value ?? ""), 255);
  if (!first) return undefined;
  const between = op === "between" || op === "notBetween";
  const second = between ? text(String(value.value2 ?? ""), 255) : undefined;
  if (between && !second) return undefined;
  return { first, second };
}

function parseTextRule(value: Bag, base: RuleBase): ConditionalRule | undefined {
  const op = oneOf(value.op, TEXT_OPERATORS);
  const needle = text(value.text, 255);
  if (!op || !needle) return undefined;
  return { ...base, type: "text", op, text: needle, style: parseConditionalStyle(value.style) };
}

function rankRule(type: "top" | "bottom"): RuleParser {
  return (value, base) =>
    compact({ ...base, type, count: clampInt(value.count, 1, 1000) ?? 10, percent: trueOrUndefined(value.percent), style: parseConditionalStyle(value.style) }) as ConditionalRule;
}

/** Rule types that carry nothing but a style. */
function styleOnlyRule(type: "duplicate" | "unique" | "above" | "below" | "blank" | "notBlank"): RuleParser {
  return (value, base) => ({ ...base, type, style: parseConditionalStyle(value.style) });
}

function parseFormulaRule(value: Bag, base: RuleBase): ConditionalRule | undefined {
  const formula = formulaText(value.formula, 1000);
  if (!formula) return undefined;
  return { ...base, type: "formula", formula, style: parseConditionalStyle(value.style) };
}

const RULE_PARSERS = new Map<string, RuleParser>([
  ["scale", parseScaleRule],
  ["bar", parseBarRule],
  ["cell", parseCellValueRule],
  ["text", parseTextRule],
  ["top", rankRule("top")],
  ["bottom", rankRule("bottom")],
  ["duplicate", styleOnlyRule("duplicate")],
  ["unique", styleOnlyRule("unique")],
  ["above", styleOnlyRule("above")],
  ["below", styleOnlyRule("below")],
  ["blank", styleOnlyRule("blank")],
  ["notBlank", styleOnlyRule("notBlank")],
  ["formula", parseFormulaRule],
]);

type ValidationNotes = Pick<SheetValidation, "strict" | "message">;

function parseValidation(value: unknown): SheetValidation | undefined {
  if (!isBag(value)) return undefined;
  const id = objectId(value.id);
  const ref = localRange(value.ref);
  const kind = oneOf(value.kind, VALIDATION_KINDS);
  if (!id || !ref || !kind) return undefined;
  const notes: ValidationNotes = { strict: bool(value.strict) ?? true, message: trimmedText(value.message, 255) };
  if (kind === "list") return parseListValidation(value, id, ref, notes);
  const op = oneOf(value.op, CELL_OPERATORS) ?? "between";
  const operands = comparisonOperands(value, op);
  if (!operands) return undefined;
  return compact({ id, ref, kind, op, value: operands.first, value2: operands.second, ...notes }) as SheetValidation;
}

/** A dropdown list from a range of cells or from typed items (the range wins). */
function parseListValidation(value: Bag, id: string, ref: string, notes: ValidationNotes): SheetValidation | undefined {
  const source = qualifiedRange(value.source);
  const items = listItems(value.items);
  if (!source && !items.length) return undefined;
  return compact({ id, ref, kind: "list" as const, items: source ? undefined : items, source, ...notes }) as SheetValidation;
}

function listItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => text(String(item), 255)?.trim()).filter((item): item is string => Boolean(item)))).slice(0, MAX_LIST_ITEMS);
}

function parseFilter(value: unknown): SheetFilter | undefined {
  if (!isBag(value)) return undefined;
  const ref = localRange(value.ref);
  if (!ref) return undefined;
  return compact({ ref, criteria: parseFilterCriteria(value.criteria), sort: parseFilterSort(value.sort) }) as SheetFilter;
}

/** Criteria keyed by upper-case column letter; columns with nothing usable are dropped. */
function parseFilterCriteria(value: unknown): Record<string, SheetFilterCriteria> {
  const criteria: Record<string, SheetFilterCriteria> = {};
  if (!isBag(value)) return criteria;
  for (const [letter, raw] of Object.entries(value)) {
    const entry = columnIndex(letter) >= 0 && isBag(raw) ? compact({ values: filterValues(raw.values), condition: filterCondition(raw.condition) }) : undefined;
    if (entry) criteria[letter.toUpperCase()] = entry;
  }
  return criteria;
}

function filterValues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => text(String(item), 255)).filter((item): item is string => item !== undefined).slice(0, MAX_LIST_ITEMS);
}

const FILTER_OPERATORS = [...CELL_OPERATORS, ...TEXT_OPERATORS] as const;

/** A filter condition; between and notBetween keep only with an upper bound. */
function filterCondition(value: unknown): SheetFilterCriteria["condition"] {
  const op = isBag(value) ? oneOf(value.op, FILTER_OPERATORS) : undefined;
  if (!op) return undefined;
  const bag = value as Bag;
  const between = op === "between" || op === "notBetween";
  const upper = between ? operandText(bag.value2) : undefined;
  if (between && !upper) return undefined;
  return compact({ op, value: operandText(bag.value), value2: upper });
}

/** An operand as text: String(value), absent as "", NUL removed, bounded. */
function operandText(value: unknown): string {
  return text(String(value ?? ""), 255)!;
}

function parseFilterSort(value: unknown): SheetFilter["sort"] {
  if (!isBag(value) || columnIndex(String(value.col)) < 0) return undefined;
  return { col: String(value.col).toUpperCase(), desc: value.desc === true };
}

function parseDimension<T extends SheetColumn | SheetRow>(
  value: unknown,
  keyOk: (key: string) => boolean,
  sizeKey: "w" | "h",
  min: number,
  max: number,
): Record<string, T> | undefined {
  if (!isBag(value)) return undefined;
  const out: Record<string, T> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!keyOk(key) || !isBag(raw)) continue;
    const entry = compact({
      [sizeKey]: clampInt(raw[sizeKey], min, max),
      hidden: trueOrUndefined(raw.hidden),
      s: parseCellStyle(raw.s),
    });
    if (entry) out[key.toUpperCase()] = entry as T;
  }
  return Object.keys(out).length ? out : undefined;
}

function list<T>(value: unknown, parse: (item: unknown) => T | undefined, max: number): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(parse).filter((item): item is T => item !== undefined).slice(0, max);
  return parsed.length ? parsed : undefined;
}

function uniqueIds<T extends { id: string }>(items: T[] | undefined): T[] | undefined {
  if (!items) return undefined;
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

function parseSheet(value: unknown, index: number, takenNames: Set<string>, takenTables: Set<string>, warnings: string[]): Sheet | undefined {
  if (!isBag(value)) return undefined;
  const id = objectId(value.id) ?? `sheet-${index + 1}`;
  const name = claimSheetName(value.name, index, takenNames, warnings);
  return compact({
    id,
    name,
    color: color(value.color),
    hidden: trueOrUndefined(value.hidden),
    cells: parseCells(value.cells),
    cols: parseDimension<SheetColumn>(value.cols, isColumnKey, "w", MIN_COL_WIDTH, MAX_COL_WIDTH),
    rows: parseDimension<SheetRow>(value.rows, isRowKey, "h", MIN_ROW_HEIGHT, MAX_ROW_HEIGHT),
    merges: parseMerges(value.merges),
    freeze: parseFreeze(value.freeze),
    gridlines: value.gridlines === false ? false : undefined,
    filter: parseFilter(value.filter),
    tables: uniqueIds(list(value.tables, (item) => parseTable(item, takenTables), MAX_OBJECTS_PER_SHEET)),
    charts: uniqueIds(list(value.charts, parseChart, MAX_OBJECTS_PER_SHEET)),
    pivots: uniqueIds(list(value.pivots, parsePivot, MAX_OBJECTS_PER_SHEET)),
    conditional: uniqueIds(list(value.conditional, parseConditional, MAX_RULES_PER_SHEET)),
    validations: uniqueIds(list(value.validations, parseValidation, MAX_RULES_PER_SHEET)),
  }) as Sheet;
}

/** The sheet's name, or a unique replacement (with a warning) when it is invalid or taken. */
function claimSheetName(value: unknown, index: number, takenNames: Set<string>, warnings: string[]): string {
  const name = typeof value === "string" ? value.trim() : "";
  const claimed = sheetNameFree(name, takenNames) ? name : renamedSheet(name, index, takenNames, warnings);
  takenNames.add(claimed.toLowerCase());
  return claimed;
}

function sheetNameFree(name: string, takenNames: Set<string>): boolean {
  return Boolean(name) && !sheetNameProblem(name) && !takenNames.has(name.toLowerCase());
}

function renamedSheet(name: string, index: number, takenNames: Set<string>, warnings: string[]): string {
  const fallback = uniqueSheetName(name && !sheetNameProblem(name) ? name : `Sheet${index + 1}`, Array.from(takenNames, (item) => ({ name: item })));
  if (name) warnings.push(`Renamed sheet "${name}" to "${fallback}".`);
  return fallback;
}

function parseCells(value: unknown): Record<string, SheetCell> {
  const cells: Record<string, SheetCell> = {};
  if (!isBag(value)) return cells;
  // Keys take their canonical spelling (" b02 " -> "B2"); when two spell the
  // same cell, the one parsed last wins, as a repeated JSON key would.
  for (const [key, raw] of Object.entries(value)) {
    const point = key.includes("$") ? null : parseCellKey(key);
    const cell = point ? parseCell(raw) : undefined;
    if (point && cell) cells[cellKey(point.row, point.col)] = cell;
  }
  return cells;
}

function isColumnKey(key: string): boolean {
  return columnIndex(key) >= 0 && columnIndex(key) < MAX_SHEET_COLS;
}

function isRowKey(key: string): boolean {
  return /^[1-9][0-9]{0,6}$/.test(key) && Number(key) <= MAX_SHEET_ROWS;
}

/** Distinct multi-cell merge ranges. */
function parseMerges(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const merges = Array.from(new Set(value.map(localRange).filter((item): item is string => Boolean(item) && item!.includes(":")))).slice(0, MAX_MERGES_PER_SHEET);
  return merges.length ? merges : undefined;
}

function parseFreeze(value: unknown): Sheet["freeze"] {
  if (!isBag(value)) return undefined;
  const rows = clampInt(value.rows, 0, 100) ?? 0;
  const cols = clampInt(value.cols, 0, 30) ?? 0;
  return rows || cols ? { rows, cols } : undefined;
}

function parseDefinedName(value: unknown, taken: Set<string>): DefinedName | undefined {
  if (!isBag(value) || typeof value.name !== "string") return undefined;
  const name = value.name.trim();
  if (!DEFINED_NAME.test(name) || tableNameProblem(name) || taken.has(name.toLowerCase())) return undefined;
  const ref = qualifiedRange(value.ref);
  if (!ref) return undefined;
  taken.add(name.toLowerCase());
  return { name, ref };
}

type WorkbookShape = { ok: true; sheets: unknown[]; names: unknown } | { ok: false; error: string };

export function parseWorkbook(value: unknown): ParseWorkbookResult {
  const shape = workbookShape(value);
  if (!shape.ok) return shape;
  const warnings: string[] = [];
  const takenTables = new Set<string>();
  const sheets = parseSheets(shape.sheets, takenTables, warnings);
  if (!sheets.length) return { ok: false, error: "A workbook needs at least one sheet." };
  if (shape.sheets.length > MAX_SHEETS) warnings.push(`Only the first ${MAX_SHEETS} sheets were kept.`);
  if (sheets.every((sheet) => sheet.hidden)) delete sheets[0].hidden;
  const cellTotal = sheets.reduce((total, sheet) => total + Object.keys(sheet.cells).length, 0);
  if (cellTotal > MAX_WORKBOOK_CELLS) {
    return { ok: false, error: `Workbooks can hold up to ${MAX_WORKBOOK_CELLS.toLocaleString("en-US")} filled cells.` };
  }
  const takenDefined = new Set(takenTables);
  const names = list(shape.names, (item) => parseDefinedName(item, takenDefined), MAX_DEFINED_NAMES);
  const workbook: Workbook = names ? { schema: SHEET_SCHEMA_VERSION, sheets, names } : { schema: SHEET_SCHEMA_VERSION, sheets };
  return { ok: true, workbook, warnings };
}

/** JSON text or an object with this schema and a non-empty sheet list. */
function workbookShape(value: unknown): WorkbookShape {
  const decoded = decodeJson(value);
  if (!decoded) return { ok: false, error: "The workbook is not valid JSON." };
  const candidate = decoded.value;
  if (!isBag(candidate)) return { ok: false, error: "The workbook is not an object." };
  if (candidate.schema !== undefined && candidate.schema !== SHEET_SCHEMA_VERSION) {
    return { ok: false, error: "This workbook was saved by a newer version of Aperture." };
  }
  if (!Array.isArray(candidate.sheets) || candidate.sheets.length === 0) {
    return { ok: false, error: "A workbook needs at least one sheet." };
  }
  return { ok: true, sheets: candidate.sheets, names: candidate.names };
}

function decodeJson(value: unknown): { value: unknown } | null {
  if (typeof value !== "string") return { value };
  try {
    return { value: JSON.parse(value) };
  } catch {
    return null;
  }
}

/** The first MAX_SHEETS sheets that parse, with duplicate ids replaced. */
function parseSheets(raw: unknown[], takenTables: Set<string>, warnings: string[]): Sheet[] {
  const takenNames = new Set<string>();
  const takenIds = new Set<string>();
  const sheets: Sheet[] = [];
  for (const [index, item] of raw.slice(0, MAX_SHEETS).entries()) {
    const sheet = parseSheet(item, index, takenNames, takenTables, warnings);
    if (!sheet) continue;
    if (takenIds.has(sheet.id)) sheet.id = nextObjectId("sheet", Array.from(takenIds, (id) => ({ id })));
    takenIds.add(sheet.id);
    sheets.push(sheet);
  }
  return sheets;
}
