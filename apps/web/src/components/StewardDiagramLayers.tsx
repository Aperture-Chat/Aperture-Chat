/** SVG layers of the structure-diagram canvas: arrows, boxes, text, and the
 * editing overlays (outlines, guides, wires, handles, connector dots). Each
 * layer renders from the layout's display list; gestures come in as
 * callbacks so these stay presentational. */

import { Fragment, type PointerEvent as ReactPointerEvent } from "react";
import {
  stewardMarkerId,
  stewardRectPath,
  stewardShadowId,
  stewardTextBlockHeight,
  type StewardDiagramCardBox,
  type StewardDiagramLayout,
  type StewardDiagramPathEl,
  type StewardDiagramTextEl,
  type StewardTextField,
} from "../lib/stewardDiagram";
import { pt, type Drag, type Pt } from "./stewardCanvasGestures";

export type CardHandlers = (cardId: string | undefined) => {
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onPointerDown?: (event: ReactPointerEvent) => void;
};

export function fieldKey(ref: StewardTextField): string {
  if (ref.scope === "chart") return `chart:${ref.field}`;
  if (ref.scope === "edge") return `edge:${ref.index}`;
  if (ref.scope === "bullet") return `bullet:${ref.cardId}:${ref.index}`;
  return `card:${ref.cardId}:${ref.field}`;
}

export function EdgePaths({ layout, dark }: { layout: StewardDiagramLayout; dark: boolean }) {
  return (
    <>
      {layout.paths.map((el, index) => (
        <path
          key={index}
          d={el.d}
          stroke={el.color}
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray={el.dash}
          markerEnd={`url(#${stewardMarkerId(el.markerKind, dark, layout.theme)})`}
        />
      ))}
    </>
  );
}

/** Wide invisible strokes that make thin arrows easy to pick up. */
export function EdgeHitPaths({
  layout,
  scale,
  editable,
  onSelect,
}: {
  layout: StewardDiagramLayout;
  scale: number;
  editable: boolean;
  onSelect: (index: number) => void;
}) {
  if (!editable) return null;
  const edges = layout.paths.filter((el) => el.edgeIndex !== undefined);
  return (
    <>
      {edges.map((el) => (
        <path
          key={`hit-${el.edgeIndex}`}
          className="sdc-edge-hit"
          d={el.d}
          strokeWidth={14 / scale}
          fill="none"
          data-edge-index={el.edgeIndex}
          onClick={() => onSelect(el.edgeIndex!)}
        />
      ))}
    </>
  );
}

export function CardShapes({
  layout,
  dark,
  editable,
  handlersFor,
}: {
  layout: StewardDiagramLayout;
  dark: boolean;
  editable: boolean;
  handlersFor: CardHandlers;
}) {
  return (
    <>
      {layout.rects.map((el, index) => {
        const shared = {
          fill: el.fill,
          stroke: el.stroke,
          filter: el.shadow ? `url(#${stewardShadowId(dark)})` : undefined,
          className: el.cardId && editable ? "sdc-card-shape" : undefined,
          ...handlersFor(el.cardId),
        };
        if (el.rx && el.corners && el.corners !== "all") {
          return <path key={index} d={stewardRectPath(el)} {...shared} />;
        }
        return <rect key={index} x={el.x} y={el.y} width={el.width} height={el.height} rx={el.rx} {...shared} />;
      })}
    </>
  );
}

function DiagramText({
  el,
  hidden,
  onClick,
  handlers,
}: {
  el: StewardDiagramTextEl;
  hidden: boolean;
  onClick?: () => void;
  handlers: ReturnType<CardHandlers>;
}) {
  const text = (
    <text
      fill={el.color}
      fontSize={el.block.size}
      fontWeight={el.block.bold ? 600 : undefined}
      fontStyle={el.italic ? "italic" : undefined}
      letterSpacing={el.letterSpacing}
      textAnchor={el.anchor}
      visibility={hidden ? "hidden" : undefined}
      className={onClick ? "sdc-text" : undefined}
      onClick={onClick}
      {...handlers}
    >
      {el.block.lines.map((line, lineIndex) => (
        <tspan
          key={lineIndex}
          x={el.x}
          y={lineIndex === 0 ? el.y + el.block.size : undefined}
          dy={lineIndex === 0 ? undefined : el.block.lineHeight}
        >
          {line}
        </tspan>
      ))}
    </text>
  );
  if (!el.halo) return text;
  return (
    <g style={{ paintOrder: "stroke" }} stroke={el.halo} strokeWidth={4} strokeLinejoin="round">
      {text}
    </g>
  );
}

export function DiagramTexts({
  layout,
  editable,
  editingKey,
  handlersFor,
  onClickText,
}: {
  layout: StewardDiagramLayout;
  editable: boolean;
  editingKey: string | null | false;
  handlersFor: CardHandlers;
  onClickText: (ref: StewardTextField) => void;
}) {
  return (
    <>
      {layout.texts.map((el, index) => {
        const ref = editable ? el.fieldRef : undefined;
        return (
          <Fragment key={index}>
            <DiagramText
              el={el}
              hidden={Boolean(ref && editingKey === fieldKey(ref))}
              onClick={ref ? () => onClickText(ref) : undefined}
              handlers={handlersFor(el.cardId)}
            />
          </Fragment>
        );
      })}
    </>
  );
}

function BoxOutline({ box, className, radius, inset, strokeWidth }: { box: StewardDiagramCardBox; className: string; radius: number; inset: number; strokeWidth?: number }) {
  return (
    <rect
      className={className}
      x={box.x - inset}
      y={box.y - inset}
      width={box.width + inset * 2}
      height={box.height + inset * 2}
      rx={radius}
      fill="none"
      strokeWidth={strokeWidth}
      pointerEvents="none"
    />
  );
}

function GuideLines({ drag, scale }: { drag: Drag | null; scale: number }) {
  if (drag?.kind !== "card") return null;
  return (
    <>
      {drag.guides.map((guide, index) =>
        guide.axis === "x" ? (
          <line key={index} className="sdc-guide" x1={guide.at} x2={guide.at} y1={guide.from - 8} y2={guide.to + 8} strokeWidth={1 / scale} />
        ) : (
          <line key={index} className="sdc-guide" y1={guide.at} y2={guide.at} x1={guide.from - 8} x2={guide.to + 8} strokeWidth={1 / scale} />
        ),
      )}
    </>
  );
}

/** The arrow being drawn or reconnected: a wire to the pointer. */
function Wire({ drag, scale }: { drag: Drag | null; scale: number }) {
  if (drag?.kind !== "endpoint" && drag?.kind !== "connect") return null;
  return <line className="sdc-wire" x1={drag.anchor.x} y1={drag.anchor.y} x2={drag.point.x} y2={drag.point.y} strokeWidth={1.6 / scale} />;
}

/** Hover and selection outlines, alignment guides while dragging a box,
 * and the wire plus drop target while drawing or reconnecting an arrow. */
export function CanvasOverlays({
  hoveredBox,
  selectedBox,
  drag,
  dropTarget,
  square,
  scale,
}: {
  hoveredBox: StewardDiagramCardBox | null;
  selectedBox: StewardDiagramCardBox | null;
  drag: Drag | null;
  dropTarget: StewardDiagramCardBox | null;
  /** Square charts get tighter outline corners. */
  square: boolean;
  scale: number;
}) {
  const radius = square ? 5 : 12;
  const hoverOnly = hoveredBox && hoveredBox !== selectedBox && !drag ? hoveredBox : null;
  return (
    <>
      {hoverOnly && <BoxOutline box={hoverOnly} className="sdc-hover-outline" radius={radius} inset={3} />}
      {selectedBox && <BoxOutline box={selectedBox} className="sdc-select-outline" radius={radius} inset={3} strokeWidth={1.6 / scale} />}
      <GuideLines drag={drag} scale={scale} />
      {dropTarget && <BoxOutline box={dropTarget} className="sdc-drop-outline" radius={radius + 1} inset={4} strokeWidth={2 / scale} />}
      <Wire drag={drag} scale={scale} />
    </>
  );
}

function connectorPoints(box: StewardDiagramCardBox): Pt[] {
  return [
    { x: box.x + box.width / 2, y: box.y },
    { x: box.x + box.width, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2, y: box.y + box.height },
    { x: box.x, y: box.y + box.height / 2 },
  ];
}

/** Dots on a box's four edges; drag one onto another box to draw an arrow. */
export function ConnectorDots({
  box,
  scale,
  onHover,
  onPress,
}: {
  box: StewardDiagramCardBox | null;
  scale: number;
  onHover: (cardId: string | null) => void;
  onPress: (event: ReactPointerEvent, cardId: string, anchor: Pt) => void;
}) {
  if (!box) return null;
  return (
    <>
      {connectorPoints(box).map((point, index) => (
        <g
          key={index}
          className="sdc-connector"
          onMouseEnter={() => onHover(box.id)}
          onMouseLeave={() => onHover(null)}
          onPointerDown={(event) => onPress(event, box.id, point)}
        >
          <circle cx={point.x} cy={point.y} r={12 / scale} fill="transparent" />
          <circle className="sdc-connector-dot" cx={point.x} cy={point.y} r={5 / scale} strokeWidth={1.5 / scale} />
        </g>
      ))}
    </>
  );
}

/** Grab points on the selected arrow: its middle run (bend) and both ends
 * (drop on another box to reconnect). */
export function EdgeHandles({
  path,
  scale,
  onBend,
  onEndpoint,
}: {
  path: StewardDiagramPathEl | null;
  scale: number;
  onBend: (event: ReactPointerEvent, path: StewardDiagramPathEl) => void;
  onEndpoint: (event: ReactPointerEvent, path: StewardDiagramPathEl, end: "from" | "to") => void;
}) {
  if (!path) return null;
  const ends = path.ends ? (["from", "to"] as const) : [];
  return (
    <g className="sdc-edge-handles">
      {ends.map((end) => {
        const [x, y] = path.ends![end];
        return (
          <g
            key={end}
            className="sdc-endpoint"
            role="button"
            aria-label={end === "from" ? "Drag to move the arrow's start" : "Drag to move the arrow's end"}
            onPointerDown={(event) => onEndpoint(event, path, end)}
          >
            <circle cx={x} cy={y} r={12 / scale} fill="transparent" />
            <circle className="sdc-handle-dot" cx={x} cy={y} r={5 / scale} strokeWidth={1.5 / scale} />
          </g>
        );
      })}
      {path.handle && (
        <g
          className={`sdc-bend-handle is-${path.handle.axis}`}
          role="button"
          aria-label="Drag to bend the arrow"
          onPointerDown={(event) => onBend(event, path)}
        >
          <circle cx={path.handle.x} cy={path.handle.y} r={13 / scale} fill="transparent" />
          <circle className="sdc-handle-dot is-bend" cx={path.handle.x} cy={path.handle.y} r={6 / scale} strokeWidth={1.6 / scale} />
        </g>
      )}
    </g>
  );
}

/** Where a selected arrow's chip floats: just above its middle. */
export function edgeChipPlacement(path: StewardDiagramPathEl, origin: Pt, scale: number) {
  const anchor = path.handle ?? (path.ends ? midpoint(path.ends.from, path.ends.to) : { x: 0, y: 0 });
  return { left: origin.x + anchor.x * scale, top: origin.y + anchor.y * scale - 12 };
}

function midpoint(a: [number, number], b: [number, number]): Pt {
  return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
}

type EditorPlacement = {
  el: StewardDiagramTextEl | null;
  box: StewardDiagramCardBox | null;
  path: StewardDiagramPathEl | null;
  layoutWidth: number;
  origin: Pt;
  scale: number;
};

/** A new label on an unlabeled arrow opens at the arrow's middle. */
function newLabelGeometry(path: StewardDiagramPathEl | null, origin: Pt, scale: number) {
  const anchor = path?.handle ?? (path?.ends ? pt(path.ends.from) : { x: 0, y: 0 });
  return {
    left: origin.x + (anchor.x - 90) * scale,
    top: origin.y + (anchor.y - 26) * scale,
    width: 180 * scale,
    minHeight: 24 * scale,
    fontSize: Math.max(11, 11 * scale),
  };
}

/** Design-unit span of the editor: the box's inner width for card text, a
 * fixed span for arrow labels, the canvas measure for chart text. */
function editorSpan(el: StewardDiagramTextEl, box: StewardDiagramCardBox | null, layoutWidth: number) {
  if (box) return { left: box.x + 10, width: box.width - 20 };
  const width = el.edgeIndex !== undefined ? 200 : Math.min(layoutWidth - 2 * el.x, 620);
  return { left: el.anchor === "middle" ? el.x - width / 2 : el.x, width };
}

/** The inline text editor sits exactly over the text it replaces. */
export function textEditorGeometry({ el, box, path, layoutWidth, origin, scale }: EditorPlacement) {
  if (!el) return newLabelGeometry(path, origin, scale);
  const span = editorSpan(el, box, layoutWidth);
  return {
    left: origin.x + span.left * scale,
    top: origin.y + (el.y - 3) * scale,
    width: span.width * scale,
    minHeight: (stewardTextBlockHeight(el.block) + 8) * scale,
    fontSize: Math.max(11, el.block.size * scale),
  };
}
