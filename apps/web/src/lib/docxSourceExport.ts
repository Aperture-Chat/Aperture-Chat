/* Word export for documents opened from Word or PDF ("source layout").
 *
 * The standard draft export (docxExport.ts) renders the editor's own design
 * system: fixed body/heading sizes, uniform table columns, and a title page
 * heading. An imported document instead carries its original formatting
 * explicitly (see documentPageSetup.ts), and exporting it must give that
 * formatting back to Word: the page size and margins, running headers and
 * footers with live PAGE/NUMPAGES fields, every paragraph's spacing, line
 * spacing, indents, alignment, borders, shading and tab stops, run fonts,
 * sizes, colors, highlights and caps, the table grid with merges, borders,
 * shading and cell margins, and pictures at their size. Only page breaks the
 * author made are written as breaks; the sheets the editor paginated are
 * left for Word to lay out, exactly as the source did. */

import {
  cssDeclaration,
  escapeXml,
  isAutomatedTestMode,
  loadExportImage,
  mergeSplitContinuationBlocks,
  normalizeWordColor,
  rasterizeExportImage,
  safeDocumentAnchor,
  safeExternalRelationshipTarget,
  type ExportImageProxy,
} from "./docxExport";
import {
  DOCUMENT_FIELD_PAGES_CLASS,
  DOCUMENT_FIELD_PAGE_CLASS,
  DOCUMENT_TAB_CLASS,
  PREVIEW_PX_PER_PT,
  fontLineFactor,
  primaryFontFamily,
  ptFromPx,
  splitPageSetup,
  type DocumentPageSetup,
} from "./documentPageSetup";
import { buildZip, type ZipEntry } from "./ooxmlZip";

export type SourceDocxResult = { bytes: Uint8Array; warnings: string[] };

const EMU_PER_PT = 12700;
const W_NAMESPACES =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/* ------------------------------ units ------------------------------ */

function twipsFromPx(px: number) {
  return Math.round(ptFromPx(px) * 20);
}

/** A CSS length in preview px (px), points (pt), or ems of the given size. */
function lengthPx(value: string | null | undefined, fontPx: number): number | null {
  if (!value) return null;
  const match = /^(-?\d+(?:\.\d+)?|-?\.\d+)(px|pt|em|rem)?$/i.exec(value.trim());
  if (!match) return value.trim() === "0" ? 0 : null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  switch ((match[2] ?? "px").toLowerCase()) {
    case "pt":
      return number * PREVIEW_PX_PER_PT;
    case "em":
    case "rem":
      return number * fontPx;
    default:
      return number;
  }
}

/** Four-value box shorthand (padding/margin) into its sides. */
function boxSides(value: string | null, fontPx: number) {
  if (!value) return null;
  const parts = value.trim().split(/\s+/).map((part) => lengthPx(part, fontPx));
  if (!parts.length || parts.some((part) => part === null)) return null;
  const [top, right = top, bottom = top, left = right] = parts as number[];
  return { top, right, bottom, left };
}

/* ------------------------------ parts and media ------------------------------ */

type Relationship = { id: string; type: string; target: string; external: boolean };

type MediaStore = { entries: ZipEntry[]; count: number; extensions: Set<string> };

class PartWriter {
  readonly rels: Relationship[] = [];
  private hyperlinks = new Map<string, string>();
  constructor(
    readonly kind: "document" | "header" | "footer",
    private readonly media: MediaStore,
  ) {}

  hyperlink(target: string) {
    const existing = this.hyperlinks.get(target);
    if (existing) return existing;
    const id = `rIdLink${this.hyperlinks.size + 1}`;
    this.hyperlinks.set(target, id);
    this.rels.push({ id, type: "hyperlink", target, external: true });
    return id;
  }

  image(bytes: Uint8Array, extension: "png" | "jpeg") {
    this.media.count += 1;
    this.media.extensions.add(extension);
    const name = `media/source-image${this.media.count}.${extension}`;
    this.media.entries.push({ name: `word/${name}`, bytes });
    const id = `rIdImg${this.media.count}`;
    this.rels.push({ id, type: "image", target: name, external: false });
    return id;
  }

  externalImage(target: string) {
    this.media.count += 1;
    const id = `rIdImg${this.media.count}`;
    this.rels.push({ id, type: "image", target, external: true });
    return id;
  }

  relsXml(extra: Relationship[] = []) {
    const rows = [...extra, ...this.rels]
      .map(
        (rel) =>
          `<Relationship Id="${escapeXml(rel.id)}" Type="${REL_BASE}/${rel.type}" Target="${escapeXml(rel.target)}"${rel.external ? ' TargetMode="External"' : ""}/>`,
      )
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows}</Relationships>`;
  }
}

function decodeDataImage(src: string): { bytes: Uint8Array; extension: "png" | "jpeg" } | null {
  const match = /^data:image\/(png|jpe?g);base64,([a-z0-9+/=\s]+)$/i.exec(src);
  if (!match) return null;
  try {
    const binary = atob(match[2].replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { bytes, extension: match[1].toLowerCase() === "png" ? "png" : "jpeg" };
  } catch {
    return null;
  }
}

/* ------------------------------ formatting model ------------------------------ */

type RunFormat = {
  font: string;
  sizePx: number;
  color?: string;
  shading?: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  caps: boolean;
  smallCaps: boolean;
  vertAlign?: "superscript" | "subscript";
  spacingPx?: number;
  href?: string;
  anchor?: string;
  field?: "page" | "pages";
};

type Writer = {
  part: PartWriter;
  setup: DocumentPageSetup;
  warnings: Set<string>;
  imageProxy?: ExportImageProxy;
  measure: (text: string, format: RunFormat) => number;
};

function styleOf(element: Element) {
  return element.getAttribute("style") ?? "";
}

function formatForElement(element: HTMLElement, inherited: RunFormat): RunFormat {
  const tag = element.tagName;
  const style = styleOf(element);
  const fontFamily = cssDeclaration(style, "font-family");
  const fontSize = lengthPx(cssDeclaration(style, "font-size"), inherited.sizePx);
  const color = normalizeWordColor(cssDeclaration(style, "color"));
  const background = normalizeWordColor(cssDeclaration(style, "background-color"));
  const weight = cssDeclaration(style, "font-weight");
  const fontStyle = cssDeclaration(style, "font-style");
  const decoration = `${cssDeclaration(style, "text-decoration") ?? ""} ${cssDeclaration(style, "text-decoration-line") ?? ""}`;
  const transform = cssDeclaration(style, "text-transform");
  const variant = `${cssDeclaration(style, "font-variant") ?? ""} ${cssDeclaration(style, "font-variant-caps") ?? ""}`;
  const letterSpacing = lengthPx(cssDeclaration(style, "letter-spacing"), inherited.sizePx);
  const rawHref = tag === "A" ? element.getAttribute("href") : null;
  let bold = inherited.bold || tag === "B" || tag === "STRONG";
  if (weight) bold = /^(bold|bolder|[6-9]00)$/i.test(weight) ? true : /^(normal|lighter|[1-5]00)$/i.test(weight) ? false : bold;
  let italic = inherited.italic || tag === "I" || tag === "EM";
  if (fontStyle) italic = /^(italic|oblique)$/i.test(fontStyle);
  return {
    font: fontFamily ? primaryFontFamily(fontFamily) || inherited.font : inherited.font,
    sizePx: fontSize && fontSize > 0 ? fontSize : inherited.sizePx,
    color: color ?? inherited.color,
    shading: background ?? (tag === "MARK" ? "FDE68A" : inherited.shading),
    bold,
    italic,
    underline: inherited.underline || tag === "U" || /\bunderline\b/i.test(decoration),
    strike: inherited.strike || tag === "S" || tag === "STRIKE" || tag === "DEL" || /\bline-through\b/i.test(decoration),
    caps: transform ? /^uppercase$/i.test(transform) : inherited.caps,
    smallCaps: /small-caps/i.test(variant) || inherited.smallCaps,
    vertAlign: tag === "SUP" ? "superscript" : tag === "SUB" ? "subscript" : inherited.vertAlign,
    spacingPx: letterSpacing ?? inherited.spacingPx,
    href: tag === "A" ? safeExternalRelationshipTarget(rawHref, true) ?? undefined : inherited.href,
    anchor: tag === "A" ? safeDocumentAnchor(rawHref) ?? undefined : inherited.anchor,
    field: element.classList.contains(DOCUMENT_FIELD_PAGE_CLASS)
      ? "page"
      : element.classList.contains(DOCUMENT_FIELD_PAGES_CLASS)
        ? "pages"
        : inherited.field,
  };
}

function runPropertiesXml(format: RunFormat) {
  const props: string[] = [];
  const font = escapeXml(format.font || "Calibri");
  props.push(`<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`);
  if (format.bold) props.push("<w:b/><w:bCs/>");
  if (format.italic) props.push("<w:i/><w:iCs/>");
  if (format.caps) props.push("<w:caps/>");
  if (format.smallCaps) props.push("<w:smallCaps/>");
  if (format.strike) props.push("<w:strike/>");
  if (format.color) props.push(`<w:color w:val="${escapeXml(format.color)}"/>`);
  if (format.spacingPx) props.push(`<w:spacing w:val="${twipsFromPx(format.spacingPx)}"/>`);
  const halfPoints = Math.max(2, Math.round(ptFromPx(format.sizePx) * 2));
  props.push(`<w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/>`);
  if (format.underline) props.push('<w:u w:val="single"/>');
  if (format.shading) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${escapeXml(format.shading)}"/>`);
  if (format.vertAlign) props.push(`<w:vertAlign w:val="${format.vertAlign}"/>`);
  return `<w:rPr>${props.join("")}</w:rPr>`;
}

/* ------------------------------ runs ------------------------------ */

type RunPiece =
  | { kind: "text"; text: string; format: RunFormat }
  | { kind: "tab"; format: RunFormat; stop: { kind: string; posTwips: number | null; leader: string; widthPx: number } }
  | { kind: "break"; format: RunFormat }
  | { kind: "image"; format: RunFormat; element: HTMLImageElement };

function collectPieces(node: Node, format: RunFormat, pieces: RunPiece[]) {
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? "";
      if (text) pieces.push({ kind: "text", text, format });
      return;
    }
    if (!(child instanceof HTMLElement)) return;
    if (child.classList.contains("document-page-label")) return;
    if (child.classList.contains("document-signature-line")) {
      // A fill-in rule is an underlined tab as wide as the rule on screen
      // (min-width 15em), so it stays one unbroken line in Word.
      const widthPx = Math.max(15 * format.sizePx, lengthPx(cssDeclaration(styleOf(child), "width"), format.sizePx) ?? 0);
      pieces.push({
        kind: "tab",
        format: { ...format, underline: true },
        stop: { kind: "left", posTwips: null, leader: "none", widthPx },
      });
      return;
    }
    if (child.classList.contains(DOCUMENT_TAB_CLASS)) {
      const classes = Array.from(child.classList);
      const kind = classes.find((name) => /^document-tab-(left|right|center|decimal)$/.test(name))?.slice(13) ?? "left";
      const at = classes.find((name) => /^document-tab-at-\d+$/.test(name));
      const border = cssDeclaration(styleOf(child), "border-bottom") ?? "";
      const leader = /dotted/i.test(border) ? "dot" : /dashed/i.test(border) ? "hyphen" : /solid/i.test(border) ? "underscore" : "none";
      pieces.push({
        kind: "tab",
        format,
        stop: {
          kind,
          posTwips: at ? Number(at.slice(16)) : null,
          leader,
          widthPx: lengthPx(cssDeclaration(styleOf(child), "width"), format.sizePx) ?? 0,
        },
      });
      return;
    }
    const tag = child.tagName;
    if (tag === "BR") {
      pieces.push({ kind: "break", format });
      return;
    }
    if (tag === "IMG") {
      pieces.push({ kind: "image", format, element: child as HTMLImageElement });
      return;
    }
    if (tag === "TABLE" || tag === "FIGURE") return;
    collectPieces(child, formatForElement(child, format), pieces);
  });
}

/** HTML whitespace rules applied to the run text: collapsible spaces fold to
 * one and vanish at the paragraph's edges; non-breaking spaces stay. */
function normalizePieceWhitespace(pieces: RunPiece[]) {
  let previousSpace = true;
  pieces.forEach((piece) => {
    if (piece.kind === "text") {
      let out = "";
      for (const char of piece.text.replace(/[\t\n\r\f ]+/g, " ")) {
        if (char === " ") {
          if (previousSpace) continue;
          previousSpace = true;
        } else {
          previousSpace = false;
        }
        out += char;
      }
      piece.text = out;
    } else if (piece.kind === "break") {
      previousSpace = true;
    } else {
      previousSpace = false;
    }
  });
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index];
    if (piece.kind !== "text") break;
    piece.text = piece.text.replace(/ +$/, "");
    if (piece.text) break;
  }
}

type ParagraphContext = { leftPx: number; firstLinePx: number };

/** Tab stops for the paragraph: the stop each spacer recorded on import, or
 * (for spacers without one, such as PDF columns) where the spacer ends when
 * the line is measured. */
function tabStops(pieces: RunPiece[], writer: Writer, paragraph: ParagraphContext) {
  const stops = new Map<number, { kind: string; leader: string }>();
  let x = paragraph.firstLinePx;
  pieces.forEach((piece) => {
    if (piece.kind === "text") x += writer.measure(piece.text, piece.format);
    else if (piece.kind === "break") x = paragraph.leftPx;
    else if (piece.kind === "image") x += lengthPx(cssDeclaration(styleOf(piece.element), "width"), piece.format.sizePx) ?? 0;
    else if (piece.kind === "tab") {
      x += piece.stop.widthPx;
      const pos = piece.stop.posTwips ?? twipsFromPx(x);
      if (!stops.has(pos)) {
        stops.set(pos, {
          kind: piece.stop.posTwips === null ? "left" : piece.stop.kind,
          leader: piece.stop.leader,
        });
      }
    }
  });
  if (!stops.size) return "";
  return `<w:tabs>${Array.from(stops.entries())
    .sort((a, b) => a[0] - b[0])
    .map(
      ([pos, stop]) =>
        `<w:tab w:val="${stop.kind}"${stop.leader !== "none" ? ` w:leader="${stop.leader}"` : ""} w:pos="${pos}"/>`,
    )
    .join("")}</w:tabs>`;
}

async function imageRunXml(writer: Writer, element: HTMLImageElement, format: RunFormat, index: number) {
  const src = element.getAttribute("src") ?? "";
  const style = styleOf(element);
  let widthPx = lengthPx(cssDeclaration(style, "width"), format.sizePx) ?? (Number(element.getAttribute("width")) || 0);
  let heightPx = lengthPx(cssDeclaration(style, "height"), format.sizePx) ?? (Number(element.getAttribute("height")) || 0);
  let relId: string | null = null;
  const decoded = decodeDataImage(src);
  if (decoded) {
    relId = writer.part.image(decoded.bytes, decoded.extension);
  } else if (!isAutomatedTestMode()) {
    const loaded = await loadExportImage(src, writer.imageProxy);
    const bytes = loaded ? rasterizeExportImage(loaded) : null;
    if (loaded && (!widthPx || !heightPx)) {
      widthPx = widthPx || loaded.width;
      heightPx = heightPx || loaded.height;
    }
    if (bytes) relId = writer.part.image(bytes, "jpeg");
  }
  if (!relId) {
    const external = safeExternalRelationshipTarget(src);
    if (external) relId = writer.part.externalImage(external);
  }
  if (!relId) {
    writer.warnings.add("A picture could not be read and was left out of the Word file.");
    return "";
  }
  if (!widthPx || !heightPx) {
    widthPx = widthPx || 300;
    heightPx = heightPx || 200;
  }
  const cx = Math.round(ptFromPx(widthPx) * EMU_PER_PT);
  const cy = Math.round(ptFromPx(heightPx) * EMU_PER_PT);
  const alt = escapeXml(element.getAttribute("alt") ?? "");
  const id = 2000 + index;
  const external = writer.part.rels.find((rel) => rel.id === relId)?.external;
  return (
    `<w:r>${runPropertiesXml(format)}<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip ${external ? "r:link" : "r:embed"}="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

let pictureCounter = 0;

async function runsXml(writer: Writer, pieces: RunPiece[]) {
  const out: string[] = [];
  let index = 0;
  while (index < pieces.length) {
    const piece = pieces[index];
    // Keep a hyperlink's pieces together inside one w:hyperlink.
    const link = piece.format.href ?? (piece.format.anchor ? `#${piece.format.anchor}` : undefined);
    let end = index + 1;
    while (
      end < pieces.length &&
      (pieces[end].format.href ?? (pieces[end].format.anchor ? `#${pieces[end].format.anchor}` : undefined)) === link
    ) {
      end += 1;
    }
    const group: string[] = [];
    for (let cursor = index; cursor < end; cursor += 1) {
      const current = pieces[cursor];
      if (current.kind === "text") {
        if (!current.text) continue;
        const text = `<w:t xml:space="preserve">${escapeXml(current.text)}</w:t>`;
        if (current.format.field && writer.part.kind !== "document") {
          // A complex field keeps the result's run formatting in every reader.
          const rPr = runPropertiesXml(current.format);
          const instruction = current.format.field === "page" ? " PAGE " : " NUMPAGES ";
          group.push(
            `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r>` +
              `<w:r>${rPr}<w:instrText xml:space="preserve">${instruction}</w:instrText></w:r>` +
              `<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r>` +
              `<w:r>${rPr}${text}</w:r>` +
              `<w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`,
          );
        } else {
          group.push(`<w:r>${runPropertiesXml(current.format)}${text}</w:r>`);
        }
      } else if (current.kind === "tab") {
        group.push(`<w:r>${runPropertiesXml(current.format)}<w:tab/></w:r>`);
      } else if (current.kind === "break") {
        group.push(`<w:r>${runPropertiesXml(current.format)}<w:br/></w:r>`);
      } else {
        pictureCounter += 1;
        group.push(await imageRunXml(writer, current.element, current.format, pictureCounter));
      }
    }
    const body = group.join("");
    if (link && piece.format.href) {
      out.push(`<w:hyperlink r:id="${writer.part.hyperlink(piece.format.href)}" w:history="1">${body}</w:hyperlink>`);
    } else if (link && piece.format.anchor) {
      out.push(`<w:hyperlink w:anchor="${escapeXml(piece.format.anchor)}" w:history="1">${body}</w:hyperlink>`);
    } else {
      out.push(body);
    }
    index = end;
  }
  return out.join("");
}

/* ------------------------------ paragraphs ------------------------------ */

type BlockScope = {
  /** Paragraph spacing the CSS gives blocks without their own margins. */
  defaultBeforePx: number;
  defaultAfterPx: number;
  format: RunFormat;
  pendingPageBreak: { value: boolean };
};

function borderXml(side: string, value: string | null) {
  if (!value) return "";
  if (/^(none|0)$/i.test(value.trim())) return `<w:${side} w:val="nil"/>`;
  // Width and color may be omitted (a re-serialized currentcolor border).
  const match = /^(?:(\d+(?:\.\d+)?)(px|pt)\s+)?(solid|double|dotted|dashed)(?:\s+(.+))?$/i.exec(value.trim());
  if (!match) return "";
  const width = match[1] ? Number(match[1]) : 1;
  const widthPt = (match[2] ?? "px").toLowerCase() === "pt" ? width : ptFromPx(width);
  const style = match[3].toLowerCase() === "solid" ? "single" : match[3].toLowerCase();
  const color = (match[4] ? normalizeWordColor(match[4]) : undefined) ?? "auto";
  return `<w:${side} w:val="${style}" w:sz="${Math.max(2, Math.min(96, Math.round(widthPt * 8)))}" w:space="0" w:color="${color}"/>`;
}

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

async function paragraphXml(
  writer: Writer,
  element: HTMLElement,
  scope: BlockScope,
  options: { markerText?: string; markerFormat?: RunFormat; listIndentPx?: number; hangingPx?: number } = {},
) {
  const style = styleOf(element);
  const format = formatForElement(element, scope.format);
  const fontPx = format.sizePx;
  const declared = (name: string) => cssDeclaration(style, name);
  const margins = boxSides(declared("margin"), fontPx);
  const before = lengthPx(declared("margin-top"), fontPx) ?? margins?.top ?? scope.defaultBeforePx;
  const after = lengthPx(declared("margin-bottom"), fontPx) ?? margins?.bottom ?? scope.defaultAfterPx;
  const left = (lengthPx(declared("margin-left"), fontPx) ?? margins?.left ?? 0) + (options.listIndentPx ?? 0);
  // A block narrower than the column (a short rule, a boxed note) keeps its
  // width in Word as a right indent.
  const columnPx = (writer.setup.widthPt - writer.setup.marginLeftPt - writer.setup.marginRightPt) * PREVIEW_PX_PER_PT;
  const widthPx = lengthPx(declared("width"), fontPx);
  const right =
    lengthPx(declared("margin-right"), fontPx) ??
    margins?.right ??
    (widthPx && widthPx < columnPx ? Math.max(0, columnPx - left - widthPx) : 0);
  const indent = options.hangingPx !== undefined ? -options.hangingPx : lengthPx(declared("text-indent"), fontPx) ?? 0;

  const pieces: RunPiece[] = [];
  if (options.markerText) {
    pieces.push({ kind: "text", text: options.markerText, format: options.markerFormat ?? format });
    pieces.push({
      kind: "tab",
      format,
      stop: { kind: "left", posTwips: twipsFromPx(left), leader: "none", widthPx: options.hangingPx ?? 0 },
    });
  }
  collectPieces(element, format, pieces);
  normalizePieceWhitespace(pieces);

  const props: string[] = [];
  if (HEADING_TAGS.has(element.tagName)) props.push(`<w:pStyle w:val="Heading${element.tagName.slice(1)}"/>`);
  // Headings, signature lead-ins, and signature lines stay with what follows.
  if (HEADING_TAGS.has(element.tagName) || element.classList.contains("document-keep-next")) {
    props.push("<w:keepNext/>");
  }
  if (scope.pendingPageBreak.value) {
    props.push("<w:pageBreakBefore/>");
    scope.pendingPageBreak.value = false;
  }
  const borders = ["top", "left", "bottom", "right"]
    .map((side) => borderXml(side, declared(`border-${side}`) ?? declared("border")))
    .join("");
  if (borders.replace(/<w:\w+ w:val="nil"\/>/g, "")) props.push(`<w:pBdr>${borders}</w:pBdr>`);
  const background = normalizeWordColor(declared("background-color"));
  if (background) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${background}"/>`);
  props.push(tabStops(pieces, writer, { leftPx: left, firstLinePx: left + indent }));
  if (element.getAttribute("dir") === "rtl") props.push("<w:bidi/>");

  const lineHeight = declared("line-height") ?? String(writer.setup.lineHeight);
  let lineXml: string;
  const unitless = /^\d+(?:\.\d+)?$/.test(lineHeight.trim());
  if (unitless) {
    const multiple = Number(lineHeight) / fontLineFactor(format.font);
    lineXml = `w:line="${Math.max(120, Math.round(240 * multiple))}" w:lineRule="auto"`;
  } else {
    const px = lengthPx(lineHeight, fontPx);
    lineXml = px ? `w:line="${twipsFromPx(px)}" w:lineRule="exact"` : `w:line="240" w:lineRule="auto"`;
  }
  props.push(`<w:spacing w:before="${twipsFromPx(Math.max(0, before))}" w:after="${twipsFromPx(Math.max(0, after))}" ${lineXml}/>`);
  const indParts: string[] = [];
  if (left) indParts.push(`w:left="${twipsFromPx(left)}"`);
  if (right) indParts.push(`w:right="${twipsFromPx(right)}"`);
  if (indent > 0) indParts.push(`w:firstLine="${twipsFromPx(indent)}"`);
  if (indent < 0) indParts.push(`w:hanging="${twipsFromPx(-indent)}"`);
  if (indParts.length) props.push(`<w:ind ${indParts.join(" ")}/>`);
  const align = declared("text-align");
  if (align === "center" || align === "right" || align === "justify") {
    props.push(`<w:jc w:val="${align === "justify" ? "both" : align}"/>`);
  }
  const outline = HEADING_TAGS.has(element.tagName) ? `<w:outlineLvl w:val="${Number(element.tagName.slice(1)) - 1}"/>` : "";
  props.push(outline);
  return `<w:p><w:pPr>${props.join("")}</w:pPr>${await runsXml(writer, pieces)}</w:p>`;
}

/* ------------------------------ lists ------------------------------ */

function listMarker(type: string, value: number) {
  const roman = (input: number) => {
    const table: Array<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let remaining = input;
    let result = "";
    table.forEach(([amount, numeral]) => {
      while (remaining >= amount) {
        result += numeral;
        remaining -= amount;
      }
    });
    return result;
  };
  const letter = (input: number) => String.fromCharCode(97 + ((Math.max(1, input) - 1) % 26));
  switch (type) {
    case "lower-alpha":
    case "lower-latin":
      return `${letter(value)}.`;
    case "upper-alpha":
    case "upper-latin":
      return `${letter(value).toUpperCase()}.`;
    case "lower-roman":
      return `${roman(value)}.`;
    case "upper-roman":
      return `${roman(value).toUpperCase()}.`;
    case "decimal-leading-zero":
      return `${value < 10 ? "0" : ""}${value}.`;
    case "circle":
      return "\u25e6";
    case "square":
      return "\u25aa";
    case "none":
      return "";
    default:
      return "";
  }
}

async function listXml(writer: Writer, list: HTMLElement, scope: BlockScope, depthIndentPx: number): Promise<string> {
  const ordered = list.tagName === "OL";
  const style = styleOf(list);
  const fontPx = formatForElement(list, scope.format).sizePx;
  const declaredType = cssDeclaration(style, "list-style-type");
  const typeAttr = list.getAttribute("type");
  const type =
    declaredType ??
    (typeAttr === "a" ? "lower-alpha" : typeAttr === "A" ? "upper-alpha" : typeAttr === "i" ? "lower-roman" : typeAttr === "I" ? "upper-roman" : ordered ? "decimal" : "disc");
  const padding = lengthPx(cssDeclaration(style, "padding-left"), fontPx) ?? 2.5 * fontPx;
  const indentPx = depthIndentPx + padding + (lengthPx(cssDeclaration(style, "margin-left"), fontPx) ?? 0);
  let counter = Number(list.getAttribute("start") ?? "1") || 1;
  const parts: string[] = [];
  for (const item of Array.from(list.children)) {
    if (!(item instanceof HTMLElement) || item.tagName !== "LI") continue;
    const explicit = Number(item.getAttribute("value"));
    if (Number.isFinite(explicit) && explicit > 0) counter = explicit;
    const marker = ordered ? listMarker(type, counter) || `${counter}.` : listMarker(type, counter) || "\u2022";
    counter += 1;
    // Nested lists render after their item's own text.
    const nested = Array.from(item.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && (child.tagName === "UL" || child.tagName === "OL"),
    );
    nested.forEach((child) => child.remove());
    parts.push(
      await paragraphXml(writer, item, scope, {
        markerText: marker,
        listIndentPx: indentPx - (lengthPx(cssDeclaration(styleOf(item), "margin-left"), fontPx) ?? 0),
        hangingPx: Math.min(indentPx, Math.max(fontPx * 1.2, padding * 0.6)),
      }),
    );
    for (const child of nested) parts.push(await listXml(writer, child, scope, indentPx));
  }
  return parts.join("");
}

/* ------------------------------ tables ------------------------------ */

type GridCell = { element: HTMLTableCellElement; column: number; span: number; rowSpan: number };

async function tableXml(writer: Writer, table: HTMLTableElement, scope: BlockScope) {
  const style = styleOf(table);
  const fontPx = formatForElement(table, scope.format).sizePx;
  const rows = Array.from(table.rows);
  // Lay cells onto a grid, honoring rowspans from rows above.
  const occupied: boolean[][] = rows.map(() => []);
  const placed: GridCell[][] = rows.map(() => []);
  rows.forEach((row, rowIndex) => {
    let column = 0;
    Array.from(row.cells).forEach((cell) => {
      while (occupied[rowIndex][column]) column += 1;
      const span = Math.max(1, cell.colSpan || 1);
      const rowSpan = Math.max(1, Math.min(rows.length - rowIndex, cell.rowSpan || 1));
      for (let r = rowIndex; r < rowIndex + rowSpan; r += 1) {
        for (let c = column; c < column + span; c += 1) occupied[r][c] = true;
      }
      placed[rowIndex].push({ element: cell, column, span, rowSpan });
      column += span;
    });
  });
  const columnCount = Math.max(1, ...occupied.map((row) => row.length));
  const contentWidthPx =
    (writer.setup.widthPt - writer.setup.marginLeftPt - writer.setup.marginRightPt) * PREVIEW_PX_PER_PT;
  const tableWidthPx = lengthPx(cssDeclaration(style, "width"), fontPx) ?? contentWidthPx;
  const colWidths = Array.from(table.querySelectorAll(":scope > colgroup > col")).map(
    (col) => lengthPx(cssDeclaration(styleOf(col), "width"), fontPx) ?? 0,
  );
  const grid = Array.from({ length: columnCount }, (_, index) => colWidths[index] || tableWidthPx / columnCount);
  const gridTwips = grid.map((width) => Math.max(1, twipsFromPx(width)));
  const props: string[] = [`<w:tblW w:w="${gridTwips.reduce((sum, width) => sum + width, 0)}" w:type="dxa"/>`];
  const marginLeft = cssDeclaration(style, "margin-left");
  const marginRight = cssDeclaration(style, "margin-right");
  if (marginLeft === "auto" && marginRight === "auto") props.push('<w:jc w:val="center"/>');
  else if (marginLeft === "auto") props.push('<w:jc w:val="right"/>');
  else {
    const indent = lengthPx(marginLeft, fontPx);
    if (indent) props.push(`<w:tblInd w:w="${twipsFromPx(indent)}" w:type="dxa"/>`);
  }
  props.push('<w:tblLayout w:type="fixed"/>');
  props.push('<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>');

  const cellScope: BlockScope = { ...scope, defaultBeforePx: 0, defaultAfterPx: 0 };
  const rowXml: string[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const trProps: string[] = [];
    const height = lengthPx(cssDeclaration(styleOf(row), "height"), fontPx);
    if (height) trProps.push(`<w:trHeight w:val="${twipsFromPx(height)}" w:hRule="atLeast"/>`);
    if (row.parentElement?.tagName === "THEAD") trProps.push("<w:tblHeader/>");
    // A signature block row never breaks across pages.
    if (table.classList.contains("document-signature-table")) trProps.push("<w:cantSplit/>");
    const cells: string[] = [];
    // Merged continuations appear as vMerge cells in later rows.
    const continuing = new Map<number, GridCell>();
    for (let above = 0; above < rowIndex; above += 1) {
      placed[above].forEach((cell) => {
        if (cell.rowSpan > 1 && above + cell.rowSpan > rowIndex) continuing.set(cell.column, cell);
      });
    }
    const ownCells = new Map(placed[rowIndex].map((cell) => [cell.column, cell]));
    let column = 0;
    while (column < columnCount) {
      const own = ownCells.get(column);
      const merged = continuing.get(column);
      const cell = own ?? merged;
      if (!cell) {
        cells.push(`<w:tc><w:tcPr><w:tcW w:w="${gridTwips[column]}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`);
        column += 1;
        continue;
      }
      const width = gridTwips.slice(column, column + cell.span).reduce((sum, value) => sum + value, 0);
      const cellStyle = styleOf(cell.element);
      const tcPr: string[] = [`<w:tcW w:w="${width}" w:type="dxa"/>`];
      if (cell.span > 1) tcPr.push(`<w:gridSpan w:val="${cell.span}"/>`);
      if (cell.rowSpan > 1 || merged) tcPr.push(own ? '<w:vMerge w:val="restart"/>' : "<w:vMerge/>");
      const borders = ["top", "left", "bottom", "right"]
        .map((side) => borderXml(side, cssDeclaration(cellStyle, `border-${side}`) ?? cssDeclaration(cellStyle, "border")))
        .join("");
      if (borders) tcPr.push(`<w:tcBorders>${borders}</w:tcBorders>`);
      const shade = normalizeWordColor(cssDeclaration(cellStyle, "background-color"));
      if (shade) tcPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>`);
      const padding = boxSides(cssDeclaration(cellStyle, "padding"), fontPx) ?? { top: 0, right: 7.96, bottom: 0, left: 7.96 };
      const side = (name: "top" | "right" | "bottom" | "left") =>
        lengthPx(cssDeclaration(cellStyle, `padding-${name}`), fontPx) ?? padding[name];
      tcPr.push(
        `<w:tcMar><w:top w:w="${twipsFromPx(side("top"))}" w:type="dxa"/><w:left w:w="${twipsFromPx(side("left"))}" w:type="dxa"/><w:bottom w:w="${twipsFromPx(side("bottom"))}" w:type="dxa"/><w:right w:w="${twipsFromPx(side("right"))}" w:type="dxa"/></w:tcMar>`,
      );
      const vAlign = cssDeclaration(cellStyle, "vertical-align");
      if (vAlign === "middle") tcPr.push('<w:vAlign w:val="center"/>');
      else if (vAlign === "bottom") tcPr.push('<w:vAlign w:val="bottom"/>');
      let content = "<w:p/>";
      if (own) {
        const cellFormat = formatForElement(cell.element, scope.format);
        const inner = await blocksXml(writer, Array.from(cell.element.childNodes), { ...cellScope, format: cellFormat });
        if (inner) content = inner;
      }
      cells.push(`<w:tc><w:tcPr>${tcPr.join("")}</w:tcPr>${content}</w:tc>`);
      column += cell.span;
    }
    rowXml.push(`<w:tr>${trProps.length ? `<w:trPr>${trProps.join("")}</w:trPr>` : ""}${cells.join("")}</w:tr>`);
  }
  return `<w:tbl><w:tblPr>${props.join("")}</w:tblPr><w:tblGrid>${gridTwips
    .map((width) => `<w:gridCol w:w="${width}"/>`)
    .join("")}</w:tblGrid>${rowXml.join("")}</w:tbl>`;
}

/* ------------------------------ blocks ------------------------------ */

const INLINE_TAGS = new Set(["A", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL", "INS", "MARK", "SPAN", "SUP", "SUB", "CODE", "BR", "IMG", "SMALL", "CITE", "Q", "TIME"]);

async function blocksXml(writer: Writer, nodes: Node[], scope: BlockScope): Promise<string> {
  const out: string[] = [];
  let inline: Node[] = [];
  const flushInline = async () => {
    if (!inline.some((node) => (node.textContent ?? "").trim() || (node instanceof HTMLElement && node.querySelector?.("img")) || (node instanceof HTMLElement && node.tagName === "IMG"))) {
      inline = [];
      return;
    }
    const holder = document.createElement("p");
    inline.forEach((node) => holder.appendChild(node.cloneNode(true)));
    inline = [];
    out.push(await paragraphXml(writer, holder, scope));
  };
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE || (node instanceof HTMLElement && INLINE_TAGS.has(node.tagName))) {
      inline.push(node);
      continue;
    }
    await flushInline();
    if (!(node instanceof HTMLElement)) continue;
    if (node.classList.contains("document-page-label")) continue;
    const tag = node.tagName;
    if (tag === "HR") {
      if (node.classList.contains("document-page-break")) {
        scope.pendingPageBreak.value = true;
      } else {
        out.push(
          `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>`,
        );
      }
      continue;
    }
    if (tag === "TABLE") {
      if (scope.pendingPageBreak.value) {
        // A table cannot break the page itself; its first paragraph does.
        out.push(`<w:p><w:pPr><w:pageBreakBefore/><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>`);
        scope.pendingPageBreak.value = false;
      }
      out.push(await tableXml(writer, node as HTMLTableElement, scope));
      continue;
    }
    if (tag === "UL" || tag === "OL") {
      out.push(await listXml(writer, node.cloneNode(true) as HTMLElement, scope, 0));
      continue;
    }
    if (tag === "FIGURE") {
      const image = node.querySelector("img");
      if (image) {
        const holder = document.createElement("p");
        holder.setAttribute("style", "text-align: center");
        holder.appendChild(image.cloneNode(true));
        out.push(await paragraphXml(writer, holder, scope));
      }
      const caption = node.querySelector("figcaption")?.textContent?.trim();
      if (caption) {
        const holder = document.createElement("p");
        holder.setAttribute("style", "text-align: center");
        holder.textContent = caption;
        out.push(await paragraphXml(writer, holder, scope));
      }
      continue;
    }
    if (tag === "PRE") {
      const holder = document.createElement("p");
      holder.setAttribute("style", `font-family: Consolas; ${styleOf(node)}`);
      (node.textContent ?? "").split("\n").forEach((line, index) => {
        if (index) holder.appendChild(document.createElement("br"));
        holder.appendChild(document.createTextNode(line.replace(/ /g, "\u00a0")));
      });
      out.push(await paragraphXml(writer, holder, scope));
      continue;
    }
    const hasBlockChildren = Array.from(node.children).some(
      (child) => !INLINE_TAGS.has(child.tagName),
    );
    if ((tag === "DIV" || tag === "SECTION" || tag === "ARTICLE" || tag === "BLOCKQUOTE") && hasBlockChildren) {
      out.push(await blocksXml(writer, Array.from(node.childNodes), { ...scope, format: formatForElement(node, scope.format) }));
      continue;
    }
    out.push(await paragraphXml(writer, node, scope));
  }
  await flushInline();
  return out.join("");
}

/* ------------------------------ package ------------------------------ */

function stylesXml(setup: DocumentPageSetup) {
  const font = escapeXml(primaryFontFamily(setup.fontFamily) || "Calibri");
  const size = Math.max(2, Math.round(ptFromPx(setup.fontSizePx) * 2));
  const color = normalizeWordColor(setup.color) ?? "000000";
  const line = Math.max(120, Math.round((240 * setup.lineHeight) / fontLineFactor(setup.fontFamily)));
  const headings = [1, 2, 3, 4, 5, 6]
    .map(
      (level) =>
        `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${level - 1}"/></w:pPr></w:style>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${W_NAMESPACES}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:before="${twipsFromPx(setup.paragraphBeforePx)}" w:after="${twipsFromPx(setup.paragraphAfterPx)}" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>` +
    `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
    headings +
    `</w:styles>`
  );
}

const TRAILING_PARAGRAPH =
  '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>';

const SETTINGS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>` +
  // Lines ending in a manual line break are not stretched in justified
  // paragraphs, and space after one paragraph adds to space before the next,
  // so Word and LibreOffice lay pages out as the editor and print do.
  `<w:compat><w:doNotExpandShiftReturn/><w:doNotUseHTMLParagraphAutoSpacing/><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

function contentTypesXml(media: MediaStore, parts: Array<{ name: string; type: "header" | "footer" }>) {
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...(media.extensions.has("png") ? ['<Default Extension="png" ContentType="image/png"/>'] : []),
    ...(media.extensions.has("jpeg") ? ['<Default Extension="jpeg" ContentType="image/jpeg"/>'] : []),
  ];
  const overrides = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>',
    ...parts.map(
      (part) =>
        `<Override PartName="/word/${part.name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${part.type}+xml"/>`,
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join("")}${overrides.join("")}</Types>`;
}

function createMeasurer() {
  let context: CanvasRenderingContext2D | null = null;
  const jsdom = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
  if (!jsdom && typeof document !== "undefined") {
    try {
      context = document.createElement("canvas").getContext("2d");
    } catch {
      context = null;
    }
  }
  return (text: string, format: RunFormat) => {
    const size = format.vertAlign ? format.sizePx * 0.65 : format.sizePx;
    if (!context) return text.length * size * 0.5;
    context.font = `${format.italic ? "italic " : ""}${format.bold ? "700" : "400"} ${size}px '${format.font}'`;
    return context.measureText(format.caps ? text.toUpperCase() : text).width;
  };
}

/** Builds the .docx for a document that carries a source page setup. */
export async function buildSourceLayoutDocx(
  contentHtml: string,
  imageProxy?: ExportImageProxy,
): Promise<SourceDocxResult> {
  const { setup, bodyHtml } = splitPageSetup(contentHtml);
  if (!setup) throw new Error("This document has no source page setup.");
  pictureCounter = 0;
  const template = document.createElement("template");
  template.innerHTML = bodyHtml;
  template.content.querySelectorAll(".document-page-label, .document-page-setup").forEach((node) => node.remove());
  mergeSplitContinuationBlocks(template.content);
  // Sheets the editor paginated are not breaks; the author's are.
  template.content.querySelectorAll("section.document-page").forEach((page, index) => {
    if (index > 0 && page.getAttribute("data-page-break-before") === "manual") {
      const marker = document.createElement("hr");
      marker.className = "document-page-break";
      page.before(marker);
    }
    page.replaceWith(...Array.from(page.childNodes));
  });

  const warnings = new Set<string>();
  const media: MediaStore = { entries: [], count: 0, extensions: new Set() };
  const measure = createMeasurer();
  const baseFormat: RunFormat = {
    font: primaryFontFamily(setup.fontFamily) || "Calibri",
    sizePx: setup.fontSizePx,
    color: normalizeWordColor(setup.color),
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    caps: false,
    smallCaps: false,
  };
  const scopeFor = (): BlockScope => ({
    defaultBeforePx: setup.paragraphBeforePx,
    defaultAfterPx: setup.paragraphAfterPx,
    format: baseFormat,
    pendingPageBreak: { value: false },
  });

  const documentPart = new PartWriter("document", media);
  const documentWriter: Writer = { part: documentPart, setup, warnings, imageProxy, measure };
  let bodyXml = await blocksXml(documentWriter, Array.from(template.content.childNodes), scopeFor());
  // Word requires a paragraph after a final table, and an empty body still
  // needs one paragraph.
  // Word needs a paragraph after a closing table (a signature block); a
  // one-point paragraph keeps it from spilling onto a blank last page.
  if (!bodyXml) bodyXml = "<w:p/>";
  else if (bodyXml.endsWith("</w:tbl>")) bodyXml += TRAILING_PARAGRAPH;

  const extraParts: Array<{ name: string; type: "header" | "footer"; xml: string; rels: string; relId: string; reference: "default" | "first" }> = [];
  const chromeSources: Array<{ html: string | null; type: "header" | "footer"; reference: "default" | "first" }> = [
    { html: setup.headerHtml, type: "header", reference: "default" },
    { html: setup.footerHtml, type: "footer", reference: "default" },
    { html: setup.firstHeaderHtml, type: "header", reference: "first" },
    { html: setup.firstFooterHtml, type: "footer", reference: "first" },
  ];
  for (const source of chromeSources) {
    if (source.html === null) continue;
    // An empty first-page variant still needs a part: it blanks page one.
    if (!source.html.trim() && source.reference === "default") continue;
    const part = new PartWriter(source.type, media);
    const holder = document.createElement("template");
    holder.innerHTML = source.html;
    const writer: Writer = { part, setup, warnings, imageProxy, measure };
    const blocks = (await blocksXml(writer, Array.from(holder.content.childNodes), {
      ...scopeFor(),
      defaultBeforePx: 0,
      defaultAfterPx: 0,
    })) || "<w:p/>";
    const root = source.type === "header" ? "w:hdr" : "w:ftr";
    const index = extraParts.length + 1;
    const name = `${source.type}${index}.xml`;
    extraParts.push({
      name,
      type: source.type,
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${root} ${W_NAMESPACES}>${blocks.endsWith("</w:tbl>") ? `${blocks}${TRAILING_PARAGRAPH}` : blocks}</${root}>`,
      rels: part.relsXml(),
      relId: `rIdPart${index}`,
      reference: source.reference,
    });
  }

  const twips = (pt: number) => Math.round(pt * 20);
  const references = [
    ...extraParts.filter((part) => part.type === "header").map((part) => `<w:headerReference w:type="${part.reference}" r:id="${part.relId}"/>`),
    ...extraParts.filter((part) => part.type === "footer").map((part) => `<w:footerReference w:type="${part.reference}" r:id="${part.relId}"/>`),
  ].join("");
  const landscape = setup.widthPt > setup.heightPt;
  const titlePage = setup.firstHeaderHtml !== null || setup.firstFooterHtml !== null;
  const sectPr =
    `<w:sectPr>${references}<w:pgSz w:w="${twips(setup.widthPt)}" w:h="${twips(setup.heightPt)}"${landscape ? ' w:orient="landscape"' : ""}/>` +
    `<w:pgMar w:top="${twips(setup.marginTopPt)}" w:right="${twips(setup.marginRightPt)}" w:bottom="${twips(setup.marginBottomPt)}" w:left="${twips(setup.marginLeftPt)}" w:header="${twips(setup.headerDistancePt)}" w:footer="${twips(setup.footerDistancePt)}" w:gutter="0"/>` +
    `${titlePage ? "<w:titlePg/>" : ""}</w:sectPr>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NAMESPACES}><w:body>${bodyXml}${sectPr}</w:body></w:document>`;

  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", bytes: encoder.encode(contentTypesXml(media, extraParts)) },
    {
      name: "_rels/.rels",
      bytes: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_BASE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
    },
    { name: "word/document.xml", bytes: encoder.encode(documentXml) },
    {
      name: "word/_rels/document.xml.rels",
      bytes: encoder.encode(
        documentPart.relsXml([
          { id: "rIdStyles", type: "styles", target: "styles.xml", external: false },
          { id: "rIdSettings", type: "settings", target: "settings.xml", external: false },
          ...extraParts.map((part) => ({ id: part.relId, type: part.type, target: part.name, external: false })),
        ]),
      ),
    },
    { name: "word/styles.xml", bytes: encoder.encode(stylesXml(setup)) },
    { name: "word/settings.xml", bytes: encoder.encode(SETTINGS_XML) },
    ...extraParts.flatMap((part) => [
      { name: `word/${part.name}`, bytes: encoder.encode(part.xml) },
      { name: `word/_rels/${part.name}.rels`, bytes: encoder.encode(part.rels) },
    ]),
    ...media.entries,
  ];
  return { bytes: buildZip(entries), warnings: Array.from(warnings) };
}
