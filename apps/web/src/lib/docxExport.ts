/** Real .docx (OOXML) export for document drafts.
 *
 * The previous Word export was HTML/MHTML behind a .doc extension; Word for
 * Windows tolerates that, but Word for macOS opens MHTML as an empty
 * document. This module writes a genuine OOXML package — ZIP + document.xml +
 * embedded media — so the file opens natively in Word (Mac and Windows),
 * Pages, and Google Docs.
 *
 * Geometry mirrors the draft preview exactly: the 728px preview content
 * column maps onto a 6.86in printed column (US Letter, 0.75in/0.82in
 * margins), and images preserve the preview's uncropped aspect ratios.
 */

import { buildZip, type ZipEntry } from "./ooxmlZip";

/** Preview canvas geometry the exports mirror (styles.css .document-canvas):
 * 860px page, ~66px side padding, so 728px of content. Media-block images
 * fit inside the full content width and 420px height; .document-image-figure
 * images fit inside 82% width and 360px height. Both preserve aspect ratio. */
export const PREVIEW_CONTENT_WIDTH_PX = 728;
const PREVIEW_MEDIA_IMAGE_MAX_HEIGHT_PX = 420;
const PREVIEW_IMAGE_FIGURE_WIDTH_RATIO = 0.82;
const PREVIEW_FIGURE_IMAGE_MAX_HEIGHT_PX = 360;
const PREVIEW_DIAGRAM_IMAGE_MAX_HEIGHT_PX = 480;
const EXPORT_IMAGE_LOAD_TIMEOUT_MS = 6000;
const EXPORT_IMAGE_RASTER_MAX_WIDTH_PX = 1400;

/** Word page metrics: 8.5in wide with 0.82in side margins leaves 6.86in
 * (493.9pt) of printed content, mirroring the 728px preview column. */
const WORD_CONTENT_WIDTH_PT = 493.9;
const WORD_PT_PER_PREVIEW_PX = WORD_CONTENT_WIDTH_PT / PREVIEW_CONTENT_WIDTH_PX;
const CONTENT_WIDTH_TWIPS = 9878; // 6.86in * 1440
const EMU_PER_PT = 12700;

/** Resolves a remote image to a canvas-safe data URL (the API image proxy). */
export type ExportImageProxy = (src: string) => Promise<string | null>;

export function isAutomatedTestMode() {
  const maybeProcess = (
    globalThis as typeof globalThis & {
      process?: { env?: { NODE_ENV?: string; VITEST?: string } };
    }
  ).process;
  return (
    import.meta.env.MODE === "test" ||
    import.meta.env.VITEST === "true" ||
    maybeProcess?.env?.NODE_ENV === "test" ||
    maybeProcess?.env?.VITEST === "true"
  );
}

type ExportImageLayout = "media" | "figure" | "inline" | "diagram";

export type LoadedExportImage = {
  element: HTMLImageElement;
  width: number;
  height: number;
  canvasSafe: boolean;
};

function exportImageLayout(image: HTMLElement): ExportImageLayout {
  const figure = image.closest("figure");
  if (!figure) return "inline";
  if (figure.classList.contains("document-diagram-figure")) return "diagram";
  return figure.classList.contains("document-image-figure") ? "figure" : "media";
}

/** Display geometry in preview pixels, matching the editor CSS: media and
 * figure images contain-fit inside their width and height limits without
 * cropping; inline images render at natural size up to the content width. */
function exportImageDisplaySize(layout: ExportImageLayout, width: number, height: number) {
  const naturalWidth = width || PREVIEW_CONTENT_WIDTH_PX;
  const naturalHeight = height || Math.round(PREVIEW_CONTENT_WIDTH_PX * 0.6);
  if (layout === "diagram") {
    // Diagrams scale to fit (preview object-fit: contain) — never cover-cropped.
    const fitScale = Math.min(
      1,
      PREVIEW_CONTENT_WIDTH_PX / naturalWidth,
      PREVIEW_DIAGRAM_IMAGE_MAX_HEIGHT_PX / naturalHeight,
    );
    return {
      width: Math.max(1, Math.round(naturalWidth * fitScale)),
      height: Math.max(1, Math.round(naturalHeight * fitScale)),
      crop: null,
    };
  }
  if (layout === "media" || layout === "figure") {
    const maxWidth = Math.round(
      layout === "figure"
        ? PREVIEW_CONTENT_WIDTH_PX * PREVIEW_IMAGE_FIGURE_WIDTH_RATIO
        : PREVIEW_CONTENT_WIDTH_PX,
    );
    const maxHeight =
      layout === "figure" ? PREVIEW_FIGURE_IMAGE_MAX_HEIGHT_PX : PREVIEW_MEDIA_IMAGE_MAX_HEIGHT_PX;
    const fitScale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
    return {
      width: Math.max(1, Math.round(naturalWidth * fitScale)),
      height: Math.max(1, Math.round(naturalHeight * fitScale)),
      crop: null,
    };
  }
  const fitScale = Math.min(1, PREVIEW_CONTENT_WIDTH_PX / naturalWidth);
  return {
    width: Math.max(1, Math.round(naturalWidth * fitScale)),
    height: Math.max(1, Math.round(naturalHeight * fitScale)),
    crop: null,
  };
}

function loadImageElement(src: string, useCors: boolean): Promise<LoadedExportImage | null> {
  return new Promise<LoadedExportImage | null>((resolve) => {
    const element = new Image();
    const timer = window.setTimeout(() => resolve(null), EXPORT_IMAGE_LOAD_TIMEOUT_MS);
    element.onload = () => {
      window.clearTimeout(timer);
      resolve({
        element,
        width: element.naturalWidth || PREVIEW_CONTENT_WIDTH_PX,
        height: element.naturalHeight || Math.round(PREVIEW_CONTENT_WIDTH_PX * 0.6),
        canvasSafe: useCors || src.startsWith("data:"),
      });
    };
    element.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    if (useCors && !src.startsWith("data:")) element.crossOrigin = "anonymous";
    element.src = src;
  });
}

/** Last-resort image fetch: some hosts reject CORS image loads but allow a
 * fetch; converting to a data URL keeps the canvas readable so the picture
 * still embeds in the export instead of silently dropping. */
async function fetchImageAsDataUrl(src: string): Promise<string | null> {
  if (src.startsWith("data:") || typeof fetch !== "function") return null;
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), EXPORT_IMAGE_LOAD_TIMEOUT_MS);
    const response = await fetch(src, { signal: controller.signal });
    window.clearTimeout(timer);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export async function loadExportImage(
  src: string,
  imageProxy?: ExportImageProxy,
): Promise<LoadedExportImage | null> {
  if (typeof Image === "undefined" || isAutomatedTestMode()) return null;
  // Start the normal CORS load and the authenticated image-proxy load at the
  // same time. Web-search hosts frequently reject CORS, and waiting for that
  // failure before starting the proxy used to add the full timeout to every
  // picture in a Word export.
  const candidates: Array<Promise<LoadedExportImage | null>> = [
    loadImageElement(src, true),
  ];
  if (imageProxy) {
    candidates.push(
      imageProxy(src).then((proxied) =>
        proxied ? loadImageElement(proxied, true) : Promise.resolve(null),
      ),
    );
  }
  const firstReadable = await firstSuccessfulImage(candidates);
  if (firstReadable) return firstReadable;
  // Fetch fallback rescues hosts that block CORS image loads but allow fetch.
  const fetched = await fetchImageAsDataUrl(src);
  if (fetched) {
    const viaData = await loadImageElement(fetched, true);
    if (viaData) return viaData;
  }
  // Plain load still lets us measure real dimensions for stable sizing.
  return loadImageElement(src, false);
}

function firstSuccessfulImage(candidates: Array<Promise<LoadedExportImage | null>>) {
  return new Promise<LoadedExportImage | null>((resolve) => {
    let remaining = candidates.length;
    let settled = false;
    candidates.forEach((candidate) => {
      candidate
        .then((loaded) => {
          if (settled) return;
          if (loaded) {
            settled = true;
            resolve(loaded);
            return;
          }
          remaining -= 1;
          if (remaining === 0) resolve(null);
        })
        .catch(() => {
          if (settled) return;
          remaining -= 1;
          if (remaining === 0) resolve(null);
        });
    });
  });
}

export function rasterizeExportImage(
  loaded: LoadedExportImage,
  crop: { sx: number; sy: number; sw: number; sh: number } | null = null,
): Uint8Array | null {
  if (!loaded.canvasSafe) return null;
  try {
    const sourceWidth = crop ? crop.sw : loaded.width;
    const sourceHeight = crop ? crop.sh : loaded.height;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, EXPORT_IMAGE_RASTER_MAX_WIDTH_PX / sourceWidth);
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (crop) {
      context.drawImage(
        loaded.element,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    } else {
      context.drawImage(loaded.element, 0, 0, canvas.width, canvas.height);
    }
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    if (!dataUrl.startsWith("data:image/jpeg")) return null;
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    // Tainted canvas or an unsupported source; the caller links the original.
    return null;
  }
}

/** Pasted/imported drafts can already contain a JPEG data URL. Decode it
 * directly when the browser image/canvas path is unavailable (including the
 * test runtime) so an offline-safe picture is still embedded in the DOCX. */
export function embeddedJpegFromDataUrl(src: string) {
  const match = /^data:image\/(?:jpeg|jpg);base64,([a-z0-9+/=\s]+)$/i.exec(src);
  if (!match) return null;
  try {
    const binary = atob(match[1].replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const dimensions = jpegDimensions(bytes);
    return {
      bytes,
      width: dimensions?.width ?? PREVIEW_CONTENT_WIDTH_PX,
      height: dimensions?.height ?? Math.round(PREVIEW_CONTENT_WIDTH_PX * 0.6),
    };
  } catch {
    return null;
  }
}

function jpegDimensions(bytes: Uint8Array) {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) return null;
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) return null;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      if (width > 0 && height > 0) return { width, height };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/* ------------------------------ block model ------------------------------ */

/** A fill-in rule exported as an underlined run of non-breaking spaces, the
 * way Word itself draws a signature line. `rule` keeps it from being dropped
 * as whitespace by the empty-paragraph check. */
export const DOCX_SIGNATURE_LINE_CLASS = "document-signature-line";
const DOCX_SIGNATURE_LINE_FILL = "\u00a0".repeat(24);

type DocRun = {
  text: string;
  rule?: boolean;
  bold: boolean;
  italic: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  font?: string;
  shadingFill?: string;
  sizeHalfPt?: number;
  superscript?: boolean;
  subscript?: boolean;
  href?: string;
  anchor?: string;
};
type DocBlockAlignment = "center" | "right" | "justify";
type DocBlock =
  | { kind: "heading"; level: 1 | 2 | 3; runs: DocRun[]; align?: DocBlockAlignment }
  | { kind: "paragraph"; runs: DocRun[]; align?: DocBlockAlignment; mla?: "heading" | "body" | "reference" }
  | { kind: "list-item"; marker: string; runs: DocRun[]; align?: DocBlockAlignment }
  | { kind: "quote"; runs: DocRun[]; align?: DocBlockAlignment }
  | { kind: "code"; text: string }
  | { kind: "caption"; runs: DocRun[] }
  | { kind: "image"; index: number; src: string; alt: string; layout: ExportImageLayout; caption: string }
  | {
      kind: "table";
      rows: { header: boolean; cells: DocRun[][]; aligns?: (DocBlockAlignment | undefined)[] }[];
    }
  | { kind: "divider" }
  | { kind: "page-break" };

const BLOCK_CONTAINER_SELECTOR = "p,h1,h2,h3,ul,ol,table,figure,blockquote,pre,div,section,hr,img";

/** Re-joins text blocks the preview paginator split across sheet boundaries
 * (marked data-split-continuation) so exports and model snapshots carry the
 * original flowing paragraph instead of a paragraph break mid-sentence. Word
 * then paginates the joined paragraph naturally at its own page edge. */
export function mergeSplitContinuationBlocks(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("[data-split-continuation]").forEach((element) => {
    element.removeAttribute("data-split-continuation");
    let previous: Element | null = element.previousElementSibling;
    while (previous && previous.classList.contains("document-page-label")) {
      previous = previous.previousElementSibling;
    }
    if (!previous && element.parentElement?.matches("section.document-page")) {
      let previousSheet = element.parentElement.previousElementSibling;
      while (previousSheet && !previous) {
        if (previousSheet.matches("section.document-page")) {
          const children = Array.from(previousSheet.children).filter(
            (child) => !child.classList.contains("document-page-label"),
          );
          previous = children[children.length - 1] ?? null;
        }
        previousSheet = previousSheet.previousElementSibling;
      }
    }
    if (!(previous instanceof HTMLElement) || previous.tagName !== element.tagName) return;
    previous.append(...Array.from(element.childNodes));
    element.remove();
  });
}

function parseDocBlocks(contentHtml: string, documentTitle: string): DocBlock[] {
  const template = document.createElement("template");
  template.innerHTML = contentHtml;
  template.content.querySelectorAll(".document-page-label").forEach((node) => node.remove());
  mergeSplitContinuationBlocks(template.content);
  const blocks: DocBlock[] = [];
  const imageCounter = { value: 0 };
  const hasPages = Boolean(template.content.querySelector("section.document-page"));
  if (hasPages) {
    // Walk top level in document order: sheet boundaries become page breaks,
    // and stray nodes between sheets (loose manual edits) are kept, not
    // silently dropped.
    let pageIndex = 0;
    template.content.childNodes.forEach((node) => {
      if (node instanceof HTMLElement && node.matches("section.document-page")) {
        if (pageIndex > 0) blocks.push({ kind: "page-break" });
        pageIndex += 1;
        node.childNodes.forEach((child) => collectDocBlocks(child, blocks, imageCounter));
        return;
      }
      collectDocBlocks(node, blocks, imageCounter);
    });
  } else {
    template.content.childNodes.forEach((node) => collectDocBlocks(node, blocks, imageCounter));
  }
  // A boundary can be marked twice in legacy drafts (section edge plus an
  // explicit break marker); duplicate breaks would render as blank pages.
  const collapsed: DocBlock[] = [];
  blocks.forEach((block) => {
    if (
      block.kind === "page-break" &&
      (!collapsed.length || collapsed[collapsed.length - 1].kind === "page-break")
    ) {
      return;
    }
    collapsed.push(block);
  });
  while (collapsed.length && collapsed[collapsed.length - 1].kind === "page-break") collapsed.pop();
  if (!template.content.querySelector(".document-mla-text") && !collapsed.some((block) => block.kind === "heading" && block.level === 1) && documentTitle) {
    collapsed.unshift({
      kind: "heading",
      level: 1,
      runs: [{ text: documentTitle, bold: true, italic: false }],
    });
  }
  return collapsed;
}

function collectDocBlocks(node: Node, blocks: DocBlock[], imageCounter: { value: number }) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) blocks.push({ kind: "paragraph", runs: [{ text, bold: false, italic: false }] });
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  if (node.matches(".document-page-label")) return;
  const tag = node.tagName.toLowerCase();

  if (tag === "hr") {
    // A marker named document-page-break is an authored hard break even when
    // it reaches the exporter outside a paginated section. Treating it as a
    // decorative rule made the preview and Word disagree for manual breaks.
    blocks.push({ kind: node.classList.contains("document-page-break") ? "page-break" : "divider" });
    return;
  }
  if (node.classList.contains("document-mla-text") && /^(p|h[1-3]|li|blockquote)$/.test(tag)) {
    blocks.push({ kind: "paragraph", runs: collectDocRuns(node), align: blockAlignment(node),
      mla: node.classList.contains("document-mla-reference") ? "reference" : node.classList.contains("document-mla-body") ? "body" : "heading" });
    return;
  }
  if (tag === "h1" || tag === "h2" || tag === "h3") {
    const runs = collectDocRuns(node);
    if (docRunsHaveText(runs)) {
      blocks.push({
        kind: "heading",
        level: tag === "h1" ? 1 : tag === "h2" ? 2 : 3,
        runs,
        align: blockAlignment(node),
      });
    }
    return;
  }
  if (tag === "img") {
    imageCounter.value += 1;
    blocks.push({
      kind: "image",
      index: imageCounter.value,
      src: node.getAttribute("src") ?? "",
      alt: node.getAttribute("alt") ?? "",
      layout: "inline",
      caption: "",
    });
    return;
  }
  if (tag === "figure") {
    const image = node.querySelector("img");
    const caption = (node.querySelector("figcaption")?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (image) {
      imageCounter.value += 1;
      blocks.push({
        kind: "image",
        index: imageCounter.value,
        src: image.getAttribute("src") ?? "",
        alt: image.getAttribute("alt") ?? "",
        layout: node.classList.contains("document-diagram-figure")
          ? "diagram"
          : node.classList.contains("document-image-figure")
            ? "figure"
            : "media",
        caption,
      });
    } else if (caption) {
      blocks.push({ kind: "caption", runs: [{ text: caption, bold: false, italic: false }] });
    }
    return;
  }
  if (tag === "ul" || tag === "ol") {
    let itemNumber = 0;
    Array.from(node.children).forEach((child) => {
      if (!(child instanceof HTMLElement) || child.tagName !== "LI") return;
      itemNumber += 1;
      const runs = collectDocRuns(child);
      if (docRunsHaveText(runs)) {
        blocks.push({
          kind: "list-item",
          marker: tag === "ol" ? `${itemNumber}.` : "•",
          runs,
          align: blockAlignment(child),
        });
      }
    });
    return;
  }
  if (tag === "blockquote") {
    const runs = collectDocRuns(node);
    if (docRunsHaveText(runs)) blocks.push({ kind: "quote", runs, align: blockAlignment(node) });
    return;
  }
  if (tag === "pre") {
    const text = (node.textContent ?? "").replace(/\s+$/, "");
    if (text.trim()) blocks.push({ kind: "code", text });
    return;
  }
  if (tag === "table") {
    const rows = Array.from(node.querySelectorAll("tr"))
      .map((row) => ({
        header: row.querySelector("th") !== null || row.closest("thead") !== null,
        cells: Array.from(row.querySelectorAll("th,td")).map((cell) => collectDocRuns(cell)),
        // Numeric columns carry their alignment from the markdown separator
        // row through to Word, where a right-aligned total still reads as one.
        aligns: Array.from(row.querySelectorAll("th,td")).map((cell) =>
          blockAlignment(cell as HTMLElement),
        ),
      }))
      .filter((row) => row.cells.length > 0);
    if (rows.length) blocks.push({ kind: "table", rows });
    return;
  }
  if (tag === "p" || !node.querySelector(BLOCK_CONTAINER_SELECTOR)) {
    const runs = collectDocRuns(node);
    if (docRunsHaveText(runs)) {
      blocks.push({ kind: "paragraph", runs, align: blockAlignment(node) });
    }
    return;
  }
  node.childNodes.forEach((child) => collectDocBlocks(child, blocks, imageCounter));
}

type DocRunFormat = Omit<DocRun, "text">;

function collectDocRuns(
  root: Node,
  inherited: DocRunFormat = { bold: false, italic: false },
  runs: DocRun[] = [],
): DocRun[] {
  const format = root instanceof HTMLElement ? runFormatForElement(root, inherited) : inherited;
  root.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent ?? "").replace(/\s+/g, " ");
      if (text) runs.push({ text, ...format });
      return;
    }
    if (!(child instanceof HTMLElement)) return;
    if (child.matches(".document-page-label")) return;
    if (child.classList.contains(DOCX_SIGNATURE_LINE_CLASS)) {
      // Emitted whole so the rule keeps its length: the text-node path
      // collapses runs of whitespace, and non-breaking spaces are whitespace.
      runs.push({
        text: DOCX_SIGNATURE_LINE_FILL,
        rule: true,
        ...runFormatForElement(child, format),
      });
      return;
    }
    const tag = child.tagName;
    if (tag === "BR") {
      runs.push({ text: "\n", ...format });
      return;
    }
    if (tag === "IMG" || tag === "FIGURE" || tag === "TABLE") return;
    collectDocRuns(child, format, runs);
  });
  return runs;
}

function runFormatForElement(element: HTMLElement, inherited: DocRunFormat): DocRunFormat {
  const tag = element.tagName;
  const style = element.getAttribute("style") ?? "";
  const inlineColor = element.getAttribute("color") ?? cssDeclaration(style, "color");
  const rawHref = tag === "A" ? element.getAttribute("href") : null;
  const href =
    tag === "A"
      ? safeExternalRelationshipTarget(rawHref, true)
      : inherited.href;
  const anchor = tag === "A" ? safeDocumentAnchor(rawHref) : inherited.anchor;
  const inlineCode = tag === "CODE";
  // Toolbar highlights arrive as background-color spans (and pasted
  // content may use <mark>); both become run shading like Word's highlighter.
  const highlightFill =
    normalizeWordColor(cssDeclaration(style, "background-color")) ??
    (tag === "MARK" ? "FDE68A" : undefined);
  return {
    bold:
      inherited.bold ||
      tag === "B" ||
      tag === "STRONG" ||
      /(^|;)\s*font-weight\s*:\s*(bold|[6-9]00)\b/i.test(style),
    italic:
      inherited.italic ||
      tag === "I" ||
      tag === "EM" ||
      /(^|;)\s*font-style\s*:\s*italic\b/i.test(style),
    underline:
      inherited.underline ||
      tag === "U" ||
      // A fill-in rule is drawn with a CSS border on screen; Word draws the
      // same rule as an underlined run of the spaces the element carries.
      element.classList.contains(DOCX_SIGNATURE_LINE_CLASS) ||
      /(^|;)\s*text-decoration(?:-line)?\s*:[^;]*\bunderline\b/i.test(style),
    strike:
      inherited.strike ||
      tag === "S" ||
      tag === "STRIKE" ||
      tag === "DEL" ||
      /(^|;)\s*text-decoration(?:-line)?\s*:[^;]*\bline-through\b/i.test(style),
    color: normalizeWordColor(inlineColor) ?? inherited.color,
    font: inlineCode ? "Consolas" : runFontFamily(style) ?? inherited.font,
    shadingFill: inlineCode ? "EEF2F5" : highlightFill ?? inherited.shadingFill,
    sizeHalfPt: runSizeHalfPoints(style) ?? inherited.sizeHalfPt,
    superscript:
      inherited.superscript ||
      tag === "SUP" ||
      element.classList.contains("document-citation") ||
      /(^|;)\s*vertical-align\s*:\s*super\b/i.test(style),
    subscript:
      inherited.subscript ||
      tag === "SUB" ||
      /(^|;)\s*vertical-align\s*:\s*sub\b/i.test(style),
    href: href ?? undefined,
    anchor: anchor ?? undefined,
  };
}

/** First font-family name from a run's inline style, unquoted, for the
 * per-run <w:rFonts>. Anything that does not look like a plain family name
 * is ignored rather than guessed at. */
function runFontFamily(style: string): string | undefined {
  const declared = cssDeclaration(style, "font-family");
  if (!declared) return undefined;
  const family = (declared.split(",")[0] ?? "").replace(/["']/g, "").replace(/\s+/g, " ").trim();
  return family && /^[a-z0-9][a-z0-9 \-]{0,58}$/i.test(family) ? family : undefined;
}

/** Explicit toolbar font sizes (px, or pt from pasted content) to Word
 * half-points through the shared preview px→pt mapping. */
function runSizeHalfPoints(style: string): number | undefined {
  const declared = cssDeclaration(style, "font-size");
  if (!declared) return undefined;
  const match = /^(\d+(?:\.\d+)?)(px|pt)$/i.exec(declared);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return match[2].toLowerCase() === "pt" ? Math.round(value * 2) : halfPoints(value);
}

/** Paragraph-level alignment from the block's inline style. Left alignment is
 * the document default and stays implicit. */
function blockAlignment(element: HTMLElement): DocBlockAlignment | undefined {
  const declared = cssDeclaration(element.getAttribute("style") ?? "", "text-align");
  if (declared === "center" || declared === "right" || declared === "justify") return declared;
  return undefined;
}

function cssDeclaration(style: string, property: string) {
  const match = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i"));
  return match?.[1]?.trim() ?? null;
}

function normalizeWordColor(value: string | null) {
  if (!value) return undefined;
  const trimmed = value.trim();
  const shortHex = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (shortHex) {
    return shortHex[1]
      .split("")
      .map((digit) => `${digit}${digit}`)
      .join("")
      .toUpperCase();
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hex) return hex[1].toUpperCase();
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,[^)]*)?\)$/i.exec(
    trimmed,
  );
  if (!rgb) return undefined;
  return rgb
    .slice(1, 4)
    .map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function safeExternalRelationshipTarget(value: string | null, allowMailto = false) {
  const trimmed = value?.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    const allowed =
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      (allowMailto && parsed.protocol === "mailto:");
    if (parsed.username || parsed.password) return null;
    return allowed ? parsed.href : null;
  } catch {
    return null;
  }
}

function safeDocumentAnchor(value: string | null) {
  const match = /^#([A-Za-z_][A-Za-z0-9_.-]{0,79})$/.exec(value?.trim() ?? "");
  return match?.[1] ?? null;
}

function docRunsHaveText(runs: DocRun[]) {
  return runs.some((run) => run.rule || run.text.trim().length > 0);
}

/* ------------------------------ images ------------------------------ */

type DocxImageResource = {
  relId: string;
  external: boolean;
  target: string;
  bytes: Uint8Array | null;
  widthEmu: number;
  heightEmu: number;
};

async function loadDocxImageResources(blocks: DocBlock[], imageProxy?: ExportImageProxy) {
  const resources = new Map<number, DocxImageResource>();
  const imageBlocks = blocks.filter(
    (block): block is Extract<DocBlock, { kind: "image" }> => block.kind === "image" && Boolean(block.src),
  );
  // Reuse one in-flight load for repeated pictures and resolve all distinct
  // images concurrently. A 25-page report should take roughly the time of its
  // slowest image, not the sum of every image timeout.
  const loadsBySource = new Map<string, Promise<LoadedExportImage | null>>();
  const loadedImages = await Promise.all(
    imageBlocks.map(async (block) => {
      let pending = loadsBySource.get(block.src);
      if (!pending) {
        pending = loadExportImage(block.src, imageProxy);
        loadsBySource.set(block.src, pending);
      }
      return { block, loaded: await pending };
    }),
  );
  let mediaCount = 0;
  for (const { block, loaded } of loadedImages) {
    const relId = `rIdImg${block.index}`;
    const embeddedJpeg = loaded ? null : embeddedJpegFromDataUrl(block.src);
    const display = exportImageDisplaySize(
      block.layout,
      loaded?.width ?? embeddedJpeg?.width ?? 0,
      loaded?.height ?? embeddedJpeg?.height ?? 0,
    );
    const rasterizedBytes = loaded ? rasterizeExportImage(loaded, display.crop) : null;
    const bytes = rasterizedBytes ?? embeddedJpeg?.bytes ?? null;
    const widthPt = display.width * WORD_PT_PER_PREVIEW_PX;
    const heightPt = display.height * WORD_PT_PER_PREVIEW_PX;
    if (bytes) {
      mediaCount += 1;
      resources.set(block.index, {
        relId,
        external: false,
        target: `media/image${mediaCount}.jpeg`,
        bytes,
        widthEmu: Math.round(widthPt * EMU_PER_PT),
        heightEmu: Math.round(heightPt * EMU_PER_PT),
      });
    } else {
      const externalTarget = safeExternalRelationshipTarget(block.src);
      if (!externalTarget) continue;
      // No readable pixels (offline, test runtime, or a host the proxy could
      // not reach): reference the picture externally so Word can fetch it
      // rather than silently dropping the figure.
      resources.set(block.index, {
        relId,
        external: true,
        target: externalTarget,
        bytes: null,
        widthEmu: Math.round(widthPt * EMU_PER_PT),
        heightEmu: Math.round(heightPt * EMU_PER_PT),
      });
    }
  }
  return resources;
}

/* ------------------------------ XML helpers ------------------------------ */

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Half-points from preview px through the shared px→pt mapping. */
function halfPoints(previewPx: number) {
  return Math.max(2, Math.round(previewPx * WORD_PT_PER_PREVIEW_PX * 2));
}

/** Twips (1/20pt) from preview px. */
function twips(previewPx: number) {
  return Math.max(0, Math.round(previewPx * WORD_PT_PER_PREVIEW_PX * 20));
}

const BODY_SIZE_HALF_PT = halfPoints(17);
const BODY_LINE_TWIPS = Math.round(240 * 1.62);

type RunStyle = {
  sizeHalfPt?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  font?: string;
};

function runsXml(
  runs: DocRun[],
  style: RunStyle = {},
  hyperlinks: Map<string, string> = new Map(),
) {
  return runs
    .map((run) => {
      const props: string[] = [];
      const hyperlinkId = run.href ? hyperlinks.get(run.href) : undefined;
      const hyperlinkAnchor = run.anchor;
      const isHyperlink = Boolean(hyperlinkId || hyperlinkAnchor);
      // Set a portable sans-serif on every run. Some Word/Quick Look readers
      // ignore docDefaults for hand-built packages and otherwise fall back to
      // Times, which makes the export visibly diverge from the preview.
      const font = run.font ?? style.font ?? "Arial";
      const safeFont = escapeXml(font);
      props.push(
        `<w:rFonts w:ascii="${safeFont}" w:hAnsi="${safeFont}" w:eastAsia="${safeFont}" w:cs="${safeFont}"/>`,
      );
      if (run.bold || style.bold) props.push("<w:b/>");
      if (run.italic || style.italic) props.push("<w:i/>");
      if (run.strike) props.push("<w:strike/>");
      const color = run.color ?? (isHyperlink ? "0563C1" : style.color);
      if (color) props.push(`<w:color w:val="${escapeXml(color)}"/>`);
      const size = run.sizeHalfPt ?? style.sizeHalfPt ?? BODY_SIZE_HALF_PT;
      props.push(`<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`);
      // Keep run properties in the schema order Word emits: color and size
      // precede underline, shading, and vertical alignment.
      if (run.underline || isHyperlink) props.push('<w:u w:val="single"/>');
      if (run.shadingFill) {
        props.push(
          `<w:shd w:val="clear" w:color="auto" w:fill="${escapeXml(run.shadingFill)}"/>`,
        );
      }
      if (run.superscript) props.push('<w:vertAlign w:val="superscript"/>');
      else if (run.subscript) props.push('<w:vertAlign w:val="subscript"/>');
      const rPr = `<w:rPr>${props.join("")}</w:rPr>`;
      // Preserve explicit newlines from <br> as real line breaks.
      const pieces = run.text.split("\n");
      const body = pieces
        .map((piece, index) => {
          const text = `<w:t xml:space="preserve">${escapeXml(piece)}</w:t>`;
          return index === 0 ? text : `<w:br/>${text}`;
        })
        .join("");
      const runXml = `<w:r>${rPr}${body}</w:r>`;
      if (hyperlinkId) {
        return `<w:hyperlink r:id="${escapeXml(hyperlinkId)}" w:history="1">${runXml}</w:hyperlink>`;
      }
      return hyperlinkAnchor
        ? `<w:hyperlink w:anchor="${escapeXml(hyperlinkAnchor)}" w:history="1">${runXml}</w:hyperlink>`
        : runXml;
    })
    .join("");
}

type ParagraphOptions = {
  spacingAfterTwips?: number;
  spacingBeforeTwips?: number;
  lineTwips?: number;
  indentLeftTwips?: number;
  hangingTwips?: number;
  firstLineTwips?: number;
  centered?: boolean;
  align?: DocBlockAlignment;
  keepNext?: boolean;
  borders?: string;
  shadingFill?: string;
  pageBreakBefore?: boolean;
};

function paragraphXml(content: string, options: ParagraphOptions = {}) {
  const props: string[] = [];
  if (options.keepNext) props.push("<w:keepNext/>");
  if (options.pageBreakBefore) props.push("<w:pageBreakBefore/>");
  if (options.borders) props.push(`<w:pBdr>${options.borders}</w:pBdr>`);
  if (options.shadingFill) {
    props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${options.shadingFill}"/>`);
  }
  const spacingParts = [
    `w:after="${options.spacingAfterTwips ?? 0}"`,
    options.spacingBeforeTwips ? `w:before="${options.spacingBeforeTwips}"` : "",
    `w:line="${options.lineTwips ?? BODY_LINE_TWIPS}" w:lineRule="auto"`,
  ]
    .filter(Boolean)
    .join(" ");
  props.push(`<w:spacing ${spacingParts}/>`);
  if (options.indentLeftTwips) {
    const hanging = options.hangingTwips ? ` w:hanging="${options.hangingTwips}"` : "";
    props.push(`<w:ind w:left="${options.indentLeftTwips}"${hanging}/>`);
  }
  if (options.firstLineTwips) props.push(`<w:ind w:firstLine="${options.firstLineTwips}"/>`);
  const justification = options.align ?? (options.centered ? "center" : undefined);
  if (justification) {
    props.push(`<w:jc w:val="${justification === "justify" ? "both" : justification}"/>`);
  }
  return `<w:p><w:pPr>${props.join("")}</w:pPr>${content}</w:p>`;
}

function imageDrawingXml(resource: DocxImageResource, index: number, alt: string) {
  const blip = resource.external
    ? `<a:blip r:link="${resource.relId}"/>`
    : `<a:blip r:embed="${resource.relId}"/>`;
  return (
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${resource.widthEmu}" cy="${resource.heightEmu}"/>` +
    `<wp:docPr id="${1000 + index}" name="Picture ${index}" descr="${escapeXml(alt)}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${1000 + index}" name="Picture ${index}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${resource.widthEmu}" cy="${resource.heightEmu}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
  );
}

function tableXml(
  rows: { header: boolean; cells: DocRun[][]; aligns?: (DocBlockAlignment | undefined)[] }[],
  hyperlinks: Map<string, string>,
) {
  const columnCount = Math.max(1, ...rows.map((row) => row.cells.length));
  const columnWidth = Math.floor(CONTENT_WIDTH_TWIPS / columnCount);
  const border = `<w:top w:val="single" w:sz="4" w:color="D9E3EA"/><w:left w:val="single" w:sz="4" w:color="D9E3EA"/><w:bottom w:val="single" w:sz="4" w:color="D9E3EA"/><w:right w:val="single" w:sz="4" w:color="D9E3EA"/><w:insideH w:val="single" w:sz="4" w:color="D9E3EA"/><w:insideV w:val="single" w:sz="4" w:color="D9E3EA"/>`;
  const grid = Array.from({ length: columnCount }, () => `<w:gridCol w:w="${columnWidth}"/>`).join("");
  const cellSize = halfPoints(14);
  const body = rows
    .map((row) => {
      const cells = Array.from({ length: columnCount }, (_, column) => {
        const cellRuns = row.cells[column] ?? [];
        const shading = row.header
          ? `<w:shd w:val="clear" w:color="auto" w:fill="EEF6F7"/>`
          : "";
        const runs = runsXml(
          cellRuns,
          {
            sizeHalfPt: cellSize,
            bold: row.header,
            color: row.header ? "173247" : "242424",
          },
          hyperlinks,
        );
        const align = row.aligns?.[column];
        const jc = align ? `<w:jc w:val="${align === "justify" ? "both" : align}"/>` : "";
        return (
          `<w:tc><w:tcPr><w:tcW w:w="${columnWidth}" w:type="dxa"/>${shading}</w:tcPr>` +
          `<w:p><w:pPr><w:spacing w:after="60" w:line="276" w:lineRule="auto"/>${jc}</w:pPr>${runs}</w:p></w:tc>`
        );
      }).join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${CONTENT_WIDTH_TWIPS}" w:type="dxa"/>` +
    `<w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>` +
    `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>`
  );
}

function renderDocBlocks(
  blocks: DocBlock[],
  images: Map<number, DocxImageResource>,
  hyperlinks: Map<string, string>,
) {
  const parts: string[] = [];
  let pageBreakPending = false;
  const paragraph = (content: string, options: ParagraphOptions = {}) => {
    parts.push(paragraphXml(content, { ...options, pageBreakBefore: pageBreakPending }));
    pageBreakPending = false;
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "page-break": {
        pageBreakPending = true;
        break;
      }
      case "heading": {
        // Preview heading scale: h1 28px, h2 30px, h3 23px.
        const size = block.level === 1 ? halfPoints(28) : block.level === 2 ? halfPoints(30) : halfPoints(23);
        const after = block.level === 1 ? twips(32) : block.level === 2 ? twips(22) : twips(12);
        const before = block.level === 3 ? twips(12) : 0;
        paragraph(
          runsXml(
            block.runs,
            {
              sizeHalfPt: size,
              bold: true,
              color:
                block.level === 3 ? "242424" : block.level === 2 ? "222222" : "151F28",
            },
            hyperlinks,
          ),
          {
            spacingAfterTwips: after,
            spacingBeforeTwips: before,
            lineTwips: 276,
            keepNext: true,
            align: block.align,
          },
        );
        break;
      }
      case "paragraph": {
        paragraph(runsXml(block.runs, {}, hyperlinks), {
          spacingAfterTwips: block.mla ? 0 : twips(20),
          lineTwips: block.mla ? 480 : undefined,
          firstLineTwips: block.mla === "body" ? 720 : undefined,
          indentLeftTwips: block.mla === "reference" ? 720 : undefined,
          hangingTwips: block.mla === "reference" ? 720 : undefined,
          align: block.align,
        });
        break;
      }
      case "list-item": {
        paragraph(
          `${runsXml(
            [{ text: `${block.marker} `, bold: false, italic: false }],
            {},
            hyperlinks,
          )}${runsXml(block.runs, {}, hyperlinks)}`,
          {
            spacingAfterTwips: twips(5),
            indentLeftTwips: twips(28),
            hangingTwips: twips(14),
            align: block.align,
          },
        );
        break;
      }
      case "quote": {
        paragraph(runsXml(block.runs, { color: "38464F" }, hyperlinks), {
          spacingAfterTwips: twips(22),
          indentLeftTwips: twips(18),
          borders: `<w:left w:val="single" w:sz="18" w:space="8" w:color="0AA4B5"/>`,
          align: block.align,
        });
        break;
      }
      case "code": {
        const lines = block.text.replace(/\t/g, "  ").split("\n");
        const runs = lines.map((line, index) => ({
          text: index === 0 ? line : `\n${line}`,
          bold: false,
          italic: false,
        }));
        paragraph(
          runsXml(
            runs,
            { font: "Consolas", sizeHalfPt: halfPoints(13.5), color: "E5EDF7" },
            hyperlinks,
          ),
          {
            spacingAfterTwips: twips(14),
            shadingFill: "0F172A",
            lineTwips: Math.round(240 * 1.55),
          },
        );
        break;
      }
      case "caption": {
        paragraph(
          runsXml(
            block.runs,
            { sizeHalfPt: halfPoints(12.5), color: "52677A" },
            hyperlinks,
          ),
          { spacingAfterTwips: twips(10) },
        );
        break;
      }
      case "divider": {
        // Preview thematic divider: dashed line with generous margins.
        paragraph("", {
          spacingBeforeTwips: twips(18),
          spacingAfterTwips: twips(30),
          borders: `<w:bottom w:val="dashed" w:sz="8" w:space="1" w:color="CBD7DF"/>`,
        });
        break;
      }
      case "image": {
        const resource = images.get(block.index);
        if (!resource) {
          paragraph(
            runsXml(
              [{ text: `[Image unavailable: ${block.alt || "figure"}]`, bold: false, italic: true }],
              { sizeHalfPt: halfPoints(12.5), color: "52677A" },
              hyperlinks,
            ),
            { spacingAfterTwips: twips(20), centered: true },
          );
          break;
        }
        const centered = block.layout === "figure" || block.layout === "diagram";
        // OOXML requires drawings inside a run; a bare w:drawing under w:p is
        // invalid and Word drops (or rejects) the picture.
        paragraph(`<w:r>${imageDrawingXml(resource, block.index, block.alt)}</w:r>`, {
          spacingBeforeTwips: block.layout === "figure" ? twips(16) : twips(28),
          spacingAfterTwips: block.caption ? twips(6) : twips(18),
          centered,
          keepNext: Boolean(block.caption),
        });
        if (block.caption) {
          paragraph(
            runsXml(
              [{ text: block.caption, bold: false, italic: false }],
              { sizeHalfPt: halfPoints(12.5), color: "52677A" },
              hyperlinks,
            ),
            { spacingAfterTwips: twips(18), centered },
          );
        }
        break;
      }
      case "table": {
        if (pageBreakPending) {
          paragraph("", { spacingAfterTwips: 0 });
        }
        parts.push(tableXml(block.rows, hyperlinks));
        break;
      }
    }
  }
  if (pageBreakPending) parts.push(paragraphXml("", { pageBreakBefore: true }));
  return parts.join("");
}

/* ------------------------------ OOXML package ------------------------------ */

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:color w:val="242424"/><w:sz w:val="${BODY_SIZE_HALF_PT}"/><w:szCs w:val="${BODY_SIZE_HALF_PT}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="${BODY_LINE_TWIPS}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;

function documentXml(bodyXml: string, mla = false) {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<w:body>${bodyXml}` +
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
    `<w:pgMar w:top="${mla ? 1440 : 1080}" w:right="${mla ? 1440 : 1181}" w:bottom="${mla ? 1440 : 1080}" w:left="${mla ? 1440 : 1181}" w:header="720" w:footer="720" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`
  );
}

function collectHyperlinkRelationships(blocks: DocBlock[]) {
  const relationships = new Map<string, string>();
  const addRuns = (runs: DocRun[]) => {
    runs.forEach((run) => {
      if (run.href && !relationships.has(run.href)) {
        relationships.set(run.href, `rIdLink${relationships.size + 1}`);
      }
    });
  };

  blocks.forEach((block) => {
    if (
      block.kind === "heading" ||
      block.kind === "paragraph" ||
      block.kind === "list-item" ||
      block.kind === "quote" ||
      block.kind === "caption"
    ) {
      addRuns(block.runs);
    } else if (block.kind === "table") {
      block.rows.forEach((row) => row.cells.forEach(addRuns));
    }
  });
  return relationships;
}

function documentRelsXml(
  images: Map<number, DocxImageResource>,
  hyperlinks: Map<string, string>,
) {
  const imageRels = Array.from(images.values())
    .map((resource) => {
      const mode = resource.external ? ` TargetMode="External"` : "";
      return `<Relationship Id="${resource.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${escapeXml(resource.target)}"${mode}/>`;
    })
    .join("");
  const hyperlinkRels = Array.from(hyperlinks.entries())
    .map(
      ([target, relId]) =>
        `<Relationship Id="${escapeXml(relId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(target)}" TargetMode="External"/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `${imageRels}${hyperlinkRels}</Relationships>`
  );
}

/* ZIP writer lives in ooxmlZip.ts, shared with the PPTX exporter. */

/* ------------------------------ entry point ------------------------------ */

export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Builds a genuine .docx for the draft: real OOXML, images embedded as media
 * parts with their full aspect ratio, and page breaks at preview
 * sheet boundaries or explicit document-page-break markers. */
export async function buildDocxExportDocument(
  documentTitle: string,
  contentHtml: string,
  imageProxy?: ExportImageProxy,
): Promise<Uint8Array> {
  if (typeof document === "undefined") {
    const text = contentHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const blocks: DocBlock[] = [
      { kind: "heading", level: 1, runs: [{ text: documentTitle, bold: true, italic: false }] },
      { kind: "paragraph", runs: [{ text, bold: false, italic: false }] },
    ];
    return assembleDocx(blocks, new Map());
  }
  const blocks = parseDocBlocks(contentHtml, documentTitle);
  const images = await loadDocxImageResources(blocks, imageProxy);
  return assembleDocx(blocks, images);
}

function assembleDocx(blocks: DocBlock[], images: Map<number, DocxImageResource>) {
  const encoder = new TextEncoder();
  const hyperlinks = collectHyperlinkRelationships(blocks);
  const bodyXml = renderDocBlocks(blocks, images, hyperlinks);
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", bytes: encoder.encode(CONTENT_TYPES_XML) },
    { name: "_rels/.rels", bytes: encoder.encode(ROOT_RELS_XML) },
    { name: "word/document.xml", bytes: encoder.encode(documentXml(bodyXml, blocks.some(b => b.kind === "paragraph" && b.mla !== undefined))) },
    {
      name: "word/_rels/document.xml.rels",
      bytes: encoder.encode(documentRelsXml(images, hyperlinks)),
    },
    { name: "word/styles.xml", bytes: encoder.encode(STYLES_XML) },
  ];
  for (const resource of images.values()) {
    if (!resource.external && resource.bytes) {
      entries.push({ name: `word/${resource.target}`, bytes: resource.bytes });
    }
  }
  return buildZip(entries);
}
