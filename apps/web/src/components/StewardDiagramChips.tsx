import {
  ArrowLeftRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  LayoutGrid,
  PaintBucket,
  PanelTop,
  RectangleHorizontal,
  Spline,
  Trash2,
  Type,
} from "lucide-react";
import { useState, type CSSProperties } from "react";
import { STEWARD_CARD_COLORS, stewardHeaderColors, type StewardCardColor } from "../lib/diagramThemes";
import {
  moveStewardCard,
  removeStewardCard,
  type StewardDiagramCardBox,
  type StewardDiagramEdgeKind,
  type StewardDiagramModel,
} from "../lib/stewardDiagram";
import {
  removeStewardEdge,
  reverseStewardEdge,
  withStewardCardColor,
  withStewardCardPosition,
  withStewardCardVariant,
  withStewardEdgeBend,
  withStewardEdgeKind,
} from "../lib/stewardDiagramEdits";
import { RailSwitch } from "./RailSwitch";

type Direction = "left" | "right" | "up" | "down";

const MOVES: Array<{ direction: Direction; label: string; tooltip: string; Icon: typeof ChevronLeft }> = [
  { direction: "left", label: "Move box left", tooltip: "Move left in its row", Icon: ChevronLeft },
  { direction: "up", label: "Move box up", tooltip: "Move up a row", Icon: ChevronUp },
  { direction: "down", label: "Move box down", tooltip: "Move down a row", Icon: ChevronDown },
  { direction: "right", label: "Move box right", tooltip: "Move right in its row", Icon: ChevronRight },
];

function moveDisabled(direction: Direction, box: StewardDiagramCardBox, rowLength: number, rowCount: number) {
  if (direction === "left") return box.columnIndex === 0;
  if (direction === "right") return box.columnIndex === rowLength - 1;
  const edgeRow = direction === "up" ? box.rowIndex === 0 : box.rowIndex === rowCount - 1;
  return edgeRow && rowLength <= 1;
}

/** Switches a box between a card with a header band and a solid banner. */
function VariantKey({ banner, onToggle }: { banner: boolean; onToggle: (variant: "card" | "banner") => void }) {
  return (
    <button
      type="button"
      aria-label={banner ? "Show as a card" : "Show as a banner"}
      data-tooltip={banner ? "Show as a card with a header band" : "Show as a solid banner"}
      onClick={() => onToggle(banner ? "card" : "banner")}
    >
      {banner ? <PanelTop size={13} /> : <RectangleHorizontal size={13} />}
    </button>
  );
}

/** Floating controls for the hovered or selected box: row moves, header
 * color, card/banner shape, return-to-row for a dragged box, and delete.
 * Row moves put a dragged box back into the row flow. */
export function StewardCardChip({
  model,
  box,
  dark,
  rowLength,
  rowCount,
  style,
  onCommit,
  onHover,
}: {
  model: StewardDiagramModel;
  box: StewardDiagramCardBox;
  dark: boolean;
  rowLength: number;
  rowCount: number;
  style: CSSProperties;
  onCommit: (next: StewardDiagramModel) => void;
  onHover: (hovering: boolean) => void;
}) {
  const [swatchesOpen, setSwatchesOpen] = useState(false);
  const card = model.rows.flat().find((item) => item.id === box.id);
  if (!card) return null;

  function move(direction: Direction) {
    const next = moveStewardCard(withStewardCardPosition(model, box.id, null), box.id, direction);
    if (next) onCommit(next);
  }

  function recolor(color: StewardCardColor | null) {
    onCommit(withStewardCardColor(model, box.id, color));
  }

  return (
    <div className="sdc-chip sdc-card-chip" style={style} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
      <div className="sdc-chip-row">
        {MOVES.map(({ direction, label, tooltip, Icon }) => (
          <button
            key={direction}
            type="button"
            aria-label={label}
            data-tooltip={tooltip}
            disabled={moveDisabled(direction, box, rowLength, rowCount)}
            onClick={() => move(direction)}
          >
            <Icon size={13} />
          </button>
        ))}
        <span className="sdc-chip-divider" aria-hidden="true" />
        <button
          type="button"
          aria-label="Header color"
          aria-expanded={swatchesOpen}
          data-tooltip="Change this box's header color"
          className={swatchesOpen ? "is-on" : undefined}
          onClick={() => setSwatchesOpen((open) => !open)}
        >
          <PaintBucket size={13} />
        </button>
        <VariantKey banner={card.variant === "banner"} onToggle={(variant) => onCommit(withStewardCardVariant(model, box.id, variant))} />
        {box.positioned && (
          <button
            type="button"
            aria-label="Return box to its row"
            data-tooltip="Put this box back in its row"
            onClick={() => onCommit(withStewardCardPosition(model, box.id, null))}
          >
            <LayoutGrid size={13} />
          </button>
        )}
        <button
          type="button"
          className="sdc-chip-delete"
          aria-label="Delete box"
          data-tooltip="Delete this box and its arrows"
          onClick={() => onCommit(removeStewardCard(model, box.id))}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {swatchesOpen && <HeaderSwatches model={model} dark={dark} current={card.color} onPick={recolor} />}
    </div>
  );
}

/** Header color swatches: the theme's own color first, then the palette. */
function HeaderSwatches({
  model,
  dark,
  current,
  onPick,
}: {
  model: StewardDiagramModel;
  dark: boolean;
  current?: StewardCardColor;
  onPick: (color: StewardCardColor | null) => void;
}) {
  const swatches: Array<{ id: StewardCardColor | null; label: string; tooltip: string }> = [
    { id: null, label: "Theme header color", tooltip: "Use the theme's color" },
    ...STEWARD_CARD_COLORS.map((color) => ({ id: color.id, label: `${color.name} header`, tooltip: color.name })),
  ];
  return (
    <div className="sdc-chip-swatches" role="group" aria-label="Header colors">
      {swatches.map((swatch) => (
        <button
          key={swatch.id ?? "theme"}
          type="button"
          className="sdc-swatch"
          aria-label={swatch.label}
          aria-pressed={(current ?? null) === swatch.id}
          data-tooltip={swatch.tooltip}
          style={{ "--swatch": stewardHeaderColors(model.theme, dark, swatch.id ?? undefined).fill } as CSSProperties}
          onClick={() => onPick(swatch.id)}
        />
      ))}
    </div>
  );
}

const EDGE_STYLES: Array<{ value: StewardDiagramEdgeKind; label: string; tooltip: string }> = [
  { value: "primary", label: "Solid", tooltip: "Solid arrow" },
  { value: "contingent", label: "Dashed", tooltip: "Dashed arrow (contingent)" },
  { value: "inactive", label: "Dotted", tooltip: "Dotted arrow (inactive)" },
];

/** Controls for the selected arrow: line style, direction, label, route
 * reset, and delete. Dragging its handles happens on the canvas. */
export function StewardEdgeChip({
  model,
  index,
  style,
  onCommit,
  onEditLabel,
}: {
  model: StewardDiagramModel;
  index: number;
  style: CSSProperties;
  onCommit: (next: StewardDiagramModel) => void;
  onEditLabel: () => void;
}) {
  const edge = model.edges[index];
  if (!edge) return null;
  return (
    <div className="sdc-chip sdc-edge-chip" style={style} role="group" aria-label="Arrow controls">
      <RailSwitch
        className="sdc-rail"
        ariaLabel="Arrow style"
        options={EDGE_STYLES}
        value={edge.kind ?? "primary"}
        onChange={(kind) => onCommit(withStewardEdgeKind(model, index, kind))}
      />
      <div className="sdc-chip-row">
        <button
          type="button"
          aria-label="Reverse arrow direction"
          data-tooltip="Point the arrow the other way"
          onClick={() => onCommit(reverseStewardEdge(model, index))}
        >
          <ArrowLeftRight size={13} />
        </button>
        <button type="button" aria-label="Edit arrow label" data-tooltip="Write or change the arrow's label" onClick={onEditLabel}>
          <Type size={13} />
        </button>
        {edge.bend !== undefined && (
          <button
            type="button"
            aria-label="Reset arrow route"
            data-tooltip="Send the arrow back along its natural route"
            onClick={() => onCommit(withStewardEdgeBend(model, index, null))}
          >
            <Spline size={13} />
          </button>
        )}
        <button
          type="button"
          className="sdc-chip-delete"
          aria-label="Delete arrow"
          data-tooltip="Delete this arrow"
          onClick={() => onCommit(removeStewardEdge(model, index))}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}
