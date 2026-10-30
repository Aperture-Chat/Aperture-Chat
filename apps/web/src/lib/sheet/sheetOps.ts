/** Pure workbook edits. Every function returns a new Workbook and leaves its
 * input untouched, so the editor keeps undo history as a stack of snapshots
 * and AI edits can be previewed before they are accepted.
 *
 * Structure edits (insert/delete rows and columns, sheet rename/delete) keep
 * every reference in sync the way Excel does: formulas on every sheet, and the
 * ranges stored on tables, charts, pivots, rules, validations, filters,
 * merges, and defined names.
 */

import {
  type CellRange,
  MAX_SHEET_COLS,
  MAX_SHEET_ROWS,
  cellKey,
  columnIndex,
  columnLabel,
  formatRangeRef,
  forEachCellInRange,
  parseCellKey,
  parseRangeRef,
  quoteSheetName,
  rangeContains,
  rangesIntersect,
  splitSheetQualifiedRef,
} from "./address";
import {
  type Axis,
  adjustFormulaForDelete,
  adjustFormulaForInsert,
  invalidateSheetInFormula,
  renameSheetInFormula,
  shiftFormula,
  shiftRangeForDelete,
  shiftRangeForInsert,
} from "./formula/references";
import { compareScalars, type Scalar } from "./formula/values";
import { parseCellInput } from "./numberFormat";
import {
  type CellBorder,
  type CellBorders,
  type CellStyle,
  type Sheet,
  type SheetCell,
  type SheetTable,
  type Workbook,
  MAX_SHEETS,
  createWorksheet,
  nextObjectId,
  sheetNameProblem,
  uniqueSheetName,
} from "./sheetModel";

/* ------------------------------------------------------------------ basics */

export function updateSheet(workbook: Workbook, sheetId: string, update: (sheet: Sheet) => Sheet): Workbook {
  let changed = false;
  const sheets = workbook.sheets.map((sheet) => {
    if (sheet.id !== sheetId) return sheet;
    const next = update(sheet);
    if (next !== sheet) changed = true;
    return next;
  });
  return changed ? { ...workbook, sheets } : workbook;
}

export function getCell(sheet: Sheet, row: number, col: number): SheetCell | undefined {
  return sheet.cells[cellKey(row, col)];
}

type CellUpdate = { row: number; col: number; cell: SheetCell | null };

function cellIsEmpty(cell: SheetCell): boolean {
  return cell.v === undefined && cell.f === undefined && cell.s === undefined && cell.n === undefined;
}

/** Writes cells; a null or empty cell removes the entry. */
export function writeCells(sheet: Sheet, updates: { row: number; col: number; cell: SheetCell | null }[]): Sheet {
  if (!updates.length) return sheet;
  const cells = { ...sheet.cells };
  for (const { row, col, cell } of updates) {
    if (row < 0 || col < 0 || row >= MAX_SHEET_ROWS || col >= MAX_SHEET_COLS) continue;
    const address = cellKey(row, col);
    if (!cell || cellIsEmpty(cell)) delete cells[address];
    else cells[address] = cell;
  }
  return { ...sheet, cells };
}

/** What the formula bar shows for a cell: "=" + formula, or the literal. */
export function cellInputText(cell: SheetCell | undefined): string {
  if (!cell) return "";
  if (cell.f !== undefined) return `=${cell.f}`;
  if (cell.v === undefined) return "";
  if (typeof cell.v === "boolean") return cell.v ? "TRUE" : "FALSE";
  if (typeof cell.v === "string") return textInputText(cell.v);
  return String(cell.v);
}

/** Text that would re-enter as a number, date, or formula keeps Excel's
 * leading apostrophe so editing the cell does not change its type. */
function textInputText(text: string): string {
  const parsed = parseCellInput(text);
  const changesType = parsed.kind === "formula" || (parsed.kind === "value" && typeof parsed.value !== "string");
  return changesType || text.startsWith("'") ? `'${text}` : text;
}

/** Applies typed text to a cell, the way pressing Enter in Excel does: a
 * number typed as "$1,200" stores 1200 and, if the cell has no number format
 * yet, picks up the currency format it was typed in. */
export function cellFromInput(existing: SheetCell | undefined, input: string): SheetCell | null {
  const parsed = parseCellInput(input);
  const base = styleAndNote(existing);
  if (parsed.kind === "empty") return cellIsEmpty(base) ? null : base;
  if (parsed.kind === "formula") return { ...base, f: parsed.formula.trim() };
  return withTypedFormat({ ...base, v: parsed.value }, existing, parsed.format);
}

/** A number typed in a format ("$1,200") gives the cell that format unless it already has one. */
function withTypedFormat(next: SheetCell, existing: SheetCell | undefined, format: string | undefined): SheetCell {
  if (format && !existing?.s?.format) next.s = { ...existing?.s, format };
  return next;
}

/** What typing over a cell keeps: its style and its note. */
function styleAndNote(existing: SheetCell | undefined): SheetCell {
  const base: SheetCell = {};
  if (existing?.s) base.s = existing.s;
  if (existing?.n) base.n = existing.n;
  return base;
}

export function setCellInput(workbook: Workbook, sheetId: string, row: number, col: number, input: string): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => writeCells(sheet, [{ row, col, cell: cellFromInput(getCell(sheet, row, col), input) }]));
}

/** Writes the same input into every cell of a range (Ctrl+Enter); relative
 * references shift per cell like a fill. */
export function setRangeInput(workbook: Workbook, sheetId: string, range: CellRange, input: string): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => {
    const updates: { row: number; col: number; cell: SheetCell | null }[] = [];
    forEachCellInRange(range, (row, col) => {
      const cell = cellFromInput(getCell(sheet, row, col), input);
      if (cell?.f) cell.f = shiftFormula(cell.f, row - range.r1, col - range.c1);
      updates.push({ row, col, cell });
    });
    return writeCells(sheet, updates);
  });
}

/* ------------------------------------------------------------------ clearing */

export type ClearMode = "all" | "contents" | "formats" | "notes";

export function clearRange(workbook: Workbook, sheetId: string, range: CellRange, mode: ClearMode = "contents"): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => {
    const updates: CellUpdate[] = [];
    for (const [address, cell] of Object.entries(sheet.cells)) {
      const point = parseCellKey(address)!;
      if (rangeContains(range, point.row, point.col)) updates.push({ row: point.row, col: point.col, cell: clearedCell(cell, mode) });
    }
    const next = writeCells(sheet, updates);
    if (mode !== "all") return next;
    return { ...next, merges: next.merges?.filter((merge) => !rangesIntersect(parseRangeRef(merge)!, range)) };
  });
}

function clearedCell(cell: SheetCell, mode: ClearMode): SheetCell | null {
  if (mode === "all") return null;
  const next = clearedParts(cell, mode);
  return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as SheetCell;
}

/** Contents keep the style and note; formats and notes drop only themselves. */
function clearedParts(cell: SheetCell, mode: ClearMode): SheetCell {
  if (mode === "contents") return { ...(cell.s ? { s: cell.s } : {}), ...(cell.n ? { n: cell.n } : {}) };
  return mode === "formats" ? { ...cell, s: undefined } : { ...cell, n: undefined };
}

/* ------------------------------------------------------------------ styles */

export type StylePatch = Partial<{ [K in keyof CellStyle]: CellStyle[K] | null }>;

/** Merges a patch into a style; null removes a key. Returns undefined when empty. */
export function patchStyle(style: CellStyle | undefined, patch: StylePatch): CellStyle | undefined {
  const next: Record<string, unknown> = { ...(style ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length ? (next as CellStyle) : undefined;
}

function isWholeColumns(range: CellRange): boolean {
  return range.r1 === 0 && range.r2 === MAX_SHEET_ROWS - 1;
}

function isWholeRows(range: CellRange): boolean {
  return range.c1 === 0 && range.c2 === MAX_SHEET_COLS - 1;
}

/** Applies a style patch to a range. Whole columns and whole rows store the
 * style on the column/row (as Excel does) as well as on existing cells. */
export function applyStyle(workbook: Workbook, sheetId: string, range: CellRange, patch: StylePatch): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => {
    const updates: CellUpdate[] = [];
    const touch = (row: number, col: number) => {
      const cell = getCell(sheet, row, col) ?? {};
      updates.push({ row, col, cell: { ...cell, s: patchStyle(cell.s, patch) } });
    };
    const whole = isWholeColumns(range) || isWholeRows(range);
    if (!whole) forEachCellInRange(range, touch);
    else {
      for (const address of Object.keys(sheet.cells)) {
        const point = parseCellKey(address)!;
        if (rangeContains(range, point.row, point.col)) touch(point.row, point.col);
      }
    }
    return writeCells(whole ? withLineStyles(sheet, range, patch) : sheet, updates);
  });
}

/** Whole columns (or rows) keep the style on the column (or row) too. */
function withLineStyles(sheet: Sheet, range: CellRange, patch: StylePatch): Sheet {
  if (isWholeColumns(range)) return { ...sheet, cols: patchedLines(sheet.cols, range.c1, range.c2, columnLabel, patch) };
  return { ...sheet, rows: patchedLines(sheet.rows, range.r1, range.r2, (row) => String(row + 1), patch) };
}

function patchedLines<T extends { s?: CellStyle }>(map: Record<string, T> | undefined, from: number, to: number, label: (index: number) => string, patch: StylePatch): Record<string, T> {
  const lines = { ...(map ?? {}) };
  for (let index = from; index <= to; index += 1) {
    const key = label(index);
    const entry = { ...(lines[key] ?? {}), s: patchStyle(lines[key]?.s, patch) };
    if (!entry.s) delete entry.s;
    if (Object.keys(entry).length) lines[key] = entry as T;
    else delete lines[key];
  }
  return lines;
}

function lineStyle(lines: Record<string, { s?: CellStyle }> | undefined, key: string): CellStyle | undefined {
  return lines?.[key]?.s;
}

/** The effective style of a cell: column, then row, then the cell itself. */
export function effectiveStyle(sheet: Sheet, row: number, col: number): CellStyle | undefined {
  const colStyle = lineStyle(sheet.cols, columnLabel(col));
  const rowStyle = lineStyle(sheet.rows, String(row + 1));
  const cellStyle = sheet.cells[cellKey(row, col)]?.s;
  if (!colStyle && !rowStyle) return cellStyle;
  return { ...colStyle, ...rowStyle, ...cellStyle };
}

export type BorderPreset = "all" | "outer" | "inner" | "top" | "bottom" | "left" | "right" | "thickOuter" | "bottomDouble" | "none";

type BorderSide = "top" | "bottom" | "left" | "right";
const BORDER_SIDES: readonly BorderSide[] = ["top", "bottom", "left", "right"];
/** Which outside edges of the range a cell sits on. */
type CellEdges = Record<BorderSide, boolean>;
type BorderLines = { thin: CellBorder; thick: CellBorder; double: CellBorder };
type BorderRule = (border: CellBorders, edges: CellEdges, lines: BorderLines) => void;

function borderLines(color: string | undefined): BorderLines {
  const tint = color ? { color } : {};
  return { thin: { style: "thin", ...tint }, thick: { style: "medium", ...tint }, double: { style: "double", ...tint } };
}

function cellEdges(range: CellRange, row: number, col: number): CellEdges {
  return { top: row === range.r1, bottom: row === range.r2, left: col === range.c1, right: col === range.c2 };
}

function noBorders(border: CellBorders): void {
  for (const side of BORDER_SIDES) delete border[side];
}

function allBorders(border: CellBorders, _edges: CellEdges, lines: BorderLines): void {
  Object.assign(border, { top: lines.thin, bottom: lines.thin, left: lines.thin, right: lines.thin });
}

function outerBorders(weight: "thin" | "thick"): BorderRule {
  return (border, edges, lines) => {
    for (const side of BORDER_SIDES) if (edges[side]) border[side] = lines[weight];
  };
}

/** Lines between cells: under every row but the last, right of every column but the last. */
function innerBorders(border: CellBorders, edges: CellEdges, lines: BorderLines): void {
  if (!edges.bottom) border.bottom = lines.thin;
  if (!edges.right) border.right = lines.thin;
}

function bottomDoubleBorder(border: CellBorders, edges: CellEdges, lines: BorderLines): void {
  if (edges.bottom) border.bottom = lines.double;
}

function sideBorder(side: BorderSide): BorderRule {
  return (border, edges, lines) => {
    if (edges[side]) border[side] = lines.thin;
  };
}

const BORDER_RULES = new Map<BorderPreset, BorderRule>([
  ["none", noBorders],
  ["all", allBorders],
  ["outer", outerBorders("thin")],
  ["thickOuter", outerBorders("thick")],
  ["inner", innerBorders],
  ["bottomDouble", bottomDoubleBorder],
  ["top", sideBorder("top")],
  ["bottom", sideBorder("bottom")],
  ["left", sideBorder("left")],
  ["right", sideBorder("right")],
]);

export function applyBorders(workbook: Workbook, sheetId: string, range: CellRange, preset: BorderPreset, color?: string): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => {
    const updates: CellUpdate[] = [];
    forEachCellInRange(range, (row, col) => {
      const cell = getCell(sheet, row, col) ?? {};
      const border = { ...(cell.s?.border ?? {}) };
      BORDER_RULES.get(preset)?.(border, cellEdges(range, row, col), borderLines(color));
      const hasBorder = Object.keys(border).length > 0;
      updates.push({ row, col, cell: { ...cell, s: patchStyle(cell.s, { border: hasBorder ? border : null }) } });
    });
    return writeCells(sheet, updates);
  });
}

/* ------------------------------------------------------------------ dimensions */

export function setColumnWidth(workbook: Workbook, sheetId: string, c1: number, c2: number, width: number | null): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => {
    const cols = { ...(sheet.cols ?? {}) };
    for (let col = c1; col <= c2; col += 1) {
      const letter = columnLabel(col);
      const entry = { ...(cols[letter] ?? {}) };
      if (width === null) delete entry.w;
      else entry.w = Math.round(Math.min(2000, Math.max(24, width)));
      if (Object.keys(entry).length) cols[letter] = entry;
      else delete cols[letter];
    }
    return { ...sheet, cols };
  });
}

export function setRowHeight(workbook: Workbook, sheetId: string, r1: number, r2: number, height: number | null): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => {
    const rows = { ...(sheet.rows ?? {}) };
    for (let row = r1; row <= r2; row += 1) {
      const label = String(row + 1);
      const entry = { ...(rows[label] ?? {}) };
      if (height === null) delete entry.h;
      else entry.h = Math.round(Math.min(1000, Math.max(18, height)));
      if (Object.keys(entry).length) rows[label] = entry;
      else delete rows[label];
    }
    return { ...sheet, rows };
  });
}

export function setHidden(workbook: Workbook, sheetId: string, axis: Axis, start: number, end: number, hidden: boolean): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => {
    const map = { ...((axis === "cols" ? sheet.cols : sheet.rows) ?? {}) } as Record<string, { hidden?: boolean }>;
    for (let index = start; index <= end; index += 1) {
      const label = axis === "cols" ? columnLabel(index) : String(index + 1);
      const entry = { ...(map[label] ?? {}) };
      if (hidden) entry.hidden = true;
      else delete entry.hidden;
      if (Object.keys(entry).length) map[label] = entry;
      else delete map[label];
    }
    return axis === "cols" ? { ...sheet, cols: map } : { ...sheet, rows: map };
  });
}

export function setFreeze(workbook: Workbook, sheetId: string, rows: number, cols: number): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => {
    const next = { ...sheet };
    if (rows > 0 || cols > 0) next.freeze = { rows: Math.max(0, rows), cols: Math.max(0, cols) };
    else delete next.freeze;
    return next;
  });
}

/* ------------------------------------------------------------------ merges */

export function mergeRange(workbook: Workbook, sheetId: string, range: CellRange): Workbook {
  if (range.r1 === range.r2 && range.c1 === range.c2) return workbook;
  return updateSheet(workbook, sheetId, (sheet) => {
    const kept = (sheet.merges ?? []).filter((merge) => !rangesIntersect(parseRangeRef(merge)!, range));
    return { ...writeCells(sheet, mergedAwayValues(sheet, range)), merges: [...kept, formatRangeRef(range)] };
  });
}

/** Excel keeps only the top-left value of a merged area; the other cells keep just their style. */
function mergedAwayValues(sheet: Sheet, range: CellRange): CellUpdate[] {
  const updates: CellUpdate[] = [];
  forEachCellInRange(range, (row, col) => {
    if (row === range.r1 && col === range.c1) return;
    const cell = getCell(sheet, row, col);
    if (cell && (cell.v !== undefined || cell.f !== undefined)) updates.push({ row, col, cell: cell.s ? { s: cell.s } : null });
  });
  return updates;
}

export function unmergeRange(workbook: Workbook, sheetId: string, range: CellRange): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => {
    const merges = (sheet.merges ?? []).filter((merge) => !rangesIntersect(parseRangeRef(merge)!, range));
    return merges.length === (sheet.merges ?? []).length ? sheet : { ...sheet, merges: merges.length ? merges : undefined };
  });
}

export function mergeAt(sheet: Sheet, row: number, col: number): CellRange | null {
  for (const merge of sheet.merges ?? []) {
    const range = parseRangeRef(merge);
    if (range && rangeContains(range, row, col)) return range;
  }
  return null;
}

/* ------------------------------------------------------------------ structure */

function adjustLocalRangeText(text: string, change: (range: CellRange) => CellRange | null): string | null {
  const range = parseRangeRef(text);
  if (!range) return text;
  const next = change(range);
  return next ? formatRangeRef(next) : null;
}

function adjustQualifiedRangeText(text: string, hostSheet: string, targetSheet: string, change: (range: CellRange) => CellRange | null): string | null {
  const { sheet, ref } = splitSheetQualifiedRef(text);
  if ((sheet ?? hostSheet).toLowerCase() !== targetSheet.toLowerCase()) return text;
  const next = adjustLocalRangeText(ref, change);
  if (next === null) return null;
  return sheet === null ? next : `${quoteSheetName(sheet)}!${next}`;
}

function adjustCellText(text: string, change: (range: CellRange) => CellRange | null): string | null {
  const point = parseCellKey(text);
  if (!point) return text;
  const next = change({ r1: point.row, c1: point.col, r2: point.row, c2: point.col });
  return next ? cellKey(next.r1, next.c1) : null;
}

type RangeChange = (range: CellRange) => CellRange | null;
type QualifiedChange = (text: string) => string | null;

/** Re-anchors everything on `sheet` that names a range on `targetSheet`. */
function adjustSheetObjects(sheet: Sheet, targetSheet: string, change: RangeChange, local: boolean): Sheet {
  const qualified = (text: string) => adjustQualifiedRangeText(text, sheet.name, targetSheet, change);
  const anchorChange = local ? change : null;
  const next: Sheet = local ? { ...sheet, ...reanchoredLocalObjects(sheet, change) } : { ...sheet };
  next.charts = movedCharts(sheet.charts, qualified, anchorChange);
  next.pivots = movedPivots(sheet.pivots, qualified, anchorChange);
  next.validations = next.validations?.map((rule) => (rule.source ? { ...rule, source: qualified(rule.source) ?? undefined } : rule));
  dropEmptyObjects(next);
  return next;
}

/** Objects that only ever name ranges on their own sheet. */
function reanchoredLocalObjects(sheet: Sheet, change: RangeChange): Partial<Sheet> {
  return {
    merges: sheet.merges?.map((merge) => adjustLocalRangeText(merge, change)).filter((merge): merge is string => Boolean(merge && merge.includes(":"))),
    tables: reanchored(sheet.tables, change),
    conditional: reanchored(sheet.conditional, change),
    validations: reanchored(sheet.validations, change),
    ...(sheet.filter ? { filter: reanchoredFilter(sheet.filter, change) } : {}),
  };
}

/** Items whose range survives the change, moved; the rest are dropped. */
function reanchored<T extends { ref: string }>(items: T[] | undefined, change: RangeChange): T[] | undefined {
  return items?.flatMap((item) => {
    const ref = adjustLocalRangeText(item.ref, change);
    return ref ? [{ ...item, ref }] : [];
  });
}

function reanchoredFilter(filter: NonNullable<Sheet["filter"]>, change: RangeChange): Sheet["filter"] {
  const ref = adjustLocalRangeText(filter.ref, change);
  return ref ? { ...filter, ref } : undefined;
}

/** Charts follow their source; their anchor moves only on the edited sheet (and stays if it was deleted). */
function movedCharts(charts: Sheet["charts"], qualified: QualifiedChange, anchorChange: RangeChange | null): Sheet["charts"] {
  return charts?.flatMap((chart) => {
    const source = qualified(chart.source);
    const at = anchorChange ? adjustCellText(chart.at, anchorChange) ?? chart.at : chart.at;
    return source ? [{ ...chart, source, at }] : [];
  });
}

/** Pivots follow their source and anchor; a deleted anchor drops the pivot. */
function movedPivots(pivots: Sheet["pivots"], qualified: QualifiedChange, anchorChange: RangeChange | null): Sheet["pivots"] {
  return pivots?.flatMap((pivot) => {
    const source = qualified(pivot.source);
    const at = anchorChange ? adjustCellText(pivot.at, anchorChange) : pivot.at;
    return source && at ? [{ ...pivot, source, at }] : [];
  });
}

function dropEmptyObjects(sheet: Sheet): void {
  for (const key of ["merges", "tables", "conditional", "validations", "charts", "pivots"] as const) {
    if (Array.isArray(sheet[key]) && !(sheet[key] as unknown[]).length) delete sheet[key];
  }
  if (!sheet.filter) delete sheet.filter;
}

/** How column letters and row numbers key the size and style maps. */
const AXIS_KEYS: Record<Axis, { index: (key: string) => number; key: (index: number) => string; limit: number }> = {
  cols: { index: columnIndex, key: columnLabel, limit: MAX_SHEET_COLS },
  rows: { index: (key) => Number(key) - 1, key: (index) => String(index + 1), limit: MAX_SHEET_ROWS },
};

function moveDimensionMap<T>(map: Record<string, T> | undefined, axis: Axis, remap: (index: number) => number | null): Record<string, T> | undefined {
  if (!map) return map;
  const keys = AXIS_KEYS[axis];
  const out: Record<string, T> = {};
  for (const [label, value] of Object.entries(map)) {
    const next = remap(keys.index(label));
    if (next === null || next < 0 || next >= keys.limit) continue;
    out[keys.key(next)] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** One row or column insert or delete, as the functions each part of the workbook needs. */
type StructureChange = {
  axis: Axis;
  /** The edited sheet's name. */
  target: string;
  /** New index of a row or column on the edited sheet; null when it was deleted. */
  remap: (index: number) => number | null;
  change: RangeChange;
  adjust: (formula: string, host: string) => string;
};

function insertChange(axis: Axis, at: number, count: number, target: string): StructureChange {
  return {
    axis,
    target,
    remap: (index) => (index >= at ? index + count : index),
    change: (range) => shiftRangeForInsert(range, axis, at, count),
    adjust: (formula, host) => adjustFormulaForInsert(formula, host, target, axis, at, count),
  };
}

function deleteChange(axis: Axis, at: number, count: number, target: string): StructureChange {
  return {
    axis,
    target,
    remap: (index) => indexAfterDelete(index, at, count),
    change: (range) => shiftRangeForDelete(range, axis, at, count),
    adjust: (formula, host) => adjustFormulaForDelete(formula, host, target, axis, at, count),
  };
}

function indexAfterDelete(index: number, at: number, count: number): number | null {
  if (index >= at && index < at + count) return null;
  return index >= at + count ? index - count : index;
}

function structureEdit(workbook: Workbook, sheetId: string, axis: Axis, at: number, count: number, kind: "insert" | "delete"): Workbook {
  const target = workbook.sheets.find((sheet) => sheet.id === sheetId);
  if (!target || count <= 0) return workbook;
  const edit = kind === "insert" ? insertChange(axis, at, count, target.name) : deleteChange(axis, at, count, target.name);
  const sheets = workbook.sheets.map((sheet) => editedSheet(sheet, sheet.id === sheetId, edit));
  const names = workbook.names?.flatMap((name) => {
    const ref = adjustQualifiedRangeText(name.ref, workbook.sheets[0].name, target.name, edit.change);
    return ref ? [{ ...name, ref }] : [];
  });
  return { ...workbook, sheets, ...(names?.length ? { names } : { names: undefined }) };
}

/** A sheet after the edit: every formula adjusted, and on the edited sheet the cells, sizes, and objects moved. */
function editedSheet(sheet: Sheet, local: boolean, edit: StructureChange): Sheet {
  let next: Sheet = { ...sheet, cells: editedCells(sheet, local, edit) };
  if (local) moveDimensions(next, sheet, edit);
  next = adjustSheetObjects(next, edit.target, edit.change, local);
  if (next.conditional) {
    next.conditional = next.conditional.map((rule) => (rule.type === "formula" ? { ...rule, formula: edit.adjust(rule.formula, sheet.name) } : rule));
  }
  return next;
}

function editedCells(sheet: Sheet, local: boolean, edit: StructureChange): Record<string, SheetCell> {
  const cells: Record<string, SheetCell> = {};
  for (const [address, cell] of Object.entries(sheet.cells)) {
    const point = local ? movedPoint(parseCellKey(address)!, edit) : parseCellKey(address)!;
    if (!point) continue;
    cells[cellKey(point.row, point.col)] = cell.f ? { ...cell, f: edit.adjust(cell.f, sheet.name) } : cell;
  }
  return cells;
}

/** Where a cell on the edited sheet moves; null when its row or column was deleted or pushed off the sheet. */
function movedPoint(point: { row: number; col: number }, edit: StructureChange): { row: number; col: number } | null {
  const rows = edit.axis === "rows";
  const moved = edit.remap(rows ? point.row : point.col);
  if (moved === null || moved >= (rows ? MAX_SHEET_ROWS : MAX_SHEET_COLS)) return null;
  return rows ? { row: moved, col: point.col } : { row: point.row, col: moved };
}

function moveDimensions(next: Sheet, sheet: Sheet, edit: StructureChange): void {
  if (edit.axis === "cols") next.cols = moveDimensionMap(sheet.cols, "cols", edit.remap);
  else next.rows = moveDimensionMap(sheet.rows, "rows", edit.remap);
  if (!next.cols) delete next.cols;
  if (!next.rows) delete next.rows;
}

export function insertRows(workbook: Workbook, sheetId: string, at: number, count = 1): Workbook {
  return structureEdit(workbook, sheetId, "rows", at, count, "insert");
}

export function deleteRows(workbook: Workbook, sheetId: string, at: number, count = 1): Workbook {
  return structureEdit(workbook, sheetId, "rows", at, count, "delete");
}

export function insertCols(workbook: Workbook, sheetId: string, at: number, count = 1): Workbook {
  return structureEdit(workbook, sheetId, "cols", at, count, "insert");
}

export function deleteCols(workbook: Workbook, sheetId: string, at: number, count = 1): Workbook {
  return structureEdit(workbook, sheetId, "cols", at, count, "delete");
}

/* ------------------------------------------------------------------ sheets */

export function addSheet(workbook: Workbook, name?: string, afterId?: string): { workbook: Workbook; sheetId: string } {
  if (workbook.sheets.length >= MAX_SHEETS) return { workbook, sheetId: workbook.sheets.at(-1)!.id };
  const id = nextObjectId("sheet", workbook.sheets);
  const sheet = createWorksheet(uniqueSheetName(name ?? `Sheet${workbook.sheets.length + 1}`, workbook.sheets), id);
  const index = afterId ? workbook.sheets.findIndex((item) => item.id === afterId) + 1 : workbook.sheets.length;
  const sheets = workbook.sheets.slice();
  sheets.splice(index > 0 ? index : sheets.length, 0, sheet);
  return { workbook: { ...workbook, sheets }, sheetId: id };
}

export function duplicateSheet(workbook: Workbook, sheetId: string): { workbook: Workbook; sheetId: string } {
  const source = workbook.sheets.find((sheet) => sheet.id === sheetId);
  if (!source || workbook.sheets.length >= MAX_SHEETS) return { workbook, sheetId };
  const id = nextObjectId("sheet", workbook.sheets);
  const name = uniqueSheetName(source.name, workbook.sheets);
  const tableNames = new Set(workbook.sheets.flatMap((sheet) => (sheet.tables ?? []).map((table) => table.name.toLowerCase())));
  const tables = source.tables?.map((table) => {
    let candidate = `${table.name}_2`;
    for (let n = 3; tableNames.has(candidate.toLowerCase()); n += 1) candidate = `${table.name}_${n}`;
    tableNames.add(candidate.toLowerCase());
    return { ...table, name: candidate, id: candidate };
  });
  const copy: Sheet = { ...structuredClone(source), id, name, ...(tables ? { tables } : {}) };
  delete copy.hidden;
  const index = workbook.sheets.findIndex((sheet) => sheet.id === sheetId);
  const sheets = workbook.sheets.slice();
  sheets.splice(index + 1, 0, copy);
  return { workbook: { ...workbook, sheets }, sheetId: id };
}

export function renameSheet(workbook: Workbook, sheetId: string, rawName: string): { workbook: Workbook; error?: string } {
  const sheet = workbook.sheets.find((item) => item.id === sheetId);
  const name = rawName.trim();
  if (!sheet || name === sheet.name) return { workbook };
  const error = renameProblem(workbook, sheetId, name);
  if (error) return { workbook, error };
  const oldName = sheet.name;
  const renameRange = (text: string) => renamedRange(text, oldName, name);
  const sheets = workbook.sheets.map((item) => {
    const next: Sheet = { ...item, cells: renamedCells(item.cells, oldName, name), ...(item.id === sheetId ? { name } : {}) };
    renameObjectSources(next, item, renameRange);
    return next;
  });
  const names = workbook.names?.map((item) => ({ ...item, ref: renameRange(item.ref) }));
  return { workbook: { ...workbook, sheets, ...(names ? { names } : {}) } };
}

function renameProblem(workbook: Workbook, sheetId: string, name: string): string | null {
  const problem = sheetNameProblem(name);
  if (problem) return problem;
  const taken = workbook.sheets.some((item) => item.id !== sheetId && item.name.toLowerCase() === name.toLowerCase());
  return taken ? `A sheet named "${name}" already exists.` : null;
}

function renamedRange(text: string, oldName: string, name: string): string {
  const split = splitSheetQualifiedRef(text);
  return split.sheet && split.sheet.toLowerCase() === oldName.toLowerCase() ? `${quoteSheetName(name)}!${split.ref}` : text;
}

function renamedCells(cells: Record<string, SheetCell>, oldName: string, name: string): Record<string, SheetCell> {
  const next: Record<string, SheetCell> = {};
  for (const [address, cell] of Object.entries(cells)) next[address] = cell.f ? { ...cell, f: renameSheetInFormula(cell.f, oldName, name) } : cell;
  return next;
}

function renameObjectSources(next: Sheet, item: Sheet, renameRange: (text: string) => string): void {
  if (item.charts) next.charts = item.charts.map((chart) => ({ ...chart, source: renameRange(chart.source) }));
  if (item.pivots) next.pivots = item.pivots.map((pivot) => ({ ...pivot, source: renameRange(pivot.source) }));
  if (item.validations) next.validations = item.validations.map((rule) => (rule.source ? { ...rule, source: renameRange(rule.source) } : rule));
}

export function deleteSheet(workbook: Workbook, sheetId: string): Workbook {
  if (workbook.sheets.length <= 1) return workbook;
  const target = workbook.sheets.find((sheet) => sheet.id === sheetId);
  if (!target) return workbook;
  const sheets = workbook.sheets.filter((sheet) => sheet.id !== sheetId).map((sheet) => withoutSheetRefs(sheet, target.name));
  if (sheets.every((sheet) => sheet.hidden)) sheets[0] = { ...sheets[0], hidden: undefined };
  const names = workbook.names?.filter((item) => !refersToSheet(item.ref, target.name));
  return { ...workbook, sheets, names: names?.length ? names : undefined };
}

function refersToSheet(text: string, name: string): boolean {
  return splitSheetQualifiedRef(text).sheet?.toLowerCase() === name.toLowerCase();
}

/** Formulas pointing at the deleted sheet become #REF!; charts and pivots fed by it go. */
function withoutSheetRefs(sheet: Sheet, name: string): Sheet {
  const cells: Record<string, SheetCell> = {};
  for (const [address, cell] of Object.entries(sheet.cells)) cells[address] = cell.f ? { ...cell, f: invalidateSheetInFormula(cell.f, name) } : cell;
  const next: Sheet = { ...sheet, cells };
  if (sheet.charts) next.charts = sheet.charts.filter((chart) => !refersToSheet(chart.source, name));
  if (sheet.pivots) next.pivots = sheet.pivots.filter((pivot) => !refersToSheet(pivot.source, name));
  return next;
}

export function moveSheet(workbook: Workbook, sheetId: string, toIndex: number): Workbook {
  const from = workbook.sheets.findIndex((sheet) => sheet.id === sheetId);
  if (from < 0) return workbook;
  const sheets = workbook.sheets.slice();
  const [sheet] = sheets.splice(from, 1);
  sheets.splice(Math.max(0, Math.min(sheets.length, toIndex)), 0, sheet);
  return { ...workbook, sheets };
}

/** A table's look: what Excel's Table Design gallery and style options change. */
export type TableStylePatch = Partial<Pick<SheetTable, "accent" | "tone" | "banded" | "filterButtons" | "firstColumn">>;

/** Restyles one table, or every table in the workbook, in place: names,
 * ranges, totals rows, and the formulas that read them are untouched. */
export function restyleTables(workbook: Workbook, patch: TableStylePatch, only?: { sheetId: string; tableId: string }): Workbook {
  const style = (table: SheetTable): SheetTable => {
    const next = { ...table, ...patch };
    if (!next.firstColumn) delete next.firstColumn;
    return next;
  };
  return {
    ...workbook,
    sheets: workbook.sheets.map((sheet) => {
      if (!sheet.tables?.length || (only && sheet.id !== only.sheetId)) return sheet;
      return { ...sheet, tables: sheet.tables.map((table) => (!only || table.id === only.tableId ? style(table) : table)) };
    }),
  };
}

export function setSheetProps(workbook: Workbook, sheetId: string, props: Partial<Pick<Sheet, "color" | "hidden" | "gridlines">>): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => {
    const next: Sheet = { ...sheet, ...props };
    if (!next.color) delete next.color;
    if (!next.hidden) delete next.hidden;
    if (next.gridlines !== false) delete next.gridlines;
    return next;
  });
}

/* ------------------------------------------------------------------ sort */

export type SortKey = { col: number; desc: boolean };

/** Sorts the rows of a range by one or more columns. Empty values sort last
 * in both directions, as in Excel; formulas shift with their row. */
export function sortRange(
  workbook: Workbook,
  sheetId: string,
  range: CellRange,
  keys: SortKey[],
  valueOf: (row: number, col: number) => Scalar,
  hasHeader = false,
): Workbook {
  const first = hasHeader ? range.r1 + 1 : range.r1;
  if (first >= range.r2 || !keys.length) return workbook;
  return updateSheet(workbook, sheetId, (sheet) => {
    const rows: number[] = [];
    for (let row = first; row <= range.r2; row += 1) rows.push(row);
    const sorted = rows.slice().sort((a, b) => compareRows(a, b, keys, valueOf));
    return writeCells(sheet, movedRowUpdates(sheet, sorted, first, range));
  });
}

/** Compares two rows key by key; ties keep their original order. */
function compareRows(a: number, b: number, keys: SortKey[], valueOf: (row: number, col: number) => Scalar): number {
  for (const key of keys) {
    const order = keyOrder(valueOf(a, key.col), valueOf(b, key.col), key.desc);
    if (order) return order;
  }
  return a - b;
}

/** Blanks sort last whichever way the key runs. */
function keyOrder(x: Scalar, y: Scalar, desc: boolean): number {
  const blankX = x === null || x === "";
  const blankY = y === null || y === "";
  if (blankX !== blankY) return blankX ? 1 : -1;
  const order = compareScalars(x, y);
  return desc ? -order : order;
}

/** Writes each source row (undefined for none) into consecutive rows from `first`, shifting formulas with their row. */
function movedRowUpdates(sheet: Sheet, fromRows: (number | undefined)[], first: number, range: CellRange): CellUpdate[] {
  const updates: CellUpdate[] = [];
  fromRows.forEach((fromRow, index) => {
    const toRow = first + index;
    for (let col = range.c1; col <= range.c2; col += 1) updates.push({ row: toRow, col, cell: fromRow === undefined ? null : rowMovedCell(sheet, fromRow, toRow, col) });
  });
  return updates;
}

function rowMovedCell(sheet: Sheet, fromRow: number, toRow: number, col: number): SheetCell | null {
  const cell = getCell(sheet, fromRow, col);
  if (!cell) return null;
  return cell.f ? { ...cell, f: shiftFormula(cell.f, toRow - fromRow, 0) } : cell;
}

/* ------------------------------------------------------------------ notes */

export function setNote(workbook: Workbook, sheetId: string, row: number, col: number, note: string): Workbook {
  return updateSheet(workbook, sheetId, (sheet) => {
    const cell = { ...(getCell(sheet, row, col) ?? {}) };
    const text = note.trim().slice(0, 2000);
    if (text) cell.n = text;
    else delete cell.n;
    return writeCells(sheet, [{ row, col, cell }]);
  });
}

/* ------------------------------------------------------------------ data tools */

/** Removes rows of a range whose values in `cols` repeat an earlier row. */
export function removeDuplicateRows(
  workbook: Workbook,
  sheetId: string,
  range: CellRange,
  cols: number[],
  valueOf: (row: number, col: number) => Scalar,
  hasHeader: boolean,
): { workbook: Workbook; removed: number } {
  const first = hasHeader ? range.r1 + 1 : range.r1;
  const keep = distinctRows(first, range.r2, cols, valueOf);
  const removed = range.r2 - first + 1 - keep.length;
  if (!removed) return { workbook, removed: 0 };
  const fromRows = Array.from({ length: range.r2 - first + 1 }, (_, index): number | undefined => keep[index]);
  const next = updateSheet(workbook, sheetId, (sheet) => writeCells(sheet, movedRowUpdates(sheet, fromRows, first, range)));
  return { workbook: next, removed };
}

/** The first row of each distinct key (text compared case-insensitively). */
function distinctRows(first: number, last: number, cols: number[], valueOf: (row: number, col: number) => Scalar): number[] {
  const seen = new Set<string>();
  const keep: number[] = [];
  for (let row = first; row <= last; row += 1) {
    const key = cols.map((col) => {
      const value = valueOf(row, col);
      return typeof value === "string" ? value.toLowerCase() : String(value);
    }).join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(row);
  }
  return keep;
}

/** Splits text in one column into neighbouring columns by a delimiter. */
export function splitTextToColumns(workbook: Workbook, sheetId: string, range: CellRange, delimiter: string): Workbook {
  if (!delimiter) return workbook;
  return updateSheet(workbook, sheetId, (sheet) => {
    const updates: { row: number; col: number; cell: SheetCell | null }[] = [];
    for (let row = range.r1; row <= range.r2; row += 1) {
      const cell = getCell(sheet, row, range.c1);
      if (typeof cell?.v !== "string") continue;
      cell.v.split(delimiter).forEach((part, index) => {
        const target = getCell(sheet, row, range.c1 + index);
        updates.push({ row, col: range.c1 + index, cell: cellFromInput(index === 0 ? cell : target, part.trim()) });
      });
    }
    return writeCells(sheet, updates);
  });
}

/** AutoSum: a SUM of the contiguous numbers above (or else left of) a cell. */
export function autoSumFormula(row: number, col: number, isNumber: (row: number, col: number) => boolean): string | null {
  let top = row - 1;
  while (top >= 0 && isNumber(top, col)) top -= 1;
  if (top < row - 1) return `SUM(${cellKey(top + 1, col)}:${cellKey(row - 1, col)})`;
  let left = col - 1;
  while (left >= 0 && isNumber(row, left)) left -= 1;
  if (left < col - 1) return `SUM(${cellKey(row, left + 1)}:${cellKey(row, col - 1)})`;
  return null;
}
