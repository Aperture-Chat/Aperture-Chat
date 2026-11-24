/** Slide deck data model for the Drafts workspace's PowerPoint mode.
 *
 * The deck is stored as canonical (recursively key-sorted) JSON so identical
 * decks always serialize to identical bytes — the same property canonical
 * sanitized HTML gives document drafts for revision hashing and CAS sync.
 * `parseSlideDeck` is the single validation gate: AI-generated decks,
 * template lifts, and stored round-trips all pass through it before anything
 * renders or exports.
 */

export const DECK_SCHEMA_VERSION = "aperture-deck-v1";
export const DECK_SANITIZER_VERSION = "deck-json-v1";
export const MAX_DECK_SLIDES = 100;
/** Decks carry their slide artwork inline (one copy per distinct design), so
 * the budget has to fit a real brand template: ~30 flattened designs plus
 * text. Storage failures at this size are reported, never silently swallowed. */
export const MAX_DECK_CONTENT_BYTES = 8_000_000;
export const MAX_DECK_BULLETS_PER_SLIDE = 8;
const MAX_RUN_TEXT_CHARS = 2000;
const MAX_NOTES_CHARS = 4000;
const MAX_TITLE_CHARS = 300;

export type DeckTextRun = {
  text: string;
  /** Explicit false matters: title and quote regions are bold or italic by
   * layout, so "off" has to be storable or the toolbar toggle springs back. */
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** "#RRGGBB" only. */
  color?: string;
  /** Point size override, 8..96. Layouts own the default sizes. */
  sizePt?: number;
  /** Font family override (single family name, e.g. "Georgia"). The theme's
   * major/minor fonts own the defaults; absence means "follow the theme". */
  font?: string;
};

/** Single font-family name: letters, digits, spaces, and hyphens only — the
 * value lands in inline CSS, PPTX typeface attributes, and DOCX rFonts. */
const RUN_FONT_NAME = /^[a-z0-9][a-z0-9 \-]{0,58}$/i;

export type DeckBullet = { runs: DeckTextRun[]; level: 0 | 1 | 2 };

/** Every text region on a slide — titles, subtitles, captions, quotes, and
 * closing bodies — is a run list, so the formatting controls apply everywhere
 * instead of only inside bullets. Plain strings are still accepted on input
 * (AI replies, older stored decks) and normalized here. */
export type DeckRichText = DeckTextRun[];

export function deckRichText(text: string): DeckRichText {
  return text ? [{ text }] : [];
}

export type DeckImageRef = { src: string; alt: string };

/** Full-bleed background picture for one slide, uploaded by the author. It
 * overrides the theme's brand background on that slide only. Kept for decks
 * saved before backgrounds moved into the shared library; parsing migrates it. */
export type DeckSlideBackground = { dataUrl: string };

/** One background picture is capped well below the deck budget; the editor
 * downscales uploads and the server downscales template designs. */
export const MAX_SLIDE_BACKGROUND_CHARS = 900_000;
export const MAX_BACKGROUND_LIBRARY_ENTRIES = 60;

export type DeckSlideLayout =
  | "title"
  | "title-bullets"
  | "two-column"
  | "image-caption"
  | "quote"
  | "section"
  | "chart"
  | "closing"
  | "statement"
  | "big-number"
  | "image-bullets";

/** A user-adjusted block box in slide coordinates (the 960×540 canvas). */
export type DeckSlideBox = { x: number; y: number; w: number; h: number };

/** Every block role a slide layout can expose; boxes for other keys are
 * dropped on parse so stored geometry can never orphan. */
export const DECK_BOX_REGIONS = [
  "title",
  "subtitle",
  "bullets",
  "left",
  "right",
  "quote",
  "attribution",
  "caption",
  "body",
  "image",
] as const;

export const DECK_BOX_MIN_W = 40;
export const DECK_BOX_MIN_H = 24;

/** What an author can add to a slide beyond its layout's own blocks. */
export type DeckAddedKind = "text" | "list" | "picture";

/** A block the author added to a slide. Its id names its kind ("text-1",
 * "list-2", "picture-1") and serves as its region name everywhere a layout
 * block's name would, so one block can never be two kinds. It always carries
 * its own box: no layout places it. */
export type DeckAddedBlock = { id: string; box: DeckSlideBox } & (
  | { text: DeckRichText }
  | { bullets: DeckBullet[] }
  | { image: DeckImageRef }
);

export const MAX_DECK_ADDED_BLOCKS = 12;
const ADDED_BLOCK_ID = /^(text|list|picture)-[a-z0-9]{1,12}$/;

type DeckSlideBase = {
  id: string;
  notes: string;
  /** Key into `theme.backgroundLibrary`. Slides sharing a design share one
   * stored picture, which is what makes a 12-design brand template fit. */
  backgroundId?: string;
  /** Legacy inline background; migrated into the library on parse. */
  background?: DeckSlideBackground;
  /** Default "#RRGGBB" for this slide's text, overriding the theme roles.
   * Imported slides with dark artwork get light type so the words are
   * readable the moment they land. Individual runs still win. */
  textColor?: string;
  /** User-resized block boxes, keyed by region ("title", "body", "image"…).
   * Absent regions keep the layout's default geometry. */
  boxes?: Record<string, DeckSlideBox>;
  /** Blocks the author deleted from this slide ("title", "image"…), sorted.
   * A deleted block holds no words or picture and is neither drawn nor
   * exported; applying a layout puts every block back. */
  removed?: string[];
  /** Blocks the author added, in the order they were added (later ones draw
   * on top). They belong to the slide, not its layout, and survive a layout
   * change. */
  added?: DeckAddedBlock[];
};

export type DeckSlide = DeckSlideBase &
  (
    | { layout: "title"; title: DeckRichText; subtitle: DeckRichText }
    | { layout: "title-bullets"; title: DeckRichText; bullets: DeckBullet[] }
    | { layout: "two-column"; title: DeckRichText; left: DeckBullet[]; right: DeckBullet[] }
    | { layout: "image-caption"; title: DeckRichText; image: DeckImageRef; caption: DeckRichText }
    | { layout: "quote"; quote: DeckRichText; attribution: DeckRichText }
    | { layout: "section"; title: DeckRichText; subtitle: DeckRichText }
    | { layout: "chart"; title: DeckRichText; mermaidSource: string }
    | { layout: "closing"; title: DeckRichText; body: DeckRichText }
    | { layout: "statement"; title: DeckRichText; body: DeckRichText }
    /** `title` holds the figure itself; `subtitle` says what it measures. */
    | { layout: "big-number"; title: DeckRichText; subtitle: DeckRichText }
    | { layout: "image-bullets"; title: DeckRichText; image: DeckImageRef; bullets: DeckBullet[] }
  );

export type DeckThemeColors = {
  background: string;
  surface: string;
  heading: string;
  body: string;
  accent1: string;
  accent2: string;
};

/** A theme's look beyond its colors: the shapes every layout draws and where
 * its text sits (deckGeometry.ts). "rule" is the original accent-rule look and
 * is stored as no design at all, so decks saved before designs existed keep
 * their exact bytes. */
export const DECK_DESIGNS = ["rule", "band", "split", "editorial", "orbit", "frame", "swiss"] as const;
export type DeckDesign = (typeof DECK_DESIGNS)[number];

export type DeckTheme = {
  colors: DeckThemeColors;
  /** Absent means the classic "rule" design. */
  design?: Exclude<DeckDesign, "rule">;
  fonts: { major: string; minor: string };
  logo: { dataUrl: string; widthPx: number; heightPx: number } | null;
  /** Deck-wide background (cover) shown on every slide without its own. */
  backgroundImage: { dataUrl: string } | null;
  /** Shared store of slide backgrounds, keyed by content hash: an uploaded
   * template's per-layout designs live here once each, and slides reference
   * them by key. */
  backgroundLibrary: Record<string, string>;
  sourceLabel: string | null;
};

export type SlideDeck = {
  schema: typeof DECK_SCHEMA_VERSION;
  title: string;
  theme: DeckTheme;
  slides: DeckSlide[];
};

/** Layouts the editor and exporter fully support today. `chart` exists in
 * the schema for forward compatibility but is not offered until its editor
 * and export paths ship. */
export const SUPPORTED_DECK_LAYOUTS: DeckSlideLayout[] = [
  "title",
  "title-bullets",
  "two-column",
  "image-bullets",
  "image-caption",
  "statement",
  "big-number",
  "section",
  "quote",
  "closing",
];

export const DECK_LAYOUT_LABELS: Record<DeckSlideLayout, string> = {
  title: "Title",
  "title-bullets": "Title + bullets",
  "two-column": "Two columns",
  "image-caption": "Image + caption",
  quote: "Quote",
  section: "Section",
  chart: "Chart",
  closing: "Closing",
  statement: "Statement",
  "big-number": "Big number",
  "image-bullets": "Picture + bullets",
};

/** The design a theme draws with; no stored design is the classic one. */
export function deckThemeDesign(theme: Pick<DeckTheme, "design">): DeckDesign {
  return theme.design ?? "rule";
}

/** Neutral Aperture default theme — real values, matching the app's design
 * tokens, used whenever no brand template is applied. */
export function defaultDeckTheme(): DeckTheme {
  return {
    colors: {
      background: "#ffffff",
      surface: "#eef4f6",
      heading: "#0c1a26",
      body: "#22313f",
      accent1: "#087d8b",
      accent2: "#0aa4b5",
    },
    fonts: { major: "Plus Jakarta Sans", minor: "Plus Jakarta Sans" },
    logo: null,
    backgroundImage: null,
    backgroundLibrary: {},
    sourceLabel: null,
  };
}

/** Stable content hash used as a background library key, so the same picture
 * applied to many slides is stored once and canonical bytes stay identical. */
export function deckBackgroundKey(dataUrl: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < dataUrl.length; index += 1) {
    hash ^= dataUrl.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `bg${hash.toString(16)}-${dataUrl.length.toString(36)}`;
}

/** Adds a picture to the library (deduplicating by content) and returns both
 * the new library and the key the slide should reference. */
export function withDeckBackground(
  theme: DeckTheme,
  dataUrl: string,
): { library: Record<string, string>; key: string } {
  const key = deckBackgroundKey(dataUrl);
  if (theme.backgroundLibrary[key]) return { library: theme.backgroundLibrary, key };
  return { library: { ...theme.backgroundLibrary, [key]: dataUrl }, key };
}

/** Drops library pictures no slide references any more, so deleting or
 * re-theming slides actually reclaims the bytes. */
export function pruneDeckBackgroundLibrary(deck: SlideDeck): SlideDeck {
  const used = new Set(
    deck.slides.map((slide) => slide.backgroundId).filter((id): id is string => Boolean(id)),
  );
  const entries = Object.entries(deck.theme.backgroundLibrary).filter(([key]) => used.has(key));
  if (entries.length === Object.keys(deck.theme.backgroundLibrary).length) return deck;
  return { ...deck, theme: { ...deck.theme, backgroundLibrary: Object.fromEntries(entries) } };
}

let deckIdCounter = 0;

export function nextDeckSlideId(existing?: SlideDeck | null) {
  deckIdCounter += 1;
  const base = `slide-${deckIdCounter}`;
  if (!existing || !existing.slides.some((slide) => slide.id === base)) return base;
  let suffix = 1;
  while (existing.slides.some((slide) => slide.id === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function createDeckSlide(layout: DeckSlideLayout, id: string): DeckSlide {
  const base = { id, notes: "" };
  switch (layout) {
    case "title":
      return { ...base, layout, title: [], subtitle: [] };
    case "title-bullets":
      return { ...base, layout, bullets: [{ runs: [{ text: "" }], level: 0 }], title: [] };
    case "two-column":
      return {
        ...base,
        layout,
        title: [],
        left: [{ runs: [{ text: "" }], level: 0 }],
        right: [{ runs: [{ text: "" }], level: 0 }],
      };
    case "image-caption":
      return { ...base, layout, title: [], image: { src: "", alt: "" }, caption: [] };
    case "quote":
      return { ...base, layout, quote: [], attribution: [] };
    case "section":
      return { ...base, layout, title: [], subtitle: [] };
    case "chart":
      return { ...base, layout, title: [], mermaidSource: "" };
    case "closing":
    case "statement":
      return { ...base, layout, title: [], body: [] };
    case "big-number":
      return { ...base, layout, title: [], subtitle: [] };
    case "image-bullets":
      return {
        ...base,
        layout,
        title: [],
        image: { src: "", alt: "" },
        bullets: [{ runs: [{ text: "" }], level: 0 }],
      };
  }
}

export function blankSlideDeck(title: string): SlideDeck {
  return {
    schema: DECK_SCHEMA_VERSION,
    title,
    theme: defaultDeckTheme(),
    slides: [createDeckSlide("title", nextDeckSlideId())],
  };
}

/* ------------------------------ serialization ------------------------------ */

function sortValueKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValueKeys);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValueKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Canonical serialization: recursively sorted keys so identical decks give
 * identical bytes (stable hashing / CAS comparisons). */
export function serializeSlideDeck(deck: SlideDeck): string {
  return JSON.stringify(sortValueKeys(deck));
}

/** True when two slides hold the same content, whatever order their keys
 * were written in (the DOM reader and the model build runs in different
 * orders, and a false "changed" redraws a text box under the caret). */
export function deckSlidesEqual(a: DeckSlide, b: DeckSlide): boolean {
  return a === b || JSON.stringify(sortValueKeys(a)) === JSON.stringify(sortValueKeys(b));
}

/** Cheap discriminator for stored content strings, confirmed by the caller
 * with parseSlideDeck before use. Canonical sorting places "schema" after
 * "slides", so match the schema tag anywhere in the first chunk. */
export function contentLooksLikeDeck(content: string): boolean {
  const head = content.slice(0, 4000);
  return content.trimStart().startsWith("{") && head.includes(`"${DECK_SCHEMA_VERSION}"`);
}

/* ------------------------------ validation ------------------------------ */

export type ParseSlideDeckResult =
  | { ok: true; deck: SlideDeck; warnings: string[] }
  | { ok: false; error: string };

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, maxChars: number, label: string, errors: string[]): string {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string`);
    return "";
  }
  if (value.length > maxChars) {
    errors.push(`${label} exceeds ${maxChars} characters`);
    return value.slice(0, maxChars);
  }
  return value;
}

function parseRun(value: unknown, label: string, errors: string[]): DeckTextRun | null {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  const run: DeckTextRun = { text: cleanText(value.text, MAX_RUN_TEXT_CHARS, `${label}.text`, errors) };
  for (const flag of ["bold", "italic", "underline", "strike"] as const) {
    const flagValue = value[flag];
    if (flagValue === true) run[flag] = true;
    // Only bold and italic have layout defaults to override, so only those
    // keep an explicit false; the others drop it and stay compact.
    else if (flagValue === false && (flag === "bold" || flag === "italic")) run[flag] = false;
    else if (flagValue !== undefined && flagValue !== false) {
      errors.push(`${label}.${flag} must be a boolean`);
    }
  }
  if (value.color !== undefined) {
    if (typeof value.color === "string" && HEX_COLOR.test(value.color)) {
      run.color = value.color.toLowerCase();
    } else {
      errors.push(`${label}.color must be #RRGGBB`);
    }
  }
  if (value.sizePt !== undefined) {
    const size = Number(value.sizePt);
    if (Number.isFinite(size) && size >= 8 && size <= 96) run.sizePt = Math.round(size);
    else errors.push(`${label}.sizePt must be between 8 and 96`);
  }
  if (value.font !== undefined) {
    const font = typeof value.font === "string" ? value.font.replace(/\s+/g, " ").trim() : "";
    if (RUN_FONT_NAME.test(font)) run.font = font;
    else errors.push(`${label}.font must be a plain font family name`);
  }
  return run;
}

function parseBullets(value: unknown, label: string, errors: string[], warnings: string[]): DeckBullet[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  let items = value;
  if (items.length > MAX_DECK_BULLETS_PER_SLIDE) {
    warnings.push(`${label} truncated to ${MAX_DECK_BULLETS_PER_SLIDE} bullets`);
    items = items.slice(0, MAX_DECK_BULLETS_PER_SLIDE);
  }
  const bullets: DeckBullet[] = [];
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`${label}[${index}] must be an object`);
      return;
    }
    const levelRaw = item.level ?? 0;
    const level = levelRaw === 0 || levelRaw === 1 || levelRaw === 2 ? levelRaw : null;
    if (level === null) {
      errors.push(`${label}[${index}].level must be 0, 1, or 2`);
      return;
    }
    const runsRaw = Array.isArray(item.runs) ? item.runs : null;
    if (!runsRaw) {
      errors.push(`${label}[${index}].runs must be an array`);
      return;
    }
    const runs = runsRaw
      .map((run, runIndex) => parseRun(run, `${label}[${index}].runs[${runIndex}]`, errors))
      .filter((run): run is DeckTextRun => run !== null);
    bullets.push({ runs, level });
  });
  return bullets;
}

function parseImageRef(value: unknown, label: string, errors: string[]): DeckImageRef {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return { src: "", alt: "" };
  }
  const src = typeof value.src === "string" ? value.src.trim() : "";
  if (src && !/^(https:\/\/|data:image\/(png|jpe?g|gif|webp);)/i.test(src)) {
    errors.push(`${label}.src must be https: or a data:image URL`);
    return { src: "", alt: "" };
  }
  return { src, alt: cleanText(value.alt ?? "", 500, `${label}.alt`, errors) };
}

const BACKGROUND_DATA_URL = /^data:image\/(png|jpe?g);/i;

function parseSlideBackground(
  value: unknown,
  label: string,
  errors: string[],
): DeckSlideBackground | null {
  if (value === undefined || value === null) return null;
  if (
    isRecord(value) &&
    typeof value.dataUrl === "string" &&
    BACKGROUND_DATA_URL.test(value.dataUrl) &&
    value.dataUrl.length <= MAX_SLIDE_BACKGROUND_CHARS
  ) {
    return { dataUrl: value.dataUrl };
  }
  errors.push(`${label} must be a bounded data:image/png or jpeg`);
  return null;
}

function parseBackgroundLibrary(value: unknown, errors: string[]): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    errors.push("theme.backgroundLibrary must be an object");
    return {};
  }
  const library: Record<string, string> = {};
  const keys = Object.keys(value);
  if (keys.length > MAX_BACKGROUND_LIBRARY_ENTRIES) {
    errors.push(`theme.backgroundLibrary holds more than ${MAX_BACKGROUND_LIBRARY_ENTRIES} pictures`);
    return {};
  }
  for (const key of keys) {
    const entry = value[key];
    if (!/^[\w-]{1,60}$/.test(key)) {
      errors.push(`theme.backgroundLibrary key "${key.slice(0, 20)}" is not a valid id`);
      continue;
    }
    if (
      typeof entry !== "string" ||
      !BACKGROUND_DATA_URL.test(entry) ||
      entry.length > MAX_SLIDE_BACKGROUND_CHARS
    ) {
      errors.push(`theme.backgroundLibrary.${key} must be a bounded data:image/png or jpeg`);
      continue;
    }
    library[key] = entry;
  }
  return library;
}

/** A stored design must be one the editor can draw; an unknown one (a deck
 * from a newer build) falls back to the classic look rather than failing. */
function parseDesign(value: unknown, warnings: string[]): DeckTheme["design"] {
  if (value === undefined || value === null || value === "rule") return undefined;
  if ((DECK_DESIGNS as readonly unknown[]).includes(value)) return value as DeckTheme["design"];
  warnings.push("theme.design is not a known design; the classic design is used");
  return undefined;
}

function parseTheme(value: unknown, errors: string[], warnings: string[]): DeckTheme {
  const fallback = defaultDeckTheme();
  if (!isRecord(value)) {
    errors.push("theme must be an object");
    return fallback;
  }
  const colorsRaw = isRecord(value.colors) ? value.colors : {};
  const colors = { ...fallback.colors };
  (Object.keys(colors) as Array<keyof DeckThemeColors>).forEach((key) => {
    const candidate = colorsRaw[key];
    if (candidate === undefined) return;
    if (typeof candidate === "string" && HEX_COLOR.test(candidate)) {
      colors[key] = candidate.toLowerCase();
    } else {
      errors.push(`theme.colors.${key} must be #RRGGBB`);
    }
  });
  const fontsRaw = isRecord(value.fonts) ? value.fonts : {};
  const fonts = {
    major: cleanText(fontsRaw.major ?? fallback.fonts.major, 100, "theme.fonts.major", errors),
    minor: cleanText(fontsRaw.minor ?? fallback.fonts.minor, 100, "theme.fonts.minor", errors),
  };
  let logo: DeckTheme["logo"] = null;
  if (value.logo !== undefined && value.logo !== null) {
    if (
      isRecord(value.logo) &&
      typeof value.logo.dataUrl === "string" &&
      /^data:image\/(png|jpe?g);/i.test(value.logo.dataUrl) &&
      value.logo.dataUrl.length <= 700_000 &&
      Number.isFinite(Number(value.logo.widthPx)) &&
      Number.isFinite(Number(value.logo.heightPx))
    ) {
      logo = {
        dataUrl: value.logo.dataUrl,
        widthPx: Math.max(1, Math.round(Number(value.logo.widthPx))),
        heightPx: Math.max(1, Math.round(Number(value.logo.heightPx))),
      };
    } else {
      errors.push("theme.logo must be a bounded data:image/png or jpeg with pixel dimensions");
    }
  }
  let backgroundImage: DeckTheme["backgroundImage"] = null;
  if (value.backgroundImage !== undefined && value.backgroundImage !== null) {
    if (
      isRecord(value.backgroundImage) &&
      typeof value.backgroundImage.dataUrl === "string" &&
      /^data:image\/(png|jpe?g);/i.test(value.backgroundImage.dataUrl) &&
      value.backgroundImage.dataUrl.length <= 1_200_000
    ) {
      backgroundImage = { dataUrl: value.backgroundImage.dataUrl };
    } else {
      errors.push("theme.backgroundImage must be a bounded data:image/png or jpeg");
    }
  }
  const backgroundLibrary = parseBackgroundLibrary(value.backgroundLibrary, errors);
  const sourceLabel =
    typeof value.sourceLabel === "string" && value.sourceLabel.trim()
      ? value.sourceLabel.slice(0, 200)
      : null;
  const design = parseDesign(value.design, warnings);
  return { colors, ...(design ? { design } : {}), fonts, logo, backgroundImage, backgroundLibrary, sourceLabel };
}

/** Accepts either a run list or a plain string (AI output and decks stored
 * before rich regions shipped) and returns validated runs. */
function parseRichText(
  value: unknown,
  maxChars: number,
  label: string,
  errors: string[],
): DeckRichText {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return deckRichText(cleanText(value, maxChars, label, errors));
  if (!Array.isArray(value)) {
    errors.push(`${label} must be text or a list of text runs`);
    return [];
  }
  const runs = value
    .map((run, runIndex) => parseRun(run, `${label}[${runIndex}]`, errors))
    .filter((run): run is DeckTextRun => run !== null)
    .filter((run) => run.text.length > 0);
  const total = runs.reduce((sum, run) => sum + run.text.length, 0);
  if (total > maxChars) {
    errors.push(`${label} exceeds ${maxChars} characters`);
    return runs.slice(0, 1);
  }
  return runs;
}

function parseSlide(
  value: unknown,
  index: number,
  usedIds: Set<string>,
  errors: string[],
  warnings: string[],
): DeckSlide | null {
  const label = `slides[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  const layout = value.layout as DeckSlideLayout;
  if (!Object.prototype.hasOwnProperty.call(DECK_LAYOUT_LABELS, layout)) {
    errors.push(`${label}.layout is not a known slide layout`);
    return null;
  }
  let id = typeof value.id === "string" && /^[\w-]{1,60}$/.test(value.id) ? value.id : `slide-r${index + 1}`;
  while (usedIds.has(id)) id = `${id}-x`;
  usedIds.add(id);
  const notes = cleanText(value.notes ?? "", MAX_NOTES_CHARS, `${label}.notes`, errors);
  const title = () => parseRichText(value.title, MAX_TITLE_CHARS, `${label}.title`, errors);
  switch (layout) {
    case "title":
    case "section":
      return {
        id,
        notes,
        layout,
        title: title(),
        subtitle: parseRichText(value.subtitle, MAX_TITLE_CHARS, `${label}.subtitle`, errors),
      };
    case "title-bullets":
      return { id, notes, layout, title: title(), bullets: parseBullets(value.bullets, `${label}.bullets`, errors, warnings) };
    case "two-column":
      return {
        id,
        notes,
        layout,
        title: title(),
        left: parseBullets(value.left, `${label}.left`, errors, warnings),
        right: parseBullets(value.right, `${label}.right`, errors, warnings),
      };
    case "image-caption":
      return {
        id,
        notes,
        layout,
        title: title(),
        image: parseImageRef(value.image, `${label}.image`, errors),
        caption: parseRichText(value.caption, 500, `${label}.caption`, errors),
      };
    case "quote":
      return {
        id,
        notes,
        layout,
        quote: parseRichText(value.quote, MAX_RUN_TEXT_CHARS, `${label}.quote`, errors),
        attribution: parseRichText(value.attribution, MAX_TITLE_CHARS, `${label}.attribution`, errors),
      };
    case "chart":
      return {
        id,
        notes,
        layout,
        title: title(),
        mermaidSource: cleanText(value.mermaidSource ?? "", 8000, `${label}.mermaidSource`, errors),
      };
    case "closing":
    case "statement":
      return {
        id,
        notes,
        layout,
        title: title(),
        body: parseRichText(value.body, MAX_RUN_TEXT_CHARS, `${label}.body`, errors),
      };
    case "big-number":
      return {
        id,
        notes,
        layout,
        title: title(),
        subtitle: parseRichText(value.subtitle, MAX_TITLE_CHARS, `${label}.subtitle`, errors),
      };
    case "image-bullets":
      return {
        id,
        notes,
        layout,
        title: title(),
        image: parseImageRef(value.image, `${label}.image`, errors),
        bullets: parseBullets(value.bullets, `${label}.bullets`, errors, warnings),
      };
  }
  return null;
}

/** Validates unknown input (parsed JSON or a JSON string) into a SlideDeck.
 * Strict on structure and unsafe values; lenient-with-warnings on trims. */
export function parseSlideDeck(value: unknown): ParseSlideDeckResult {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ok: false, error: "Deck content is not valid JSON." };
    }
  }
  if (!isRecord(candidate)) return { ok: false, error: "Deck must be a JSON object." };
  if (candidate.schema !== DECK_SCHEMA_VERSION) {
    return { ok: false, error: `Deck schema must be "${DECK_SCHEMA_VERSION}".` };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const title = cleanText(candidate.title ?? "", MAX_TITLE_CHARS, "title", errors);
  const theme = parseTheme(candidate.theme ?? defaultDeckTheme(), errors, warnings);
  if (!Array.isArray(candidate.slides)) {
    return { ok: false, error: "Deck slides must be an array." };
  }
  if (candidate.slides.length > MAX_DECK_SLIDES) {
    return { ok: false, error: `Decks are limited to ${MAX_DECK_SLIDES} slides.` };
  }
  const usedIds = new Set<string>();
  // Backgrounds resolve against a shared library. A deck saved with the older
  // inline shape migrates into that library here, so stored decks keep their
  // pictures instead of losing them on load.
  const library: Record<string, string> = { ...theme.backgroundLibrary };
  const slides = candidate.slides
    .map((slide, index) => {
      const parsed = parseSlide(slide, index, usedIds, errors, warnings);
      if (!parsed) return null;
      const raw = isRecord(slide) ? slide : {};
      const withColor = (slide: DeckSlide): DeckSlide => {
        if (raw.textColor === undefined || raw.textColor === null) return withBoxes(slide);
        if (typeof raw.textColor === "string" && HEX_COLOR.test(raw.textColor)) {
          return withBoxes({ ...slide, textColor: raw.textColor.toLowerCase() });
        }
        errors.push(`slides[${index}].textColor must be #RRGGBB`);
        return withBoxes(slide);
      };
      // User-resized block boxes: unknown regions and broken geometry drop
      // with a warning; usable values clamp to the 960×540 slide canvas
      // (deckGeometry's preview dimensions) so a box can never leave it.
      const withBoxes = (slide: DeckSlide): DeckSlide =>
        withAddedBlocks(
          withRemovedBlocks(withBoxOverrides(slide), raw.removed, `slides[${index}].removed`, warnings),
          raw.added,
          `slides[${index}].added`,
          errors,
          warnings,
        );
      const withBoxOverrides = (slide: DeckSlide): DeckSlide => {
        if (raw.boxes === undefined || raw.boxes === null) return slide;
        if (!isRecord(raw.boxes)) {
          warnings.push(`slides[${index}].boxes was not an object and was dropped`);
          return slide;
        }
        const boxes: Record<string, DeckSlideBox> = {};
        for (const [region, value] of Object.entries(raw.boxes)) {
          if (!(DECK_BOX_REGIONS as readonly string[]).includes(region) || !isRecord(value)) {
            warnings.push(`slides[${index}].boxes.${region} is not an adjustable block and was dropped`);
            continue;
          }
          const box = parseSlideBox(value);
          if (!box) {
            warnings.push(`slides[${index}].boxes.${region} had unusable geometry and was dropped`);
            continue;
          }
          boxes[region] = box;
        }
        return Object.keys(boxes).length ? { ...slide, boxes } : slide;
      };
      const inline = parseSlideBackground(raw.background, `slides[${index}].background`, errors);
      if (inline) {
        const key = deckBackgroundKey(inline.dataUrl);
        library[key] = inline.dataUrl;
        return withColor({ ...parsed, backgroundId: key });
      }
      if (raw.backgroundId === undefined || raw.backgroundId === null) return withColor(parsed);
      if (typeof raw.backgroundId !== "string" || !/^[\w-]{1,60}$/.test(raw.backgroundId)) {
        errors.push(`slides[${index}].backgroundId is not a valid background id`);
        return withColor(parsed);
      }
      if (!library[raw.backgroundId]) {
        warnings.push(`slides[${index}] referenced a background that is not in the deck; it was dropped`);
        return withColor(parsed);
      }
      return withColor({ ...parsed, backgroundId: raw.backgroundId });
    })
    .filter((slide): slide is DeckSlide => slide !== null);
  theme.backgroundLibrary = library;
  if (errors.length) {
    return { ok: false, error: errors.slice(0, 6).join("; ") };
  }
  const deck: SlideDeck = { schema: DECK_SCHEMA_VERSION, title, theme, slides };
  const serialized = serializeSlideDeck(deck);
  if (utf8Length(serialized) > MAX_DECK_CONTENT_BYTES) {
    return {
      ok: false,
      error: `Deck exceeds the ${Math.round(MAX_DECK_CONTENT_BYTES / 1_000_000)} MB content limit.`,
    };
  }
  return { ok: true, deck, warnings };
}

/** A block box clamped to the 960×540 slide canvas and the minimum block
 * size, or null when the value holds no usable geometry. */
function parseSlideBox(value: unknown): DeckSlideBox | null {
  if (!isRecord(value)) return null;
  const { x, y, w, h } = value;
  if (![x, y, w, h].every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  const width = Math.round(Math.min(Math.max(w as number, DECK_BOX_MIN_W), 960));
  const height = Math.round(Math.min(Math.max(h as number, DECK_BOX_MIN_H), 540));
  return {
    x: Math.round(Math.min(Math.max(x as number, 0), 960 - width)),
    y: Math.round(Math.min(Math.max(y as number, 0), 540 - height)),
    w: width,
    h: height,
  };
}

/** Reads the blocks an author added to a slide. A block with a bad name, a
 * repeated name, or no usable box is dropped with a warning; its words and
 * picture are checked as strictly as a layout block's. */
function withAddedBlocks(
  slide: DeckSlide,
  value: unknown,
  label: string,
  errors: string[],
  warnings: string[],
): DeckSlide {
  if (value === undefined || value === null) return slide;
  if (!Array.isArray(value)) {
    warnings.push(`${label} was not a list and was dropped`);
    return slide;
  }
  const added: DeckAddedBlock[] = [];
  value.forEach((entry, index) => {
    const frame = addedBlockFrame(entry, added);
    if (!frame) {
      warnings.push(`${label}[${index}] was not a usable added block and was dropped`);
    } else if (added.length === MAX_DECK_ADDED_BLOCKS) {
      warnings.push(`${label} truncated to ${MAX_DECK_ADDED_BLOCKS} blocks`);
    } else {
      added.push(addedBlockContent(frame, `${label}[${index}]`, errors, warnings));
    }
  });
  return added.length ? { ...slide, added } : slide;
}

type AddedBlockFrame = { id: string; kind: DeckAddedKind; box: DeckSlideBox; entry: Record<string, unknown> };

/** An added block's name, kind, and box, or null when the entry has no
 * usable name or box, or repeats a name already taken. */
function addedBlockFrame(entry: unknown, taken: DeckAddedBlock[]): AddedBlockFrame | null {
  if (!isRecord(entry) || typeof entry.id !== "string") return null;
  const { id } = entry;
  const kind = deckAddedKind(id);
  const box = parseSlideBox(entry.box);
  if (!kind || !box || taken.some((block) => block.id === id)) return null;
  return { id, kind, box, entry };
}

/** The block with its words or picture read from the entry, by its kind. */
function addedBlockContent(frame: AddedBlockFrame, at: string, errors: string[], warnings: string[]): DeckAddedBlock {
  const { id, kind, box, entry } = frame;
  if (kind === "text") return { id, box, text: parseRichText(entry.text, MAX_RUN_TEXT_CHARS, `${at}.text`, errors) };
  if (kind === "list") return { id, box, bullets: parseBullets(entry.bullets ?? [], `${at}.bullets`, errors, warnings) };
  return { id, box, image: parseImageRef(entry.image ?? {}, `${at}.image`, errors) };
}

/** Applies a stored list of deleted blocks. Names the layout lacks drop with
 * a warning; a deleted block's words are cleared here, so no stored deck can
 * carry text that is on no slide. */
function withRemovedBlocks(slide: DeckSlide, value: unknown, label: string, warnings: string[]): DeckSlide {
  if (value === undefined || value === null) return slide;
  if (!Array.isArray(value)) {
    warnings.push(`${label} was not a list and was dropped`);
    return slide;
  }
  const blocks = deckSlideBlocks(slide.layout);
  return value.reduce<DeckSlide>((current, region) => {
    if (blocks.includes(region)) return withoutDeckBlock(current, region);
    warnings.push(`${label} named "${String(region).slice(0, 20)}", which this layout does not have; it was dropped`);
    return current;
  }, slide);
}

function utf8Length(value: string) {
  return new TextEncoder().encode(value).length;
}

/* ------------------------------ text helpers ------------------------------ */

/** The picture actually painted behind a slide: the slide's own background
 * when it has one, otherwise the deck-wide brand background. */
export function deckSlideBackgroundSource(slide: DeckSlide, theme: DeckTheme): string | null {
  if (slide.backgroundId) {
    const stored = theme.backgroundLibrary[slide.backgroundId];
    if (stored) return stored;
  }
  return slide.background?.dataUrl ?? theme.backgroundImage?.dataUrl ?? null;
}

/** Each layout's text regions, in reading order. A region is named after
 * the slide field that holds its words, so one table answers "which words
 * live where" for the editor, the export, and the fit check. */
export const DECK_LAYOUT_REGIONS: Record<DeckSlideLayout, readonly string[]> = {
  title: ["title", "subtitle"],
  section: ["title", "subtitle"],
  "big-number": ["title", "subtitle"],
  "title-bullets": ["title", "bullets"],
  "image-bullets": ["title", "bullets"],
  "two-column": ["title", "left", "right"],
  "image-caption": ["title", "caption"],
  quote: ["quote", "attribution"],
  chart: ["title"],
  closing: ["title", "body"],
  statement: ["title", "body"],
};

/** Text content of one region on a slide, or null when the layout has no
 * such region. Bullet regions return their bullets; the rest run lists. */
export function deckSlideRegionContent(slide: DeckSlide, region: string): DeckRichText | DeckBullet[] | null {
  const added = addedBlock(slide, region);
  if (added) return "text" in added ? added.text : "bullets" in added ? added.bullets : null;
  if (!DECK_LAYOUT_REGIONS[slide.layout].includes(region) || deckBlockRemoved(slide, region)) return null;
  return (slide as unknown as Record<string, DeckRichText | DeckBullet[]>)[region];
}

/** The layouts that carry a slide picture. */
export const DECK_PICTURE_LAYOUTS: readonly DeckSlideLayout[] = ["image-caption", "image-bullets"];

/** True for a slide that shows a picture block: its layout has one and the
 * author has not deleted it. */
function holdsPicture(
  slide: DeckSlide,
): slide is Extract<DeckSlide, { layout: "image-caption" | "image-bullets" }> {
  return (slide.layout === "image-caption" || slide.layout === "image-bullets") && !deckBlockRemoved(slide, "image");
}

/** The picture in one of a slide's picture blocks: its layout's ("image",
 * the default) or one the author added. Null when the slide has no such
 * block. */
export function deckSlidePicture(slide: DeckSlide, region = "image"): DeckImageRef | null {
  if (region === "image") return holdsPicture(slide) ? slide.image : null;
  const added = addedBlock(slide, region);
  return added && "image" in added ? added.image : null;
}

/** The slide with one picture block's picture replaced; a slide with no
 * such block comes back unchanged. */
export function withDeckSlidePicture(slide: DeckSlide, image: DeckImageRef, region = "image"): DeckSlide {
  if (region === "image") return holdsPicture(slide) ? { ...slide, image } : slide;
  return deckSlidePicture(slide, region) ? withAddedBlock(slide, region, { image }) : slide;
}

/** Every picture block on a slide, in drawing order: the layout's, then the
 * ones the author added. */
export function deckPictureRegions(slide: DeckSlide): string[] {
  const added = (slide.added ?? []).filter((block) => "image" in block).map((block) => block.id);
  return holdsPicture(slide) ? ["image", ...added] : added;
}

/* ------------------------------ added blocks ------------------------------ */

/** The kind of block an added block's name stands for; null for a layout
 * block's name or anything else. */
export function deckAddedKind(region: string): DeckAddedKind | null {
  return (ADDED_BLOCK_ID.exec(region)?.[1] as DeckAddedKind | undefined) ?? null;
}

function addedBlock(slide: DeckSlide, region: string): DeckAddedBlock | undefined {
  return slide.added?.find((block) => block.id === region);
}

/** The slide with one added block's fields replaced. */
function withAddedBlock(slide: DeckSlide, region: string, fields: Partial<DeckAddedBlock>): DeckSlide {
  const added = (slide.added ?? []).map((block) => (block.id === region ? ({ ...block, ...fields } as DeckAddedBlock) : block));
  return { ...slide, added };
}

/** An empty block of a kind, as it is when the author first adds it. */
function emptyAddedBlock(kind: DeckAddedKind, id: string, box: DeckSlideBox): DeckAddedBlock {
  if (kind === "text") return { id, box, text: [] };
  if (kind === "list") return { id, box, bullets: [{ runs: [{ text: "" }], level: 0 }] };
  return { id, box, image: { src: "", alt: "" } };
}

/** Adds an empty block of a kind at a box and says what it is called. Null
 * when the slide already holds as many added blocks as it may. */
export function withDeckBlockAdded(
  slide: DeckSlide,
  kind: DeckAddedKind,
  box: DeckSlideBox,
): { slide: DeckSlide; region: string } | null {
  const added = slide.added ?? [];
  if (added.length >= MAX_DECK_ADDED_BLOCKS) return null;
  let number = 1;
  while (added.some((block) => block.id === `${kind}-${number}`)) number += 1;
  const region = `${kind}-${number}`;
  return { slide: { ...slide, added: [...added, emptyAddedBlock(kind, region, box)] }, region };
}

/** The slide with the words of one added text box or bullet list replaced. */
export function withDeckAddedContent(slide: DeckSlide, region: string, content: DeckRichText | DeckBullet[]): DeckSlide {
  const kind = addedBlock(slide, region) && deckAddedKind(region);
  if (kind === "text") return withAddedBlock(slide, region, { text: content as DeckRichText });
  if (kind === "list") return withAddedBlock(slide, region, { bullets: content as DeckBullet[] });
  return slide;
}

/** The slide with one block moved or resized: an added block keeps its box
 * itself, a layout block's is kept as an override of the layout's. */
export function withDeckBlockBox(slide: DeckSlide, region: string, box: DeckSlideBox): DeckSlide {
  if (addedBlock(slide, region)) return withAddedBlock(slide, region, { box });
  return { ...slide, boxes: { ...(slide.boxes ?? {}), [region]: box } };
}

/* ----------------------------- deleted blocks ----------------------------- */

/** Every block a layout draws: its text regions, then its picture. */
export function deckSlideBlocks(layout: DeckSlideLayout): string[] {
  return [...DECK_LAYOUT_REGIONS[layout], ...(DECK_PICTURE_LAYOUTS.includes(layout) ? ["image"] : [])];
}

/** True when the author deleted this block from the slide. */
export function deckBlockRemoved(slide: DeckSlide, region: string): boolean {
  return Boolean(slide.removed?.includes(region));
}

/** The slide without one of its blocks. The block's words or picture go with
 * it, so nothing that is off the slide can reach an export or a prompt. A
 * block the layout does not have, or one already deleted, changes nothing. */
export function withoutDeckBlock(slide: DeckSlide, region: string): DeckSlide {
  if (addedBlock(slide, region)) return withoutAddedBlock(slide, region);
  if (!deckSlideBlocks(slide.layout).includes(region)) return slide;
  const removed = [...new Set(slide.removed).add(region)].sort();
  const emptied = region === "image" ? { image: { src: "", alt: "" } } : { [region]: [] };
  return { ...slide, ...emptied, removed } as DeckSlide;
}

/** An added block is simply gone once deleted: no layout brings it back. */
function withoutAddedBlock(slide: DeckSlide, region: string): DeckSlide {
  const { added = [], ...rest } = slide;
  const left = added.filter((block) => block.id !== region);
  return (left.length ? { ...rest, added: left } : rest) as DeckSlide;
}

/** The slide with every deleted block back, empty, as a new slide of its
 * layout has it. A block the author had moved returns to that place. */
export function withDeckBlocksRestored(slide: DeckSlide): DeckSlide {
  if (!slide.removed) return slide;
  const { removed, ...rest } = slide;
  const fresh = createDeckSlide(slide.layout, slide.id) as unknown as Record<string, unknown>;
  return { ...rest, ...Object.fromEntries(removed.map((region) => [region, fresh[region]])) } as DeckSlide;
}

/** True when a region value written by a model carries any words. */
function hasWords(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasWords);
  if (!isRecord(value)) return false;
  return hasWords(value.text) || hasWords(value.runs);
}

/** The deleted blocks a revised slide keeps deleted. A revision never sees
 * which blocks are gone, so one it left empty stays gone, and one it wrote
 * words into comes back with those words. */
export function deckBlocksStillRemoved(kept: DeckSlide, revised: Record<string, unknown>): string[] {
  if (!kept.removed) return [];
  return kept.removed.filter((region) => !hasWords(revised[region]));
}

/** Plain text of a region's content, bullets one per line. */
export function deckRegionPlainText(content: DeckRichText | DeckBullet[] | null | undefined): string {
  if (!content?.length) return "";
  if (isDeckBulletList(content)) return content.map((bullet) => deckRunsText(bullet.runs)).join("\n");
  return deckRunsText(content);
}

/** True when a region holds bullets rather than a flat run list. */
export function isDeckBulletList(content: DeckRichText | DeckBullet[]): content is DeckBullet[] {
  const first: unknown = content[0];
  return Boolean(first) && typeof first === "object" && "runs" in (first as object);
}

/** Splits rich text on authored line breaks, so a two-line quote exports as
 * two paragraphs instead of one run containing a newline. */
export function deckRichTextParagraphs(runs: DeckRichText): DeckRichText[] {
  const paragraphs: DeckRichText[] = [[]];
  runs.forEach((run) => {
    run.text.split("\n").forEach((piece, index) => {
      if (index > 0) paragraphs.push([]);
      if (piece) paragraphs[paragraphs.length - 1].push({ ...run, text: piece });
    });
  });
  return paragraphs.filter((paragraph) => paragraph.length > 0);
}

export function deckRunsText(runs: DeckTextRun[]): string {
  return runs.map((run) => run.text).join("");
}

export function deckSlideTitleText(slide: DeckSlide): string {
  switch (slide.layout) {
    case "quote":
      return deckRunsText(slide.quote).slice(0, 60) || "Quote";
    default:
      return deckRunsText(slide.title);
  }
}

/** Plain-text outline of one slide (used by copy + AI prompts). */
export function deckSlideOutline(slide: DeckSlide): string {
  const lines: string[] = [];
  const push = (value: string) => {
    if (value.trim()) lines.push(value);
  };
  switch (slide.layout) {
    case "title":
    case "section":
    case "big-number":
      push(deckRunsText(slide.title));
      push(deckRunsText(slide.subtitle));
      break;
    case "title-bullets":
      push(deckRunsText(slide.title));
      slide.bullets.forEach((bullet) => push(`${"  ".repeat(bullet.level)}- ${deckRunsText(bullet.runs)}`));
      break;
    case "image-bullets":
      push(deckRunsText(slide.title));
      push(slide.image.alt ? `[Image: ${slide.image.alt}]` : "");
      slide.bullets.forEach((bullet) => push(`${"  ".repeat(bullet.level)}- ${deckRunsText(bullet.runs)}`));
      break;
    case "two-column":
      push(deckRunsText(slide.title));
      slide.left.forEach((bullet) => push(`${"  ".repeat(bullet.level)}- ${deckRunsText(bullet.runs)}`));
      slide.right.forEach((bullet) => push(`${"  ".repeat(bullet.level)}- ${deckRunsText(bullet.runs)}`));
      break;
    case "image-caption":
      push(deckRunsText(slide.title));
      push(slide.image.alt ? `[Image: ${slide.image.alt}]` : "");
      push(deckRunsText(slide.caption));
      break;
    case "quote": {
      const quote = deckRunsText(slide.quote);
      const attribution = deckRunsText(slide.attribution);
      push(quote ? `"${quote}"` : "");
      push(attribution ? `— ${attribution}` : "");
      break;
    }
    case "chart":
      push(deckRunsText(slide.title));
      push(slide.mermaidSource ? "[Chart]" : "");
      break;
    case "closing":
    case "statement":
      push(deckRunsText(slide.title));
      push(deckRunsText(slide.body));
      break;
  }
  (slide.added ?? []).flatMap(addedBlockOutline).forEach(push);
  return lines.join("\n");
}

/** One added block's lines in a slide's outline. */
function addedBlockOutline(block: DeckAddedBlock): string[] {
  if ("text" in block) return [deckRunsText(block.text)];
  if ("bullets" in block) return block.bullets.map((bullet) => `${"  ".repeat(bullet.level)}- ${deckRunsText(bullet.runs)}`);
  return [block.image.alt ? `[Image: ${block.image.alt}]` : ""];
}
