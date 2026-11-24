/**
 * Where a slide has room for something new: the space its blocks' words and
 * pictures cover, the largest empty area left over, and the box a newly
 * added block takes there. The editor's plus button and its right-click
 * menu both ask here, so a block lands in the same place either way.
 */
import {
  DECK_LINE_HEIGHT,
  DECK_PREVIEW_HEIGHT_PX,
  DECK_PREVIEW_WIDTH_PX,
  DECK_TEXT_INSET_Y,
  boxHolds,
  largestFreeBox,
  resolvedMediaBox,
  resolvedTextRegions,
  type DeckBox,
  type DeckTextRegionSpec,
} from "./deckGeometry";
import {
  deckAddedKind,
  deckPictureRegions,
  deckSlideRegionContent,
  deckThemeDesign,
  withDeckBlockAdded,
  type DeckAddedBlock,
  type DeckAddedKind,
  type DeckSlide,
  type DeckSlideBox,
  type DeckTheme,
} from "./deckModel";
import {
  approximateDeckMeasure,
  deckCanvasMeasure,
  deckRegionFitWith,
  deckRegionLayout,
  type DeckRegionContent,
  type DeckTextMeasure,
} from "./deckTextFit";

type Point = { x: number; y: number };

/** The slide area offered for new blocks: the canvas less a margin. */
export const DECK_FREE_BOUNDS: DeckBox = { x: 40, y: 32, w: 880, h: 476 };

/** Where a block goes on a slide with no empty area worth offering. */
const FULL_SLIDE_CORNER: DeckBox = { x: 560, y: 388, w: 360, h: 120 };

/** An empty area smaller than this is not offered. */
const MIN_FREE = { w: 120, h: 44 };

/** A new block's usual size; an empty area smaller than that shrinks it. */
const NEW_BLOCK_SIZE: Record<DeckAddedKind, { w: number; h: number }> = {
  text: { w: 480, h: 96 },
  list: { w: 480, h: 200 },
  picture: { w: 360, h: 240 },
};

/** The part of the canvas each block covers. A picture covers its whole
 * box, and so does a block the author added, who sized it on purpose. A
 * layout's text covers its box only as far as its words run (an empty box
 * counts as one line), so the unused foot of a tall column is free space. */
export function deckUsedBoxes(
  slide: DeckSlide,
  theme: DeckTheme,
  measure: DeckTextMeasure = deckCanvasMeasure() ?? approximateDeckMeasure,
): DeckBox[] {
  const design = deckThemeDesign(theme);
  const text = Object.entries(resolvedTextRegions(slide, design)).flatMap(([region, spec]) => {
    const content = deckSlideRegionContent(slide, region);
    if (content === null) return [];
    return [deckAddedKind(region) ? spec.box : usedTextBox(spec, content, theme, measure)];
  });
  const pictures = deckPictureRegions(slide).flatMap((region) => resolvedMediaBox(slide, design, region) ?? []);
  return [...text, ...pictures];
}

function usedTextBox(
  spec: DeckTextRegionSpec,
  content: DeckRegionContent,
  theme: DeckTheme,
  measure: DeckTextMeasure,
): DeckBox {
  const { fit } = deckRegionFitWith(spec, content, theme, measure);
  const words = deckRegionLayout(spec, content, theme, fit, measure).height;
  const oneLine = DECK_LINE_HEIGHT * spec.sizePt;
  const h = Math.min(spec.box.h, Math.ceil(Math.max(words, oneLine) + DECK_TEXT_INSET_Y * 2));
  const y = spec.anchor === "middle" ? spec.box.y + (spec.box.h - h) / 2 : spec.box.y;
  return { x: spec.box.x, y: Math.floor(y), w: spec.box.w, h };
}

/** Where a new block goes: the empty area it may use, and its top left
 * corner. */
export type DeckAddPlace = { free: DeckBox; corner: Point };

/** Where a new block goes when the author has not pointed anywhere: the
 * slide's largest empty area, starting at the left edge the slide's text
 * keeps. A slide with no room offers its bottom right corner. */
export function deckAddPlace(slide: DeckSlide, theme: DeckTheme, measure?: DeckTextMeasure): DeckAddPlace {
  const used = deckUsedBoxes(slide, theme, measure);
  const free = worthOffering(largestFreeBox(used, DECK_FREE_BOUNDS));
  if (!free) return { free: FULL_SLIDE_CORNER, corner: FULL_SLIDE_CORNER };
  const textEdge = used
    .map((box) => box.x)
    .filter((x) => x >= free.x && x < free.x + free.w / 2)
    .sort((a, b) => a - b)[0];
  return { free, corner: { x: textEdge ?? free.x, y: free.y + 12 } };
}

/** Where a new block goes when the author pointed at a spot (a right-click):
 * that spot, in the empty area around it. Null when the spot is on a block,
 * which keeps its own menu. */
export function deckAddPlaceAt(
  slide: DeckSlide,
  theme: DeckTheme,
  at: Point,
  measure?: DeckTextMeasure,
): DeckAddPlace | null {
  const used = deckUsedBoxes(slide, theme, measure);
  if (used.some((box) => boxHolds(box, at))) return null;
  return { free: worthOffering(largestFreeBox(used, DECK_FREE_BOUNDS, at)) ?? DECK_FREE_BOUNDS, corner: at };
}

function worthOffering(free: DeckBox | null): DeckBox | null {
  return free && free.w >= MIN_FREE.w && free.h >= MIN_FREE.h ? free : null;
}

/** The middle of a place's empty area, where the editor shows its plus. */
export function deckAddPoint(place: DeckAddPlace): Point {
  return { x: place.free.x + place.free.w / 2, y: place.free.y + place.free.h / 2 };
}

/** The room the add menu needs on screen, in pixels, with its offset. */
const ADD_MENU_ROOM = { w: 190, h: 200 };

/** Which way the add menu opens from a spot on the slide (in slide pixels)
 * at the stage's zoom: down and right by default, up or left when the slide
 * has less room than the menu needs on that side. The menu keeps its size
 * while the slide shrinks, so the answer depends on the zoom. */
export function deckAddMenuOpens(spot: Point, scale: number): { up: boolean; left: boolean } {
  return {
    up: (DECK_PREVIEW_HEIGHT_PX - spot.y) * scale < ADD_MENU_ROOM.h,
    left: (DECK_PREVIEW_WIDTH_PX - spot.x) * scale < ADD_MENU_ROOM.w,
  };
}

/** The box a new block takes at a place. Along each side it starts at the
 * place's corner at its kind's usual size; with less room than that it
 * shrinks to the room there is, down to half its usual size; with less than
 * half it slides back from the corner to stay whole inside the empty area. */
export function deckNewBlockBox(kind: DeckAddedKind, place: DeckAddPlace): DeckSlideBox {
  const { free, corner } = place;
  const across = fitSide(corner.x, free.x, free.w, NEW_BLOCK_SIZE[kind].w);
  const down = fitSide(corner.y, free.y, free.h, NEW_BLOCK_SIZE[kind].h);
  return { x: across.start, y: down.start, w: across.length, h: down.length };
}

/** One side of a new block: where it starts and how long it is, given the
 * empty stretch it may use and the length it would like. */
function fitSide(corner: number, freeStart: number, freeLength: number, usual: number): { start: number; length: number } {
  const start = Math.round(Math.min(Math.max(corner, freeStart), freeStart + freeLength));
  const room = freeStart + freeLength - start;
  if (room >= usual / 2) return { start, length: Math.round(Math.min(usual, room)) };
  const length = Math.round(Math.min(usual, freeLength));
  return { start: Math.round(freeStart + freeLength) - length, length };
}

/** The added blocks of a slide after a model revised it, as raw entries for
 * the deck validator. The model never sees or sets a box and never holds a
 * picture's file, so:
 *
 * - a reply that says nothing about added blocks keeps them all;
 * - a block the reply kept (same id) keeps its box and its picture;
 * - a block the reply wrote new gets a name and a box: the first one goes to
 *   `place` (where the author asked for it) when there is one, the rest to
 *   the empty space left. A new picture is dropped, having nothing to show.
 *
 * A slide the model wrote from scratch (`kept` undefined) has none. */
export function revisedAddedBlocks(
  revised: unknown,
  kept: DeckSlide | undefined,
  theme: DeckTheme,
  place?: DeckAddPlace | null,
  measure?: DeckTextMeasure,
): unknown[] | undefined {
  if (!kept) return undefined;
  if (!Array.isArray(revised)) return kept.added;
  const room: RevisionRoom = { working: kept, asked: place ?? null, theme, measure };
  return revised.flatMap((entry): unknown[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const mine = kept.added?.find((block) => block.id === record.id);
    return mine ? [keptBlockEntry(record, mine)] : newBlockEntry(record, room);
  });
}

/** Where new blocks may still go while a revision is read: the slide as
 * placed so far, and the spot the author asked for until it is taken. */
type RevisionRoom = { working: DeckSlide; asked: DeckAddPlace | null; theme: DeckTheme; measure?: DeckTextMeasure };

/** A block the model kept: its words, on the box and picture file it had. */
function keptBlockEntry(record: Record<string, unknown>, mine: DeckAddedBlock): unknown {
  return { ...record, box: mine.box, ...("image" in mine ? { image: keptPicture(record.image, mine.image) } : {}) };
}

/** A block the model wrote new, named and placed; nothing when it is not a
 * text box or list, or the slide is full. */
function newBlockEntry(record: Record<string, unknown>, room: RevisionRoom): unknown[] {
  const kind = newBlockKind(record);
  if (!kind) return [];
  const box = deckNewBlockBox(kind, room.asked ?? deckAddPlace(room.working, room.theme, room.measure));
  const result = withDeckBlockAdded(room.working, kind, box);
  if (!result) return [];
  room.working = result.slide;
  room.asked = null;
  return [{ ...record, id: result.region, box }];
}

/** What a block the model wrote new is: named by its id's first word, else
 * by what it holds. Pictures cannot be written new. */
function newBlockKind(record: Record<string, unknown>): Exclude<DeckAddedKind, "picture"> | null {
  const named = typeof record.id === "string" ? deckAddedKind(record.id) : null;
  if (named === "picture") return null;
  return named ?? (Array.isArray(record.bullets) ? "list" : record.text !== undefined ? "text" : null);
}

/** The picture a kept block shows: the model's description when it wrote
 * one, on the file the editor holds. */
function keptPicture(revised: unknown, mine: { src: string; alt: string }) {
  const alt = revised && typeof revised === "object" ? (revised as Record<string, unknown>).alt : undefined;
  return { src: mine.src, alt: typeof alt === "string" && alt.trim() ? alt : mine.alt };
}
