import clsx from "clsx";
import { AiPen } from "./AiPen";
import { ChevronDown, Settings2 } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CellPoint,
  type CellRange,
  MAX_SHEET_COLS,
  MAX_SHEET_ROWS,
  cellKey,
  formatRangeRef,
  normalizeRange,
  parseRangeRef,
  rangeContains,
  splitSheetQualifiedRef,
} from "../../lib/sheet/address";
import { type ClipBlock, blockToHtml, blockToTsv, copyBlock, externalBlock, parseHtmlTable, parseTsv, pasteBlock, type PasteMode } from "../../lib/sheet/clipboard";
import { computeDecorations, computeFilter, currentRegion } from "../../lib/sheet/decorations";
import { fitRowHeights, headerSpan } from "../../lib/sheet/autofit";
import { fillFromEdge, fillRange } from "../../lib/sheet/fillSeries";
import { formulaReferences } from "../../lib/sheet/formula/references";
import { isError, type Scalar } from "../../lib/sheet/formula/values";
import { canInsertReference, formulaSegments, referenceColor } from "../../lib/sheet/formulaEditing";
import { buildGeometry, displayedSize, nextVisible } from "../../lib/sheet/geometry";
import { adjustDecimals, formatCellValue, parseCellInput } from "../../lib/sheet/numberFormat";
import { computeWorkbook, tableAt } from "../../lib/sheet/recalc";
import { describeChanges, diffWorkbooks } from "../../lib/sheet/sheetAi";
import { runSheetAiFlow } from "../../lib/sheet/sheetAiFlow";
import { type Sheet, type SheetChart, type Workbook, serializeWorkbook, sheetByName } from "../../lib/sheet/sheetModel";
import {
  type BorderPreset,
  type StylePatch,
  addSheet,
  applyBorders,
  applyStyle,
  autoSumFormula,
  cellInputText,
  clearRange,
  deleteCols,
  deleteRows,
  effectiveStyle,
  getCell,
  insertCols,
  insertRows,
  mergeAt,
  mergeRange,
  setCellInput,
  setColumnWidth,
  setFreeze,
  setRangeInput,
  setHidden,
  setRowHeight,
  setSheetProps,
  sortRange,
  unmergeRange,
  updateSheet,
} from "../../lib/sheet/sheetOps";
import { type GridKeyCommand, gridKeyCommand } from "../../lib/sheet/keyboard";
import { validateEntry } from "../../lib/sheet/validation";
import { type CommitDirection, FormulaInput, type FormulaInputHandle } from "./FormulaInput";
import { DOCUMENT_ZOOM_STEPS } from "../DocumentStatusBar";
import { EditorShortcutsDialog } from "../EditorShortcutsDialog";
import { AI_COMPOSER_TRIGGER, SheetAiComposer, type SheetAiPreview, type SheetAiState, composerAnchor } from "./SheetAiComposer";
import { type GridHandle, type GridPointerTarget, type RefHighlight, SheetGrid, measureCellText } from "./SheetGrid";
import { SheetContextMenu, SheetFilterMenu, SheetValidationList, type ContextMenuState } from "./SheetMenus";
import { SheetSidePanel, type SidePanel } from "./SheetPanels";
import { SheetStatusBar } from "./SheetStatusBar";
import { SheetTabs } from "./SheetTabs";
import { SheetToolbar, type SheetActions, type SheetToolbarState } from "./SheetToolbar";
import { formatRangeAsTable, regionForTable, restyledWorkbook, sharedTableLook, styleMeetsOwnColors } from "../../lib/sheet/tableStyles";

export type SheetAiAsk = (prompt: string, options: { signal: AbortSignal; onText?: (text: string) => void }) => Promise<string>;

export type SpreadsheetEditorProps = {
  workbook: Workbook;
  /** Changing this resets undo history (a version was restored or opened). */
  historyKey: string;
  onChange: (workbook: Workbook, summary: string) => void;
  readOnly?: boolean;
  saveStatus?: ReactNode;
  mobileExpanded: boolean;
  onToggleMobile: () => void;
  /** agentName labels the run in the AI composer, as in documents and decks. */
  ai: { available: boolean; reason?: string; ask: SheetAiAsk; agentName?: string };
  onStatus?: (message: string) => void;
  title: string;
  /** Reports the sheet on screen (for "CSV (current sheet)" exports). */
  onActiveSheetChange?: (sheetId: string) => void;
  /** Shows a sheet when the nonce changes (e.g. one the assistant just built). */
  focusSheet?: { id: string; nonce: number } | null;
};

type Selection = { active: CellPoint; anchor: CellPoint; range: CellRange };
type Editing = { text: string; caret: number; source: "cell" | "bar"; mode: "enter" | "edit"; pick: { start: number; end: number; anchor: CellPoint } | null };
type HistoryEntry = { workbook: Workbook; sheetId: string; selection: Selection; label: string };

const START: Selection = { active: { row: 0, col: 0 }, anchor: { row: 0, col: 0 }, range: { r1: 0, c1: 0, r2: 0, c2: 0 } };
const HISTORY_LIMIT = 100;

function rangeLabel(range: CellRange): string {
  return formatRangeRef(range);
}

export function SpreadsheetEditor(props: SpreadsheetEditorProps) {
  const { workbook, onChange, readOnly = false, ai } = props;
  const [sheetId, setSheetId] = useState(workbook.sheets.find((sheet) => !sheet.hidden)?.id ?? workbook.sheets[0].id);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [editing, setEditingState] = useState<Editing | null>(null);
  // Mirrors `editing` synchronously: keys typed in the instant between
  // opening the cell editor and its textarea taking focus still reach the
  // grid, and must extend the edit rather than restart it.
  const editingRef = useRef<Editing | null>(null);
  const setEditing = useCallback((next: Editing | null | ((current: Editing | null) => Editing | null)) => {
    const value = typeof next === "function" ? next(editingRef.current) : next;
    editingRef.current = value;
    setEditingState(value);
  }, []);
  const [undo, setUndo] = useState<HistoryEntry[]>([]);
  const [redo, setRedo] = useState<HistoryEntry[]>([]);
  const [clip, setClip] = useState<ClipBlock | null>(null);
  const [zoom, setZoom] = useState(1);
  const [growth, setGrowth] = useState<Record<string, { rows: number; cols: number }>>({});
  const [selectedChartId, setSelectedChartId] = useState<string | null>(null);
  const [panel, setPanel] = useState<SidePanel | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [filterMenu, setFilterMenu] = useState<{ col: number; anchor: DOMRect } | null>(null);
  const [validationList, setValidationList] = useState<{ point: CellPoint; anchor: DOMRect } | null>(null);
  const [aiState, setAiState] = useState<SheetAiState>({ open: false, phase: "idle", prompt: "", label: "" });
  const [notice, setNotice] = useState<string | null>(null);
  const [findMatches, setFindMatches] = useState<Set<string> | null>(null);
  const grid = useRef<GridHandle>(null);
  const barInput = useRef<FormulaInputHandle>(null);
  const cellInput = useRef<FormulaInputHandle>(null);
  const aiAbort = useRef<AbortController | null>(null);
  const historyKeyRef = useRef(props.historyKey);

  useEffect(() => {
    if (historyKeyRef.current === props.historyKey) return;
    historyKeyRef.current = props.historyKey;
    setUndo([]);
    setRedo([]);
    setEditing(null);
    setAiState((state) => ({ ...state, phase: "idle", preview: undefined }));
  }, [props.historyKey]);

  // Keep the active sheet valid when the workbook changes underneath us.
  useEffect(() => {
    if (!workbook.sheets.some((sheet) => sheet.id === sheetId)) setSheetId(workbook.sheets[0].id);
  }, [workbook, sheetId]);

  const { onActiveSheetChange, focusSheet } = props;
  useEffect(() => {
    onActiveSheetChange?.(sheetId);
  }, [sheetId, onActiveSheetChange]);

  useEffect(() => {
    if (focusSheet && workbook.sheets.some((sheet) => sheet.id === focusSheet.id)) setSheetId(focusSheet.id);
    // The nonce is the trigger; the id alone may repeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSheet?.nonce]);

  const preview = aiState.preview;
  const shownWorkbook = preview?.workbook ?? workbook;
  const sheet: Sheet = shownWorkbook.sheets.find((item) => item.id === sheetId) ?? shownWorkbook.sheets[0];
  const engine = useMemo(() => computeWorkbook(shownWorkbook), [shownWorkbook]);
  const selection = selections[sheet.id] ?? START;
  const filter = useMemo(() => computeFilter(sheet.filter, sheet.id, engine), [sheet.filter, sheet.id, engine]);
  const dark = useDarkTheme();
  const decorations = useMemo(() => computeDecorations(sheet, engine, filter, dark), [sheet, engine, filter, dark]);
  const used = engine.usedRange(sheet.id);
  const size = displayedSize(used, growth[sheet.id]?.rows ?? 0, growth[sheet.id]?.cols ?? 0);
  const geometry = useMemo(
    () => buildGeometry(sheet, { rows: Math.min(MAX_SHEET_ROWS, Math.max(size.rows, selection.range.r2 + 30)), cols: Math.min(MAX_SHEET_COLS, Math.max(size.cols, selection.range.c2 + 6)) }, filter?.hiddenRows ?? new Set(), zoom),
    [sheet, size.rows, size.cols, selection.range.r2, selection.range.c2, filter, zoom],
  );
  const validationCells = useMemo(() => {
    const set = new Set<string>();
    for (const rule of sheet.validations ?? []) {
      if (rule.kind !== "list") continue;
      const range = parseRangeRef(rule.ref);
      if (range && rangeContains(range, selection.active.row, selection.active.col)) set.add(cellKey(selection.active.row, selection.active.col));
    }
    return set;
  }, [sheet.validations, selection.active]);
  const changedCells = preview ? preview.changed.get(sheet.id) ?? new Set<string>() : null;

  const announce = useCallback((message: string) => {
    props.onStatus?.(message);
  }, [props]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    announce(message);
  }, [announce]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 4200);
    return () => clearTimeout(timer);
  }, [notice]);

  const setSelection = useCallback((next: Selection, scroll = true) => {
    setSelections((current) => ({ ...current, [sheet.id]: next }));
    if (scroll) requestAnimationFrame(() => grid.current?.scrollToCell(next.active));
  }, [sheet.id]);

  const commit = useCallback((next: Workbook, label: string, nextSelection?: Selection, nextSheetId?: string) => {
    if (readOnly || next === workbook) return;
    setUndo((stack) => [...stack.slice(-HISTORY_LIMIT + 1), { workbook, sheetId: sheet.id, selection, label }]);
    setRedo([]);
    onChange(next, label);
    if (nextSheetId) setSheetId(nextSheetId);
    if (nextSelection) setSelections((current) => ({ ...current, [nextSheetId ?? sheet.id]: nextSelection }));
    // After a toolbar, menu, or AI command, keyboard focus returns to the grid
    // (as Excel's ribbon does) unless the author is typing in a panel field.
    requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      // A menu that stays open after a pick (the Table design gallery) keeps focus, so Escape still closes it.
      if (active?.closest(".sheet-menu[role='menu']")) return;
      const typing = active?.closest(".sheet-side-panel, .ai-composer, .sheet-tabs") && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
      if (!typing && (!active || active === document.body || active.closest(".sheet-editor"))) grid.current?.focus();
    });
  }, [readOnly, workbook, sheet.id, selection, onChange]);

  const undoChange = useCallback(() => {
    const entry = undo.at(-1);
    if (!entry) return;
    setUndo((stack) => stack.slice(0, -1));
    setRedo((stack) => [...stack, { workbook, sheetId: sheet.id, selection, label: entry.label }]);
    onChange(entry.workbook, `Undid ${entry.label.toLowerCase()}`);
    setSheetId(entry.sheetId);
    setSelections((current) => ({ ...current, [entry.sheetId]: entry.selection }));
    announce(`Undid: ${entry.label}.`);
  }, [undo, workbook, sheet.id, selection, onChange, announce]);

  const redoChange = useCallback(() => {
    const entry = redo.at(-1);
    if (!entry) return;
    setRedo((stack) => stack.slice(0, -1));
    setUndo((stack) => [...stack, { workbook, sheetId: sheet.id, selection, label: entry.label }]);
    onChange(entry.workbook, `Redid ${entry.label.toLowerCase()}`);
    setSheetId(entry.sheetId);
    setSelections((current) => ({ ...current, [entry.sheetId]: entry.selection }));
    announce(`Redid: ${entry.label}.`);
  }, [redo, workbook, sheet.id, selection, onChange, announce]);

  /* ---------------------------------------------------------- selection helpers */

  const select = useCallback((point: CellPoint, extend = false) => {
    const row = Math.max(0, Math.min(MAX_SHEET_ROWS - 1, point.row));
    const col = Math.max(0, Math.min(MAX_SHEET_COLS - 1, point.col));
    if (extend) {
      let range = normalizeRange(selection.anchor, { row, col });
      // A selection always covers whole merged areas, as in Excel.
      for (const merge of sheet.merges ?? []) {
        const area = parseRangeRef(merge);
        if (area && area.r1 <= range.r2 && range.r1 <= area.r2 && area.c1 <= range.c2 && range.c1 <= area.c2) {
          range = { r1: Math.min(range.r1, area.r1), c1: Math.min(range.c1, area.c1), r2: Math.max(range.r2, area.r2), c2: Math.max(range.c2, area.c2) };
        }
      }
      setSelection({ ...selection, range, active: selection.active }, false);
      requestAnimationFrame(() => grid.current?.scrollToCell({ row, col }));
      return;
    }
    const merge = mergeAt(sheet, row, col);
    const active = merge ? { row: merge.r1, col: merge.c1 } : { row, col };
    setSelection({ active, anchor: active, range: merge ?? { r1: row, c1: col, r2: row, c2: col } });
  }, [selection, setSelection, sheet]);

  const selectAll = useCallback(() => {
    setSelection({ ...selection, range: { r1: 0, c1: 0, r2: MAX_SHEET_ROWS - 1, c2: MAX_SHEET_COLS - 1 } }, false);
  }, [selection, setSelection]);

  /** The range a command applies to: whole rows/columns are bounded to the
   * used area where that matters (sorting, AI context). */
  const workRange = useMemo(() => {
    const range = selection.range;
    if (!used) return range;
    return { r1: range.r1, c1: range.c1, r2: Math.min(range.r2, Math.max(used.r2, range.r1)), c2: Math.min(range.c2, Math.max(used.c2, range.c1)) };
  }, [selection.range, used]);

  const valueAt = useCallback((row: number, col: number): Scalar => engine.value(sheet.id, row, col), [engine, sheet.id]);

  /* ---------------------------------------------------------- editing */

  const activeCell = getCell(sheet, selection.active.row, selection.active.col);
  const derived = !activeCell?.f && activeCell?.v === undefined ? engine.derivedSource(sheet.id, selection.active.row, selection.active.col) : null;
  const barText = editing ? editing.text : derived?.kind === "spill"
    ? `=${getCell(sheet, derived.row, derived.col)?.f ?? ""}`
    : cellInputText(activeCell);

  const beginEdit = useCallback((initial: string | null, source: "cell" | "bar" = "cell") => {
    if (readOnly || preview) return;
    if (derived?.kind === "pivot") {
      flash("This cell is part of a pivot table. Change the pivot from its panel.");
      return;
    }
    const text = initial ?? cellInputText(getCell(sheet, selection.active.row, selection.active.col));
    setEditing({ text, caret: text.length, source, mode: initial === null ? "edit" : "enter", pick: null });
  }, [readOnly, preview, derived, flash, sheet, selection.active]);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    requestAnimationFrame(() => grid.current?.focus());
  }, []);

  const move = useCallback((direction: CommitDirection, from: Selection = selection) => {
    if (direction === "none" || direction === "fill") return;
    const multi = from.range.r1 !== from.range.r2 || from.range.c1 !== from.range.c2;
    const { row, col } = from.active;
    if (multi) {
      // Enter and Tab walk inside a multi-cell selection without losing it.
      const { r1, r2, c1, c2 } = from.range;
      let next = { row, col };
      if (direction === "down") next = row < r2 ? { row: row + 1, col } : { row: r1, col: col < c2 ? col + 1 : c1 };
      else if (direction === "up") next = row > r1 ? { row: row - 1, col } : { row: r2, col: col > c1 ? col - 1 : c2 };
      else if (direction === "right") next = col < c2 ? { row, col: col + 1 } : { row: row < r2 ? row + 1 : r1, col: c1 };
      else next = col > c1 ? { row, col: col - 1 } : { row: row > r1 ? row - 1 : r2, col: c2 };
      setSelection({ ...from, active: next });
      return;
    }
    const step = { down: [1, 0], up: [-1, 0], right: [0, 1], left: [0, -1] }[direction];
    const nextRow = step[0] ? nextVisible(geometry.hiddenRows, row, step[0], MAX_SHEET_ROWS) : row;
    const nextCol = step[1] ? nextVisible(geometry.hiddenCols, col, step[1], MAX_SHEET_COLS) : col;
    const merge = mergeAt(sheet, row, col);
    let target = { row: nextRow, col: nextCol };
    if (merge && direction === "down") target = { row: Math.min(MAX_SHEET_ROWS - 1, merge.r2 + 1), col };
    if (merge && direction === "right") target = { row, col: Math.min(MAX_SHEET_COLS - 1, merge.c2 + 1) };
    const targetMerge = mergeAt(sheet, target.row, target.col);
    const active = targetMerge ? { row: targetMerge.r1, col: targetMerge.c1 } : target;
    setSelection({ active, anchor: active, range: targetMerge ?? { r1: active.row, c1: active.col, r2: active.row, c2: active.col } });
  }, [selection, setSelection, geometry, sheet]);

  const commitEdit = useCallback((direction: CommitDirection) => {
    const editing = editingRef.current;
    if (!editing) return;
    const { row, col } = selection.active;
    const text = editing.text;
    const problem = validateEntry(sheet, row, col, text);
    if (problem?.strict) {
      flash(problem.message);
      return;
    }
    let next: Workbook;
    if (direction === "fill") next = setRangeInput(workbook, sheet.id, selection.range, text);
    else next = setCellInput(workbook, sheet.id, row, col, text);
    next = inheritFormulaFormat(next, sheet.id, row, col);
    setEditing(null);
    if (problem) flash(problem.message);
    const parsed = parseCellInput(text);
    if (parsed.kind === "formula") {
      const check = computeWorkbook(next).value(sheet.id, row, col);
      if (isError(check) && check.code === "#NAME?" && check.message?.startsWith("The formula could not be read")) flash(check.message);
    }
    commit(next, `Edited ${cellKey(row, col)}`, selection);
    if (direction !== "fill") move(direction);
    requestAnimationFrame(() => grid.current?.focus());
  }, [editing, selection, sheet, workbook, commit, move, flash]);

  const insertReference = useCallback((range: CellRange, anchor: CellPoint, extending: boolean) => {
    if (!editing) return false;
    const handle = editing.source === "bar" ? barInput.current : cellInput.current;
    const caret = handle?.caret() ?? editing.caret;
    const refText = rangeLabel(range);
    if (editing.pick && (extending || editing.pick.end === caret)) {
      const { start, end } = editing.pick;
      const text = editing.text.slice(0, start) + refText + editing.text.slice(end);
      setEditing({ ...editing, text, caret: start + refText.length, pick: { start, end: start + refText.length, anchor: editing.pick.anchor } });
      return true;
    }
    if (!canInsertReference(editing.text, caret)) return false;
    const text = editing.text.slice(0, caret) + refText + editing.text.slice(caret);
    setEditing({ ...editing, text, caret: caret + refText.length, pick: { start: caret, end: caret + refText.length, anchor } });
    return true;
  }, [editing]);

  /* ---------------------------------------------------------- pointer */

  const onPointerTarget = useCallback((target: GridPointerTarget, mode: "start" | "extend" | "end", event: { shiftKey: boolean; button: number }) => {
    setMenu(null);
    setSelectedChartId(null);
    if (target.kind === "cell") {
      if (editing && editing.text.startsWith("=")) {
        if (mode === "start" && insertReference({ r1: target.point.row, c1: target.point.col, r2: target.point.row, c2: target.point.col }, target.point, false)) return;
        if (mode === "extend" && editing.pick) {
          insertReference(normalizeRange(editing.pick.anchor, target.point), editing.pick.anchor, true);
          return;
        }
        if (editing.pick) return;
      }
      if (editing && mode === "start") commitEdit("none");
      if (mode === "start") select(target.point, event.shiftKey);
      else if (mode === "extend") select(target.point, true);
      return;
    }
    if (editing && mode === "start") commitEdit("none");
    if (target.kind === "corner") {
      selectAll();
      return;
    }
    if (target.kind === "col") {
      const anchorCol = mode === "start" && !event.shiftKey ? target.index : selection.anchor.col;
      const c1 = Math.min(anchorCol, target.index);
      const c2 = Math.max(anchorCol, target.index);
      const active = mode === "start" && !event.shiftKey ? { row: 0, col: target.index } : selection.active;
      setSelection({ active, anchor: { row: 0, col: anchorCol }, range: { r1: 0, c1, r2: MAX_SHEET_ROWS - 1, c2 } }, false);
      return;
    }
    const anchorRow = mode === "start" && !event.shiftKey ? target.index : selection.anchor.row;
    const r1 = Math.min(anchorRow, target.index);
    const r2 = Math.max(anchorRow, target.index);
    const active = mode === "start" && !event.shiftKey ? { row: target.index, col: 0 } : selection.active;
    setSelection({ active, anchor: { row: anchorRow, col: 0 }, range: { r1, c1: 0, r2, c2: MAX_SHEET_COLS - 1 } }, false);
  }, [editing, insertReference, commitEdit, select, selectAll, selection, setSelection]);

  /* ---------------------------------------------------------- commands */

  const styleOf = effectiveStyle(sheet, selection.active.row, selection.active.col);

  const applyStylePatch = useCallback((patch: StylePatch, label: string) => {
    commit(applyStyle(workbook, sheet.id, selection.range, patch), label);
  }, [commit, workbook, sheet.id, selection.range]);

  const toggleStyle = useCallback((key: "bold" | "italic" | "underline" | "strike") => {
    const on = !styleOf?.[key];
    applyStylePatch({ [key]: on ? true : null }, `${on ? "Applied" : "Removed"} ${key === "strike" ? "strikethrough" : key}`);
  }, [styleOf, applyStylePatch]);

  const clearSelection = useCallback((mode: "contents" | "formats" | "all" = "contents") => {
    if (readOnly) return;
    commit(clearRange(workbook, sheet.id, selection.range, mode), mode === "contents" ? `Cleared ${rangeLabel(workRange)}` : `Cleared ${mode} in ${rangeLabel(workRange)}`);
  }, [readOnly, commit, workbook, sheet.id, selection.range, workRange]);

  const copySelection = useCallback(async (cut: boolean) => {
    const range = workRange;
    const block = copyBlock(sheet, range, cut, valueAt);
    setClip(block);
    const texts: string[][] = [];
    const styles: (ReturnType<typeof effectiveStyle>)[][] = [];
    for (let row = range.r1; row <= range.r2; row += 1) {
      const line: string[] = [];
      const styleLine: (ReturnType<typeof effectiveStyle>)[] = [];
      for (let col = range.c1; col <= range.c2; col += 1) {
        const style = effectiveStyle(sheet, row, col);
        line.push(formatCellValue(valueAt(row, col), style?.format).text);
        styleLine.push(style);
      }
      texts.push(line);
      styles.push(styleLine);
    }
    const tsv = blockToTsv(texts);
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([tsv], { type: "text/plain" }), "text/html": new Blob([blockToHtml(texts, styles)], { type: "text/html" }) })]);
      } else {
        await navigator.clipboard?.writeText(tsv);
      }
    } catch {
      // The in-app clipboard still works when the browser denies access.
    }
    flash(`${cut ? "Cut" : "Copied"} ${rangeLabel(range)}.`);
  }, [workRange, sheet, valueAt, flash]);

  const pasteFrom = useCallback((block: ClipBlock, mode: PasteMode = "all") => {
    if (readOnly) return;
    const result = pasteBlock(workbook, sheet.id, selection.range, block, mode);
    commit(result.workbook, `Pasted into ${rangeLabel(result.range)}`, { active: selection.active, anchor: selection.active, range: result.range });
    if (block.cut) setClip(null);
  }, [readOnly, workbook, sheet.id, selection, commit]);

  const pasteClipboard = useCallback(async (mode: PasteMode = "all") => {
    if (readOnly) return;
    let text = "";
    let html = "";
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
          if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
        }
      } else if (navigator.clipboard?.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch {
      // Fall back to the in-app clipboard below.
    }
    if (clip && (!text || text === blockToTsv(clip.cells.map((line, r) => line.map((_, c) => formatCellValue(clip.values?.[r]?.[c] ?? null).text))))) {
      pasteFrom(clip, mode);
      return;
    }
    if (clip && !text) {
      pasteFrom(clip, mode);
      return;
    }
    const table = html ? parseHtmlTable(html) : null;
    const block = table ? externalBlock(table.texts, mode === "values" ? undefined : table.styles) : text ? externalBlock(parseTsv(text)) : null;
    if (block) pasteFrom(block, mode === "transpose" ? "transpose" : "all");
    else if (clip) pasteFrom(clip, mode);
  }, [readOnly, clip, pasteFrom]);

  const onPasteEvent = useCallback((event: ClipboardEvent) => {
    if (editing || readOnly) return;
    const html = event.clipboardData?.getData("text/html") ?? "";
    const text = event.clipboardData?.getData("text/plain") ?? "";
    event.preventDefault();
    if (clip && text === blockToTsv(clip.cells.map((line, r) => line.map((_, c) => formatCellValue(clip.values?.[r]?.[c] ?? null).text)))) {
      pasteFrom(clip);
      return;
    }
    const table = html ? parseHtmlTable(html) : null;
    const block = table ? externalBlock(table.texts, table.styles) : text ? externalBlock(parseTsv(text)) : clip;
    if (block) pasteFrom(block);
  }, [editing, readOnly, clip, pasteFrom]);

  const gridRoot = useRef<HTMLDivElement>(null);
  const formulaBar = useRef<HTMLDivElement>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    const node = gridRoot.current;
    if (!node) return undefined;
    const handler = (event: ClipboardEvent) => onPasteEvent(event);
    node.addEventListener("paste", handler);
    return () => node.removeEventListener("paste", handler);
  }, [onPasteEvent]);

  const fill = useCallback((source: CellRange, target: CellRange) => {
    commit(fillRange(workbook, sheet.id, source, target), `Filled ${rangeLabel(target)}`, { active: selection.active, anchor: selection.anchor, range: target });
  }, [commit, workbook, sheet.id, selection]);

  const fillToEnd = useCallback(() => {
    // Double-clicking the fill handle fills down as far as the column to the
    // left (or right) has data, like Excel.
    const src = selection.range;
    const neighbor = src.c1 > 0 ? src.c1 - 1 : src.c2 + 1;
    let last = src.r2;
    while (last + 1 < MAX_SHEET_ROWS && valueAt(last + 1, neighbor) !== null) last += 1;
    if (last > src.r2) fill(src, { ...src, r2: last });
  }, [selection.range, valueAt, fill]);

  const insertStructure = useCallback((kind: "rowsAbove" | "rowsBelow" | "colsLeft" | "colsRight") => {
    const range = selection.range;
    const rows = range.r2 - range.r1 + 1;
    const cols = range.c2 - range.c1 + 1;
    if (kind === "rowsAbove") commit(insertRows(workbook, sheet.id, range.r1, Math.min(rows, 500)), `Inserted ${Math.min(rows, 500)} row(s)`);
    else if (kind === "rowsBelow") commit(insertRows(workbook, sheet.id, range.r2 + 1, Math.min(rows, 500)), `Inserted ${Math.min(rows, 500)} row(s)`, { ...selection, active: { row: range.r2 + 1, col: selection.active.col }, anchor: { row: range.r2 + 1, col: selection.active.col }, range: { ...range, r1: range.r2 + 1, r2: range.r2 + Math.min(rows, 500) } });
    else if (kind === "colsLeft") commit(insertCols(workbook, sheet.id, range.c1, Math.min(cols, 100)), `Inserted ${Math.min(cols, 100)} column(s)`);
    else commit(insertCols(workbook, sheet.id, range.c2 + 1, Math.min(cols, 100)), `Inserted ${Math.min(cols, 100)} column(s)`, { ...selection, active: { row: selection.active.row, col: range.c2 + 1 }, anchor: { row: selection.active.row, col: range.c2 + 1 }, range: { ...range, c1: range.c2 + 1, c2: range.c2 + Math.min(cols, 100) } });
  }, [selection, commit, workbook, sheet.id]);

  const deleteStructure = useCallback((axis: "rows" | "cols") => {
    const range = selection.range;
    if (axis === "rows") commit(deleteRows(workbook, sheet.id, range.r1, range.r2 - range.r1 + 1), `Deleted row(s) ${range.r1 + 1}–${range.r2 + 1}`);
    else commit(deleteCols(workbook, sheet.id, range.c1, range.c2 - range.c1 + 1), `Deleted column(s)`);
  }, [selection.range, commit, workbook, sheet.id]);

  const autofit = useCallback((c1: number, c2: number = c1) => {
    let next = workbook;
    for (let col = c1; col <= c2; col += 1) {
      let width = 40;
      const last = Math.min(used?.r2 ?? 0, 2000);
      for (let row = 0; row <= last; row += 1) {
        const value = valueAt(row, col);
        if (value === null) continue;
        const style = effectiveStyle(sheet, row, col);
        if (mergeAt(sheet, row, col)) continue;
        width = Math.max(width, measureCellText(formatCellValue(value, style?.format).text, style) + 16);
      }
      next = setColumnWidth(next, sheet.id, col, col, Math.min(480, Math.ceil(width)));
    }
    commit(next, "Auto-fit column width");
  }, [workbook, used, valueAt, sheet, commit]);

  const autofitRows = useCallback((r1: number, r2: number = r1) => {
    commit(fitRowHeights(workbook, sheet, { r1, r2, lastCol: used?.c2 ?? 0 }, valueAt, measureCellText), "Auto-fit row height");
  }, [workbook, used, valueAt, sheet, commit]);

  const autoSum = useCallback((fn: "SUM" | "AVERAGE" | "COUNT" | "MAX" | "MIN" = "SUM") => {
    const { row, col } = selection.active;
    const multi = selection.range.r1 !== selection.range.r2 || selection.range.c1 !== selection.range.c2;
    if (multi) {
      // Excel puts a total under each column of a selected block.
      const r = selection.range;
      let next = workbook;
      for (let c = r.c1; c <= r.c2; c += 1) next = setCellInput(next, sheet.id, r.r2 + 1, c, `=${fn}(${cellKey(r.r1, c)}:${cellKey(r.r2, c)})`);
      commit(next, `Added ${fn} under ${rangeLabel(r)}`);
      return;
    }
    const formula = autoSumFormula(row, col, (r, c) => typeof valueAt(r, c) === "number");
    const text = formula ? `=${formula.replace(/^SUM/, fn)}` : `=${fn}()`;
    setEditing({ text, caret: formula ? text.length : text.length - 1, source: "cell", mode: "edit", pick: null });
  }, [selection, workbook, sheet.id, commit, valueAt]);

  const toggleFilter = useCallback(() => {
    if (sheet.filter) {
      commit(updateSheet(workbook, sheet.id, (current) => ({ ...current, filter: undefined })), "Removed filter");
      return;
    }
    const multi = selection.range.r1 !== selection.range.r2 || selection.range.c1 !== selection.range.c2;
    const range = multi ? workRange : currentRegion(sheet.id, engine, selection.active.row, selection.active.col);
    if (range.r2 <= range.r1) {
      flash("Select a range with a header row and data to filter.");
      return;
    }
    commit(updateSheet(workbook, sheet.id, (current) => ({ ...current, filter: { ref: rangeLabel(range), criteria: {} } })), `Added a filter to ${rangeLabel(range)}`);
  }, [sheet, workbook, selection, workRange, engine, commit, flash]);

  const freeze = useCallback((kind: "row" | "col" | "selection" | "none") => {
    const rows = kind === "row" ? 1 : kind === "selection" ? selection.active.row : 0;
    const cols = kind === "col" ? 1 : kind === "selection" ? selection.active.col : 0;
    commit(setFreeze(workbook, sheet.id, rows, cols), kind === "none" ? "Unfroze panes" : "Froze panes");
  }, [selection.active, commit, workbook, sheet.id]);

  /* ---------------------------------------------------------- AI */

  /** Runs one AI request. A refinement starts from the open proposal, so the
   * model adjusts its own change; the preview still diffs against the saved
   * workbook, and Apply lands everything as one undoable step. */
  const runAi = useCallback(async (instruction: string, label = instruction, base?: SheetAiPreview) => {
    if (!ai.available || !instruction.trim()) return;
    aiAbort.current?.abort();
    const controller = new AbortController();
    aiAbort.current = controller;
    setAiState((state) => ({ ...state, prompt: instruction, label, phase: "thinking", error: undefined, message: undefined, preview: base, streamed: "" }));
    try {
      const flow = await runSheetAiFlow({
        ask: (prompt) => ai.ask(prompt, { signal: controller.signal, onText: (partial) => setAiState((state) => ({ ...state, streamed: partial })) }),
        instruction,
        workbook: base?.workbook ?? workbook,
        sheetId: base?.sheetId ?? sheet.id,
        scope: "cell",
        selection: workRange,
        context: base ? `This refines a change you just proposed ("${aiState.label}"). That proposal is already in the workbook above: adjust it as asked and keep the rest of it.` : undefined,
        onPhase: (phase) => setAiState((state) => ({ ...state, phase })),
        isCancelled: () => controller.signal.aborted,
      });
      if (controller.signal.aborted || (!flow.ok && flow.reason === "cancelled")) return;
      if (!flow.ok) throw new Error("The model's reply could not be read as spreadsheet changes. Try rephrasing.");
      const { result, message, problems } = flow;
      const changed = diffWorkbooks(workbook, result.workbook);
      const anyChange = serializeWorkbook(result.workbook) !== serializeWorkbook(workbook);
      setAiState((state) => ({
        ...state,
        phase: anyChange ? "preview" : "answered",
        message: message || (anyChange ? "Here is the proposed change." : "No changes were needed."),
        preview: anyChange ? { workbook: result.workbook, changed, summary: describeChanges(workbook, result.workbook), warnings: result.warnings, problems: problems.length, sheetId: result.activeSheetId } : undefined,
      }));
      if (anyChange && result.activeSheetId !== sheet.id) setSheetId(result.activeSheetId);
    } catch (error) {
      if (controller.signal.aborted) return;
      setAiState((state) => ({ ...state, phase: "error", preview: undefined, error: error instanceof Error ? error.message : "The AI request failed." }));
    }
  }, [ai, workRange, workbook, sheet.id, aiState.label]);

  const acceptAi = useCallback(() => {
    const result = aiState.preview;
    if (!result) return;
    setAiState({ open: false, phase: "idle", prompt: "", label: "" });
    commit(result.workbook, `AI: ${aiState.label.slice(0, 60)}`, undefined, result.sheetId);
    flash(`Applied the AI change (${result.summary}).`);
  }, [aiState, commit, flash]);

  const discardAi = useCallback(() => {
    aiAbort.current?.abort();
    setAiState((state) => ({ ...state, phase: "idle", preview: undefined, message: undefined, streamed: undefined }));
  }, []);

  const closeAi = useCallback(() => {
    aiAbort.current?.abort();
    setAiState({ open: false, phase: "idle", prompt: "", label: "" });
    grid.current?.focus();
  }, []);

  const openAi = useCallback(() => {
    if (!ai.available) {
      flash(ai.reason ?? "AI is not available for this workspace.");
      return;
    }
    setAiState((state) => ({ ...state, open: true }));
  }, [ai, flash]);

  const aiAnchor = useCallback(() => composerAnchor(gridRoot.current, formulaBar.current), []);

  /* ---------------------------------------------------------- keyboard */

  const jump = useCallback((point: CellPoint, dRow: number, dCol: number): CellPoint => {
    // Ctrl+Arrow: to the edge of the current data block, or the next block.
    const filled = (row: number, col: number) => {
      const value = valueAt(row, col);
      return value !== null && value !== "";
    };
    let { row, col } = point;
    const limitRow = Math.max((used?.r2 ?? 0) + 1, 0);
    const limitCol = Math.max((used?.c2 ?? 0) + 1, 0);
    const inBounds = (r: number, c: number) => r >= 0 && c >= 0 && r <= Math.max(limitRow, point.row) && c <= Math.max(limitCol, point.col);
    const startFilled = filled(row, col);
    const nextFilled = inBounds(row + dRow, col + dCol) && filled(row + dRow, col + dCol);
    if (startFilled && nextFilled) {
      while (inBounds(row + dRow, col + dCol) && filled(row + dRow, col + dCol)) { row += dRow; col += dCol; }
    } else {
      row += dRow;
      col += dCol;
      while (inBounds(row, col) && !filled(row, col)) { row += dRow; col += dCol; }
      if (!inBounds(row, col)) {
        row = dRow > 0 ? Math.max(point.row, limitRow - 1) : dRow < 0 ? 0 : point.row;
        col = dCol > 0 ? Math.max(point.col, limitCol - 1) : dCol < 0 ? 0 : point.col;
      }
    }
    return { row: Math.max(0, row), col: Math.max(0, col) };
  }, [valueAt, used]);

  const onGridKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const pending = editingRef.current;
    if (pending) {
      // The cell editor is opening; keep what is typed in the meantime.
      const typed = gridKeyCommand(event);
      if (!typed) return;
      event.preventDefault();
      if (typed.kind === "type") setEditing({ ...pending, text: pending.text + typed.text, caret: pending.text.length + typed.text.length });
      else if (typed.kind === "enter") commitEdit(typed.up ? "up" : "down");
      else if (typed.kind === "tab") commitEdit(typed.left ? "left" : "right");
      else if (typed.kind === "escape") cancelEdit();
      else if (typed.kind === "arrow" && pending.mode === "enter" && !pending.text.startsWith("=")) commitEdit(typed.dRow > 0 ? "down" : typed.dRow < 0 ? "up" : typed.dCol > 0 ? "right" : "left");
      return;
    }
    const command = gridKeyCommand(event);
    if (!command) return;
    if (command.kind !== "escape") event.preventDefault();
    const extendFrom = { row: selection.range.r1 === selection.anchor.row ? selection.range.r2 : selection.range.r1, col: selection.range.c1 === selection.anchor.col ? selection.range.c2 : selection.range.c1 };
    const single = { ...selection, range: { r1: selection.active.row, c1: selection.active.col, r2: selection.active.row, c2: selection.active.col } };
    const handlers: { [K in GridKeyCommand["kind"]]: (cmd: Extract<GridKeyCommand, { kind: K }>) => void } = {
      arrow: ({ dRow, dCol, extend, jump: toEdge }) => {
        const from = extend ? extendFrom : selection.active;
        if (toEdge) select(jump(from, dRow, dCol), extend);
        else if (extend) select({ row: dRow ? nextVisible(geometry.hiddenRows, from.row, dRow, MAX_SHEET_ROWS) : from.row, col: dCol ? nextVisible(geometry.hiddenCols, from.col, dCol, MAX_SHEET_COLS) : from.col }, true);
        else move(dRow > 0 ? "down" : dRow < 0 ? "up" : dCol > 0 ? "right" : "left", single);
      },
      enter: ({ up }) => move(up ? "up" : "down"),
      tab: ({ left }) => move(left ? "left" : "right"),
      home: ({ toStart, extend }) => select(toStart ? { row: 0, col: 0 } : { row: selection.active.row, col: 0 }, extend),
      end: ({ extend }) => select({ row: used?.r2 ?? 0, col: used?.c2 ?? 0 }, extend),
      page: ({ down, extend }) => select({ row: Math.max(0, selection.active.row + (grid.current?.viewportRows() ?? 20) * (down ? 1 : -1)), col: selection.active.col }, extend),
      escape: () => {
        if (clip) setClip(null);
        if (aiState.open) closeAi();
      },
      undo: () => undoChange(),
      redo: () => redoChange(),
      copy: () => void copySelection(false),
      cut: () => { if (!readOnly) void copySelection(true); },
      pasteValues: () => void pasteClipboard("values"),
      selectAll: () => {
        // First ⌘A selects the data region around the cell, the second the sheet.
        const region = currentRegion(sheet.id, engine, selection.active.row, selection.active.col);
        const same = region.r1 === selection.range.r1 && region.r2 === selection.range.r2 && region.c1 === selection.range.c1 && region.c2 === selection.range.c2;
        if (same || (region.r1 === region.r2 && region.c1 === region.c2)) selectAll();
        else setSelection({ ...selection, range: region }, false);
      },
      style: ({ key }) => toggleStyle(key),
      fill: ({ axis }) => commit(fillFromEdge(workbook, sheet.id, selection.range, axis), axis === "down" ? "Filled down" : "Filled right"),
      find: ({ replace }) => setPanel({ kind: "find", replace }),
      ai: () => openAi(),
      shortcuts: () => setShortcutsOpen(true),
      today: () => {
        const now = new Date();
        commit(setCellInput(workbook, sheet.id, selection.active.row, selection.active.col, `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`), "Inserted today's date");
      },
      format: ({ format }) => applyStylePatch({ format }, format.includes("%") ? "Percent format" : "Currency format"),
      filter: () => toggleFilter(),
      selectColumn: () => setSelection({ ...selection, range: { r1: 0, c1: selection.range.c1, r2: MAX_SHEET_ROWS - 1, c2: selection.range.c2 } }, false),
      selectRow: () => setSelection({ ...selection, range: { r1: selection.range.r1, c1: 0, r2: selection.range.r2, c2: MAX_SHEET_COLS - 1 } }, false),
      autoSum: () => autoSum(),
      clear: () => clearSelection("contents"),
      backspace: () => {
        if (readOnly) return;
        commit(clearRange(workbook, sheet.id, single.range), `Cleared ${cellKey(selection.active.row, selection.active.col)}`);
        beginEdit("");
      },
      edit: () => beginEdit(null),
      type: ({ text }) => beginEdit(text),
    };
    (handlers[command.kind] as (cmd: GridKeyCommand) => void)(command);
  }, [selection, geometry, select, jump, move, used, clip, aiState.open, closeAi, redoChange, undoChange, copySelection, readOnly, pasteClipboard, sheet.id, engine, selectAll, setSelection, toggleStyle, commit, workbook, openAi, applyStylePatch, toggleFilter, autoSum, clearSelection, beginEdit, setEditing, commitEdit, cancelEdit]);

  /* ---------------------------------------------------------- derived UI */

  const refHighlights: RefHighlight[] = useMemo(() => {
    // Precedent boxes appear while a formula is being edited, as in Excel.
    const text = editing?.text ?? "";
    if (!text.startsWith("=")) return [];
    const colors = new Map<string, string>();
    for (const segment of formulaSegments(text)) if (segment.color) colors.set(segment.text.replace(/\$/g, "").toUpperCase(), segment.color);
    return formulaReferences(text).flatMap((ref, index) => {
      const sameSheet = ref.sheet === null || ref.sheet.toLowerCase() === sheet.name.toLowerCase();
      if (!sameSheet || (!editing && index > 12)) return [];
      return [{ range: { r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2 }, color: editing ? referenceColor(index) : "#2f6eba" }];
    }).slice(0, 24).map((item, index) => (editing ? { ...item, color: Array.from(colors.values())[index] ?? item.color } : item));
  }, [editing, activeCell, sheet.name]);

  const activeTable = tableAt(sheet.tables, selection.active.row, selection.active.col);
  const tableRegion = useMemo(
    () => (activeTable ? null : regionForTable(engine, sheet.id, selection.range, selection.active)),
    [activeTable, engine, sheet.id, selection.range, selection.active],
  );
  const tableLook = useMemo(() => sharedTableLook(workbook), [workbook]);
  const tableFills = useMemo(() => styleMeetsOwnColors(workbook, sheet.id, activeTable, tableRegion), [workbook, sheet.id, activeTable, tableRegion]);
  const toolbarState: SheetToolbarState = {
    canUndo: undo.length > 0,
    canRedo: redo.length > 0,
    style: styleOf,
    merged: Boolean(mergeAt(sheet, selection.active.row, selection.active.col)),
    filterOn: Boolean(sheet.filter),
    gridlines: sheet.gridlines !== false,
    frozen: Boolean(sheet.freeze),
    readOnly,
    table: activeTable,
    tableCount: workbook.sheets.reduce((count, item) => count + (item.tables?.length ?? 0), 0),
    tableLook,
    tableRegion: tableRegion && formatRangeRef(tableRegion),
    tableFills,
    dark,
  };

  const actions: SheetActions = {
    undo: undoChange,
    redo: redoChange,
    toggle: toggleStyle,
    style: applyStylePatch,
    numberFormat: (format) => applyStylePatch({ format: format ?? null }, format ? "Changed number format" : "Reset number format"),
    decimals: (delta) => applyStylePatch({ format: adjustDecimals(styleOf?.format, delta, typeof valueAt(selection.active.row, selection.active.col) === "number" ? (valueAt(selection.active.row, selection.active.col) as number) : undefined) }, delta > 0 ? "More decimals" : "Fewer decimals"),
    borders: (preset: BorderPreset) => commit(applyBorders(workbook, sheet.id, selection.range, preset), "Borders"),
    merge: () => {
      if (mergeAt(sheet, selection.active.row, selection.active.col)) commit(unmergeRange(workbook, sheet.id, selection.range), "Unmerged cells");
      else commit(mergeRange(workbook, sheet.id, selection.range), `Merged ${rangeLabel(selection.range)}`);
    },
    insert: insertStructure,
    remove: deleteStructure,
    clear: clearSelection,
    sort: (desc) => setPanel({ kind: "sort", quick: desc }),
    filter: toggleFilter,
    clearFilters: () => sheet.filter && commit(updateSheet(workbook, sheet.id, (current) => ({ ...current, filter: current.filter ? { ...current.filter, criteria: {} } : undefined })), "Cleared filters"),
    open: (next) => setPanel(next),
    autoSum,
    freeze,
    gridlines: () => commit(setSheetProps(workbook, sheet.id, { gridlines: sheet.gridlines === false ? undefined : false }), "Toggled gridlines"),
    autofit: () => autofit(selection.range.c1, Math.min(selection.range.c2, (used?.c2 ?? selection.range.c2))),
    tableStyle: (patch, everyTable) => {
      if (everyTable) commit(restyledWorkbook(workbook, patch), "Styled every table");
      else if (activeTable) commit(restyledWorkbook(workbook, patch, { sheetId: sheet.id, tableId: activeTable.id }), "Changed table style");
    },
    formatAsTable: (look) => {
      const formatted = tableRegion && formatRangeAsTable(workbook, sheet.id, tableRegion, look);
      if (formatted) commit(formatted, "Formatted as a table");
      else flash("That range overlaps a table, so it was not formatted.");
    },
    zoom: (value) => setZoom(Math.max(0.5, Math.min(2, value))),
    insertFunction: (name) => {
      setEditing({ text: `=${name}(`, caret: name.length + 2, source: "cell", mode: "edit", pick: null });
    },
    addSheet: () => {
      const added = addSheet(workbook, undefined, sheet.id);
      commit(added.workbook, "Added a sheet", START, added.sheetId);
    },
  };

  /* ---------------------------------------------------------- name box */

  const [nameBox, setNameBox] = useState<string | null>(null);
  const nameBoxLabel = editing ? cellKey(selection.active.row, selection.active.col) : selection.range.r1 === selection.range.r2 && selection.range.c1 === selection.range.c2 ? cellKey(selection.active.row, selection.active.col) : rangeLabel(selection.range);

  const goToName = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const defined = workbook.names?.find((item) => item.name.toLowerCase() === trimmed.toLowerCase());
    const table = workbook.sheets.flatMap((item) => (item.tables ?? []).map((t) => ({ table: t, sheet: item }))).find((entry) => entry.table.name.toLowerCase() === trimmed.toLowerCase());
    const target = defined ? splitSheetQualifiedRef(defined.ref) : table ? { sheet: table.sheet.name, ref: table.table.ref } : splitSheetQualifiedRef(trimmed);
    const range = parseRangeRef(target.ref);
    if (range) {
      const targetSheet = target.sheet ? sheetByName(workbook, target.sheet) : sheet;
      if (!targetSheet) {
        flash(`There is no sheet named "${target.sheet}".`);
        return;
      }
      if (targetSheet.id !== sheet.id) setSheetId(targetSheet.id);
      const active = { row: range.r1, col: range.c1 };
      setSelections((current) => ({ ...current, [targetSheet.id]: { active, anchor: active, range } }));
      requestAnimationFrame(() => grid.current?.scrollToCell(active));
      return;
    }
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(trimmed)) {
      // Typing a new name with a range selected defines it, as in Excel.
      const ref = `${sheet.name.includes(" ") ? `'${sheet.name}'` : sheet.name}!${rangeLabel(selection.range).replace(/([A-Z]+)(\d+)/g, "$$$1$$$2")}`;
      const names = [...(workbook.names ?? []).filter((item) => item.name.toLowerCase() !== trimmed.toLowerCase()), { name: trimmed, ref }];
      commit({ ...workbook, names }, `Named ${rangeLabel(selection.range)} "${trimmed}"`);
      flash(`Named ${rangeLabel(selection.range)} "${trimmed}". Use it in formulas like =SUM(${trimmed}).`);
      return;
    }
    flash(`"${trimmed}" is not a cell, range, or name.`);
  };

  /* ---------------------------------------------------------- render */

  const editorNode = editing && editing.source === "cell" ? (
    <FormulaInput
      ref={cellInput}
      variant="cell"
      className="sheet-cell-editor"
      value={editing.text}
      ariaLabel={`Edit ${cellKey(selection.active.row, selection.active.col)}`}
      autoFocus
      arrowsCommit={editing.mode === "enter"}
      onChange={(text, caret) => setEditing((state) => (state ? { ...state, text, caret, pick: state.pick && caret === state.pick.end ? state.pick : null } : state))}
      onCaretChange={(caret) => setEditing((state) => (state ? { ...state, caret } : state))}
      onCommit={commitEdit}
      onCancel={cancelEdit}
      style={{ font: undefined }}
    />
  ) : null;

  return (
    <div className={clsx("sheet-editor", preview && "is-previewing", readOnly && "is-read-only")}>
      <div className={clsx("document-toolbar document-toolbar-compact sheet-toolbar", props.mobileExpanded && "is-mobile-expanded")} aria-label="Spreadsheet formatting">
        <button
          className="document-mobile-toolbar-toggle"
          type="button"
          aria-label={`${props.mobileExpanded ? "Collapse" : "Expand"} spreadsheet formatting`}
          aria-controls="sheet-formatting-controls"
          aria-expanded={props.mobileExpanded}
          onClick={props.onToggleMobile}
        >
          <span className="document-mobile-toolbar-copy">
            <Settings2 size={17} aria-hidden="true" />
            <span>
              <strong>Sheet formatting</strong>
              <small>{rangeLabel(workRange)} on {sheet.name}</small>
            </span>
          </span>
          <ChevronDown className="document-mobile-toolbar-chevron" size={17} aria-hidden="true" />
        </button>
        <SheetToolbar state={toolbarState} actions={actions} />
        {props.saveStatus}
      </div>

      <div className="sheet-formula-bar" ref={formulaBar}>
        <input
          className="sheet-name-box"
          aria-label="Name box: type a cell, range, or name to go there"
          data-tooltip="Type a cell (B4), a range (A1:C9), or a name and press Enter. Type a new name to name the selection."
          value={nameBox ?? nameBoxLabel}
          onFocus={(event) => { setNameBox(nameBoxLabel); event.currentTarget.select(); }}
          onChange={(event) => setNameBox(event.target.value)}
          onBlur={() => setNameBox(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); goToName(event.currentTarget.value); setNameBox(null); grid.current?.focus(); }
            if (event.key === "Escape") { setNameBox(null); grid.current?.focus(); }
          }}
        />
        <span className="sheet-fx" aria-hidden="true">fx</span>
        <FormulaInput
          ref={barInput}
          variant="bar"
          className="sheet-bar-input"
          value={barText}
          ariaLabel={`Contents of ${cellKey(selection.active.row, selection.active.col)}`}
          placeholder={readOnly ? "" : "Type a value, or = to start a formula"}
          disabled={readOnly || Boolean(preview) || derived?.kind === "pivot"}
          onChange={(text, caret) => {
            if (!editing) setEditing({ text, caret, source: "bar", mode: "edit", pick: null });
            else setEditing({ ...editing, text, caret, source: editing.source, pick: null });
          }}
          onCaretChange={(caret) => setEditing((state) => (state ? { ...state, caret } : state))}
          onCommit={commitEdit}
          onCancel={cancelEdit}
        />
        <button
          type="button"
          className="sheet-ai-trigger"
          {...{ [AI_COMPOSER_TRIGGER]: "" }}
          aria-label="Ask AI about the selection"
          aria-keyshortcuts="Meta+J Control+J"
          aria-expanded={aiState.open}
          data-tooltip={ai.available ? `Ask AI to write formulas, clean data, or build tables and charts for ${rangeLabel(workRange)} (⌘J)` : ai.reason ?? "AI is not available"}
          disabled={!ai.available || readOnly}
          onClick={aiState.open ? closeAi : openAi}
        >
          <AiPen size={17} />
          <span>Ask AI</span>
        </button>
      </div>

      {aiState.open && (
        <SheetAiComposer
          state={aiState}
          scopeLabel={`${sheet.name}!${rangeLabel(workRange)}`}
          agentName={ai.agentName ?? "AI"}
          disabledReason={ai.available ? null : ai.reason ?? "AI is not available"}
          getAnchor={aiAnchor}
          onRun={(instruction, label) => void runAi(instruction, label)}
          onRefine={(instruction) => void runAi(instruction, `${aiState.label} · ${instruction}`, aiState.preview)}
          onAccept={acceptAi}
          onRetry={() => void runAi(aiState.prompt, aiState.label)}
          onStop={discardAi}
          onClose={closeAi}
        />
      )}
      {shortcutsOpen && <EditorShortcutsDialog kind="spreadsheet" onClose={() => { setShortcutsOpen(false); grid.current?.focus(); }} />}

      <div className="sheet-body" ref={gridRoot}>
        <div className="sheet-grid-wrap">
          <SheetGrid
            ref={grid}
            sheet={sheet}
            workbook={shownWorkbook}
            engine={engine}
            geometry={geometry}
            decorations={decorations}
            active={selection.active}
            selection={selection.range}
            editor={editorNode}
            refHighlights={refHighlights}
            changedCells={changedCells}
            marchingRange={clip?.origin?.sheetId === sheet.id ? clip.origin.range : null}
            findMatches={findMatches}
            selectedChartId={selectedChartId}
            showGridlines={sheet.gridlines !== false}
            readOnly={readOnly || Boolean(preview)}
            validationCells={validationCells}
            onPointerTarget={onPointerTarget}
            onDoubleClickCell={(point) => { if (!readOnly) { select(point); beginEdit(null); } }}
            onFill={fill}
            onFillToEnd={fillToEnd}
            onResize={(axis, index, value) => {
              const [a, b] = headerSpan(axis, index, selection.range);
              commit(axis === "cols" ? setColumnWidth(workbook, sheet.id, a, b, value) : setRowHeight(workbook, sheet.id, a, b, value), axis === "cols" ? "Resized column" : "Resized row");
            }}
            onAutofit={(axis, index) => {
              const [a, b] = headerSpan(axis, index, selection.range);
              if (axis === "cols") autofit(a, b);
              else autofitRows(a, b);
            }}
            onContextMenu={(target, x, y) => {
              if (target.kind === "cell" && !rangeContains(selection.range, target.point.row, target.point.col)) select(target.point);
              setMenu({ x, y, target });
            }}
            onFilterButton={(col, anchor) => setFilterMenu({ col, anchor })}
            onValidationButton={(point, anchor) => setValidationList({ point, anchor })}
            onChartSelect={(id) => {
              // As in Excel, a click selects the chart; its settings open on a double-click and then follow the selection.
              setSelectedChartId(id);
              if (id) setPanel((current) => (current?.kind === "chart" ? { kind: "chart", chartId: id } : current));
            }}
            onChartChange={(id, change) => commit(updateSheet(workbook, sheet.id, (current) => ({ ...current, charts: current.charts?.map((chart: SheetChart) => (chart.id === id ? { ...chart, ...change } : chart)) })), change.at ? "Moved chart" : "Resized chart")}
            onChartOpen={(id) => setPanel({ kind: "chart", chartId: id })}
            onNearEnd={(axis) => setGrowth((current) => {
              const entry = current[sheet.id] ?? { rows: size.rows, cols: size.cols };
              const next = axis === "rows" ? { ...entry, rows: Math.min(MAX_SHEET_ROWS, Math.max(entry.rows, size.rows) + 200) } : { ...entry, cols: Math.min(MAX_SHEET_COLS, Math.max(entry.cols, size.cols) + 10) };
              return next.rows === entry.rows && next.cols === entry.cols ? current : { ...current, [sheet.id]: next };
            })}
            onKeyDown={onGridKeyDown}
            ariaLabel={`${sheet.name} grid`}
          />
          {notice && <div className="sheet-notice" role="status">{notice}</div>}
        </div>
        {panel && (
          <SheetSidePanel
            panel={panel}
            workbook={workbook}
            sheet={workbook.sheets.find((item) => item.id === sheet.id) ?? sheet}
            engine={engine}
            selection={workRange}
            active={selection.active}
            readOnly={readOnly}
            onApply={(next, label, nextSheetId) => commit(next, label, undefined, nextSheetId)}
            onClose={() => { setPanel(null); setSelectedChartId(null); setFindMatches(null); grid.current?.focus(); }}
            onOpen={setPanel}
            onSelect={(range, targetSheetId) => {
              if (targetSheetId && targetSheetId !== sheet.id) setSheetId(targetSheetId);
              const active = { row: range.r1, col: range.c1 };
              setSelections((current) => ({ ...current, [targetSheetId ?? sheet.id]: { active, anchor: active, range } }));
              requestAnimationFrame(() => grid.current?.scrollToCell(active));
            }}
            onFindMatches={setFindMatches}
            onNotice={flash}
            onInsertFunction={(name) => { setPanel(null); actions.insertFunction(name); }}
          />
        )}
      </div>

      <SheetTabs
        workbook={workbook}
        activeId={sheet.id}
        readOnly={readOnly || Boolean(preview)}
        onActivate={(id) => { if (editing) commitEdit("none"); setSheetId(id); setSelectedChartId(null); }}
        onChange={(next, label, nextActive) => commit(next, label, undefined, nextActive)}
        onNotice={flash}
      />
      <SheetStatusBar
        engine={engine}
        workbook={shownWorkbook}
        sheet={sheet}
        range={workRange}
        zoom={zoom}
        onZoom={actions.zoom}
        onOpenFind={() => setPanel({ kind: "find", replace: false })}
        onShowShortcuts={() => setShortcutsOpen(true)}
      />

      {menu && (
        <SheetContextMenu
          menu={menu}
          readOnly={readOnly}
          hasClip={Boolean(clip)}
          aiAvailable={ai.available}
          onClose={() => setMenu(null)}
          onCommand={(command) => {
            setMenu(null);
            switch (command) {
              case "cut": void copySelection(true); break;
              case "copy": void copySelection(false); break;
              case "paste": void pasteClipboard("all"); break;
              case "pasteValues": void pasteClipboard("values"); break;
              case "pasteFormats": if (clip) pasteFrom(clip, "formats"); break;
              case "pasteTranspose": void pasteClipboard("transpose"); break;
              case "insertRowsAbove": insertStructure("rowsAbove"); break;
              case "insertRowsBelow": insertStructure("rowsBelow"); break;
              case "insertColsLeft": insertStructure("colsLeft"); break;
              case "insertColsRight": insertStructure("colsRight"); break;
              case "deleteRows": deleteStructure("rows"); break;
              case "deleteCols": deleteStructure("cols"); break;
              case "clear": clearSelection("contents"); break;
              case "clearFormats": clearSelection("formats"); break;
              case "sortAsc": setPanel({ kind: "sort", quick: false }); break;
              case "sortDesc": setPanel({ kind: "sort", quick: true }); break;
              case "filter": toggleFilter(); break;
              case "note": setPanel({ kind: "note" }); break;
              case "chart": setPanel({ kind: "chart", chartId: null }); break;
              case "table": setPanel({ kind: "table" }); break;
              case "pivot": setPanel({ kind: "pivot", pivotId: null }); break;
              case "conditional": setPanel({ kind: "conditional" }); break;
              case "validation": setPanel({ kind: "validation" }); break;
              case "hideRows": commit(setSheetHidden(workbook, sheet.id, "rows", selection.range, true), "Hid rows"); break;
              case "hideCols": commit(setSheetHidden(workbook, sheet.id, "cols", selection.range, true), "Hid columns"); break;
              case "unhide": commit(setSheetHidden(setSheetHidden(workbook, sheet.id, "rows", { ...selection.range, r1: Math.max(0, selection.range.r1 - 1), r2: selection.range.r2 + 1 }, false), sheet.id, "cols", { ...selection.range, c1: Math.max(0, selection.range.c1 - 1), c2: selection.range.c2 + 1 }, false), "Unhid rows and columns"); break;
              case "autofit": actions.autofit(); break;
              case "ai": openAi(); break;
              default: break;
            }
          }}
        />
      )}
      {filterMenu && sheet.filter && (
        <SheetFilterMenu
          col={filterMenu.col}
          anchor={filterMenu.anchor}
          filter={sheet.filter}
          sheet={sheet}
          engine={engine}
          readOnly={readOnly}
          onApply={(next, label) => commit(updateSheet(workbook, sheet.id, (current) => ({ ...current, filter: next })), label)}
          onSort={(desc) => {
            const range = parseRangeRef(sheet.filter!.ref)!;
            const data = { ...range, r2: Math.min(range.r2, used?.r2 ?? range.r2) };
            setFilterMenu(null);
            setPanel(null);
            commit(sortRows(workbook, sheet.id, data, filterMenu.col, desc, valueAt), `Sorted by ${cellKey(range.r1, filterMenu.col)}`);
          }}
          onClose={() => setFilterMenu(null)}
        />
      )}
      {filterMenu && !sheet.filter && (sheet.tables ?? []).length > 0 && (
        <SheetFilterMenu
          col={filterMenu.col}
          anchor={filterMenu.anchor}
          filter={{ ref: (sheet.tables ?? []).find((table) => { const r = parseRangeRef(table.ref); return r && filterMenu.col >= r.c1 && filterMenu.col <= r.c2; })?.ref ?? sheet.tables![0].ref, criteria: {} }}
          sheet={sheet}
          engine={engine}
          readOnly={readOnly}
          onApply={(next, label) => commit(updateSheet(workbook, sheet.id, (current) => ({ ...current, filter: next })), label)}
          onSort={(desc) => {
            const tableRef = (sheet.tables ?? []).find((table) => { const r = parseRangeRef(table.ref); return r && filterMenu.col >= r.c1 && filterMenu.col <= r.c2; })?.ref;
            const range = parseRangeRef(tableRef ?? "")!;
            setFilterMenu(null);
            if (range) commit(sortRows(workbook, sheet.id, range, filterMenu.col, desc, valueAt), "Sorted table");
          }}
          onClose={() => setFilterMenu(null)}
        />
      )}
      {validationList && (
        <SheetValidationList
          anchor={validationList.anchor}
          sheet={sheet}
          workbook={workbook}
          engine={engine}
          point={validationList.point}
          onPick={(value) => {
            setValidationList(null);
            commit(setCellInput(workbook, sheet.id, validationList.point.row, validationList.point.col, value), `Picked "${value}"`);
            requestAnimationFrame(() => grid.current?.focus());
          }}
          onClose={() => setValidationList(null)}
        />
      )}
    </div>
  );
}


/** Follows the app's theme class so computed table styles match the canvas. */
function useDarkTheme(): boolean {
  const read = () => typeof document !== "undefined" && document.documentElement.classList.contains("theme-dark");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return undefined;
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** Excel gives a new formula the number format of the first cell it reads
 * (=SUM of currency cells shows as currency) when the formula cell has none
 * and the result is a number; counting functions keep the plain format. */
function inheritFormulaFormat(workbook: Workbook, sheetId: string, row: number, col: number): Workbook {
  const sheet = workbook.sheets.find((item) => item.id === sheetId);
  const cell = sheet ? getCell(sheet, row, col) : undefined;
  if (!sheet || !cell?.f || effectiveStyle(sheet, row, col)?.format) return workbook;
  if (/^\s*(COUNT|COUNTA|COUNTIF|COUNTIFS|COUNTBLANK|ROWS|COLUMNS|LEN|RANK|MATCH|XMATCH|ROW|COLUMN)\s*\(/i.test(cell.f)) return workbook;
  const first = formulaReferences(cell.f).find((ref) => ref.sheet === null);
  if (!first) return workbook;
  const format = effectiveStyle(sheet, first.r1, first.c1)?.format;
  if (!format || format === "@") return workbook;
  const value = computeWorkbook(workbook).value(sheetId, row, col);
  if (typeof value !== "number") return workbook;
  return applyStyle(workbook, sheetId, { r1: row, c1: col, r2: row, c2: col }, { format });
}

function setSheetHidden(workbook: Workbook, sheetId: string, axis: "rows" | "cols", range: CellRange, hidden: boolean): Workbook {
  return axis === "rows" ? setHidden(workbook, sheetId, "rows", range.r1, Math.min(range.r2, MAX_SHEET_ROWS - 1), hidden) : setHidden(workbook, sheetId, "cols", range.c1, Math.min(range.c2, MAX_SHEET_COLS - 1), hidden);
}

function sortRows(workbook: Workbook, sheetId: string, range: CellRange, col: number, desc: boolean, valueOf: (row: number, col: number) => Scalar): Workbook {
  return sortRange(workbook, sheetId, range, [{ col, desc }], valueOf, true);
}
