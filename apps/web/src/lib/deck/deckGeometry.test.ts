import { expect, test } from "vitest";
import {
  DECK_PREVIEW_HEIGHT_PX,
  DECK_PREVIEW_WIDTH_PX,
  deckRegionIsList,
  deckRegionLabel,
  deckRoleColor,
  resolvedMediaBox,
  resolvedTextRegions,
  slideDecorations,
  slideRegionNames,
  slideTextRegions,
  type DeckBox,
  type DeckDecorationSpec,
} from "./deckGeometry";
import {
  DECK_DESIGNS,
  SUPPORTED_DECK_LAYOUTS,
  createDeckSlide,
  deckSlideRegionContent,
  withDeckBlockAdded,
  withoutDeckBlock,
  defaultDeckTheme,
  type DeckDesign,
  type DeckSlideLayout,
} from "./deckModel";

const NEW_DESIGNS = DECK_DESIGNS.filter((design) => design !== "rule");

function center(box: DeckBox) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function covers(decoration: DeckDecorationSpec, point: { x: number; y: number }) {
  const { x, y, w, h } = decoration.box;
  if (decoration.shape === "ellipse") {
    const dx = (point.x - (x + w / 2)) / (w / 2);
    const dy = (point.y - (y + h / 2)) / (h / 2);
    return dx * dx + dy * dy <= 1;
  }
  return point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h;
}

/** The fill a text region sits on: the topmost shape under its middle that is
 * strong enough to change what text color reads on it. */
function strongFillUnder(layout: DeckSlideLayout, design: DeckDesign, box: DeckBox) {
  const point = center(box);
  const fills = slideDecorations(layout, design).filter((decoration) => covers(decoration, point));
  const top = fills[fills.length - 1];
  if (!top || (top.tint ?? 0) >= 0.5 || top.colorRole === "surface" || top.colorRole === "background") return null;
  return top;
}

test("the classic design keeps the original accent-rule geometry", () => {
  expect(slideDecorations("title", "rule")).toEqual([{ box: { x: 430, y: 312, w: 100, h: 5 }, colorRole: "accent1" }]);
  expect(slideTextRegions("title-bullets", "rule").bullets.box).toEqual({ x: 60, y: 126, w: 840, h: 356 });
  expect(slideTextRegions("quote", "rule").quote).toMatchObject({ sizePt: 24, italic: true, colorRole: "heading" });
});

test("every design gives every layout the same regions, inside the slide", () => {
  for (const layout of SUPPORTED_DECK_LAYOUTS) {
    const classicRegions = Object.keys(slideTextRegions(layout, "rule")).sort();
    // The drawn regions are exactly the slide's text fields, each one present
    // on a new slide of that layout.
    expect([...slideRegionNames(layout)].sort(), layout).toEqual(classicRegions);
    const blank = createDeckSlide(layout, "blank");
    for (const region of classicRegions) expect(deckSlideRegionContent(blank, region), `${layout} ${region}`).not.toBeUndefined();
    for (const design of DECK_DESIGNS) {
      const regions = slideTextRegions(layout, design);
      expect(Object.keys(regions).sort(), `${design} ${layout}`).toEqual(classicRegions);
      for (const [region, spec] of Object.entries(regions)) {
        const { x, y, w, h } = spec.box;
        const where = `${design} ${layout} ${region}`;
        expect(x >= 0 && y >= 0 && w > 0 && h > 0, where).toBe(true);
        expect(x + w <= DECK_PREVIEW_WIDTH_PX && y + h <= DECK_PREVIEW_HEIGHT_PX, where).toBe(true);
        expect(spec.sizePt, where).toBeLessThanOrEqual(96);
      }
    }
  }
});

test("text on a strong fill turns to the background color, and only there", () => {
  for (const layout of SUPPORTED_DECK_LAYOUTS) {
    for (const design of DECK_DESIGNS) {
      for (const [region, spec] of Object.entries(slideTextRegions(layout, design))) {
        const fill = strongFillUnder(layout, design, spec.box);
        const where = `${design} ${layout} ${region}`;
        if (fill) expect(spec.colorRole, where).toBe("background");
        else expect(spec.colorRole, where).not.toBe("background");
      }
    }
  }
});

test("each design draws its own look instead of recoloring one", () => {
  const signature = (layout: DeckSlideLayout, design: DeckDesign) =>
    JSON.stringify({
      decorations: slideDecorations(layout, design),
      text: Object.values(slideTextRegions(layout, design)).map(({ box, align, sizePt, bold, italic }) => ({
        box,
        align,
        sizePt,
        bold,
        italic,
      })),
    });
  for (const layout of ["title", "title-bullets", "section", "statement", "big-number", "image-bullets"] as const) {
    const looks = new Set(DECK_DESIGNS.map((design) => signature(layout, design)));
    expect(looks.size, layout).toBe(DECK_DESIGNS.length);
  }
  // None of the new designs fall back to the centered accent rule.
  for (const design of NEW_DESIGNS) {
    expect(JSON.stringify(slideDecorations("title", design)), design).not.toContain('"x":430,"y":312');
  }
});

test("picture layouts place the picture where the design wants it, honoring a resized box", () => {
  const picture = createDeckSlide("image-bullets", "p1");
  expect(resolvedMediaBox(picture, "rule")).toEqual({ x: 0, y: 0, w: 440, h: 540 });
  expect(resolvedMediaBox(picture, "split")?.x).toBeGreaterThan(400);
  expect(resolvedMediaBox({ ...picture, boxes: { image: { x: 10, y: 20, w: 300, h: 200 } } }, "split")).toEqual({
    x: 10,
    y: 20,
    w: 300,
    h: 200,
  });
  expect(resolvedMediaBox(createDeckSlide("statement", "s1"), "orbit")).toBeNull();
});

test("role colors resolve from the theme and soften toward the background by tint", () => {
  const theme = defaultDeckTheme();
  expect(deckRoleColor(theme, "accent1")).toBe("#087d8b");
  expect(deckRoleColor(theme, "background")).toBe("#ffffff");
  // Halfway from #087d8b to #ffffff.
  expect(deckRoleColor(theme, "accent1", 0.5)).toBe("#84bec5");
  expect(deckRoleColor(theme, "accent1", 1)).toBe("#ffffff");
});

test("a deleted block has no place on the slide; the blocks that stay keep theirs", () => {
  const slide = createDeckSlide("image-bullets", "p1");
  const all = resolvedTextRegions(slide, "rule");
  expect(Object.keys(all)).toEqual(["title", "bullets"]);

  const withoutTitle = withoutDeckBlock(slide, "title");
  expect(Object.keys(resolvedTextRegions(withoutTitle, "rule"))).toEqual(["bullets"]);
  expect(resolvedTextRegions(withoutTitle, "rule").bullets).toEqual(all.bullets);
  expect(resolvedMediaBox(withoutTitle, "rule")).toEqual(resolvedMediaBox(slide, "rule"));

  const moved = { ...withoutTitle, boxes: { bullets: { x: 500, y: 200, w: 400, h: 200 }, title: { x: 1, y: 2, w: 300, h: 40 } } };
  expect(resolvedTextRegions(moved, "rule")).toEqual({
    bullets: { ...all.bullets, box: { x: 500, y: 200, w: 400, h: 200 } },
  });

  const withoutPicture = withoutDeckBlock(slide, "image");
  expect(resolvedMediaBox(withoutPicture, "rule")).toBeNull();
  expect(resolvedMediaBox({ ...withoutPicture, boxes: { image: { x: 10, y: 20, w: 300, h: 200 } } }, "split")).toBeNull();
  expect(resolvedTextRegions(withoutPicture, "rule")).toEqual(all);
});

test("added blocks sit in their own boxes, set like body text, and are named for their kind", () => {
  const spot = { x: 80, y: 300, w: 400, h: 120 };
  let slide = withDeckBlockAdded(createDeckSlide("image-bullets", "p1"), "text", spot)!.slide;
  slide = withDeckBlockAdded(slide, "list", { ...spot, x: 500 })!.slide;
  slide = withDeckBlockAdded(slide, "picture", { ...spot, y: 20 })!.slide;
  const regions = resolvedTextRegions(slide, "split");
  expect(Object.keys(regions)).toEqual(["title", "bullets", "text-1", "list-1"]);
  expect(regions["text-1"]).toEqual({ box: spot, sizePt: 18, align: "left", colorRole: "body", font: "minor", anchor: "top" });
  expect(regions["list-1"]).toEqual({ box: { ...spot, x: 500 }, sizePt: 16, align: "left", colorRole: "body", font: "minor", anchor: "top" });
  expect(regions.title).toEqual(resolvedTextRegions(createDeckSlide("image-bullets", "p1"), "split").title);

  expect(resolvedMediaBox(slide, "split", "picture-1")).toEqual({ ...spot, y: 20 });
  expect(resolvedMediaBox(slide, "split")).toEqual(resolvedMediaBox(createDeckSlide("image-bullets", "p1"), "split"));
  expect(resolvedMediaBox(slide, "split", "text-1")).toBeNull();
  expect(resolvedMediaBox(slide, "split", "picture-2")).toBeNull();
  expect(resolvedMediaBox(createDeckSlide("title", "t1"), "rule", "picture-1")).toBeNull();

  expect(["bullets", "left", "right", "list-1"].map(deckRegionIsList)).toEqual([true, true, true, true]);
  expect(["title", "text-1", "picture-1", "list"].map(deckRegionIsList)).toEqual([false, false, false, false]);
  expect(["title", "left", "text-2", "list-1", "picture-3", "mystery"].map(deckRegionLabel)).toEqual([
    "Title",
    "Left column",
    "Text box",
    "Bullet list",
    "Picture",
    "mystery",
  ]);
});
