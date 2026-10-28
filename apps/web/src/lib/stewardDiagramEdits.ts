/** Direct-manipulation edits for structure charts: where a card sits, its
 * header color and shape, how arrows run and what they connect, and the
 * chart-wide style. Each helper returns a new model and leaves its input
 * untouched; a helper that cannot apply returns null where noted. */

import type { StewardCardColor, StewardDiagramThemeId } from "./diagramThemes";
import {
  cloneStewardDiagram,
  type StewardDiagramCard,
  type StewardDiagramConnector,
  type StewardDiagramCorners,
  type StewardDiagramEdge,
  type StewardDiagramEdgeKind,
  type StewardDiagramModel,
} from "./stewardDiagram";

function editCard(
  model: StewardDiagramModel,
  cardId: string,
  edit: (card: StewardDiagramCard) => void,
): StewardDiagramModel {
  const next = cloneStewardDiagram(model);
  const card = next.rows.flat().find((item) => item.id === cardId);
  if (card) edit(card);
  return next;
}

function editEdge(
  model: StewardDiagramModel,
  index: number,
  edit: (edge: StewardDiagramEdge) => void,
): StewardDiagramModel {
  const next = cloneStewardDiagram(model);
  const edge = next.edges[index];
  if (edge) edit(edge);
  return next;
}

/** Places a card at a dropped position (design units), or returns it to its
 * row slot with null. */
export function withStewardCardPosition(
  model: StewardDiagramModel,
  cardId: string,
  position: { x: number; y: number } | null,
): StewardDiagramModel {
  return editCard(model, cardId, (card) => {
    card.position = position
      ? { x: Math.max(0, Math.round(position.x)), y: Math.max(0, Math.round(position.y)) }
      : undefined;
  });
}

export function withStewardCardColor(
  model: StewardDiagramModel,
  cardId: string,
  color: StewardCardColor | null,
): StewardDiagramModel {
  return editCard(model, cardId, (card) => {
    card.color = color ?? undefined;
  });
}

export function withStewardCardVariant(
  model: StewardDiagramModel,
  cardId: string,
  variant: "card" | "banner",
): StewardDiagramModel {
  return editCard(model, cardId, (card) => {
    card.variant = variant;
  });
}

export function withStewardEdgeKind(
  model: StewardDiagramModel,
  index: number,
  kind: StewardDiagramEdgeKind,
): StewardDiagramModel {
  return editEdge(model, index, (edge) => {
    edge.kind = kind;
  });
}

export function withStewardEdgeBend(model: StewardDiagramModel, index: number, bend: number | null): StewardDiagramModel {
  return editEdge(model, index, (edge) => {
    edge.bend = bend ? Math.round(bend) : undefined;
  });
}

/** Flips an arrow's direction. The old bend belonged to the old route, so
 * it is cleared. */
export function reverseStewardEdge(model: StewardDiagramModel, index: number): StewardDiagramModel {
  return editEdge(model, index, (edge) => {
    [edge.from, edge.to] = [edge.to, edge.from];
    edge.bend = undefined;
  });
}

export function removeStewardEdge(model: StewardDiagramModel, index: number): StewardDiagramModel {
  const next = cloneStewardDiagram(model);
  next.edges.splice(index, 1);
  return next;
}

function hasCard(model: StewardDiagramModel, cardId: string): boolean {
  return model.rows.some((row) => row.some((card) => card.id === cardId));
}

/** Moves one end of an arrow onto another card. Null when the card is
 * unknown, is the arrow's other end, or the arrow does not exist. */
export function reconnectStewardEdge(
  model: StewardDiagramModel,
  index: number,
  end: "from" | "to",
  cardId: string,
): StewardDiagramModel | null {
  const edge = model.edges[index];
  if (!edge || !hasCard(model, cardId)) return null;
  if ((end === "from" ? edge.to : edge.from) === cardId) return null;
  return editEdge(model, index, (draft) => {
    draft[end] = cardId;
    draft.bend = undefined;
  });
}

/** Adds a solid arrow between two cards; null for a self-loop, an unknown
 * card, or an arrow that already exists. */
export function addStewardEdge(model: StewardDiagramModel, from: string, to: string): StewardDiagramModel | null {
  if (from === to || !hasCard(model, from) || !hasCard(model, to)) return null;
  if (model.edges.some((edge) => edge.from === from && edge.to === to)) return null;
  const next = cloneStewardDiagram(model);
  next.edges.push({ from, to, kind: "primary" });
  return next;
}

export type StewardChartStyle = {
  theme?: StewardDiagramThemeId;
  connector?: StewardDiagramConnector;
  corners?: StewardDiagramCorners;
};

const STYLE_DEFAULTS: Required<StewardChartStyle> = { theme: "aperture", connector: "elbow", corners: "rounded" };

/** Applies chart-wide style. Picking a default removes the field, so a
 * chart restyled back to defaults serializes exactly as the model wrote it. */
export function withStewardChartStyle(model: StewardDiagramModel, patch: StewardChartStyle): StewardDiagramModel {
  const next = cloneStewardDiagram(model);
  for (const key of Object.keys(patch) as Array<keyof StewardChartStyle>) {
    const value = patch[key];
    if (value === undefined || value === STYLE_DEFAULTS[key]) delete next[key];
    else Object.assign(next, { [key]: value });
  }
  return next;
}

export function stewardHasManualLayout(model: StewardDiagramModel): boolean {
  return model.rows.some((row) => row.some((card) => card.position)) || model.edges.some((edge) => edge.bend);
}

/** Puts every card back in its row slot and every arrow on its natural route. */
export function resetStewardLayout(model: StewardDiagramModel): StewardDiagramModel {
  const next = cloneStewardDiagram(model);
  next.rows.forEach((row) => row.forEach((card) => delete card.position));
  next.edges.forEach((edge) => delete edge.bend);
  return next;
}

type Box = { id: string; x: number; y: number; width: number; height: number };

export type StewardGuide = { axis: "x" | "y"; at: number; from: number; to: number };

const GRID = 8;
const SNAP_DISTANCE = 6;

type AxisSnap = { value: number; line?: number; other?: Box };

/** Snaps one axis: the nearest neighbor edge or center line within reach,
 * else the grid. */
function snapAxis(start: number, length: number, others: Box[], axis: "x" | "y"): AxisSnap {
  const own = [0, length / 2, length];
  let best: AxisSnap & { distance: number } = { value: Math.round(start / GRID) * GRID, distance: Infinity };
  for (const other of others) {
    const origin = axis === "x" ? other.x : other.y;
    const size = axis === "x" ? other.width : other.height;
    for (const line of [origin, origin + size / 2, origin + size]) {
      for (const offset of own) {
        const distance = Math.abs(line - (start + offset));
        if (distance <= SNAP_DISTANCE && distance < best.distance) {
          best = { value: line - offset, line, other, distance };
        }
      }
    }
  }
  return best;
}

function guideFor(axis: "x" | "y", snap: AxisSnap, box: Box): StewardGuide[] {
  if (snap.line === undefined || !snap.other) return [];
  const [start, size, otherStart, otherSize] =
    axis === "x"
      ? [box.y, box.height, snap.other.y, snap.other.height]
      : [box.x, box.width, snap.other.x, snap.other.width];
  return [{ axis, at: snap.line, from: Math.min(start, otherStart), to: Math.max(start + size, otherStart + otherSize) }];
}

/** Where a dragged card lands: aligned to a neighbor's edge or center when
 * within a few units (with a guide line to show it), else on the grid. */
export function snapStewardCardPosition(
  candidate: { x: number; y: number },
  size: { width: number; height: number },
  others: Box[],
): { x: number; y: number; guides: StewardGuide[] } {
  const snapX = snapAxis(candidate.x, size.width, others, "x");
  const snapY = snapAxis(candidate.y, size.height, others, "y");
  const box = { id: "", x: snapX.value, y: snapY.value, width: size.width, height: size.height };
  return { x: box.x, y: box.y, guides: [...guideFor("x", snapX, box), ...guideFor("y", snapY, box)] };
}

/** The top-most card under a point (later boxes paint on top). */
export function stewardCardAt(boxes: Box[], point: { x: number; y: number }, excludeId?: string): string | null {
  for (let index = boxes.length - 1; index >= 0; index -= 1) {
    const box = boxes[index]!;
    if (box.id === excludeId) continue;
    if (point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height) {
      return box.id;
    }
  }
  return null;
}
