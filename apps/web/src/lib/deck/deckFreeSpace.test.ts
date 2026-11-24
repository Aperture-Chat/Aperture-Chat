import { expect, test } from "vitest";
import { DECK_FREE_BOUNDS, deckAddMenuOpens, deckAddPlace, deckAddPlaceAt, deckAddPoint, deckNewBlockBox, deckUsedBoxes, revisedAddedBlocks } from "./deckFreeSpace";
import { boxHolds, largestFreeBox, resolvedTextRegions } from "./deckGeometry";
import {
  createDeckSlide,
  deckRichText,
  defaultDeckTheme,
  withDeckBlockAdded,
  withDeckBlockBox,
  withoutDeckBlock,
  type DeckBullet,
  type DeckSlide,
} from "./deckModel";
import { approximateDeckMeasure } from "./deckTextFit";

const theme = defaultDeckTheme();
const bullets = (...lines: string[]): DeckBullet[] => lines.map((text) => ({ runs: [{ text }], level: 0 }));

function goalsSlide(): DeckSlide {
  return {
    ...createDeckSlide("two-column", "s1"),
    title: deckRichText("Quarterly goals and results"),
    left: bullets("GOALS", "Revenue: $3.0M", "Customer renewal rate: 94%", "Service uptime: 99.90%", "Product launches: 3"),
    right: bullets("ACTUAL RESULTS", "Revenue: $3.2M", "Customer renewal rate: 92%", "Service uptime: 99.95%", "Product launches: 2"),
  } as DeckSlide;
}

test("the largest empty rectangle avoids every box, and a point picks the empty area around it", () => {
  const bounds = { x: 0, y: 0, w: 100, h: 100 };
  expect(largestFreeBox([], bounds)).toEqual(bounds);
  // A box across the top leaves everything under it.
  expect(largestFreeBox([{ x: 0, y: 0, w: 100, h: 30 }], bounds)).toEqual({ x: 0, y: 30, w: 100, h: 70 });
  // A box in the corner: the taller strip beside it beats the wider strip under it.
  const corner = [{ x: 0, y: 0, w: 40, h: 60 }];
  expect(largestFreeBox(corner, bounds)).toEqual({ x: 40, y: 0, w: 60, h: 100 });
  expect(largestFreeBox(corner, bounds, { x: 10, y: 80 })).toEqual({ x: 0, y: 60, w: 100, h: 40 });
  expect(largestFreeBox(corner, bounds, { x: 10, y: 10 })).toBeNull();
  expect(largestFreeBox(corner, bounds, { x: 150, y: 10 })).toBeNull();
  // Boxes that run past the bounds only count for the part inside, and equal areas go to the top one.
  expect(largestFreeBox([{ x: -50, y: 40, w: 300, h: 20 }], bounds)).toEqual({ x: 0, y: 0, w: 100, h: 40 });
  expect(largestFreeBox([{ x: 0, y: 0, w: 100, h: 100 }], bounds)).toBeNull();
  // Touching edges is not overlapping, on any side.
  expect(largestFreeBox([{ x: 0, y: 0, w: 50, h: 100 }], bounds)).toEqual({ x: 50, y: 0, w: 50, h: 100 });
  expect(largestFreeBox([{ x: 50, y: 0, w: 50, h: 100 }], bounds)).toEqual({ x: 0, y: 0, w: 50, h: 100 });
  expect(largestFreeBox([{ x: 0, y: 70, w: 100, h: 30 }], bounds)).toEqual({ x: 0, y: 0, w: 100, h: 70 });
  // A box's edges belong to it.
  const ten = { x: 0, y: 0, w: 10, h: 10 };
  expect([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }, { x: 5, y: 5 }].map((point) => boxHolds(ten, point))).toEqual([true, true, true, true, true]);
  expect([{ x: 11, y: 5 }, { x: -1, y: 5 }, { x: 5, y: 11 }, { x: 5, y: -1 }].map((point) => boxHolds(ten, point))).toEqual([false, false, false, false]);
});

test("text covers its box only as far as its words run, so the foot of a short column is free", () => {
  const slide = goalsSlide();
  const regions = resolvedTextRegions(slide, "rule");
  const [title, left, right] = deckUsedBoxes(slide, theme, approximateDeckMeasure);
  // The heading is one line centred in its band; the columns start at the top of their boxes.
  expect(title.h).toBeLessThan(regions.title.box.h);
  expect(Math.abs(title.y + title.h / 2 - (regions.title.box.y + regions.title.box.h / 2))).toBeLessThanOrEqual(1);
  expect(left).toMatchObject({ x: regions.left.box.x, y: regions.left.box.y, w: regions.left.box.w });
  expect(left.h).toBeGreaterThan(5 * 15);
  expect(left.h).toBeLessThan(regions.left.box.h / 2);
  expect(right.h).toBe(left.h);

  // An empty box still holds its one line; a box filled past its foot stops at the foot.
  const empty = deckUsedBoxes(createDeckSlide("two-column", "s2"), theme, approximateDeckMeasure);
  expect(empty[1].h).toBeGreaterThan(15);
  expect(empty[1].h).toBeLessThan(40);
  const full = { ...slide, left: bullets(...Array.from({ length: 8 }, () => "A long line of words that wraps around the column more than once, every time")) } as DeckSlide;
  expect(deckUsedBoxes(full, theme, approximateDeckMeasure)[1].h).toBe(regions.left.box.h);

  // Pictures and added blocks count; a deleted block does not.
  let picture = withDeckBlockAdded(createDeckSlide("image-caption", "s3"), "picture", { x: 600, y: 300, w: 200, h: 150 })!.slide;
  expect(deckUsedBoxes(picture, theme, approximateDeckMeasure)).toHaveLength(4);
  expect(deckUsedBoxes(picture, theme, approximateDeckMeasure)[3]).toEqual({ x: 600, y: 300, w: 200, h: 150 });
  picture = withoutDeckBlock(withoutDeckBlock(picture, "image"), "caption");
  expect(deckUsedBoxes(picture, theme, approximateDeckMeasure)).toHaveLength(2);
});

test("the plus sits in the middle of the largest empty area, and a new block starts at the slide's text edge", () => {
  const slide = goalsSlide();
  const columnFoot = deckUsedBoxes(slide, theme, approximateDeckMeasure)[1];
  const place = deckAddPlace(slide, theme, approximateDeckMeasure);
  expect(place.free).toEqual({
    x: DECK_FREE_BOUNDS.x,
    y: columnFoot.y + columnFoot.h,
    w: DECK_FREE_BOUNDS.w,
    h: DECK_FREE_BOUNDS.y + DECK_FREE_BOUNDS.h - (columnFoot.y + columnFoot.h),
  });
  expect(place.corner).toEqual({ x: 60, y: place.free.y + 12 });
  expect(deckAddPoint(place)).toEqual({ x: 480, y: place.free.y + place.free.h / 2 });

  expect(deckNewBlockBox("text", place)).toEqual({ x: 60, y: place.free.y + 12, w: 480, h: 96 });
  expect(deckNewBlockBox("list", place)).toEqual({ x: 60, y: place.free.y + 12, w: 480, h: 200 });
  expect(deckNewBlockBox("picture", place)).toMatchObject({ x: 60, w: 360, h: 240 });

  // A blank slide: the whole offered area, starting at its own corner.
  const blank = withoutDeckBlock(withoutDeckBlock(createDeckSlide("title", "s2"), "title"), "subtitle");
  expect(deckAddPlace(blank, theme, approximateDeckMeasure)).toEqual({
    free: DECK_FREE_BOUNDS,
    corner: { x: DECK_FREE_BOUNDS.x, y: DECK_FREE_BOUNDS.y + 12 },
  });
});

test("a right-click places the block where it was made, kept inside the empty area around it", () => {
  const slide = goalsSlide();
  const free = deckAddPlace(slide, theme, approximateDeckMeasure).free;
  const at = { x: 700, y: free.y + 150 };
  const place = deckAddPlaceAt(slide, theme, at, approximateDeckMeasure)!;
  expect(place).toEqual({ free, corner: at });
  // Near the right edge and the foot, the block slides back to stay whole.
  expect(deckNewBlockBox("text", place)).toEqual({ x: free.x + free.w - 480, y: at.y, w: 480, h: 96 });
  const low = deckNewBlockBox("list", { free, corner: { x: 100, y: free.y + free.h - 10 } });
  expect(low).toEqual({ x: 100, y: free.y + free.h - 200, w: 480, h: 200 });
  expect(deckNewBlockBox("text", { free, corner: { x: -500, y: -500 } })).toMatchObject({ x: free.x, y: free.y });
  // A small empty area shrinks the block: across, half its usual width is left
  // from the corner, so it stays put; down, less than half, so it slides back.
  expect(deckNewBlockBox("picture", { free: { x: 100, y: 100, w: 200, h: 90 }, corner: { x: 120.4, y: 110.6 } })).toEqual({
    x: 120,
    y: 100,
    w: 180,
    h: 90,
  });
  // The turning point is half the usual size: 240 of a text box's 480.
  const wide = { x: 100, y: 100, w: 600, h: 300 };
  expect(deckNewBlockBox("text", { free: wide, corner: { x: 400, y: 100 } })).toMatchObject({ x: 400, w: 300 });
  expect(deckNewBlockBox("text", { free: wide, corner: { x: 460, y: 100 } })).toMatchObject({ x: 460, w: 240 });
  expect(deckNewBlockBox("text", { free: wide, corner: { x: 461, y: 100 } })).toMatchObject({ x: 220, w: 480 });
  expect(deckNewBlockBox("text", { free: wide, corner: { x: 100, y: 352 } })).toMatchObject({ y: 352, h: 48 });
  expect(deckNewBlockBox("text", { free: wide, corner: { x: 100, y: 353 } })).toMatchObject({ y: 304, h: 96 });

  // On a block there is nothing to add: the block keeps its own menu.
  expect(deckAddPlaceAt(slide, theme, { x: 100, y: 140 }, approximateDeckMeasure)).toBeNull();
  // In the margin, outside the offered area, the block still goes where asked.
  expect(deckAddPlaceAt(slide, theme, { x: 10, y: 530 }, approximateDeckMeasure)).toEqual({
    free: DECK_FREE_BOUNDS,
    corner: { x: 10, y: 530 },
  });
});

test("a slide with no room offers its bottom right corner", () => {
  let slide: DeckSlide = createDeckSlide("title", "s1");
  slide = withDeckBlockBox(withDeckBlockAdded(slide, "picture", { x: 0, y: 0, w: 960, h: 540 })!.slide, "picture-1", { x: 0, y: 0, w: 960, h: 540 });
  const place = deckAddPlace(slide, theme, approximateDeckMeasure);
  expect(place.free).toEqual({ x: 560, y: 388, w: 360, h: 120 });
  expect(deckNewBlockBox("text", place)).toEqual({ x: 560, y: 388, w: 360, h: 96 });
  expect(deckAddPoint(place)).toEqual({ x: 740, y: 448 });
  // A sliver of room is not offered either.
  const sliver = withDeckBlockBox(slide, "picture-1", { x: 0, y: 0, w: 960, h: 470 });
  expect(deckAddPlace(sliver, theme, approximateDeckMeasure).free).toEqual({ x: 560, y: 388, w: 360, h: 120 });
  const strip = withDeckBlockBox(slide, "picture-1", { x: 0, y: 0, w: 960, h: 464 });
  expect(deckAddPlace(strip, theme, approximateDeckMeasure).free).toEqual({ x: 40, y: 464, w: 880, h: 44 });
});

test("a revision keeps added blocks where they were and finds room for the ones it adds", () => {
  const spot = { x: 80, y: 300, w: 400, h: 120 };
  let kept = withDeckBlockAdded(goalsSlide(), "text", spot)!.slide;
  kept = withDeckBlockAdded(kept, "picture", { x: 600, y: 300, w: 200, h: 150 })!.slide;
  kept = { ...kept, added: kept.added!.map((block) => ("image" in block ? { ...block, image: { src: "https://example.test/a.png", alt: "Chart" } } : block)) };
  const revise = (revised: unknown, place?: Parameters<typeof revisedAddedBlocks>[3]) =>
    revisedAddedBlocks(revised, kept, theme, place, approximateDeckMeasure);

  // Saying nothing keeps everything; so does anything that is not a list.
  expect(revise(undefined)).toBe(kept.added);
  expect(revise("text-1")).toBe(kept.added);
  // A slide written from scratch has none, whatever the reply claims.
  expect(revisedAddedBlocks([{ id: "text-1", text: "x" }], undefined, theme)).toBeUndefined();

  // Kept blocks hold their box and picture file; the model's words and description are taken.
  expect(
    revise([
      { id: "text-1", text: "Sharper words", box: { x: 0, y: 0, w: 50, h: 50 } },
      { id: "picture-1", image: { src: "", alt: "Chart of renewals" } },
    ]),
  ).toEqual([
    { id: "text-1", text: "Sharper words", box: spot },
    { id: "picture-1", image: { src: "https://example.test/a.png", alt: "Chart of renewals" }, box: { x: 600, y: 300, w: 200, h: 150 } },
  ]);
  expect(revise([{ id: "picture-1" }, { id: "picture-1", image: { alt: "  " } }, { id: "picture-1", image: "x" }, { id: "picture-1", image: null }])).toEqual(
    Array.from({ length: 4 }, () => ({
      id: "picture-1",
      image: { src: "https://example.test/a.png", alt: "Chart" },
      box: { x: 600, y: 300, w: 200, h: 150 },
    })),
  );
  // Leaving a block out of the list deletes it.
  expect(revise([])).toEqual([]);

  // A new block goes where the author pointed; the next one to the empty space left.
  const asked = { free: { x: 500, y: 440, w: 400, h: 60 }, corner: { x: 520, y: 450 } };
  const added = revise(
    [
      { id: "text-1", text: "Kept" },
      { id: "text-new", text: "Key takeaway" },
      { id: "list-new", bullets: [{ runs: [{ text: "Next step" }], level: 0 }] },
      { bullets: [] },
      { text: "No name" },
      { id: "picture-new", image: { src: "", alt: "A picture" } },
      { id: "picture-words", text: "A picture cannot be written, whatever else it carries" },
      { id: "shape-1" },
      "text-9",
      null,
    ],
    asked,
  ) as Array<{ id: string; box: { x: number; y: number; w: number; h: number } }>;
  expect(added.map((block) => block.id)).toEqual(["text-1", "text-2", "list-1", "list-2", "text-3"]);
  expect(added.map((block) => (block as { text?: string }).text ?? "list")).toEqual(["Kept", "Key takeaway", "list", "list", "No name"]);
  expect(added[1].box).toEqual({ x: 520, y: 450, w: 380, h: 50 });
  // The second new block avoids the first one and the blocks already there.
  const overlaps = (a: typeof added[0]["box"], b: typeof added[0]["box"]) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  expect(overlaps(added[2].box, added[1].box)).toBe(false);
  expect(overlaps(added[2].box, spot)).toBe(false);
  expect(added[2].box.w).toBeGreaterThanOrEqual(120);

  // With nowhere asked for, the first new block takes the largest empty area.
  const unasked = revise([{ id: "text-new", text: "Note" }]) as typeof added;
  expect(unasked).toEqual([{ id: "text-2", text: "Note", box: deckNewBlockBox("text", deckAddPlace(kept, theme, approximateDeckMeasure)) }]);

  // A slide with nothing added yet takes its first block from a revision.
  expect(revisedAddedBlocks([{ id: "list-new", bullets: [] }], goalsSlide(), theme, null, approximateDeckMeasure)).toEqual([
    { id: "list-1", bullets: [], box: deckNewBlockBox("list", deckAddPlace(goalsSlide(), theme, approximateDeckMeasure)) },
  ]);

  // A full slide takes no more.
  let full = kept;
  while (withDeckBlockAdded(full, "text", spot)) full = withDeckBlockAdded(full, "text", spot)!.slide;
  expect(revisedAddedBlocks([{ id: "text-new", text: "One more" }], full, theme, null, approximateDeckMeasure)).toEqual([]);
});

test("the add menu opens down and right unless the slide lacks the room on that side at its zoom", () => {
  expect(deckAddMenuOpens({ x: 100, y: 100 }, 1)).toEqual({ up: false, left: false });
  // Full size: 200 pixels under the spot and 190 to its right are just enough.
  expect(deckAddMenuOpens({ x: 770, y: 340 }, 1)).toEqual({ up: false, left: false });
  expect(deckAddMenuOpens({ x: 771, y: 340 }, 1)).toEqual({ up: false, left: true });
  expect(deckAddMenuOpens({ x: 770, y: 341 }, 1)).toEqual({ up: true, left: false });
  // The same spot on a slide shown at a third of its size has room on neither side.
  expect(deckAddMenuOpens({ x: 480, y: 270 }, 1)).toEqual({ up: false, left: false });
  expect(deckAddMenuOpens({ x: 480, y: 270 }, 0.35)).toEqual({ up: true, left: true });
  expect(deckAddMenuOpens({ x: 100, y: 500 }, 0.5)).toEqual({ up: true, left: false });
});

test("a new block lines up with the leftmost text edge in the near half of the empty area", () => {
  const blank = withoutDeckBlock(withoutDeckBlock(createDeckSlide("title", "s1"), "title"), "subtitle");
  const withPictures = (...boxes: Array<{ x: number; y: number; w: number; h: number }>) =>
    boxes.reduce((slide, box) => withDeckBlockAdded(slide, "picture", box)!.slide, blank);
  const corner = (slide: DeckSlide) => deckAddPlace(slide, theme, approximateDeckMeasure).corner.x;
  // An edge left of the empty area, or at its middle or beyond, is no guide.
  expect(corner(withPictures({ x: 0, y: 0, w: 960, h: 100 }))).toBe(40);
  expect(corner(withPictures({ x: 480, y: 32, w: 440, h: 100 }))).toBe(40);
  expect(corner(withPictures({ x: 479, y: 32, w: 441, h: 100 }))).toBe(479);
  // Of several edges the leftmost wins, whatever order the blocks were added in.
  const band = { y: 32, w: 60, h: 60 };
  expect(corner(withPictures({ x: 300, ...band }, { x: 100, ...band }, { x: 200, ...band }))).toBe(100);
  expect(corner(withPictures({ x: 200, ...band }, { x: 300, ...band }, { x: 100, ...band }))).toBe(100);
  expect(corner(withPictures({ x: 100, ...band }, { x: 300, ...band }))).toBe(100);
  // The smallest area worth offering is 120 wide.
  expect(deckAddPlace(withPictures({ x: 160, y: 0, w: 800, h: 540 }), theme, approximateDeckMeasure).free).toEqual({ x: 40, y: 32, w: 120, h: 476 });
  expect(deckAddPlace(withPictures({ x: 159, y: 0, w: 801, h: 540 }), theme, approximateDeckMeasure).free.x).toBe(560);
  // A point on a block's edge is on the block.
  const picture = withPictures({ x: 300, y: 200, w: 100, h: 100 });
  expect(deckAddPlaceAt(picture, theme, { x: 300, y: 200 }, approximateDeckMeasure)).toBeNull();
  expect(deckAddPlaceAt(picture, theme, { x: 400, y: 300 }, approximateDeckMeasure)).toBeNull();
  expect(deckAddPlaceAt(picture, theme, { x: 299, y: 200 }, approximateDeckMeasure)).not.toBeNull();
});
