import { expect, test } from "vitest";
import {
  DECK_SCHEMA_VERSION,
  MAX_SLIDE_BACKGROUND_CHARS,
  blankSlideDeck,
  deckBackgroundKey,
  deckRichText,
  contentLooksLikeDeck,
  deckSlideBackgroundSource,
  parseSlideDeck,
  serializeSlideDeck,
} from "./deckModel";
import { markdownOutlineFromDeck } from "./deckToDocument";

test("serializes canonically and round-trips through the validator", () => {
  const deck = blankSlideDeck("Quarterly Review");
  const serialized = serializeSlideDeck(deck);
  const reparsed = parseSlideDeck(serialized);
  expect(reparsed.ok).toBe(true);
  if (!reparsed.ok) return;
  expect(serializeSlideDeck(reparsed.deck)).toBe(serialized);
  // Key order does not affect the canonical bytes.
  const shuffled = JSON.parse(serialized);
  const reordered = { slides: shuffled.slides, theme: shuffled.theme, title: shuffled.title, schema: shuffled.schema };
  const reparsedShuffled = parseSlideDeck(JSON.stringify(reordered));
  expect(reparsedShuffled.ok).toBe(true);
  if (reparsedShuffled.ok) {
    expect(serializeSlideDeck(reparsedShuffled.deck)).toBe(serialized);
  }
});

test("detects deck content strings without being fooled by documents", () => {
  const deck = blankSlideDeck("Deck Draft");
  expect(contentLooksLikeDeck(serializeSlideDeck(deck))).toBe(true);
  expect(contentLooksLikeDeck("<p>A normal document.</p>")).toBe(false);
  expect(contentLooksLikeDeck(`<p>mentions ${DECK_SCHEMA_VERSION} in text</p>`)).toBe(false);
});

test("rejects invalid decks with actionable errors", () => {
  expect(parseSlideDeck("not json").ok).toBe(false);
  expect(parseSlideDeck({ schema: "wrong" }).ok).toBe(false);

  const badColor = parseSlideDeck({
    schema: DECK_SCHEMA_VERSION,
    title: "T",
    theme: { colors: { accent1: "red" }, fonts: {}, logo: null, sourceLabel: null },
    slides: [],
  });
  expect(badColor.ok).toBe(false);
  if (!badColor.ok) expect(badColor.error).toContain("accent1");

  const badLayout = parseSlideDeck({
    schema: DECK_SCHEMA_VERSION,
    title: "T",
    theme: {},
    slides: [{ id: "s1", notes: "", layout: "freeform" }],
  });
  expect(badLayout.ok).toBe(false);

  const unsafeImage = parseSlideDeck({
    schema: DECK_SCHEMA_VERSION,
    title: "T",
    theme: {},
    slides: [
      {
        id: "s1",
        notes: "",
        layout: "image-caption",
        title: "Pic",
        image: { src: "javascript:alert(1)", alt: "x" },
        caption: "",
      },
    ],
  });
  expect(unsafeImage.ok).toBe(false);
});

test("truncates oversized bullet lists with a warning instead of failing", () => {
  const bullets = Array.from({ length: 12 }, (_, index) => ({
    runs: [{ text: `Point ${index + 1}` }],
    level: 0,
  }));
  const result = parseSlideDeck({
    schema: DECK_SCHEMA_VERSION,
    title: "T",
    theme: {},
    slides: [{ id: "s1", notes: "", layout: "title-bullets", title: "List", bullets }],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const slide = result.deck.slides[0];
  expect(slide.layout).toBe("title-bullets");
  if (slide.layout === "title-bullets") expect(slide.bullets).toHaveLength(8);
  expect(result.warnings.join(" ")).toContain("truncated");
});

test("per-slide backgrounds live in a shared library and reject unsafe or oversized data", () => {
  const dataUrl = "data:image/png;base64,AAAA";
  const accepted = parseSlideDeck({
    schema: DECK_SCHEMA_VERSION,
    title: "Backdrops",
    theme: {},
    slides: [
      { id: "s1", notes: "", layout: "title", title: "Cover", subtitle: "", background: { dataUrl } },
      { id: "s2", notes: "", layout: "section", title: "Next", subtitle: "" },
    ],
  });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  // The legacy inline shape migrates into the deduplicating library.
  const key = deckBackgroundKey(dataUrl);
  expect(accepted.deck.slides[0].backgroundId).toBe(key);
  expect(accepted.deck.theme.backgroundLibrary[key]).toBe(dataUrl);
  expect(accepted.deck.slides[1].backgroundId).toBeUndefined();
  // The slide's own background wins; slides without one fall back to the theme.
  expect(deckSlideBackgroundSource(accepted.deck.slides[0], accepted.deck.theme)).toBe(dataUrl);
  expect(deckSlideBackgroundSource(accepted.deck.slides[1], accepted.deck.theme)).toBeNull();
  const themed = { ...accepted.deck.theme, backgroundImage: { dataUrl } };
  expect(deckSlideBackgroundSource(accepted.deck.slides[1], themed)).toBe(dataUrl);
  expect(serializeSlideDeck(parseSlideDeckOrThrow(serializeSlideDeck(accepted.deck)))).toBe(
    serializeSlideDeck(accepted.deck),
  );

  const unsafe = parseSlideDeck({
    schema: DECK_SCHEMA_VERSION,
    title: "Backdrops",
    theme: {},
    slides: [
      {
        id: "s1",
        notes: "",
        layout: "title",
        title: "Cover",
        subtitle: "",
        background: { dataUrl: "javascript:alert(1)" },
      },
    ],
  });
  expect(unsafe.ok).toBe(false);

  const oversized = parseSlideDeck({
    schema: DECK_SCHEMA_VERSION,
    title: "Backdrops",
    theme: {},
    slides: [
      {
        id: "s1",
        notes: "",
        layout: "title",
        title: "Cover",
        subtitle: "",
        background: { dataUrl: `data:image/png;base64,${"A".repeat(MAX_SLIDE_BACKGROUND_CHARS)}` },
      },
    ],
  });
  expect(oversized.ok).toBe(false);
});

function parseSlideDeckOrThrow(value: unknown) {
  const result = parseSlideDeck(value);
  if (!result.ok) throw new Error(result.error);
  return result.deck;
}

test("markdown outline reflects slides and notes honestly", () => {
  const deck = blankSlideDeck("Launch Plan");
  deck.slides = [
    {
      id: "a",
      notes: "Welcome everyone",
      layout: "title",
      title: deckRichText("Launch Plan"),
      subtitle: deckRichText("2026"),
    },
    {
      id: "b",
      notes: "",
      layout: "title-bullets",
      title: deckRichText("Timeline"),
      bullets: [
        { runs: [{ text: "Kickoff in July" }], level: 0 },
        { runs: [{ text: "Beta in August" }], level: 1 },
      ],
    },
    {
      id: "c",
      notes: "",
      layout: "quote",
      quote: deckRichText("Ship it"),
      attribution: deckRichText("The team"),
    },
  ];
  const outline = markdownOutlineFromDeck(deck);
  expect(outline).toContain("# Launch Plan");
  expect(outline).toContain("## Timeline");
  expect(outline).toContain("- Kickoff in July");
  expect(outline).toContain("  - Beta in August");
  expect(outline).toContain("> Ship it");
  expect(outline).toContain("> Notes: Welcome everyone");
});

test("user-resized block boxes round-trip, clamp, and drop unknown regions", () => {
  const deck = blankSlideDeck("Boxes");
  deck.slides = [
    {
      id: "s1",
      notes: "",
      layout: "closing",
      title: deckRichText("Thanks"),
      body: deckRichText("Closing message"),
      boxes: { body: { x: 160, y: 306, w: 640, h: 180 } },
    },
  ];
  const serialized = serializeSlideDeck(deck);
  const reparsed = parseSlideDeck(serialized);
  expect(reparsed.ok).toBe(true);
  if (!reparsed.ok) return;
  expect(reparsed.deck.slides[0].boxes).toEqual({ body: { x: 160, y: 306, w: 640, h: 180 } });
  expect(serializeSlideDeck(reparsed.deck)).toBe(serialized);

  // Out-of-range geometry clamps to the canvas; unknown regions and broken
  // values drop with a warning instead of failing the whole deck.
  const raw = JSON.parse(serialized);
  raw.slides[0].boxes = {
    body: { x: -50, y: 900, w: 5000, h: 4 },
    sparkles: { x: 1, y: 1, w: 100, h: 100 },
    title: { x: "left", y: 0, w: 100, h: 100 },
  };
  const clamped = parseSlideDeck(JSON.stringify(raw));
  expect(clamped.ok).toBe(true);
  if (!clamped.ok) return;
  expect(clamped.deck.slides[0].boxes).toEqual({ body: { x: 0, y: 516, w: 960, h: 24 } });
  expect(clamped.warnings.join(" ")).toContain("sparkles");
  expect(clamped.warnings.join(" ")).toContain("boxes.title");
});
