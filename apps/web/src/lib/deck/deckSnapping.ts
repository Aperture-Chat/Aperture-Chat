import { DECK_PREVIEW_HEIGHT_PX, DECK_PREVIEW_WIDTH_PX, type DeckBox } from "./deckGeometry";

/**
 * Smart guides for moving a text box on the 960×540 slide canvas, the way
 * PowerPoint snaps a shape to the slide's center and edges and to the other
 * shapes on the slide. All values are slide pixels.
 */

export type SnapGuides = { x: number[]; y: number[] };

export const DECK_SNAP_THRESHOLD = 6;

function snapAxis(
  start: number,
  size: number,
  targets: number[],
  threshold: number,
): { offset: number; guide: number | null } {
  const edges = [start, start + size / 2, start + size];
  let best: { offset: number; guide: number | null; distance: number } = {
    offset: 0,
    guide: null,
    distance: threshold + 1,
  };
  for (const edge of edges) {
    for (const target of targets) {
      const distance = Math.abs(target - edge);
      if (distance <= threshold && distance < best.distance) {
        best = { offset: target - edge, guide: target, distance };
      }
    }
  }
  return { offset: best.offset, guide: best.guide };
}

/** Clamps a box inside the slide canvas. */
export function clampBoxToCanvas(box: DeckBox): DeckBox {
  return {
    ...box,
    x: Math.round(Math.max(0, Math.min(DECK_PREVIEW_WIDTH_PX - box.w, box.x))),
    y: Math.round(Math.max(0, Math.min(DECK_PREVIEW_HEIGHT_PX - box.h, box.y))),
  };
}

/** Moves `box` to its dragged position, snapping any of its left/center/right
 * and top/middle/bottom lines to the canvas or to another box. */
export function snapMovedBox(
  box: DeckBox,
  others: DeckBox[],
  threshold = DECK_SNAP_THRESHOLD,
): { box: DeckBox; guides: SnapGuides } {
  const xTargets = [0, DECK_PREVIEW_WIDTH_PX / 2, DECK_PREVIEW_WIDTH_PX];
  const yTargets = [0, DECK_PREVIEW_HEIGHT_PX / 2, DECK_PREVIEW_HEIGHT_PX];
  others.forEach((other) => {
    xTargets.push(other.x, other.x + other.w / 2, other.x + other.w);
    yTargets.push(other.y, other.y + other.h / 2, other.y + other.h);
  });
  const x = snapAxis(box.x, box.w, xTargets, threshold);
  const y = snapAxis(box.y, box.h, yTargets, threshold);
  const snapped = clampBoxToCanvas({ ...box, x: box.x + x.offset, y: box.y + y.offset });
  return {
    box: snapped,
    guides: {
      x: x.guide === null ? [] : [x.guide],
      y: y.guide === null ? [] : [y.guide],
    },
  };
}
