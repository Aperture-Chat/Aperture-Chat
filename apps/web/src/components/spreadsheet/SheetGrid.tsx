import clsx from "clsx";
import { ChevronDown, Filter, GripVertical } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type CellPoint, type CellRange, MAX_SHEET_COLS, MAX_SHEET_ROWS, cellKey, columnLabel, normalizeRange, parseCellKey, parseRangeRef, rangeContains } from "../../lib/sheet/address";
import { readChartData } from "../../lib/sheet/chartData";
import { type CellDecoration, decorationAt } from "../../lib/sheet/decorations";
import { isError } from "../../lib/sheet/formula/values";
import { type GridGeometry, HEADER_HEIGHT, HEADER_WIDTH, indexAt, type PaneKey, panesForRect, rangeRect } from "../../lib/sheet/geometry";
import { formatCellValue } from "../../lib/sheet/numberFormat";
import type { WorkbookEngine } from "../../lib/sheet/recalc";
import type { CellBorder, CellStyle, Sheet, SheetChart, Workbook } from "../../lib/sheet/sheetModel";
import { effectiveStyle, mergeAt } from "../../lib/sheet/sheetOps";
import { SheetChartView } from "./SheetChart";

export type GridHandle = {
  scrollToCell: (point: CellPoint) => void;
  viewportRows: () => number;
  focus: () => void;
};

export type RefHighlight = { range: CellRange; color: string };

export type GridPointerTarget =
  | { kind: "cell"; point: CellPoint }
  | { kind: "col"; index: number }
  | { kind: "row"; index: number }
  | { kind: "corner" };

type Props = {
  sheet: Sheet;
  workbook: Workbook;
  engine: WorkbookEngine;
  geometry: GridGeometry;
  decorations: Map<number, CellDecoration>;
  active: CellPoint;
  selection: CellRange;
  /** Rendered over the active cell while it is being edited. */
  editor: ReactNode;
  refHighlights: RefHighlight[];
  changedCells: Set<string> | null;
  marchingRange: CellRange | null;
  findMatches: Set<string> | null;
  selectedChartId: string | null;
  showGridlines: boolean;
  readOnly: boolean;
  onPointerTarget: (target: GridPointerTarget, mode: "start" | "extend" | "end", event: { shiftKey: boolean; button: number; pointerType: string; metaKey: boolean; ctrlKey: boolean }) => void;
  onDoubleClickCell: (point: CellPoint) => void;
  onFill: (source: CellRange, target: CellRange) => void;
  onFillToEnd: () => void;
  onResize: (axis: "cols" | "rows", index: number, size: number) => void;
  /** Double-click on a column or row edge: fit the column to its text, or the row to its lines. */
  onAutofit: (axis: "cols" | "rows", index: number) => void;
  onContextMenu: (target: GridPointerTarget, clientX: number, clientY: number) => void;
  onFilterButton: (col: number, anchor: DOMRect) => void;
  onValidationButton: (point: CellPoint, anchor: DOMRect) => void;
  validationCells: Set<string>;
  onChartSelect: (id: string | null) => void;
  onChartChange: (id: string, change: Partial<Pick<SheetChart, "at" | "w" | "h">>) => void;
  onChartOpen: (id: string) => void;
  onNearEnd: (axis: "rows" | "cols") => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  ariaLabel: string;
};

const FONT_FAMILY = '"Plus Jakarta Sans", "SF Pro Text", "Segoe UI", system-ui, sans-serif';
const DEFAULT_FONT_PT = 10;

let measureContext: CanvasRenderingContext2D | null | undefined;
function measureText(text: string, font: string): number {
  if (measureContext === undefined) {
    try {
      // jsdom (tests) has no canvas; fall back to an average glyph width there.
      const jsdom = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
      measureContext = typeof document !== "undefined" && !jsdom ? document.createElement("canvas").getContext("2d") : null;
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) return text.length * 7;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

export function cellFont(style: CellStyle | undefined, zoom: number): string {
  const size = ((style?.size ?? DEFAULT_FONT_PT) * 4) / 3 * zoom;
  const family = style?.font ? `"${style.font}", ${FONT_FAMILY}` : FONT_FAMILY;
  return `${style?.italic ? "italic " : ""}${style?.bold ? "700" : "400"} ${size.toFixed(1)}px ${family}`;
}

/** Width of a cell's displayed text, for autofit. */
export function measureCellText(text: string, style: CellStyle | undefined): number {
  return measureText(text, cellFont(style, 1));
}

function borderCss(border: CellBorder | undefined): string | undefined {
  if (!border) return undefined;
  const color = border.color ?? "var(--sheet-ink)";
  switch (border.style) {
    case "thin": return `1px solid ${color}`;
    case "medium": return `2px solid ${color}`;
    case "thick": return `3px solid ${color}`;
    case "dashed": return `1px dashed ${color}`;
    case "dotted": return `1px dotted ${color}`;
    case "double": return `3px double ${color}`;
  }
}

type PaneSpec = { key: PaneKey; x: number; y: number; w: number; h: number; offsetX: number; offsetY: number; rows: [number, number]; cols: [number, number] };

type CellView = {
  key: string;
  row: number;
  col: number;
  rect: { x: number; y: number; w: number; h: number };
  text: string;
  style: CSSProperties;
  textStyle: CSSProperties;
  align: "left" | "center" | "right";
  bar?: { fraction: number; color: string };
  note?: string;
  error?: string;
  filter?: { active: boolean };
  validation: boolean;
  spill: boolean;
  borders?: CSSProperties;
  changed: boolean;
  found: boolean;
};

function visibleSpan(offsets: Float64Array, from: number, to: number, start: number, count: number): [number, number] {
  const a = Math.max(start, indexAt(offsets, from));
  const b = Math.min(count - 1, indexAt(offsets, to));
  return [a, Math.max(a, b)];
}

export const SheetGrid = memo(forwardRef<GridHandle, Props>(function SheetGrid(props, ref) {
  const { sheet, workbook, engine, geometry, decorations, active, selection, editor, refHighlights, changedCells, marchingRange, findMatches, selectedChartId, showGridlines, readOnly } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 900, h: 560 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const frame = useRef<number | null>(null);
  const dragRef = useRef<null | { kind: "select" | "fill" | "resize-col" | "resize-row" | "chart-move" | "chart-resize"; startX: number; startY: number; index?: number; size?: number; chart?: SheetChart; pointerType: string; moved: boolean; target?: GridPointerTarget }>(null);
  const [fillTarget, setFillTarget] = useState<CellRange | null>(null);
  const [resizeGuide, setResizeGuide] = useState<{ axis: "cols" | "rows"; position: number } | null>(null);
  const [chartDraft, setChartDraft] = useState<{ id: string; dx: number; dy: number; w?: number; h?: number } | null>(null);
  const zoom = geometry.zoom;
  const frozenW = geometry.colOffsets[geometry.freezeCols];
  const frozenH = geometry.rowOffsets[geometry.freezeRows];

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return undefined;
    const measure = () => setViewport({ w: node.clientWidth || 900, h: node.clientHeight || 560 });
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const node = scrollRef.current;
      if (!node) return;
      setScroll({ x: node.scrollLeft, y: node.scrollTop });
      if (node.scrollTop + node.clientHeight > node.scrollHeight - 400) props.onNearEnd("rows");
      if (node.scrollLeft + node.clientWidth > node.scrollWidth - 300) props.onNearEnd("cols");
    });
  }, [props]);

  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);

  const scrollToCell = useCallback((point: CellPoint) => {
    const node = scrollRef.current;
    if (!node) return;
    const x = geometry.colOffsets[Math.min(point.col, geometry.cols - 1)];
    const y = geometry.rowOffsets[Math.min(point.row, geometry.rows - 1)];
    const w = geometry.colOffsets[Math.min(point.col + 1, geometry.cols)] - x;
    const h = geometry.rowOffsets[Math.min(point.row + 1, geometry.rows)] - y;
    const viewW = node.clientWidth - HEADER_WIDTH - frozenW;
    const viewH = node.clientHeight - HEADER_HEIGHT - frozenH;
    if (point.col >= geometry.freezeCols) {
      const left = x - frozenW;
      if (left < node.scrollLeft) node.scrollLeft = left;
      else if (left + w > node.scrollLeft + viewW) node.scrollLeft = left + w - viewW;
    }
    if (point.row >= geometry.freezeRows) {
      const top = y - frozenH;
      if (top < node.scrollTop) node.scrollTop = top;
      else if (top + h > node.scrollTop + viewH) node.scrollTop = top + h - viewH;
    }
  }, [geometry, frozenW, frozenH]);

  useImperativeHandle(ref, () => ({
    scrollToCell,
    viewportRows: () => Math.max(1, Math.floor((viewport.h - HEADER_HEIGHT) / (24 * zoom))),
    focus: () => scrollRef.current?.focus({ preventScroll: true }),
  }), [scrollToCell, viewport.h, zoom]);

  const totalW = geometry.colOffsets[geometry.cols];
  const totalH = geometry.rowOffsets[geometry.rows];

  const panes = useMemo<PaneSpec[]>(() => {
    const mainX = HEADER_WIDTH + frozenW;
    const mainY = HEADER_HEIGHT + frozenH;
    const mainW = Math.max(0, viewport.w - mainX);
    const mainH = Math.max(0, viewport.h - mainY);
    const sx = scroll.x + frozenW;
    const sy = scroll.y + frozenH;
    const rowsMain = visibleSpan(geometry.rowOffsets, sy, sy + mainH, geometry.freezeRows, geometry.rows);
    const colsMain = visibleSpan(geometry.colOffsets, sx, sx + mainW, geometry.freezeCols, geometry.cols);
    const rowsFrozen: [number, number] = [0, Math.max(0, geometry.freezeRows - 1)];
    const colsFrozen: [number, number] = [0, Math.max(0, geometry.freezeCols - 1)];
    const list: PaneSpec[] = [{ key: "main", x: mainX, y: mainY, w: mainW, h: mainH, offsetX: -sx, offsetY: -sy, rows: rowsMain, cols: colsMain }];
    if (geometry.freezeRows) list.push({ key: "top", x: mainX, y: HEADER_HEIGHT, w: mainW, h: frozenH, offsetX: -sx, offsetY: 0, rows: rowsFrozen, cols: colsMain });
    if (geometry.freezeCols) list.push({ key: "left", x: HEADER_WIDTH, y: mainY, w: frozenW, h: mainH, offsetX: 0, offsetY: -sy, rows: rowsMain, cols: colsFrozen });
    if (geometry.freezeRows && geometry.freezeCols) list.push({ key: "corner", x: HEADER_WIDTH, y: HEADER_HEIGHT, w: frozenW, h: frozenH, offsetX: 0, offsetY: 0, rows: rowsFrozen, cols: colsFrozen });
    return list;
  }, [geometry, viewport, scroll, frozenW, frozenH]);

  /* ---------------------------------------------------------- cells */

  const buildCells = useCallback((pane: PaneSpec): CellView[] => {
    const views: CellView[] = [];
    const seenMerges = new Set<string>();
    for (let row = pane.rows[0]; row <= pane.rows[1]; row += 1) {
      if (geometry.hiddenRows.has(row)) continue;
      for (let col = pane.cols[0]; col <= pane.cols[1]; col += 1) {
        if (geometry.hiddenCols.has(col)) continue;
        let anchorRow = row;
        let anchorCol = col;
        let rect = { x: geometry.colOffsets[col], y: geometry.rowOffsets[row], w: geometry.colOffsets[col + 1] - geometry.colOffsets[col], h: geometry.rowOffsets[row + 1] - geometry.rowOffsets[row] };
        const merge = sheet.merges?.length ? mergeAt(sheet, row, col) : null;
        if (merge) {
          const id = `${merge.r1}:${merge.c1}`;
          if (seenMerges.has(id)) continue;
          seenMerges.add(id);
          anchorRow = merge.r1;
          anchorCol = merge.c1;
          rect = rangeRect(geometry, merge);
        }
        const address = cellKey(anchorRow, anchorCol);
        const cell = sheet.cells[address];
        const style = effectiveStyle(sheet, anchorRow, anchorCol);
        const decoration = decorationAt(decorations, anchorRow, anchorCol);
        const value = engine.value(sheet.id, anchorRow, anchorCol);
        const derived = cell?.f === undefined && cell?.v === undefined ? engine.derivedSource(sheet.id, anchorRow, anchorCol) : null;
        const changed = Boolean(changedCells?.has(address));
        const found = Boolean(findMatches?.has(address));
        const validation = props.validationCells.has(address) && anchorRow === active.row && anchorCol === active.col;
        if (value === null && !style && !decoration && !cell?.n && !merge && !changed && !found && !validation) continue;
        const format = style?.format ?? (derived?.kind === "pivot" ? engine.pivotCellFormat(sheet.id, anchorRow, anchorCol) : undefined);
        const formatted = formatCellValue(value, format);
        const align = style?.align ?? formatted.align;
        const fill = decoration?.fill && !style?.fill ? decoration.fill : style?.fill ?? decoration?.fill;
        const font = cellFont({ ...style, bold: style?.bold ?? decoration?.bold }, zoom);
        let text = formatted.text;
        const wrap = Boolean(style?.wrap);
        let overflowW = rect.w;
        if (!wrap && !merge && typeof value === "string" && align === "left" && text) {
          const needed = measureText(text, font) + 8 * zoom;
          for (let next = anchorCol + 1; overflowW < needed && next <= pane.cols[1] + 6 && next < geometry.cols; next += 1) {
            const neighbor = engine.value(sheet.id, anchorRow, next);
            if (neighbor !== null && neighbor !== "") break;
            overflowW += geometry.colOffsets[next + 1] - geometry.colOffsets[next];
          }
        } else if (typeof value === "number" && !wrap && text && measureText(text, font) + 6 * zoom > rect.w && !format?.includes("@")) {
          // Excel shows ##### when a number is wider than its column.
          text = "#".repeat(Math.max(1, Math.floor(rect.w / (7 * zoom))));
        }
        // A filled cell with no text colour of its own gets ink that contrasts
        // with the fill, so light fills stay readable in dark mode too.
        const decorated = (decoration?.color && !style?.color ? decoration.color : style?.color) ?? (fill ? contrastInk(fill) : undefined);
        const view: CellView = {
          key: address,
          row: anchorRow,
          col: anchorCol,
          rect,
          text,
          align,
          style: {
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            background: fill ?? (merge ? "var(--sheet-bg)" : undefined),
            justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start",
            alignItems: style?.valign === "top" ? "flex-start" : style?.valign === "middle" ? "center" : "flex-end",
            zIndex: overflowW > rect.w ? 2 : undefined,
          },
          textStyle: {
            font,
            color: formatted.color ?? decorated,
            textDecoration: [style?.underline && "underline", style?.strike && "line-through"].filter(Boolean).join(" ") || undefined,
            whiteSpace: wrap ? "pre-wrap" : "pre",
            width: overflowW > rect.w ? overflowW : undefined,
            flexShrink: overflowW > rect.w ? 0 : undefined,
            paddingLeft: style?.indent ? style.indent * 9 * zoom + 4 * zoom : undefined,
            textAlign: align,
          },
          bar: decoration?.bar,
          note: cell?.n,
          error: isError(value) ? value.message ?? value.code : undefined,
          filter: decoration?.filterButton,
          validation,
          spill: derived?.kind === "spill",
          changed,
          found,
        };
        const border = style?.border;
        if (border || decoration?.lineBottom || decoration?.lineTop) {
          view.borders = {
            left: rect.x - 1,
            top: rect.y - 1,
            width: rect.w + 1,
            height: rect.h + 1,
            borderTop: borderCss(border?.top) ?? (decoration?.lineTop ? `1px solid ${decoration.lineTop}` : undefined),
            borderBottom: borderCss(border?.bottom) ?? (decoration?.lineBottom ? `1px solid ${decoration.lineBottom}` : undefined),
            borderLeft: borderCss(border?.left),
            borderRight: borderCss(border?.right),
          };
        }
        views.push(view);
      }
    }
    return views;
  }, [sheet, engine, geometry, decorations, zoom, changedCells, findMatches, props.validationCells, active.row, active.col]);

  /* ---------------------------------------------------------- pointer */

  const targetAt = useCallback((clientX: number, clientY: number): GridPointerTarget | null => {
    const node = scrollRef.current;
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const vx = clientX - box.left;
    const vy = clientY - box.top;
    const contentX = vx < HEADER_WIDTH + frozenW ? vx - HEADER_WIDTH : vx - HEADER_WIDTH + scroll.x;
    const contentY = vy < HEADER_HEIGHT + frozenH ? vy - HEADER_HEIGHT : vy - HEADER_HEIGHT + scroll.y;
    if (vx < HEADER_WIDTH && vy < HEADER_HEIGHT) return { kind: "corner" };
    const col = indexAt(geometry.colOffsets, Math.max(0, contentX));
    const row = indexAt(geometry.rowOffsets, Math.max(0, contentY));
    if (vy < HEADER_HEIGHT) return { kind: "col", index: col };
    if (vx < HEADER_WIDTH) return { kind: "row", index: row };
    return { kind: "cell", point: { row, col } };
  }, [geometry, scroll, frozenW, frozenH]);

  /** The column or row edge handle under the pointer, if any. */
  const resizeHandleAt = (element: HTMLElement): { axis: "cols" | "rows"; index: number } | null => {
    const handle = element.closest<HTMLElement>("[data-resize-axis]");
    if (!handle) return null;
    return { axis: handle.dataset.resizeAxis === "rows" ? "rows" : "cols", index: Number(handle.dataset.resizeIndex) };
  };

  const eventInfo = (event: ReactPointerEvent | PointerEvent) => ({
    shiftKey: event.shiftKey,
    button: event.button,
    pointerType: event.pointerType,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
  });

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement;
    if (element.closest(".sheet-filter-button, .sheet-validation-button, .sheet-chart, .sheet-cell-editor, .sheet-fill-handle")) return;
    if (event.button === 2) return;
    const border = resizeHandleAt(element);
    if (border && !readOnly) {
      event.preventDefault();
      const size = border.axis === "cols"
        ? geometry.colOffsets[border.index + 1] - geometry.colOffsets[border.index]
        : geometry.rowOffsets[border.index + 1] - geometry.rowOffsets[border.index];
      dragRef.current = { kind: border.axis === "cols" ? "resize-col" : "resize-row", startX: event.clientX, startY: event.clientY, index: border.index, size, pointerType: event.pointerType, moved: false };
      // Keep the resize cursor while the pointer runs ahead of the handle.
      if (scrollRef.current) scrollRef.current.dataset.resize = border.axis;
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      return;
    }
    const target = targetAt(event.clientX, event.clientY);
    if (!target) return;
    if (event.pointerType === "touch") {
      // Touch scrolls natively; a tap selects on pointerup.
      dragRef.current = { kind: "select", startX: event.clientX, startY: event.clientY, pointerType: "touch", moved: false, target };
      return;
    }
    event.preventDefault();
    scrollRef.current?.focus({ preventScroll: true });
    props.onPointerTarget(target, "start", eventInfo(event));
    dragRef.current = { kind: "select", startX: event.clientX, startY: event.clientY, pointerType: event.pointerType, moved: false, target };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved && Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 4) {
      drag.moved = true;
      if (drag.kind === "chart-move" || drag.kind === "chart-resize") scrollRef.current?.setPointerCapture?.(event.pointerId);
    }
    if (drag.kind === "resize-col" || drag.kind === "resize-row") {
      const delta = drag.kind === "resize-col" ? event.clientX - drag.startX : event.clientY - drag.startY;
      const size = Math.max(drag.kind === "resize-col" ? 24 : 18, (drag.size ?? 0) + delta);
      const base = drag.kind === "resize-col" ? geometry.colOffsets[drag.index!] : geometry.rowOffsets[drag.index!];
      setResizeGuide({ axis: drag.kind === "resize-col" ? "cols" : "rows", position: base + size });
      return;
    }
    if (drag.pointerType === "touch") return;
    if (drag.kind === "fill") {
      const target = targetAt(event.clientX, event.clientY);
      if (target?.kind !== "cell") return;
      const { row, col } = target.point;
      const down = row - selection.r2;
      const up = selection.r1 - row;
      const right = col - selection.c2;
      const left = selection.c1 - col;
      const best = Math.max(down, up, right, left);
      if (best <= 0) setFillTarget(null);
      else if (best === down) setFillTarget({ ...selection, r2: row });
      else if (best === up) setFillTarget({ ...selection, r1: row });
      else if (best === right) setFillTarget({ ...selection, c2: col });
      else setFillTarget({ ...selection, c1: col });
      return;
    }
    if (drag.kind === "chart-move" || drag.kind === "chart-resize") {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (drag.kind === "chart-move") setChartDraft({ id: drag.chart!.id, dx, dy });
      else setChartDraft({ id: drag.chart!.id, dx: 0, dy: 0, w: Math.max(200, drag.chart!.w + dx / zoom), h: Math.max(140, drag.chart!.h + dy / zoom) });
      return;
    }
    const target = targetAt(event.clientX, event.clientY);
    if (target && drag.moved) props.onPointerTarget(target, "extend", eventInfo(event));
    autoScroll(event.clientX, event.clientY);
  };

  const autoScroll = (clientX: number, clientY: number) => {
    const node = scrollRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    if (clientY > box.bottom - 20) node.scrollTop += 24;
    else if (clientY < box.top + HEADER_HEIGHT + frozenH + 8 && node.scrollTop > 0) node.scrollTop -= 24;
    if (clientX > box.right - 20) node.scrollLeft += 40;
    else if (clientX < box.left + HEADER_WIDTH + frozenW + 8 && node.scrollLeft > 0) node.scrollLeft -= 40;
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === "resize-col" || drag.kind === "resize-row") {
      setResizeGuide(null);
      if (scrollRef.current) scrollRef.current.dataset.resize = "";
      const delta = drag.kind === "resize-col" ? event.clientX - drag.startX : event.clientY - drag.startY;
      if (drag.moved) props.onResize(drag.kind === "resize-col" ? "cols" : "rows", drag.index!, Math.max(18, ((drag.size ?? 0) + delta) / zoom));
      return;
    }
    if (drag.kind === "fill") {
      const target = fillTarget;
      setFillTarget(null);
      if (target) props.onFill(selection, target);
      return;
    }
    if (drag.kind === "chart-move" || drag.kind === "chart-resize") {
      const draft = chartDraft;
      setChartDraft(null);
      if (!draft || !drag.moved) return;
      if (drag.kind === "chart-resize") {
        props.onChartChange(drag.chart!.id, { w: Math.round(draft.w ?? drag.chart!.w), h: Math.round(draft.h ?? drag.chart!.h) });
      } else {
        const origin = parseCellKey(drag.chart!.at)!;
        const x = geometry.colOffsets[origin.col] + draft.dx;
        const y = geometry.rowOffsets[origin.row] + draft.dy;
        const col = indexAt(geometry.colOffsets, Math.max(0, x + 4));
        const row = indexAt(geometry.rowOffsets, Math.max(0, y + 4));
        props.onChartChange(drag.chart!.id, { at: cellKey(row, col) });
      }
      return;
    }
    if (drag.pointerType === "touch") {
      if (!drag.moved && drag.target) props.onPointerTarget(drag.target, "start", eventInfo(event));
      return;
    }
    const target = targetAt(event.clientX, event.clientY);
    if (target) props.onPointerTarget(target, "end", eventInfo(event));
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement;
    if (element.closest(".sheet-chart")) return;
    const border = resizeHandleAt(element);
    if (border) {
      if (!readOnly) props.onAutofit(border.axis, border.index);
      return;
    }
    const target = targetAt(event.clientX, event.clientY);
    if (target?.kind === "cell") props.onDoubleClickCell(target.point);
  };

  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = targetAt(event.clientX, event.clientY);
    if (!target) return;
    event.preventDefault();
    props.onContextMenu(target, event.clientX, event.clientY);
  };

  const startFill = (event: ReactPointerEvent<HTMLElement>) => {
    if (readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { kind: "fill", startX: event.clientX, startY: event.clientY, pointerType: event.pointerType, moved: false };
    scrollRef.current?.setPointerCapture?.(event.pointerId);
  };

  const startChartDrag = (event: ReactPointerEvent<HTMLElement>, chart: SheetChart, kind: "chart-move" | "chart-resize") => {
    if (event.button !== 0) return;
    event.stopPropagation();
    props.onChartSelect(chart.id);
    if (readOnly) return;
    event.preventDefault();
    // The grid takes the pointer only once the chart really moves (see onPointerMove), so a
    // click or double-click still lands on the chart itself.
    dragRef.current = { kind, startX: event.clientX, startY: event.clientY, chart, pointerType: event.pointerType, moved: false };
  };

  /* ---------------------------------------------------------- overlays */

  const selectionRect = rangeRect(geometry, selection);
  const activeMerge = mergeAt(sheet, active.row, active.col);
  const activeRect = rangeRect(geometry, activeMerge ?? { r1: active.row, c1: active.col, r2: active.row, c2: active.col });
  const spill = engine.spillRange(sheet.id, active.row, active.col);
  const multi = selection.r1 !== selection.r2 || selection.c1 !== selection.c2;
  const activePaneKey = active.row < geometry.freezeRows
    ? (active.col < geometry.freezeCols ? "corner" : "top")
    : active.col < geometry.freezeCols ? "left" : "main";

  const charts = sheet.charts ?? [];
  const chartViews = useMemo(() => charts.map((chart) => ({ chart, data: readChartData(chart, sheet, workbook, engine) })), [charts, sheet, workbook, engine]);

  /** Where a chart sits in sheet pixels, following an in-progress move or resize. */
  const chartBox = (chart: SheetChart) => {
    const point = parseCellKey(chart.at);
    if (!point) return null;
    const draft = chartDraft?.id === chart.id ? chartDraft : null;
    return {
      x: geometry.colOffsets[point.col] + (draft?.dx ?? 0) + 2,
      y: geometry.rowOffsets[point.row] + (draft?.dy ?? 0) + 2,
      w: (draft?.w ?? chart.w) * zoom,
      h: (draft?.h ?? chart.h) * zoom,
      home: homePane(point.row, point.col),
    };
  };
  const chartPanes = (chart: SheetChart): PaneKey[] => {
    const box = chartBox(chart);
    return box ? panesForRect(geometry, box) : [];
  };
  /** The pane holding the chart's anchor cell: its copy there is the one people use. */
  const homePane = (row: number, col: number): PaneKey => {
    const frozenRow = row < geometry.freezeRows;
    const frozenCol = col < geometry.freezeCols;
    return frozenRow && frozenCol ? "corner" : frozenRow ? "top" : frozenCol ? "left" : "main";
  };

  const renderPane = (pane: PaneSpec) => {
    const cells = buildCells(pane);
    const lines: ReactNode[] = [];
    if (showGridlines) {
      for (let col = pane.cols[0]; col <= pane.cols[1]; col += 1) {
        if (geometry.hiddenCols.has(col)) continue;
        lines.push(<span key={`v${col}`} className="sheet-gridline is-vertical" style={{ left: geometry.colOffsets[col + 1] - 1, top: geometry.rowOffsets[pane.rows[0]], height: geometry.rowOffsets[pane.rows[1] + 1] - geometry.rowOffsets[pane.rows[0]] }} />);
      }
      for (let row = pane.rows[0]; row <= pane.rows[1]; row += 1) {
        if (geometry.hiddenRows.has(row)) continue;
        lines.push(<span key={`h${row}`} className="sheet-gridline" style={{ top: geometry.rowOffsets[row + 1] - 1, left: geometry.colOffsets[pane.cols[0]], width: geometry.colOffsets[pane.cols[1] + 1] - geometry.colOffsets[pane.cols[0]] }} />);
      }
    }
    const inPaneCharts = chartViews.filter(({ chart }) => chartPanes(chart).includes(pane.key));
    return (
      <div key={pane.key} className={`sheet-pane is-${pane.key}`} style={{ left: pane.x, top: pane.y, width: pane.w, height: pane.h }}>
        <div className="sheet-pane-content" style={{ transform: `translate(${pane.offsetX}px, ${pane.offsetY}px)`, width: totalW, height: totalH }}>
          {lines}
          {cells.map((view) => (
            <div
              key={view.key}
              className={clsx("sheet-cell", view.changed && "is-ai-changed", view.found && "is-found", view.error && "is-error", view.spill && "is-spilled")}
              style={view.style}
              data-cell={view.key}
              data-tooltip={view.note ?? view.error}
            >
              {view.bar && <span className="sheet-cell-bar" style={{ width: `${Math.round(view.bar.fraction * 100)}%`, background: view.bar.color }} aria-hidden="true" />}
              <span className="sheet-cell-text" style={view.textStyle}>{view.text}</span>
              {view.note && <span className="sheet-cell-note" aria-label="Has a note" />}
              {view.error && <span className="sheet-cell-error-mark" aria-hidden="true" />}
              {view.filter && (
                <button
                  type="button"
                  className={clsx("sheet-filter-button", view.filter.active && "is-active")}
                  aria-label={`Filter ${columnLabel(view.col)}`}
                  data-tooltip={view.filter.active ? "Filtered — change or clear this filter" : "Sort and filter this column"}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => props.onFilterButton(view.col, event.currentTarget.getBoundingClientRect())}
                >
                  {view.filter.active ? <Filter size={11} /> : <ChevronDown size={12} />}
                </button>
              )}
              {view.validation && !readOnly && (
                <button
                  type="button"
                  className="sheet-validation-button"
                  aria-label="Choose from the list"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => props.onValidationButton({ row: view.row, col: view.col }, event.currentTarget.getBoundingClientRect())}
                >
                  <ChevronDown size={13} />
                </button>
              )}
            </div>
          ))}
          {cells.filter((view) => view.borders).map((view) => <span key={`b-${view.key}`} className="sheet-cell-borders" style={view.borders} aria-hidden="true" />)}
          {spill && <span className="sheet-spill-outline" style={rectStyle(rangeRect(geometry, spill))} aria-hidden="true" />}
          {refHighlights.map((item, index) => (
            <span key={`ref-${index}`} className="sheet-ref-highlight" style={{ ...rectStyle(rangeRect(geometry, item.range)), borderColor: item.color, background: `${item.color}1a` }} aria-hidden="true" />
          ))}
          {marchingRange && <span className="sheet-marching" style={rectStyle(rangeRect(geometry, marchingRange))} aria-hidden="true" />}
          {multi && <span className="sheet-selection-fill" style={rectStyle(selectionRect)} aria-hidden="true" />}
          <span className="sheet-selection" style={rectStyle(selectionRect)} aria-hidden="true" />
          <span className="sheet-active-cell" style={rectStyle(activeRect)} aria-hidden="true" />
          {fillTarget && <span className="sheet-fill-preview" style={rectStyle(rangeRect(geometry, fillTarget))} aria-hidden="true" />}
          {!readOnly && !editor && (
            <span
              className="sheet-fill-handle"
              style={{ left: selectionRect.x + selectionRect.w - 4, top: selectionRect.y + selectionRect.h - 4 }}
              onPointerDown={startFill}
              onDoubleClick={(event) => { event.stopPropagation(); props.onFillToEnd(); }}
              data-tooltip="Drag to fill a series; double-click to fill down"
              role="presentation"
            />
          )}
          {editor && pane.key === activePaneKey && (
            <div className="sheet-editor-slot" style={{ left: activeRect.x, top: activeRect.y, minWidth: activeRect.w, minHeight: activeRect.h }}>{editor}</div>
          )}
          {inPaneCharts.map(({ chart, data }) => {
            const box = chartBox(chart)!;
            const selected = selectedChartId === chart.id;
            // A chart that crosses the freeze line also shows in the next pane; that copy is for the eye only.
            const mirror = box.home !== pane.key;
            return (
              <div
                key={chart.id}
                className={clsx("sheet-chart", selected && "is-selected")}
                style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                onPointerDown={(event) => startChartDrag(event, chart, "chart-move")}
                onDoubleClick={() => props.onChartOpen(chart.id)}
                role={mirror ? undefined : "group"}
                aria-label={mirror ? undefined : `${chart.title || "Untitled"} chart`}
                aria-hidden={mirror || undefined}
                data-tooltip={mirror ? undefined : "Double-click to edit the chart"}
              >
                <SheetChartView chart={chart} data={data} width={box.w} height={box.h} />
                {selected && !readOnly && (
                  <>
                    <span className="sheet-chart-grip" aria-hidden="true"><GripVertical size={14} /></span>
                    <span className="sheet-chart-resize" onPointerDown={(event) => startChartDrag(event, chart, "chart-resize")} aria-label="Resize chart" role="presentation" />
                  </>
                )}
              </div>
            );
          })}
          {resizeGuide && pane.key === "main" && (
            <span className={clsx("sheet-resize-guide", resizeGuide.axis === "rows" && "is-row")} style={resizeGuide.axis === "cols" ? { left: resizeGuide.position - 1, top: 0, height: totalH } : { top: resizeGuide.position - 1, left: 0, width: totalW }} aria-hidden="true" />
          )}
        </div>
      </div>
    );
  };

  /* ---------------------------------------------------------- headers */

  const mainPane = panes[0];
  const colHeaderRanges: { cols: [number, number]; offset: number; x: number; w: number }[] = [{ cols: mainPane.cols, offset: -(scroll.x + frozenW), x: HEADER_WIDTH + frozenW, w: mainPane.w }];
  if (geometry.freezeCols) colHeaderRanges.push({ cols: [0, geometry.freezeCols - 1], offset: 0, x: HEADER_WIDTH, w: frozenW });
  const rowHeaderRanges: { rows: [number, number]; offset: number; y: number; h: number }[] = [{ rows: mainPane.rows, offset: -(scroll.y + frozenH), y: HEADER_HEIGHT + frozenH, h: mainPane.h }];
  if (geometry.freezeRows) rowHeaderRanges.push({ rows: [0, geometry.freezeRows - 1], offset: 0, y: HEADER_HEIGHT, h: frozenH });
  // Whole columns run to the sheet's last row and whole rows to its last column,
  // however far the grid has been laid out.
  const allCols = selection.r1 === 0 && selection.r2 >= MAX_SHEET_ROWS - 1;
  const allRows = selection.c1 === 0 && selection.c2 >= MAX_SHEET_COLS - 1;

  return (
    <div
      ref={scrollRef}
      className={clsx("sheet-scroll", !showGridlines && "is-gridless")}
      tabIndex={0}
      role="grid"
      aria-label={props.ariaLabel}
      aria-rowcount={geometry.rows}
      aria-colcount={geometry.cols}
      aria-activedescendant={undefined}
      onScroll={handleScroll}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { dragRef.current = null; setFillTarget(null); setResizeGuide(null); setChartDraft(null); if (scrollRef.current) scrollRef.current.dataset.resize = ""; }}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onKeyDown={props.onKeyDown}
    >
      <div className="sheet-spacer" style={{ width: HEADER_WIDTH + totalW, height: HEADER_HEIGHT + totalH }} aria-hidden="true" />
      <div className="sheet-viewport" style={{ "--sheet-zoom": zoom } as CSSProperties}>
        {panes.map(renderPane)}
        {colHeaderRanges.map((band, index) => (
          <div key={`ch-${index}`} className="sheet-col-headers" style={{ left: band.x, width: band.w, height: HEADER_HEIGHT }}>
            <div className="sheet-pane-content" style={{ transform: `translate(${band.offset}px, 0)` }}>
              {Array.from({ length: band.cols[1] - band.cols[0] + 1 }, (_, i) => band.cols[0] + i).map((col) => {
                if (geometry.hiddenCols.has(col)) return <span key={col} className="sheet-hidden-marker is-col" style={{ left: geometry.colOffsets[col] - 2 }} aria-hidden="true" />;
                const selected = col >= selection.c1 && col <= selection.c2;
                return (
                  <div key={col} className={clsx("sheet-header", selected && "is-selected", selected && allCols && "is-full")} style={{ left: geometry.colOffsets[col], width: geometry.colOffsets[col + 1] - geometry.colOffsets[col], height: HEADER_HEIGHT }} role="columnheader" aria-label={`Column ${columnLabel(col)}`}>
                    {columnLabel(col)}
                    {!readOnly && <ResizeHandle axis="cols" index={col} label={`Resize column ${columnLabel(col)}`} />}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {rowHeaderRanges.map((band, index) => (
          <div key={`rh-${index}`} className="sheet-row-headers" style={{ top: band.y, height: band.h, width: HEADER_WIDTH }}>
            <div className="sheet-pane-content" style={{ transform: `translate(0, ${band.offset}px)` }}>
              {Array.from({ length: band.rows[1] - band.rows[0] + 1 }, (_, i) => band.rows[0] + i).map((row) => {
                if (geometry.hiddenRows.has(row)) return null;
                const selected = row >= selection.r1 && row <= selection.r2;
                return (
                  <div key={row} className={clsx("sheet-header is-row", selected && "is-selected", selected && allRows && "is-full")} style={{ top: geometry.rowOffsets[row], height: geometry.rowOffsets[row + 1] - geometry.rowOffsets[row], width: HEADER_WIDTH }} role="rowheader" aria-label={`Row ${row + 1}`}>
                    {row + 1}
                    {!readOnly && <ResizeHandle axis="rows" index={row} label={`Resize row ${row + 1}`} />}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div className={clsx("sheet-corner", allCols && allRows && "is-selected")} style={{ width: HEADER_WIDTH, height: HEADER_HEIGHT }} aria-label="Select all" role="button" data-tooltip="Select the whole sheet (⌘A twice)" />
        {geometry.freezeRows > 0 && <span className="sheet-freeze-line" style={{ top: HEADER_HEIGHT + frozenH - 1, left: 0, right: 0 }} aria-hidden="true" />}
        {geometry.freezeCols > 0 && <span className="sheet-freeze-line is-vertical" style={{ left: HEADER_WIDTH + frozenW - 1, top: 0, bottom: 0 }} aria-hidden="true" />}
      </div>
    </div>
  );
}));

/** The grab strip on a header's trailing edge: drag to resize, double-click to fit. */
function ResizeHandle({ axis, index, label }: { axis: "cols" | "rows"; index: number; label: string }) {
  return (
    <span
      className={clsx("sheet-resize-handle", axis === "rows" ? "is-row" : "is-col")}
      role="separator"
      aria-orientation={axis === "rows" ? "horizontal" : "vertical"}
      aria-label={label}
      data-resize-axis={axis}
      data-resize-index={index}
      data-tooltip={axis === "rows" ? "Drag to resize · double-click to fit" : "Drag to resize · double-click to fit the text"}
    />
  );
}

function contrastInk(fill: string): string | undefined {
  if (!/^#[0-9a-f]{6}$/i.test(fill)) return undefined;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? "#1d2a30" : "#ffffff";
}

function rectStyle(rect: { x: number; y: number; w: number; h: number }): CSSProperties {
  return { left: rect.x, top: rect.y, width: Math.max(0, rect.w), height: Math.max(0, rect.h) };
}

/** Parses a range typed in the name box ("B4", "A1:C9", "C:C"). */
export function parseNameBoxRange(text: string): CellRange | null {
  return parseRangeRef(text.replace(/\s+/g, ""));
}

export { normalizeRange, rangeContains };
