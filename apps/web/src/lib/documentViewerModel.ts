/**
 * The viewer's arithmetic and targeting, kept free of the DOM and of pdf.js so
 * the rules for "which page, where, and how many" can be tested on their own.
 */
import { locatePassage, type MarkLevel, type PassageRange } from "./documentPassage";
import type {
  KnowledgeDocumentNotice,
  KnowledgeDocumentSegment,
  KnowledgeDocumentTarget,
  KnowledgeDocumentView,
} from "./types";

export type PageBox = { width: number; height: number };

export type PageLayout = {
  /** Each page's scroll offset; index 0 is page 1. */
  tops: number[];
  heights: number[];
  widths: number[];
  total: number;
  widest: number;
};

/** A place in the document that survives zooming and late page measurements:
 * this far down this page sits `viewOffset` pixels below the view's top edge. */
export type PageAnchor = { page: number; fraction: number; viewOffset: number };

export const PAGE_GAP = 16;
export const ZOOM_STOPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** How far below the view's top edge "the page you are on" is measured. */
const CURRENT_PAGE_PROBE = 40;
/** A fitted page stops growing here, so a wide window keeps a readable page. */
const MAX_FIT_SCALE = 1.6;
const FIT_MARGIN = 30;
/** Past this, iOS Safari silently refuses to draw a canvas. */
const MAX_CANVAS_PIXELS = 16_000_000;
/** Where a passage lands, as a share of the view's height. */
const PASSAGE_VIEW_POSITION = 0.25;
/** Unpaged text is cut into sheets of about one printed page. */
const SHEET_CHARACTERS = 3200;

export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(page, 1), pageCount);
}

export function pageLayout(
  pageCount: number,
  measured: ReadonlyMap<number, PageBox>,
  estimate: PageBox,
  scale: number,
): PageLayout {
  const tops: number[] = [];
  const heights: number[] = [];
  const widths: number[] = [];
  let top = PAGE_GAP;
  for (let page = 1; page <= pageCount; page += 1) {
    const box = measured.get(page) ?? estimate;
    tops.push(top);
    heights.push(box.height * scale);
    widths.push(box.width * scale);
    top += box.height * scale + PAGE_GAP;
  }
  return { tops, heights, widths, total: top, widest: Math.max(...widths) };
}

/** Last page whose top edge is at or above `offset`. */
function pageAtOffset(layout: PageLayout, offset: number): number {
  let low = 0;
  let high = layout.tops.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (layout.tops[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

export function currentPage(layout: PageLayout, scrollTop: number, viewportHeight: number): number {
  const atEnd = scrollTop + viewportHeight >= layout.total - 1;
  return atEnd ? layout.tops.length : pageAtOffset(layout, scrollTop + CURRENT_PAGE_PROBE);
}

export function visiblePages(layout: PageLayout, scrollTop: number, viewportHeight: number, overscan: number): number[] {
  const first = pageAtOffset(layout, scrollTop);
  const last = pageAtOffset(layout, scrollTop + viewportHeight - 1);
  const pages: number[] = [];
  const end = Math.min(last + overscan, layout.tops.length);
  for (let page = Math.max(first - overscan, 1); page <= end; page += 1) pages.push(page);
  return pages;
}

export function anchorAt(layout: PageLayout, scrollTop: number, viewOffset = 0): PageAnchor {
  const offset = scrollTop + viewOffset;
  const page = pageAtOffset(layout, offset);
  const height = layout.heights[page - 1];
  const fraction = height > 0 ? (offset - layout.tops[page - 1]) / height : 0;
  return { page, fraction: Math.max(fraction, 0), viewOffset };
}

export function anchorTop(layout: PageLayout, anchor: PageAnchor): number {
  const offset = layout.tops[anchor.page - 1] + anchor.fraction * layout.heights[anchor.page - 1];
  return Math.max(offset - anchor.viewOffset, 0);
}

/** The scale that fits a page to the view, capped on wide screens. */
export function fitScale(availableWidth: number, pageWidth: number): number {
  if (availableWidth <= FIT_MARGIN || pageWidth <= 0) return 1;
  return Math.min((availableWidth - FIT_MARGIN) / pageWidth, MAX_FIT_SCALE);
}

export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next = ZOOM_STOPS.indexOf(zoom) + direction;
  return ZOOM_STOPS[Math.min(Math.max(next, 0), ZOOM_STOPS.length - 1)];
}

/** Device pixels per CSS pixel for a page canvas of this size. */
export function canvasPixelRatio(width: number, height: number, devicePixelRatio: number): number {
  const ratio = devicePixelRatio || 1;
  return Math.min(ratio, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
}

/** The pages a passage sits on, inside this document. */
export function passagePages(
  target: KnowledgeDocumentTarget | null,
  pageCount: number,
): { first: number; last: number } | null {
  if (target?.page == null) return null;
  const first = clampPage(target.page, pageCount);
  return { first, last: clampPage(target.page_end ?? target.page, pageCount) };
}

/** The excerpt to look for on one page, if the passage sits there. */
export function passageExcerpt(
  page: number,
  passage: { first: number; last: number } | null,
  target: KnowledgeDocumentTarget | null,
): string | null {
  if (!passage || !target) return null;
  return page >= passage.first && page <= passage.last ? target.excerpt : null;
}

/** Scroll offset that shows a passage without leaving its page. */
export function passageScrollTop({
  markTop,
  pageTop,
  viewportHeight,
}: {
  markTop: number;
  pageTop: number;
  viewportHeight: number;
}): number {
  return Math.max(pageTop - PAGE_GAP, markTop - viewportHeight * PASSAGE_VIEW_POSITION);
}

// ------------------------------------------------------------- text fallback

export type PaperSheet = {
  key: string;
  heading: string | null;
  page: number | null;
  segments: KnowledgeDocumentSegment[];
};

function sheetHeading(segment: KnowledgeDocumentSegment): string | null {
  return segment.locator ?? (segment.page ? `Page ${segment.page}` : null);
}

function belongsOnSheet(sheet: PaperSheet, segment: KnowledgeDocumentSegment, heading: string | null): boolean {
  if (sheet.heading !== heading || sheet.page !== segment.page) return false;
  if (heading !== null) return true;
  const written = sheet.segments.reduce((total, item) => total + item.text.length, 0);
  return written + segment.text.length <= SHEET_CHARACTERS;
}

/** Lays text out as pages: one sheet per page, slide, or worksheet, and sheets
 * of about a page where the source has no positions. */
export function paperSheets(segments: readonly KnowledgeDocumentSegment[]): PaperSheet[] {
  const sheets: PaperSheet[] = [];
  for (const segment of segments) {
    const heading = sheetHeading(segment);
    const sheet = sheets[sheets.length - 1];
    if (sheet && belongsOnSheet(sheet, segment, heading)) sheet.segments.push(segment);
    else sheets.push({ key: segment.id, heading, page: segment.page, segments: [segment] });
  }
  return sheets;
}

export function targetSheetIndex(sheets: readonly PaperSheet[], target: KnowledgeDocumentTarget | null): number {
  if (!target) return 0;
  const tests: Array<(sheet: PaperSheet) => boolean> = [
    (sheet) => sheet.segments.some((segment) => segment.id === target.chunk_id),
    (sheet) => target.page !== null && sheet.page === target.page,
    (sheet) => target.locator !== null && sheet.heading === target.locator,
  ];
  for (const test of tests) {
    const index = sheets.findIndex(test);
    if (index >= 0) return index;
  }
  return 0;
}

type Span = { start: number; end: number };
export type SegmentMarks = { tint: Span[]; solid: Span[] };

function bySegment(sheet: PaperSheet, ranges: PassageRange[]): Map<string, Span[]> {
  const spans = new Map<string, Span[]>();
  for (const { part, start, end } of ranges) {
    const id = sheet.segments[part].id;
    spans.set(id, [...(spans.get(id) ?? []), { start, end }]);
  }
  return spans;
}

/** Each segment's highlight on a sheet: the cited sentence solid, and its chunk
 * tinted. Nothing is solid unless the sentence was found, and when the words do
 * not match at all, the chunk the server named is what gets the tint. */
export function sheetMarks(
  sheet: PaperSheet,
  target: KnowledgeDocumentTarget | null,
  passage: string | null,
): Map<string, SegmentMarks> {
  const marks = new Map<string, SegmentMarks>();
  if (!target) return marks;
  const located = locatePassage(sheet.segments.map((segment) => segment.text), target.excerpt, passage);
  const solid = bySegment(sheet, located.passage);
  const tint = bySegment(sheet, located.chunk);
  for (const id of new Set([...solid.keys(), ...tint.keys()])) {
    marks.set(id, { tint: tint.get(id) ?? [], solid: solid.get(id) ?? [] });
  }
  const named = sheet.segments.find((segment) => segment.id === target.chunk_id);
  if (marks.size === 0 && named) marks.set(named.id, { tint: [{ start: 0, end: named.text.length }], solid: [] });
  return marks;
}

const MARK_ORDER: ReadonlyArray<MarkLevel | null> = [null, "none", "tint", "solid"];

/** How much of a passage a page managed to mark. */
export function markLevel(tinted: number, solid: number): MarkLevel {
  if (solid > 0) return "solid";
  return tinted > 0 ? "tint" : "none";
}

export function strongerMark(known: MarkLevel | null, next: MarkLevel): MarkLevel {
  return known !== null && MARK_ORDER.indexOf(known) > MARK_ORDER.indexOf(next) ? known : next;
}

/** A quiet line for the callout, saying exactly how far the highlight goes. A
 * sentence is only ever strong when the reply singled it out and it was found. */
export function passageNote(level: MarkLevel | null, hasSentence: boolean): string | null {
  if (level === null || level === "solid") return null;
  if (level === "none") return "These words could not be marked on this page, so they are shown here.";
  return hasSentence
    ? "The cited sentence could not be picked out on this page, so the whole passage is shaded."
    : "The reply did not single out one sentence, so the whole passage is shaded.";
}

export function sheetPositionLabel(
  sheet: Pick<PaperSheet, "page" | "heading">,
  index: number,
  sheetCount: number,
  pageCount: number | null,
): string {
  if (sheet.page !== null) return pageCount ? `Page ${sheet.page} of ${pageCount}` : `Page ${sheet.page}`;
  return sheet.heading ?? `Section ${index + 1} of ${sheetCount}`;
}

const PRESENTATION_TYPE = /presentation|powerpoint/i;

/** A deck's pages are slides, whatever format they reach the viewer in. */
export function pageNoun(contentType: string): "Page" | "Slide" {
  return PRESENTATION_TYPE.test(contentType) ? "Slide" : "Page";
}

function printedPage(page: number, labels: readonly string[] | null): string {
  return labels?.[page - 1]?.trim() || String(page);
}

export type PagePosition = { printed: string; suffix: string; compactSuffix: string; label: string };

/** A page as the reader knows it. The printed number comes first, because that
 * is what citations and the page itself say; the file's own count stays visible
 * whenever the two differ. */
export function pagePosition(
  noun: string,
  page: number,
  pageCount: number,
  labels: readonly string[] | null,
): PagePosition {
  const printed = printedPage(page, labels);
  const relabelled = printed !== String(page);
  const suffix = relabelled ? `(PDF page ${page} of ${pageCount})` : `of ${pageCount}`;
  return {
    printed,
    suffix,
    compactSuffix: relabelled ? `PDF ${page}/${pageCount}` : suffix,
    label: `${noun} ${printed} ${suffix}`,
  };
}

/** The page a typed value means. A printed page wins, then a position in the
 * file; numbers past the ends clamp, and anything else leaves the page alone. */
export function resolvePageInput(raw: string, pageCount: number, labels: readonly string[] | null): number | null {
  const wanted = raw.trim().toLowerCase();
  if (!wanted) return null;
  const printed = labels?.findIndex((label) => label.trim().toLowerCase() === wanted) ?? -1;
  if (printed >= 0) return printed + 1;
  return /^\d+$/.test(wanted) ? clampPage(Number(wanted), pageCount) : null;
}

/** `Page 40`, `Pages 1–2`, `Slide 3`, or `Sheet: Q3`, from what the server said. */
export function placeLabel(
  target: KnowledgeDocumentTarget,
  labels: readonly string[] | null,
  noun: string,
): string | null {
  const { page, page_end: pageEnd, locator } = target;
  if (page === null) return locator;
  const end = pageEnd ?? page;
  const first = printedPage(page, labels);
  const last = printedPage(end, labels);
  const relabelled = first !== String(page) || last !== String(end);
  if (end !== page) {
    return `${noun}s ${first}–${last}${relabelled ? ` (PDF pages ${page}–${end})` : ""}`;
  }
  if (relabelled) return `${noun} ${first} (PDF page ${page})`;
  return locator ?? `${noun} ${first}`;
}

const SENTENCE_OPENING = /^[\p{Lu}\p{N}("'“‘[§•*-]/u;
const SENTENCE_CLOSING = /[.!?:;)\]"'”’…]$/u;
const WHOLE_WORD_AFTER_FIRST = /^\S+\s+/u;
const WHOLE_WORD_BEFORE_LAST = /\s+\S+$/u;

/** An excerpt as a person reads it. Stored chunks overlap by character count,
 * so one can begin or end inside a word; the fragment goes, marked with an
 * ellipsis. Spreadsheet rows lose their pipes. */
export function readableExcerpt(excerpt: string): string {
  let text = excerpt.trim().replace(/\n{3,}/g, "\n\n").replace(/\s*\|\s*/g, " · ");
  if (!SENTENCE_OPENING.test(text) && WHOLE_WORD_AFTER_FIRST.test(text)) {
    text = `… ${text.replace(WHOLE_WORD_AFTER_FIRST, "")}`;
  }
  if (!SENTENCE_CLOSING.test(text) && WHOLE_WORD_BEFORE_LAST.test(text)) {
    text = `${text.replace(WHOLE_WORD_BEFORE_LAST, "")} …`;
  }
  return text;
}

const PAN_STEP = 80;

export type ScrollMetrics = { scrollLeft: number; clientWidth: number; scrollWidth: number };

/** How far an arrow key pans a page wider than the view. Zero means there is
 * nowhere left to go, so the key turns the page instead. */
export function panStep(key: string, { scrollLeft, clientWidth, scrollWidth }: ScrollMetrics): number {
  if (key === "ArrowLeft" && scrollLeft >= 1) return -PAN_STEP;
  if (key === "ArrowRight" && scrollLeft + clientWidth <= scrollWidth - 1) return PAN_STEP;
  return 0;
}

/** When the cited chunk is gone, the page it was cited from is still the best
 * place to open. Only ever positions a document the server already allowed. */
export function viewWithPageHint(view: KnowledgeDocumentView, pageHint: number | null): KnowledgeDocumentView {
  if (view.target || !pageHint) return view;
  const target = { page: pageHint, page_end: pageHint, locator: null, excerpt: "", chunk_id: null, exact: false };
  return { ...view, target };
}

const NOTICES: Record<KnowledgeDocumentNotice, string> = {
  original_missing: "The original file is not available, so this shows the text that was indexed.",
  conversion_unavailable: "This server cannot show this file type with its original layout, so this shows the text that was indexed.",
  conversion_failed: "The original layout could not be prepared, so this shows the text that was indexed.",
  privacy_restricted: "A privacy policy applies to this document, so this shows the text that was indexed, not the original.",
};

export function viewNoticeText(notice: KnowledgeDocumentNotice | null): string | null {
  return notice ? NOTICES[notice] : null;
}
