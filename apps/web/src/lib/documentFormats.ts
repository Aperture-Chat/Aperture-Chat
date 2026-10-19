/* Document formats: the page, type, and block styles a draft is set in.
 *
 * Templates, AI drafts, and plain-English layout requests all end in the same
 * place as a document opened from Word: the page-setup marker
 * (documentPageSetup.ts). A format chooses the paper, margins, typeface, line
 * spacing, paragraph and heading styles, running headers and footers, and the
 * structure rules its genre needs — numbered clauses with hanging indents,
 * signature blocks that stay together, exhibits on their own page, memo
 * headers, screenplay elements. The editor, print, and the Word export all
 * render from that marker and the inline styles written here, so a formatted
 * draft looks the same on screen, on paper, and in Word.
 *
 * Lengths follow the marker contract: page geometry in points, every inline
 * length in preview px (pxFromPt). */

import {
  DOCUMENT_FIELD_PAGE_CLASS,
  DOCUMENT_FIELD_PAGES_CLASS,
  DOCUMENT_LIST_MARKER_CLASS,
  DOCUMENT_STYLE_TAGS,
  DOCUMENT_TAB_CLASS,
  cssFontFamilyStack,
  fontLineFactor,
  primaryFontFamily,
  ptFromPx,
  pxFromPt,
  roundTo,
  type DocumentPageSetup,
  type DocumentStyleTag,
} from "./documentPageSetup";

export type FormatAlign = "left" | "center" | "right" | "justify";

export type BlockFormat = {
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  caps?: boolean;
  align?: FormatAlign;
  beforePt?: number;
  afterPt?: number;
  color?: string;
  fontName?: string;
  /** Single-spaced even in a double-spaced document (court headings). */
  singleSpaced?: boolean;
};

/** A running header or footer line. {page} and {pages} become live fields. */
export type RunningText = {
  left?: string;
  center?: string;
  right?: string;
  sizePt?: number;
  color?: string;
};

export type DocumentFeature = "clauses" | "signatures" | "exhibits" | "memo" | "screenplay" | "academic";

export type DocumentFormat = {
  id: string;
  label: string;
  widthPt: number;
  heightPt: number;
  marginTopPt: number;
  marginRightPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  headerDistancePt: number;
  footerDistancePt: number;
  fontName: string;
  fontSizePt: number;
  color: string;
  /** Word's line spacing multiple: 1 single, 1.5, 2 double. */
  lineSpacing: number;
  /** Exact leading as a multiple of the font size, when the genre fixes it. */
  lineHeightOverride?: number;
  body: { beforePt: number; afterPt: number; align: FormatAlign; indentFirstPt: number };
  headings: Record<"h1" | "h2" | "h3" | "h4", BlockFormat>;
  table: {
    borderPt: number;
    borderColor: string;
    headerFill: string | null;
    headerColor: string | null;
    padPt: number;
  };
  header: RunningText | null;
  footer: RunningText | null;
  /** The first page carries no running header or footer (letters). */
  plainFirstPage: boolean;
  features: DocumentFeature[];
};

const INCH = 72;
const LETTER_SIZE = { widthPt: 612, heightPt: 792 };
const ONE_INCH_MARGINS = {
  marginTopPt: INCH,
  marginRightPt: INCH,
  marginBottomPt: INCH,
  marginLeftPt: INCH,
  headerDistancePt: 36,
  footerDistancePt: 36,
};

/** A commercial agreement as US firms set one: Times New Roman 12, justified
 * text, centered capitalized title and article headings, numbered clauses on
 * hanging indents, and "Page X of Y" so a missing page is obvious. */
const LEGAL_AGREEMENT: DocumentFormat = {
  id: "legal-agreement",
  label: "Legal agreement",
  ...LETTER_SIZE,
  ...ONE_INCH_MARGINS,
  fontName: "Times New Roman",
  fontSizePt: 12,
  color: "#000000",
  lineSpacing: 1,
  body: { beforePt: 0, afterPt: 12, align: "justify", indentFirstPt: 0 },
  headings: {
    h1: { sizePt: 14, bold: true, caps: true, align: "center", beforePt: 0, afterPt: 18 },
    h2: { sizePt: 12, bold: true, caps: true, align: "center", beforePt: 12, afterPt: 12 },
    h3: { sizePt: 12, bold: true, caps: false, align: "left", beforePt: 0, afterPt: 6 },
    h4: { sizePt: 12, bold: true, italic: true, caps: false, align: "left", beforePt: 0, afterPt: 6 },
  },
  table: { borderPt: 0.5, borderColor: "#000000", headerFill: "#F2F2F2", headerColor: null, padPt: 5.4 },
  header: null,
  footer: { center: "Page {page} of {pages}", sizePt: 10 },
  plainFirstPage: false,
  features: ["clauses", "signatures", "exhibits"],
};

/** Correspondence: left-aligned Times New Roman 12 with page numbers from
 * page two, as a letter on letterhead is numbered. */
const LEGAL_LETTER: DocumentFormat = {
  ...LEGAL_AGREEMENT,
  id: "legal-letter",
  label: "Letter",
  body: { beforePt: 0, afterPt: 12, align: "left", indentFirstPt: 0 },
  headings: {
    h1: { sizePt: 12, bold: true, caps: true, align: "center", beforePt: 0, afterPt: 12 },
    h2: { sizePt: 12, bold: true, caps: false, align: "left", beforePt: 0, afterPt: 6 },
    h3: { sizePt: 12, bold: true, italic: true, caps: false, align: "left", beforePt: 0, afterPt: 6 },
    h4: { sizePt: 12, bold: false, italic: true, underline: true, caps: false, align: "left", beforePt: 0, afterPt: 6 },
  },
  footer: { center: "{page}", sizePt: 10 },
  plainFirstPage: true,
  features: ["signatures"],
};

/** An internal memorandum: TO/FROM/DATE/RE block on a tab stop over a rule. */
const LEGAL_MEMO: DocumentFormat = {
  ...LEGAL_AGREEMENT,
  id: "legal-memo",
  label: "Memorandum",
  body: { beforePt: 0, afterPt: 12, align: "left", indentFirstPt: 0 },
  headings: {
    h1: { sizePt: 16, bold: true, caps: true, align: "center", beforePt: 0, afterPt: 18 },
    h2: { sizePt: 12, bold: true, caps: true, align: "left", beforePt: 6, afterPt: 6 },
    h3: { sizePt: 12, bold: true, caps: false, align: "left", beforePt: 0, afterPt: 6 },
    h4: { sizePt: 12, bold: true, italic: true, caps: false, align: "left", beforePt: 0, afterPt: 6 },
  },
  footer: { center: "Page {page} of {pages}", sizePt: 10 },
  features: ["memo"],
};

/** A court filing: double-spaced Times New Roman 12 with indented first
 * lines, single-spaced headings and block quotes, and page numbers centered at
 * the foot. Local rules vary; this is the common default most courts accept. */
const LEGAL_BRIEF: DocumentFormat = {
  ...LEGAL_AGREEMENT,
  id: "legal-brief",
  label: "Court filing",
  lineSpacing: 2,
  body: { beforePt: 0, afterPt: 0, align: "left", indentFirstPt: 36 },
  headings: {
    h1: { sizePt: 12, bold: true, caps: true, align: "center", beforePt: 0, afterPt: 12, singleSpaced: true },
    h2: { sizePt: 12, bold: true, caps: true, align: "center", beforePt: 12, afterPt: 12, singleSpaced: true },
    h3: { sizePt: 12, bold: true, caps: false, align: "left", beforePt: 12, afterPt: 12, singleSpaced: true },
    h4: { sizePt: 12, bold: false, italic: true, underline: true, caps: false, align: "left", beforePt: 0, afterPt: 12, singleSpaced: true },
  },
  footer: { center: "{page}", sizePt: 12 },
  features: ["signatures"],
};

/** A finance or operating report: Calibri 11 at Word's 1.08 spacing, navy
 * headings, shaded table headers, and a confidential footer. */
const BUSINESS_CONFIDENTIAL: DocumentFormat = {
  id: "business-confidential",
  label: "Business report (confidential)",
  ...LETTER_SIZE,
  ...ONE_INCH_MARGINS,
  fontName: "Calibri",
  fontSizePt: 11,
  color: "#000000",
  lineSpacing: 1.08,
  body: { beforePt: 0, afterPt: 8, align: "left", indentFirstPt: 0 },
  headings: {
    h1: { sizePt: 18, bold: true, caps: false, align: "left", beforePt: 0, afterPt: 12, color: "#1F3864" },
    h2: { sizePt: 13, bold: true, caps: false, align: "left", beforePt: 12, afterPt: 4, color: "#1F3864" },
    h3: { sizePt: 11, bold: true, caps: false, align: "left", beforePt: 8, afterPt: 2, color: "#1F3864" },
    h4: { sizePt: 11, bold: true, italic: true, caps: false, align: "left", beforePt: 6, afterPt: 2, color: "#404040" },
  },
  table: { borderPt: 0.5, borderColor: "#A6A6A6", headerFill: "#1F3864", headerColor: "#FFFFFF", padPt: 5.4 },
  header: null,
  footer: { left: "Confidential", right: "Page {page} of {pages}", sizePt: 9, color: "#595959" },
  plainFirstPage: false,
  features: ["memo"],
};

const BUSINESS_REPORT: DocumentFormat = {
  ...BUSINESS_CONFIDENTIAL,
  id: "business-report",
  label: "Business report",
  footer: { right: "Page {page} of {pages}", sizePt: 9, color: "#595959" },
};

/** A paper: Times New Roman 12, double spaced, first lines indented half an
 * inch, page number at the top right (APA 7 student-paper layout). */
const ACADEMIC_PAPER: DocumentFormat = {
  id: "academic-paper",
  label: "Academic paper",
  ...LETTER_SIZE,
  ...ONE_INCH_MARGINS,
  fontName: "Times New Roman",
  fontSizePt: 12,
  color: "#000000",
  lineSpacing: 2,
  body: { beforePt: 0, afterPt: 0, align: "left", indentFirstPt: 36 },
  headings: {
    h1: { sizePt: 12, bold: true, caps: false, align: "center", beforePt: 0, afterPt: 0 },
    h2: { sizePt: 12, bold: true, caps: false, align: "center", beforePt: 0, afterPt: 0 },
    h3: { sizePt: 12, bold: true, caps: false, align: "left", beforePt: 0, afterPt: 0 },
    h4: { sizePt: 12, bold: true, italic: true, caps: false, align: "left", beforePt: 0, afterPt: 0 },
  },
  table: { borderPt: 0.5, borderColor: "#000000", headerFill: null, headerColor: null, padPt: 5.4 },
  header: { right: "{page}", sizePt: 12 },
  footer: null,
  plainFirstPage: false,
  features: ["academic"],
};

/** Screenplay page: Courier 12 at six lines an inch, 1.5" binding margin,
 * elements on the industry's indents, page number "N." from page two. */
const SCREENPLAY: DocumentFormat = {
  id: "screenplay",
  label: "Screenplay",
  ...LETTER_SIZE,
  marginTopPt: INCH,
  marginRightPt: INCH,
  marginBottomPt: INCH,
  marginLeftPt: 1.5 * INCH,
  headerDistancePt: 36,
  footerDistancePt: 36,
  fontName: "Courier New",
  fontSizePt: 12,
  color: "#000000",
  lineSpacing: 1,
  lineHeightOverride: 1,
  body: { beforePt: 0, afterPt: 12, align: "left", indentFirstPt: 0 },
  headings: {
    h1: { sizePt: 12, bold: false, caps: true, underline: true, align: "center", beforePt: 0, afterPt: 24 },
    h2: { sizePt: 12, bold: false, caps: true, align: "left", beforePt: 12, afterPt: 12 },
    h3: { sizePt: 12, bold: false, caps: true, align: "left", beforePt: 0, afterPt: 12 },
    h4: { sizePt: 12, bold: false, caps: true, align: "left", beforePt: 0, afterPt: 12 },
  },
  table: { borderPt: 0.5, borderColor: "#000000", headerFill: null, headerColor: null, padPt: 5.4 },
  header: { right: "{page}.", sizePt: 12 },
  footer: null,
  plainFirstPage: true,
  features: ["screenplay"],
};

/** A neutral business document, the base for plain-English layout requests
 * that name no genre. */
const STANDARD_DOCUMENT: DocumentFormat = {
  ...BUSINESS_REPORT,
  id: "standard",
  label: "Standard document",
  headings: {
    h1: { sizePt: 18, bold: true, caps: false, align: "left", beforePt: 0, afterPt: 12 },
    h2: { sizePt: 14, bold: true, caps: false, align: "left", beforePt: 12, afterPt: 6 },
    h3: { sizePt: 12, bold: true, caps: false, align: "left", beforePt: 8, afterPt: 4 },
    h4: { sizePt: 11, bold: true, italic: true, caps: false, align: "left", beforePt: 6, afterPt: 2 },
  },
  table: { borderPt: 0.5, borderColor: "#808080", headerFill: "#F2F2F2", headerColor: null, padPt: 5.4 },
};

export const DOCUMENT_FORMATS: readonly DocumentFormat[] = [
  LEGAL_AGREEMENT,
  LEGAL_LETTER,
  LEGAL_MEMO,
  LEGAL_BRIEF,
  BUSINESS_CONFIDENTIAL,
  BUSINESS_REPORT,
  ACADEMIC_PAPER,
  SCREENPLAY,
  STANDARD_DOCUMENT,
];

export function documentFormatById(id: string | null | undefined): DocumentFormat | null {
  return DOCUMENT_FORMATS.find((format) => format.id === id) ?? null;
}

/* ------------------------------ helpers ------------------------------ */

export function cssLength(pt: number) {
  return `${roundTo(pxFromPt(pt), 2)}px`;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseStyle(style: string | null | undefined) {
  const map = new Map<string, string>();
  (style ?? "").split(";").forEach((part) => {
    const index = part.indexOf(":");
    if (index < 1) return;
    const name = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (name && value) map.set(name, value);
  });
  return map;
}

function serializeStyle(map: Map<string, string>) {
  return Array.from(map.entries())
    .map(([name, value]) => `${name}: ${value}`)
    .join("; ");
}

function setStyles(element: HTMLElement, declarations: Record<string, string | null>) {
  const map = parseStyle(element.getAttribute("style"));
  Object.entries(declarations).forEach(([name, value]) => {
    if (value === null) map.delete(name);
    else map.set(name, value);
  });
  const style = serializeStyle(map);
  if (style) element.setAttribute("style", style);
  else element.removeAttribute("style");
}

function plainText(element: Element) {
  return (element.textContent ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

type Measurer = (text: string, fontName: string, sizePt: number, bold?: boolean) => number;

/** Text width in points. Canvas metrics in a browser; an average glyph width
 * where there is no canvas (tests), which the editor re-measures anyway. */
function createMeasurer(): Measurer {
  let context: CanvasRenderingContext2D | null = null;
  const isJsdom = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
  if (!isJsdom && typeof document !== "undefined") {
    try {
      context = document.createElement("canvas").getContext("2d");
    } catch {
      context = null;
    }
  }
  return (text, fontName, sizePt, bold = false) => {
    if (!text) return 0;
    if (context) {
      context.font = `${bold ? "bold " : ""}${sizePt}pt ${cssFontFamilyStack(fontName)}`;
      return context.measureText(text).width * 0.75;
    }
    return text.length * sizePt * 0.5;
  };
}

/* ------------------------------ format → page setup ------------------------------ */

function blockCss(format: BlockFormat, bodyFontName: string) {
  const parts: string[] = [];
  if (format.fontName) parts.push(`font-family: ${cssFontFamilyStack(format.fontName)}`);
  if (format.sizePt) parts.push(`font-size: ${cssLength(format.sizePt)}`);
  if (format.bold !== undefined) parts.push(`font-weight: ${format.bold ? "bold" : "normal"}`);
  if (format.italic !== undefined) parts.push(`font-style: ${format.italic ? "italic" : "normal"}`);
  parts.push(`text-decoration: ${format.underline ? "underline" : "none"}`);
  if (format.caps !== undefined) parts.push(`text-transform: ${format.caps ? "uppercase" : "none"}`);
  if (format.align) parts.push(`text-align: ${format.align}`);
  parts.push("text-indent: 0px");
  if (format.beforePt !== undefined) parts.push(`margin-top: ${cssLength(format.beforePt)}`);
  if (format.afterPt !== undefined) parts.push(`margin-bottom: ${cssLength(format.afterPt)}`);
  if (format.color) parts.push(`color: ${format.color}`);
  if (format.singleSpaced) parts.push(`line-height: ${roundTo(fontLineFactor(format.fontName ?? bodyFontName), 3)}`);
  return parts.join("; ");
}

function tableCellCss(table: DocumentFormat["table"], header: boolean) {
  const border = `${roundTo(pxFromPt(table.borderPt), 2)}px solid ${table.borderColor}`;
  const parts = [
    `border: ${border}`,
    `padding: ${cssLength(1)} ${cssLength(table.padPt)}`,
    "vertical-align: top",
  ];
  if (header) {
    parts.push("font-weight: bold");
    if (table.headerFill) parts.push(`background-color: ${table.headerFill}`);
    if (table.headerColor) parts.push(`color: ${table.headerColor}`);
  }
  return parts.join("; ");
}

function runningFieldsHtml(text: string) {
  return escapeHtml(text).replace(/\{(page|pages)\}/g, (_match, kind: string) =>
    kind === "page"
      ? `<span class="${DOCUMENT_FIELD_PAGE_CLASS}">1</span>`
      : `<span class="${DOCUMENT_FIELD_PAGES_CLASS}">1</span>`,
  );
}

/** One running header/footer line. A single part is an aligned paragraph; a
 * line with several parts is a borderless row of cells, which lines up the
 * same on screen, on paper, and in Word without measured tab stops. */
export function runningTextHtml(zone: RunningText, defaults: { sizePt: number }) {
  const slots = (["left", "center", "right"] as const).filter((slot) => zone[slot]?.trim());
  if (!slots.length) return "";
  const run = [
    "margin-top: 0px",
    "margin-bottom: 0px",
    `font-size: ${cssLength(zone.sizePt ?? defaults.sizePt)}`,
    zone.color ? `color: ${zone.color}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  if (slots.length === 1) {
    const slot = slots[0];
    return `<p style="text-align: ${slot}; text-indent: 0px; ${run}">${runningFieldsHtml(zone[slot] as string)}</p>`;
  }
  const cells = (["left", "center", "right"] as const)
    .filter((slot) => slot !== "center" || zone.center?.trim())
    .map(
      (slot) =>
        `<td style="padding: 0px; vertical-align: bottom; text-align: ${slot}"><p style="text-align: ${slot}; text-indent: 0px; ${run}">${runningFieldsHtml(
          zone[slot] ?? "",
        )}</p></td>`,
    );
  return `<table class="document-running-table" style="width: 100%; border-collapse: collapse; table-layout: fixed"><tbody><tr>${cells.join(
    "",
  )}</tr></tbody></table>`;
}

/** The page setup a format produces: geometry and Normal text in the marker,
 * heading and table samples, and the structure rules it applies. */
export function pageSetupForFormat(format: DocumentFormat): DocumentPageSetup {
  const header = format.header ? runningTextHtml(format.header, { sizePt: format.fontSizePt }) : "";
  const footer = format.footer ? runningTextHtml(format.footer, { sizePt: format.fontSizePt }) : "";
  const paragraph = [`text-align: ${format.body.align}`, `text-indent: ${cssLength(format.body.indentFirstPt)}`].join("; ");
  return {
    widthPt: format.widthPt,
    heightPt: format.heightPt,
    marginTopPt: format.marginTopPt,
    marginRightPt: format.marginRightPt,
    marginBottomPt: format.marginBottomPt,
    marginLeftPt: format.marginLeftPt,
    headerDistancePt: format.headerDistancePt,
    footerDistancePt: format.footerDistancePt,
    fontFamily: cssFontFamilyStack(format.fontName),
    fontSizePx: roundTo(pxFromPt(format.fontSizePt), 2),
    lineHeight: roundTo(format.lineHeightOverride ?? fontLineFactor(format.fontName) * format.lineSpacing, 3),
    color: format.color,
    paragraphBeforePx: roundTo(pxFromPt(format.body.beforePt), 2),
    paragraphAfterPx: roundTo(pxFromPt(format.body.afterPt), 2),
    headerHtml: header,
    footerHtml: footer,
    firstHeaderHtml: format.plainFirstPage ? "" : null,
    firstFooterHtml: format.plainFirstPage ? "" : null,
    blockStyles: {
      p: paragraph,
      h1: blockCss(format.headings.h1, format.fontName),
      h2: blockCss(format.headings.h2, format.fontName),
      h3: blockCss(format.headings.h3, format.fontName),
      h4: blockCss(format.headings.h4, format.fontName),
      td: tableCellCss(format.table, false),
      th: tableCellCss(format.table, true),
    },
    features: [...format.features],
  };
}

/** Font size of the setup's Normal text in points. */
export function setupFontSizePt(setup: DocumentPageSetup) {
  return roundTo(ptFromPx(setup.fontSizePx), 1);
}

/** Line spacing multiple (Word's sense) of the setup's Normal text. */
export function setupLineSpacing(setup: DocumentPageSetup) {
  return roundTo(setup.lineHeight / fontLineFactor(setup.fontFamily), 2);
}

/** Short human description of a page setup for status messages. */
export function describePageSetup(setup: DocumentPageSetup) {
  const spacing = setupLineSpacing(setup);
  const spacingLabel =
    Math.abs(spacing - 1) < 0.04 ? "single spacing" : Math.abs(spacing - 2) < 0.05 ? "double spacing" : `${spacing} line spacing`;
  const paper =
    Math.abs(setup.widthPt - 612) < 2 && Math.abs(setup.heightPt - 792) < 2
      ? "Letter"
      : Math.abs(setup.widthPt - 612) < 2 && Math.abs(setup.heightPt - 1008) < 2
        ? "Legal paper"
        : Math.abs(setup.widthPt - 595.3) < 2 && Math.abs(setup.heightPt - 841.9) < 2
          ? "A4"
          : setup.widthPt > setup.heightPt
            ? "landscape"
            : `${roundTo(setup.widthPt / INCH, 2)}" × ${roundTo(setup.heightPt / INCH, 2)}"`;
  const margins = [setup.marginTopPt, setup.marginRightPt, setup.marginBottomPt, setup.marginLeftPt];
  const marginLabel = margins.every((value) => Math.abs(value - margins[0]) < 0.5)
    ? `${roundTo(margins[0] / INCH, 2)}-inch margins`
    : "custom margins";
  return `${primaryFontFamily(setup.fontFamily)} ${setupFontSizePt(setup)} pt, ${spacingLabel}, ${paper}, ${marginLabel}`;
}

/* ------------------------------ body formatting ------------------------------ */

type FormatContext = {
  setup: DocumentPageSetup;
  fontName: string;
  fontSizePt: number;
  contentWidthPt: number;
  measure: Measurer;
};

function formatContext(setup: DocumentPageSetup): FormatContext {
  return {
    setup,
    fontName: primaryFontFamily(setup.fontFamily) || "Times New Roman",
    fontSizePt: ptFromPx(setup.fontSizePx),
    contentWidthPt: Math.max(144, setup.widthPt - setup.marginLeftPt - setup.marginRightPt),
    measure: createMeasurer(),
  };
}

/** Top-level blocks of a body: children of each sheet, or of the root. */
function topLevelBlocks(root: DocumentFragment | HTMLElement): HTMLElement[] {
  const children = Array.from(root.children) as HTMLElement[];
  const sheets = children.filter((child) => child.matches("section.document-page"));
  const containers: Array<DocumentFragment | HTMLElement> = sheets.length ? sheets : [root];
  return containers.flatMap((container) =>
    (Array.from(container.children) as HTMLElement[]).filter(
      (child) =>
        !child.classList.contains("document-page-label") &&
        !child.classList.contains("document-page-setup") &&
        !child.matches("section.document-page"),
    ),
  );
}

const HEADING_TAG = /^H[1-6]$/;

function isHeading(element: Element) {
  return HEADING_TAG.test(element.tagName);
}

/** Splits a paragraph at its line breaks into one paragraph per line group.
 * `startsGroup` decides which lines open a new paragraph; the rest join the
 * paragraph above. Attributes are copied to every piece. */
function splitParagraphLines(paragraph: HTMLElement, startsGroup: (lineText: string, index: number) => boolean) {
  if (paragraph.tagName !== "P" || !paragraph.querySelector(":scope > br")) return [paragraph];
  const lines: Node[][] = [[]];
  Array.from(paragraph.childNodes).forEach((node) => {
    if (node instanceof HTMLElement && node.tagName === "BR") lines.push([]);
    else lines[lines.length - 1].push(node);
  });
  const groups: Node[][][] = [];
  lines.forEach((line, index) => {
    const text = line.map((node) => node.textContent ?? "").join("").replace(/ /g, " ").trim();
    if (!groups.length || (text && startsGroup(text, index))) groups.push([line]);
    else groups[groups.length - 1].push(line);
  });
  if (groups.length < 2) return [paragraph];
  const pieces = groups.map((group) => {
    const piece = paragraph.cloneNode(false) as HTMLElement;
    group.forEach((line, index) => {
      if (index) piece.appendChild(document.createElement("br"));
      line.forEach((node) => piece.appendChild(node));
    });
    return piece;
  });
  paragraph.replaceWith(...pieces);
  return pieces;
}

/** Wraps the paragraph's leading enumerator ("(a)", "1.1") in a literal
 * marker span followed by a tab spacer that reaches the text indent. */
function placeClauseMarker(paragraph: HTMLElement, marker: string, stopPt: number, context: FormatContext) {
  const twips = Math.round(stopPt * 20);
  const tabClass = `${DOCUMENT_TAB_CLASS} document-tab-left document-tab-at-${twips}`;
  const markerPt = context.measure(marker, context.fontName, context.fontSizePt);
  const indentPt = 36;
  const widthPx = roundTo(pxFromPt(Math.max(context.fontSizePt * 0.25, indentPt - markerPt)), 2);
  const existing = paragraph.querySelector<HTMLElement>(`.${DOCUMENT_LIST_MARKER_CLASS}`);
  if (existing) {
    const tab = existing.nextElementSibling;
    if (tab instanceof HTMLElement && tab.classList.contains(DOCUMENT_TAB_CLASS)) {
      tab.className = tabClass;
      setStyles(tab, { display: "inline-block", width: `${widthPx}px` });
    }
    return;
  }
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node && !node.data.replace(/ /g, " ").trim()) node = walker.nextNode() as Text | null;
  if (!node) return;
  const leading = node.data.length - node.data.replace(/^[\s ]+/, "").length;
  if (!node.data.slice(leading).startsWith(marker)) return;
  if (leading) node.data = node.data.slice(leading);
  const rest = node.splitText(marker.length);
  const span = document.createElement("span");
  span.className = DOCUMENT_LIST_MARKER_CLASS;
  node.replaceWith(span);
  span.appendChild(node);
  const tab = document.createElement("span");
  tab.className = tabClass;
  tab.setAttribute("style", `display: inline-block; width: ${widthPx}px`);
  tab.textContent = "\t";
  span.after(tab);
  // The space that followed the enumerator is now the tab.
  let next: Node | null = rest;
  while (next) {
    if (next.nodeType === Node.TEXT_NODE) {
      const text = next as Text;
      const trimmed = text.data.replace(/^[\s ]+/, "");
      if (trimmed !== text.data) text.data = trimmed;
      if (trimmed) break;
      next = text.nextSibling ?? text.parentElement?.nextSibling ?? null;
      continue;
    }
    break;
  }
}

const DECIMAL_CLAUSE = /^(\d{1,2}(?:\.\d{1,2}){1,3}\.?)(?=\s)/;
const PAREN_CLAUSE = /^\(([a-z]{1,5}|[A-Z]{1,5}|\d{1,3})\)(?=\s)/;
const ROMAN_LOWER = /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)$/;
const ROMAN_UPPER = /^(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)$/;
const RECITAL = /^(?:WHEREAS|NOW,?\s+THEREFORE)\b/;
const CENTERED_NOTE =
  /^\[\s*(?:signature pages?\s+follows?|signatures?\s+on\s+(?:the\s+)?following\s+page|remainder\s+of\s+(?:this\s+)?page\s+(?:is\s+)?(?:intentionally\s+)?(?:left\s+)?blank|this\s+page\s+(?:is\s+)?intentionally\s+left\s+blank)[^\]]*\]\.?$/i;

type ClauseFamily = "number" | "lower-alpha" | "lower-roman" | "upper-alpha" | "upper-roman";

function nextLetter(letter: string) {
  return String.fromCharCode(letter.charCodeAt(0) + 1);
}

function clauseFamily(token: string, lastLower: string | null, lastUpper: string | null): ClauseFamily {
  if (/^\d+$/.test(token)) return "number";
  if (token === token.toLowerCase()) {
    const continuesLetters = token.length === 1 && lastLower !== null && nextLetter(lastLower) === token;
    return ROMAN_LOWER.test(token) && !continuesLetters ? "lower-roman" : "lower-alpha";
  }
  const continuesLetters = token.length === 1 && lastUpper !== null && nextLetter(lastUpper) === token;
  return ROMAN_UPPER.test(token) && !continuesLetters ? "upper-roman" : "upper-alpha";
}

const CLAUSE_STEP_PT = 36;

function layoutClause(paragraph: HTMLElement, marker: string, depth: number, context: FormatContext) {
  const level = Math.max(0, Math.min(5, depth));
  const textAt = (level + 1) * CLAUSE_STEP_PT;
  paragraph.classList.add("document-clause");
  setStyles(paragraph, {
    "margin-left": cssLength(textAt),
    "text-indent": `-${cssLength(CLAUSE_STEP_PT)}`,
  });
  placeClauseMarker(paragraph, marker, textAt, context);
}

/** Contract clauses: "1.1" paragraphs hang their number at the margin,
 * "(a)"/"(i)"/"(A)"/"(1)" sub-clauses nest by the order their numbering
 * families appear, each half an inch deeper, so wrapped lines align with the
 * clause text the way an attorney sets them. Recitals indent their first line
 * and bracketed "[Signature page follows]" notes are centered. */
function applyClauseLayout(root: DocumentFragment, context: FormatContext) {
  // A list whose items each carry their own enumerator ("- (a) …") is a run
  // of clauses written as bullets; the bullet would print beside the "(a)".
  topLevelBlocks(root).forEach((block) => {
    if (block.tagName !== "UL" && block.tagName !== "OL") return;
    const items = Array.from(block.children).filter((child) => child.tagName === "LI") as HTMLElement[];
    if (!items.length || items.some((item) => item.querySelector("ul, ol"))) return;
    if (!items.every((item) => PAREN_CLAUSE.test(plainText(item)) || DECIMAL_CLAUSE.test(plainText(item)))) return;
    block.replaceWith(
      ...items.map((item) => {
        const paragraph = document.createElement("p");
        Array.from(item.childNodes).forEach((node) => paragraph.appendChild(node));
        return paragraph;
      }),
    );
  });
  topLevelBlocks(root).forEach((block) => {
    if (block.tagName !== "P") return;
    splitParagraphLines(block, (line, index) => index > 0 && (DECIMAL_CLAUSE.test(line) || PAREN_CLAUSE.test(line)));
  });
  let families: ClauseFamily[] = [];
  let base = 1;
  let lastLower: string | null = null;
  let lastUpper: string | null = null;
  topLevelBlocks(root).forEach((block) => {
    if (isHeading(block)) {
      families = [];
      base = 1;
      lastLower = null;
      lastUpper = null;
      return;
    }
    if (block.tagName !== "P" || block.closest("table")) return;
    const text = plainText(block);
    if (!text) return;
    if (CENTERED_NOTE.test(text)) {
      block.classList.add("document-note");
      setStyles(block, { "text-align": "center", "text-indent": "0px" });
      return;
    }
    if (RECITAL.test(text)) {
      block.classList.add("document-recital");
      setStyles(block, { "text-indent": cssLength(36) });
      return;
    }
    const decimal = DECIMAL_CLAUSE.exec(text);
    if (decimal) {
      const depth = decimal[1].split(".").filter(Boolean).length - 2;
      layoutClause(block, decimal[1], depth, context);
      families = [];
      base = depth + 1;
      lastLower = null;
      lastUpper = null;
      return;
    }
    const paren = PAREN_CLAUSE.exec(text);
    if (!paren) return;
    const token = paren[1];
    const family = clauseFamily(token, lastLower, lastUpper);
    if (family === "lower-alpha") lastLower = token.slice(-1);
    if (family === "upper-alpha") lastUpper = token.slice(-1);
    let index = families.indexOf(family);
    if (index === -1) {
      families.push(family);
      index = families.length - 1;
    } else {
      families = families.slice(0, index + 1);
    }
    layoutClause(block, `(${token})`, base + index, context);
  });
}

const EXHIBIT_TITLE = /^(?:EXHIBIT|SCHEDULE|ANNEX|APPENDIX|ATTACHMENT|ADDENDUM)\s+(?:[A-Z]{1,2}|\d{1,3}|[IVX]{1,5})(?:[-.:\s]|$)/i;

/** Exhibits, schedules, and annexes start on a new page, as they are
 * assembled behind the signature page. */
function applyExhibitBreaks(root: DocumentFragment) {
  const blocks = topLevelBlocks(root);
  blocks.forEach((block, index) => {
    if (!index) return;
    const text = plainText(block);
    // A title line: few words, no closing period, set bold or in capitals.
    // "Exhibit A lists the fees." is a sentence, not a title.
    const shortTitle =
      block.tagName === "P" &&
      text.split(/\s+/).length <= 6 &&
      !/[.;:,]$/.test(text) &&
      (isWhollyBold(block) || text === text.toUpperCase());
    if (!(isHeading(block) || shortTitle) || !EXHIBIT_TITLE.test(text)) return;
    const previous = block.previousElementSibling;
    if (previous?.matches("hr.document-page-break")) return;
    // A title line right after another exhibit title belongs to it.
    if (previous && EXHIBIT_TITLE.test(plainText(previous))) return;
    const pageBreak = document.createElement("hr");
    pageBreak.className = "document-page-break";
    block.before(pageBreak);
  });
}

const SIGNATURE_START =
  /^(?:IN\s+WITNESS\s+WHEREOF|EXECUTED\s+(?:as\s+of|on)|AGREED\s+(?:TO\s+)?AND\s+ACCEPTED|ACCEPTED\s+AND\s+AGREED|ACKNOWLEDGED\s+AND\s+AGREED|AGREED\s+AND\s+ACKNOWLEDGED)/i;
const SIGNATURE_HEADING = /^(?:signatures?|signature\s+page|signature\s+blocks?|execution(?:\s+page)?)$/i;
const SIGNATURE_FIELD =
  /^(?:by|name|printed\s+name|print\s+name|title|its|date|dated|signature|address|e-?mail|witness|attest|notary(?:\s+public)?|phone|telephone)\b[^:]{0,14}:/i;
const SIGNATURE_RULE_CLASS = "document-signature-line";

type SignatureLine = { nodes: Node[]; text: string };
type SignatureParty = { labels: SignatureLine[]; fields: SignatureLine[] };

function blockLines(block: HTMLElement): SignatureLine[] | null {
  if (block.tagName === "P" || HEADING_TAG.test(block.tagName)) {
    const lines: Node[][] = [[]];
    Array.from(block.childNodes).forEach((node) => {
      if (node instanceof HTMLElement && node.tagName === "BR") lines.push([]);
      else lines[lines.length - 1].push(node);
    });
    return lines.map((nodes) => ({
      nodes: nodes.map((node) => node.cloneNode(true)),
      text: nodes.map((node) => node.textContent ?? "").join("").replace(/ /g, " ").trim(),
    }));
  }
  if (block.tagName === "UL" || block.tagName === "OL") {
    return Array.from(block.querySelectorAll(":scope > li")).map((item) => ({
      nodes: Array.from(item.childNodes).map((node) => node.cloneNode(true)),
      text: plainText(item),
    }));
  }
  return null;
}

/** Fill-in rules in any form: the editor's rule span, an imported
 * template's underscore blank, or a rule already aimed at the cell edge. */
const RULE_SELECTOR = `.${SIGNATURE_RULE_CLASS}, .document-blank, .document-signature-rule`;

function hasRule(nodes: Node[]) {
  return nodes.some(
    (node) =>
      node instanceof HTMLElement &&
      (node.matches(RULE_SELECTOR) || !!node.querySelector(RULE_SELECTOR)),
  );
}

function isFieldLine(line: SignatureLine) {
  return SIGNATURE_FIELD.test(line.text) || /_{4,}/.test(line.text) || hasRule(line.nodes);
}

/** A cell's lines, in order: each paragraph's lines, each list item, and
 * any inline runs between them. Null when the cell holds something that is
 * not a line (a nested table), so the cell is left exactly as it is. */
function cellLines(cell: HTMLElement): SignatureLine[] | null {
  const lines: SignatureLine[] = [];
  let inline: Node[] = [];
  const flushInline = () => {
    if (!inline.length) return;
    const holder = document.createElement("p");
    inline.forEach((node) => holder.appendChild(node.cloneNode(true)));
    lines.push(...(blockLines(holder) ?? []));
    inline = [];
  };
  for (const node of Array.from(cell.childNodes)) {
    if (!(node instanceof HTMLElement) || !/^(P|H[1-6]|DIV|UL|OL|TABLE|BLOCKQUOTE|FIGURE|PRE)$/.test(node.tagName)) {
      inline.push(node);
      continue;
    }
    flushInline();
    if (/^(TABLE|FIGURE|PRE)$/.test(node.tagName)) return null;
    const holder = document.createElement(/^(UL|OL)$/.test(node.tagName) ? node.tagName.toLowerCase() : "p");
    Array.from(node.childNodes).forEach((child) => holder.appendChild(child.cloneNode(true)));
    lines.push(...(blockLines(holder as HTMLElement) ?? []));
  }
  flushInline();
  return lines;
}

function groupParties(lines: SignatureLine[]): SignatureParty[] | null {
  const parties: SignatureParty[] = [];
  let current: SignatureParty | null = null;
  const hasImage = (nodes: Node[]) =>
    nodes.some((node) => node instanceof HTMLElement && (node.tagName === "IMG" || !!node.querySelector("img")));
  for (const line of lines) {
    if (!line.text && !hasRule(line.nodes) && !hasImage(line.nodes)) continue;
    if (isFieldLine(line)) {
      if (!current) {
        current = { labels: [], fields: [] };
        parties.push(current);
      }
      current.fields.push(line);
    } else {
      if (!current || current.fields.length) {
        current = { labels: [], fields: [] };
        parties.push(current);
      }
      current.labels.push(line);
    }
  }
  if (!parties.length || parties.length > 8) return null;
  if (parties.some((party) => !party.fields.length)) return null;
  if (!parties.some((party) => party.fields.length >= 2)) return null;
  // Each block needs a line to sign on; a notices block (Address, Attention,
  // Email) after the parties is not a signatory, and a wrong table is worse
  // than none.
  const signs = (line: SignatureLine) =>
    /^(?:by|signature|signed)\b/i.test(line.text) || /_{4,}/.test(line.text) || hasRule(line.nodes);
  if (parties.some((party) => !party.fields.some(signs))) return null;
  return parties;
}

/** Turns the last fill-in rule of a field line into a tab spacer that rules
 * to the cell's right edge, so every "By:" line in a block ends at the same
 * place and exports as an underscore-leader tab stop. */
function ruleToCellEdge(paragraph: HTMLElement, stopPt: number) {
  const rules = Array.from(paragraph.querySelectorAll<HTMLElement>(`.${SIGNATURE_RULE_CLASS}, .document-blank`));
  let rule: Node | null = rules[rules.length - 1] ?? null;
  if (!rule) {
    // Underscore runs the line normalizer did not reach. The text nodes are
    // collected before any is split, so the walk never revisits a split-off
    // run (which would split forever).
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
    for (let index = texts.length - 1; index >= 0 && !rule; index -= 1) {
      const text = texts[index];
      const runs = Array.from(text.data.matchAll(/_{4,}/g));
      const last = runs[runs.length - 1];
      if (!last || last.index === undefined) continue;
      const after = text.splitText(last.index);
      after.splitText(last[0].length);
      rule = after;
    }
  }
  if (!rule) return;
  // Only a rule that ends the line can reach the edge.
  let trailing = "";
  for (let node: Node | null = rule.nextSibling; node; node = node.nextSibling) trailing += node.textContent ?? "";
  if (trailing.replace(/ /g, " ").trim()) return;
  const tab = document.createElement("span");
  tab.className = `${DOCUMENT_TAB_CLASS} document-tab-right document-tab-at-${Math.round(stopPt * 20)} document-signature-rule`;
  tab.setAttribute("style", `display: inline-block; width: ${cssLength(Math.max(36, stopPt * 0.6))}; border-bottom: 0.75px solid currentcolor`);
  tab.textContent = "\t";
  rule.parentNode?.replaceChild(tab, rule);
  const previous = tab.previousSibling;
  if (previous?.nodeType === Node.TEXT_NODE) {
    (previous as Text).data = (previous as Text).data.replace(/[\s ]+$/, " ");
  }
}

function signatureCellHtml(party: SignatureParty | null, cellWidthPt: number, padLeftPt: number, padRightPt: number) {
  const cell = document.createElement("td");
  cell.setAttribute(
    "style",
    `padding: 0px ${cssLength(padRightPt)} 0px ${cssLength(padLeftPt)}; vertical-align: top; border: 0`,
  );
  if (!party) return cell;
  const stopPt = Math.max(72, cellWidthPt - padLeftPt - padRightPt);
  let firstField = true;
  const addLine = (line: SignatureLine, field: boolean) => {
    const paragraph = document.createElement("p");
    line.nodes.forEach((node) => paragraph.appendChild(node));
    const isRuled = field && (/_{4,}/.test(line.text) || !!paragraph.querySelector(RULE_SELECTOR));
    const before = field ? (firstField && isRuled ? 24 : isRuled ? 10 : 4) : 0;
    if (field) firstField = false;
    paragraph.setAttribute(
      "style",
      `margin-top: ${cssLength(before)}; margin-bottom: 0px; text-align: left; text-indent: 0px`,
    );
    paragraph.className = "document-keep-next";
    if (isRuled) ruleToCellEdge(paragraph, stopPt);
    cell.appendChild(paragraph);
  };
  party.labels.forEach((line) => addLine(line, false));
  party.fields.forEach((line) => addLine(line, true));
  cell.lastElementChild?.classList.remove("document-keep-next");
  return cell;
}

function buildSignatureTable(parties: SignatureParty[], context: FormatContext) {
  const columns = 2;
  const gutterPt = 18;
  const columnPt = context.contentWidthPt / columns;
  const table = document.createElement("table");
  table.className = "document-signature-table";
  // Sized to the text column, so a margin change reflows the blocks.
  table.setAttribute(
    "style",
    `width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 0px; margin-bottom: ${cssLength(12)}`,
  );
  const colgroup = document.createElement("colgroup");
  for (let index = 0; index < columns; index += 1) {
    const col = document.createElement("col");
    col.setAttribute("style", `width: ${roundTo(100 / columns, 2)}%`);
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);
  const body = document.createElement("tbody");
  for (let start = 0; start < parties.length; start += columns) {
    const row = document.createElement("tr");
    for (let column = 0; column < columns; column += 1) {
      const party = parties[start + column] ?? null;
      const cell = signatureCellHtml(party, columnPt, column ? gutterPt / 2 : 0, column ? 0 : gutterPt / 2);
      if (start > 0) setStyles(cell, { "padding-top": cssLength(30) });
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
  table.appendChild(body);
  return table;
}

const SIGNATURE_FIELD_ANYWHERE = /\b(?:By|Name|Printed Name|Title|Its|Date|Signature)\s*:/;

function isSignatureTable(table: HTMLTableElement) {
  if (table.classList.contains("document-signature-table")) return true;
  const cells = Array.from(table.querySelectorAll<HTMLElement>("td, th"));
  const fieldCells = cells.filter(
    (cell) =>
      SIGNATURE_FIELD_ANYWHERE.test(cell.textContent ?? "") ||
      /_{4,}/.test(cell.textContent ?? "") ||
      !!cell.querySelector(RULE_SELECTOR),
  );
  return cells.length > 0 && fieldCells.length >= Math.max(1, Math.ceil(cells.length / 3));
}

/** A table the model already built for signatures keeps its cells but loses
 * the data-table chrome, and its rules reach the cell edge. */
function restyleSignatureTable(table: HTMLTableElement, context: FormatContext) {
  // Already laid out (a re-format of a formatted draft): leave it be.
  if (table.classList.contains("document-signature-table")) return;
  table.classList.remove("document-data-table");
  table.classList.add("document-signature-table");
  setStyles(table, {
    width: "100%",
    "border-collapse": "collapse",
    "table-layout": "fixed",
  });
  const columns = Math.max(1, ...Array.from(table.rows).map((row) => row.cells.length));
  const cellWidthPt = context.contentWidthPt / columns;
  table.querySelectorAll<HTMLElement>("th, td").forEach((cell) => {
    cell.setAttribute("style", "padding: 0px 9px 0px 0px; vertical-align: top; border: 0; text-align: left");
    const lines = cellLines(cell);
    if (!lines) return;
    cell.replaceChildren();
    let firstField = true;
    lines.forEach((line) => {
      if (!line.text && !line.nodes.length) return;
      const paragraph = document.createElement("p");
      line.nodes.forEach((node) => paragraph.appendChild(node));
      const field = isFieldLine(line);
      const ruled = field && (/_{4,}/.test(line.text) || !!paragraph.querySelector(RULE_SELECTOR));
      const before = field ? (firstField && ruled ? 24 : ruled ? 10 : 4) : 0;
      if (field) firstField = false;
      paragraph.setAttribute("style", `margin-top: ${cssLength(before)}; margin-bottom: 0px; text-align: left; text-indent: 0px`);
      if (cell.tagName === "TH") setStyles(paragraph, { "font-weight": "bold" });
      if (ruled) ruleToCellEdge(paragraph, Math.max(72, cellWidthPt - 12));
      cell.appendChild(paragraph);
    });
  });
}

/** Points from an inline px length ("13.27px"), or 0. */
function ptFromCss(value: string | undefined) {
  const px = Number.parseFloat(value ?? "");
  return Number.isFinite(px) && /px$/.test(value ?? "") ? ptFromPx(px) : 0;
}

/** Re-aims every signature rule at its cell's right edge for the current
 * text column, so a margin or paper change never pushes a rule past the
 * cell (where it would wrap under its label). */
function refreshSignatureRules(root: DocumentFragment, context: FormatContext) {
  root.querySelectorAll<HTMLTableElement>("table.document-signature-table").forEach((table) => {
    const columns = Math.max(1, ...Array.from(table.rows).map((row) => row.cells.length));
    const cellPt = context.contentWidthPt / columns;
    table.querySelectorAll<HTMLElement>("td, th").forEach((cell) => {
      const style = parseStyle(cell.getAttribute("style"));
      const padding = (style.get("padding") ?? "").split(/\s+/);
      const padRight = ptFromCss(style.get("padding-right") ?? padding[1] ?? padding[0]);
      const padLeft = ptFromCss(style.get("padding-left") ?? padding[3] ?? padding[1] ?? padding[0]);
      const stopTwips = Math.round(Math.max(72, cellPt - padLeft - padRight) * 20);
      cell.querySelectorAll<HTMLElement>(".document-signature-rule").forEach((rule) => {
        rule.className = rule.className.replace(/\bdocument-tab-at-\d+\b/, `document-tab-at-${stopTwips}`);
      });
    });
  });
}

/** Signature blocks after "IN WITNESS WHEREOF" (or a Signatures heading)
 * become a borderless two-column table: each party's name and its By, Name,
 * Title, and Date lines, with rules that end at the same edge. The table never
 * splits across sheets and the lead-in paragraph stays with it. */
function applySignatureBlocks(root: DocumentFragment, context: FormatContext) {
  const blocks = topLevelBlocks(root);
  for (let index = 0; index < blocks.length; index += 1) {
    const start = blocks[index];
    const text = plainText(start);
    const isLeadIn = start.tagName === "P" && SIGNATURE_START.test(text) && text.split(/\s+/).length <= 120;
    const isHeadingStart = isHeading(start) && SIGNATURE_HEADING.test(text);
    if (!isLeadIn && !isHeadingStart) continue;
    if (isLeadIn) start.classList.add("document-keep-next");
    const region: HTMLElement[] = [];
    const lines: SignatureLine[] = [];
    let cursor = index + 1;
    for (; cursor < blocks.length; cursor += 1) {
      const block = blocks[cursor];
      const blockText = plainText(block);
      if (block.tagName === "TABLE") {
        if (isSignatureTable(block as HTMLTableElement)) {
          restyleSignatureTable(block as HTMLTableElement, context);
          cursor += 1;
        }
        break;
      }
      if (block.matches("hr, figure, pre, blockquote") || EXHIBIT_TITLE.test(blockText)) break;
      // A party name the model set as a minor heading is still a label.
      const minorLabel = /^H[3-6]$/.test(block.tagName) && blockText.split(/\s+/).length <= 8;
      if (isHeading(block) && !minorLabel && !SIGNATURE_FIELD.test(blockText)) break;
      if (CENTERED_NOTE.test(blockText)) break;
      const blockLineList = blockLines(block);
      if (!blockLineList) break;
      if (blockLineList.some((line) => line.text.split(/\s+/).length > 25)) break;
      region.push(block);
      lines.push(...blockLineList);
    }
    if (region.length) {
      const parties = groupParties(lines);
      if (parties) {
        const table = buildSignatureTable(parties, context);
        region[0].before(table);
        region.forEach((block) => block.remove());
      }
    }
    index = cursor - 1;
  }
  // A model-built signature table with no lead-in still drops the grid.
  topLevelBlocks(root).forEach((block) => {
    if (block.tagName === "TABLE" && !block.classList.contains("document-signature-table")) {
      const table = block as HTMLTableElement;
      const previous = plainText(table.previousElementSibling ?? document.createElement("p"));
      if (SIGNATURE_START.test(previous) && isSignatureTable(table)) restyleSignatureTable(table, context);
    }
  });
}

const MEMO_FIELD = /^(TO|FROM|CC|BCC|DATE|RE|SUBJECT|MATTER|CLIENT|CLIENT\/MATTER|PRIVILEGE)\s*:\s*/i;

/** The TO / FROM / DATE / RE block of a memorandum: labels in bold capitals,
 * values on a common 1" tab stop, and a rule under the block. */
function applyMemoHeader(root: DocumentFragment, context: FormatContext) {
  const blocks = topLevelBlocks(root);
  const fieldParagraphs: HTMLElement[] = [];
  for (const block of blocks.slice(0, 14)) {
    if (block.tagName === "H2" || block.tagName === "H3") break;
    if (block.tagName !== "P") continue;
    const pieces = splitParagraphLines(block, (line) => MEMO_FIELD.test(line));
    pieces.forEach((piece) => {
      if (MEMO_FIELD.test(plainText(piece))) fieldParagraphs.push(piece);
    });
  }
  if (fieldParagraphs.length < 2) return;
  const stopPt = 72;
  fieldParagraphs.forEach((paragraph, index) => {
    paragraph.classList.add("document-memo-field");
    if (!paragraph.querySelector(`.${DOCUMENT_TAB_CLASS}`)) {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode() as Text | null;
      while (node && !node.data.trim()) node = walker.nextNode() as Text | null;
      const match = node ? MEMO_FIELD.exec(node.data.replace(/^\s+/, "")) : null;
      if (node && match) {
        node.data = node.data.replace(/^\s+/, "");
        const rest = node.splitText(match[0].length);
        // The label keeps the author's text; capitals are a style.
        const label = document.createElement("strong");
        label.setAttribute("style", "text-transform: uppercase");
        label.textContent = `${match[1]}:`;
        node.replaceWith(label);
        const labelPt = context.measure(label.textContent.toUpperCase(), context.fontName, context.fontSizePt, true);
        const tab = document.createElement("span");
        tab.className = `${DOCUMENT_TAB_CLASS} document-tab-left document-tab-at-${stopPt * 20}`;
        tab.setAttribute("style", `display: inline-block; width: ${cssLength(Math.max(6, stopPt - labelPt))}`);
        tab.textContent = "\t";
        label.after(tab);
        rest.data = rest.data.replace(/^\s+/, "");
      }
    }
    const last = index === fieldParagraphs.length - 1;
    setStyles(paragraph, {
      "margin-top": "0px",
      "margin-bottom": last ? cssLength(12) : cssLength(6),
      "margin-left": cssLength(stopPt),
      "text-indent": `-${cssLength(stopPt)}`,
      "text-align": "left",
    });
  });
  // The rule under the block spans the full text column.
  const lastField = fieldParagraphs[fieldParagraphs.length - 1];
  if (!lastField.nextElementSibling?.classList.contains("document-memo-rule")) {
    const rule = document.createElement("hr");
    rule.className = "document-memo-rule";
    lastField.after(rule);
  }
}

type ScreenplayKind = "scene" | "action" | "character" | "parenthetical" | "dialogue" | "transition";

const SCENE_HEADING = /^(?:INT|EXT|INT\.?\/EXT|EXT\.?\/INT|I\/E|EST)[.\s]/i;
const TRANSITION = /^(?:FADE\s+(?:IN|OUT|TO\s+BLACK)|CUT\s+TO|SMASH\s+CUT\s+TO|MATCH\s+CUT\s+TO|JUMP\s+CUT\s+TO|DISSOLVE\s+TO|CUT\s+TO\s+BLACK|[A-Z ]+\s+TO)[.:]?$/;
const CHARACTER_CUE = /^\[?[A-Z][A-Z0-9 .'\-]{0,32}\]?(?:\s*\((?:V\.O\.|O\.S\.|O\.C\.|CONT'D|CONT’D)\))?$/;
const INLINE_DIALOGUE = /^([A-Z][A-Z0-9 .'\-]{0,32}(?:\s*\((?:V\.O\.|O\.S\.|O\.C\.|CONT'D|CONT’D)\))?)\s*:\s+(.+)$/;
const SCREENPLAY_LABEL = /^(?:SCENE|ACTION|CHARACTER|DIALOGUE|PARENTHETICAL|TRANSITION)\s*:\s*/;

function screenplayStyle(kind: ScreenplayKind): Record<string, string> {
  switch (kind) {
    case "scene":
      return { "margin-top": cssLength(12), "margin-bottom": cssLength(12), "text-transform": "uppercase", "text-align": "left" };
    case "character":
      return { "margin-top": "0px", "margin-bottom": "0px", "margin-left": cssLength(2.2 * INCH), "text-transform": "uppercase", "text-align": "left" };
    case "parenthetical":
      return { "margin-top": "0px", "margin-bottom": "0px", "margin-left": cssLength(1.6 * INCH), "margin-right": cssLength(2.4 * INCH), "text-align": "left" };
    case "dialogue":
      return { "margin-top": "0px", "margin-bottom": cssLength(12), "margin-left": cssLength(1 * INCH), "margin-right": cssLength(1.5 * INCH), "text-align": "left" };
    case "transition":
      return { "margin-top": "0px", "margin-bottom": cssLength(12), "text-transform": "uppercase", "text-align": "right" };
    default:
      return { "margin-top": "0px", "margin-bottom": cssLength(12), "text-align": "left" };
  }
}

function screenplayParagraph(kind: ScreenplayKind, nodes: Node[]) {
  const paragraph = document.createElement("p");
  paragraph.className = `document-screenplay document-screenplay-${kind}`;
  nodes.forEach((node) => paragraph.appendChild(node));
  setStyles(paragraph, { ...screenplayStyle(kind), "text-indent": "0px" });
  return paragraph;
}

/** The speech in a "NAME: line" paragraph, with its own formatting, once
 * the cue and colon are taken off the front. */
function dialogueAfterCue(nodes: Node[], cue: string): Node[] {
  const holder = document.createElement("span");
  nodes.forEach((node) => holder.appendChild(node));
  let remaining = cue.length;
  const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining <= 0) {
      const colon = /^\s*:\s*/.exec(node.data);
      if (colon) node.data = node.data.slice(colon[0].length);
      if (node.data.trim()) break;
      continue;
    }
    const lead = node.data.length - node.data.replace(/^[\s\u00a0]+/, "").length;
    const take = Math.min(node.data.length, lead + remaining);
    remaining -= take - lead;
    node.data = node.data.slice(take);
    if (remaining <= 0) {
      const colon = /^\s*:\s*/.exec(node.data);
      if (colon) node.data = node.data.slice(colon[0].length);
      if (node.data.trim()) break;
    }
  }
  return Array.from(holder.childNodes);
}

function stripLeadingLabel(nodes: Node[]) {
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      if (!text.data.trim()) continue;
      text.data = text.data.replace(SCREENPLAY_LABEL, "");
      return;
    }
    if (node instanceof HTMLElement) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const first = walker.nextNode() as Text | null;
      if (first) first.data = first.data.replace(SCREENPLAY_LABEL, "");
      return;
    }
  }
}

/** Screenplay elements from the model's plain lines: scene headings, action,
 * character cues, parentheticals, dialogue, and transitions, each on the
 * industry's indents. "NAME: line" dialogue is split into cue and speech. */
function applyScreenplayLayout(root: DocumentFragment) {
  topLevelBlocks(root).forEach((block) => {
    if (block.tagName !== "P") return;
    if (block.classList.contains("document-screenplay")) {
      const kind = /document-screenplay-(scene|action|character|parenthetical|dialogue|transition)/.exec(block.className)?.[1];
      if (kind) setStyles(block, { ...screenplayStyle(kind as ScreenplayKind), "text-indent": "0px" });
      return;
    }
    const lines: Node[][] = [[]];
    Array.from(block.childNodes).forEach((node) => {
      if (node instanceof HTMLElement && node.tagName === "BR") lines.push([]);
      else lines[lines.length - 1].push(node);
    });
    const output: HTMLElement[] = [];
    let speaking = false;
    lines.forEach((nodes) => {
      stripLeadingLabel(nodes);
      const text = nodes.map((node) => node.textContent ?? "").join("").replace(/ /g, " ").trim();
      if (!text) {
        speaking = false;
        return;
      }
      const inline = INLINE_DIALOGUE.exec(text);
      if (SCENE_HEADING.test(text)) {
        output.push(screenplayParagraph("scene", nodes));
        speaking = false;
      } else if (TRANSITION.test(text) && text === text.toUpperCase()) {
        const transition = screenplayParagraph("transition", nodes);
        if (/^FADE\s+IN/i.test(text)) setStyles(transition, { "text-align": "left" });
        output.push(transition);
        speaking = false;
      } else if (inline && !SCENE_HEADING.test(inline[1]) && inline[1] === inline[1].toUpperCase()) {
        output.push(screenplayParagraph("character", [document.createTextNode(inline[1].trim())]));
        output.push(screenplayParagraph("dialogue", dialogueAfterCue(nodes, inline[1])));
        speaking = false;
      } else if (speaking && /^\(.*\)$/.test(text)) {
        output.push(screenplayParagraph("parenthetical", nodes));
      } else if (speaking) {
        const previous = output[output.length - 1];
        if (previous?.classList.contains("document-screenplay-dialogue")) {
          previous.appendChild(document.createElement("br"));
          nodes.forEach((node) => previous.appendChild(node));
        } else {
          output.push(screenplayParagraph("dialogue", nodes));
        }
      } else if (
        CHARACTER_CUE.test(text) &&
        text === text.toUpperCase() &&
        /[A-Z]/.test(text) &&
        text.split(/\s+/).length <= 5 &&
        (lines.length > 1 || !!block.nextElementSibling)
      ) {
        output.push(screenplayParagraph("character", nodes));
        speaking = true;
      } else {
        output.push(screenplayParagraph("action", nodes));
      }
    });
    if (output.length) block.replaceWith(...output);
  });
  // A cue whose speech arrived as the next paragraph still reads as dialogue.
  topLevelBlocks(root).forEach((block) => {
    const previous = block.previousElementSibling;
    if (
      previous?.classList.contains("document-screenplay-character") &&
      block.classList.contains("document-screenplay-action")
    ) {
      block.className = "document-screenplay document-screenplay-dialogue";
      setStyles(block, screenplayStyle("dialogue"));
    }
  });
}

const REFERENCE_HEADING = /^(?:references|works\s+cited|bibliography|sources|works\s+consulted)$/i;

/** A paper's title block (the short lines under the title) is centered, and
 * each reference hangs half an inch, as APA and MLA both require. */
function applyAcademicLayout(root: DocumentFragment) {
  const blocks = topLevelBlocks(root);
  const titleIndex = blocks.findIndex((block) => block.tagName === "H1");
  if (titleIndex !== -1) {
    for (const block of blocks.slice(titleIndex + 1)) {
      if (block.tagName !== "P") break;
      const text = plainText(block);
      const lines = (block.innerHTML.split(/<br\s*\/?>/i) ?? []).map((line) => line.replace(/<[^>]+>/g, "").trim());
      const titleBlock = lines.length > 0 && lines.every((line) => line.split(/\s+/).length <= 12) && !/[.!?]["”]?$/.test(text);
      if (!titleBlock) break;
      block.classList.add("document-title-block");
      setStyles(block, { "text-align": "center", "text-indent": "0px" });
    }
  }
  let inReferences = false;
  topLevelBlocks(root).forEach((block) => {
    if (isHeading(block)) {
      inReferences = REFERENCE_HEADING.test(plainText(block));
      return;
    }
    if (!inReferences || block.tagName !== "P") return;
    splitParagraphLines(block, (_line, index) => index > 0).forEach((reference) => {
      reference.classList.add("document-reference");
      setStyles(reference, { "margin-left": cssLength(36), "text-indent": `-${cssLength(36)}`, "text-align": "left" });
    });
  });
}

/* ------------------------------ block styles ------------------------------ */

/** Which block properties a restyle may override: "all" for a format applied
 * over existing content, or "tag:property" keys for a plain-English change. */
export type RestyleScope = "all" | Set<string>;

function styleTagFor(element: HTMLElement): DocumentStyleTag | null {
  const tag = element.tagName.toLowerCase();
  if (tag === "h5" || tag === "h6") return "h4";
  return (DOCUMENT_STYLE_TAGS as readonly string[]).includes(tag) ? (tag as DocumentStyleTag) : null;
}

function applySample(element: HTMLElement, tag: DocumentStyleTag, sample: string, restyle: RestyleScope | undefined, skip: Set<string>) {
  const declarations = parseStyle(sample);
  const current = parseStyle(element.getAttribute("style"));
  let changed = false;
  declarations.forEach((value, name) => {
    if (skip.has(name)) return;
    const forced = restyle === "all" || (restyle instanceof Set && restyle.has(`${tag}:${name}`));
    if (current.has(name) && !forced) return;
    if (current.get(name) === value) return;
    current.set(name, value);
    changed = true;
  });
  if (changed) element.setAttribute("style", serializeStyle(current));
}

function isWhollyBold(paragraph: HTMLElement) {
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let sawText = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node.textContent ?? "").trim()) continue;
    sawText = true;
    if (!node.parentElement?.closest("strong, b")) return false;
  }
  return sawText;
}

function paragraphSkips(paragraph: HTMLElement) {
  const skip = new Set<string>();
  if (paragraph.classList.contains("document-clause") || paragraph.classList.contains("document-memo-field")) {
    skip.add("text-indent");
  }
  if (paragraph.classList.contains("document-recital") || paragraph.classList.contains("document-reference")) {
    skip.add("text-indent");
  }
  if (paragraph.classList.contains("document-title-block") || paragraph.classList.contains("document-reference")) {
    skip.add("text-align");
    skip.add("text-indent");
  }
  if (paragraph.classList.contains("document-note") || paragraph.classList.contains("document-memo-field")) {
    skip.add("text-align");
  }
  // A paragraph the author centered or right-aligned keeps that alignment.
  const align = parseStyle(paragraph.getAttribute("style")).get("text-align");
  if (align === "center" || align === "right") {
    skip.add("text-align");
    skip.add("text-indent");
  }
  // A first-line indent marks prose. Dates, address blocks, salutations,
  // closings, and labels (short lines, or lines broken by hand) start flush.
  if (paragraph.querySelector("br") || plainText(paragraph).split(/\s+/).length < 8) skip.add("text-indent");
  // A wholly bold line ("Re: …", a run-in label) is a label, not prose.
  if (isWhollyBold(paragraph)) skip.add("text-indent");
  // Hanging layouts drawn with a literal marker or tab keep their indent.
  if (paragraph.querySelector(`.${DOCUMENT_LIST_MARKER_CLASS}, .${DOCUMENT_TAB_CLASS}`)) skip.add("text-indent");
  // Fill-in lines are not body prose.
  if (paragraph.querySelector(RULE_SELECTOR)) {
    skip.add("text-indent");
    skip.add("text-align");
  }
  return skip;
}

function applyBlockStyles(root: DocumentFragment, setup: DocumentPageSetup, restyle: RestyleScope | undefined) {
  const styles = setup.blockStyles ?? {};
  const normalMargins = `margin-top: ${roundTo(setup.paragraphBeforePx, 2)}px; margin-bottom: ${roundTo(setup.paragraphAfterPx, 2)}px`;
  const forceMargins =
    restyle === "all" || (restyle instanceof Set && (restyle.has("p:margin-top") || restyle.has("p:margin-bottom")));
  topLevelBlocks(root).forEach((block) => {
    if (block.classList.contains("document-screenplay")) return;
    const tag = styleTagFor(block);
    if (tag === "p") {
      const skip = paragraphSkips(block);
      const sample = [styles.p ?? "", forceMargins && parseStyle(block.getAttribute("style")).has("margin-bottom") ? normalMargins : ""]
        .filter(Boolean)
        .join("; ");
      if (sample) applySample(block, "p", sample, restyle, skip);
      return;
    }
    if (tag && tag !== "td" && tag !== "th") {
      const sample = styles[tag];
      if (sample) applySample(block, tag, sample, restyle, new Set());
      return;
    }
    if (block.tagName === "BLOCKQUOTE") {
      const single = roundTo(fontLineFactor(setup.fontFamily), 3);
      const quote = [
        `margin-left: ${cssLength(36)}`,
        `margin-right: ${cssLength(36)}`,
        setup.lineHeight > single * 1.3 ? `line-height: ${single}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      applySample(block, "p", quote, restyle === "all" ? "all" : undefined, new Set());
      return;
    }
    if (block.tagName === "TABLE" && !block.classList.contains("document-signature-table") && !block.classList.contains("document-running-table")) {
      const table = block as HTMLTableElement;
      const current = parseStyle(table.getAttribute("style"));
      if (!current.has("width") || restyle === "all") current.set("width", "100%");
      current.set("border-collapse", "collapse");
      table.setAttribute("style", serializeStyle(current));
      table.querySelectorAll<HTMLElement>("td, th").forEach((cell) => {
        const cellTag = cell.tagName === "TH" ? "th" : "td";
        const sample = styles[cellTag];
        if (sample) applySample(cell, cellTag, sample, restyle, new Set());
      });
    }
  });
}

/** Removes the source document's own typography so a format applied over it
 * takes effect: fonts, sizes, and line spacing on every element; spacing on
 * blocks. Indents, colors, emphasis, and alignment of centered text stay. */
function stripSourceTypography(root: DocumentFragment) {
  root.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    if (element.closest("pre, code, .document-page-setup, .document-signature-table")) return;
    if (element.classList.contains(DOCUMENT_TAB_CLASS)) return;
    const block = /^(P|H[1-6]|LI|BLOCKQUOTE)$/.test(element.tagName);
    // A heading takes the new format's heading style whole.
    const heading = /^H[1-6]$/.test(element.tagName);
    setStyles(element, {
      "font-family": null,
      "font-size": null,
      "line-height": null,
      ...(block ? { "margin-top": null, "margin-bottom": null } : {}),
      ...(heading
        ? {
            "text-align": null,
            "text-transform": null,
            "font-weight": null,
            "font-style": null,
            "text-decoration": null,
            "text-indent": null,
            color: null,
          }
        : {}),
    });
  });
}

export type FormatBodyOptions = {
  /** Override formatting the content already has (see RestyleScope). Without
   * it, only blocks that lack a property receive the format's. */
  restyle?: RestyleScope;
  /** Run the format's structure rules (on by default). */
  structure?: boolean;
};

/** Sets body HTML (no marker) in a page setup's formats: structure rules for
 * its genre, then each block's style. Returns the body HTML. */
export function formatDocumentBody(bodyHtml: string, setup: DocumentPageSetup, options: FormatBodyOptions = {}) {
  if (typeof document === "undefined" || !bodyHtml.trim()) return bodyHtml;
  const template = document.createElement("template");
  template.innerHTML = bodyHtml;
  const root = template.content;
  const features = new Set(setup.features ?? []);
  const context = formatContext(setup);
  if (options.restyle === "all") stripSourceTypography(root);
  refreshSignatureRules(root, context);
  if (options.structure !== false) {
    if (features.has("screenplay")) applyScreenplayLayout(root);
    if (features.has("memo")) applyMemoHeader(root, context);
    if (features.has("clauses")) applyClauseLayout(root, context);
    if (features.has("signatures")) applySignatureBlocks(root, context);
    if (features.has("exhibits")) applyExhibitBreaks(root);
    if (features.has("academic")) applyAcademicLayout(root);
  }
  refreshSignatureRules(root, context);
  applyBlockStyles(root, setup, options.restyle);
  return template.innerHTML;
}

/** The most common inline style of each block kind in a body, as samples for
 * content added to a document that carries no samples of its own (a file
 * opened from Word or PDF). Only block-level declarations are kept. */
export function inferBlockStyles(bodyHtml: string): Partial<Record<DocumentStyleTag, string>> {
  if (typeof document === "undefined" || !bodyHtml.trim()) return {};
  const template = document.createElement("template");
  template.innerHTML = bodyHtml;
  const keep = new Set([
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-transform",
    "text-align",
    "text-indent",
    "line-height",
    "margin-top",
    "margin-bottom",
    "color",
  ]);
  const counts = new Map<DocumentStyleTag, Map<string, number>>();
  topLevelBlocks(template.content).forEach((block) => {
    const tag = styleTagFor(block);
    if (!tag || tag === "td" || tag === "th") return;
    if (block.classList.contains("document-clause") || block.querySelector(`.${DOCUMENT_TAB_CLASS}`)) return;
    if (!plainText(block)) return;
    const style = serializeStyle(
      new Map(Array.from(parseStyle(block.getAttribute("style")).entries()).filter(([name]) => keep.has(name))),
    );
    if (!style) return;
    const tally = counts.get(tag) ?? new Map<string, number>();
    tally.set(style, (tally.get(style) ?? 0) + 1);
    counts.set(tag, tally);
  });
  const styles: Partial<Record<DocumentStyleTag, string>> = {};
  // Table cells: the header row and a body row of the first real table.
  const cellKeep = new Set([
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "background-color",
    "color",
    "font-weight",
    "vertical-align",
  ]);
  const cellStyle = (cell: Element | null | undefined) => {
    if (!cell) return "";
    const style = new Map(Array.from(parseStyle(cell.getAttribute("style")).entries()).filter(([name]) => cellKeep.has(name)));
    // Word often colors a header row's words rather than its cells (white on
    // a dark fill); the words' color and weight belong to the cell sample.
    Array.from(cell.querySelectorAll<HTMLElement>("[style]")).some((run) => {
      const runStyle = parseStyle(run.getAttribute("style"));
      if (!style.has("color") && runStyle.get("color")) style.set("color", runStyle.get("color") as string);
      if (!style.has("font-weight") && /^(bold|[6-9]00)$/.test(runStyle.get("font-weight") ?? "")) {
        style.set("font-weight", "bold");
      }
      return style.has("color");
    });
    if (!style.has("font-weight") && cell.querySelector("strong, b")) style.set("font-weight", "bold");
    return serializeStyle(style);
  };
  const table = Array.from(template.content.querySelectorAll("table")).find(
    (candidate) => candidate.rows.length >= 2 && !candidate.closest(".document-page-setup"),
  );
  if (table) {
    const header = cellStyle(table.rows[0]?.cells[0]);
    const body = cellStyle(table.rows[1]?.cells[0]);
    if (header) styles.th = header;
    if (body) styles.td = body;
  }
  counts.forEach((tally, tag) => {
    const [best] = Array.from(tally.entries()).sort((a, b) => b[1] - a[1]);
    if (best) styles[tag] = best[0];
  });
  // Paragraph spacing of a source paragraph sample is the Normal spacing the
  // marker already records; only its other declarations are a sample.
  if (styles.p) {
    const paragraph = parseStyle(styles.p);
    paragraph.delete("margin-top");
    paragraph.delete("margin-bottom");
    styles.p = serializeStyle(paragraph);
    if (!styles.p) delete styles.p;
  }
  return styles;
}

/** Restyle keys for the difference between two setups: every sample
 * declaration that changed, plus Normal spacing changes. */
export function restyleScopeBetween(before: DocumentPageSetup, after: DocumentPageSetup): Set<string> {
  const scope = new Set<string>();
  DOCUMENT_STYLE_TAGS.forEach((tag) => {
    const previous = parseStyle(before.blockStyles?.[tag]);
    const next = parseStyle(after.blockStyles?.[tag]);
    next.forEach((value, name) => {
      if (previous.get(name) !== value) scope.add(`${tag}:${name}`);
    });
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") {
      previous.forEach((_value, name) => {
        if (!next.has(name)) scope.add(`${tag}:${name}`);
      });
    }
  });
  if (Math.abs(before.paragraphBeforePx - after.paragraphBeforePx) > 0.05) scope.add("p:margin-top");
  if (Math.abs(before.paragraphAfterPx - after.paragraphAfterPx) > 0.05) scope.add("p:margin-bottom");
  return scope;
}

/** Applies Normal-text changes the marker alone cannot carry to content that
 * has its own inline typography (documents opened from Word or PDF): a new
 * typeface replaces every inline face, a new size replaces inline sizes that
 * matched the old Normal size, and a new line spacing replaces inline line
 * spacing. Returns the body HTML. */
export function applyNormalTextChange(bodyHtml: string, before: DocumentPageSetup, after: DocumentPageSetup) {
  if (typeof document === "undefined") return bodyHtml;
  const fontChanged = primaryFontFamily(before.fontFamily) !== primaryFontFamily(after.fontFamily);
  const sizeChanged = Math.abs(before.fontSizePx - after.fontSizePx) > 0.05;
  const spacingChanged = Math.abs(before.lineHeight - after.lineHeight) > 0.001;
  if (!fontChanged && !sizeChanged && !spacingChanged) return bodyHtml;
  const template = document.createElement("template");
  template.innerHTML = bodyHtml;
  template.content.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    if (element.closest("pre, code")) return;
    const style = parseStyle(element.getAttribute("style"));
    const updates: Record<string, string | null> = {};
    if (fontChanged && style.has("font-family") && !/mono|courier|consolas/i.test(style.get("font-family") ?? "")) {
      updates["font-family"] = null;
    }
    if (sizeChanged && style.has("font-size")) {
      const sizePx = Number.parseFloat(style.get("font-size") ?? "");
      if (/px$/.test(style.get("font-size") ?? "") && Math.abs(sizePx - before.fontSizePx) < 0.6) updates["font-size"] = null;
    }
    if (spacingChanged && style.has("line-height")) updates["line-height"] = null;
    if (Object.keys(updates).length) setStyles(element, updates);
  });
  return template.innerHTML;
}
