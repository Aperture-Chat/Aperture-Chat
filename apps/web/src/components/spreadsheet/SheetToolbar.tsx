import clsx from "clsx";
import {
  AArrowDown,
  AArrowUp,
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDownAZ,
  ArrowDownZA,
  Baseline,
  Bold,
  ChartColumn,
  Check,
  ChevronDown,
  Columns3,
  DollarSign,
  Eraser,
  Filter,
  FilterX,
  Grid3x3,
  Highlighter,
  Italic,
  ListChecks,
  PaintBucket,
  Percent,
  Plus,
  Redo2,
  Rows3,
  Sigma,
  Snowflake,
  SquareFunction,
  StickyNote,
  Strikethrough,
  Table2,
  TableCellsMerge,
  TableProperties,
  Trash2,
  Underline,
  Undo2,
  WrapText,
} from "lucide-react";
import { type CSSProperties, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NUMBER_FORMAT_PRESETS, numberFormatLabel } from "../../lib/sheet/numberFormat";
import { SHEET_ACCENTS } from "../../lib/sheet/palette";
import { tablePalette } from "../../lib/sheet/decorations";
import { SHEET_ACCENT_NAMES } from "../../lib/sheet/palette";
import { type AccentSlot, type CellStyle, type SheetTable, TABLE_TONES, type TableTone } from "../../lib/sheet/sheetModel";
import type { BorderPreset, StylePatch, TableStylePatch } from "../../lib/sheet/sheetOps";
import type { TableLook } from "../../lib/sheet/tableStyles";
import type { SidePanel } from "./SheetPanels";

export type SheetToolbarState = {
  canUndo: boolean;
  canRedo: boolean;
  style: CellStyle | undefined;
  merged: boolean;
  filterOn: boolean;
  gridlines: boolean;
  frozen: boolean;
  readOnly: boolean;
  /** The table the active cell sits in, which Table styles restyles; null outside tables. */
  table: SheetTable | null;
  /** Tables in the whole workbook: outside a table, Table styles restyles them all. */
  tableCount: number;
  /** The style every table shares, marked in the gallery when the cursor is outside them. */
  tableLook: TableLook | null;
  /** With no tables yet, the data around the cursor that a picked style formats as one (A1 ref). */
  tableRegion: string | null;
  /** Cells inside what a picked style reaches carry their own fill or text color. */
  tableFills: boolean;
  /** The app's dark theme, so the style gallery draws the palette the grid draws. */
  dark: boolean;
};

export type SheetActions = {
  undo: () => void;
  redo: () => void;
  toggle: (key: "bold" | "italic" | "underline" | "strike") => void;
  style: (patch: StylePatch, label: string) => void;
  numberFormat: (format: string | undefined) => void;
  decimals: (delta: 1 | -1) => void;
  borders: (preset: BorderPreset) => void;
  merge: () => void;
  insert: (kind: "rowsAbove" | "rowsBelow" | "colsLeft" | "colsRight") => void;
  remove: (axis: "rows" | "cols") => void;
  clear: (mode: "contents" | "formats" | "all") => void;
  sort: (desc: boolean) => void;
  filter: () => void;
  clearFilters: () => void;
  open: (panel: SidePanel) => void;
  autoSum: (fn?: "SUM" | "AVERAGE" | "COUNT" | "MAX" | "MIN") => void;
  freeze: (kind: "row" | "col" | "selection" | "none") => void;
  gridlines: () => void;
  autofit: () => void;
  /** Restyles the active cell's table, or every table in the workbook. */
  tableStyle: (patch: TableStylePatch, everyTable?: boolean) => void;
  /** Formats the data around the cursor (state.tableRegion) as a table in this style. */
  formatAsTable: (look: TableLook) => void;
  zoom: (value: number) => void;
  insertFunction: (name: string) => void;
  addSheet: () => void;
};

export const SHEET_COLOR_SWATCHES = [
  "#000000", "#434343", "#666666", "#999999", "#d9d9d9", "#ffffff",
  SHEET_ACCENTS[1], SHEET_ACCENTS[2], SHEET_ACCENTS[3], SHEET_ACCENTS[4], SHEET_ACCENTS[5], SHEET_ACCENTS[6],
  "#d6efef", "#dbe7f6", "#e7e0f6", "#fbefd9", "#f8dfe3", "#dcefe2",
  "#9b1c1c", "#b45309", "#a16207", "#15803d", "#1d4ed8", "#6d28d9",
];

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];

type Span = { left: number; right: number };

const CLIPPING = new Set(["hidden", "clip", "auto", "scroll"]);

/** The part of the window a menu can show in: the window, cut down by every
 * ancestor that hides what sticks out of it (the Drafts editor pane does). */
function visibleSpan(menu: HTMLElement): Span {
  let span: Span = { left: 0, right: window.innerWidth };
  for (let node = menu.parentElement; node; node = node.parentElement) {
    if (!CLIPPING.has(getComputedStyle(node).overflowX)) continue;
    const box = node.getBoundingClientRect();
    span = { left: Math.max(span.left, box.left), right: Math.min(span.right, box.right) };
  }
  return span;
}

/** How far to slide an open menu sideways so all of it shows: left to clear
 * the right edge, but never so far that its own left edge (where its items
 * start) is hidden. */
function screenShift(rect: DOMRect, span: Span, margin = 8): number {
  const clearRight = Math.min(0, span.right - margin - rect.right);
  return Math.max(span.left + margin - rect.left, clearRight);
}

/** Measures a menu as it opens and returns the sideways shift that keeps it on
 * screen, wherever its button sits (a wrapped toolbar puts More at the left).
 * Closing resets the shift, so each opening measures the menu where it falls. */
function useStayOnScreen(open: boolean, menu: RefObject<HTMLDivElement | null>): number {
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const node = open ? menu.current : null;
    setShift(node ? screenShift(node.getBoundingClientRect(), visibleSpan(node)) : 0);
  }, [open, menu]);
  return shift;
}

/** Closes an open menu on a press anywhere outside it. */
function useCloseOnPressOutside(open: boolean, root: RefObject<HTMLDivElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, root, close]);
}

/** A toolbar menu button with a dropdown in the Drafts menu style. */
export function ToolbarMenu({ label, icon, tooltip, children, disabled, wide, className }: { label: string; icon: ReactNode; tooltip: string; children: (close: () => void) => ReactNode; disabled?: boolean; wide?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnPressOutside(open, root, close);
  const shift = useStayOnScreen(open, menu);
  return (
    <div
      ref={root}
      className={clsx("document-insert-control sheet-toolbar-menu", className)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          root.current?.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={tooltip}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
      >
        {icon}
        <ChevronDown size={12} className="sheet-menu-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div ref={menu} className={clsx("document-insert-menu sheet-menu", wide && "is-wide")} role="menu" aria-label={label} style={shift ? { transform: `translateX(${shift}px)` } : undefined}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, disabled, hint, pressed, ariaLabel }: { icon?: ReactNode; label: string; onClick: () => void; disabled?: boolean; hint?: string; pressed?: boolean; ariaLabel?: string }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} aria-pressed={pressed} aria-label={ariaLabel} onClick={onClick} data-tooltip={hint}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

type ColorPick = { label: string; current?: string; onPick: (color: string | null) => void; noneLabel: string };

function ColorSwatches({ label, current, onPick, noneLabel, close }: ColorPick & { close: () => void }) {
  return (
    <div className="sheet-color-menu">
      <div className="document-color-swatches sheet-swatches" role="group" aria-label={`${label} presets`}>
        {SHEET_COLOR_SWATCHES.map((color) => (
          <button key={color} type="button" aria-label={`${label} ${color}`} aria-pressed={current === color} style={{ "--swatch-color": color } as CSSProperties} onClick={() => { onPick(color); close(); }} />
        ))}
      </div>
      <div className="sheet-color-actions">
        <label className="sheet-color-custom">
          <input type="color" aria-label={`Custom ${label.toLowerCase()}`} value={current ?? "#087d8b"} onChange={(event) => onPick(event.target.value)} />
          <span>Custom…</span>
        </label>
        <button type="button" onClick={() => { onPick(null); close(); }}>{noneLabel}</button>
      </div>
    </div>
  );
}

function ColorMenu({ icon, tooltip, className, ...pick }: ColorPick & { icon: ReactNode; tooltip: string; className?: string }) {
  return (
    <ToolbarMenu label={pick.label} className={className} icon={<span className="sheet-color-icon" style={{ "--swatch-color": pick.current ?? "transparent" } as CSSProperties}>{icon}</span>} tooltip={tooltip} wide>
      {(close) => <ColorSwatches {...pick} close={close} />}
    </ToolbarMenu>
  );
}

/** Tiers a narrow toolbar folds into More, in the order they leave. */
const FOLD_LEVELS = 5;

/** Folds toolbar tiers into More until the main group fits on one row, the
 * way the document toolbar keeps a single row. Re-fits when the toolbar
 * resizes, fonts load, or a key's label changes width. */
function useFoldToFit(main: RefObject<HTMLDivElement | null>, labels: string) {
  useLayoutEffect(() => {
    const node = main.current;
    if (!node) return undefined;
    const fit = () => {
      for (let level = 0; level <= FOLD_LEVELS; level += 1) {
        node.dataset.fold = String(level);
        if (fitsOneRow(node)) return;
      }
    };
    fit();
    void document.fonts?.ready.then(fit);
    if (typeof ResizeObserver === "undefined") return undefined;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      fit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [main, labels]);
}

function fitsOneRow(node: HTMLElement): boolean {
  let middle: number | null = null;
  for (const child of Array.from(node.children) as HTMLElement[]) {
    if (!child.offsetWidth) continue;
    const center = child.offsetTop + child.offsetHeight / 2;
    if (middle === null) middle = center;
    else if (Math.abs(center - middle) > 12) return false;
  }
  return true;
}

const BORDER_PRESETS: [BorderPreset, string][] = [
  ["all", "All borders"], ["outer", "Outside borders"], ["inner", "Inside borders"], ["thickOuter", "Thick box"],
  ["top", "Top border"], ["bottom", "Bottom border"], ["left", "Left border"], ["right", "Right border"],
  ["bottomDouble", "Double bottom (totals)"], ["none", "No borders"],
];

function BorderGrid({ onPick }: { onPick: (preset: BorderPreset) => void }) {
  return (
    <div className="sheet-border-grid">
      {BORDER_PRESETS.map(([preset, label]) => (
        <button key={preset} type="button" role="menuitem" onClick={() => onPick(preset)}>
          <span className={`sheet-border-icon is-${preset}`} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

/** Next font size up or down the toolbar's list (Excel's Increase/Decrease Font Size). */
export function stepFontSize(current: number, direction: "up" | "down"): number {
  const larger = FONT_SIZES.filter((size) => size > current);
  const smaller = FONT_SIZES.filter((size) => size < current);
  if (direction === "up") return larger.length ? larger[0] : FONT_SIZES[FONT_SIZES.length - 1];
  return smaller.length ? smaller[smaller.length - 1] : FONT_SIZES[0];
}

type KeysProps = { state: SheetToolbarState; actions: SheetActions };
type HorizontalAlign = "left" | "center" | "right";
type VerticalAlign = "top" | "middle" | "bottom";

const ALIGNMENTS: { value: HorizontalAlign; label: string; key: string; icon: (size: number) => ReactNode }[] = [
  { value: "left", label: "Align left", key: "Align left", icon: (size) => <AlignLeft size={size} /> },
  { value: "center", label: "Align center", key: "Center", icon: (size) => <AlignCenter size={size} /> },
  { value: "right", label: "Align right", key: "Align right", icon: (size) => <AlignRight size={size} /> },
];

const VERTICAL_ALIGNMENTS: { value: VerticalAlign; label: string; icon: (size: number) => ReactNode }[] = [
  { value: "top", label: "Top", icon: (size) => <AlignVerticalJustifyStart size={size} /> },
  { value: "middle", label: "Middle", icon: (size) => <AlignVerticalJustifyCenter size={size} /> },
  { value: "bottom", label: "Bottom", icon: (size) => <AlignVerticalJustifyEnd size={size} /> },
];

const AUTOSUM_FUNCTIONS = [
  ["SUM", "Sum"], ["AVERAGE", "Average"], ["COUNT", "Count numbers"], ["MAX", "Max"], ["MIN", "Min"],
] as const;

/** Clicking the alignment a cell already has clears it back to General. */
function toggleAlign(actions: SheetActions, current: CellStyle["align"], option: (typeof ALIGNMENTS)[number]) {
  actions.style({ align: current === option.value ? null : option.value }, option.key);
}

/** Bottom is Excel's default, so it is stored as no vertical alignment. */
function setVerticalAlign(actions: SheetActions, value: VerticalAlign) {
  actions.style({ valign: value === "bottom" ? null : value }, `Align ${value}`);
}

function verticalAlignOf(style: CellStyle | undefined): VerticalAlign {
  return style?.valign ?? "bottom";
}

function setFontSize(actions: SheetActions, size: number) {
  actions.style({ size: size === 10 ? null : size }, `Font size ${size}`);
}

function toggleWrap(actions: SheetActions, wrapped: boolean) {
  actions.style({ wrap: wrapped ? null : true }, wrapped ? "Unwrapped text" : "Wrapped text");
}

function NumberKeys({ state, actions }: KeysProps) {
  const disabled = state.readOnly;
  const format = state.style?.format;
  return (
    <>
      <ToolbarMenu label="Number format" icon={<span className="sheet-format-chip">{numberFormatLabel(format)}</span>} tooltip="How numbers, dates, and money display in the selected cells" disabled={disabled} wide>
        {(close) => NUMBER_FORMAT_PRESETS.map((preset) => (
          <button key={preset.id} type="button" role="menuitemradio" aria-checked={format === preset.format} onClick={() => { actions.numberFormat(preset.format); close(); }}>
            <span>{preset.label}</span>
            <small>{preset.example}</small>
          </button>
        ))}
      </ToolbarMenu>
      <button type="button" className="sheet-tier-b" aria-label="Currency format" data-tooltip="Show as currency: $1,234.50 (⌘⇧$)" disabled={disabled} onClick={() => actions.numberFormat("$#,##0.00")}><DollarSign size={17} /></button>
      <button type="button" className="sheet-tier-b" aria-label="Percent format" data-tooltip="Show as a percentage: 12% (⌘⇧%)" disabled={disabled} onClick={() => actions.numberFormat("0%")}><Percent size={17} /></button>
      <button type="button" className="sheet-decimal-button sheet-tier-a" aria-label="Fewer decimal places" data-tooltip="Show one fewer decimal place" disabled={disabled} onClick={() => actions.decimals(-1)}><span aria-hidden="true">.0</span><small aria-hidden="true">←</small></button>
      <button type="button" className="sheet-decimal-button sheet-tier-a" aria-label="More decimal places" data-tooltip="Show one more decimal place" disabled={disabled} onClick={() => actions.decimals(1)}><span aria-hidden="true">.00</span><small aria-hidden="true">→</small></button>
    </>
  );
}

function TextKeys({ state, actions }: KeysProps) {
  const style = state.style ?? {};
  const disabled = state.readOnly;
  const size = style.size ?? 10;
  return (
    <>
      <button type="button" aria-label="Bold" aria-pressed={Boolean(style.bold)} data-tooltip="Bold (⌘B)" disabled={disabled} onClick={() => actions.toggle("bold")}><Bold size={18} /></button>
      <button type="button" aria-label="Italic" aria-pressed={Boolean(style.italic)} data-tooltip="Italic (⌘I)" disabled={disabled} onClick={() => actions.toggle("italic")}><Italic size={18} /></button>
      <button type="button" aria-label="Underline" aria-pressed={Boolean(style.underline)} data-tooltip="Underline (⌘U)" disabled={disabled} onClick={() => actions.toggle("underline")}><Underline size={18} /></button>
      <button type="button" className="sheet-tier-a" aria-label="Strikethrough" aria-pressed={Boolean(style.strike)} data-tooltip="Strikethrough (⌘5)" disabled={disabled} onClick={() => actions.toggle("strike")}><Strikethrough size={18} /></button>
      <ToolbarMenu label="Font size" className="sheet-tier-b" icon={<span className="sheet-format-chip is-number">{size}</span>} tooltip="Text size in points" disabled={disabled}>
        {(close) => FONT_SIZES.map((option) => (
          <button key={option} type="button" role="menuitemradio" aria-checked={size === option} onClick={() => { setFontSize(actions, option); close(); }}>
            <span>{option} pt</span>
          </button>
        ))}
      </ToolbarMenu>
      <ColorMenu label="Text color" className="sheet-tier-d" icon={<Baseline size={17} />} tooltip="Color the text in the selected cells" current={style.color} noneLabel="Automatic" onPick={(color) => actions.style({ color }, "Text color")} />
      <ColorMenu label="Fill color" className="sheet-tier-d" icon={<PaintBucket size={17} />} tooltip="Shade the background of the selected cells" current={style.fill} noneLabel="No fill" onPick={(fill) => actions.style({ fill }, "Fill color")} />
      <ToolbarMenu label="Borders" className="sheet-tier-b" icon={<Grid3x3 size={17} />} tooltip="Add or remove cell borders" disabled={disabled} wide>
        {(close) => <BorderGrid onPick={(preset) => { actions.borders(preset); close(); }} />}
      </ToolbarMenu>
    </>
  );
}

function AlignKeys({ state, actions }: KeysProps) {
  const style = state.style;
  const disabled = state.readOnly;
  const vertical = verticalAlignOf(style);
  const wrapped = Boolean(style?.wrap);
  return (
    <>
      {ALIGNMENTS.map((option) => (
        <button key={option.value} type="button" className="sheet-tier-c" aria-label={option.label} aria-pressed={style?.align === option.value} data-tooltip={option.key} disabled={disabled} onClick={() => toggleAlign(actions, style?.align, option)}>{option.icon(17)}</button>
      ))}
      <ToolbarMenu label="Vertical alignment" className="sheet-tier-a" icon={VERTICAL_ALIGNMENTS.find((option) => option.value === vertical)!.icon(17)} tooltip="Top, middle, or bottom of the cell" disabled={disabled}>
        {(close) => VERTICAL_ALIGNMENTS.map((option) => (
          <MenuItem key={option.value} icon={option.icon(16)} label={option.label} pressed={vertical === option.value} onClick={() => { setVerticalAlign(actions, option.value); close(); }} />
        ))}
      </ToolbarMenu>
      <button type="button" className="sheet-tier-b" aria-label="Wrap text" aria-pressed={wrapped} data-tooltip="Wrap long text onto more lines" disabled={disabled} onClick={() => toggleWrap(actions, wrapped)}><WrapText size={17} /></button>
      <button type="button" className="sheet-tier-b" aria-label={state.merged ? "Unmerge cells" : "Merge cells"} aria-pressed={state.merged} data-tooltip={state.merged ? "Split the merged cells" : "Merge the selected cells into one"} disabled={disabled} onClick={actions.merge}><TableCellsMerge size={17} /></button>
    </>
  );
}

function InsertMenu({ state, actions }: KeysProps) {
  return (
    <ToolbarMenu label="Insert" icon={<Plus size={18} />} tooltip="Insert rows, columns, charts, tables, pivot tables, and notes" disabled={state.readOnly} wide>
      {(close) => {
        const run = (fn: () => void) => () => { fn(); close(); };
        return (
          <>
            <MenuItem icon={<Rows3 size={16} />} label="Rows above" onClick={run(() => actions.insert("rowsAbove"))} />
            <MenuItem icon={<Rows3 size={16} />} label="Rows below" onClick={run(() => actions.insert("rowsBelow"))} />
            <MenuItem icon={<Columns3 size={16} />} label="Columns left" onClick={run(() => actions.insert("colsLeft"))} />
            <MenuItem icon={<Columns3 size={16} />} label="Columns right" onClick={run(() => actions.insert("colsRight"))} />
            <span className="sheet-menu-separator" role="separator" />
            <MenuItem icon={<ChartColumn size={16} />} label="Chart…" onClick={run(() => actions.open({ kind: "chart", chartId: null }))} />
            <MenuItem icon={<Table2 size={16} />} label="Table…" onClick={run(() => actions.open({ kind: "table" }))} />
            <MenuItem icon={<TableProperties size={16} />} label="Pivot table…" onClick={run(() => actions.open({ kind: "pivot", pivotId: null }))} />
            <MenuItem icon={<StickyNote size={16} />} label="Note" onClick={run(() => actions.open({ kind: "note" }))} />
            <MenuItem icon={<SquareFunction size={16} />} label="Function…" onClick={run(() => actions.open({ kind: "functions" }))} />
            <MenuItem icon={<Plus size={16} />} label="Sheet" onClick={run(actions.addSheet)} />
            <span className="sheet-menu-separator" role="separator" />
            <MenuItem icon={<Trash2 size={16} />} label="Delete selected rows" onClick={run(() => actions.remove("rows"))} />
            <MenuItem icon={<Trash2 size={16} />} label="Delete selected columns" onClick={run(() => actions.remove("cols"))} />
          </>
        );
      }}
    </ToolbarMenu>
  );
}

function DataMenu({ state, actions }: KeysProps) {
  return (
    <ToolbarMenu label="Data" icon={<Filter size={17} />} tooltip="Sort, filter, clean up, and validate data" disabled={state.readOnly} wide>
      {(close) => {
        const run = (fn: () => void) => () => { fn(); close(); };
        return (
          <>
            <MenuItem icon={<ArrowDownAZ size={16} />} label="Sort A → Z…" onClick={run(() => actions.sort(false))} />
            <MenuItem icon={<ArrowDownZA size={16} />} label="Sort Z → A…" onClick={run(() => actions.sort(true))} />
            <MenuItem icon={<Filter size={16} />} label={state.filterOn ? "Remove filter" : "Filter"} pressed={state.filterOn} onClick={run(actions.filter)} hint="⌘⇧L" />
            <MenuItem icon={<FilterX size={16} />} label="Clear filter choices" disabled={!state.filterOn} onClick={run(actions.clearFilters)} />
            <span className="sheet-menu-separator" role="separator" />
            <MenuItem icon={<Eraser size={16} />} label="Remove duplicates…" onClick={run(() => actions.open({ kind: "duplicates" }))} />
            <MenuItem icon={<Columns3 size={16} />} label="Split text to columns…" onClick={run(() => actions.open({ kind: "split" }))} />
            <MenuItem icon={<ListChecks size={16} />} label="Data validation…" onClick={run(() => actions.open({ kind: "validation" }))} />
            <MenuItem icon={<SquareFunction size={16} />} label="Named ranges…" onClick={run(() => actions.open({ kind: "names" }))} />
          </>
        );
      }}
    </ToolbarMenu>
  );
}

function FormatMenu({ state, actions }: KeysProps) {
  return (
    <ToolbarMenu label="Format" icon={<Highlighter size={17} />} tooltip="Conditional formatting, table styles, freeze panes, and gridlines" disabled={state.readOnly} wide>
      {(close) => {
        const run = (fn: () => void) => () => { fn(); close(); };
        return (
          <>
            <MenuItem icon={<Highlighter size={16} />} label="Conditional formatting…" onClick={run(() => actions.open({ kind: "conditional" }))} />
            <MenuItem icon={<Table2 size={16} />} label="Format as table…" onClick={run(() => actions.open({ kind: "table" }))} />
            <span className="sheet-menu-separator" role="separator" />
            <MenuItem icon={<Snowflake size={16} />} label="Freeze top row" onClick={run(() => actions.freeze("row"))} />
            <MenuItem icon={<Snowflake size={16} />} label="Freeze first column" onClick={run(() => actions.freeze("col"))} />
            <MenuItem icon={<Snowflake size={16} />} label="Freeze above and left of selection" onClick={run(() => actions.freeze("selection"))} />
            <MenuItem icon={<Snowflake size={16} />} label="Unfreeze panes" disabled={!state.frozen} onClick={run(() => actions.freeze("none"))} />
            <span className="sheet-menu-separator" role="separator" />
            <MenuItem icon={<Grid3x3 size={16} />} label={state.gridlines ? "Hide gridlines" : "Show gridlines"} onClick={run(actions.gridlines)} />
            <MenuItem icon={<Columns3 size={16} />} label="Auto-fit column width" onClick={run(actions.autofit)} />
            <MenuItem icon={<Eraser size={16} />} label="Clear formatting" onClick={run(() => actions.clear("formats"))} />
          </>
        );
      }}
    </ToolbarMenu>
  );
}

function AutoSumMenu({ state, actions }: KeysProps) {
  return (
    <ToolbarMenu label="AutoSum" className="sheet-tier-e" icon={<Sigma size={17} />} tooltip="Total the numbers above or to the left (⌥=)" disabled={state.readOnly}>
      {(close) => AUTOSUM_FUNCTIONS.map(([fn, label]) => (
        <MenuItem key={fn} label={label} onClick={() => { actions.autoSum(fn); close(); }} />
      ))}
    </ToolbarMenu>
  );
}

const TONE_LABELS: Record<TableTone, string> = { light: "Light", medium: "Medium", dark: "Dark" };
const TABLE_ACCENTS: AccentSlot[] = [1, 2, 3, 4, 5, 6];

function TableStyleChoice({ current, accent, tone, dark, disabled, onPick }: { current: TableLook | null; accent: AccentSlot; tone: TableTone; dark: boolean; disabled: boolean; onPick: () => void }) {
  const colors = tablePalette({ accent, tone }, dark);
  const chosen = current?.accent === accent && current.tone === tone;
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={chosen}
      aria-label={`${SHEET_ACCENT_NAMES[accent]} · ${TONE_LABELS[tone]}`}
      data-tooltip={`${SHEET_ACCENT_NAMES[accent]} · ${TONE_LABELS[tone]}`}
      className={clsx("sheet-table-choice", chosen && "is-active")}
      style={{ "--table-header": colors.header, "--table-band": colors.band, "--table-line": colors.line } as CSSProperties}
      disabled={disabled}
      onClick={onPick}
    >
      <span className="sheet-table-swatch" aria-hidden="true"><i /><i /><i /><i /></span>
    </button>
  );
}

function TableOption({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} className="sheet-table-option" onClick={onToggle}>
      <span className="sheet-table-option-box" aria-hidden="true">{checked && <Check size={12} strokeWidth={3} />}</span>
      <span>{label}</span>
    </button>
  );
}

/** What a picked style does where the cursor is: restyle this table, restyle
 * every table (Excel's Table Design is only reachable inside one, so this key
 * also works from anywhere), format the data here as a table, or nothing yet. */
type StyleTarget =
  | { kind: "table"; table: SheetTable }
  | { kind: "every"; count: number }
  | { kind: "region"; ref: string }
  | { kind: "none" };

function styleTarget(state: SheetToolbarState): StyleTarget {
  if (state.table) return { kind: "table", table: state.table };
  if (state.tableCount > 0) return { kind: "every", count: state.tableCount };
  if (state.tableRegion) return { kind: "region", ref: state.tableRegion };
  return { kind: "none" };
}

const TARGET_NOTE: Record<StyleTarget["kind"], (target: StyleTarget) => string> = {
  table: () => "",
  every: (target) => (target.kind === "every" && target.count > 1 ? `Restyle all ${target.count} tables` : "Restyle the table"),
  region: (target) => (target.kind === "region" ? `Format ${target.ref} as a table` : ""),
  none: () => "Click inside your data, or select a range with a header row, to make it a table.",
};

const TARGET_TOOLTIP: Record<StyleTarget["kind"], string> = {
  table: "Switch this table's style and options",
  every: "Switch the style of every table in the workbook",
  region: "Format the data around the selected cell as a table, in a style you pick",
  none: "Table styles: click inside your data first",
};

function targetLook(target: StyleTarget, state: SheetToolbarState): TableLook | null {
  if (target.kind === "table") return { accent: target.table.accent, tone: target.table.tone };
  return target.kind === "every" ? state.tableLook : null;
}

function pickStyle(target: StyleTarget, actions: SheetActions, look: TableLook): void {
  if (target.kind === "region") actions.formatAsTable(look);
  else actions.tableStyle(look, target.kind === "every");
}

function TableOptions({ table, actions }: { table: SheetTable; actions: SheetActions }) {
  return (
    <>
      <span className="sheet-menu-separator" role="separator" />
      <TableOption label="Banded rows" checked={table.banded} onToggle={() => actions.tableStyle({ banded: !table.banded })} />
      <TableOption label="Filter buttons" checked={table.filterButtons} onToggle={() => actions.tableStyle({ filterButtons: !table.filterButtons })} />
      <TableOption label="Bold first column" checked={Boolean(table.firstColumn)} onToggle={() => actions.tableStyle({ firstColumn: !table.firstColumn })} />
    </>
  );
}

function FillsNote({ target }: { target: StyleTarget }) {
  const plural = target.kind === "every" && target.count > 1;
  return (
    <p className="sheet-menu-note">
      {plural ? "Cell fill colors inside the tables hide their style; picking one clears them." : "Cell fill colors inside the table hide its style; picking one clears them."}
    </p>
  );
}

/** Under the gallery: this table's options and "every table", or a way to
 * make the data here a table, then the Table panel. */
function TableStylesFooter({ target, state, actions, close }: KeysProps & { target: StyleTarget; close: () => void }) {
  const run = (fn: () => void) => () => { fn(); close(); };
  return (
    <>
      {target.kind === "table" && <TableOptions table={target.table} actions={actions} />}
      <span className="sheet-menu-separator" role="separator" />
      {target.kind === "table" && state.tableCount > 1 && <MenuItem icon={<Table2 size={16} />} label="Use this style for every table" onClick={run(() => actions.tableStyle({ accent: target.table.accent, tone: target.table.tone }, true))} />}
      {target.kind === "every" && state.tableRegion && <MenuItem icon={<Table2 size={16} />} label="Format this data as a table…" onClick={run(() => actions.open({ kind: "table" }))} />}
      <MenuItem icon={<TableProperties size={16} />} label="More table options…" onClick={run(() => actions.open({ kind: "table" }))} />
    </>
  );
}

/** Excel's table style gallery (three tones of six colors), applied as you
 * pick; the menu stays open so another look is one more click away. */
function TableStylesMenu({ state, actions }: KeysProps) {
  const target = styleTarget(state);
  const current = targetLook(target, state);
  const note = TARGET_NOTE[target.kind](target);
  return (
    <ToolbarMenu label="Table styles" className="sheet-table-design" icon={<Table2 size={17} />} tooltip={TARGET_TOOLTIP[target.kind]} disabled={state.readOnly} wide>
      {(close) => (
        <div className="sheet-table-design-menu">
          {note && <p className="sheet-menu-note">{note}</p>}
          {TABLE_TONES.map((tone) => (
            <div key={tone} className="sheet-table-gallery" role="group" aria-label={`${TONE_LABELS[tone]} styles`}>
              <p className="sheet-menu-heading">{TONE_LABELS[tone]}</p>
              <div className="sheet-table-gallery-row">
                {TABLE_ACCENTS.map((accent) => (
                  <TableStyleChoice key={accent} current={current} accent={accent} tone={tone} dark={state.dark} disabled={target.kind === "none"} onPick={() => pickStyle(target, actions, { accent, tone })} />
                ))}
              </div>
            </div>
          ))}
          {state.tableFills && target.kind !== "none" && <FillsNote target={target} />}
          <TableStylesFooter target={target} state={state} actions={actions} close={close} />
        </div>
      )}
    </ToolbarMenu>
  );
}

type MoreProps = KeysProps & { close: () => void };

/** Tier a in More: strikethrough, decimals, vertical alignment. */
function MoreTierA({ state, actions, close }: MoreProps) {
  const vertical = verticalAlignOf(state.style);
  const run = (fn: () => void) => () => { fn(); close(); };
  return (
    <div className="sheet-tier-a">
      <MenuItem icon={<Strikethrough size={16} />} label="Strikethrough" pressed={Boolean(state.style?.strike)} onClick={run(() => actions.toggle("strike"))} />
      <MenuItem icon={<span className="sheet-menu-glyph">.0</span>} label="Fewer decimal places" onClick={run(() => actions.decimals(-1))} />
      <MenuItem icon={<span className="sheet-menu-glyph">.00</span>} label="More decimal places" onClick={run(() => actions.decimals(1))} />
      {VERTICAL_ALIGNMENTS.map((option) => (
        <MenuItem key={option.value} icon={option.icon(16)} label={`Align ${option.value}`} pressed={vertical === option.value} onClick={run(() => setVerticalAlign(actions, option.value))} />
      ))}
    </div>
  );
}

/** Tier b in More: currency, percent, font size, wrap, merge, borders. */
function MoreTierB({ state, actions, close }: MoreProps) {
  const size = state.style?.size ?? 10;
  const wrapped = Boolean(state.style?.wrap);
  const run = (fn: () => void) => () => { fn(); close(); };
  return (
    <div className="sheet-tier-b">
      <span className="sheet-menu-separator" role="separator" />
      <MenuItem icon={<DollarSign size={16} />} label="Currency format" onClick={run(() => actions.numberFormat("$#,##0.00"))} />
      <MenuItem icon={<Percent size={16} />} label="Percent format" onClick={run(() => actions.numberFormat("0%"))} />
      <MenuItem icon={<AArrowUp size={16} />} label="Increase font size" hint={`${size} pt now`} onClick={run(() => setFontSize(actions, stepFontSize(size, "up")))} />
      <MenuItem icon={<AArrowDown size={16} />} label="Decrease font size" hint={`${size} pt now`} onClick={run(() => setFontSize(actions, stepFontSize(size, "down")))} />
      <MenuItem icon={<WrapText size={16} />} label="Wrap text" pressed={wrapped} onClick={run(() => toggleWrap(actions, wrapped))} />
      <MenuItem icon={<TableCellsMerge size={16} />} label={state.merged ? "Unmerge cells" : "Merge cells"} pressed={state.merged} onClick={run(actions.merge)} />
      <p className="sheet-menu-heading">Borders</p>
      <BorderGrid onPick={(preset) => { actions.borders(preset); close(); }} />
    </div>
  );
}

/** Tier c in More: horizontal alignment. */
function MoreTierC({ state, actions, close }: MoreProps) {
  return (
    <div className="sheet-tier-c">
      <span className="sheet-menu-separator" role="separator" />
      {ALIGNMENTS.map((option) => (
        <MenuItem key={option.value} icon={option.icon(16)} label={option.label} pressed={state.style?.align === option.value} onClick={() => { toggleAlign(actions, state.style?.align, option); close(); }} />
      ))}
    </div>
  );
}

/** Tier d in More: text and fill color. */
function MoreTierD({ state, actions, close }: MoreProps) {
  return (
    <div className="sheet-tier-d">
      <span className="sheet-menu-separator" role="separator" />
      <p className="sheet-menu-heading">Text color</p>
      <ColorSwatches label="Text color" current={state.style?.color} noneLabel="Automatic" onPick={(color) => actions.style({ color }, "Text color")} close={close} />
      <p className="sheet-menu-heading">Fill color</p>
      <ColorSwatches label="Fill color" current={state.style?.fill} noneLabel="No fill" onPick={(fill) => actions.style({ fill }, "Fill color")} close={close} />
    </div>
  );
}

/** Tier e in More: AutoSum, the last key to leave a very narrow toolbar. */
function MoreTierE({ actions, close }: MoreProps) {
  return (
    <div className="sheet-tier-e">
      <span className="sheet-menu-separator" role="separator" />
      <p className="sheet-menu-heading">AutoSum</p>
      {AUTOSUM_FUNCTIONS.map(([fn, label]) => (
        <MenuItem key={fn} icon={<Sigma size={16} />} label={label} ariaLabel={`AutoSum: ${label}`} onClick={() => { actions.autoSum(fn); close(); }} />
      ))}
    </div>
  );
}

/** The keys a narrow toolbar folds away, in the order they leave it. Each
 * tier shows only while its keys are hidden (spreadsheet.css). */
function MoreMenu(props: KeysProps) {
  return (
    <ToolbarMenu label="More formatting" className="sheet-tier-more" icon={<span className="sheet-toolbar-label">More</span>} tooltip="Formatting that does not fit on the toolbar at this width" disabled={props.state.readOnly} wide>
      {(close) => (
        <div className="sheet-more-menu">
          <MoreTierA {...props} close={close} />
          <MoreTierB {...props} close={close} />
          <MoreTierC {...props} close={close} />
          <MoreTierD {...props} close={close} />
          <MoreTierE {...props} close={close} />
        </div>
      )}
    </ToolbarMenu>
  );
}

export function SheetToolbar({ state, actions }: KeysProps) {
  const main = useRef<HTMLDivElement>(null);
  useFoldToFit(main, `${numberFormatLabel(state.style?.format)}|${state.style?.size ?? 10}`);
  return (
    <div className="document-toolbar-content" id="sheet-formatting-controls">
      <div className="document-toolbar-group document-toolbar-main" ref={main}>
        <button type="button" aria-label="Undo" data-tooltip="Undo the last change (⌘Z)" disabled={!state.canUndo || state.readOnly} onClick={actions.undo}><Undo2 size={18} /></button>
        <button type="button" aria-label="Redo" data-tooltip="Redo the change you undid (⌘⇧Z)" disabled={!state.canRedo || state.readOnly} onClick={actions.redo}><Redo2 size={18} /></button>
        <span className="document-toolbar-divider" aria-hidden="true" />
        <NumberKeys state={state} actions={actions} />
        <span className="document-toolbar-divider" aria-hidden="true" />
        <TextKeys state={state} actions={actions} />
        <span className="document-toolbar-divider" aria-hidden="true" />
        <AlignKeys state={state} actions={actions} />
        <span className="document-toolbar-divider" aria-hidden="true" />
        <InsertMenu state={state} actions={actions} />
        <DataMenu state={state} actions={actions} />
        <FormatMenu state={state} actions={actions} />
        <TableStylesMenu state={state} actions={actions} />
        <AutoSumMenu state={state} actions={actions} />
        <MoreMenu state={state} actions={actions} />
      </div>
    </div>
  );
}
