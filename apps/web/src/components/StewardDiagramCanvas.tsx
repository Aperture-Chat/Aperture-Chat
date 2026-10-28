import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { DIAGRAM_FONT_FAMILY } from "../lib/diagramTheme";
import {
  computeStewardDiagramLayout,
  stewardDiagramMarkerDefs,
  stewardFieldValue,
  withStewardFieldValue,
  type StewardDiagramCardBox,
  type StewardDiagramLayout,
  type StewardDiagramModel,
  type StewardDiagramPathEl,
  type StewardTextField,
} from "../lib/stewardDiagram";
import { stewardCardAt } from "../lib/stewardDiagramEdits";
import {
  bendDrag,
  canvasKeyAction,
  cardDrag,
  connectDrag,
  designPoint,
  endpointDrag,
  previewModel,
  useCanvasDrag,
  useCanvasSelection,
  useCardNudge,
  withoutSelection,
  type Drag,
  type GestureContext,
  type KeyAction,
  type Pt,
  type Selection,
} from "./stewardCanvasGestures";
import { StewardCardChip, StewardEdgeChip } from "./StewardDiagramChips";
import {
  CanvasOverlays,
  CardShapes,
  ConnectorDots,
  DiagramTexts,
  EdgeHandles,
  EdgeHitPaths,
  EdgePaths,
  edgeChipPlacement,
  fieldKey,
  textEditorGeometry,
  type CardHandlers,
} from "./StewardDiagramLayers";
import { useDiagramHistory } from "./useDiagramHistory";

/** The chip hangs off a box's right edge; keep it inside the canvas. */
const CHIP_MIN_RIGHT = 228;

/** Before measuring, a summary chart on a phone assumes the window width. */
function initialSummaryWidth(summary: boolean): number | null {
  if (!summary || typeof window === "undefined" || window.innerWidth >= 700) return null;
  return Math.max(320, window.innerWidth - 72);
}

/** Summary charts reflow to one card per row on narrow screens. */
function useSummaryReflow(model: StewardDiagramModel) {
  const summary = model.tag === "Visual summary";
  const [availableWidth, setAvailableWidth] = useState<number | null>(() => initialSummaryWidth(summary));
  const narrow = summary && availableWidth !== null && availableWidth < 700;
  const displayModel = useMemo<StewardDiagramModel>(
    () => (narrow ? { ...model, rows: model.rows.flat().map((card) => [card]) } : model),
    [model, narrow],
  );
  const canvasWidth = summary && availableWidth ? availableWidth : undefined;
  return { displayModel, canvasWidth, onWidth: summary ? setAvailableWidth : undefined };
}

type MeasuredNode = Pick<HTMLElement, "getBoundingClientRect" | "clientWidth" | "clientLeft" | "clientTop" | "scrollLeft" | "scrollTop">;

/** Screen px per design unit, where the SVG sits inside the scrolling
 * container (absolute children are placed from its padding edge), and the
 * width available for a reflowing summary chart. */
export function measureCanvas(node: MeasuredNode, svg: Pick<Element, "getBoundingClientRect"> | null, layoutWidth: number) {
  const box = node.getBoundingClientRect();
  const rect = svg?.getBoundingClientRect() ?? box;
  return {
    scale: (rect.width || node.clientWidth) / layoutWidth,
    origin: {
      x: rect.left - box.left - node.clientLeft + node.scrollLeft,
      y: rect.top - box.top - node.clientTop + node.scrollTop,
    },
    width: Math.max(320, node.clientWidth),
  };
}

/** Rendered scale (screen px per design unit) and where the SVG sits inside
 * the scrolling container, for positioning HTML chips over it. */
function useCanvasMetrics(
  container: MutableRefObject<HTMLDivElement | null>,
  svg: MutableRefObject<SVGSVGElement | null>,
  layoutWidth: number,
  onWidth?: (width: number) => void,
) {
  const [scale, setScale] = useState(1);
  const [origin, setOrigin] = useState<Pt>({ x: 0, y: 0 });
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const sync = () => {
      const measured = measureCanvas(node, svg.current, layoutWidth);
      setScale(measured.scale);
      setOrigin(measured.origin);
      onWidth?.(measured.width);
    };
    sync();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, [container, layoutWidth, onWidth, svg]);
  return { scale, origin };
}

/** Hovered box, with a short grace period so the pointer can travel from a
 * box to its floating controls without the chip vanishing underneath it. */
function useHoverCard() {
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const hoverCard = useCallback((cardId: string | null) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (cardId !== null) setHoveredCardId(cardId);
    else timer.current = window.setTimeout(() => setHoveredCardId(null), 220);
  }, []);
  return { hoveredCardId, hoverCard };
}

/** PowerPoint-style text editing: click a text run, rewrite it in place,
 * Enter or blur saves, Escape cancels. */
function useInlineTextEditing(model: StewardDiagramModel, commit: (next: StewardDiagramModel) => void) {
  const [editing, setEditing] = useState<StewardTextField | null>(null);
  const [draft, setDraft] = useState("");
  const start = useCallback(
    (ref: StewardTextField) => {
      setDraft(stewardFieldValue(model, ref));
      setEditing(ref);
    },
    [model],
  );
  const save = useCallback(() => {
    if (editing && draft.trim() !== stewardFieldValue(model, editing).trim()) {
      commit(withStewardFieldValue(model, editing, draft));
    }
    setEditing(null);
  }, [commit, draft, editing, model]);
  const cancel = useCallback(() => setEditing(null), []);
  return { editing, draft, setDraft, start, save, cancel };
}

type CanvasView = {
  activeBox: StewardDiagramCardBox | null;
  hoveredBox: StewardDiagramCardBox | null;
  selectedBox: StewardDiagramCardBox | null;
  selectedPath: StewardDiagramPathEl | null;
  dropTarget: StewardDiagramCardBox | null;
};

function boxById(layout: StewardDiagramLayout, id: string | null | undefined) {
  return layout.cardBoxes.find((box) => box.id === id) ?? null;
}

/** Which box shows controls, which outlines draw, which arrow is picked. */
function canvasView(
  layout: StewardDiagramLayout,
  selection: Selection,
  hoveredCardId: string | null,
  drag: Drag | null,
  busy: boolean,
): CanvasView {
  const selectedId = selection?.kind === "card" ? selection.id : null;
  return {
    activeBox: busy ? null : boxById(layout, selectedId ?? hoveredCardId),
    hoveredBox: boxById(layout, hoveredCardId),
    selectedBox: boxById(layout, selectedId),
    selectedPath: selectedPathOf(layout, selection),
    dropTarget: dropTargetOf(layout, drag),
  };
}

function selectedPathOf(layout: StewardDiagramLayout, selection: Selection) {
  if (selection?.kind !== "edge") return null;
  return layout.paths.find((path) => path.edgeIndex === selection.index) ?? null;
}

/** The box under the pointer while drawing or reconnecting an arrow. */
function dropTargetOf(layout: StewardDiagramLayout, drag: Drag | null) {
  if (drag?.kind !== "endpoint" && drag?.kind !== "connect") return null;
  return boxById(layout, stewardCardAt(layout.cardBoxes, drag.point, drag.skipId));
}

type KeyHandlers = Record<KeyAction["type"], (action: KeyAction) => void>;

type HistoryControls = ReturnType<typeof useDiagramHistory<StewardDiagramModel>>;

/** Keyboard on the focused canvas: undo/redo, Escape, Delete, arrow nudges.
 * Keys typed in the label editor or the chips belong to them. */
function useCanvasKeys({
  editable,
  selection,
  setSelection,
  model,
  history,
  nudgeCard,
}: {
  editable: boolean;
  selection: Selection;
  setSelection: (next: Selection) => void;
  model: StewardDiagramModel;
  history: HistoryControls;
  nudgeCard: (id: string, delta: Pt, step: number) => void;
}) {
  const handlers: KeyHandlers = {
    undo: () => history.undo(),
    redo: () => history.redo(),
    deselect: () => setSelection(null),
    delete: () => {
      if (selection) history.commit(withoutSelection(model, selection));
      setSelection(null);
    },
    nudge: (action) => {
      if (action.type === "nudge" && selection?.kind === "card") nudgeCard(selection.id, action.delta, action.step);
    },
  };
  return (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = editable && event.target === event.currentTarget ? canvasKeyAction(event, selection) : null;
    if (!action) return;
    event.preventDefault();
    handlers[action.type](action);
  };
}

/** Pointer wiring: what pressing a box, an arrow handle, a connector dot,
 * a text run, or the empty canvas does. */
function useCanvasPointer({
  svgRef,
  scale,
  layout,
  editable,
  model,
  text,
  begin,
  swallowClick,
  hoverCard,
  select,
  setSelection,
}: {
  svgRef: MutableRefObject<SVGSVGElement | null>;
  scale: number;
  layout: StewardDiagramLayout;
  editable: boolean;
  model: StewardDiagramModel;
  text: ReturnType<typeof useInlineTextEditing>;
  begin: (drag: Drag | null) => void;
  swallowClick: () => boolean;
  hoverCard: (cardId: string | null) => void;
  select: (next: Selection) => void;
  setSelection: (next: Selection) => void;
}) {
  const point = (event: { clientX: number; clientY: number }) => designPoint(svgRef.current, scale, event);
  const pressCard = (event: ReactPointerEvent, cardId: string) => {
    const box = boxById(layout, cardId);
    if (event.button === 0 && box && !text.editing) begin(cardDrag(event.pointerId, box, point(event)));
  };
  const handlersFor: CardHandlers = (cardId) =>
    cardId && editable
      ? {
          onMouseEnter: () => hoverCard(cardId),
          onMouseLeave: () => hoverCard(null),
          onPointerDown: (event) => pressCard(event, cardId),
        }
      : {};
  return {
    handlersFor,
    selectEdge: (index: number) => select({ kind: "edge", index }),
    clickText: (ref: StewardTextField) => {
      if (!swallowClick()) text.start(ref);
    },
    pressBend: (event: ReactPointerEvent, path: StewardDiagramPathEl) => begin(bendDrag(event.pointerId, path, model)),
    pressEndpoint: (event: ReactPointerEvent, path: StewardDiagramPathEl, end: "from" | "to") =>
      begin(endpointDrag(event.pointerId, path, end, model, point(event))),
    pressConnector: (event: ReactPointerEvent, cardId: string, anchor: Pt) =>
      begin(connectDrag(event.pointerId, cardId, anchor, point(event))),
    onBackground: (event: ReactPointerEvent<SVGSVGElement>) => {
      if (event.target === event.currentTarget) setSelection(null);
    },
  };
}

/** Focus and naming for an editable canvas; a read-only one is a plain figure. */
function editorAttributes(editable: boolean) {
  if (!editable) return {};
  return {
    tabIndex: 0,
    role: "group",
    "aria-label": "Diagram editor",
    "aria-keyshortcuts": "ArrowLeft ArrowRight ArrowUp ArrowDown Delete Escape Meta+Z",
  };
}

function canvasClassName(editable: boolean, drag: Drag | null) {
  const dragging = drag?.kind === "card" && drag.moved;
  return `md-diagram-canvas sdc-canvas${editable ? " is-editable" : ""}${dragging ? " is-dragging" : ""}`;
}

function InlineTextEditor({
  text,
  layout,
  path,
  origin,
  scale,
}: {
  text: ReturnType<typeof useInlineTextEditing>;
  layout: StewardDiagramLayout;
  path: StewardDiagramPathEl | null;
  origin: Pt;
  scale: number;
}) {
  const editing = text.editing;
  if (!editing) return null;
  const key = fieldKey(editing);
  const geometry = textEditorGeometry({
    el: layout.texts.find((el) => el.fieldRef && fieldKey(el.fieldRef) === key) ?? null,
    box: editing.scope === "card" || editing.scope === "bullet" ? boxById(layout, editing.cardId) : null,
    path,
    layoutWidth: layout.width,
    origin,
    scale,
  });
  return (
    <textarea
      className="sdc-edit-input"
      style={geometry}
      aria-label="Edit diagram text"
      autoFocus
      value={text.draft}
      onChange={(event) => text.setDraft(event.target.value)}
      onBlur={text.save}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          text.save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          text.cancel();
        }
      }}
    />
  );
}

/** The live diagram surface: the same display list the static SVG uses,
 * rendered as JSX so the reader can work the chart like a slide — click any
 * text to rewrite it in place, drag boxes anywhere, select an arrow to bend,
 * reconnect, restyle, or relabel it, and draw new arrows from a box's
 * connector dots. Every committed change persists immediately through
 * onCommit; without onCommit the canvas is a plain non-interactive rendering. */
export function StewardDiagramCanvas({
  dark,
  model,
  onCommit,
}: {
  dark: boolean;
  model: StewardDiagramModel;
  onCommit?: (next: StewardDiagramModel) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const editable = Boolean(onCommit);
  const { displayModel, canvasWidth, onWidth } = useSummaryReflow(model);
  const live = useRef({} as GestureContext);
  const [selection, setSelection] = useCanvasSelection(containerRef, displayModel);
  const history = useDiagramHistory(displayModel, onCommit);
  const { drag, begin, swallowClick } = useCanvasDrag(live);
  const { nudge, nudgeCard } = useCardNudge(live);
  const shownModel = useMemo(() => previewModel(displayModel, drag, nudge), [displayModel, drag, nudge]);
  const layout = useMemo(() => computeStewardDiagramLayout(shownModel, dark, canvasWidth), [canvasWidth, dark, shownModel]);
  const { scale, origin } = useCanvasMetrics(containerRef, svgRef, layout.width, onWidth);
  const s = scale > 0 ? scale : 1;
  const { hoveredCardId, hoverCard } = useHoverCard();
  const text = useInlineTextEditing(displayModel, history.commit);
  const busy = Boolean(drag || text.editing);
  const view = canvasView(layout, selection, hoveredCardId, drag, busy);
  const select = (next: Selection) => {
    setSelection(next);
    if (next) containerRef.current?.focus({ preventScroll: true });
  };
  live.current = { layout, scale, displayModel, commit: history.commit, select, svg: svgRef.current };
  const pointer = useCanvasPointer({ svgRef, scale, layout, editable, model: displayModel, text, begin, swallowClick, hoverCard, select, setSelection });
  const onKeyDown = useCanvasKeys({ editable, selection, setSelection, model: displayModel, history, nudgeCard });

  return (
    <div className={canvasClassName(editable, drag)} ref={containerRef} {...editorAttributes(editable)} onKeyDown={onKeyDown}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        fontFamily={DIAGRAM_FONT_FAMILY}
        role="img"
        aria-label={model.title ?? "Structure diagram"}
        // A narrow chart (one card per row) never balloons past ~1.15× its
        // design size in a wide chat column.
        style={{ maxWidth: Math.round(layout.width * 1.15) }}
        onPointerDown={pointer.onBackground}
      >
        <defs dangerouslySetInnerHTML={{ __html: stewardDiagramMarkerDefs(dark, layout.theme) }} />
        <SelectionGlow path={view.selectedPath} scale={s} />
        <EdgePaths layout={layout} dark={dark} />
        <EdgeHitPaths layout={layout} scale={s} editable={editable} onSelect={pointer.selectEdge} />
        <CardShapes layout={layout} dark={dark} editable={editable} handlersFor={pointer.handlersFor} />
        <DiagramTexts
          layout={layout}
          editable={editable}
          editingKey={text.editing && fieldKey(text.editing)}
          handlersFor={pointer.handlersFor}
          onClickText={pointer.clickText}
        />
        <CanvasOverlays
          hoveredBox={view.hoveredBox}
          selectedBox={view.selectedBox}
          drag={drag}
          dropTarget={view.dropTarget}
          square={shownModel.corners === "square"}
          scale={s}
        />
        <EdgeHandles path={drag ? null : view.selectedPath} scale={s} onBend={pointer.pressBend} onEndpoint={pointer.pressEndpoint} />
        <ConnectorDots box={view.activeBox} scale={s} onHover={hoverCard} onPress={pointer.pressConnector} />
      </svg>
      <CanvasChips
        model={displayModel}
        layout={layout}
        view={view}
        selection={selection}
        dark={dark}
        origin={origin}
        scale={s}
        hidden={busy}
        onCommit={onCommit && history.commit}
        onHover={hoverCard}
        onEditLabel={(index) => text.start({ scope: "edge", index, field: "label" })}
      />
      <InlineTextEditor text={text} layout={layout} path={view.selectedPath} origin={origin} scale={s} />
    </div>
  );
}

function SelectionGlow({ path, scale }: { path: StewardDiagramPathEl | null; scale: number }) {
  if (!path) return null;
  return <path className="sdc-edge-glow" d={path.d} strokeWidth={7 / scale} fill="none" pointerEvents="none" />;
}

/** The floating controls: one for the active box, one for the selected arrow. */
function CanvasChips({
  model,
  layout,
  view,
  selection,
  dark,
  origin,
  scale,
  hidden,
  onCommit,
  onHover,
  onEditLabel,
}: {
  model: StewardDiagramModel;
  layout: StewardDiagramLayout;
  view: CanvasView;
  selection: Selection;
  dark: boolean;
  origin: Pt;
  scale: number;
  hidden: boolean;
  onCommit?: (next: StewardDiagramModel) => void;
  onHover: (cardId: string | null) => void;
  onEditLabel: (index: number) => void;
}) {
  if (!onCommit) return null;
  const box = view.activeBox;
  const edgeIndex = selection?.kind === "edge" && view.selectedPath && !hidden ? selection.index : null;
  return (
    <>
      {box && (
        <StewardCardChip
          key={box.id}
          model={model}
          box={box}
          dark={dark}
          rowLength={layout.cardBoxes.filter((item) => item.rowIndex === box.rowIndex).length}
          rowCount={Math.max(0, ...layout.cardBoxes.map((item) => item.rowIndex + 1))}
          style={{ left: origin.x + Math.max((box.x + box.width) * scale - 4, CHIP_MIN_RIGHT), top: origin.y + box.y * scale - 14 }}
          onCommit={onCommit}
          onHover={(hovering) => onHover(hovering ? box.id : null)}
        />
      )}
      {edgeIndex !== null && (
        <StewardEdgeChip
          model={model}
          index={edgeIndex}
          style={edgeChipPlacement(view.selectedPath!, origin, scale)}
          onCommit={onCommit}
          onEditLabel={() => onEditLabel(edgeIndex)}
        />
      )}
    </>
  );
}
