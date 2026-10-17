/* Word (.docx/.dotx) → editable document HTML that keeps the source's look.
 *
 * This reads the WordprocessingML package directly instead of going through
 * a semantic converter, because the drafter's rule for opened documents is
 * that formatting must not change: fonts, sizes, colors, highlights, caps,
 * paragraph alignment, indents, spacing, line spacing, borders and shading,
 * numbering exactly as Word draws it, tab stops, tables (grid widths, merges,
 * borders, shading, cell margins), pictures at their real size, page breaks,
 * page size and margins, and running headers/footers with page numbers.
 *
 * Style inheritance is resolved here (document defaults → paragraph style
 * chain → numbering level → direct formatting; runs add character styles),
 * and every block carries the resolved values inline in the shared units of
 * documentPageSetup.ts, so the editor, storage sanitizers, DOCX export, and
 * print all see the same explicit formatting. Constructs the editor cannot
 * show faithfully (floating shapes, comments, tracked changes, metafile
 * pictures, multi-column sections) are reported as import notes rather than
 * silently dropped. */

import {
  DOCUMENT_FIELD_PAGES_CLASS,
  DOCUMENT_FIELD_PAGE_CLASS,
  DOCUMENT_LIST_MARKER_CLASS,
  DOCUMENT_TAB_CLASS,
  LETTER_PAGE_SETUP,
  cssFontFamilyStack,
  cssPx,
  fontLineFactor,
  pageSetupMarkerHtml,
  ptFromPx,
  pxFromPt,
  roundTo,
  type DocumentPageSetup,
} from "./documentPageSetup";
import { readZip, type ZipParts } from "./ooxmlZipRead";

export type DocxImportResult = {
  /** Page-setup marker followed by the body blocks. */
  html: string;
  setup: DocumentPageSetup;
  warnings: string[];
};

/* ------------------------------ XML helpers ------------------------------ */

function parseXml(text: string): Document | null {
  try {
    const parsed = new DOMParser().parseFromString(text, "application/xml");
    if (parsed.getElementsByTagName("parsererror").length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function kids(element: Element | null | undefined, name?: string): Element[] {
  if (!element) return [];
  const result: Element[] = [];
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
    if (!name || child.localName === name) result.push(child);
  }
  return result;
}

function kid(element: Element | null | undefined, name: string): Element | null {
  if (!element) return null;
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
    if (child.localName === name) return child;
  }
  return null;
}

function descendants(element: Element | null | undefined, name: string): Element[] {
  if (!element) return [];
  return Array.from(element.getElementsByTagNameNS("*", name));
}

/** Attribute by local name, so transitional (w:) and strict namespaces read
 * the same. */
function attr(element: Element | null | undefined, name: string): string | null {
  if (!element) return null;
  const attributes = element.attributes;
  for (let index = 0; index < attributes.length; index += 1) {
    const item = attributes[index];
    if (item.localName === name) return item.value;
  }
  return null;
}

function numAttr(element: Element | null | undefined, name: string): number | undefined {
  const raw = attr(element, name);
  if (raw === null) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** OOXML on/off property: absent → undefined, present → true unless its
 * val says otherwise. */
function onOff(element: Element | null | undefined): boolean | undefined {
  if (!element) return undefined;
  const value = attr(element, "val");
  if (value === null) return true;
  return !/^(0|false|off|none)$/i.test(value);
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

const TWIPS_PER_PT = 20;
const EMU_PER_PT = 12700;

function ptFromTwips(twips: number) {
  return twips / TWIPS_PER_PT;
}

/* ------------------------------ package ------------------------------ */

type Relationship = { type: string; target: string; external: boolean };

function partDirectory(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index + 1);
}

function resolvePartPath(basePath: string, target: string) {
  if (target.startsWith("/")) return target.slice(1);
  const segments = `${partDirectory(basePath)}${target}`.split("/");
  const resolved: string[] = [];
  segments.forEach((segment) => {
    if (segment === "..") resolved.pop();
    else if (segment && segment !== ".") resolved.push(segment);
  });
  return resolved.join("/");
}

function relationshipsFor(parts: ZipParts, partPath: string): Map<string, Relationship> {
  const relsPath = `${partDirectory(partPath)}_rels/${partPath.slice(partDirectory(partPath).length)}.rels`;
  const map = new Map<string, Relationship>();
  const bytes = parts.get(relsPath);
  if (!bytes) return map;
  const xml = parseXml(new TextDecoder().decode(bytes));
  if (!xml) return map;
  kids(xml.documentElement, "Relationship").forEach((rel) => {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target) return;
    const external = attr(rel, "TargetMode") === "External";
    map.set(id, {
      type: (attr(rel, "Type") ?? "").split("/").pop() ?? "",
      target: external ? target : resolvePartPath(partPath, target),
      external,
    });
  });
  return map;
}

function readPartXml(parts: ZipParts, path: string): Document | null {
  const bytes = parts.get(path);
  return bytes ? parseXml(new TextDecoder().decode(bytes)) : null;
}

/* ------------------------------ theme ------------------------------ */

type Theme = {
  majorFont: string;
  minorFont: string;
  colors: Record<string, string>;
};

function parseTheme(xml: Document | null): Theme {
  const theme: Theme = { majorFont: "Calibri Light", minorFont: "Calibri", colors: {} };
  if (!xml) return theme;
  const fontScheme = descendants(xml.documentElement, "fontScheme")[0];
  const latin = (name: string) => attr(kid(kid(fontScheme, name), "latin"), "typeface");
  theme.majorFont = latin("majorFont") || theme.majorFont;
  theme.minorFont = latin("minorFont") || theme.minorFont;
  const scheme = descendants(xml.documentElement, "clrScheme")[0];
  kids(scheme).forEach((entry) => {
    const srgb = kid(entry, "srgbClr");
    const sys = kid(entry, "sysClr");
    const value = attr(srgb, "val") ?? attr(sys, "lastClr");
    if (value && /^[0-9a-f]{6}$/i.test(value)) theme.colors[entry.localName] = value.toUpperCase();
  });
  return theme;
}

const THEME_COLOR_KEYS: Record<string, string> = {
  dark1: "dk1",
  light1: "lt1",
  dark2: "dk2",
  light2: "lt2",
  text1: "dk1",
  background1: "lt1",
  text2: "dk2",
  background2: "lt2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hyperlink: "hlink",
  followedHyperlink: "folHlink",
};

function applyTintShade(hex: string, tint?: string | null, shade?: string | null) {
  let [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  if (shade && /^[0-9a-f]{2}$/i.test(shade)) {
    const factor = Number.parseInt(shade, 16) / 255;
    [r, g, b] = [r, g, b].map((channel) => Math.round(channel * factor));
  }
  if (tint && /^[0-9a-f]{2}$/i.test(tint)) {
    const factor = Number.parseInt(tint, 16) / 255;
    [r, g, b] = [r, g, b].map((channel) => Math.round(255 - (255 - channel) * factor));
  }
  return [r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function resolveColor(
  theme: Theme,
  value: string | null,
  themeColor: string | null,
  tint?: string | null,
  shade?: string | null,
): string | undefined {
  if (themeColor) {
    const key = THEME_COLOR_KEYS[themeColor] ?? themeColor;
    const base = theme.colors[key];
    if (base) return applyTintShade(base, tint, shade);
  }
  if (value && /^[0-9a-f]{6}$/i.test(value)) return value.toUpperCase();
  return undefined;
}

/* ------------------------------ properties ------------------------------ */

type Border = { style: string; widthPt: number; spacePt: number; color?: string };

type TabStop = { pos: number; kind: string; leader: string };

type ParaProps = {
  styleId?: string;
  align?: string;
  indLeft?: number;
  indRight?: number;
  indFirstLine?: number;
  indHanging?: number;
  spacingBefore?: number;
  spacingAfter?: number;
  beforeAuto?: boolean;
  afterAuto?: boolean;
  line?: number;
  lineRule?: string;
  contextualSpacing?: boolean;
  pageBreakBefore?: boolean;
  numId?: string;
  ilvl?: number;
  outlineLvl?: number;
  borders?: Partial<Record<"top" | "bottom" | "left" | "right", Border | null>>;
  shading?: string | null;
  tabs?: TabStop[];
  clearedTabs?: number[];
  bidi?: boolean;
};

type RunProps = {
  styleId?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  vanish?: boolean;
  color?: string | null;
  highlight?: string | null;
  shading?: string | null;
  sizeHalfPt?: number;
  font?: string;
  vertAlign?: string;
  spacingTwips?: number;
};

type CellProps = {
  widthTwips?: number;
  widthType?: string;
  gridSpan?: number;
  vMerge?: "restart" | "continue";
  borders?: Partial<Record<"top" | "bottom" | "left" | "right" | "insideH" | "insideV", Border | null>>;
  shading?: string | null;
  vAlign?: string;
  margins?: Partial<Record<"top" | "bottom" | "left" | "right", number>>;
};

type TableProps = {
  styleId?: string;
  widthTwips?: number;
  widthType?: string;
  align?: string;
  indentTwips?: number;
  borders?: CellProps["borders"];
  cellMargins?: CellProps["margins"];
  layoutFixed?: boolean;
  look?: TableLook;
};

type TableLook = {
  firstRow: boolean;
  lastRow: boolean;
  firstColumn: boolean;
  lastColumn: boolean;
  noHBand: boolean;
  noVBand: boolean;
};

function parseBorder(element: Element | null, theme: Theme): Border | null | undefined {
  if (!element) return undefined;
  const style = attr(element, "val") ?? "single";
  if (/^(nil|none)$/i.test(style)) return null;
  const sz = numAttr(element, "sz") ?? 4;
  return {
    style,
    widthPt: Math.max(0.25, sz / 8),
    spacePt: numAttr(element, "space") ?? 0,
    color: resolveColor(theme, attr(element, "color"), attr(element, "themeColor"), attr(element, "themeTint"), attr(element, "themeShade")),
  };
}

function parseShading(element: Element | null, theme: Theme): string | null | undefined {
  if (!element) return undefined;
  const fill = resolveColor(
    theme,
    attr(element, "fill"),
    attr(element, "themeFill"),
    attr(element, "themeFillTint"),
    attr(element, "themeFillShade"),
  );
  const pattern = attr(element, "val") ?? "clear";
  if (fill) return fill;
  // Solid pattern shading paints the pattern color instead of the fill.
  if (pattern === "solid") {
    return resolveColor(theme, attr(element, "color"), attr(element, "themeColor")) ?? "000000";
  }
  return attr(element, "fill") === "auto" ? null : undefined;
}

function parseParaProps(pPr: Element | null, theme: Theme): ParaProps {
  const props: ParaProps = {};
  if (!pPr) return props;
  const styleId = attr(kid(pPr, "pStyle"), "val");
  if (styleId) props.styleId = styleId;
  const jc = attr(kid(pPr, "jc"), "val");
  if (jc) props.align = jc;
  const ind = kid(pPr, "ind");
  if (ind) {
    const left = numAttr(ind, "left") ?? numAttr(ind, "start");
    const right = numAttr(ind, "right") ?? numAttr(ind, "end");
    if (left !== undefined) props.indLeft = left;
    if (right !== undefined) props.indRight = right;
    const firstLine = numAttr(ind, "firstLine");
    const hanging = numAttr(ind, "hanging");
    if (hanging !== undefined) {
      props.indHanging = hanging;
      props.indFirstLine = 0;
    } else if (firstLine !== undefined) {
      props.indFirstLine = firstLine;
      props.indHanging = 0;
    }
  }
  const spacing = kid(pPr, "spacing");
  if (spacing) {
    const before = numAttr(spacing, "before");
    const after = numAttr(spacing, "after");
    if (before !== undefined) props.spacingBefore = before;
    if (after !== undefined) props.spacingAfter = after;
    const beforeAuto = attr(spacing, "beforeAutospacing");
    const afterAuto = attr(spacing, "afterAutospacing");
    if (beforeAuto !== null) props.beforeAuto = /^(1|true|on)$/i.test(beforeAuto);
    if (afterAuto !== null) props.afterAuto = /^(1|true|on)$/i.test(afterAuto);
    const line = numAttr(spacing, "line");
    if (line !== undefined) {
      props.line = line;
      props.lineRule = attr(spacing, "lineRule") ?? "auto";
    }
  }
  const contextual = onOff(kid(pPr, "contextualSpacing"));
  if (contextual !== undefined) props.contextualSpacing = contextual;
  const pageBreakBefore = onOff(kid(pPr, "pageBreakBefore"));
  if (pageBreakBefore !== undefined) props.pageBreakBefore = pageBreakBefore;
  const numPr = kid(pPr, "numPr");
  if (numPr) {
    const numId = attr(kid(numPr, "numId"), "val");
    const ilvl = numAttr(kid(numPr, "ilvl"), "val");
    if (numId !== null) props.numId = numId;
    if (ilvl !== undefined) props.ilvl = ilvl;
  }
  const outline = numAttr(kid(pPr, "outlineLvl"), "val");
  if (outline !== undefined) props.outlineLvl = outline;
  const pBdr = kid(pPr, "pBdr");
  if (pBdr) {
    props.borders = {};
    (["top", "bottom", "left", "right"] as const).forEach((side) => {
      const border = parseBorder(kid(pBdr, side) ?? (side === "left" ? kid(pBdr, "start") : side === "right" ? kid(pBdr, "end") : null), theme);
      if (border !== undefined) props.borders![side] = border;
    });
  }
  const shading = parseShading(kid(pPr, "shd"), theme);
  if (shading !== undefined) props.shading = shading;
  const tabs = kid(pPr, "tabs");
  if (tabs) {
    props.tabs = [];
    props.clearedTabs = [];
    kids(tabs, "tab").forEach((tab) => {
      const pos = numAttr(tab, "pos");
      if (pos === undefined) return;
      const kind = attr(tab, "val") ?? "left";
      if (kind === "clear") props.clearedTabs!.push(pos);
      else props.tabs!.push({ pos, kind, leader: attr(tab, "leader") ?? "none" });
    });
  }
  const bidi = onOff(kid(pPr, "bidi"));
  if (bidi !== undefined) props.bidi = bidi;
  return props;
}

const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "FFFF00",
  green: "00FF00",
  cyan: "00FFFF",
  magenta: "FF00FF",
  blue: "0000FF",
  red: "FF0000",
  darkBlue: "000080",
  darkCyan: "008080",
  darkGreen: "008000",
  darkMagenta: "800080",
  darkRed: "800000",
  darkYellow: "808000",
  darkGray: "808080",
  lightGray: "C0C0C0",
  black: "000000",
  white: "FFFFFF",
};

function themeFontName(theme: Theme, value: string | null) {
  if (!value) return undefined;
  return /^major/i.test(value) ? theme.majorFont : theme.minorFont;
}

function parseRunProps(rPr: Element | null, theme: Theme): RunProps {
  const props: RunProps = {};
  if (!rPr) return props;
  const styleId = attr(kid(rPr, "rStyle"), "val");
  if (styleId) props.styleId = styleId;
  const fonts = kid(rPr, "rFonts");
  if (fonts) {
    const font =
      attr(fonts, "ascii") ??
      themeFontName(theme, attr(fonts, "asciiTheme")) ??
      attr(fonts, "hAnsi") ??
      themeFontName(theme, attr(fonts, "hAnsiTheme"));
    if (font) props.font = font;
  }
  const toggle = (name: string) => onOff(kid(rPr, name));
  const bold = toggle("b");
  if (bold !== undefined) props.bold = bold;
  const italic = toggle("i");
  if (italic !== undefined) props.italic = italic;
  const caps = toggle("caps");
  if (caps !== undefined) props.caps = caps;
  const smallCaps = toggle("smallCaps");
  if (smallCaps !== undefined) props.smallCaps = smallCaps;
  const strike = toggle("strike");
  const dstrike = toggle("dstrike");
  if (strike !== undefined || dstrike !== undefined) props.strike = Boolean(strike || dstrike);
  const vanish = toggle("vanish");
  if (vanish !== undefined) props.vanish = vanish;
  const color = kid(rPr, "color");
  if (color) {
    const value = attr(color, "val");
    props.color =
      value === "auto" && !attr(color, "themeColor")
        ? null
        : resolveColor(theme, value, attr(color, "themeColor"), attr(color, "themeTint"), attr(color, "themeShade")) ?? null;
  }
  const size = numAttr(kid(rPr, "sz"), "val");
  if (size !== undefined && size > 0) props.sizeHalfPt = size;
  const underline = kid(rPr, "u");
  if (underline) props.underline = !/^(none|0|false)$/i.test(attr(underline, "val") ?? "single");
  const highlight = attr(kid(rPr, "highlight"), "val");
  if (highlight) props.highlight = highlight === "none" ? null : HIGHLIGHT_COLORS[highlight] ?? null;
  const shading = parseShading(kid(rPr, "shd"), theme);
  if (shading !== undefined) props.shading = shading;
  const vertAlign = attr(kid(rPr, "vertAlign"), "val");
  if (vertAlign) props.vertAlign = vertAlign;
  const spacing = numAttr(kid(rPr, "spacing"), "val");
  if (spacing !== undefined) props.spacingTwips = spacing;
  return props;
}

function mergeParaProps(base: ParaProps, next: ParaProps): ParaProps {
  const merged: ParaProps = { ...base };
  (Object.keys(next) as Array<keyof ParaProps>).forEach((key) => {
    const value = next[key];
    if (value === undefined) return;
    if (key === "borders") {
      merged.borders = { ...(base.borders ?? {}), ...(next.borders ?? {}) };
    } else if (key === "tabs") {
      const cleared = new Set(next.clearedTabs ?? []);
      const kept = (base.tabs ?? []).filter((tab) => !cleared.has(tab.pos));
      const positions = new Set((next.tabs ?? []).map((tab) => tab.pos));
      merged.tabs = [...kept.filter((tab) => !positions.has(tab.pos)), ...(next.tabs ?? [])].sort(
        (a, b) => a.pos - b.pos,
      );
    } else if (key === "clearedTabs") {
      return;
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  });
  return merged;
}

function mergeRunProps(base: RunProps, next: RunProps): RunProps {
  const merged: RunProps = { ...base };
  (Object.keys(next) as Array<keyof RunProps>).forEach((key) => {
    const value = next[key];
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  });
  return merged;
}

function parseCellBorders(element: Element | null, theme: Theme): CellProps["borders"] | undefined {
  if (!element) return undefined;
  const borders: NonNullable<CellProps["borders"]> = {};
  (["top", "bottom", "left", "right", "insideH", "insideV"] as const).forEach((side) => {
    const node =
      kid(element, side) ??
      (side === "left" ? kid(element, "start") : side === "right" ? kid(element, "end") : null);
    const border = parseBorder(node, theme);
    if (border !== undefined) borders[side] = border;
  });
  return borders;
}

function parseCellMargins(element: Element | null): CellProps["margins"] | undefined {
  if (!element) return undefined;
  const margins: NonNullable<CellProps["margins"]> = {};
  (["top", "bottom", "left", "right"] as const).forEach((side) => {
    const node =
      kid(element, side) ??
      (side === "left" ? kid(element, "start") : side === "right" ? kid(element, "end") : null);
    const width = numAttr(node, "w");
    if (width !== undefined && (attr(node, "type") ?? "dxa") === "dxa") margins[side] = width;
  });
  return margins;
}

function parseTableProps(tblPr: Element | null, theme: Theme): TableProps {
  const props: TableProps = {};
  if (!tblPr) return props;
  const styleId = attr(kid(tblPr, "tblStyle"), "val");
  if (styleId) props.styleId = styleId;
  const width = kid(tblPr, "tblW");
  if (width) {
    props.widthTwips = numAttr(width, "w");
    props.widthType = attr(width, "type") ?? "dxa";
  }
  const jc = attr(kid(tblPr, "jc"), "val");
  if (jc) props.align = jc;
  const indent = kid(tblPr, "tblInd");
  if (indent && (attr(indent, "type") ?? "dxa") === "dxa") props.indentTwips = numAttr(indent, "w");
  const borders = parseCellBorders(kid(tblPr, "tblBorders"), theme);
  if (borders) props.borders = borders;
  const margins = parseCellMargins(kid(tblPr, "tblCellMar"));
  if (margins) props.cellMargins = margins;
  const layout = attr(kid(tblPr, "tblLayout"), "type");
  if (layout) props.layoutFixed = layout === "fixed";
  const look = kid(tblPr, "tblLook");
  if (look) {
    const legacy = Number.parseInt(attr(look, "val") ?? "", 16);
    const flag = (name: string, bit: number) => {
      const value = attr(look, name);
      if (value !== null) return /^(1|true|on)$/i.test(value);
      return Number.isFinite(legacy) ? (legacy & bit) !== 0 : false;
    };
    props.look = {
      firstRow: flag("firstRow", 0x20),
      lastRow: flag("lastRow", 0x40),
      firstColumn: flag("firstColumn", 0x80),
      lastColumn: flag("lastColumn", 0x100),
      noHBand: flag("noHBand", 0x200),
      noVBand: flag("noVBand", 0x400),
    };
  }
  return props;
}

function parseCellProps(tcPr: Element | null, theme: Theme): CellProps {
  const props: CellProps = {};
  if (!tcPr) return props;
  const width = kid(tcPr, "tcW");
  if (width) {
    props.widthTwips = numAttr(width, "w");
    props.widthType = attr(width, "type") ?? "dxa";
  }
  const span = numAttr(kid(tcPr, "gridSpan"), "val");
  if (span && span > 1) props.gridSpan = Math.round(span);
  const vMerge = kid(tcPr, "vMerge");
  if (vMerge) props.vMerge = attr(vMerge, "val") === "restart" ? "restart" : "continue";
  const borders = parseCellBorders(kid(tcPr, "tcBorders"), theme);
  if (borders) props.borders = borders;
  const shading = parseShading(kid(tcPr, "shd"), theme);
  if (shading !== undefined) props.shading = shading;
  const vAlign = attr(kid(tcPr, "vAlign"), "val");
  if (vAlign) props.vAlign = vAlign;
  const margins = parseCellMargins(kid(tcPr, "tcMar"));
  if (margins) props.margins = margins;
  return props;
}

function mergeCellProps(base: CellProps, next: CellProps): CellProps {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
    borders: { ...(base.borders ?? {}), ...(next.borders ?? {}) },
    margins: { ...(base.margins ?? {}), ...(next.margins ?? {}) },
  };
}

/* ------------------------------ styles ------------------------------ */

type ConditionalFormat = { pPr: ParaProps; rPr: RunProps; tcPr: CellProps };

type StyleDef = {
  id: string;
  type: string;
  name: string;
  basedOn?: string;
  pPr: ParaProps;
  rPr: RunProps;
  tblPr: TableProps;
  tcPr: CellProps;
  conditional: Map<string, ConditionalFormat>;
  isDefault: boolean;
};

type StyleSheet = {
  styles: Map<string, StyleDef>;
  defaultParagraph?: string;
  defaultCharacter?: string;
  defaultTable?: string;
  docPPr: ParaProps;
  docRPr: RunProps;
};

function parseStyles(xml: Document | null, theme: Theme): StyleSheet {
  const sheet: StyleSheet = { styles: new Map(), docPPr: {}, docRPr: {} };
  if (!xml) return sheet;
  const root = xml.documentElement;
  const defaults = kid(root, "docDefaults");
  sheet.docPPr = parseParaProps(kid(kid(defaults, "pPrDefault"), "pPr"), theme);
  sheet.docRPr = parseRunProps(kid(kid(defaults, "rPrDefault"), "rPr"), theme);
  kids(root, "style").forEach((style) => {
    const id = attr(style, "styleId");
    if (!id) return;
    const type = attr(style, "type") ?? "paragraph";
    const conditional = new Map<string, ConditionalFormat>();
    kids(style, "tblStylePr").forEach((entry) => {
      const kind = attr(entry, "type");
      if (!kind) return;
      conditional.set(kind, {
        pPr: parseParaProps(kid(entry, "pPr"), theme),
        rPr: parseRunProps(kid(entry, "rPr"), theme),
        tcPr: parseCellProps(kid(entry, "tcPr"), theme),
      });
    });
    const tblPr = parseTableProps(kid(style, "tblPr"), theme);
    const def: StyleDef = {
      id,
      type,
      name: attr(kid(style, "name"), "val") ?? id,
      basedOn: attr(kid(style, "basedOn"), "val") ?? undefined,
      pPr: parseParaProps(kid(style, "pPr"), theme),
      rPr: parseRunProps(kid(style, "rPr"), theme),
      tblPr,
      tcPr: parseCellProps(kid(style, "tcPr"), theme),
      conditional,
      isDefault: /^(1|true|on)$/i.test(attr(style, "default") ?? ""),
    };
    sheet.styles.set(id, def);
    if (def.isDefault) {
      if (type === "paragraph") sheet.defaultParagraph = id;
      else if (type === "character") sheet.defaultCharacter = id;
      else if (type === "table") sheet.defaultTable = id;
    }
  });
  return sheet;
}

function styleChain(sheet: StyleSheet, id: string | undefined): StyleDef[] {
  const chain: StyleDef[] = [];
  const seen = new Set<string>();
  let current = id ? sheet.styles.get(id) : undefined;
  while (current && !seen.has(current.id) && chain.length < 20) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.basedOn ? sheet.styles.get(current.basedOn) : undefined;
  }
  return chain;
}

/* ------------------------------ numbering ------------------------------ */

type NumberingLevel = {
  start: number;
  format: string;
  text: string;
  pPr: ParaProps;
  rPr: RunProps;
  suffix: string;
  isLegal: boolean;
  restart?: number;
};

type Numbering = {
  abstracts: Map<string, Map<number, NumberingLevel>>;
  nums: Map<string, { abstractId: string; overrides: Map<number, { start?: number; level?: NumberingLevel }> }>;
};

function parseLevel(lvl: Element, theme: Theme): NumberingLevel {
  return {
    start: numAttr(kid(lvl, "start"), "val") ?? 1,
    format: attr(kid(lvl, "numFmt"), "val") ?? "decimal",
    text: attr(kid(lvl, "lvlText"), "val") ?? "",
    pPr: parseParaProps(kid(lvl, "pPr"), theme),
    rPr: parseRunProps(kid(lvl, "rPr"), theme),
    suffix: attr(kid(lvl, "suff"), "val") ?? "tab",
    isLegal: Boolean(onOff(kid(lvl, "isLgl"))),
    restart: numAttr(kid(lvl, "lvlRestart"), "val"),
  };
}

function parseNumbering(xml: Document | null, theme: Theme): Numbering {
  const numbering: Numbering = { abstracts: new Map(), nums: new Map() };
  if (!xml) return numbering;
  kids(xml.documentElement, "abstractNum").forEach((abstract) => {
    const id = attr(abstract, "abstractNumId");
    if (id === null) return;
    const levels = new Map<number, NumberingLevel>();
    kids(abstract, "lvl").forEach((lvl) => {
      const ilvl = numAttr(lvl, "ilvl");
      if (ilvl !== undefined) levels.set(ilvl, parseLevel(lvl, theme));
    });
    numbering.abstracts.set(id, levels);
  });
  kids(xml.documentElement, "num").forEach((num) => {
    const id = attr(num, "numId");
    const abstractId = attr(kid(num, "abstractNumId"), "val");
    if (id === null || abstractId === null) return;
    const overrides = new Map<number, { start?: number; level?: NumberingLevel }>();
    kids(num, "lvlOverride").forEach((override) => {
      const ilvl = numAttr(override, "ilvl");
      if (ilvl === undefined) return;
      const lvl = kid(override, "lvl");
      overrides.set(ilvl, {
        start: numAttr(kid(override, "startOverride"), "val"),
        level: lvl ? parseLevel(lvl, theme) : undefined,
      });
    });
    numbering.nums.set(id, { abstractId, overrides });
  });
  return numbering;
}

const ROMAN = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
] as const;

function toRoman(value: number) {
  let remaining = Math.max(1, Math.min(3999, value));
  let result = "";
  ROMAN.forEach(([amount, numeral]) => {
    while (remaining >= amount) {
      result += numeral;
      remaining -= amount;
    }
  });
  return result;
}

function toLetters(value: number) {
  // Word repeats the letter past z: a…z, aa…zz, aaa…
  const index = Math.max(1, value) - 1;
  const letter = String.fromCharCode(97 + (index % 26));
  return letter.repeat(Math.floor(index / 26) + 1);
}

const ORDINAL_WORDS = ["Zero", "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth", "Eleventh", "Twelfth", "Thirteenth", "Fourteenth", "Fifteenth", "Sixteenth", "Seventeenth", "Eighteenth", "Nineteenth", "Twentieth"];
const CARDINAL_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty"];

function formatNumber(value: number, format: string) {
  switch (format) {
    case "lowerLetter":
      return toLetters(value);
    case "upperLetter":
      return toLetters(value).toUpperCase();
    case "lowerRoman":
      return toRoman(value);
    case "upperRoman":
      return toRoman(value).toUpperCase();
    case "decimalZero":
      return value < 10 ? `0${value}` : String(value);
    case "ordinal": {
      const mod100 = value % 100;
      const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : ["th", "st", "nd", "rd"][value % 10] ?? "th";
      return `${value}${suffix}`;
    }
    case "ordinalText":
      return ORDINAL_WORDS[value] ?? String(value);
    case "cardinalText":
      return CARDINAL_WORDS[value] ?? String(value);
    case "none":
      return "";
    default:
      return String(value);
  }
}

/** Private-use bullet glyphs from Symbol/Wingdings mapped to the Unicode
 * shapes they draw. */
const SYMBOL_GLYPHS: Record<number, string> = {
  0xf0b7: "\u2022",
  0xf0a7: "\u25aa",
  0xf0a8: "\u25fb",
  0xf06c: "\u25cf",
  0xf06e: "\u25a0",
  0xf06f: "\u25a1",
  0xf071: "\u2751",
  0xf075: "\u25c6",
  0xf076: "\u2756",
  0xf077: "\u25c6",
  0xf09f: "\u2022",
  0xf0a1: "\u25cb",
  0xf0d8: "\u27a2",
  0xf0e0: "\u2192",
  0xf0e8: "\u2794",
  0xf0fb: "\u2717",
  0xf0fc: "\u2713",
  0xf0fd: "\u2612",
  0xf0fe: "\u2611",
  0xf0a3: "\u25a1",
  0xf02d: "\u2013",
};

function mapSymbolText(text: string) {
  return Array.from(text)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code >= 0xf000 && code <= 0xf0ff) return SYMBOL_GLYPHS[code] ?? "\u2022";
      return char;
    })
    .join("");
}

/* ------------------------------ text measurement ------------------------------ */

type Measurer = (text: string, font: string, sizePx: number) => number;

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
  return (text, font, sizePx) => {
    if (!text) return 0;
    if (context) {
      context.font = font;
      return context.measureText(text).width;
    }
    return text.length * sizePx * 0.5;
  };
}

/* ------------------------------ conversion state ------------------------------ */

type ImageData = { src: string; bytes: number };

type ConversionContext = {
  parts: ZipParts;
  theme: Theme;
  styles: StyleSheet;
  numbering: Numbering;
  defaultTabTwips: number;
  measure: Measurer;
  images: Map<string, Promise<ImageData | null>>;
  imageBudget: { used: number };
  counters: Map<string, Map<number, number>>;
  numsSeen: Set<string>;
  notes: { kind: "footnote" | "endnote"; id: string; number: number }[];
  noteParts: { footnotes: Map<string, Element>; endnotes: Map<string, Element> };
  notices: Map<string, number>;
  /** Normal-style text, used to decide which formatting is a difference. */
  base: { font: string; sizePx: number; color: string };
  footnoteRels: Map<string, Relationship>;
  endnoteRels: Map<string, Relationship>;
  /** Number shown by w:footnoteRef while a note body is converted. */
  currentNoteNumber: number | null;
  /** Word 2013+ (compatibility mode 15) measures table indents to the
   * border; earlier modes measure them to the cell text. */
  tableIndentToBorder: boolean;
};

type PartScope = {
  path: string;
  rels: Map<string, Relationship>;
  headerFooter: boolean;
};

function notice(context: ConversionContext, key: string) {
  context.notices.set(key, (context.notices.get(key) ?? 0) + 1);
}

/* ------------------------------ images ------------------------------ */

const MAX_IMAGE_DATA_CHARS = 450_000;
const TOTAL_IMAGE_BUDGET_CHARS = 1_400_000;

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function imageMime(path: string, bytes: Uint8Array) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return "image/webp";
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "emf" || extension === "wmf") return "image/x-metafile";
  if (extension === "tif" || extension === "tiff") return "image/tiff";
  if (extension === "svg") return "image/svg+xml";
  return "application/octet-stream";
}

/** Re-encodes a picture through a canvas (PNG keeps transparency, JPEG for
 * opaque photos) at no more than twice its displayed size. Returns null
 * where canvas decoding is unavailable. */
async function reencodeImage(
  bytes: Uint8Array,
  mime: string,
  displayWidthPx: number,
  preferJpeg: boolean,
): Promise<string | null> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return null;
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: mime }));
    const scale = Math.min(1, (Math.max(48, displayWidthPx) * 2) / Math.max(1, bitmap.width));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    if (preferJpeg) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas.toDataURL(preferJpeg ? "image/jpeg" : "image/png", 0.86);
  } catch {
    return null;
  }
}

async function loadImage(
  context: ConversionContext,
  path: string,
  displayWidthPx: number,
): Promise<ImageData | null> {
  const bytes = context.parts.get(path);
  if (!bytes) return null;
  const mime = imageMime(path, bytes);
  if (mime === "image/x-metafile") {
    notice(context, "metafile");
    return null;
  }
  let src: string | null = null;
  const direct = mime === "image/png" || mime === "image/jpeg";
  if (direct) {
    const encoded = `data:${mime};base64,${bytesToBase64(bytes)}`;
    if (encoded.length <= MAX_IMAGE_DATA_CHARS) src = encoded;
  }
  if (!src) {
    src = await reencodeImage(bytes, mime, displayWidthPx, mime === "image/jpeg");
    if (src && src.length > MAX_IMAGE_DATA_CHARS) {
      src = await reencodeImage(bytes, mime, displayWidthPx * 0.6, true);
    }
    if (src && !/^data:image\/(png|jpeg);base64,/.test(src)) src = null;
  }
  if (!src) {
    notice(context, direct ? "image-too-large" : "image-format");
    return null;
  }
  if (context.imageBudget.used + src.length > TOTAL_IMAGE_BUDGET_CHARS) {
    notice(context, "image-budget");
    return null;
  }
  context.imageBudget.used += src.length;
  return { src, bytes: src.length };
}

/* ------------------------------ tokens ------------------------------ */

type RunFormat = {
  font: string;
  sizePx: number;
  color?: string;
  background?: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  caps: boolean;
  smallCaps: boolean;
  vertAlign?: "super" | "sub";
  letterSpacingPx?: number;
};

type Token =
  | { kind: "text"; text: string; format: RunFormat; href?: string; field?: "page" | "pages" }
  | { kind: "tab"; format: RunFormat }
  | { kind: "break" }
  | { kind: "page-break" }
  | { kind: "image"; path: string; widthPx: number; heightPx: number; alt: string; floating: boolean; align?: string }
  | { kind: "marker"; text: string; format: RunFormat; suffix: string }
  | { kind: "blocks"; html: string };

/** Symbol-encoded fonts whose glyphs are mapped to Unicode on import; the
 * mapped characters render in the surrounding text font instead. */
const SYMBOL_FONT = /^(symbol|wingdings( [23])?|webdings|marlett|zapf ?dingbats)$/i;

function runFormatFromProps(props: RunProps, context: ConversionContext): RunFormat {
  const sizePt = (props.sizeHalfPt ?? 20) / 2;
  const fontName =
    props.font && !SYMBOL_FONT.test(props.font.trim()) ? props.font : context.theme.minorFont;
  return {
    font: cssFontFamilyStack(fontName),
    sizePx: roundTo(pxFromPt(sizePt), 2),
    color: props.color ? `#${props.color}` : undefined,
    background: props.highlight
      ? `#${props.highlight}`
      : props.shading
        ? `#${props.shading}`
        : undefined,
    bold: Boolean(props.bold),
    italic: Boolean(props.italic),
    underline: Boolean(props.underline),
    strike: Boolean(props.strike),
    caps: Boolean(props.caps),
    smallCaps: Boolean(props.smallCaps) && !props.caps,
    vertAlign:
      props.vertAlign === "superscript" ? "super" : props.vertAlign === "subscript" ? "sub" : undefined,
    letterSpacingPx: props.spacingTwips ? roundTo(pxFromPt(ptFromTwips(props.spacingTwips)), 2) : undefined,
  };
}

function canvasFont(format: RunFormat) {
  // Super/subscript text renders at a reduced size. Every family is quoted:
  // an unquoted name the canvas cannot parse would discard the whole font.
  const size = format.vertAlign ? format.sizePx * 0.66 : format.sizePx;
  const families = format.font
    .split(",")
    .map((family) => family.replace(/'/g, "").trim())
    .map((family) => (/^(serif|sans-serif|monospace)$/.test(family) ? family : `'${family}'`))
    .join(", ");
  return `${format.italic ? "italic " : ""}${format.smallCaps ? "small-caps " : ""}${format.bold ? "700 " : "400 "}${roundTo(size, 2)}px ${families}`;
}

function measureToken(context: ConversionContext, text: string, format: RunFormat) {
  const shown = format.caps ? text.toUpperCase() : text;
  const size = format.vertAlign ? format.sizePx * 0.66 : format.sizePx;
  return (
    context.measure(shown, canvasFont(format), size) +
    (format.letterSpacingPx ? format.letterSpacingPx * shown.length : 0)
  );
}

/* ------------------------------ paragraph resolution ------------------------------ */

type ResolvedParagraph = {
  pPr: ParaProps;
  /** Run properties from defaults and the paragraph style, before the
   * character style and direct formatting of each run. */
  baseRPr: RunProps;
  styleId?: string;
  styleName?: string;
  numbering?: { level: NumberingLevel; text: string };
};

function resolveParagraph(
  context: ConversionContext,
  pPrElement: Element | null,
  tableLayer?: { pPr: ParaProps; rPr: RunProps },
): ResolvedParagraph {
  const direct = parseParaProps(pPrElement, context.theme);
  const styleId = direct.styleId ?? context.styles.defaultParagraph;
  const chain = styleChain(context.styles, styleId);
  let pPr = mergeParaProps({}, context.styles.docPPr);
  let rPr = mergeRunProps({}, context.styles.docRPr);
  if (tableLayer) {
    pPr = mergeParaProps(pPr, tableLayer.pPr);
    rPr = mergeRunProps(rPr, tableLayer.rPr);
  }
  chain.forEach((style) => {
    pPr = mergeParaProps(pPr, style.pPr);
    rPr = mergeRunProps(rPr, style.rPr);
  });
  // Numbering may come from the style; direct numPr overrides it.
  const numId = direct.numId ?? pPr.numId;
  const ilvl = direct.ilvl ?? pPr.ilvl ?? 0;
  let numberingInfo: ResolvedParagraph["numbering"];
  if (numId && numId !== "0") {
    const level = numberingLevel(context, numId, ilvl);
    if (level) {
      pPr = mergeParaProps(pPr, level.pPr);
      numberingInfo = { level, text: nextNumberText(context, numId, ilvl) };
    }
  }
  pPr = mergeParaProps(pPr, { ...direct, numId: undefined, ilvl: undefined });
  const styleDef = styleId ? context.styles.styles.get(styleId) : undefined;
  return {
    pPr,
    baseRPr: rPr,
    styleId,
    styleName: styleDef?.name,
    numbering: numberingInfo,
  };
}

function numberingLevel(context: ConversionContext, numId: string, ilvl: number) {
  const num = context.numbering.nums.get(numId);
  if (!num) return undefined;
  const override = num.overrides.get(ilvl);
  if (override?.level) return override.level;
  return context.numbering.abstracts.get(num.abstractId)?.get(ilvl);
}

/** Advances the list counter for this paragraph and renders its number the
 * way Word does: %1…%9 replaced by each level's current value in its own
 * format (or decimal for legal numbering). */
function nextNumberText(context: ConversionContext, numId: string, ilvl: number) {
  const num = context.numbering.nums.get(numId);
  if (!num) return "";
  const key = num.abstractId;
  const levels = context.numbering.abstracts.get(num.abstractId) ?? new Map<number, NumberingLevel>();
  const levelFor = (index: number) => num.overrides.get(index)?.level ?? levels.get(index);
  let counters = context.counters.get(key);
  if (!counters) {
    counters = new Map();
    context.counters.set(key, counters);
  }
  if (!context.numsSeen.has(numId)) {
    context.numsSeen.add(numId);
    num.overrides.forEach((override, index) => {
      if (override.start !== undefined) counters!.set(index, override.start - 1);
    });
  }
  const level = levelFor(ilvl);
  if (!level) return "";
  counters.set(ilvl, (counters.get(ilvl) ?? level.start - 1) + 1);
  for (let deeper = ilvl + 1; deeper < 9; deeper += 1) {
    const deeperLevel = levelFor(deeper);
    // lvlRestart 0 means never restart; N restarts only after level N or a
    // higher one (1-based) appears.
    if (deeperLevel?.restart === 0) continue;
    if (deeperLevel?.restart !== undefined && deeperLevel.restart - 1 < ilvl) continue;
    counters.delete(deeper);
  }
  if (level.format === "bullet") return mapSymbolText(level.text);
  return level.text.replace(/%([1-9])/g, (_match, digit: string) => {
    const index = Number(digit) - 1;
    const ref = levelFor(index);
    const value = counters!.get(index) ?? ref?.start ?? 1;
    const format = level.isLegal && index < ilvl ? "decimal" : ref?.format ?? "decimal";
    return formatNumber(value, format);
  });
}

function headingLevel(resolved: ResolvedParagraph): number | null {
  const name = (resolved.styleName ?? "").toLowerCase();
  if (name === "title") return 1;
  const named = /^heading\s*([1-6])$/.exec(name);
  if (named) return Number(named[1]);
  const outline = resolved.pPr.outlineLvl;
  if (outline !== undefined && outline >= 0 && outline <= 5) return outline + 1;
  return null;
}

/* ------------------------------ run collection ------------------------------ */

type RunScope = {
  context: ConversionContext;
  part: PartScope;
  resolved: ResolvedParagraph;
  tokens: Token[];
  href?: string;
  field?: "page" | "pages";
  /** Complex field state: instruction text collected until "separate". */
  fieldStack: { instruction: string; separated: boolean; field?: "page" | "pages"; href?: string; hideResult?: boolean }[];
  trailingBlocks: string[];
};

function runFormatFor(scope: RunScope, rPrElement: Element | null): { format: RunFormat; props: RunProps } {
  const { context } = scope;
  const direct = parseRunProps(rPrElement, context.theme);
  let props = mergeRunProps({}, scope.resolved.baseRPr);
  const characterStyle = direct.styleId ?? undefined;
  styleChain(context.styles, characterStyle).forEach((style) => {
    props = mergeRunProps(props, style.rPr);
  });
  props = mergeRunProps(props, direct);
  return { format: runFormatFromProps(props, context), props };
}

function activeHref(scope: RunScope) {
  for (let index = scope.fieldStack.length - 1; index >= 0; index -= 1) {
    const entry = scope.fieldStack[index];
    if (entry.separated && entry.href) return entry.href;
  }
  return scope.href;
}

function activeField(scope: RunScope) {
  for (let index = scope.fieldStack.length - 1; index >= 0; index -= 1) {
    const entry = scope.fieldStack[index];
    if (entry.separated && entry.field) return entry.field;
  }
  return scope.field;
}

function fieldHidesResult(scope: RunScope) {
  return scope.fieldStack.some((entry) => entry.hideResult);
}

function fieldInstructionPending(scope: RunScope) {
  return scope.fieldStack.some((entry) => !entry.separated);
}

function classifyField(instruction: string): { field?: "page" | "pages"; href?: string } {
  const trimmed = instruction.trim();
  const word = trimmed.split(/\s+/)[0]?.toUpperCase() ?? "";
  if (word === "PAGE") return { field: "page" };
  if (word === "NUMPAGES" || word === "SECTIONPAGES") return { field: "pages" };
  if (word === "HYPERLINK") {
    const target = /"([^"]+)"/.exec(trimmed)?.[1] ?? trimmed.split(/\s+/)[1];
    const anchor = /\\l\s+"([^"]+)"/.exec(trimmed)?.[1];
    if (target && /^(https?:|mailto:)/i.test(target)) return { href: target };
    if (anchor) return { href: `#${anchor}` };
  }
  return {};
}

function safeHref(target: string | undefined) {
  if (!target) return undefined;
  const trimmed = target.trim();
  if (/^(https?:\/\/|mailto:)/i.test(trimmed) && !/\s/.test(trimmed)) return trimmed;
  if (/^#[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(trimmed)) return trimmed;
  return undefined;
}

function pushText(scope: RunScope, text: string, format: RunFormat) {
  if (!text) return;
  if (fieldInstructionPending(scope) || fieldHidesResult(scope)) return;
  scope.tokens.push({
    kind: "text",
    text,
    format,
    href: activeHref(scope),
    field: scope.part.headerFooter ? activeField(scope) : undefined,
  });
}

async function collectRunContent(scope: RunScope, run: Element) {
  const { format, props } = runFormatFor(scope, kid(run, "rPr"));
  if (props.vanish) return;
  for (const child of kids(run)) {
    switch (child.localName) {
      case "t":
        pushText(scope, child.textContent ?? "", format);
        break;
      case "tab":
        if (!fieldInstructionPending(scope) && !fieldHidesResult(scope)) {
          scope.tokens.push({ kind: "tab", format });
        }
        break;
      case "br": {
        const type = attr(child, "type");
        if (type === "page") scope.tokens.push({ kind: "page-break" });
        else scope.tokens.push({ kind: "break" });
        break;
      }
      case "cr":
        scope.tokens.push({ kind: "break" });
        break;
      case "noBreakHyphen":
        pushText(scope, "\u2011", format);
        break;
      case "softHyphen":
        pushText(scope, "\u00ad", format);
        break;
      case "sym": {
        const raw = Number.parseInt(attr(child, "char") ?? "", 16);
        if (!Number.isFinite(raw)) break;
        const symbolFont = /symbol|wingdings|webdings/i.test(attr(child, "font") ?? "");
        const code = raw < 0xf000 && symbolFont ? raw + 0xf000 : raw;
        const char = code >= 0xf000 ? SYMBOL_GLYPHS[code] ?? "\u2022" : String.fromCodePoint(code);
        pushText(scope, char, format);
        break;
      }
      case "footnoteRef":
      case "endnoteRef":
        if (scope.context.currentNoteNumber !== null) {
          pushText(scope, String(scope.context.currentNoteNumber), { ...format, vertAlign: "super" });
        }
        break;
      case "fldChar": {
        const type = attr(child, "fldCharType");
        if (type === "begin") scope.fieldStack.push({ instruction: "", separated: false });
        else if (type === "separate") {
          const entry = scope.fieldStack[scope.fieldStack.length - 1];
          if (entry) {
            entry.separated = true;
            const classified = classifyField(entry.instruction);
            entry.field = classified.field;
            entry.href = safeHref(classified.href);
          }
        } else if (type === "end") {
          const entry = scope.fieldStack.pop();
          // A field with no cached result still shows its value in Word; for
          // page fields render a placeholder the header/footer fills in.
          if (entry && !entry.separated) {
            const classified = classifyField(entry.instruction);
            if (classified.field && scope.part.headerFooter) {
              scope.tokens.push({ kind: "text", text: "1", format, field: classified.field });
            }
          }
        }
        break;
      }
      case "instrText": {
        const entry = scope.fieldStack[scope.fieldStack.length - 1];
        if (entry && !entry.separated) entry.instruction += child.textContent ?? "";
        break;
      }
      case "drawing":
        await collectDrawing(scope, child);
        break;
      case "pict":
      case "object":
        await collectVml(scope, child);
        break;
      case "AlternateContent":
        await collectAlternateContent(scope, child, (node) => collectRunContentChildren(scope, node, format));
        break;
      case "footnoteReference":
      case "endnoteReference": {
        const id = attr(child, "id");
        if (id) {
          const kind = child.localName === "footnoteReference" ? "footnote" : "endnote";
          const number = scope.context.notes.length + 1;
          scope.context.notes.push({ kind, id, number });
          pushText(scope, String(number), { ...format, vertAlign: "super" });
        }
        break;
      }
      case "commentReference":
        notice(scope.context, "comments");
        break;
      case "delText":
      case "delInstrText":
        break;
      case "ruby": {
        const base = kid(child, "rubyBase");
        for (const inner of kids(base, "r")) await collectRunContent(scope, inner);
        break;
      }
      default:
        break;
    }
  }
}

async function collectRunContentChildren(scope: RunScope, node: Element, format: RunFormat) {
  for (const child of kids(node)) {
    if (child.localName === "drawing") await collectDrawing(scope, child);
    else if (child.localName === "pict") await collectVml(scope, child);
    else if (child.localName === "t") pushText(scope, child.textContent ?? "", format);
  }
}

async function collectAlternateContent(
  scope: RunScope,
  element: Element,
  collect: (node: Element) => Promise<void>,
) {
  const choice = kid(element, "Choice");
  const before = scope.tokens.length + scope.trailingBlocks.length;
  if (choice) await collect(choice);
  if (scope.tokens.length + scope.trailingBlocks.length === before) {
    const fallback = kid(element, "Fallback");
    if (fallback) await collect(fallback);
  }
}

async function collectInline(scope: RunScope, element: Element) {
  for (const child of kids(element)) {
    switch (child.localName) {
      case "r":
        await collectRunContent(scope, child);
        break;
      case "hyperlink": {
        const relId = attr(child, "id");
        const rel = relId ? scope.part.rels.get(relId) : undefined;
        const anchor = attr(child, "anchor");
        const previous = scope.href;
        scope.href = safeHref(rel?.external ? rel.target : anchor ? `#${anchor}` : undefined) ?? previous;
        await collectInline(scope, child);
        scope.href = previous;
        break;
      }
      case "fldSimple": {
        const classified = classifyField(attr(child, "instr") ?? "");
        const previousField = scope.field;
        const previousHref = scope.href;
        if (classified.field) scope.field = classified.field;
        if (classified.href) scope.href = safeHref(classified.href);
        const before = scope.tokens.length;
        await collectInline(scope, child);
        if (classified.field && scope.part.headerFooter && scope.tokens.length === before) {
          scope.tokens.push({
            kind: "text",
            text: "1",
            format: runFormatFor(scope, null).format,
            field: classified.field,
          });
        }
        scope.field = previousField;
        scope.href = previousHref;
        break;
      }
      case "ins":
      case "moveTo":
        notice(scope.context, "tracked");
        await collectInline(scope, child);
        break;
      case "del":
      case "moveFrom":
        notice(scope.context, "tracked");
        break;
      case "smartTag":
      case "customXml":
      case "dir":
      case "bdo":
        await collectInline(scope, child);
        break;
      case "sdt":
        await collectInline(scope, kid(child, "sdtContent") ?? child);
        break;
      case "AlternateContent":
        await collectAlternateContent(scope, child, (node) => collectInline(scope, node));
        break;
      case "commentRangeStart":
        notice(scope.context, "comments");
        break;
      case "oMath":
      case "oMathPara":
        pushText(scope, child.textContent ?? "", runFormatFor(scope, null).format);
        notice(scope.context, "math");
        break;
      default:
        break;
    }
  }
}

function extentPx(element: Element | null) {
  const cx = numAttr(element, "cx") ?? 0;
  const cy = numAttr(element, "cy") ?? 0;
  return {
    widthPx: roundTo(pxFromPt(cx / EMU_PER_PT), 2),
    heightPx: roundTo(pxFromPt(cy / EMU_PER_PT), 2),
  };
}

async function collectDrawing(scope: RunScope, drawing: Element) {
  const holder = kid(drawing, "inline") ?? kid(drawing, "anchor");
  if (!holder) return;
  const floating = holder.localName === "anchor";
  const { widthPx, heightPx } = extentPx(kid(holder, "extent"));
  const alt = attr(kid(holder, "docPr"), "descr") ?? attr(kid(holder, "docPr"), "title") ?? "";
  const graphicData = descendants(holder, "graphicData")[0];
  const uri = attr(graphicData, "uri") ?? "";
  const blip = descendants(holder, "blip")[0];
  const embed = attr(blip, "embed");
  if (embed) {
    const rel = scope.part.rels.get(embed);
    if (rel && !rel.external) {
      let align: string | undefined;
      if (floating) {
        notice(scope.context, "floating");
        align = descendants(kid(holder, "positionH"), "align")[0]?.textContent ?? undefined;
        if (attr(holder, "behindDoc") === "1" && scope.part.headerFooter && widthPx > 300) {
          // A large picture behind header text is a watermark or letterhead
          // background; drawing it in the flow would cover the page.
          notice(scope.context, "watermark");
          return;
        }
      }
      scope.tokens.push({ kind: "image", path: rel.target, widthPx, heightPx, alt, floating, align });
      return;
    }
  }
  // Text boxes and shapes with text: keep their paragraphs, in line.
  const textBox = descendants(holder, "txbxContent")[0];
  if (textBox) {
    notice(scope.context, "textbox");
    scope.trailingBlocks.push(await convertBlocks(scope.context, scope.part, textBox));
    return;
  }
  if (/chart|diagram/.test(uri)) {
    notice(scope.context, "chart");
    return;
  }
  if (!/wordprocessingGroup|wordprocessingShape/.test(uri)) notice(scope.context, "shape");
}

async function collectVml(scope: RunScope, element: Element) {
  const imageData = descendants(element, "imagedata")[0];
  const relId = attr(imageData, "id");
  if (relId) {
    const rel = scope.part.rels.get(relId);
    const shape = imageData?.parentElement;
    const style = shape?.getAttribute("style") ?? "";
    const dimension = (name: string) => {
      const match = new RegExp(`${name}\\s*:\\s*([\\d.]+)(pt|in|px)?`, "i").exec(style);
      if (!match) return 0;
      const value = Number(match[1]);
      const pt = match[2] === "in" ? value * 72 : match[2] === "px" ? value * 0.75 : value;
      return roundTo(pxFromPt(pt), 2);
    };
    if (rel && !rel.external) {
      const isWatermark = /WordPictureWatermark|PowerPlusWaterMark/i.test(shape?.getAttribute("id") ?? "");
      if (isWatermark) {
        notice(scope.context, "watermark");
        return;
      }
      scope.tokens.push({
        kind: "image",
        path: rel.target,
        widthPx: dimension("width"),
        heightPx: dimension("height"),
        alt: shape?.getAttribute("alt") ?? "",
        floating: /position\s*:\s*absolute/i.test(style),
      });
      return;
    }
  }
  const textBox = descendants(element, "txbxContent")[0];
  if (textBox) {
    if (/PowerPlusWaterMark/i.test(element.innerHTML)) {
      notice(scope.context, "watermark");
      return;
    }
    notice(scope.context, "textbox");
    scope.trailingBlocks.push(await convertBlocks(scope.context, scope.part, textBox));
  }
}

/* ------------------------------ paragraph rendering ------------------------------ */

type BlockOptions = {
  /** Positions that stand in for the paragraph's tab stops, in twips from
   * the text column's left edge (Word measures tab stops from the margin). */
  tableLayer?: { pPr: ParaProps; rPr: RunProps };
  headerFooter: boolean;
};

type RenderedParagraph = {
  /** Output blocks: paragraphs plus page-break markers. */
  html: string;
  styleId?: string;
  contextual: boolean;
  spacingBeforePx: number;
  spacingAfterPx: number;
  /** Index into the html where margin values can be adjusted. */
  sectionBreak?: boolean;
  isEmpty: boolean;
  /** Paragraph pieces before/after contextual spacing adjustments. */
  pieces: ParagraphPiece[];
};

type ParagraphPiece = {
  tag: string;
  styles: string[];
  marginTopPx: number;
  marginBottomPx: number;
  inner: string;
  breakBefore: boolean;
  dir?: string;
};

function borderCss(border: Border | null | undefined) {
  if (border === undefined) return undefined;
  if (border === null) return "none";
  const width = Math.max(0.75, roundTo(pxFromPt(border.widthPt), 2));
  const style = /double/i.test(border.style)
    ? "double"
    : /dot/i.test(border.style)
      ? "dotted"
      : /dash/i.test(border.style)
        ? "dashed"
        : "solid";
  // Double borders need room for two strokes and a gap.
  const shown = style === "double" ? Math.max(width, 2.5) : width;
  return `${roundTo(shown, 2)}px ${style} ${border.color ? `#${border.color}` : "#000000"}`;
}

function lineHeightCss(pPr: ParaProps, dominantFormat: RunFormat): string | undefined {
  const factor = fontLineFactor(dominantFormat.font);
  const rule = pPr.lineRule ?? "auto";
  if (pPr.line === undefined) return undefined;
  if (rule === "auto") {
    return String(roundTo((pPr.line / 240) * factor, 3));
  }
  const linePx = pxFromPt(ptFromTwips(pPr.line));
  if (rule === "exact") return `${roundTo(linePx, 2)}px`;
  // atLeast: the larger of the requested height and the font's own line.
  const natural = dominantFormat.sizePx * factor;
  return linePx > natural ? `${roundTo(linePx, 2)}px` : String(roundTo(factor, 3));
}

function alignCss(value: string | undefined, bidi?: boolean) {
  switch (value) {
    case "center":
      return "center";
    case "right":
    case "end":
      return bidi ? "left" : "right";
    case "both":
    case "distribute":
    case "lowKashida":
    case "mediumKashida":
    case "highKashida":
    case "thaiDistribute":
      return "justify";
    case "left":
    case "start":
      return bidi ? "right" : undefined;
    default:
      return undefined;
  }
}

function formatStyles(format: RunFormat, base: { font: string; sizePx: number; color?: string; background?: string }) {
  const styles: string[] = [];
  if (format.font !== base.font) styles.push(`font-family: ${format.font}`);
  if (Math.abs(format.sizePx - base.sizePx) > 0.01) styles.push(`font-size: ${format.sizePx}px`);
  if ((format.color ?? "") !== (base.color ?? "")) styles.push(`color: ${format.color ?? "#000000"}`);
  if (format.background && format.background !== base.background) {
    styles.push(`background-color: ${format.background}`);
  }
  if (format.caps) styles.push("text-transform: uppercase");
  if (format.smallCaps) styles.push("font-variant: small-caps");
  if (format.letterSpacingPx) styles.push(`letter-spacing: ${format.letterSpacingPx}px`);
  return styles;
}

function wrapFormatted(html: string, format: RunFormat, base: { font: string; sizePx: number; color?: string; background?: string }) {
  let out = html;
  if (format.vertAlign === "super") out = `<sup>${out}</sup>`;
  else if (format.vertAlign === "sub") out = `<sub>${out}</sub>`;
  if (format.strike) out = `<s>${out}</s>`;
  if (format.underline) out = `<u>${out}</u>`;
  if (format.italic) out = `<em>${out}</em>`;
  if (format.bold) out = `<strong>${out}</strong>`;
  const styles = formatStyles(format, base);
  if (styles.length) out = `<span style="${escapeAttribute(styles.join("; "))}">${out}</span>`;
  return out;
}

function sameFormat(a: RunFormat, b: RunFormat) {
  return (
    a.font === b.font &&
    a.sizePx === b.sizePx &&
    a.color === b.color &&
    a.background === b.background &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.caps === b.caps &&
    a.smallCaps === b.smallCaps &&
    a.vertAlign === b.vertAlign &&
    a.letterSpacingPx === b.letterSpacingPx
  );
}

/** The run style covering the most characters: written once on the block so
 * spans only carry differences. */
function dominantFormat(tokens: Token[], fallback: RunFormat) {
  const weights = new Map<string, { format: RunFormat; weight: number }>();
  tokens.forEach((token) => {
    if (token.kind !== "text" && token.kind !== "marker") return;
    const key = `${token.format.font}|${token.format.sizePx}|${token.format.color ?? ""}`;
    const entry = weights.get(key) ?? { format: token.format, weight: 0 };
    entry.weight += token.text.length;
    weights.set(key, entry);
  });
  let best: { format: RunFormat; weight: number } | null = null;
  weights.forEach((entry) => {
    if (!best || entry.weight > best.weight) best = entry;
  });
  return (best as { format: RunFormat; weight: number } | null)?.format ?? fallback;
}

/** Spaces the browser would collapse but Word draws: repeated spaces, a
 * space at the start of a line, and spaces inside underlined or highlighted
 * runs (fill-in lines) become non-breaking spaces. */
function preserveSpaces(tokens: Token[]) {
  let previousWasSpace = true;
  tokens.forEach((token) => {
    if (token.kind === "text") {
      const keepAll =
        (token.format.underline || token.format.strike || Boolean(token.format.background)) &&
        !token.text.trim();
      let out = "";
      for (const char of token.text) {
        if (char === " " && (previousWasSpace || keepAll)) {
          out += "\u00a0";
          previousWasSpace = false;
          continue;
        }
        out += char;
        previousWasSpace = char === " ";
      }
      token.text = out;
    } else if (token.kind === "break") {
      previousWasSpace = true;
    } else if (token.kind === "tab" || token.kind === "image" || token.kind === "marker") {
      previousWasSpace = false;
    }
  });
}

type TabStopSpec = { posPx: number; posTwips: number; kind: string; leader: string };

type TabLayout = {
  leftPx: number;
  firstLinePx: number;
  stops: TabStopSpec[];
  defaultStopTwips: number;
  hangingStopTwips: number | null;
};

const twipsToPx = (twips: number) => pxFromPt(ptFromTwips(twips));

function nextTabStop(layout: TabLayout, x: number): TabStopSpec {
  const custom = layout.stops.find((stop) => stop.posPx > x + 0.5 && stop.kind !== "bar");
  // Word treats a hanging indent as an implicit stop before any default one.
  if (layout.hangingStopTwips !== null && x + 0.5 < twipsToPx(layout.hangingStopTwips)) {
    if (!custom || custom.posTwips > layout.hangingStopTwips) {
      return {
        posPx: twipsToPx(layout.hangingStopTwips),
        posTwips: layout.hangingStopTwips,
        kind: "left",
        leader: "none",
      };
    }
  }
  if (custom) return custom;
  const step = Math.max(120, layout.defaultStopTwips);
  const xTwips = Math.round(ptFromPx(x + 0.5) * 20);
  const next = Math.floor(xTwips / step) * step + step;
  return { posPx: twipsToPx(next), posTwips: next, kind: "left", leader: "none" };
}

/** The spacer remembers the Word stop it reached (kind and position in
 * twips) in its classes, so the Word export can rebuild the real tab stop. */
function tabSpacerHtml(widthPx: number, stop: TabStopSpec) {
  const styles = [`display: inline-block`, `width: ${roundTo(Math.max(0, widthPx), 2)}px`];
  const leader = stop.leader;
  if (leader === "dot" || leader === "middleDot") styles.push("border-bottom: 1.5px dotted currentcolor");
  else if (leader === "hyphen") styles.push("border-bottom: 1px dashed currentcolor");
  else if (leader === "underscore" || leader === "heavy") styles.push(`border-bottom: ${leader === "heavy" ? 2 : 1}px solid currentcolor`);
  const kind = stop.kind === "end" ? "right" : stop.kind === "start" ? "left" : stop.kind;
  const classes = [DOCUMENT_TAB_CLASS, `${DOCUMENT_TAB_CLASS}-${kind}`, `${DOCUMENT_TAB_CLASS}-at-${Math.max(0, Math.round(stop.posTwips))}`];
  return `<span class="${classes.join(" ")}" style="${styles.join("; ")}">\t</span>`;
}

/** Lays the paragraph out along its first line to give every tab the width
 * that reaches its stop (left, center, right, and decimal stops). */
function renderTokens(
  context: ConversionContext,
  tokens: Token[],
  base: RunFormat,
  layout: TabLayout,
  images: Map<string, ImageData | null>,
): string {
  const parts: string[] = [];
  let x = layout.firstLinePx;
  let index = 0;
  const segmentWidth = (from: number) => {
    let width = 0;
    for (let cursor = from; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token.kind === "tab" || token.kind === "break" || token.kind === "page-break") break;
      if (token.kind === "text" || token.kind === "marker") width += measureToken(context, token.text, token.format);
      if (token.kind === "image") width += token.widthPx;
    }
    return width;
  };
  const decimalOffset = (from: number) => {
    let width = 0;
    for (let cursor = from; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token.kind === "tab" || token.kind === "break" || token.kind === "page-break") break;
      if (token.kind === "text") {
        const dot = token.text.indexOf(".");
        if (dot !== -1) return width + measureToken(context, token.text.slice(0, dot), token.format);
        width += measureToken(context, token.text, token.format);
      }
    }
    return width;
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === "text") {
      // Group consecutive tokens with the same formatting, link, and field.
      let text = token.text;
      let next = index + 1;
      while (next < tokens.length) {
        const candidate = tokens[next];
        if (
          candidate.kind !== "text" ||
          candidate.href !== token.href ||
          candidate.field !== token.field ||
          !sameFormat(candidate.format, token.format)
        ) {
          break;
        }
        text += candidate.text;
        next += 1;
      }
      x += measureToken(context, text, token.format);
      let html = escapeHtml(text);
      if (token.field) {
        const className = token.field === "page" ? DOCUMENT_FIELD_PAGE_CLASS : DOCUMENT_FIELD_PAGES_CLASS;
        html = `<span class="${className}">${html}</span>`;
      }
      html = wrapFormatted(html, token.format, base);
      if (token.href) html = `<a href="${escapeAttribute(token.href)}">${html}</a>`;
      parts.push(html);
      index = next;
      continue;
    }
    if (token.kind === "marker") {
      x += measureToken(context, token.text, token.format);
      parts.push(
        wrapFormatted(
          `<span class="${DOCUMENT_LIST_MARKER_CLASS}">${escapeHtml(token.text)}</span>`,
          token.format,
          base,
        ),
      );
      if (token.suffix === "space") {
        parts.push("\u00a0");
        x += measureToken(context, " ", token.format);
      } else if (token.suffix === "tab") {
        const stop = nextTabStop(layout, x);
        const width = Math.max(measureToken(context, " ", token.format), stop.posPx - x);
        parts.push(tabSpacerHtml(width, stop));
        x += width;
      }
      index += 1;
      continue;
    }
    if (token.kind === "tab") {
      const stop = nextTabStop(layout, x);
      let width = stop.posPx - x;
      const following = segmentWidth(index + 1);
      // A pixel of slack keeps text aligned to a stop at the margin from
      // wrapping onto its own line over sub-pixel rounding.
      if (stop.kind === "right" || stop.kind === "end") width -= following + 1;
      else if (stop.kind === "center") width -= following / 2 + 0.5;
      else if (stop.kind === "decimal") width -= decimalOffset(index + 1) + 0.5;
      // A stop the text already passed (or a right tab whose text does not
      // fit) still advances by at least a space, as Word does.
      width = Math.max(measureToken(context, " ", token.format), width);
      parts.push(tabSpacerHtml(width, stop));
      x += width;
      index += 1;
      continue;
    }
    if (token.kind === "break") {
      parts.push("<br>");
      x = layout.leftPx;
      index += 1;
      continue;
    }
    if (token.kind === "image") {
      const image = images.get(token.path);
      if (image) {
        const styles = [`width: ${token.widthPx}px`, `height: ${token.heightPx}px`];
        parts.push(`<img src="${image.src}" alt="${escapeAttribute(token.alt)}" style="${styles.join("; ")}">`);
        x += token.widthPx;
      }
      index += 1;
      continue;
    }
    if (token.kind === "blocks") {
      index += 1;
      continue;
    }
    index += 1;
  }
  return parts.join("");
}

function paragraphLayout(context: ConversionContext, pPr: ParaProps): TabLayout {
  const leftPx = twipsToPx(pPr.indLeft ?? 0);
  const firstLineTwips = (pPr.indFirstLine ?? 0) - (pPr.indHanging ?? 0);
  return {
    leftPx,
    firstLinePx: leftPx + twipsToPx(firstLineTwips),
    stops: (pPr.tabs ?? [])
      .filter((tab) => tab.kind !== "clear")
      .map((tab) => ({ posPx: twipsToPx(tab.pos), posTwips: tab.pos, kind: tab.kind, leader: tab.leader })),
    defaultStopTwips: context.defaultTabTwips,
    hangingStopTwips: pPr.indHanging ? pPr.indLeft ?? 0 : null,
  };
}

async function resolveImages(context: ConversionContext, tokens: Token[]) {
  const images = new Map<string, ImageData | null>();
  for (const token of tokens) {
    if (token.kind !== "image" || images.has(token.path)) continue;
    let pending = context.images.get(token.path);
    if (!pending) {
      pending = loadImage(context, token.path, token.widthPx);
      context.images.set(token.path, pending);
    }
    images.set(token.path, await pending);
  }
  return images;
}

function blockStyles(
  context: ConversionContext,
  pPr: ParaProps,
  base: RunFormat,
  options: { heading: boolean },
): string[] {
  const styles: string[] = [];
  const align = alignCss(pPr.align, pPr.bidi);
  if (align) styles.push(`text-align: ${align}`);
  const left = pPr.indLeft ?? 0;
  const right = pPr.indRight ?? 0;
  const firstLine = (pPr.indFirstLine ?? 0) - (pPr.indHanging ?? 0);
  if (left) styles.push(`margin-left: ${cssPx(ptFromTwips(left))}`);
  if (right) styles.push(`margin-right: ${cssPx(ptFromTwips(right))}`);
  if (firstLine) styles.push(`text-indent: ${cssPx(ptFromTwips(firstLine))}`);
  const lineHeight = lineHeightCss(pPr, base);
  if (lineHeight) styles.push(`line-height: ${lineHeight}`);
  // Headings always state their size: the editor's heading scale must not
  // apply to a Word heading that is drawn at body size.
  if (base.font !== context.base.font) styles.push(`font-family: ${base.font}`);
  if (options.heading || Math.abs(base.sizePx - context.base.sizePx) > 0.01) styles.push(`font-size: ${base.sizePx}px`);
  if ((base.color ?? "#000000").toLowerCase() !== context.base.color.toLowerCase()) {
    styles.push(`color: ${base.color ?? "#000000"}`);
  }
  if (options.heading) styles.push("font-weight: normal");
  if (pPr.shading) styles.push(`background-color: #${pPr.shading}`);
  (["top", "right", "bottom", "left"] as const).forEach((side) => {
    const border = pPr.borders?.[side];
    const css = borderCss(border);
    if (css && css !== "none" && border) {
      styles.push(`border-${side}: ${css}`);
      if (border.spacePt) styles.push(`padding-${side}: ${cssPx(border.spacePt)}`);
    }
  });
  return styles;
}

function spacingPx(pPr: ParaProps) {
  const before = pPr.beforeAuto ? 14 : ptFromTwips(pPr.spacingBefore ?? 0);
  const after = pPr.afterAuto ? 14 : ptFromTwips(pPr.spacingAfter ?? 0);
  return { before: roundTo(pxFromPt(before), 2), after: roundTo(pxFromPt(after), 2) };
}

async function convertParagraph(
  context: ConversionContext,
  part: PartScope,
  paragraph: Element,
  options: BlockOptions,
): Promise<{ rendered: RenderedParagraph; trailing: string[]; sectionBreak: boolean }> {
  const pPrElement = kid(paragraph, "pPr");
  const resolved = resolveParagraph(context, pPrElement, options.tableLayer);
  const scope: RunScope = {
    context,
    part,
    resolved,
    tokens: [],
    fieldStack: [],
    trailingBlocks: [],
  };
  const markRunProps = parseRunProps(kid(pPrElement, "rPr"), context.theme);
  const markFormat = runFormatFromProps(
    mergeRunProps(
      styleChain(context.styles, markRunProps.styleId).reduce(
        (props, style) => mergeRunProps(props, style.rPr),
        mergeRunProps({}, resolved.baseRPr),
      ),
      { ...markRunProps, vanish: undefined },
    ),
    context,
  );
  if (resolved.numbering && resolved.numbering.text) {
    // Bullets drawn from Symbol/Wingdings are mapped to Unicode, so they
    // take the paragraph's own font rather than the symbol font.
    const levelRPr = { ...resolved.numbering.level.rPr };
    if (levelRPr.font && SYMBOL_FONT.test(levelRPr.font.trim())) delete levelRPr.font;
    const markerProps = mergeRunProps(
      mergeRunProps(mergeRunProps({}, resolved.baseRPr), { ...markRunProps, vanish: undefined }),
      levelRPr,
    );
    const markerFormat = runFormatFromProps(
      { ...markerProps, underline: levelRPr.underline ?? false, strike: levelRPr.strike ?? false },
      context,
    );
    scope.tokens.push({
      kind: "marker",
      text: resolved.numbering.text,
      format: markerFormat,
      suffix: resolved.numbering.level.suffix,
    });
  }
  await collectInline(scope, paragraph);
  preserveSpaces(scope.tokens);

  const sectPr = kid(pPrElement, "sectPr");
  const sectionType = attr(kid(sectPr, "type"), "val") ?? "nextPage";
  const sectionBreak = Boolean(sectPr) && sectionType !== "continuous";

  const heading = options.headerFooter ? null : headingLevel(resolved);
  const tag = heading ? `h${heading}` : "p";
  const base = dominantFormat(scope.tokens, markFormat);
  const layout = paragraphLayout(context, resolved.pPr);
  const images = await resolveImages(context, scope.tokens);
  const styles = blockStyles(context, resolved.pPr, base, { heading: Boolean(heading) });
  const spacing = spacingPx(resolved.pPr);

  // A floating picture alone in its paragraph keeps its horizontal anchor.
  const visible = scope.tokens.filter((token) => token.kind !== "text" || token.text.trim());
  if (
    visible.length === 1 &&
    visible[0].kind === "image" &&
    visible[0].floating &&
    visible[0].align &&
    !styles.some((style) => style.startsWith("text-align"))
  ) {
    const align = visible[0].align === "center" ? "center" : visible[0].align === "right" ? "right" : null;
    if (align) styles.push(`text-align: ${align}`);
  }

  // Page breaks inside the paragraph split it: the text after the break
  // starts the next page, as in Word.
  const segments: Token[][] = [[]];
  scope.tokens.forEach((token) => {
    if (token.kind === "page-break") segments.push([]);
    else segments[segments.length - 1].push(token);
  });
  const pieces: ParagraphPiece[] = segments.map((segment, segmentIndex) => {
    const inner = renderTokens(context, segment, base, layout, images);
    const hasContent = segment.some(
      (token) =>
        (token.kind === "text" && token.text.length > 0) ||
        token.kind === "image" ||
        token.kind === "marker" ||
        token.kind === "tab",
    );
    const endsWithBreak = segment.length > 0 && segment[segment.length - 1].kind === "break";
    return {
      tag,
      styles,
      marginTopPx: segmentIndex === 0 ? spacing.before : 0,
      marginBottomPx: segmentIndex === segments.length - 1 ? spacing.after : 0,
      // Empty paragraphs keep their line (Word draws the paragraph mark).
      inner: hasContent ? (endsWithBreak ? `${inner}<br>` : inner) : "<br>",
      breakBefore: segmentIndex > 0 || (segmentIndex === 0 && Boolean(resolved.pPr.pageBreakBefore)),
      dir: resolved.pPr.bidi ? "rtl" : undefined,
    };
  });
  // Since Word 2013 the paragraph mark after a page break stays on the page
  // before it, so an empty remainder draws no line on the next page; the
  // break itself moves to the following block.
  let breakAfter = false;
  if (pieces.length > 1 && pieces[pieces.length - 1].inner === "<br>" && !segments[segments.length - 1].length) {
    pieces.pop();
    pieces[pieces.length - 1].marginBottomPx = spacing.after;
    breakAfter = true;
  }
  // Text-free pieces left by a break at the very start of a paragraph do not
  // draw a line in Word: drop that leading empty piece.
  if (pieces.length > 1 && pieces[0].inner === "<br>" && !segments[0].length) {
    pieces.shift();
    pieces[0].breakBefore = true;
    pieces[0].marginTopPx = spacing.before;
  }

  const isEmpty = !scope.tokens.some(
    (token) => (token.kind === "text" && token.text.trim()) || token.kind === "image" || token.kind === "marker",
  );
  return {
    rendered: {
      html: "",
      styleId: resolved.styleId,
      contextual: Boolean(resolved.pPr.contextualSpacing),
      spacingBeforePx: spacing.before,
      spacingAfterPx: spacing.after,
      isEmpty,
      pieces,
    },
    trailing: scope.trailingBlocks,
    sectionBreak: sectionBreak || breakAfter,
  };
}

function pieceHtml(piece: ParagraphPiece, allowPageBreaks: boolean) {
  const styles = [
    `margin-top: ${roundTo(piece.marginTopPx, 2)}px`,
    `margin-bottom: ${roundTo(piece.marginBottomPx, 2)}px`,
    ...piece.styles,
  ];
  const dir = piece.dir ? ` dir="${piece.dir}"` : "";
  return `${piece.breakBefore && allowPageBreaks ? '<hr class="document-page-break">' : ""}<${piece.tag}${dir} style="${escapeAttribute(styles.join("; "))}">${piece.inner}</${piece.tag}>`;
}

/* ------------------------------ tables ------------------------------ */

type GridCell = {
  element: Element;
  props: CellProps;
  column: number;
  span: number;
  rowSpan: number;
  skip: boolean;
};

function conditionalLayers(
  style: StyleDef | undefined,
  look: TableLook,
  rowIndex: number,
  rowCount: number,
  column: number,
  columnCount: number,
  headerRows: number,
) {
  if (!style || !style.conditional.size) return [] as ConditionalFormat[];
  const layers: ConditionalFormat[] = [];
  const add = (key: string) => {
    const entry = style.conditional.get(key);
    if (entry) layers.push(entry);
  };
  add("wholeTable");
  const isFirstRow = look.firstRow && rowIndex < Math.max(1, headerRows);
  const isLastRow = look.lastRow && rowIndex === rowCount - 1;
  const bodyRow = rowIndex - (look.firstRow ? Math.max(1, headerRows) : 0);
  if (!look.noVBand) add(column % 2 === 0 ? "band1Vert" : "band2Vert");
  if (!look.noHBand && !isFirstRow && !isLastRow && bodyRow >= 0) add(bodyRow % 2 === 0 ? "band1Horz" : "band2Horz");
  if (look.firstColumn && column === 0) add("firstCol");
  if (look.lastColumn && column === columnCount - 1) add("lastCol");
  if (isFirstRow) add("firstRow");
  if (isLastRow) add("lastRow");
  if (isFirstRow && look.firstColumn && column === 0) add("nwCell");
  if (isFirstRow && look.lastColumn && column === columnCount - 1) add("neCell");
  if (isLastRow && look.firstColumn && column === 0) add("swCell");
  if (isLastRow && look.lastColumn && column === columnCount - 1) add("seCell");
  return layers;
}

async function convertTable(
  context: ConversionContext,
  part: PartScope,
  table: Element,
  options: BlockOptions,
): Promise<string> {
  const direct = parseTableProps(kid(table, "tblPr"), context.theme);
  const styleId = direct.styleId ?? context.styles.defaultTable;
  const chain = styleChain(context.styles, styleId);
  let tblProps: TableProps = {};
  let tableCell: CellProps = {};
  let tablePPr: ParaProps = {};
  let tableRPr: RunProps = {};
  chain.forEach((style) => {
    tblProps = {
      ...tblProps,
      ...Object.fromEntries(Object.entries(style.tblPr).filter(([, value]) => value !== undefined)),
      borders: { ...(tblProps.borders ?? {}), ...(style.tblPr.borders ?? {}) },
      cellMargins: { ...(tblProps.cellMargins ?? {}), ...(style.tblPr.cellMargins ?? {}) },
    };
    tableCell = mergeCellProps(tableCell, style.tcPr);
    tablePPr = mergeParaProps(tablePPr, style.pPr);
    tableRPr = mergeRunProps(tableRPr, style.rPr);
  });
  tblProps = {
    ...tblProps,
    ...Object.fromEntries(Object.entries(direct).filter(([, value]) => value !== undefined)),
    borders: { ...(tblProps.borders ?? {}), ...(direct.borders ?? {}) },
    cellMargins: { ...(tblProps.cellMargins ?? {}), ...(direct.cellMargins ?? {}) },
  };
  const look: TableLook = tblProps.look ?? {
    firstRow: true,
    lastRow: false,
    firstColumn: true,
    lastColumn: false,
    noHBand: false,
    noVBand: true,
  };
  const styleDef = chain[chain.length - 1];

  const grid = kids(kid(table, "tblGrid"), "gridCol").map((col) => numAttr(col, "w") ?? 0);
  const rows = kids(table).flatMap((child) => {
    if (child.localName === "tr") return [child];
    // Rows wrapped in content controls or custom XML.
    if (child.localName === "sdt") return kids(kid(child, "sdtContent"), "tr");
    if (child.localName === "customXml") return kids(child, "tr");
    return [];
  });
  const headerRows = rows.findIndex((row) => !onOff(kid(kid(row, "trPr"), "tblHeader")));
  const headerRowCount = headerRows === -1 ? rows.length : headerRows;

  // Lay cells onto the grid to resolve vertical merges into rowspans.
  const cellRows: GridCell[][] = rows.map((row) => {
    let column = numAttr(kid(kid(row, "trPr"), "gridBefore"), "val") ?? 0;
    return kids(row)
      .flatMap((child) => (child.localName === "tc" ? [child] : child.localName === "sdt" ? kids(kid(child, "sdtContent"), "tc") : []))
      .map((cell) => {
        const props = parseCellProps(kid(cell, "tcPr"), context.theme);
        const span = props.gridSpan ?? 1;
        const entry: GridCell = { element: cell, props, column, span, rowSpan: 1, skip: false };
        column += span;
        return entry;
      });
  });
  cellRows.forEach((row, rowIndex) => {
    row.forEach((cell) => {
      if (cell.props.vMerge !== "continue") return;
      cell.skip = true;
      for (let above = rowIndex - 1; above >= 0; above -= 1) {
        const owner = cellRows[above].find((candidate) => candidate.column === cell.column && !candidate.skip);
        if (owner) {
          owner.rowSpan += 1;
          break;
        }
        const continued = cellRows[above].find((candidate) => candidate.column === cell.column);
        if (!continued) break;
      }
    });
  });
  const columnCount = Math.max(grid.length, ...cellRows.map((row) => row.reduce((sum, cell) => Math.max(sum, cell.column + cell.span), 0)));
  const gridWidths = Array.from({ length: columnCount }, (_, index) => grid[index] ?? 0);
  const totalGrid = gridWidths.reduce((sum, width) => sum + width, 0);

  const tableStyles: string[] = ["border-collapse: collapse"];
  if (totalGrid > 0) {
    tableStyles.push(`width: ${cssPx(ptFromTwips(totalGrid))}`, "table-layout: fixed");
  } else if (tblProps.widthType === "pct" && tblProps.widthTwips) {
    // Percent widths are fiftieths of a percent (or an explicit "%").
    tableStyles.push(`width: ${roundTo(tblProps.widthTwips / 50, 2)}%`);
  } else if (tblProps.widthType === "dxa" && tblProps.widthTwips) {
    tableStyles.push(`width: ${cssPx(ptFromTwips(tblProps.widthTwips))}`);
  }
  const leftMargin = tblProps.cellMargins?.left ?? 108;
  if (tblProps.align === "center") tableStyles.push("margin-left: auto", "margin-right: auto");
  else if (tblProps.align === "right" || tblProps.align === "end") tableStyles.push("margin-left: auto");
  else {
    // Before Word 2013 the indent places the cell text, so the border sits
    // one cell margin further left; Word 2013+ places the border itself.
    const indent = (tblProps.indentTwips ?? 0) - (context.tableIndentToBorder ? 0 : leftMargin);
    if (indent) tableStyles.push(`margin-left: ${cssPx(ptFromTwips(indent))}`);
  }

  const colgroup = totalGrid > 0
    ? `<colgroup>${gridWidths.map((width) => `<col style="width: ${cssPx(ptFromTwips(width))}">`).join("")}</colgroup>`
    : "";

  const rowHtml: string[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const trPr = kid(row, "trPr");
    const heightEl = kid(trPr, "trHeight");
    const heightTwips = numAttr(heightEl, "val");
    const rowStyles: string[] = [];
    if (heightTwips) rowStyles.push(`height: ${cssPx(ptFromTwips(heightTwips))}`);
    const cells: string[] = [];
    for (const cell of cellRows[rowIndex]) {
      if (cell.skip) continue;
      const layers = conditionalLayers(styleDef, look, rowIndex, rows.length, cell.column, columnCount, headerRowCount);
      let cellProps: CellProps = mergeCellProps({}, tableCell);
      let layerPPr = mergeParaProps({}, tablePPr);
      let layerRPr = mergeRunProps({}, tableRPr);
      layers.forEach((layer) => {
        cellProps = mergeCellProps(cellProps, layer.tcPr);
        layerPPr = mergeParaProps(layerPPr, layer.pPr);
        layerRPr = mergeRunProps(layerRPr, layer.rPr);
      });
      cellProps = mergeCellProps(cellProps, cell.props);
      const isTop = rowIndex === 0;
      const isBottom = rowIndex + cell.rowSpan >= rows.length;
      const isLeft = cell.column === 0;
      const isRight = cell.column + cell.span >= columnCount;
      const sideBorder = (side: "top" | "bottom" | "left" | "right") => {
        const own = cellProps.borders?.[side];
        if (own !== undefined) return own;
        const edge = side === "top" ? isTop : side === "bottom" ? isBottom : side === "left" ? isLeft : isRight;
        const tableBorders = tblProps.borders ?? {};
        if (edge) return tableBorders[side];
        return side === "top" || side === "bottom" ? tableBorders.insideH : tableBorders.insideV;
      };
      const styles: string[] = [];
      (["top", "right", "bottom", "left"] as const).forEach((side) => {
        const css = borderCss(sideBorder(side));
        if (css && css !== "none") styles.push(`border-${side}: ${css}`);
      });
      const margin = (side: "top" | "bottom" | "left" | "right", fallback: number) =>
        cellProps.margins?.[side] ?? tblProps.cellMargins?.[side] ?? fallback;
      const padding = [margin("top", 0), margin("right", 108), margin("bottom", 0), margin("left", 108)]
        .map((twips) => cssPx(ptFromTwips(twips)))
        .join(" ");
      styles.push(`padding: ${padding}`);
      if (cellProps.shading) styles.push(`background-color: #${cellProps.shading}`);
      const vAlign = cellProps.vAlign === "center" ? "middle" : cellProps.vAlign === "bottom" ? "bottom" : "top";
      styles.push(`vertical-align: ${vAlign}`);
      const content = await convertBlocks(context, part, cell.element, {
        ...options,
        tableLayer: { pPr: layerPPr, rPr: layerRPr },
      });
      const spanAttrs = `${cell.span > 1 ? ` colspan="${cell.span}"` : ""}${cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ""}`;
      cells.push(`<td${spanAttrs} style="${escapeAttribute(styles.join("; "))}">${content || "<p><br></p>"}</td>`);
    }
    const styleAttr = rowStyles.length ? ` style="${escapeAttribute(rowStyles.join("; "))}"` : "";
    rowHtml.push(`<tr${styleAttr}>${cells.join("")}</tr>`);
  }
  const head = headerRowCount > 0 && headerRowCount < rows.length ? `<thead>${rowHtml.slice(0, headerRowCount).join("")}</thead>` : "";
  const body = `<tbody>${rowHtml.slice(head ? headerRowCount : 0).join("")}</tbody>`;
  return `<table style="${escapeAttribute(tableStyles.join("; "))}">${colgroup}${head}${body}</table>`;
}

/* ------------------------------ block walking ------------------------------ */

/** Converts the block children of body/cell/header/note containers. */
async function convertBlocks(
  context: ConversionContext,
  part: PartScope,
  container: Element,
  options: BlockOptions = { headerFooter: part.headerFooter },
): Promise<string> {
  const output: string[] = [];
  let previous: RenderedParagraph | null = null;
  const flushPrevious = () => {
    if (previous) {
      // Page breaks inside table cells and headers/footers do not break pages.
      const allowPageBreaks = !options.headerFooter && !options.tableLayer;
      output.push(previous.pieces.map((piece) => pieceHtml(piece, allowPageBreaks)).join(""));
      previous = null;
    }
  };
  const visit = async (nodes: Element[]) => {
    for (const node of nodes) {
      switch (node.localName) {
        case "p": {
          const { rendered, trailing, sectionBreak } = await convertParagraph(context, part, node, options);
          // "Don't add space between paragraphs of the same style."
          if (previous && previous.styleId === rendered.styleId) {
            const prevLast = previous.pieces[previous.pieces.length - 1];
            const nextFirst = rendered.pieces[0];
            if (previous.contextual && prevLast) prevLast.marginBottomPx = 0;
            if (rendered.contextual && nextFirst && !nextFirst.breakBefore) nextFirst.marginTopPx = 0;
          }
          flushPrevious();
          previous = rendered;
          if (trailing.length) {
            flushPrevious();
            output.push(...trailing);
          }
          if (sectionBreak && !options.headerFooter && !options.tableLayer) {
            flushPrevious();
            output.push('<hr class="document-page-break">');
          }
          break;
        }
        case "tbl":
          flushPrevious();
          output.push(await convertTable(context, part, node, options));
          break;
        case "sdt":
          await visit(kids(kid(node, "sdtContent")));
          break;
        case "customXml":
        case "ins":
        case "moveTo":
          await visit(kids(node));
          break;
        case "AlternateContent": {
          const choice = kid(node, "Choice");
          await visit(kids(choice ?? kid(node, "Fallback")));
          break;
        }
        default:
          break;
      }
    }
  };
  await visit(kids(container));
  flushPrevious();
  return output.join("");
}

/* ------------------------------ sections and parts ------------------------------ */

function firstSectionProperties(body: Element | null): Element | null {
  if (!body) return null;
  for (const child of kids(body)) {
    if (child.localName === "p") {
      const sectPr = kid(kid(child, "pPr"), "sectPr");
      if (sectPr) return sectPr;
    }
  }
  return kid(body, "sectPr");
}

function allSectionProperties(body: Element | null): Element[] {
  if (!body) return [];
  const sections = kids(body, "p")
    .map((paragraph) => kid(kid(paragraph, "pPr"), "sectPr"))
    .filter((value): value is Element => Boolean(value));
  const final = kid(body, "sectPr");
  if (final) sections.push(final);
  return sections;
}

async function convertHeaderFooter(
  context: ConversionContext,
  sectPr: Element | null,
  rels: Map<string, Relationship>,
  kind: "headerReference" | "footerReference",
  type: "default" | "first",
): Promise<string | null> {
  const reference = kids(sectPr, kind).find((node) => (attr(node, "type") ?? "default") === type);
  const relId = attr(reference, "id");
  if (!relId) return null;
  const rel = rels.get(relId);
  if (!rel || rel.external) return null;
  const xml = readPartXml(context.parts, rel.target);
  if (!xml) return null;
  const part: PartScope = {
    path: rel.target,
    rels: relationshipsFor(context.parts, rel.target),
    headerFooter: true,
  };
  return convertBlocks(context, part, xml.documentElement, { headerFooter: true });
}

function noteMap(xml: Document | null, name: "footnote" | "endnote") {
  const map = new Map<string, Element>();
  if (!xml) return map;
  kids(xml.documentElement, name).forEach((note) => {
    const id = attr(note, "id");
    const type = attr(note, "type");
    // Separator and continuation notes are layout scaffolding, not notes.
    if (id && (!type || type === "normal")) map.set(id, note);
  });
  return map;
}

async function renderNotes(context: ConversionContext): Promise<string> {
  if (!context.notes.length) return "";
  const blocks: string[] = [
    `<p style="margin-top: ${cssPx(12)}; margin-bottom: ${cssPx(6)}; width: ${cssPx(144)}; border-top: 0.75px solid #000000; line-height: 1"><br></p>`,
  ];
  for (const note of context.notes) {
    const element =
      note.kind === "footnote"
        ? context.noteParts.footnotes.get(note.id)
        : context.noteParts.endnotes.get(note.id);
    if (!element) continue;
    const part: PartScope = {
      path: note.kind === "footnote" ? "word/footnotes.xml" : "word/endnotes.xml",
      rels: note.kind === "footnote" ? context.footnoteRels : context.endnoteRels,
      headerFooter: false,
    };
    // The note's own reference mark (w:footnoteRef) renders as its number.
    context.currentNoteNumber = note.number;
    blocks.push(await convertBlocks(context, part, element, { headerFooter: true }));
    context.currentNoteNumber = null;
  }
  notice(context, "notes");
  return blocks.join("");
}

function noticeText(key: string, count: number) {
  switch (key) {
    case "floating":
      return `${count} floating picture${count === 1 ? " was" : "s were"} placed in line with the text.`;
    case "textbox":
      return "Text boxes were placed in line with the surrounding text.";
    case "tracked":
      return "This document contains tracked changes; it opened with all changes accepted.";
    case "comments":
      return "Comments in the Word file were not imported.";
    case "metafile":
      return `${count} picture${count === 1 ? " is" : "s are"} Windows metafiles (EMF/WMF), which browsers cannot display, and ${count === 1 ? "was" : "were"} left out.`;
    case "image-format":
      return `${count} picture${count === 1 ? " uses" : "s use"} a format this browser cannot display and ${count === 1 ? "was" : "were"} left out.`;
    case "image-too-large":
      return `${count} very large picture${count === 1 ? " was" : "s were"} left out to keep the draft within its size limit.`;
    case "image-budget":
      return "Some pictures were left out to keep the draft within its size limit.";
    case "chart":
      return "Charts and SmartArt graphics were left out; they cannot be edited here.";
    case "shape":
      return "Drawing shapes without text were left out.";
    case "watermark":
      return "The page watermark/background picture was left out.";
    case "notes":
      return "Footnotes are shown at the end of the document.";
    case "columns":
      return "Multi-column sections are shown as a single column.";
    case "sections":
      return "Page size or margins change between sections; the first section's page setup is used.";
    case "math":
      return "Equations were imported as plain text.";
    default:
      return "";
  }
}

/* ------------------------------ entry point ------------------------------ */

export async function importDocxDocument(bytes: Uint8Array): Promise<DocxImportResult> {
  const parts = await readZip(bytes);
  const rootRels = relationshipsFor(parts, "");
  const mainRel = Array.from(rootRels.values()).find((rel) => rel.type === "officeDocument");
  const documentPath = mainRel?.target ?? "word/document.xml";
  const documentXml = readPartXml(parts, documentPath);
  if (!documentXml) throw new Error("The Word file has no readable document body.");
  const rels = relationshipsFor(parts, documentPath);
  const relOfType = (type: string) => Array.from(rels.values()).find((rel) => rel.type === type && !rel.external);
  const theme = parseTheme(readPartXml(parts, relOfType("theme")?.target ?? "word/theme/theme1.xml"));
  const styles = parseStyles(readPartXml(parts, relOfType("styles")?.target ?? "word/styles.xml"), theme);
  const numbering = parseNumbering(readPartXml(parts, relOfType("numbering")?.target ?? "word/numbering.xml"), theme);
  const settings = readPartXml(parts, relOfType("settings")?.target ?? "word/settings.xml");
  const defaultTabTwips = numAttr(kid(settings?.documentElement, "defaultTabStop"), "val") ?? 720;
  const compatibilityMode =
    numAttr(
      kids(kid(settings?.documentElement, "compat"), "compatSetting").find(
        (setting) => attr(setting, "name") === "compatibilityMode",
      ),
      "val",
    ) ?? 12;
  const footnotesPath = relOfType("footnotes")?.target ?? "word/footnotes.xml";
  const endnotesPath = relOfType("endnotes")?.target ?? "word/endnotes.xml";

  // Normal-style text defines the document defaults.
  let normalRPr = mergeRunProps({}, styles.docRPr);
  let normalPPr = mergeParaProps({}, styles.docPPr);
  styleChain(styles, styles.defaultParagraph).forEach((style) => {
    normalRPr = mergeRunProps(normalRPr, style.rPr);
    normalPPr = mergeParaProps(normalPPr, style.pPr);
  });
  const normalFont = normalRPr.font ?? theme.minorFont;
  const normalFormat: RunFormat = {
    font: cssFontFamilyStack(normalFont),
    sizePx: roundTo(pxFromPt((normalRPr.sizeHalfPt ?? 20) / 2), 2),
    color: normalRPr.color ? `#${normalRPr.color}` : "#000000",
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    caps: false,
    smallCaps: false,
  };

  const context: ConversionContext = {
    parts,
    theme,
    styles,
    numbering,
    defaultTabTwips,
    measure: createMeasurer(),
    images: new Map(),
    imageBudget: { used: 0 },
    counters: new Map(),
    numsSeen: new Set(),
    notes: [],
    noteParts: {
      footnotes: noteMap(readPartXml(parts, footnotesPath), "footnote"),
      endnotes: noteMap(readPartXml(parts, endnotesPath), "endnote"),
    },
    notices: new Map(),
    base: { font: normalFormat.font, sizePx: normalFormat.sizePx, color: normalFormat.color ?? "#000000" },
    footnoteRels: relationshipsFor(parts, footnotesPath),
    endnoteRels: relationshipsFor(parts, endnotesPath),
    currentNoteNumber: null,
    tableIndentToBorder: compatibilityMode >= 15,
  };

  const body = kid(documentXml.documentElement, "body");
  const sectPr = firstSectionProperties(body);
  const sections = allSectionProperties(body);
  const pageSize = kid(sectPr, "pgSz");
  const pageMargin = kid(sectPr, "pgMar");
  const widthPt = ptFromTwips(numAttr(pageSize, "w") ?? 12240);
  const heightPt = ptFromTwips(numAttr(pageSize, "h") ?? 15840);
  const gutter = ptFromTwips(numAttr(pageMargin, "gutter") ?? 0);
  const margin = (name: string, fallback: number) => Math.abs(ptFromTwips(numAttr(pageMargin, name) ?? fallback));
  if (
    sections.some((section) => {
      const size = kid(section, "pgSz");
      return (
        Math.abs(ptFromTwips(numAttr(size, "w") ?? 12240) - widthPt) > 1 ||
        Math.abs(ptFromTwips(numAttr(size, "h") ?? 15840) - heightPt) > 1
      );
    })
  ) {
    notice(context, "sections");
  }
  if (sections.some((section) => (numAttr(kid(section, "cols"), "num") ?? 1) > 1)) notice(context, "columns");

  const part: PartScope = { path: documentPath, rels, headerFooter: false };
  let bodyHtml = await convertBlocks(context, part, body ?? documentXml.documentElement, { headerFooter: false });
  bodyHtml += await renderNotes(context);
  // A final section break has nothing after it; drop the trailing marker.
  bodyHtml = bodyHtml.replace(/(?:<hr class="document-page-break">)+$/, "");

  const titlePage = Boolean(onOff(kid(sectPr, "titlePg")));
  const headerHtml = (await convertHeaderFooter(context, sectPr, rels, "headerReference", "default")) ?? "";
  const footerHtml = (await convertHeaderFooter(context, sectPr, rels, "footerReference", "default")) ?? "";
  const firstHeaderHtml = titlePage
    ? (await convertHeaderFooter(context, sectPr, rels, "headerReference", "first")) ?? ""
    : null;
  const firstFooterHtml = titlePage
    ? (await convertHeaderFooter(context, sectPr, rels, "footerReference", "first")) ?? ""
    : null;

  const setup: DocumentPageSetup = {
    ...LETTER_PAGE_SETUP,
    widthPt,
    heightPt,
    marginTopPt: margin("top", 1440),
    marginRightPt: margin("right", 1440),
    marginBottomPt: margin("bottom", 1440),
    marginLeftPt: margin("left", 1440) + gutter,
    headerDistancePt: margin("header", 720),
    footerDistancePt: margin("footer", 720),
    fontFamily: normalFormat.font,
    fontSizePx: normalFormat.sizePx,
    lineHeight: Number(lineHeightCss(normalPPr, normalFormat) ?? fontLineFactor(normalFormat.font)) || fontLineFactor(normalFormat.font),
    color: normalFormat.color ?? "#000000",
    paragraphBeforePx: spacingPx(normalPPr).before,
    paragraphAfterPx: spacingPx(normalPPr).after,
    headerHtml: isBlankBlocks(headerHtml) ? "" : headerHtml,
    footerHtml: isBlankBlocks(footerHtml) ? "" : footerHtml,
    firstHeaderHtml: firstHeaderHtml === null ? null : isBlankBlocks(firstHeaderHtml) ? "" : firstHeaderHtml,
    firstFooterHtml: firstFooterHtml === null ? null : isBlankBlocks(firstFooterHtml) ? "" : firstFooterHtml,
  };
  // Exact line spacing stored as px is not a usable unitless default.
  if (!Number.isFinite(setup.lineHeight) || setup.lineHeight <= 0.5 || setup.lineHeight >= 5) {
    setup.lineHeight = fontLineFactor(normalFormat.font);
  }

  const warnings = Array.from(context.notices.entries())
    .map(([key, count]) => noticeText(key, count))
    .filter(Boolean);
  return {
    html: `${pageSetupMarkerHtml(setup)}${bodyHtml || "<p><br></p>"}`,
    setup,
    warnings,
  };
}

function isBlankBlocks(html: string) {
  if (/<img\b/i.test(html)) return false;
  const text = html
    .replace(/<span class="document-tab"[^>]*>\t<\/span>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|\u00a0/g, " ")
    .trim();
  return !text;
}
