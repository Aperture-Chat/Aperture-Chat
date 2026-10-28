import { expect, test } from "vitest";
import {
  DECK_PREVIEW_HEIGHT_PX,
  DECK_PREVIEW_WIDTH_PX,
  deckRoleColor,
  resolvedMediaBox,
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
