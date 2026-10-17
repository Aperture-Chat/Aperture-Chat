/* Source page setup for documents opened from Word or PDF.
 *
 * An imported document keeps the page it came from: paper size, margins,
 * the default Normal-style text, and its running headers and footers. That
 * setup travels inside the draft HTML as one leading marker element
 *
 *   <div class="document-page-setup" style="width: 612pt; height: 792pt;
 *        padding-top: 72pt; …; margin-top: 36pt; margin-bottom: 36pt;
 *        font-family: …; font-size: 16.2px; line-height: 1.22; color: #000000">
 *     <div class="document-page-header">…blocks…</div>
 *     <div class="document-page-footer">…blocks…</div>
 *   </div>
 *
 * so it survives storage, versions, and history without a schema change.
 * The marker is never shown in the editable flow; the editor sizes its sheets
 * from it and draws the header/footer on every sheet, and the Word export and
 * print rebuild the same page from it.
 *
 * Units: page geometry in the marker is in points (Word's own unit). Every
 * other imported length — font sizes, spacing, indents, widths — is written in
 * preview px, the editor's canvas unit, where 1pt = PREVIEW_PX_PER_PT px. That
 * keeps imported text on the same scale as the toolbar's sizes (12 pt is
 * 17.7px in both) and lets the DOCX export map every value back to exact
 * points. */

export const DOCUMENT_PAGE_SETUP_CLASS = "document-page-setup";
export const DOCUMENT_PAGE_HEADER_CLASS = "document-page-header";
export const DOCUMENT_PAGE_FOOTER_CLASS = "document-page-footer";
export const DOCUMENT_PAGE_HEADER_FIRST_CLASS = "document-page-header-first";
export const DOCUMENT_PAGE_FOOTER_FIRST_CLASS = "document-page-footer-first";
/** Hidden sample paragraph inside the marker carrying the source's Normal
 * paragraph spacing, used for paragraphs added after import. */
export const DOCUMENT_PAGE_NORMAL_CLASS = "document-page-normal";
/** Current page number inside a header/footer; the text is a placeholder. */
export const DOCUMENT_FIELD_PAGE_CLASS = "document-field-page";
/** Total page count inside a header/footer; the text is a placeholder. */
export const DOCUMENT_FIELD_PAGES_CLASS = "document-field-pages";
/** A Word tab rendered as a fixed-width spacer that reaches the tab stop. */
export const DOCUMENT_TAB_CLASS = "document-tab";
/** A literal list number/bullet kept exactly as the source drew it. */
export const DOCUMENT_LIST_MARKER_CLASS = "document-list-marker";
/** Hidden sample paragraphs inside the marker carrying the block styles new
 * content follows: a template's headings and table cells. Samples are
 * paragraphs (class document-page-style-{tag}), never real headings, so the
 * outline and every heading walker ignore them. */
export const DOCUMENT_PAGE_STYLE_CLASS = "document-page-style";
/** Marker classes naming the layout rules a format applies to new content
 * (see documentFormats.ts), e.g. document-format-clauses. */
export const DOCUMENT_FORMAT_FEATURE_PREFIX = "document-format-";
export const DOCUMENT_STYLE_TAGS = ["p", "h1", "h2", "h3", "h4", "td", "th"] as const;
export type DocumentStyleTag = (typeof DOCUMENT_STYLE_TAGS)[number];

/** Must match docxExport's px→pt mapping (728px column = 493.9pt). */
export const PREVIEW_PX_PER_PT = 728 / 493.9;

export function pxFromPt(pt: number) {
  return pt * PREVIEW_PX_PER_PT;
}

export function ptFromPx(px: number) {
  return px / PREVIEW_PX_PER_PT;
}

/** Compact CSS px value with at most two decimals. */
export function cssPx(pt: number) {
  return `${roundTo(pxFromPt(pt), 2)}px`;
}

export function roundTo(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export type DocumentPageSetup = {
  widthPt: number;
  heightPt: number;
  marginTopPt: number;
  marginRightPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  /** Distance from the sheet top to the header's first line. */
  headerDistancePt: number;
  /** Distance from the sheet bottom to the footer's last line. */
  footerDistancePt: number;
  /** Normal-style text the source document uses for unformatted text. */
  fontFamily: string;
  fontSizePx: number;
  /** Unitless multiple of the font size. */
  lineHeight: number;
  color: string;
  /** Normal-style paragraph spacing for paragraphs added after import. */
  paragraphBeforePx: number;
  paragraphAfterPx: number;
  headerHtml: string;
  footerHtml: string;
  /** Present when the source used a different first-page header/footer. */
  firstHeaderHtml: string | null;
  firstFooterHtml: string | null;
  /** Inline CSS each kind of block takes when it is added without its own
   * formatting (AI drafts, revisions). "p" holds declarations beyond the
   * Normal spacing above, such as justification and first-line indent. */
  blockStyles?: Partial<Record<DocumentStyleTag, string>>;
  /** Layout rules of the document's format, e.g. "clauses", "signatures". */
  features?: string[];
};

export const LETTER_PAGE_SETUP: DocumentPageSetup = {
  widthPt: 612,
  heightPt: 792,
  marginTopPt: 72,
  marginRightPt: 72,
  marginBottomPt: 72,
  marginLeftPt: 72,
  headerDistancePt: 36,
  footerDistancePt: 36,
  fontFamily: "Calibri, Carlito, Arial, sans-serif",
  fontSizePx: roundTo(pxFromPt(11), 2),
  lineHeight: 1.22,
  color: "#000000",
  paragraphBeforePx: 0,
  paragraphAfterPx: roundTo(pxFromPt(8), 2),
  headerHtml: "",
  footerHtml: "",
  firstHeaderHtml: null,
  firstFooterHtml: null,
};

export type DocumentSheetGeometry = {
  sheetWidthPx: number;
  sheetHeightPx: number;
  padTopPx: number;
  padRightPx: number;
  padBottomPx: number;
  padLeftPx: number;
  contentWidthPx: number;
  contentHeightPx: number;
  headerTopPx: number;
  footerBottomPx: number;
};

export function documentSheetGeometry(setup: DocumentPageSetup): DocumentSheetGeometry {
  const sheetWidthPx = pxFromPt(setup.widthPt);
  const sheetHeightPx = pxFromPt(setup.heightPt);
  const padTopPx = pxFromPt(setup.marginTopPt);
  const padRightPx = pxFromPt(setup.marginRightPt);
  const padBottomPx = pxFromPt(setup.marginBottomPt);
  const padLeftPx = pxFromPt(setup.marginLeftPt);
  return {
    sheetWidthPx,
    sheetHeightPx,
    padTopPx,
    padRightPx,
    padBottomPx,
    padLeftPx,
    contentWidthPx: Math.max(120, sheetWidthPx - padLeftPx - padRightPx),
    contentHeightPx: Math.max(160, sheetHeightPx - padTopPx - padBottomPx),
    headerTopPx: pxFromPt(setup.headerDistancePt),
    footerBottomPx: pxFromPt(setup.footerDistancePt),
  };
}

/* ------------------------------ fonts ------------------------------ */

/** Single line height of common document fonts as a multiple of the font
 * size (hhea ascent + descent + line gap over units per em), which is what
 * Word's "Single" line spacing means for that font. CSS line-height
 * multiplies the font size instead, so imports convert through this table
 * and the export converts back with the same numbers. */
const FONT_LINE_FACTORS: Record<string, number> = {
  aptos: 1.2,
  arial: 1.15,
  "arial narrow": 1.15,
  "book antiqua": 1.17,
  "bookman old style": 1.17,
  calibri: 1.22,
  "calibri light": 1.22,
  cambria: 1.17,
  candara: 1.22,
  "century gothic": 1.23,
  "century schoolbook": 1.2,
  consolas: 1.17,
  constantia: 1.22,
  corbel: 1.22,
  "courier new": 1.13,
  "franklin gothic book": 1.13,
  garamond: 1.12,
  georgia: 1.14,
  helvetica: 1.15,
  "palatino linotype": 1.33,
  "segoe ui": 1.33,
  tahoma: 1.21,
  "times new roman": 1.15,
  times: 1.15,
  "trebuchet ms": 1.16,
  verdana: 1.22,
};

const DEFAULT_FONT_LINE_FACTOR = 1.17;

export function primaryFontFamily(value: string) {
  return (value.split(",")[0] ?? "").replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

export function fontLineFactor(family: string) {
  return FONT_LINE_FACTORS[primaryFontFamily(family).toLowerCase()] ?? DEFAULT_FONT_LINE_FACTOR;
}

/** Metric-compatible open fonts first, so a machine without the Office font
 * still wraps lines where the source did. */
const FONT_FALLBACKS: Record<string, string> = {
  aptos: "Carlito, Arial, sans-serif",
  arial: "Liberation Sans, Arimo, Helvetica, sans-serif",
  calibri: "Carlito, Arial, sans-serif",
  "calibri light": "Carlito, Arial, sans-serif",
  cambria: "Caladea, Georgia, serif",
  candara: "Carlito, Arial, sans-serif",
  consolas: "Courier New, monospace",
  constantia: "Caladea, Georgia, serif",
  corbel: "Carlito, Arial, sans-serif",
  "courier new": "Liberation Mono, Cousine, monospace",
  courier: "Courier New, monospace",
  garamond: "EB Garamond, Georgia, serif",
  georgia: "serif",
  helvetica: "Arial, sans-serif",
  "times new roman": "Liberation Serif, Tinos, Times, serif",
  times: "Times New Roman, serif",
  verdana: "sans-serif",
  tahoma: "Verdana, sans-serif",
  "segoe ui": "Arial, sans-serif",
};

// "Roman" and "Book" are weight names as often as serif families (Univers 55
// Roman, Franklin Gothic Book), so they do not decide the generic family.
const SERIF_NAME = /(times|serif|georgia|garamond|cambria|antiqua|bookman|palatino|minion|baskerville|caslon|century|bodoni|didot|goudy|janson|sabon|constantia)/i;
const SANS_NAME = /\bsans\b|gothic|grotesk|helvetica|arial|univers/i;
const MONO_NAME = /(mono|courier|consolas|code|typewriter)/i;

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);

/** A family name as CSS: generic keywords bare, simple one-word names bare,
 * anything with spaces or digits single-quoted. */
export function cssFamilyName(name: string) {
  const clean = name.replace(/["'\\;<>]/g, "").replace(/\s+/g, " ").trim();
  if (GENERIC_FAMILIES.has(clean.toLowerCase())) return clean.toLowerCase();
  return /^[a-z][a-z-]*$/i.test(clean) ? clean : `'${clean}'`;
}

/** CSS font-family stack for a source font name: the name first (so the
 * export writes it back verbatim), then metric-compatible fallbacks. Names
 * that cannot be expressed safely collapse to a generic family. The stack
 * stays within the sanitizers' 120-character limit by dropping fallbacks,
 * never by cutting a name. */
export function cssFontFamilyStack(name: string, options: { serif?: boolean; mono?: boolean } = {}) {
  const clean = name.replace(/["'\\;<>]/g, "").replace(/\s+/g, " ").trim();
  const generic = options.mono || MONO_NAME.test(clean)
    ? "monospace"
    : options.serif ?? (SERIF_NAME.test(clean) && !SANS_NAME.test(clean))
      ? "serif"
      : "sans-serif";
  if (!clean || !/^[a-z0-9][a-z0-9 \-]{0,58}$/i.test(clean)) return generic;
  const fallbacks = (FONT_FALLBACKS[clean.toLowerCase()] ?? generic).split(",").map((part) => part.trim());
  const names = [clean, ...fallbacks.filter((part) => part.toLowerCase() !== clean.toLowerCase())];
  if (!GENERIC_FAMILIES.has(names[names.length - 1].toLowerCase())) names.push(generic);
  let stack = names.map(cssFamilyName);
  while (stack.join(", ").length > 118 && stack.length > 2) stack = [...stack.slice(0, -2), stack[stack.length - 1]];
  return stack.join(", ");
}

/* ------------------------------ marker ------------------------------ */

function cssNumber(style: CSSStyleDeclaration | null, property: string, unit: "pt" | "px") {
  const raw = style?.getPropertyValue(property)?.trim() ?? "";
  const match = /^(-?\d+(?:\.\d+)?)(pt|px)$/i.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const sourceUnit = match[2].toLowerCase();
  if (sourceUnit === unit) return value;
  return unit === "pt" ? ptFromPx(value) : pxFromPt(value);
}

function clampPt(value: number | null, fallback: number, min: number, max: number) {
  if (value === null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Reads a marker element back into a page setup. Out-of-range values fall
 * back to Letter so a damaged marker can never produce an unusable sheet. */
export function pageSetupFromElement(element: Element): DocumentPageSetup {
  const style = (element as HTMLElement).style ?? null;
  const widthPt = clampPt(cssNumber(style, "width", "pt"), LETTER_PAGE_SETUP.widthPt, 144, 1728);
  const heightPt = clampPt(cssNumber(style, "height", "pt"), LETTER_PAGE_SETUP.heightPt, 144, 1728);
  const margin = (property: string, fallback: number, limit: number) =>
    clampPt(cssNumber(style, property, "pt"), fallback, 0, limit);
  const marginLeftPt = margin("padding-left", LETTER_PAGE_SETUP.marginLeftPt, widthPt / 2 - 36);
  const marginRightPt = margin("padding-right", LETTER_PAGE_SETUP.marginRightPt, widthPt / 2 - 36);
  const marginTopPt = margin("padding-top", LETTER_PAGE_SETUP.marginTopPt, heightPt / 2 - 36);
  const marginBottomPt = margin("padding-bottom", LETTER_PAGE_SETUP.marginBottomPt, heightPt / 2 - 36);
  const fontSizePx = clampPt(cssNumber(style, "font-size", "px"), LETTER_PAGE_SETUP.fontSizePx, 4, 200);
  const lineHeightRaw = Number.parseFloat(style?.getPropertyValue("line-height") ?? "");
  const child = (className: string) =>
    Array.from(element.children).find((node) => node.classList.contains(className)) ?? null;
  const childHtml = (className: string) => child(className)?.innerHTML ?? null;
  const normal = child(DOCUMENT_PAGE_NORMAL_CLASS) as HTMLElement | null;
  const normalSpacing = (property: string) =>
    clampPt(cssNumber(normal?.style ?? null, property, "px"), 0, 0, 400);
  return {
    widthPt,
    heightPt,
    marginTopPt,
    marginRightPt,
    marginBottomPt,
    marginLeftPt,
    headerDistancePt: margin("margin-top", Math.min(LETTER_PAGE_SETUP.headerDistancePt, marginTopPt), heightPt / 2),
    footerDistancePt: margin("margin-bottom", Math.min(LETTER_PAGE_SETUP.footerDistancePt, marginBottomPt), heightPt / 2),
    fontFamily: style?.getPropertyValue("font-family")?.trim() || LETTER_PAGE_SETUP.fontFamily,
    fontSizePx,
    lineHeight:
      Number.isFinite(lineHeightRaw) && lineHeightRaw > 0.5 && lineHeightRaw < 5
        ? lineHeightRaw
        : LETTER_PAGE_SETUP.lineHeight,
    color: style?.getPropertyValue("color")?.trim() || LETTER_PAGE_SETUP.color,
    paragraphBeforePx: normalSpacing("margin-top"),
    paragraphAfterPx: normalSpacing("margin-bottom"),
    headerHtml: childHtml(DOCUMENT_PAGE_HEADER_CLASS) ?? "",
    footerHtml: childHtml(DOCUMENT_PAGE_FOOTER_CLASS) ?? "",
    firstHeaderHtml: childHtml(DOCUMENT_PAGE_HEADER_FIRST_CLASS),
    firstFooterHtml: childHtml(DOCUMENT_PAGE_FOOTER_FIRST_CLASS),
    blockStyles: markerBlockStyles(element, normal),
    features: Array.from(element.classList)
      .filter((name) => name.startsWith(DOCUMENT_FORMAT_FEATURE_PREFIX))
      .map((name) => name.slice(DOCUMENT_FORMAT_FEATURE_PREFIX.length))
      .filter(Boolean),
  };
}

/** Declarations of an inline style, minus the named properties. */
function styleWithout(style: string, omit: string[]) {
  return style
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.split(":")[0]?.trim().toLowerCase() ?? "";
      return part.includes(":") && !omit.includes(name);
    })
    .join("; ");
}

function markerBlockStyles(element: Element, normal: HTMLElement | null) {
  const styles: Partial<Record<DocumentStyleTag, string>> = {};
  const paragraph = styleWithout(normal?.getAttribute("style") ?? "", ["margin-top", "margin-bottom"]);
  if (paragraph) styles.p = paragraph;
  Array.from(element.children).forEach((child) => {
    if (!child.classList.contains(DOCUMENT_PAGE_STYLE_CLASS)) return;
    const tag = DOCUMENT_STYLE_TAGS.find((name) => child.classList.contains(`${DOCUMENT_PAGE_STYLE_CLASS}-${name}`));
    const style = child.getAttribute("style")?.trim();
    if (tag && tag !== "p" && style) styles[tag] = style;
  });
  return styles;
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function pageSetupMarkerHtml(setup: DocumentPageSetup) {
  const style = [
    `width: ${roundTo(setup.widthPt, 2)}pt`,
    `height: ${roundTo(setup.heightPt, 2)}pt`,
    `padding-top: ${roundTo(setup.marginTopPt, 2)}pt`,
    `padding-right: ${roundTo(setup.marginRightPt, 2)}pt`,
    `padding-bottom: ${roundTo(setup.marginBottomPt, 2)}pt`,
    `padding-left: ${roundTo(setup.marginLeftPt, 2)}pt`,
    `margin-top: ${roundTo(setup.headerDistancePt, 2)}pt`,
    `margin-bottom: ${roundTo(setup.footerDistancePt, 2)}pt`,
    `font-family: ${setup.fontFamily}`,
    `font-size: ${roundTo(setup.fontSizePx, 2)}px`,
    `line-height: ${roundTo(setup.lineHeight, 3)}`,
    `color: ${setup.color}`,
  ].join("; ");
  const blockStyles = setup.blockStyles ?? {};
  const normalStyle = [
    `margin-top: ${roundTo(setup.paragraphBeforePx, 2)}px; margin-bottom: ${roundTo(setup.paragraphAfterPx, 2)}px`,
    blockStyles.p ? styleWithout(blockStyles.p, ["margin-top", "margin-bottom"]) : "",
  ]
    .filter(Boolean)
    .join("; ");
  const samples = DOCUMENT_STYLE_TAGS.filter((tag) => tag !== "p" && blockStyles[tag]?.trim()).map(
    (tag) =>
      `<p class="${DOCUMENT_PAGE_STYLE_CLASS} ${DOCUMENT_PAGE_STYLE_CLASS}-${tag}" style="${escapeAttribute(
        blockStyles[tag] as string,
      )}"><br></p>`,
  );
  const featureClasses = (setup.features ?? [])
    .filter((name) => /^[a-z][a-z0-9-]{0,30}$/.test(name))
    .map((name) => ` ${DOCUMENT_FORMAT_FEATURE_PREFIX}${name}`)
    .join("");
  const parts = [
    `<p class="${DOCUMENT_PAGE_NORMAL_CLASS}" style="${escapeAttribute(normalStyle)}"><br></p>`,
    ...samples,
    setup.headerHtml.trim() ? `<div class="${DOCUMENT_PAGE_HEADER_CLASS}">${setup.headerHtml}</div>` : "",
    setup.footerHtml.trim() ? `<div class="${DOCUMENT_PAGE_FOOTER_CLASS}">${setup.footerHtml}</div>` : "",
    setup.firstHeaderHtml !== null
      ? `<div class="${DOCUMENT_PAGE_HEADER_FIRST_CLASS}">${setup.firstHeaderHtml}</div>`
      : "",
    setup.firstFooterHtml !== null
      ? `<div class="${DOCUMENT_PAGE_FOOTER_FIRST_CLASS}">${setup.firstFooterHtml}</div>`
      : "",
  ].join("");
  return `<div class="${DOCUMENT_PAGE_SETUP_CLASS}${featureClasses}" style="${escapeAttribute(style)}">${parts}</div>`;
}

export function isPageSetupNode(node: Node | null | undefined): node is HTMLElement {
  return (
    !!node &&
    node.nodeType === 1 &&
    (node as Element).classList.contains(DOCUMENT_PAGE_SETUP_CLASS)
  );
}

const MARKER_OPEN = /<div\b[^>]*\bclass=["'][^"']*\bdocument-page-setup\b[^"']*["'][^>]*>/i;

/** Fast check that avoids parsing ordinary drafts. */
export function hasPageSetupMarker(html: string) {
  return MARKER_OPEN.test(html);
}

/** Locates the marker's full extent by counting nested div tags from its
 * opening tag. Text never contains a raw "<div" (it is escaped), so the
 * scan is exact for serialized HTML. */
function locateMarker(html: string): { start: number; end: number } | null {
  const open = MARKER_OPEN.exec(html);
  if (!open) return null;
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = open.index;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return { start: open.index, end: match.index + match[0].length };
  }
  return null;
}

const parsedMarkers = new Map<string, DocumentPageSetup>();

/** Parses marker HTML once; repeated renders of the same draft reuse it. */
export function pageSetupFromMarkerHtml(markerHtml: string): DocumentPageSetup | null {
  if (!markerHtml || typeof document === "undefined") return null;
  const cached = parsedMarkers.get(markerHtml);
  if (cached) return cached;
  const template = document.createElement("template");
  template.innerHTML = markerHtml;
  const element = template.content.firstElementChild;
  if (!element || !isPageSetupNode(element)) return null;
  const setup = pageSetupFromElement(element);
  if (parsedMarkers.size > 16) parsedMarkers.clear();
  parsedMarkers.set(markerHtml, setup);
  return setup;
}

/** The marker HTML at the front of a draft, without parsing the rest. */
export function leadingPageSetupMarker(html: string) {
  const located = locateMarker(html);
  return located ? html.slice(located.start, located.end) : "";
}

/** Splits draft HTML into its page setup (if any) and the remaining body.
 * The first marker wins; any stray copies are dropped so the body never
 * carries a hidden duplicate. */
export function splitPageSetup(html: string): {
  setup: DocumentPageSetup | null;
  markerHtml: string;
  bodyHtml: string;
} {
  const located = locateMarker(html);
  if (!located) return { setup: null, markerHtml: "", bodyHtml: html };
  const markerHtml = html.slice(located.start, located.end);
  let bodyHtml = `${html.slice(0, located.start)}${html.slice(located.end)}`;
  for (let extra = locateMarker(bodyHtml), guard = 0; extra && guard < 8; extra = locateMarker(bodyHtml), guard += 1) {
    bodyHtml = `${bodyHtml.slice(0, extra.start)}${bodyHtml.slice(extra.end)}`;
  }
  return { setup: pageSetupFromMarkerHtml(markerHtml), markerHtml, bodyHtml };
}

/** Puts a marker back in front of a body produced without it. */
export function withPageSetupMarker(markerHtml: string, bodyHtml: string) {
  if (!markerHtml) return bodyHtml;
  return `${markerHtml}${bodyHtml}`;
}

/** CSS custom properties the editor canvas, the pagination host, and print
 * use to draw sheets at the source's page size with its Normal text. */
export function sourceLayoutCssVariables(setup: DocumentPageSetup): Record<string, string> {
  const geometry = documentSheetGeometry(setup);
  return {
    "--source-sheet-width": `${roundTo(geometry.sheetWidthPx, 2)}px`,
    "--source-sheet-height": `${roundTo(geometry.sheetHeightPx, 2)}px`,
    "--source-pad-top": `${roundTo(geometry.padTopPx, 2)}px`,
    "--source-pad-right": `${roundTo(geometry.padRightPx, 2)}px`,
    "--source-pad-bottom": `${roundTo(geometry.padBottomPx, 2)}px`,
    "--source-pad-left": `${roundTo(geometry.padLeftPx, 2)}px`,
    "--source-font-family": setup.fontFamily,
    "--source-font-size": `${roundTo(setup.fontSizePx, 2)}px`,
    "--source-line-height": String(roundTo(setup.lineHeight, 3)),
    "--source-color": setup.color,
    "--source-block-before": `${roundTo(setup.paragraphBeforePx, 2)}px`,
    "--source-block-after": `${roundTo(setup.paragraphAfterPx, 2)}px`,
  };
}

export function cssVariablesText(variables: Record<string, string>) {
  return Object.entries(variables)
    .map(([name, value]) => `${name}: ${value}`)
    .join("; ");
}

/** Fills page-number fields in a header/footer copy for one sheet. */
export function headerFooterHtmlForPage(html: string, pageNumber: number, pageCount: number) {
  if (!html.includes(DOCUMENT_FIELD_PAGE_CLASS)) return html;
  return html
    .replace(
      new RegExp(`(<span[^>]*class="[^"]*\\b${DOCUMENT_FIELD_PAGES_CLASS}\\b[^"]*"[^>]*>)[^<]*(</span>)`, "g"),
      `$1${pageCount}$2`,
    )
    .replace(
      new RegExp(`(<span[^>]*class="[^"]*\\b${DOCUMENT_FIELD_PAGE_CLASS}\\b[^"]*"[^>]*>)[^<]*(</span>)`, "g"),
      `$1${pageNumber}$2`,
    );
}

/** The header/footer a given sheet shows, honoring a distinct first page. */
export function pageChromeHtml(setup: DocumentPageSetup, pageIndex: number) {
  const first = pageIndex === 0;
  return {
    header: first && setup.firstHeaderHtml !== null ? setup.firstHeaderHtml : setup.headerHtml,
    footer: first && setup.firstFooterHtml !== null ? setup.firstFooterHtml : setup.footerHtml,
  };
}
