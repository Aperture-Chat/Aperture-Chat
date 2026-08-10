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
  | "closing";

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
  );

export type DeckThemeColors = {
  background: string;
  surface: string;
  heading: string;
  body: string;
  accent1: string;
  accent2: string;
};

export type DeckTheme = {
  colors: DeckThemeColors;
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
  "image-caption",
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
};

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
      return { ...base, layout, title: [], body: [] };
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

function parseTheme(value: unknown, errors: string[]): DeckTheme {
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
  return { colors, fonts, logo, backgroundImage, backgroundLibrary, sourceLabel };
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
      return {
        id,
        notes,
        layout,
        title: title(),
        body: parseRichText(value.body, MAX_RUN_TEXT_CHARS, `${label}.body`, errors),
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
  const theme = parseTheme(candidate.theme ?? defaultDeckTheme(), errors);
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
      const withBoxes = (slide: DeckSlide): DeckSlide => {
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
          const { x, y, w, h } = value as Record<string, unknown>;
          if (![x, y, w, h].every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
            warnings.push(`slides[${index}].boxes.${region} had unusable geometry and was dropped`);
            continue;
          }
          const width = Math.round(Math.min(Math.max(w as number, DECK_BOX_MIN_W), 960));
          const height = Math.round(Math.min(Math.max(h as number, DECK_BOX_MIN_H), 540));
          boxes[region] = {
            x: Math.round(Math.min(Math.max(x as number, 0), 960 - width)),
            y: Math.round(Math.min(Math.max(y as number, 0), 540 - height)),
            w: width,
            h: height,
          };
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
      push(deckRunsText(slide.title));
      push(deckRunsText(slide.subtitle));
      break;
    case "title-bullets":
      push(deckRunsText(slide.title));
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
      push(deckRunsText(slide.title));
      push(deckRunsText(slide.body));
      break;
  }
  return lines.join("\n");
}
