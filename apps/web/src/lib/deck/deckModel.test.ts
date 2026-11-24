import { expect, test } from "vitest";
import {
  DECK_SCHEMA_VERSION,
  MAX_SLIDE_BACKGROUND_CHARS,
  SUPPORTED_DECK_LAYOUTS,
  blankSlideDeck,
  createDeckSlide,
  deckSlideOutline,
  deckSlidePicture,
  withDeckSlidePicture,
  MAX_DECK_ADDED_BLOCKS,
  deckAddedKind,
  deckPictureRegions,
  withDeckAddedContent,
  withDeckBlockAdded,
  withDeckBlockBox,
  deckBlockRemoved,
  deckBlocksStillRemoved,
  deckSlideBlocks,
  withDeckBlocksRestored,
  withoutDeckBlock,
  deckSlideRegionContent,
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

test("a theme's design round-trips, the classic design stays implicit, and unknown designs drop", () => {
  const withDesign = (design: unknown) =>
    parseSlideDeck({ ...JSON.parse(serializeSlideDeck(blankSlideDeck("Designs"))), theme: { design } });

  const orbit = withDesign("orbit");
  expect(orbit.ok).toBe(true);
  if (!orbit.ok) return;
  expect(orbit.deck.theme.design).toBe("orbit");
  expect(serializeSlideDeck(orbit.deck)).toContain('"design":"orbit"');

  // The classic look is the absence of a design, so decks saved before
  // designs existed keep byte-identical content.
  const classic = withDesign("rule");
  expect(classic.ok).toBe(true);
  if (classic.ok) expect(serializeSlideDeck(classic.deck)).not.toContain('"design"');
  expect(serializeSlideDeck(blankSlideDeck("Plain"))).not.toContain('"design"');

  // No design, or an explicit null, is simply the classic look: no warning.
  for (const absent of [undefined, null]) {
    const plain = withDesign(absent);
    expect(plain.ok && plain.warnings).toEqual([]);
  }

  const unknown = withDesign("neon-zebra");
  expect(unknown.ok).toBe(true);
  if (!unknown.ok) return;
  expect(unknown.deck.theme.design).toBeUndefined();
  expect(unknown.warnings.join(" ")).toContain("theme.design");
});

test("statement, big-number, and picture + bullets slides parse with their own regions", () => {
  expect(SUPPORTED_DECK_LAYOUTS).toEqual(expect.arrayContaining(["statement", "big-number", "image-bullets"]));
  const parsed = parseSlideDeck({
    schema: DECK_SCHEMA_VERSION,
    title: "New layouts",
    slides: [
      { id: "s1", notes: "", layout: "statement", title: "Ship weekly", body: "Small batches beat big launches" },
      { id: "s2", notes: "", layout: "big-number", title: "42%", subtitle: "of renewals came from referrals" },
      {
        id: "s3",
        notes: "",
        layout: "image-bullets",
        title: "The new office",
        image: { src: "", alt: "Harbor-side office at dusk" },
        bullets: [{ runs: [{ text: "Opens in May" }], level: 0 }],
      },
    ],
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const [statement, figure, picture] = parsed.deck.slides;
  expect(deckSlideRegionContent(statement, "body")).toEqual([{ text: "Small batches beat big launches" }]);
  expect(deckSlideRegionContent(figure, "subtitle")).toEqual([{ text: "of renewals came from referrals" }]);
  expect(deckSlideRegionContent(picture, "bullets")).toEqual([{ runs: [{ text: "Opens in May" }], level: 0 }]);
  expect(deckSlideRegionContent(picture, "caption")).toBeNull();
  expect(deckSlideOutline(figure)).toBe("42%\nof renewals came from referrals");
  expect(deckSlideOutline(picture)).toBe("The new office\n[Image: Harbor-side office at dusk]\n- Opens in May");

  expect(createDeckSlide("image-bullets", "n1")).toMatchObject({
    layout: "image-bullets",
    image: { src: "", alt: "" },
    bullets: [{ runs: [{ text: "" }], level: 0 }],
  });
  expect(createDeckSlide("statement", "n2")).toMatchObject({ layout: "statement", title: [], body: [] });
  expect(createDeckSlide("big-number", "n3")).toMatchObject({ layout: "big-number", title: [], subtitle: [] });
});

test("both picture layouts expose and replace their picture; other layouts have none", () => {
  const office = { src: "https://example.test/office.jpg", alt: "Office" };
  for (const layout of ["image-caption", "image-bullets"] as const) {
    const slide = withDeckSlidePicture(createDeckSlide(layout, "p"), office);
    expect(deckSlidePicture(slide)).toEqual(office);
    expect(slide.layout).toBe(layout);
  }
  const statement = createDeckSlide("statement", "s");
  expect(deckSlidePicture(statement)).toBeNull();
  expect(withDeckSlidePicture(statement, office)).toBe(statement);
});

test("the markdown outline carries the new layouts' words and picture", () => {
  const deck = blankSlideDeck("Outline");
  deck.slides = [
    { id: "a", notes: "", layout: "statement", title: deckRichText("Ship weekly"), body: deckRichText("Small batches win") },
    { id: "b", notes: "", layout: "big-number", title: deckRichText("42%"), subtitle: deckRichText("of renewals") },
    {
      id: "c",
      notes: "",
      layout: "image-bullets",
      title: deckRichText("Office"),
      image: { src: "https://example.test/office.jpg", alt: "Harbor office" },
      bullets: [{ runs: [{ text: "Opens in May" }], level: 0 }],
    },
  ];
  expect(markdownOutlineFromDeck(deck)).toBe(
    [
      "# Outline",
      "## Ship weekly\n\nSmall batches win",
      "## 42%\n\nof renewals",
      "## Office\n\n![Harbor office](https://example.test/office.jpg)\n\n- Opens in May",
    ].join("\n\n"),
  );
});

test("deleting a block takes its words with it and the slide stops having that region", () => {
  const slide = {
    ...createDeckSlide("title", "s1"),
    title: deckRichText("Quarterly review"),
    subtitle: deckRichText("Prepared for the board"),
  };
  const without = withoutDeckBlock(slide, "subtitle");
  expect(deckBlockRemoved(without, "subtitle")).toBe(true);
  expect(deckBlockRemoved(without, "title")).toBe(false);
  expect(deckBlockRemoved(slide, "subtitle")).toBe(false);
  expect(deckSlideRegionContent(without, "subtitle")).toBeNull();
  expect(deckSlideRegionContent(without, "title")).toEqual(deckRichText("Quarterly review"));
  expect(deckSlideOutline(without)).toBe("Quarterly review");
  expect(without.removed).toEqual(["subtitle"]);
  // Deleting it again, or deleting something the layout never had, changes nothing.
  expect(withoutDeckBlock(without, "subtitle")).toEqual(without);
  expect(withoutDeckBlock(slide, "bullets")).toBe(slide);
  expect(withoutDeckBlock(slide, "image")).toBe(slide);
  // Every block can go, in whatever order; the list stays sorted.
  const empty = withoutDeckBlock(without, "title");
  expect(empty.removed).toEqual(["subtitle", "title"]);
  expect(withoutDeckBlock(withoutDeckBlock(slide, "title"), "subtitle")).toEqual(empty);
  expect(deckSlideOutline(empty)).toBe("");
});

test("each layout's blocks are its text regions plus its picture", () => {
  expect(deckSlideBlocks("title")).toEqual(["title", "subtitle"]);
  expect(deckSlideBlocks("two-column")).toEqual(["title", "left", "right"]);
  expect(deckSlideBlocks("image-caption")).toEqual(["title", "caption", "image"]);
  expect(deckSlideBlocks("image-bullets")).toEqual(["title", "bullets", "image"]);
  expect(deckSlideBlocks("quote")).toEqual(["quote", "attribution"]);
});

test("deleting the picture block removes the picture and the slide no longer holds one", () => {
  const office = { src: "https://example.test/office.jpg", alt: "Office" };
  const slide = withDeckSlidePicture(
    { ...createDeckSlide("image-bullets", "p1"), title: deckRichText("New office") },
    office,
  );
  const without = withoutDeckBlock(slide, "image");
  expect(without.removed).toEqual(["image"]);
  expect(deckSlidePicture(without)).toBeNull();
  expect(withDeckSlidePicture(without, office)).toBe(without);
  expect(deckSlideOutline(slide)).toContain("[Image: Office]");
  expect(deckSlideOutline(without)).not.toContain("[Image");
  expect(JSON.stringify(without)).not.toContain("office.jpg");
});

test("putting blocks back restores them empty, as a new slide of that layout has them", () => {
  const slide = {
    ...createDeckSlide("image-bullets", "p1"),
    title: deckRichText("New office"),
    boxes: { bullets: { x: 500, y: 200, w: 400, h: 200 } },
  };
  const fresh = createDeckSlide("image-bullets", "p1");
  const emptied = withoutDeckBlock(withoutDeckBlock(slide, "bullets"), "image");
  const restored = withDeckBlocksRestored(emptied);
  expect(restored).not.toHaveProperty("removed");
  expect(deckSlideRegionContent(restored, "bullets")).toEqual(deckSlideRegionContent(fresh, "bullets"));
  expect(deckSlidePicture(restored)).toEqual({ src: "", alt: "" });
  expect(deckSlideRegionContent(restored, "title")).toEqual(deckRichText("New office"));
  // A block comes back where the author had put it.
  expect(restored.boxes).toEqual({ bullets: { x: 500, y: 200, w: 400, h: 200 } });
  expect(withDeckBlocksRestored(slide)).toBe(slide);
});

test("deleted blocks round-trip in a stable order and can never keep words", () => {
  const deck = blankSlideDeck("Deleted blocks");
  deck.slides = [
    withoutDeckBlock(
      withoutDeckBlock(
        { ...createDeckSlide("two-column", "s1"), title: deckRichText("Compare") },
        "right",
      ),
      "left",
    ),
    withoutDeckBlock(createDeckSlide("image-caption", "s2"), "image"),
  ];
  const serialized = serializeSlideDeck(deck);
  const reparsed = parseSlideDeck(serialized);
  expect(reparsed.ok).toBe(true);
  if (!reparsed.ok) return;
  expect(reparsed.deck.slides[0].removed).toEqual(["left", "right"]);
  expect(reparsed.deck.slides[1].removed).toEqual(["image"]);
  expect(reparsed.warnings).toEqual([]);
  expect(serializeSlideDeck(reparsed.deck)).toBe(serialized);

  // Words in a deleted block, repeats, names the layout lacks, and broken
  // values are all cleaned at the door rather than failing the deck.
  const raw = JSON.parse(serialized);
  raw.slides[0].removed = ["right", "left", "right", "subtitle", 7];
  raw.slides[0].left = [{ runs: [{ text: "Hidden words" }], level: 0 }];
  raw.slides[1].removed = ["image"];
  raw.slides[1].image = { src: "https://example.test/secret.png", alt: "Secret" };
  const cleaned = parseSlideDeck(JSON.stringify(raw));
  expect(cleaned.ok).toBe(true);
  if (!cleaned.ok) return;
  expect(serializeSlideDeck(cleaned.deck)).toBe(serialized);
  expect(cleaned.warnings.join(" ")).toContain("slides[0].removed");
  expect(cleaned.warnings.join(" ")).toContain("subtitle");

  raw.slides[0].removed = "left";
  raw.slides[1].removed = [];
  const dropped = parseSlideDeck(JSON.stringify(raw));
  expect(dropped.ok).toBe(true);
  if (!dropped.ok) return;
  expect(dropped.deck.slides[0]).not.toHaveProperty("removed");
  expect(dropped.deck.slides[1]).not.toHaveProperty("removed");
  expect(deckSlideRegionContent(dropped.deck.slides[0], "left")).toEqual([
    { runs: [{ text: "Hidden words" }], level: 0 },
  ]);
  expect(dropped.warnings.join(" ")).toContain("slides[0].removed was not a list");
  // A deck with nothing deleted keeps the bytes it always had.
  expect(serializeSlideDeck(blankSlideDeck("Plain"))).not.toContain("removed");
});

test("a revised slide keeps its deleted blocks unless the revision wrote into them", () => {
  const kept = withoutDeckBlock(
    withoutDeckBlock(withoutDeckBlock(createDeckSlide("image-bullets", "s1"), "title"), "bullets"),
    "image",
  );
  expect(deckBlocksStillRemoved(kept, { title: [], bullets: [], image: { src: "", alt: "Office" } })).toEqual([
    "bullets",
    "image",
    "title",
  ]);
  expect(deckBlocksStillRemoved(kept, {})).toEqual(["bullets", "image", "title"]);
  expect(deckBlocksStillRemoved(kept, { title: "  ", bullets: [{ runs: [{ text: "" }], level: 0 }] })).toEqual([
    "bullets",
    "image",
    "title",
  ]);
  // Words the revision put in a deleted block bring that block back.
  expect(deckBlocksStillRemoved(kept, { title: "New heading" })).toEqual(["bullets", "image"]);
  expect(deckBlocksStillRemoved(kept, { title: [{ text: "New heading" }] })).toEqual(["bullets", "image"]);
  // One character is still a word.
  expect(deckBlocksStillRemoved(kept, { title: "7" })).toEqual(["bullets", "image"]);
  expect(
    deckBlocksStillRemoved(kept, { bullets: [{ runs: [{ text: "" }, { text: "First point" }], level: 0 }] }),
  ).toEqual(["image", "title"]);
  expect(deckBlocksStillRemoved(createDeckSlide("title", "s2"), { title: "x" })).toEqual([]);
});

const SPOT = { x: 80, y: 300, w: 400, h: 120 };

test("an author can add text boxes, bullet lists, and pictures to any slide, each named for its kind", () => {
  const slide = { ...createDeckSlide("title", "s1"), title: deckRichText("Quarterly review") };
  const first = withDeckBlockAdded(slide, "text", SPOT)!;
  expect(first.region).toBe("text-1");
  expect(deckSlideRegionContent(first.slide, "text-1")).toEqual([]);
  const second = withDeckBlockAdded(first.slide, "text", { ...SPOT, y: 430 })!;
  expect(second.region).toBe("text-2");
  const list = withDeckBlockAdded(second.slide, "list", SPOT)!;
  expect(list.region).toBe("list-1");
  expect(deckSlideRegionContent(list.slide, "list-1")).toEqual([{ runs: [{ text: "" }], level: 0 }]);
  const picture = withDeckBlockAdded(list.slide, "picture", SPOT)!;
  expect(picture.region).toBe("picture-1");
  expect(deckSlidePicture(picture.slide, "picture-1")).toEqual({ src: "", alt: "" });
  // A picture block has no words; a title slide's layout still has no picture.
  expect(deckSlideRegionContent(picture.slide, "picture-1")).toBeNull();
  expect(deckSlidePicture(picture.slide)).toBeNull();
  expect(deckSlidePicture(picture.slide, "text-1")).toBeNull();
  expect(deckSlidePicture(picture.slide, "picture-9")).toBeNull();
  expect(picture.slide.added!.map((block) => block.id)).toEqual(["text-1", "text-2", "list-1", "picture-1"]);
  expect(picture.slide.added![1].box).toEqual({ ...SPOT, y: 430 });
  // The layout's own blocks are untouched, and the original slide is not changed.
  expect(deckSlideRegionContent(picture.slide, "title")).toEqual(deckRichText("Quarterly review"));
  expect(slide).not.toHaveProperty("added");

  // A freed number is reused, so names stay short.
  const freed = withoutDeckBlock(picture.slide, "text-1");
  expect(withDeckBlockAdded(freed, "text", SPOT)!.region).toBe("text-1");

  expect(deckAddedKind("text-1")).toBe("text");
  expect(deckAddedKind("list-2")).toBe("list");
  expect(deckAddedKind("picture-12")).toBe("picture");
  for (const name of ["title", "image", "text", "text-", "text-1 ", "xtext-1", "shape-1", "text-ABC"]) {
    expect(deckAddedKind(name), name).toBeNull();
  }
});

test("a slide holds a bounded number of added blocks", () => {
  let slide = createDeckSlide("statement", "s1");
  for (let count = 0; count < MAX_DECK_ADDED_BLOCKS; count += 1) slide = withDeckBlockAdded(slide, "text", SPOT)!.slide;
  expect(slide.added).toHaveLength(MAX_DECK_ADDED_BLOCKS);
  expect(withDeckBlockAdded(slide, "text", SPOT)).toBeNull();
  expect(withDeckBlockAdded(withoutDeckBlock(slide, "text-3"), "list", SPOT)!.region).toBe("list-1");
});

test("added blocks take words, pictures, and a new place, and are deleted outright", () => {
  let slide = withDeckBlockAdded(createDeckSlide("image-caption", "s1"), "text", SPOT)!.slide;
  slide = withDeckBlockAdded(slide, "list", SPOT)!.slide;
  slide = withDeckBlockAdded(slide, "picture", SPOT)!.slide;
  const bullets = [{ runs: [{ text: "First point" }], level: 0 as const }];
  slide = withDeckAddedContent(slide, "text-1", deckRichText("A note"));
  slide = withDeckAddedContent(slide, "list-1", bullets);
  expect(deckSlideRegionContent(slide, "text-1")).toEqual(deckRichText("A note"));
  expect(deckSlideRegionContent(slide, "list-1")).toEqual(bullets);
  // Words cannot go into a picture, a block that is not there, or a layout block.
  expect(withDeckAddedContent(slide, "picture-1", deckRichText("x"))).toBe(slide);
  expect(withDeckAddedContent(slide, "text-7", deckRichText("x"))).toBe(slide);
  expect(withDeckAddedContent(slide, "title", deckRichText("x"))).toBe(slide);

  const office = { src: "https://example.test/office.jpg", alt: "Office" };
  const chart = { src: "https://example.test/chart.png", alt: "Chart" };
  slide = withDeckSlidePicture(withDeckSlidePicture(slide, office), chart, "picture-1");
  expect(deckSlidePicture(slide)).toEqual(office);
  expect(deckSlidePicture(slide, "picture-1")).toEqual(chart);
  expect(deckPictureRegions(slide)).toEqual(["image", "picture-1"]);
  expect(withDeckSlidePicture(slide, chart, "text-1")).toBe(slide);
  expect(withDeckSlidePicture(slide, chart, "picture-4")).toBe(slide);
  expect(deckSlideOutline(slide).split("\n")).toEqual(["[Image: Office]", "A note", "- First point", "[Image: Chart]"]);

  // Moving an added block changes its own box; a layout block gets an override.
  const moved = withDeckBlockBox(withDeckBlockBox(slide, "text-1", { x: 1, y: 2, w: 300, h: 60 }), "caption", { x: 5, y: 6, w: 200, h: 50 });
  expect(moved.added![0].box).toEqual({ x: 1, y: 2, w: 300, h: 60 });
  expect(moved.added![1].box).toEqual(SPOT);
  expect(moved.boxes).toEqual({ caption: { x: 5, y: 6, w: 200, h: 50 } });

  // Deleting the layout's picture leaves the added one; an added block is gone for good.
  const withoutLayoutPicture = withoutDeckBlock(slide, "image");
  expect(deckPictureRegions(withoutLayoutPicture)).toEqual(["picture-1"]);
  const withoutAdded = withoutDeckBlock(withoutDeckBlock(withoutDeckBlock(slide, "text-1"), "list-1"), "picture-1");
  expect(withoutAdded).not.toHaveProperty("added");
  expect(withoutAdded).not.toHaveProperty("removed");
  expect(withDeckBlocksRestored(withoutDeckBlock(withoutLayoutPicture, "text-1")).added!.map((block) => block.id)).toEqual([
    "list-1",
    "picture-1",
  ]);
  expect(deckPictureRegions(createDeckSlide("title", "s2"))).toEqual([]);
});

test("added blocks round-trip through the validator, which drops unusable ones and rejects unsafe pictures", () => {
  const deck = blankSlideDeck("Added blocks");
  let slide = withDeckBlockAdded({ ...createDeckSlide("title", "s1"), title: deckRichText("Cover") }, "text", SPOT)!.slide;
  slide = withDeckAddedContent(slide, "text-1", [{ text: "Bold note", bold: true }]);
  slide = withDeckBlockAdded(slide, "list", { x: 500, y: 300, w: 400, h: 200 })!.slide;
  slide = withDeckSlidePicture(withDeckBlockAdded(slide, "picture", SPOT)!.slide, { src: "https://example.test/a.png", alt: "A" }, "picture-1");
  deck.slides = [slide];
  const serialized = serializeSlideDeck(deck);
  const reparsed = parseSlideDeck(serialized);
  expect(reparsed.ok).toBe(true);
  if (!reparsed.ok) return;
  expect(reparsed.warnings).toEqual([]);
  expect(serializeSlideDeck(reparsed.deck)).toBe(serialized);

  const raw = JSON.parse(serialized);
  raw.slides[0].added = [
    { id: "text-1", box: { x: -40, y: 530, w: 5000, h: 2 }, text: "Plain words" },
    { id: "text-1", box: SPOT, text: "Same name again" },
    { id: "title", box: SPOT, text: "A layout name" },
    { id: "list-1", box: SPOT },
    { id: "picture-1", box: SPOT },
    { id: "text-2", text: "No box" },
    { id: "text-3", box: { x: "left", y: 0, w: 10, h: 10 }, text: "Bad box" },
    "text-4",
    { box: SPOT, text: "No name" },
    null,
  ];
  const cleaned = parseSlideDeck(JSON.stringify(raw));
  expect(cleaned.ok).toBe(true);
  if (!cleaned.ok) return;
  expect(cleaned.deck.slides[0].added).toEqual([
    { id: "text-1", box: { x: 0, y: 516, w: 960, h: 24 }, text: [{ text: "Plain words" }] },
    { id: "list-1", box: SPOT, bullets: [] },
    { id: "picture-1", box: SPOT, image: { src: "", alt: "" } },
  ]);
  expect(cleaned.warnings.filter((warning) => warning.includes("not a usable added block"))).toHaveLength(7);
  expect(cleaned.warnings.join(" ")).toContain("slides[0].added[1]");

  raw.slides[0].added = Array.from({ length: MAX_DECK_ADDED_BLOCKS + 2 }, (_, index) => ({ id: `text-${index + 1}`, box: SPOT, text: "" }));
  const capped = parseSlideDeck(JSON.stringify(raw));
  expect(capped.ok && capped.deck.slides[0].added).toHaveLength(MAX_DECK_ADDED_BLOCKS);
  expect(capped.ok && capped.warnings.join(" ")).toContain(`truncated to ${MAX_DECK_ADDED_BLOCKS} blocks`);

  raw.slides[0].added = "text-1";
  const dropped = parseSlideDeck(JSON.stringify(raw));
  expect(dropped.ok && dropped.deck.slides[0]).not.toHaveProperty("added");
  expect(dropped.ok && dropped.warnings.join(" ")).toContain("slides[0].added was not a list");
  raw.slides[0].added = [];
  const none = parseSlideDeck(JSON.stringify(raw));
  expect(none.ok && none.deck.slides[0]).not.toHaveProperty("added");

  raw.slides[0].added = [{ id: "picture-1", box: SPOT, image: { src: "javascript:alert(1)", alt: "" } }];
  const unsafe = parseSlideDeck(JSON.stringify(raw));
  expect(unsafe.ok).toBe(false);
  expect(!unsafe.ok && unsafe.error).toContain("slides[0].added[0].image.src");
  raw.slides[0].added = [{ id: "text-1", box: SPOT, text: 7 }];
  expect(parseSlideDeck(JSON.stringify(raw)).ok).toBe(false);
  raw.slides[0].added = [{ id: "list-1", box: SPOT, bullets: "x" }];
  expect(parseSlideDeck(JSON.stringify(raw)).ok).toBe(false);
  expect(serializeSlideDeck(blankSlideDeck("Plain"))).not.toContain("added");
});

test("an added block's box is pulled back onto the slide from any side, and needs real numbers", () => {
  const parsed = (box: unknown) => {
    const raw = JSON.parse(serializeSlideDeck(blankSlideDeck("Boxes"))) as { slides: Array<Record<string, unknown>> };
    raw.slides[0].added = [{ id: "text-1", box, text: "x" }];
    const result = parseSlideDeck(raw);
    return result.ok ? result.deck.slides[0].added?.[0].box ?? null : "invalid";
  };
  expect(parsed({ x: -5, y: -7, w: 100, h: 50 })).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  expect(parsed({ x: 950, y: 530, w: 100, h: 50 })).toEqual({ x: 860, y: 490, w: 100, h: 50 });
  expect(parsed({ x: 10.4, y: 20.6, w: 100.5, h: 49.5 })).toEqual({ x: 10, y: 21, w: 101, h: 50 });
  for (const broken of [{ x: Number.NaN, y: 0, w: 100, h: 50 }, { x: 0, y: Infinity, w: 100, h: 50 }, { x: "5", y: 0, w: 100, h: 50 }]) {
    expect(parsed(broken)).toBeNull();
  }
});
