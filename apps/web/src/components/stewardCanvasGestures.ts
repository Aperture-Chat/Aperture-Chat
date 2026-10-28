/** Gesture logic for the structure-diagram canvas: what a press starts, how
 * a drag advances, what a release saves, and what a key does. Pure
 * functions plus the hooks that wire them to pointer, keyboard, and timer
 * events; the canvas component only renders. */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  removeStewardCard,
  type StewardDiagramCardBox,
  type StewardDiagramLayout,
  type StewardDiagramModel,
  type StewardDiagramPathEl,
} from "../lib/stewardDiagram";
import {
  addStewardEdge,
  reconnectStewardEdge,
  removeStewardEdge,
  snapStewardCardPosition,
  stewardCardAt,
  withStewardCardPosition,
  withStewardEdgeBend,
  type StewardGuide,
} from "../lib/stewardDiagramEdits";
import { stewardBendFromPointer, type Point, type StewardEdgeHandle } from "../lib/stewardDiagramRoutes";

export type Pt = { x: number; y: number };

export type Selection = { kind: "card"; id: string } | { kind: "edge"; index: number } | null;

export type Drag =
  | { kind: "card"; pointerId: number; id: string; start: Pt; origin: Pt; moved: boolean; at: Pt; guides: StewardGuide[] }
  | { kind: "bend"; pointerId: number; index: number; handle: StewardEdgeHandle; bend: number; moved: boolean }
  | { kind: "endpoint"; pointerId: number; index: number; end: "from" | "to"; anchor: Pt; point: Pt; skipId: string }
  | { kind: "connect"; pointerId: number; fromId: string; anchor: Pt; point: Pt; skipId: string };

export type Nudge = { id: string; at: Pt };

/** Screen pixels a press must travel before it becomes a drag, so a click
 * on text still opens the inline editor. */
const DRAG_THRESHOLD_PX = 4;
/** Keyboard nudges settle into one saved edit after this pause. */
const NUDGE_COMMIT_MS = 400;
const POSITION_INSET = 4;

export function pt(point: Point): Pt {
  return { x: point[0], y: point[1] };
}

export function clampToCanvas(at: Pt, box: StewardDiagramCardBox, layout: StewardDiagramLayout): Pt {
  const maxX = Math.max(POSITION_INSET, layout.width - box.width - POSITION_INSET);
  return { x: Math.min(Math.max(at.x, POSITION_INSET), maxX), y: Math.max(at.y, layout.contentTop) };
}

function advanceCardDrag(drag: Extract<Drag, { kind: "card" }>, point: Pt, layout: StewardDiagramLayout, scale: number): Drag {
  const dx = point.x - drag.start.x;
  const dy = point.y - drag.start.y;
  const moved = drag.moved || Math.hypot(dx, dy) * scale >= DRAG_THRESHOLD_PX;
  const box = layout.cardBoxes.find((item) => item.id === drag.id);
  if (!moved || !box) return drag;
  const others = layout.cardBoxes.filter((item) => item.id !== drag.id);
  const snapped = snapStewardCardPosition({ x: drag.origin.x + dx, y: drag.origin.y + dy }, box, others);
  return { ...drag, moved, at: clampToCanvas(snapped, box, layout), guides: snapped.guides };
}

export function advanceDrag(drag: Drag, point: Pt, layout: StewardDiagramLayout, scale: number): Drag {
  if (drag.kind === "card") return advanceCardDrag(drag, point, layout, scale);
  if (drag.kind === "bend") return { ...drag, moved: true, bend: stewardBendFromPointer(drag.handle, point) };
  return { ...drag, point };
}

/** What the canvas shows mid-gesture: the dragged card or bent arrow in its
 * new place, before anything is saved. */
export function previewModel(model: StewardDiagramModel, drag: Drag | null, nudge: Nudge | null): StewardDiagramModel {
  if (drag?.kind === "card" && drag.moved) return withStewardCardPosition(model, drag.id, drag.at);
  if (drag?.kind === "bend" && drag.moved) return withStewardEdgeBend(model, drag.index, drag.bend);
  if (nudge) return withStewardCardPosition(model, nudge.id, nudge.at);
  return model;
}

/** The saved edit a finished gesture makes, or null when it changes nothing. */
export function dragResult(drag: Drag, point: Pt, model: StewardDiagramModel, layout: StewardDiagramLayout) {
  if (drag.kind === "card") return drag.moved ? withStewardCardPosition(model, drag.id, drag.at) : null;
  if (drag.kind === "bend") return drag.moved ? withStewardEdgeBend(model, drag.index, drag.bend) : null;
  const target = stewardCardAt(layout.cardBoxes, point, drag.skipId);
  if (!target) return null;
  return drag.kind === "endpoint"
    ? reconnectStewardEdge(model, drag.index, drag.end, target)
    : addStewardEdge(model, drag.fromId, target);
}

export function cardDrag(pointerId: number, box: StewardDiagramCardBox, start: Pt): Drag {
  const origin = { x: box.x, y: box.y };
  return { kind: "card", pointerId, id: box.id, start, origin, at: origin, moved: false, guides: [] };
}

export function bendDrag(pointerId: number, path: StewardDiagramPathEl, model: StewardDiagramModel): Drag | null {
  if (!path.handle || path.edgeIndex === undefined) return null;
  const bend = model.edges[path.edgeIndex]?.bend ?? 0;
  return { kind: "bend", pointerId, index: path.edgeIndex, handle: path.handle, bend, moved: false };
}

export function endpointDrag(
  pointerId: number,
  path: StewardDiagramPathEl,
  end: "from" | "to",
  model: StewardDiagramModel,
  point: Pt,
): Drag | null {
  const edge = path.edgeIndex === undefined ? undefined : model.edges[path.edgeIndex];
  if (!edge || !path.ends) return null;
  const anchor = pt(end === "from" ? path.ends.to : path.ends.from);
  const skipId = end === "from" ? edge.to : edge.from;
  return { kind: "endpoint", pointerId, index: path.edgeIndex!, end, anchor, point, skipId };
}

export function connectDrag(pointerId: number, cardId: string, anchor: Pt, point: Pt): Drag {
  return { kind: "connect", pointerId, fromId: cardId, anchor, point, skipId: cardId };
}

export type KeyAction =
  | { type: "undo" }
  | { type: "redo" }
  | { type: "deselect" }
  | { type: "delete" }
  | { type: "nudge"; delta: Pt; step: number };

const ARROW_KEYS: Record<string, Pt> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

type KeyInput = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };

function historyAction(event: KeyInput): KeyAction | null {
  if (!event.metaKey && !event.ctrlKey) return null;
  const key = event.key.toLowerCase();
  if (key === "y" || (key === "z" && event.shiftKey)) return { type: "redo" };
  return key === "z" ? { type: "undo" } : null;
}

/** What a key pressed on the canvas does, given the current selection. */
export function canvasKeyAction(event: KeyInput, selection: Selection): KeyAction | null {
  const history = historyAction(event);
  if (history) return history;
  if (event.key === "Escape") return { type: "deselect" };
  if (!selection) return null;
  if (event.key === "Delete" || event.key === "Backspace") return { type: "delete" };
  const delta = ARROW_KEYS[event.key];
  if (!delta || selection.kind !== "card") return null;
  return { type: "nudge", delta, step: event.shiftKey ? 10 : 1 };
}

/** The model without the selected box or arrow. */
export function withoutSelection(model: StewardDiagramModel, selection: Exclude<Selection, null>): StewardDiagramModel {
  return selection.kind === "card" ? removeStewardCard(model, selection.id) : removeStewardEdge(model, selection.index);
}

/** Live values the window listeners read without re-subscribing. */
export type GestureContext = {
  layout: StewardDiagramLayout;
  scale: number;
  displayModel: StewardDiagramModel;
  commit: (next: StewardDiagramModel) => void;
  select: (selection: Selection) => void;
  svg: SVGSVGElement | null;
};

export function designPoint(svg: SVGSVGElement | null, scale: number, event: { clientX: number; clientY: number }): Pt {
  const rect = svg?.getBoundingClientRect();
  const factor = scale > 0 ? scale : 1;
  return { x: (event.clientX - (rect?.left ?? 0)) / factor, y: (event.clientY - (rect?.top ?? 0)) / factor };
}

/** What stays selected after a gesture: the dragged box, the bent or
 * reconnected arrow, or a newly drawn arrow. */
function selectionAfter(settled: Drag, next: StewardDiagramModel | null): Selection {
  if (settled.kind === "card") return { kind: "card", id: settled.id };
  if (settled.kind === "connect") return next ? { kind: "edge", index: next.edges.length - 1 } : null;
  return { kind: "edge", index: settled.index };
}

function settleDrag(settled: Drag, point: Pt, ctx: GestureContext, suppressClick: MutableRefObject<boolean>) {
  const next = dragResult(settled, point, ctx.displayModel, ctx.layout);
  suppressClick.current = settled.kind === "card" && settled.moved;
  if (next) ctx.commit(next);
  const selection = selectionAfter(settled, next);
  if (selection) ctx.select(selection);
}

/** One pointer gesture at a time, followed on the window until release. */
export function useCanvasDrag(live: MutableRefObject<GestureContext>) {
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);

  const setDrag = useCallback((next: Drag | null) => {
    dragRef.current = next;
    setDragState(next);
  }, []);

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const follow = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return null;
      const point = designPoint(live.current.svg, live.current.scale, event);
      return { point, next: advanceDrag(current, point, live.current.layout, live.current.scale || 1) };
    };
    const move = (event: PointerEvent) => {
      const step = follow(event);
      if (step) setDrag(step.next);
    };
    const finish = (event: PointerEvent) => {
      const step = follow(event);
      if (!step) return;
      setDrag(null);
      settleDrag(step.next, step.point, live.current, suppressClick);
    };
    const cancel = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [dragging, live, setDrag]);

  const begin = useCallback(
    (next: Drag | null) => {
      if (!next) return;
      suppressClick.current = false;
      setDrag(next);
    },
    [setDrag],
  );

  /** True once for the click that ends a real drag, so it opens no editor. */
  const swallowClick = useCallback(() => {
    const swallow = suppressClick.current;
    suppressClick.current = false;
    return swallow;
  }, []);

  return { drag, begin, swallowClick };
}

/** Arrow-key nudges move the box at once and save after a short pause; a
 * pending nudge is saved, not dropped, when the figure goes away. */
export function useCardNudge(live: MutableRefObject<GestureContext>) {
  const [nudge, setNudge] = useState<Nudge | null>(null);
  const pending = useRef<Nudge | null>(null);
  const timer = useRef<number | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const settled = pending.current;
    pending.current = null;
    setNudge(null);
    if (settled) live.current.commit(withStewardCardPosition(live.current.displayModel, settled.id, settled.at));
  }, [live]);

  useEffect(
    () => () => {
      if (timer.current === null) return;
      window.clearTimeout(timer.current);
      flush();
    },
    [flush],
  );

  const nudgeCard = useCallback(
    (id: string, delta: Pt, step: number) => {
      const { layout } = live.current;
      const box = layout.cardBoxes.find((item) => item.id === id);
      if (!box) return;
      const from = pending.current?.id === id ? pending.current.at : { x: box.x, y: box.y };
      pending.current = { id, at: clampToCanvas({ x: from.x + delta.x * step, y: from.y + delta.y * step }, box, layout) };
      setNudge(pending.current);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, NUDGE_COMMIT_MS);
    },
    [flush, live],
  );

  return { nudge, nudgeCard };
}

/** Whether a selection still points at a box or arrow in the model. */
export function selectionExists(model: StewardDiagramModel, selection: Selection): boolean {
  if (!selection) return true;
  if (selection.kind === "edge") return Boolean(model.edges[selection.index]);
  return model.rows.some((row) => row.some((card) => card.id === selection.id));
}

/** Selection that lets go on a press outside the figure and clears itself
 * when its box or arrow no longer exists. */
export function useCanvasSelection(
  container: MutableRefObject<HTMLDivElement | null>,
  model: StewardDiagramModel,
) {
  const [selection, setSelection] = useState<Selection>(null);

  useEffect(() => {
    if (!selection) return;
    // The dispatch path, not the target: a pressed handle can unmount (the
    // drag hides it) before this listener runs, detaching the target.
    const release = (event: PointerEvent) => {
      if (!container.current || !event.composedPath().includes(container.current)) setSelection(null);
    };
    document.addEventListener("pointerdown", release);
    return () => document.removeEventListener("pointerdown", release);
  }, [container, selection]);

  const stale = !selectionExists(model, selection);
  useEffect(() => {
    if (stale) setSelection(null);
  }, [stale]);

  return [stale ? null : selection, setSelection] as const;
}
