/** AI editing for spreadsheets.
 *
 * The model never writes workbook JSON. It answers with a short message and
 * a list of operations in a small, documented vocabulary ("set", "format",
 * "chart", "pivot"...). Each operation is validated and applied with the same
 * pure edits the toolbar uses, so an AI change can be previewed cell by cell,
 * accepted as one undo step, and checked for formula errors before the
 * author sees it. Values that start with "=" are formulas.
 */

import {
  type CellRange,
  MAX_SHEET_COLS,
  MAX_SHEET_ROWS,
  cellKey,
  columnIndex,
  columnLabel,
  formatRangeRef,
  parseCellKey,
  parseRangeRef,
  quoteSheetName,
  splitSheetQualifiedRef,
} from "./address";
import { isError, type Scalar } from "./formula/values";
import { formatCellValue } from "./numberFormat";
import type { FormulaProblem, WorkbookEngine } from "./recalc";
import { computeWorkbook } from "./recalc";
import {
  CHART_LEGENDS,
  CHART_TYPES,
  PIVOT_AGGREGATES,
  TABLE_TONES,
  type AccentSlot,
  type CellStyle,
  type PivotValueField,
  type Sheet,
  type SheetCell,
  type SheetChart,
  type SheetTable,
  type Workbook,
  nextObjectId,
  parseCellStyle,
  parseWorkbook,
  sheetByName,
  tableNameProblem,
} from "./sheetModel";
import {
  type BorderPreset,
  type TableStylePatch,
  addSheet,
  applyBorders,
  applyStyle,
  cellFromInput,
  clearRange,
  deleteCols,
  deleteRows,
  deleteSheet,
  effectiveStyle,
  insertCols,
  insertRows,
  mergeRange,
  renameSheet,
  setColumnWidth,
  setFreeze,
  setNote,
  setRowHeight,
  setSheetProps,
  sortRange,
  unmergeRange,
  updateSheet,
  writeCells,
} from "./sheetOps";
import { restyledWorkbook } from "./tableStyles";
import { cleanAiTitle } from "../aiTitle";
import { shiftFormula } from "./formula/references";
import { fitPivotColumns } from "./pivotLayout";

export type SheetOp = Record<string, unknown> & { op: string };
/** `title` names the whole workbook; the editor uses it only while the draft is untitled. */
export type SheetAiReply = { message: string; title?: string; ops: SheetOp[] };
export type ApplyResult = { workbook: Workbook; applied: number; warnings: string[]; touched: Map<string, Set<string>>; activeSheetId: string };

const MAX_OPS = 400;
const MAX_SET_CELLS = 20_000;

/* ------------------------------------------------------------------ reply parsing */

/** Extracts the JSON reply, tolerating code fences and stray prose. */
export function parseSheetAiReply(text: string): SheetAiReply | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  for (const candidate of [fenced?.[1], text]) {
    const reply = candidate ? replyFromCandidate(candidate) : null;
    if (reply) return reply;
  }
  return null;
}

/** The outermost {...} in a reply, parsed. */
function jsonObjectIn(candidate: string): Record<string, unknown> | null {
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  return parseJsonObject(candidate.slice(start, candidate.lastIndexOf("}") + 1));
}

function textField(value: unknown, max = Number.POSITIVE_INFINITY): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function replyFromCandidate(candidate: string): SheetAiReply | null {
  const bag = jsonObjectIn(candidate);
  if (!bag) return null;
  const ops = Array.isArray(bag.ops) ? bag.ops.filter(isSheetOp) : [];
  const message = textField(bag.message);
  if (!ops.length && !message) return null;
  // Names show as plain text, so markdown the model slips in is removed;
  // what is left must hold a letter or digit to be a name at all.
  const cleaned = cleanAiTitle(textField(bag.title)).slice(0, 120).trim();
  const title = /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "";
  return { message, ...(title ? { title } : {}), ops: ops.slice(0, MAX_OPS) };
}

/** The name an untitled workbook takes after the assistant builds it: the
 * reply's title, else the new name the assistant gave the first sheet. */
export function workbookTitleFrom(title: string | undefined, before: Workbook, after: Workbook): string | null {
  if (title) return title;
  const first = after.sheets[0];
  const was = first ? before.sheets.find((sheet) => sheet.id === first.id) : undefined;
  return was && was.name !== first.name ? first.name : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isSheetOp(op: unknown): op is SheetOp {
  return Boolean(op) && typeof op === "object" && typeof (op as SheetOp).op === "string";
}

/* ------------------------------------------------------------------ applying */

type Context = {
  workbook: Workbook;
  sheetId: string;
  warnings: string[];
  touched: Map<string, Set<string>>;
};

type ApplyHint = { activateSheet?: string };
type OpHandler = (ctx: Context, op: SheetOp) => ApplyHint | void;
type CellUpdate = { row: number; col: number; cell: SheetCell | null };

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function resolveSheet(ctx: Context, name: unknown): Sheet | null {
  if (typeof name === "string" && name.trim()) {
    const sheet = sheetByName(ctx.workbook, name.trim());
    if (!sheet) {
      ctx.warnings.push(`Skipped a change for missing sheet "${name}".`);
      return null;
    }
    return sheet;
  }
  return ctx.workbook.sheets.find((sheet) => sheet.id === ctx.sheetId) ?? ctx.workbook.sheets[0];
}

function rangeArg(ctx: Context, value: unknown, label = "range"): CellRange | null {
  if (typeof value !== "string") {
    ctx.warnings.push(`A change was missing its ${label}.`);
    return null;
  }
  const { ref } = splitSheetQualifiedRef(value);
  const range = parseRangeRef(ref);
  if (!range) ctx.warnings.push(`"${value}" is not a valid ${label}.`);
  return range;
}

function sheetOfRef(ctx: Context, op: SheetOp, key = "range"): Sheet | null {
  const raw = op[key];
  const qualified = typeof raw === "string" ? splitSheetQualifiedRef(raw).sheet : null;
  return resolveSheet(ctx, op.sheet ?? qualified);
}

/** The sheet and range an op targets, warning for each one it lacks. */
function targetOf(ctx: Context, op: SheetOp): { sheet: Sheet; range: CellRange } | null {
  const sheet = sheetOfRef(ctx, op);
  const range = rangeArg(ctx, op.range);
  return sheet && range ? { sheet, range } : null;
}

function touch(ctx: Context, sheetId: string, range: CellRange): void {
  const set = ctx.touched.get(sheetId) ?? new Set<string>();
  const rows = Math.min(range.r2, range.r1 + 2000);
  const cols = Math.min(range.c2, range.c1 + 200);
  for (let row = range.r1; row <= rows; row += 1) for (let col = range.c1; col <= cols; col += 1) set.add(cellKey(row, col));
  ctx.touched.set(sheetId, set);
}

function literalInput(value: unknown): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return value;
  return null;
}

/** A value the model sent for one cell. Text that only looks like a number
 * stays text when the model sent a string, so ZIP codes and IDs survive. */
function cellForValue(existing: SheetCell | undefined, value: unknown): SheetCell | null {
  if (typeof value === "string" && !value.startsWith("=")) {
    const typed = cellFromInput(existing, value);
    if (typed && typeof typed.v === "number" && /^0\d/.test(value.trim())) return { ...typed, v: value };
    return typed;
  }
  const input = literalInput(value);
  if (input === null) return existing ?? null;
  return cellFromInput(existing, input);
}

const STYLE_ALIASES: Record<string, string> = { background: "fill", bg: "fill", textColor: "color", fontColor: "color", numberFormat: "format", fontSize: "size", horizontal: "align", vertical: "valign", wrapText: "wrap", fontFamily: "font" };

function styleArg(value: unknown): { style: CellStyle; border?: BorderPreset } {
  if (!value || typeof value !== "object") return { style: {} };
  const raw = aliasedStyle(value as Record<string, unknown>);
  const border = optionalString(raw.border) as BorderPreset | undefined;
  if (border) delete raw.border;
  lowerCaseText(raw, "color");
  lowerCaseText(raw, "fill");
  return { style: parseCellStyle(raw) ?? {}, border };
}

function aliasedStyle(value: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) raw[STYLE_ALIASES[key] ?? key] = item;
  if (raw.valign === "center") raw.valign = "middle";
  return raw;
}

function lowerCaseText(bag: Record<string, unknown>, key: string): void {
  const text = bag[key];
  if (typeof text === "string") bag[key] = text.toLowerCase();
}

const BORDER_PRESETS: BorderPreset[] = ["all", "outer", "inner", "top", "bottom", "left", "right", "thickOuter", "bottomDouble", "none"];

function applySet(ctx: Context, op: SheetOp): void {
  const sheet = sheetOfRef(ctx, op, op.range !== undefined ? "range" : "start");
  if (!sheet) return;
  const range = rangeArg(ctx, op.range ?? op.start ?? op.cell);
  if (!range) return;
  const updates = Array.isArray(op.values) ? gridUpdates(ctx, sheet, range, op.values) : fillUpdates(ctx, sheet, range, op);
  if (updates) ctx.workbook = updateSheet(ctx.workbook, sheet.id, (current) => writeCells(current, updates));
}

/** 2D rows written from the range's top-left cell. */
function gridUpdates(ctx: Context, sheet: Sheet, range: CellRange, values: unknown[]): CellUpdate[] {
  const rows = values.slice(0, MAX_SHEET_ROWS);
  const updates: CellUpdate[] = [];
  let count = 0;
  rows.forEach((line, r) => {
    const cells = Array.isArray(line) ? line : [line];
    cells.forEach((value, c) => {
      const row = range.r1 + r;
      const col = range.c1 + c;
      if (row >= MAX_SHEET_ROWS || col >= MAX_SHEET_COLS || count++ > MAX_SET_CELLS) return;
      updates.push({ row, col, cell: cellForValue(sheet.cells[cellKey(row, col)], value) });
    });
  });
  const width = Math.max(1, ...rows.map((line) => (Array.isArray(line) ? line.length : 1)));
  touch(ctx, sheet.id, { r1: range.r1, c1: range.c1, r2: range.r1 + rows.length - 1, c2: range.c1 + width - 1 });
  return updates;
}

/** One formula or value written across the range; relative references
 * shift per cell, like typing it in the first cell and filling. */
function fillUpdates(ctx: Context, sheet: Sheet, range: CellRange, op: SheetOp): CellUpdate[] | null {
  if (typeof op.formula !== "string" && op.value === undefined) {
    ctx.warnings.push("A set change had no values.");
    return null;
  }
  const input = fillInput(op);
  if (input === null) return null;
  const updates: CellUpdate[] = [];
  for (let row = range.r1; row <= Math.min(range.r2, range.r1 + 5000); row += 1) {
    for (let col = range.c1; col <= range.c2; col += 1) {
      const cell = cellForValue(sheet.cells[cellKey(row, col)], input);
      if (cell?.f) cell.f = shiftFormula(cell.f, row - range.r1, col - range.c1);
      updates.push({ row, col, cell });
    }
  }
  touch(ctx, sheet.id, range);
  return updates;
}

function fillInput(op: SheetOp): string | null {
  if (typeof op.formula !== "string") return literalInput(op.value);
  return op.formula.startsWith("=") ? op.formula : `=${op.formula}`;
}

function applyFormat(ctx: Context, op: SheetOp): void {
  const target = targetOf(ctx, op);
  if (!target) return;
  const { sheet, range } = target;
  const { style, border } = styleArg(op.style ?? op);
  const patch = withFormat(style, optionalString(op.format));
  if (Object.keys(patch).length) ctx.workbook = applyStyle(ctx.workbook, sheet.id, range, patch);
  const preset = border ?? (optionalString(op.border) as BorderPreset | undefined);
  if (preset && BORDER_PRESETS.includes(preset)) {
    ctx.workbook = applyBorders(ctx.workbook, sheet.id, range, preset, optionalString(op.borderColor)?.toLowerCase());
  }
  touch(ctx, sheet.id, { ...range, r2: Math.min(range.r2, range.r1 + 500), c2: Math.min(range.c2, range.c1 + 60) });
}

function withFormat(style: CellStyle, format: string | undefined): CellStyle {
  return { ...style, ...(format ? { format } : {}) };
}

function indexArg(value: unknown, axis: "rows" | "cols"): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return axis === "rows" ? value - 1 : value - 1;
  if (typeof value === "string") {
    if (axis === "cols") {
      const index = columnIndex(value.trim());
      return index >= 0 ? index : null;
    }
    const number = Number(value);
    return Number.isInteger(number) ? number - 1 : null;
  }
  return null;
}

function applyStructure(ctx: Context, op: SheetOp): void {
  const sheet = resolveSheet(ctx, op.sheet);
  if (!sheet) return;
  const axis = op.op.endsWith("Rows") ? "rows" : "cols";
  const at = indexArg(op.at, axis);
  const count = typeof op.count === "number" ? Math.max(1, Math.min(1000, Math.round(op.count))) : 1;
  if (at === null || at < 0) {
    ctx.warnings.push(`${op.op} needs "at".`);
    return;
  }
  const edits = { insertRows, deleteRows, insertCols, deleteCols } as const;
  ctx.workbook = edits[op.op as keyof typeof edits](ctx.workbook, sheet.id, at, count);
}

/** An explicit anchor cell the model asked for, upper-cased. */
function anchorArg(value: unknown): string | null {
  return typeof value === "string" && parseCellKey(value) ? value.toUpperCase() : null;
}

function clampedSize(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" ? Math.max(min, Math.min(max, value)) : fallback;
}

function trueOrUndefined(value: unknown): true | undefined {
  return value === true ? true : undefined;
}

function allObjects<T>(workbook: Workbook, list: (sheet: Sheet) => T[] | undefined): T[] {
  return workbook.sheets.flatMap((item) => list(item) ?? []);
}

function applyChart(ctx: Context, op: SheetOp): void {
  const sheet = resolveSheet(ctx, op.sheet);
  if (!sheet) return;
  const located = chartSource(ctx, sheet, op);
  if (!located) return;
  const chart = buildChart(ctx.workbook, op, located.range, located.source);
  ctx.workbook = updateSheet(ctx.workbook, sheet.id, (current) => ({ ...current, charts: [...(current.charts ?? []), chart] }));
}

/** The chart's data range, written relative to the sheet that holds it. */
function chartSource(ctx: Context, sheet: Sheet, op: SheetOp): { range: CellRange; source: string } | null {
  const split = splitSheetQualifiedRef(optionalString(op.source) ?? optionalString(op.range) ?? "");
  const range = parseRangeRef(split.ref);
  if (!range) {
    ctx.warnings.push("A chart was missing its data range.");
    return null;
  }
  const sourceSheet = split.sheet ? sheetByName(ctx.workbook, split.sheet) : sheet;
  if (!sourceSheet) {
    ctx.warnings.push(`A chart pointed at missing sheet "${split.sheet}".`);
    return null;
  }
  const source = sourceSheet.id === sheet.id ? formatRangeRef(range) : `${quoteSheetName(sourceSheet.name)}!${formatRangeRef(range)}`;
  return { range, source };
}

function buildChart(workbook: Workbook, op: SheetOp, range: CellRange, source: string): SheetChart {
  return {
    id: nextObjectId("chart", allObjects(workbook, (item) => item.charts)),
    type: CHART_TYPES.find((item) => item === op.type) ?? "column",
    title: optionalString(op.title)?.slice(0, 200),
    source,
    seriesBy: op.seriesBy === "rows" ? "rows" : "columns",
    stacked: trueOrUndefined(op.stacked),
    legend: CHART_LEGENDS.find((item) => item === op.legend) ?? "bottom",
    showValues: trueOrUndefined(op.showValues),
    xTitle: optionalString(op.xTitle),
    yTitle: optionalString(op.yTitle),
    at: anchorArg(op.at) ?? cellKey(Math.max(0, range.r1), Math.min(MAX_SHEET_COLS - 8, range.c2 + 2)),
    w: clampedSize(op.width, 240, 1200, 480),
    h: clampedSize(op.height, 160, 900, 300),
  };
}

function applyTable(ctx: Context, op: SheetOp): void {
  const target = targetOf(ctx, op);
  if (!target) return;
  const { sheet, range } = target;
  if (range.r2 <= range.r1) {
    ctx.warnings.push("A table needs a header row and at least one data row.");
    return;
  }
  // A table formatted again over the same cells keeps its name, so formulas that read it keep working.
  const replaced = new Set((sheet.tables ?? []).filter((table) => rangesOverlap(parseRangeRef(table.ref), range)).map((table) => table.name.toLowerCase()));
  const name = uniqueTableName(ctx.workbook, op.name, replaced);
  const accent = tableAccent(op.accent);
  const tone = TABLE_TONES.find((item) => item === op.tone) ?? "medium";
  ctx.workbook = updateSheet(ctx.workbook, sheet.id, (current) => ({
    ...current,
    tables: [
      ...(current.tables ?? []).filter((table) => !rangesOverlap(parseRangeRef(table.ref), range)),
      { id: name, name, ref: formatRangeRef(range), accent, tone, banded: op.banded !== false, totals: op.totals === true, filterButtons: op.filterButtons !== false },
    ],
  }));
  touch(ctx, sheet.id, { ...range, r2: range.r1 });
}

/** A valid Excel table name, numbered past names other tables already use. */
function uniqueTableName(workbook: Workbook, raw: unknown, freed: Set<string> = new Set()): string {
  const taken = new Set(allObjects(workbook, (item) => item.tables).map((table) => table.name.toLowerCase()).filter((name) => !freed.has(name)));
  let name = tableNameArg(raw);
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${name.replace(/\d+$/, "")}${n}`;
  return name;
}

function tableNameArg(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/[^A-Za-z0-9_.]/g, "_").replace(/^([^A-Za-z_])/, "_$1") : "Table1";
  return tableNameProblem(name) ? "Table1" : name;
}

/** Restyles an existing table (or "*": every table) without renaming or moving it. */
function applyTableStyle(ctx: Context, op: SheetOp): void {
  const patch = tableStyleArgs(op);
  if (op.table === "*") {
    ctx.workbook = restyledWorkbook(ctx.workbook, patch);
    return;
  }
  const name = typeof op.table === "string" ? op.table : "";
  const found = namedTable(ctx.workbook, name);
  if (!found) {
    ctx.warnings.push(`There is no table named "${name}" to restyle.`);
    return;
  }
  const { sheetId, table } = found;
  ctx.workbook = restyledWorkbook(ctx.workbook, patch, { sheetId, tableId: table.id });
  const range = parseRangeRef(table.ref);
  if (range) touch(ctx, sheetId, { ...range, r2: range.r1 });
}

/** A table by name, matched without regard to case, as Excel does. */
function namedTable(workbook: Workbook, name: string): { sheetId: string; table: SheetTable } | null {
  const wanted = name.toLowerCase();
  for (const sheet of workbook.sheets) {
    const table = sheet.tables?.find((item) => item.name.toLowerCase() === wanted);
    if (table) return { sheetId: sheet.id, table };
  }
  return null;
}

function tableStyleArgs(op: SheetOp): TableStylePatch {
  const patch: TableStylePatch = {};
  if (op.accent !== undefined) patch.accent = tableAccent(op.accent);
  const tone = TABLE_TONES.find((item) => item === op.tone);
  if (tone) patch.tone = tone;
  if (typeof op.banded === "boolean") patch.banded = op.banded;
  if (typeof op.filterButtons === "boolean") patch.filterButtons = op.filterButtons;
  if (typeof op.firstColumn === "boolean") patch.firstColumn = op.firstColumn;
  return patch;
}

function tableAccent(value: unknown): AccentSlot {
  return typeof value === "number" && value >= 1 && value <= 6 ? (Math.round(value) as AccentSlot) : 1;
}

function rangesOverlap(a: CellRange | null, b: CellRange): boolean {
  return Boolean(a && a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2);
}

function applyPivot(ctx: Context, op: SheetOp): ApplyHint | void {
  const split = splitSheetQualifiedRef(optionalString(op.source) ?? "");
  const range = parseRangeRef(split.ref);
  if (!range) {
    ctx.warnings.push("A pivot table was missing its source range.");
    return;
  }
  const sourceSheet = split.sheet ? sheetByName(ctx.workbook, split.sheet) : resolveSheet(ctx, undefined);
  if (!sourceSheet) return;
  const hostId = pivotHost(ctx, op.sheet, sourceSheet).id;
  const values = pivotValues(op.values);
  const pivot = {
    id: nextObjectId("pivot", allObjects(ctx.workbook, (item) => item.pivots)),
    name: optionalString(op.name) ?? "PivotTable",
    source: `${quoteSheetName(sourceSheet.name)}!${formatRangeRef(range)}`,
    at: anchorArg(op.at) ?? (hostId === sourceSheet.id ? cellKey(range.r1, range.c2 + 2) : "A3"),
    rows: stringList(op.rows),
    columns: stringList(op.columns),
    values,
    filters: [],
    rowTotals: op.rowTotals !== false,
    columnTotals: op.columnTotals !== false,
  };
  ctx.workbook = updateSheet(ctx.workbook, hostId, (current) => ({ ...current, pivots: [...(current.pivots ?? []), pivot] }));
  ctx.workbook = fitPivotColumns(ctx.workbook, hostId, pivot.id);
  return { activateSheet: hostId };
}

/** The sheet a pivot goes on: the named sheet (added when missing) or its source sheet. */
function pivotHost(ctx: Context, name: unknown, sourceSheet: Sheet): Sheet {
  if (typeof name !== "string") return sourceSheet;
  const existing = sheetByName(ctx.workbook, name);
  if (existing) return existing;
  const added = addSheet(ctx.workbook, name, sourceSheet.id);
  ctx.workbook = added.workbook;
  return ctx.workbook.sheets.find((item) => item.id === added.sheetId) ?? sourceSheet;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function pivotValues(value: unknown): PivotValueField[] {
  return (Array.isArray(value) ? value : []).flatMap((item: unknown) => pivotValueField(item));
}

function pivotValueField(item: unknown): PivotValueField[] {
  if (typeof item === "string") return [{ field: item, agg: "sum" }];
  if (!item || typeof item !== "object") return [];
  const bag = item as Record<string, unknown>;
  const agg = PIVOT_AGGREGATES.find((name) => name === bag.agg) ?? "sum";
  return typeof bag.field === "string" ? [{ field: bag.field, agg, ...(typeof bag.label === "string" ? { label: bag.label } : {}) }] : [];
}

/** A rule run through the workbook gate on its own, or undefined when the gate drops it. */
function parsedRule<K extends "conditional" | "validations">(key: K, candidate: unknown): NonNullable<Sheet[K]>[number] | undefined {
  const parsed = parseWorkbook({ sheets: [{ name: "x", cells: {}, [key]: [candidate] }] });
  return parsed.ok ? parsed.workbook.sheets[0][key]?.[0] : undefined;
}

function applyConditional(ctx: Context, op: SheetOp): void {
  const target = targetOf(ctx, op);
  if (!target) return;
  const { sheet, range } = target;
  const raw = (op.rule && typeof op.rule === "object" ? op.rule : op) as Record<string, unknown>;
  const rule = parsedRule("conditional", { ...raw, id: nextObjectId("rule", sheet.conditional ?? []), ref: formatRangeRef(range) });
  if (!rule) {
    ctx.warnings.push("Skipped a conditional format the editor could not read.");
    return;
  }
  ctx.workbook = updateSheet(ctx.workbook, sheet.id, (current) => ({ ...current, conditional: [...(current.conditional ?? []), rule] }));
}

function applyValidation(ctx: Context, op: SheetOp): void {
  const target = targetOf(ctx, op);
  if (!target) return;
  const { sheet, range } = target;
  const kind = op.kind ?? (Array.isArray(op.items) ? "list" : undefined);
  const rule = parsedRule("validations", { ...op, id: nextObjectId("valid", sheet.validations ?? []), ref: formatRangeRef(range), kind });
  if (!rule) {
    ctx.warnings.push("Skipped a data validation rule the editor could not read.");
    return;
  }
  ctx.workbook = updateSheet(ctx.workbook, sheet.id, (current) => ({ ...current, validations: [...(current.validations ?? []), rule] }));
}

function applySort(ctx: Context, op: SheetOp): void {
  const target = targetOf(ctx, op);
  if (!target) return;
  const { sheet, range } = target;
  const by = sortKeys(op);
  if (!by.length) return;
  const engine = computeWorkbook(ctx.workbook);
  ctx.workbook = sortRange(ctx.workbook, sheet.id, range, by, (row, col) => engine.value(sheet.id, row, col), op.header !== false);
  touch(ctx, sheet.id, range);
}

function sortKeys(op: SheetOp): { col: number; desc: boolean }[] {
  const keys: unknown[] = Array.isArray(op.by) ? op.by : [op.by ?? { col: op.col, desc: op.desc }];
  return keys.flatMap((item) => sortKey(item));
}

function sortKey(item: unknown): { col: number; desc: boolean }[] {
  if (!item || typeof item !== "object") return [];
  const bag = item as Record<string, unknown>;
  const col = sortColumn(bag.col);
  return col >= 0 ? [{ col, desc: bag.desc === true }] : [];
}

/** A column letter, or a 1-based column number; -1 when neither. */
function sortColumn(col: unknown): number {
  if (typeof col === "string") return columnIndex(col);
  return typeof col === "number" ? col - 1 : -1;
}

function applyClear(ctx: Context, op: SheetOp): void {
  const target = targetOf(ctx, op);
  if (!target) return;
  const what = (["all", "contents", "formats", "notes"] as const).find((item) => item === op.what) ?? "contents";
  ctx.workbook = clearRange(ctx.workbook, target.sheet.id, target.range, what);
  touch(ctx, target.sheet.id, target.range);
}

function applyAddSheet(ctx: Context, op: SheetOp): ApplyHint {
  const name = optionalString(op.name);
  const existing = name ? sheetByName(ctx.workbook, name) : undefined;
  if (existing) return { activateSheet: existing.id };
  const added = addSheet(ctx.workbook, name);
  ctx.workbook = added.workbook;
  if (typeof op.color === "string") ctx.workbook = setSheetProps(ctx.workbook, added.sheetId, { color: op.color.toLowerCase() });
  return { activateSheet: added.sheetId };
}

function applyRenameSheet(ctx: Context, op: SheetOp): void {
  const sheet = resolveSheet(ctx, op.sheet);
  if (!sheet || typeof op.name !== "string") return;
  const result = renameSheet(ctx.workbook, sheet.id, op.name);
  if (result.error) ctx.warnings.push(result.error);
  ctx.workbook = result.workbook;
}

function applyDeleteSheet(ctx: Context, op: SheetOp): void {
  const sheet = resolveSheet(ctx, op.sheet);
  if (sheet) ctx.workbook = deleteSheet(ctx.workbook, sheet.id);
}

function applyActivateSheet(ctx: Context, op: SheetOp): ApplyHint | void {
  const sheet = resolveSheet(ctx, op.sheet);
  return sheet ? { activateSheet: sheet.id } : undefined;
}

function applyTabColor(ctx: Context, op: SheetOp): void {
  const sheet = resolveSheet(ctx, op.sheet);
  if (sheet && typeof op.color === "string") ctx.workbook = setSheetProps(ctx.workbook, sheet.id, { color: op.color.toLowerCase() });
}

function applyMerge(ctx: Context, op: SheetOp): void {
  const target = targetOf(ctx, op);
  if (target) ctx.workbook = (op.op === "merge" ? mergeRange : unmergeRange)(ctx.workbook, target.sheet.id, target.range);
}

/** "B" or "3" alone means the whole span "B:B" or "3:3". */
function spanRef(text: string): string {
  return text.includes(":") ? text : `${text}:${text}`;
}

function applyColWidth(ctx: Context, op: SheetOp): void {
  const sheet = resolveSheet(ctx, op.sheet);
  const range = typeof op.cols === "string" ? parseRangeRef(spanRef(op.cols)) : null;
  if (sheet && range && typeof op.width === "number") ctx.workbook = setColumnWidth(ctx.workbook, sheet.id, range.c1, range.c2, op.width);
}

function applyRowHeight(ctx: Context, op: SheetOp): void {
  const sheet = resolveSheet(ctx, op.sheet);
  const range = parseRangeRef(spanRef(String(op.rows ?? "")));
  if (sheet && range && typeof op.height === "number") ctx.workbook = setRowHeight(ctx.workbook, sheet.id, range.r1, range.r2, op.height);
}

function paneCount(value: unknown, max: number): number {
  return Math.max(0, Math.min(max, Number(value ?? 0) || 0));
}

function applyFreeze(ctx: Context, op: SheetOp): void {
  const sheet = resolveSheet(ctx, op.sheet);
  if (sheet) ctx.workbook = setFreeze(ctx.workbook, sheet.id, paneCount(op.rows, 50), paneCount(op.cols, 20));
}

function applyGridlines(ctx: Context, op: SheetOp): void {
  const sheet = resolveSheet(ctx, op.sheet);
  if (sheet) ctx.workbook = setSheetProps(ctx.workbook, sheet.id, { gridlines: op.show === false ? false : undefined });
}

function applyFilter(ctx: Context, op: SheetOp): void {
  const target = targetOf(ctx, op);
  if (!target) return;
  const filter = { ref: formatRangeRef(target.range), criteria: {} };
  ctx.workbook = updateSheet(ctx.workbook, target.sheet.id, (current) => ({ ...current, filter }));
}

function applyNote(ctx: Context, op: SheetOp): void {
  const sheet = sheetOfRef(ctx, op, "cell");
  const point = typeof op.cell === "string" ? parseCellKey(splitSheetQualifiedRef(op.cell).ref) : null;
  if (sheet && point) ctx.workbook = setNote(ctx.workbook, sheet.id, point.row, point.col, optionalString(op.text) ?? "");
}

function applyName(ctx: Context, op: SheetOp): void {
  if (typeof op.name !== "string" || typeof op.ref !== "string") return;
  const key = op.name.toLowerCase();
  const names = [...(ctx.workbook.names ?? []).filter((item) => item.name.toLowerCase() !== key), { name: op.name, ref: op.ref }];
  const parsed = parseWorkbook({ ...ctx.workbook, names });
  if (parsed.ok) ctx.workbook = { ...ctx.workbook, names: parsed.workbook.names };
}

/** Every operation the model may send, by its "op" name. */
const OP_HANDLERS = new Map<string, OpHandler>([
  ["set", applySet],
  ["format", applyFormat],
  ["numberFormat", applyFormat],
  ["clear", applyClear],
  ["insertRows", applyStructure],
  ["deleteRows", applyStructure],
  ["insertCols", applyStructure],
  ["deleteCols", applyStructure],
  ["addSheet", applyAddSheet],
  ["renameSheet", applyRenameSheet],
  ["deleteSheet", applyDeleteSheet],
  ["activateSheet", applyActivateSheet],
  ["tabColor", applyTabColor],
  ["merge", applyMerge],
  ["unmerge", applyMerge],
  ["colWidth", applyColWidth],
  ["rowHeight", applyRowHeight],
  ["freeze", applyFreeze],
  ["gridlines", applyGridlines],
  ["table", applyTable],
  ["tableStyle", applyTableStyle],
  ["chart", applyChart],
  ["pivot", applyPivot],
  ["conditional", applyConditional],
  ["conditionalFormat", applyConditional],
  ["validation", applyValidation],
  ["sort", applySort],
  ["filter", applyFilter],
  ["note", applyNote],
  ["name", applyName],
]);

function applyOne(ctx: Context, op: SheetOp): ApplyHint | void {
  const handler = OP_HANDLERS.get(op.op);
  if (handler) return handler(ctx, op);
  ctx.warnings.push(`Skipped an unknown change "${op.op}".`);
}

function applyGuarded(ctx: Context, op: SheetOp): ApplyHint | void {
  try {
    return applyOne(ctx, op);
  } catch (error) {
    ctx.warnings.push(`Skipped a change that failed: ${error instanceof Error ? error.message : "unknown error"}.`);
  }
}

/** Applies AI operations to a workbook; invalid operations are skipped with
 * a warning instead of failing the whole reply. */
export function applySheetOps(workbook: Workbook, sheetId: string, ops: SheetOp[]): ApplyResult {
  const ctx: Context = { workbook, sheetId, warnings: [], touched: new Map() };
  let applied = 0;
  let activeSheetId = sheetId;
  for (const op of ops.slice(0, MAX_OPS)) {
    const before = ctx.workbook;
    const warningsBefore = ctx.warnings.length;
    ctx.sheetId = activeSheetId;
    const hint = applyGuarded(ctx, op);
    if (hint?.activateSheet) activeSheetId = hint.activateSheet;
    if (ctx.workbook !== before || ctx.warnings.length === warningsBefore) applied += 1;
  }
  const validated = parseWorkbook(ctx.workbook);
  if (!validated.ok) return { workbook, applied: 0, warnings: [validated.error], touched: new Map(), activeSheetId: sheetId };
  if (!validated.workbook.sheets.some((sheet) => sheet.id === activeSheetId)) activeSheetId = validated.workbook.sheets[0].id;
  return { workbook: validated.workbook, applied, warnings: [...ctx.warnings, ...validated.warnings], touched: ctx.touched, activeSheetId };
}

/* ------------------------------------------------------------------ change summary */

/** Cells whose input differs between two workbooks, per sheet id. */
export function diffWorkbooks(before: Workbook, after: Workbook): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const sheet of after.sheets) {
    const old = before.sheets.find((item) => item.id === sheet.id);
    const changed = changedCells(sheet, old);
    if (changed.size || !old) out.set(sheet.id, changed);
  }
  return out;
}

function changedCells(sheet: Sheet, old: Sheet | undefined): Set<string> {
  const changed = new Set<string>();
  const keys = new Set([...Object.keys(sheet.cells), ...Object.keys(old?.cells ?? {})]);
  for (const key of keys) {
    if (cellJson(sheet.cells[key]) !== cellJson(old?.cells[key])) changed.add(key);
  }
  return changed;
}

function cellJson(cell: SheetCell | undefined): string {
  return JSON.stringify(cell ?? null);
}

/** Sheet objects the change summary counts, with the noun it uses for each. */
const SUMMARY_OBJECTS: [noun: string, list: (sheet: Sheet) => unknown[] | undefined][] = [
  ["chart", (sheet) => sheet.charts],
  ["table", (sheet) => sheet.tables],
  ["pivot table", (sheet) => sheet.pivots],
  ["highlight rule", (sheet) => sheet.conditional],
];

function objectCount(workbook: Workbook, list: (sheet: Sheet) => unknown[] | undefined): number {
  return workbook.sheets.reduce((total, sheet) => total + (list(sheet)?.length ?? 0), 0);
}

function countLabel(count: number, noun: string, shown = String(count)): string {
  return `${shown} ${noun}${count === 1 ? "" : "s"}`;
}

export function describeChanges(before: Workbook, after: Workbook): string {
  const cells = Array.from(diffWorkbooks(before, after).values()).reduce((total, set) => total + set.size, 0);
  const newSheets = after.sheets.filter((sheet) => !before.sheets.some((item) => item.id === sheet.id)).length;
  const parts: string[] = [];
  if (cells) parts.push(countLabel(cells, "cell", cells.toLocaleString("en-US")));
  if (newSheets) parts.push(countLabel(newSheets, "new sheet"));
  for (const [noun, list] of SUMMARY_OBJECTS) {
    const added = objectCount(after, list) - objectCount(before, list);
    if (added > 0) parts.push(countLabel(added, noun));
  }
  return parts.length ? parts.join(", ") : "formatting only";
}

/** Formula errors in cells the AI wrote, for the automatic fix round. */
export function problemsInTouched(engine: WorkbookEngine, touched: Map<string, Set<string>>): FormulaProblem[] {
  return engine.formulaProblems().filter((problem) => touched.get(problem.sheetId)?.has(problem.address)).slice(0, 25);
}

/* ------------------------------------------------------------------ prompt context */

function displayValue(value: Scalar, format: string | undefined): string {
  if (value === null) return "";
  if (isError(value)) return value.code;
  return formatCellValue(value, format).text;
}

function isBlank(value: Scalar): boolean {
  return value === null || value === "";
}

function cellLine(sheet: Sheet, engine: WorkbookEngine, row: number, col: number): string | null {
  const address = cellKey(row, col);
  const formula = sheet.cells[address]?.f;
  const value = engine.value(sheet.id, row, col);
  if (!formula && isBlank(value)) return null;
  const format = effectiveStyle(sheet, row, col)?.format;
  const shown = displayValue(value, format);
  if (formula) return `${address}: =${formula} → ${shown}`;
  return literalLine(address, value, shown, format);
}

function literalLine(address: string, value: Scalar, shown: string, format: string | undefined): string {
  return `${address}: ${JSON.stringify(typeof value === "string" ? value : shown)}${format ? ` [${format}]` : ""}`;
}

/** A compact, model-readable picture of one sheet: structure, headers, and
 * cell contents (formulas shown with their results), bounded by `budget`. */
export function describeSheet(sheet: Sheet, engine: WorkbookEngine, budget: number, focus?: CellRange): string {
  const used = engine.usedRange(sheet.id);
  const lines = [`Sheet ${JSON.stringify(sheet.name)} (${sheetMeta(sheet, used).join("; ")})`];
  if (!used) return lines.join("\n");
  const widths = Object.entries(sheet.cols ?? {}).filter(([, col]) => col.w).slice(0, 30).map(([letter, col]) => `${letter}=${col.w}`);
  if (widths.length) lines.push(`Column widths px: ${widths.join(" ")}`);
  const complete = addRowLines(lines, budget, rowsToShow(used, focus), (row) => rowLine(sheet, engine, row, used));
  if (used.r2 - used.r1 + 1 > 80 && !focus) lines.splice(lines.length - 10, 0, `… rows ${used.r1 + 41}-${used.r2 - 9} omitted (same columns) …`);
  if (!complete) lines.push("… more cells omitted …");
  return lines.join("\n");
}

function listMeta<T>(items: T[] | undefined, describe: (items: T[]) => string): string[] {
  return items?.length ? [describe(items)] : [];
}

/** The parenthesized structure summary after a sheet's name. */
function sheetMeta(sheet: Sheet, used: CellRange | null): string[] {
  return [
    `used ${used ? formatRangeRef(used) : "(empty)"}`,
    ...(sheet.freeze ? [`frozen ${sheet.freeze.rows} row(s) ${sheet.freeze.cols} col(s)`] : []),
    ...listMeta(sheet.tables, (tables) => `tables ${tables.map((table) => `${table.name} ${table.ref}`).join(", ")}`),
    ...listMeta(sheet.charts, (charts) => `charts ${charts.map((chart) => `${chart.type} "${chart.title ?? ""}" of ${chart.source} at ${chart.at}`).join("; ")}`),
    ...listMeta(sheet.pivots, (pivots) => `pivots ${pivots.map((pivot) => `${pivot.name} at ${pivot.at} from ${pivot.source}`).join("; ")}`),
    ...listMeta(sheet.merges, (merges) => `merges ${merges.slice(0, 12).join(", ")}`),
    ...listMeta(sheet.conditional, (rules) => `${rules.length} conditional format rule(s)`),
  ];
}

function rowSpan(from: number, to: number): number[] {
  const rows: number[] = [];
  for (let row = from; row <= to; row += 1) rows.push(row);
  return rows;
}

/** Rows around the focus first, then every row of a short sheet or the head and tail of a long one. */
function rowsToShow(used: CellRange, focus: CellRange | undefined): Set<number> {
  const around = focus ? rowSpan(Math.max(0, focus.r1 - 2), Math.min(used.r2, focus.r2 + 2)) : [];
  const body = used.r2 - used.r1 + 1 <= 80 ? rowSpan(used.r1, used.r2) : [...rowSpan(used.r1, used.r1 + 39), ...rowSpan(used.r2 - 9, used.r2)];
  return new Set([...around, ...body]);
}

/** Appends row lines while they fit the budget; false when one did not. */
function addRowLines(lines: string[], budget: number, rows: Iterable<number>, lineFor: (row: number) => string): boolean {
  let size = lines.join("\n").length;
  for (const row of rows) {
    const line = lineFor(row);
    if (!line) continue;
    if (size + line.length + 1 > budget) return false;
    lines.push(line);
    size += line.length + 1;
  }
  return true;
}

function rowLine(sheet: Sheet, engine: WorkbookEngine, row: number, used: CellRange): string {
  const parts: string[] = [];
  for (let col = used.c1; col <= Math.min(used.c2, used.c1 + 40); col += 1) {
    const line = cellLine(sheet, engine, row, col);
    if (line) parts.push(line);
  }
  return parts.join(" | ");
}

export function describeWorkbook(workbook: Workbook, engine: WorkbookEngine, activeSheetId: string, focus?: CellRange, budget = 24_000): string {
  const active = workbook.sheets.find((sheet) => sheet.id === activeSheetId) ?? workbook.sheets[0];
  const others = workbook.sheets.filter((sheet) => sheet.id !== active.id);
  const parts = [`Workbook with ${workbook.sheets.length} sheet(s): ${workbook.sheets.map((sheet) => JSON.stringify(sheet.name)).join(", ")}.`];
  if (workbook.names?.length) parts.push(`Defined names: ${workbook.names.map((item) => `${item.name}=${item.ref}`).join(", ")}`);
  parts.push(`ACTIVE ${describeSheet(active, engine, Math.floor(budget * (others.length ? 0.6 : 1)), focus)}`);
  const share = others.length ? Math.floor((budget * 0.4) / others.length) : 0;
  for (const sheet of others) parts.push(describeSheet(sheet, engine, Math.max(600, share)));
  return parts.join("\n\n");
}

export function describeSelection(sheet: Sheet, engine: WorkbookEngine, range: CellRange): string {
  const label = formatRangeRef(range);
  const lines: string[] = [];
  const bounded = { ...range, r2: Math.min(range.r2, range.r1 + 199), c2: Math.min(range.c2, range.c1 + 25) };
  for (let row = bounded.r1; row <= bounded.r2; row += 1) {
    const parts: string[] = [];
    for (let col = bounded.c1; col <= bounded.c2; col += 1) {
      const line = cellLine(sheet, engine, row, col);
      parts.push(line ?? `${cellKey(row, col)}: (empty)`);
    }
    lines.push(parts.join(" | "));
  }
  return `Selected range ${quoteSheetName(sheet.name)}!${label}:\n${lines.join("\n")}`;
}

/* ------------------------------------------------------------------ prompts */

export const SHEET_OPS_REFERENCE = `Reply with ONE JSON object and nothing else:
{"message": "<one or two plain sentences for the user: what you changed, or the answer>", "title": "<a short name for the whole workbook, 2 to 6 words, when you build or reshape it>", "ops": [ ... ]}

Operations (all ranges are A1 text; "sheet" is optional and defaults to the active sheet):
- {"op":"set","range":"A1","values":[["Region","Q1"],["East",1200]]}  2D rows written from the range's top-left. Strings starting with "=" are formulas. null clears a cell.
- {"op":"set","range":"D2:D40","formula":"=B2*C2"}  one formula filled down/across; relative references shift per cell.
- {"op":"format","range":"A1:D1","style":{"bold":true,"fill":"#087d8b","color":"#ffffff","align":"center","valign":"middle","wrap":true,"italic":true,"size":12,"format":"$#,##0.00","border":"all|outer|bottom|thickOuter|bottomDouble|none"}}
- {"op":"clear","range":"A1:B9","what":"contents|formats|all"}
- {"op":"insertRows","at":5,"count":2}  {"op":"deleteRows","at":5,"count":1}  {"op":"insertCols","at":"C","count":1}  {"op":"deleteCols","at":"C"}
- {"op":"addSheet","name":"Summary","color":"#087d8b"}  (later ops without "sheet" go to the newest added sheet)  {"op":"renameSheet","sheet":"Sheet1","name":"Data"}  {"op":"deleteSheet","sheet":"Old"}  {"op":"activateSheet","sheet":"Data"}
- {"op":"merge","range":"A1:F1"}  {"op":"colWidth","cols":"A:C","width":140}  {"op":"rowHeight","rows":"1:1","height":32}  {"op":"freeze","rows":1,"cols":0}  {"op":"gridlines","show":false} only when the user asks to hide gridlines
- {"op":"table","range":"A1:F25","name":"Sales","accent":1-6,"tone":"light|medium|dark","totals":false,"banded":true}
- {"op":"tableStyle","table":"Sales","accent":1-6,"tone":"light|medium|dark","banded":true,"filterButtons":true,"firstColumn":false}  restyles an existing table in place (its name, range, and formulas keep working); "table":"*" restyles every table. A new accent or tone also clears cell fills inside the table so the style shows; color a table with tableStyle, not format fills. Accents: 1 teal, 2 blue, 3 violet, 4 amber, 5 rose, 6 green.
- {"op":"chart","type":"column|bar|line|area|pie|doughnut|scatter","source":"A1:C13","title":"Revenue by month","at":"H2","width":520,"height":320,"seriesBy":"columns|rows","stacked":false,"legend":"bottom|right|top|none","showValues":false,"xTitle":"","yTitle":""}
  The source's first column is the category labels and its first row the series names.
- {"op":"pivot","source":"Data!A1:F200","sheet":"Pivot","at":"A3","rows":["Region"],"columns":["Quarter"],"values":[{"field":"Revenue","agg":"sum|count|average|min|max|countDistinct"}]}
- {"op":"conditional","range":"E2:E40","rule":{"type":"scale","min":"#f8d7da","mid":"#fff3cd","max":"#d1e7dd"}}  other rule types: {"type":"bar","color":"#087d8b"}, {"type":"cell","op":"gt|gte|lt|lte|eq|neq|between","value":"100","value2":"200","style":{"fill":"#fde2e1","color":"#9b1c1c","bold":true}}, {"type":"text","op":"contains","text":"Late","style":{...}}, {"type":"top","count":3,"style":{...}}, {"type":"duplicate","style":{...}}, {"type":"formula","formula":"=$E2<0","style":{...}}
- {"op":"validation","range":"C2:C100","kind":"list","items":["Open","Closed"]}  or kind "whole|decimal|date|textLength" with "op":"between","value":"1","value2":"10"
- {"op":"sort","range":"A1:F40","by":[{"col":"F","desc":true}],"header":true}  {"op":"filter","range":"A1:F40"}
- {"op":"note","cell":"B4","text":"Source: FY27 plan"}  {"op":"name","name":"TaxRate","ref":"Inputs!$B$2"}  {"op":"tabColor","sheet":"Data","color":"#2f6eba"}

Formula rules: Excel syntax and function names (SUM, SUMIFS, XLOOKUP, INDEX/MATCH, IFERROR, FILTER, SORT, UNIQUE, TEXT, EOMONTH, PMT, ...). Reference cells with A1 ranges (quote sheet names with spaces: 'Q1 Sales'!B2). Do not use structured table references, R1C1, macros, or external links. Every total, ratio, and derived number must be a live formula, never a typed result. Dates are real dates ("2027-03-15" or =DATE()), formatted with a date format.`;

export const SHEET_DESIGN_GUIDE = `Design like a senior financial analyst building a client-ready workbook:
- Lay out data as a clean table: one header row, one record per row, no blank rows or columns inside it.
- Header row: bold, accent fill (#087d8b teal or a table op), white text, frozen with {"op":"freeze","rows":1}.
- Apply number formats everywhere: currency "$#,##0.00" or "$#,##0", percentages "0.0%", thousands "#,##0", dates "mmm d, yyyy".
- Set sensible column widths (text 140–220px, numbers 100–130px). Wrap long text.
- Put inputs/assumptions in clearly labeled cells and reference them from formulas instead of repeating constants.
- Add totals and summary rows with SUM/AVERAGE/SUMIFS formulas, bold with a top border.
- Use a table op for record lists, a chart when a trend or comparison matters, and conditional formats to flag outliers.
- Anchor a chart two rows below its data or two columns to its right, so it never covers cells that hold values.
- Keep gridlines on, as Excel does, unless the user asks for a gridless report or dashboard.
- For multi-part requests, use several sheets (e.g. "Inputs", "Data", "Summary") and link them with formulas.
- Realistic, plausible sample data is fine when the user asks for a template; never invent facts presented as real.`;

export type SheetPromptInput = {
  instruction: string;
  workbook: Workbook;
  engine: WorkbookEngine;
  sheetId: string;
  selection?: CellRange;
  /** "cell": inline assistant on a selection; "workbook": Sheet Assistant. */
  scope: "cell" | "workbook";
  sources?: string;
  problems?: FormulaProblem[];
  previousReply?: string;
};

const CELL_SCOPE_GUIDE =
  "Scope: the user selected the range below and is asking about it. Keep changes inside or right next to the selection unless the request clearly needs more (for example a helper column or a summary below). If the user only asks a question (explain, analyze, what does this mean), answer in \"message\" and return an empty ops list. If they ask for a formula, write it into the selected cell(s).";

function problemLine(problem: FormulaProblem): string {
  return `${quoteSheetName(problem.sheetName)}!${problem.address}: =${problem.formula} → ${problem.error.code}${problem.error.message ? ` (${problem.error.message})` : ""}`;
}

export function buildSheetPrompt(input: SheetPromptInput): string {
  const sheet = input.workbook.sheets.find((item) => item.id === input.sheetId) ?? input.workbook.sheets[0];
  const blank = input.workbook.sheets.every((item) => Object.keys(item.cells).length === 0);
  const sections = [
    "You are the spreadsheet assistant inside Aperture Drafts, an Excel-compatible workbook editor. You change the workbook by returning operations; the editor applies them, recalculates, and shows the user a preview to accept.",
    SHEET_OPS_REFERENCE,
    SHEET_DESIGN_GUIDE,
  ];
  if (input.scope === "cell" && input.selection) sections.push(CELL_SCOPE_GUIDE, describeSelection(sheet, input.engine, input.selection));
  sections.push(blank ? "The workbook is empty: build it from scratch (rename Sheet1 to fit, or add sheets)." : describeWorkbook(input.workbook, input.engine, sheet.id, input.selection));
  if (input.sources) sections.push(`Reference material the user attached (use it as the source of truth for facts and numbers):\n${input.sources}`);
  if (input.problems?.length) {
    sections.push(`Your previous operations left formula errors. Fix them with new operations (rewrite the broken formulas; keep everything else). Errors:\n${input.problems.map(problemLine).join("\n")}`);
  }
  if (input.previousReply) sections.push(`Your previous reply was not valid JSON. Reply again with only the JSON object. Previous reply started: ${input.previousReply.slice(0, 400)}`);
  sections.push(`User request: ${input.instruction.trim()}`);
  return sections.join("\n\n");
}

/** Plain text of a workbook (values as displayed), for titles and search. */
export function workbookPlainText(workbook: Workbook, engine: WorkbookEngine, limit = 4000): string {
  const parts: string[] = [];
  let size = 0;
  for (const sheet of workbook.sheets) {
    parts.push(`# ${sheet.name}`);
    const used = engine.usedRange(sheet.id);
    if (!used) continue;
    for (let row = used.r1; row <= used.r2 && size < limit; row += 1) {
      const line = plainRow(sheet, engine, row, used);
      if (line === null) continue;
      parts.push(line);
      size += line.length;
    }
  }
  return parts.join("\n").slice(0, limit);
}

/** A row's displayed values, tab-separated; null when the row is blank. */
function plainRow(sheet: Sheet, engine: WorkbookEngine, row: number, used: CellRange): string | null {
  const cells: string[] = [];
  for (let col = used.c1; col <= used.c2; col += 1) {
    const value = engine.value(sheet.id, row, col);
    if (!isBlank(value)) cells.push(displayValue(value, effectiveStyle(sheet, row, col)?.format));
  }
  return cells.length ? cells.join("\t") : null;
}

export function columnLetters(range: CellRange): string {
  return `${columnLabel(range.c1)}${range.c1 === range.c2 ? "" : `:${columnLabel(range.c2)}`}`;
}
