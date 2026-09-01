import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { MERMAID_FONT_FAMILY } from "../lib/mermaidRender";
import {
  computeStewardDiagramLayout,
  moveStewardCard,
  removeStewardCard,
  stewardDiagramMarkerDefs,
  stewardFieldValue,
  stewardTextBlockHeight,
  withStewardFieldValue,
  type StewardDiagramModel,
  type StewardDiagramTextEl,
  type StewardTextField,
} from "../lib/stewardDiagram";

function fieldKey(ref: StewardTextField): string {
  if (ref.scope === "chart") return `chart:${ref.field}`;
  if (ref.scope === "bullet") return `bullet:${ref.cardId}:${ref.index}`;
  return `card:${ref.cardId}:${ref.field}`;
}

/** The live diagram surface: the same display list the static SVG uses,
 * rendered as JSX so the reader can work the chart like a slide — click any
 * text to rewrite it in place, hover a box for move/delete controls. Every
 * committed change persists immediately through onCommit; without onCommit
 * the canvas is a plain non-interactive rendering. */
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
  const summary = model.tag === "Visual summary";
  const [availableWidth, setAvailableWidth] = useState<number | null>(() => {
    if (!summary || typeof window === "undefined" || window.innerWidth >= 700) return null;
    return Math.max(320, window.innerWidth - 72);
  });
  const displayModel = useMemo<StewardDiagramModel>(() => {
    if (!summary || availableWidth === null || availableWidth >= 700) return model;
    return { ...model, rows: model.rows.flat().map((card) => [card]) };
  }, [availableWidth, model, summary]);
  const layout = useMemo(
    () => computeStewardDiagramLayout(displayModel, dark, summary && availableWidth ? availableWidth : undefined),
    [availableWidth, dark, displayModel, summary],
  );
  const [scale, setScale] = useState(1);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const hoverClearTimer = useRef<number | null>(null);
  const [editing, setEditing] = useState<StewardTextField | null>(null);
  const [draft, setDraft] = useState("");
  const editable = Boolean(onCommit);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const syncSize = () => {
      setScale(node.clientWidth / layout.width);
      if (summary) setAvailableWidth(Math.max(320, node.clientWidth));
    };
    syncSize();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(syncSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [layout.width, summary]);

  function hoverCard(cardId: string | null) {
    if (hoverClearTimer.current !== null) window.clearTimeout(hoverClearTimer.current);
    if (cardId === null) {
      // A short grace period lets the pointer travel from the card to its
      // floating controls without the chip vanishing underneath it.
      hoverClearTimer.current = window.setTimeout(() => setHoveredCardId(null), 220);
    } else {
      setHoveredCardId(cardId);
    }
  }

  function startEditing(ref: StewardTextField) {
    if (!editable) return;
    setDraft(stewardFieldValue(model, ref));
    setEditing(ref);
  }

  function commitEditing() {
    if (!editing || !onCommit) {
      setEditing(null);
      return;
    }
    const current = stewardFieldValue(model, editing);
    if (draft.trim() !== current.trim()) onCommit(withStewardFieldValue(model, editing, draft));
    setEditing(null);
  }

  function move(cardId: string, direction: "left" | "right" | "up" | "down") {
    if (!onCommit) return;
    const next = moveStewardCard(displayModel, cardId, direction);
    if (next) onCommit(next);
  }

  const hoveredBox = layout.cardBoxes.find((box) => box.id === hoveredCardId) ?? null;
  const hoveredRowLength = hoveredBox ? layout.cardBoxes.filter((box) => box.rowIndex === hoveredBox.rowIndex).length : 0;
  const rowCount = hoveredBox ? Math.max(...layout.cardBoxes.map((box) => box.rowIndex)) + 1 : 0;
  const editingKey = editing ? fieldKey(editing) : null;
  const editingEl = editingKey
    ? layout.texts.find((el) => el.fieldRef && fieldKey(el.fieldRef) === editingKey) ?? null
    : null;
  const editingBox = editing && editing.scope !== "chart"
    ? layout.cardBoxes.find((box) => box.id === (editing as { cardId: string }).cardId) ?? null
    : null;

  function overlayGeometry(el: StewardDiagramTextEl) {
    const width = editingBox ? editingBox.width - 20 : Math.min(layout.width - 2 * el.x, 620);
    const left = editingBox ? editingBox.x + 10 : el.anchor === "middle" ? el.x - width / 2 : el.x;
    return {
      left: left * scale,
      top: (el.y - 3) * scale,
      width: width * scale,
      minHeight: (stewardTextBlockHeight(el.block) + 8) * scale,
      fontSize: Math.max(11, el.block.size * scale),
    };
  }

  return (
    <div className={`md-diagram-canvas sdc-canvas${editable ? " is-editable" : ""}`} ref={containerRef}>
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        fontFamily={MERMAID_FONT_FAMILY}
        role="img"
        aria-label={model.title ?? "Structure diagram"}
      >
        <defs dangerouslySetInnerHTML={{ __html: stewardDiagramMarkerDefs() }} />
        {layout.paths.map((el, index) => (
          <path
            key={index}
            d={el.d}
            stroke={el.color}
            strokeWidth={1.6}
            fill="none"
            strokeDasharray={el.dash}
            markerEnd={`url(#arrow-${el.markerKind})`}
          />
        ))}
        {layout.rects.map((el, index) => (
          <rect
            key={index}
            x={el.x}
            y={el.y}
            width={el.width}
            height={el.height}
            fill={el.fill}
            stroke={el.stroke}
            onMouseEnter={el.cardId && editable ? () => hoverCard(el.cardId!) : undefined}
            onMouseLeave={el.cardId && editable ? () => hoverCard(null) : undefined}
          />
        ))}
        {layout.texts.map((el, index) => {
          const isBeingEdited = editingKey !== null && el.fieldRef && fieldKey(el.fieldRef) === editingKey;
          const clickable = editable && el.fieldRef;
          const text = (
            <text
              fill={el.color}
              fontSize={el.block.size}
              fontWeight={el.block.bold ? 600 : undefined}
              fontStyle={el.italic ? "italic" : undefined}
              textAnchor={el.anchor}
              visibility={isBeingEdited ? "hidden" : undefined}
              className={clickable ? "sdc-text" : undefined}
              onClick={clickable ? () => startEditing(el.fieldRef!) : undefined}
              onMouseEnter={el.cardId && editable ? () => hoverCard(el.cardId!) : undefined}
              onMouseLeave={el.cardId && editable ? () => hoverCard(null) : undefined}
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
          if (!el.halo) return <Fragment key={index}>{text}</Fragment>;
          return (
            <g key={index} style={{ paintOrder: "stroke" }} stroke={el.halo} strokeWidth={3}>
              {text}
            </g>
          );
        })}
        {editable && hoveredBox && (
          <rect
            className="sdc-hover-outline"
            x={hoveredBox.x - 3}
            y={hoveredBox.y - 3}
            width={hoveredBox.width + 6}
            height={hoveredBox.height + 6}
            fill="none"
            pointerEvents="none"
          />
        )}
      </svg>
      {editable && hoveredBox && !editing && (
        <div
          className="sdc-chip"
          style={{ left: (hoveredBox.x + hoveredBox.width) * scale - 4, top: hoveredBox.y * scale - 14 }}
          onMouseEnter={() => hoverCard(hoveredBox.id)}
          onMouseLeave={() => hoverCard(null)}
        >
          <button
            type="button"
            aria-label="Move box left"
            data-tooltip="Move left"
            disabled={hoveredBox.columnIndex === 0}
            onClick={() => move(hoveredBox.id, "left")}
          >
            <ChevronLeft size={13} />
          </button>
          <button
            type="button"
            aria-label="Move box up"
            data-tooltip="Move up a row"
            disabled={hoveredBox.rowIndex === 0 && hoveredRowLength <= 1}
            onClick={() => move(hoveredBox.id, "up")}
          >
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            aria-label="Move box down"
            data-tooltip="Move down a row"
            disabled={hoveredBox.rowIndex === rowCount - 1 && hoveredRowLength <= 1}
            onClick={() => move(hoveredBox.id, "down")}
          >
            <ChevronDown size={13} />
          </button>
          <button
            type="button"
            aria-label="Move box right"
            data-tooltip="Move right"
            disabled={hoveredBox.columnIndex === hoveredRowLength - 1}
            onClick={() => move(hoveredBox.id, "right")}
          >
            <ChevronRight size={13} />
          </button>
          <button
            type="button"
            className="sdc-chip-delete"
            aria-label="Delete box"
            data-tooltip="Delete this box and its arrows"
            onClick={() => onCommit?.(removeStewardCard(displayModel, hoveredBox.id))}
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
      {editing && editingEl && (
        <textarea
          className="sdc-edit-input"
          style={overlayGeometry(editingEl)}
          aria-label="Edit diagram text"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitEditing}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              commitEditing();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(null);
            }
          }}
        />
      )}
    </div>
  );
}
