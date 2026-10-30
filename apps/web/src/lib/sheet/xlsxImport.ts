/** .xlsx import for the Drafts spreadsheet editor.
 *
 * Reads an Office Open XML workbook into the Workbook model: sheets, values,
 * formulas, styles, layout, rules, filters, tables, notes, and charts. Every
 * result passes through `parseWorkbook`, the model's single validation gate.
 *
 * Formulas keep their text and drop Excel's cached results (the engine
 * recalculates on load), except where Aperture cannot read the formula: then
 * the cached value is kept as a literal and the import says so. Shared
 * formulas are expanded into every cell; array formulas stay on their anchor
 * so the engine spills them. What-if data tables keep their values.
 *
 * Nothing in the file is ever executed. Macros, external links, pictures,
 * shapes, pivot table definitions, and chart types the editor cannot draw are
 * left out with a warning; limits are enforced by truncation with a warning.
 */

import { readZip, type ZipParts } from "../ooxmlZipRead";
import {
  type CellRange,
  MAX_SHEET_COLS,
  MAX_SHEET_ROWS,
  cellKey,
  columnIndex,
  columnLabel,
  formatRangeRef,
  parseCellKey,
  parseRangeRef,
  quoteSheetName,
  rangeContains,
  splitSheetQualifiedRef,
} from "./address";
import { needsFilePrefix } from "./formula/excelNames";
import { parseFormula } from "./formula/parser";
import { shiftFormula } from "./formula/references";
import { BUILTIN_NUMBER_FORMATS, isDateFormat } from "./numberFormat";
import { excelWidthToPx, pointsToPx } from "./palette";
import {
  type AccentSlot,
  type BorderStyle,
  type CellBorders,
  type CellLiteral,
  type CellOperator,
  type CellStyle,
  type ConditionalRule,
  type ConditionalStyle,
  type DefinedName,
  type HorizontalAlign,
  type Sheet,
  type SheetCell,
  type SheetChart,
  type SheetChartLegend,
  type SheetChartType,
  type SheetColumn,
  type SheetFilter,
  type SheetFilterCriteria,
  type SheetRow,
  type SheetTable,
  type SheetValidation,
  type TableTone,
  type TextOperator,
  type ValidationKind,
  type VerticalAlign,
  type Workbook,
  MAX_DEFINED_NAMES,
  MAX_FORMULA_CHARS,
  MAX_MERGES_PER_SHEET,
  MAX_OBJECTS_PER_SHEET,
  MAX_RULES_PER_SHEET,
  MAX_SHEETS,
  MAX_SHEET_CONTENT_BYTES,
  MAX_WORKBOOK_CELLS,
  SHEET_SCHEMA_VERSION,
  parseWorkbook,
  serializeWorkbook,
} from "./sheetModel";

export type XlsxImportResult = { workbook: Workbook; warnings: string[] };

const NOT_XLSX = "This file is not an Excel workbook (.xlsx).";
const LEGACY_XLS = "This is an Excel 97–2003 workbook (.xls). Open it in Excel, save it as .xlsx, and import that file.";
const ENCRYPTED = "This workbook is password-protected. Remove the password in Excel, save it, and import it again.";
const BINARY_XLSB = "Binary Excel workbooks (.xlsb) can't be imported. Save it as .xlsx in Excel and import that file.";
const TOO_LARGE = "This workbook is too large to import. Split it into smaller workbooks and import those.";

const EMU_PER_PX = 9525;
const MS_PER_DAY = 86_400_000;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DATE_1904_OFFSET = 1462;

/* ------------------------------------------------------------------ XML helpers */

const decoder = new TextDecoder();

/** Browsers report XML errors as a <parsererror> root, or one placed at the
 * top of the partial document; checking there avoids walking a large sheet. */
function isParseError(root: Element | null): boolean {
  const first = root?.firstElementChild;
  return !root || [root, first, first?.firstElementChild].some((item) => item?.localName === "parsererror");
}

function parseXml(bytes: Uint8Array | undefined): Element | null {
  if (!bytes) return null;
  try {
    const root = new DOMParser().parseFromString(decoder.decode(bytes), "application/xml").documentElement;
    return isParseError(root) ? null : root;
  } catch {
    return null;
  }
}

function kids(element: Element | null | undefined, name?: string): Element[] {
  const result: Element[] = [];
  for (let child = element?.firstElementChild ?? null; child; child = child.nextElementSibling) {
    if (!name || child.localName === name) result.push(child);
  }
  return result;
}

function kid(element: Element | null | undefined, name: string): Element | null {
  for (let child = element?.firstElementChild ?? null; child; child = child.nextElementSibling) {
    if (child.localName === name) return child;
  }
  return null;
}

function descendants(element: Element | null | undefined, name: string): Element[] {
  return element ? Array.from(element.getElementsByTagNameNS("*", name)) : [];
}

/** Unprefixed attribute, as SpreadsheetML writes them. */
function attr(element: Element | null | undefined, name: string): string | null {
  return element ? element.getAttribute(name) : null;
}

/** A relationship id (r:id) by local name, so transitional and strict
 * namespaces read alike. */
function relationId(element: Element | null | undefined): string {
  const attributes = element?.attributes;
  for (let index = 0; attributes && index < attributes.length; index += 1) {
    if (attributes[index].localName === "id" && attributes[index].prefix) return attributes[index].value;
  }
  return "";
}

function num(element: Element | null | undefined, name: string): number | undefined {
  const raw = attr(element, name);
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** xsd:boolean attribute: "1"/"true" or "0"/"false"; undefined when absent. */
function flag(element: Element | null | undefined, name: string): boolean | undefined {
  const raw = attr(element, name);
  return raw === null ? undefined : raw === "1" || raw.toLowerCase() === "true";
}

/** On/off element such as <b/>: present means on unless its val says off. */
function onOff(element: Element | null): boolean {
  return Boolean(element) && !/^(0|false|off|none)$/i.test(attr(element, "val") ?? "1");
}

function textOf(element: Element | null | undefined): string {
  return element?.textContent ?? "";
}

/** OOXML escapes characters XML cannot hold as "_xHHHH_". */
function decodeEscapes(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Plain text of a shared string, inline string, or comment: runs joined,
 * phonetic hints dropped. */
function richText(element: Element | null): string {
  const direct = kid(element, "t");
  const text = direct ? textOf(direct) : kids(element, "r").map((run) => textOf(kid(run, "t"))).join("");
  return decodeEscapes(text);
}

function compact<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
}

/* ------------------------------------------------------------------ package */

type Relationship = { type: string; target: string; external: boolean };
type Relationships = Map<string, Relationship>;

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWithBytes(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function containsUtf16(bytes: Uint8Array, text: string): boolean {
  const pattern = Array.from(text).flatMap((ch) => [ch.charCodeAt(0), 0]);
  for (let at = 0; at + pattern.length <= bytes.length; at += 1) {
    if (bytes[at] === pattern[0] && pattern.every((byte, index) => bytes[at + index] === byte)) return true;
  }
  return false;
}

/** Legacy .xls and encrypted .xlsx files are both OLE compound files. */
function containerProblem(bytes: Uint8Array): string | null {
  if (startsWithBytes(bytes, OLE_SIGNATURE)) return containsUtf16(bytes, "EncryptedPackage") ? ENCRYPTED : LEGACY_XLS;
  return startsWithBytes(bytes, [0x50, 0x4b]) ? null : NOT_XLSX;
}

async function openPackage(bytes: Uint8Array): Promise<ZipParts> {
  const problem = containerProblem(bytes);
  if (problem) throw new Error(problem);
  try {
    return await readZip(bytes);
  } catch {
    throw new Error(NOT_XLSX);
  }
}

function partDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

function resolvePartPath(basePath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const resolved: string[] = [];
  for (const segment of `${partDirectory(basePath)}${target}`.split("/")) {
    if (segment === "..") resolved.pop();
    else if (segment && segment !== ".") resolved.push(segment);
  }
  return resolved.join("/");
}

function relationshipsFor(parts: ZipParts, partPath: string): Relationships {
  const directory = partDirectory(partPath);
  const root = parseXml(parts.get(`${directory}_rels/${partPath.slice(directory.length)}.rels`));
  const map: Relationships = new Map();
  for (const rel of kids(root, "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target) continue;
    const external = attr(rel, "TargetMode") === "External";
    map.set(id, { type: (attr(rel, "Type") ?? "").split("/").pop() ?? "", target: external ? target : resolvePartPath(partPath, target), external });
  }
  return map;
}

function relsOfType(rels: Relationships, type: string): Relationship[] {
  return Array.from(rels.values()).filter((rel) => rel.type === type);
}

function workbookPath(parts: ZipParts): string {
  const office = relsOfType(relationshipsFor(parts, ""), "officeDocument")[0];
  return office && parts.has(office.target) ? office.target : "xl/workbook.xml";
}

/* ------------------------------------------------------------------ warnings and ids */

class WarningLog {
  private readonly items = new Set<string>();
  add(message: string): void {
    this.items.add(message);
  }
  list(): string[] {
    return Array.from(this.items);
  }
}

class IdSource {
  private readonly counts = new Map<string, number>();
  next(prefix: string): string {
    const count = (this.counts.get(prefix) ?? 0) + 1;
    this.counts.set(prefix, count);
    return `${prefix}-${count}`;
  }
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function capped<T>(items: T[], max: number, log: WarningLog, message: string): T[] {
  if (items.length > max) log.add(message);
  return items.slice(0, max);
}

/* ------------------------------------------------------------------ colors */

/** Theme color indexes as cell colors use them: Excel swaps the first two
 * pairs of the scheme (index 0 is lt1, 1 is dk1, 2 is lt2, 3 is dk2). */
const THEME_SLOTS = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
const OFFICE_THEME = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47", "0563C1", "954F72"];

/** Excel's legacy 64-color palette, then system foreground and background. */
const DEFAULT_INDEXED = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
  "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
  "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF",
  "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
  "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696",
  "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
  "000000", "FFFFFF",
];

type Palette = { theme: string[]; indexed: string[] };

function hex6(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/^[0-9a-f]{8}$/i.test(value)) return value.slice(2);
  return /^[0-9a-f]{6}$/i.test(value) ? value : undefined;
}

function readTheme(root: Element | null): string[] {
  const scheme = descendants(root, "clrScheme")[0];
  return THEME_SLOTS.map((slot, index) => {
    const entry = kid(scheme, slot);
    return hex6(attr(kid(entry, "srgbClr"), "val") ?? attr(kid(entry, "sysClr"), "lastClr")) ?? OFFICE_THEME[index];
  });
}

function readIndexedPalette(styles: Element | null): string[] {
  const custom = kids(kid(kid(styles, "colors"), "indexedColors"), "rgbColor").map((item) => hex6(attr(item, "rgb")));
  return DEFAULT_INDEXED.map((value, index) => custom[index] ?? value);
}

/** Hue in sextants (0..6), saturation and lightness 0..1. */
function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const delta = max - min;
  if (!delta) return [0, 0, light];
  const hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue, delta / (1 - Math.abs(2 * light - 1)), light];
}

function hslToHex(hue: number, saturation: number, light: number): string {
  const chroma = (1 - Math.abs(2 * light - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const sextants: [number, number, number][] = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]];
  const offset = light - chroma / 2;
  return sextants[Math.min(5, Math.floor(hue))].map((value) => Math.round((value + offset) * 255).toString(16).padStart(2, "0")).join("");
}

/** Excel's tint: darken toward black (negative) or lighten toward white. */
function applyTint(hex: string, tint: number): string {
  const [hue, saturation, light] = hexToHsl(hex);
  const tinted = tint < 0 ? light * (1 + tint) : light * (1 - tint) + tint;
  return hslToHex(hue, saturation, Math.min(1, Math.max(0, tinted)));
}

function baseColor(element: Element, palette: Palette): string | undefined {
  const rgb = hex6(attr(element, "rgb"));
  if (rgb) return rgb;
  const theme = num(element, "theme");
  if (theme !== undefined) return palette.theme[theme];
  const indexed = num(element, "indexed");
  return indexed === undefined ? undefined : palette.indexed[indexed];
}

/** A CT_Color element as "#rrggbb"; automatic colors resolve to undefined. */
function resolveColor(element: Element | null, palette: Palette): string | undefined {
  if (!element || flag(element, "auto")) return undefined;
  const base = baseColor(element, palette);
  if (!base) return undefined;
  const tint = num(element, "tint") ?? 0;
  return `#${(tint ? applyTint(base, tint) : base).toLowerCase()}`;
}

/* ------------------------------------------------------------------ styles */

type FontInfo = { bold: boolean; italic: boolean; underline: boolean; strike: boolean; size?: number; color?: string; name?: string };

export type StyleBook = {
  palette: Palette;
  cell(index: number | undefined): CellStyle | undefined;
  dxf(index: number | undefined): ConditionalStyle | undefined;
};

const BORDER_STYLES = new Map<string, BorderStyle>([
  ["thin", "thin"], ["hair", "thin"], ["medium", "medium"], ["thick", "thick"], ["dotted", "dotted"], ["double", "double"],
  ["dashed", "dashed"], ["mediumDashed", "dashed"], ["dashDot", "dashed"], ["mediumDashDot", "dashed"],
  ["dashDotDot", "dashed"], ["mediumDashDotDot", "dashed"], ["slantDashDot", "dashed"],
]);
const HORIZONTAL = new Map<string, HorizontalAlign>([
  ["left", "left"], ["center", "center"], ["centerContinuous", "center"], ["distributed", "center"], ["right", "right"], ["justify", "left"], ["fill", "left"],
]);
/** Bottom is Excel's default and is left unset. */
const VERTICAL = new Map<string, VerticalAlign>([["top", "top"], ["center", "middle"], ["justify", "middle"], ["distributed", "middle"]]);

function readFont(element: Element, palette: Palette): FontInfo {
  return {
    bold: onOff(kid(element, "b")),
    italic: onOff(kid(element, "i")),
    underline: onOff(kid(element, "u")),
    strike: onOff(kid(element, "strike")),
    size: num(kid(element, "sz"), "val"),
    color: resolveColor(kid(element, "color"), palette),
    name: attr(kid(element, "name"), "val") ?? undefined,
  };
}

/** Font properties that differ from the workbook default font. */
function fontStyle(font: FontInfo | undefined, base: FontInfo | undefined): CellStyle {
  if (!font) return {};
  const differs = <K extends "size" | "color" | "name">(key: K) => (font[key] !== undefined && font[key] !== base?.[key] ? font[key] : undefined);
  return {
    bold: font.bold || undefined,
    italic: font.italic || undefined,
    underline: font.underline || undefined,
    strike: font.strike || undefined,
    size: differs("size"),
    color: differs("color"),
    font: differs("name"),
  };
}

function solidFill(element: Element, palette: Palette): string | undefined {
  const pattern = kid(element, "patternFill");
  return attr(pattern, "patternType") === "solid" ? resolveColor(kid(pattern, "fgColor"), palette) : undefined;
}

function borderSide(border: Element, names: string[], palette: Palette) {
  const edge = names.map((name) => kid(border, name)).find(Boolean) ?? null;
  const style = BORDER_STYLES.get(attr(edge, "style") ?? "");
  return style ? compact({ style, color: resolveColor(kid(edge, "color"), palette) }) : undefined;
}

function readBorder(element: Element, palette: Palette): CellBorders | undefined {
  return compact({
    top: borderSide(element, ["top"], palette),
    right: borderSide(element, ["right", "end"], palette),
    bottom: borderSide(element, ["bottom"], palette),
    left: borderSide(element, ["left", "start"], palette),
  });
}

function readAlignment(element: Element | null): CellStyle {
  return {
    align: HORIZONTAL.get(attr(element, "horizontal") ?? ""),
    valign: VERTICAL.get(attr(element, "vertical") ?? ""),
    wrap: flag(element, "wrapText") || undefined,
    indent: num(element, "indent") || undefined,
  };
}

/** Format code for a numFmtId; locale-only tags ("[$-409]") and General drop. */
function formatCode(id: number, custom: Map<number, string>): string | undefined {
  const code = (custom.get(id) ?? BUILTIN_NUMBER_FORMATS[id])?.replace(/\[\$-[0-9A-Fa-f]+\]/g, "");
  return code && code !== "General" ? code : undefined;
}

type StyleParts = { fonts: FontInfo[]; fills: (string | undefined)[]; borders: (CellBorders | undefined)[]; numFmts: Map<number, string> };

function xfStyle(xf: Element, parts: StyleParts): CellStyle | undefined {
  return compact({
    ...fontStyle(parts.fonts[num(xf, "fontId") ?? 0], parts.fonts[0]),
    fill: parts.fills[num(xf, "fillId") ?? 0],
    border: parts.borders[num(xf, "borderId") ?? 0],
    format: formatCode(num(xf, "numFmtId") ?? 0, parts.numFmts),
    ...readAlignment(kid(xf, "alignment")),
  });
}

/** Differential formats fill with bgColor; some writers use fgColor. */
function dxfStyle(dxf: Element, palette: Palette): ConditionalStyle | undefined {
  const pattern = kid(kid(dxf, "fill"), "patternFill");
  const font = kid(dxf, "font");
  return compact({
    fill: resolveColor(kid(pattern, "bgColor"), palette) ?? resolveColor(kid(pattern, "fgColor"), palette),
    color: resolveColor(kid(font, "color"), palette),
    bold: onOff(kid(font, "b")) || undefined,
  });
}

function readStyles(root: Element | null, theme: string[]): StyleBook {
  const palette: Palette = { theme, indexed: readIndexedPalette(root) };
  const numFmts = new Map(kids(kid(root, "numFmts"), "numFmt").map((item) => [num(item, "numFmtId") ?? -1, attr(item, "formatCode") ?? ""]));
  const parts: StyleParts = {
    fonts: kids(kid(root, "fonts"), "font").map((item) => readFont(item, palette)),
    fills: kids(kid(root, "fills"), "fill").map((item) => solidFill(item, palette)),
    borders: kids(kid(root, "borders"), "border").map((item) => readBorder(item, palette)),
    numFmts,
  };
  const xfs = kids(kid(root, "cellXfs"), "xf").map((item) => xfStyle(item, parts));
  const dxfs = kids(kid(root, "dxfs"), "dxf").map((item) => dxfStyle(item, palette));
  return {
    palette,
    cell: (index) => (index === undefined ? undefined : xfs[index]),
    dxf: (index) => (index === undefined ? undefined : dxfs[index]),
  };
}

/* ------------------------------------------------------------------ workbook */

type SheetEntry = { name: string; hidden: boolean; path: string };

type BookContext = {
  parts: ZipParts;
  styles: StyleBook;
  strings: string[];
  date1904: boolean;
  /** Defined names, lower-cased, to their normalized range text. */
  names: Map<string, string>;
  log: WarningLog;
  ids: IdSource;
  budget: { cells: number; exceeded: boolean };
};

type SheetContext = BookContext & { name: string; path: string; rels: Relationships };

/** "'Q1 Sales'!$A$2:$A$9" -> "'Q1 Sales'!A2:A9"; undefined unless a range. */
function rangeText(text: string): string | undefined {
  const { sheet, ref } = splitSheetQualifiedRef(text.trim());
  const range = parseRangeRef(ref.replace(/\$/g, ""));
  if (!range) return undefined;
  return sheet === null ? formatRangeRef(range) : `${quoteSheetName(sheet)}!${formatRangeRef(range)}`;
}

function readDefinedNames(root: Element, log: WarningLog): DefinedName[] {
  const names: DefinedName[] = [];
  let skipped = 0;
  for (const item of kids(kid(root, "definedNames"), "definedName")) {
    const name = attr(item, "name") ?? "";
    if (name.startsWith("_xlnm.") || flag(item, "hidden")) continue;
    const ref = rangeText(textOf(item));
    if (ref) names.push({ name, ref });
    else skipped += 1;
  }
  if (skipped) log.add(`Left out ${plural(skipped, "named formula or constant", "named formulas or constants")}; only names that point at a range were imported.`);
  return capped(names, MAX_DEFINED_NAMES, log, `Only the first ${MAX_DEFINED_NAMES} defined names were imported.`);
}

function listSheets(root: Element, rels: Relationships, log: WarningLog): SheetEntry[] {
  const entries: SheetEntry[] = [];
  for (const item of kids(kid(root, "sheets"), "sheet")) {
    const name = attr(item, "name") ?? "";
    const rel = rels.get(relationId(item));
    if (rel?.type === "worksheet") {
      entries.push({ name, hidden: /hidden/i.test(attr(item, "state") ?? ""), path: rel.target });
    } else {
      log.add(rel?.type === "chartsheet" ? `Left out chart sheet "${name}"; only charts placed on a worksheet are imported.` : `Left out "${name}", which is not a worksheet.`);
    }
  }
  return capped(entries, MAX_SHEETS, log, `Only the first ${MAX_SHEETS} sheets were imported.`);
}

function warnWorkbookExtras(parts: ZipParts, rels: Relationships, log: WarningLog): void {
  if (Array.from(parts.keys()).some((name) => /vbaProject\.bin$/i.test(name))) {
    log.add("This workbook's macros were left out; Aperture never runs macros.");
  }
  if (relsOfType(rels, "externalLink").length) {
    log.add("Links to other workbooks were left out; formulas that use them keep their last calculated values.");
  }
}

function openWorkbook(parts: ZipParts): { root: Element; path: string } {
  if (parts.has("xl/workbook.bin")) throw new Error(BINARY_XLSB);
  const path = workbookPath(parts);
  const root = parseXml(parts.get(path));
  if (!root || root.localName !== "workbook") throw new Error(NOT_XLSX);
  return { root, path };
}

function bookContext(parts: ZipParts, root: Element, rels: Relationships, log: WarningLog, names: DefinedName[]): BookContext {
  const partOf = (type: string) => parseXml(parts.get(relsOfType(rels, type)[0]?.target ?? ""));
  const styles = readStyles(partOf("styles"), readTheme(partOf("theme")));
  return {
    parts,
    styles,
    strings: kids(partOf("sharedStrings"), "si").map(richText),
    date1904: flag(kid(root, "workbookPr"), "date1904") === true,
    names: new Map(names.map((item) => [item.name.toLowerCase(), item.ref])),
    log,
    ids: new IdSource(),
    budget: { cells: MAX_WORKBOOK_CELLS, exceeded: false },
  };
}

/** Reads an .xlsx package into a validated Workbook plus import warnings. */
export async function importXlsxWorkbook(bytes: Uint8Array): Promise<XlsxImportResult> {
  const parts = await openPackage(bytes);
  const { root, path } = openWorkbook(parts);
  const rels = relationshipsFor(parts, path);
  const log = new WarningLog();
  warnWorkbookExtras(parts, rels, log);
  const names = readDefinedNames(root, log);
  const entries = listSheets(root, rels, log);
  const context = bookContext(parts, root, rels, log, names);
  const sheets = entries.map((entry, index) => readSheet(entry, index, context));
  if (context.budget.exceeded) log.add(`The workbook has more than ${MAX_WORKBOOK_CELLS.toLocaleString("en-US")} filled cells; the cells past that limit were left out.`);
  const parsed = parseWorkbook({ schema: SHEET_SCHEMA_VERSION, sheets, ...(names.length ? { names } : {}) });
  if (!parsed.ok) throw new Error(parsed.error);
  if (new TextEncoder().encode(serializeWorkbook(parsed.workbook)).length > MAX_SHEET_CONTENT_BYTES) throw new Error(TOO_LARGE);
  return { workbook: parsed.workbook, warnings: [...log.list(), ...parsed.warnings] };
}

/* ------------------------------------------------------------------ cell values */

type FormulaInfo = { kind: string; text: string; si: string | null; ref: string | null };
type RawCell = { row: number; col: number; style?: CellStyle; value?: CellLiteral; formula?: FormulaInfo };

const CELL_REF = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;

/** A cell's position from its r attribute, else the next one in sequence. */
function cellPoint(ref: string | null, row: number, nextCol: number): { row: number; col: number } {
  const match = CELL_REF.exec(ref ?? "");
  return match ? { row: Number(match[2]) - 1, col: columnIndex(match[1]) } : { row, col: nextCol };
}

/** ISO 8601 date text (t="d" cells) as an Excel serial number. */
function isoSerial(text: string | null): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/.exec(text ?? "");
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  return (Date.UTC(year, month - 1, day, hour, minute, 0) + second * 1000 - EXCEL_EPOCH_MS) / MS_PER_DAY;
}

type LiteralReader = (raw: string | null, cell: Element, context: BookContext) => CellLiteral | undefined;

const LITERAL_READERS = new Map<string, LiteralReader>([
  ["s", (raw, _, context) => (raw === null ? undefined : context.strings[Number(raw)])],
  ["inlineStr", (_, cell) => richText(kid(cell, "is"))],
  ["b", (raw) => (raw === null ? undefined : raw === "1" || raw === "true")],
  ["e", (raw) => raw ?? undefined],
  ["str", (raw) => (raw === null ? undefined : decodeEscapes(raw))],
  ["d", (raw) => isoSerial(raw)],
  ["n", (raw) => (raw === null || raw.trim() === "" || !Number.isFinite(Number(raw)) ? undefined : Number(raw))],
]);

function cellLiteral(cell: Element, raw: Element | undefined, context: BookContext): CellLiteral | undefined {
  const reader = LITERAL_READERS.get(attr(cell, "t") ?? "n") ?? LITERAL_READERS.get("n")!;
  return reader(raw ? textOf(raw) : null, cell, context);
}

function readCell(cell: Element, point: { row: number; col: number }, context: BookContext): RawCell {
  const parts = new Map(kids(cell).map((child) => [child.localName, child]));
  const formula = parts.get("f");
  return {
    ...point,
    style: context.styles.cell(num(cell, "s")),
    value: cellLiteral(cell, parts.get("v"), context),
    formula: formula ? { kind: attr(formula, "t") ?? "normal", text: textOf(formula), si: attr(formula, "si"), ref: attr(formula, "ref") } : undefined,
  };
}

/* ------------------------------------------------------------------ sheet data */

type SheetData = { raw: RawCell[]; rows: Record<string, SheetRow>; cutRows: boolean; cutCols: boolean };

function readRowProps(row: Element, context: BookContext, defaultHeight: number): SheetRow | undefined {
  const height = num(row, "ht");
  const sized = height !== undefined && (flag(row, "customHeight") || height !== defaultHeight);
  return compact({
    h: sized ? pointsToPx(height) : undefined,
    hidden: flag(row, "hidden") || undefined,
    s: flag(row, "customFormat") ? context.styles.cell(num(row, "s")) : undefined,
  });
}

function readRowCells(row: Element, rowIndex: number, context: BookContext, data: SheetData): void {
  let col = -1;
  for (const cell of kids(row, "c")) {
    const point = cellPoint(attr(cell, "r"), rowIndex, col + 1);
    col = point.col;
    if (col >= MAX_SHEET_COLS) data.cutCols = true;
    else data.raw.push(readCell(cell, point, context));
  }
}

function readSheetData(sheetData: Element | null, context: BookContext, defaultHeight: number): SheetData {
  const data: SheetData = { raw: [], rows: {}, cutRows: false, cutCols: false };
  let rowIndex = -1;
  for (const row of kids(sheetData, "row")) {
    rowIndex = (num(row, "r") ?? rowIndex + 2) - 1;
    if (rowIndex >= MAX_SHEET_ROWS) {
      data.cutRows = true;
      break;
    }
    const props = readRowProps(row, context, defaultHeight);
    if (props) data.rows[String(rowIndex + 1)] = props;
    readRowCells(row, rowIndex, context, data);
  }
  return data;
}

/* ------------------------------------------------------------------ formulas */

/** Removes the file prefixes the .xlsx writer adds back (excelNames.ts) and
 * spells this-row table references the way the editor shows them. String
 * literals are left untouched. */
export function cleanFormula(text: string): string {
  return text
    .split(/("(?:[^"]|"")*")/)
    .map((part, index) => (index % 2 ? part : cleanFormulaCode(part)))
    .join("")
    .trim();
}

function cleanFormulaCode(code: string): string {
  return code
    .replace(/_xlfn\.(?:_xlws\.)?([A-Za-z][A-Za-z0-9.]*)(?=\s*\()/g, (match, name: string) => (needsFilePrefix(name) ? name : match))
    .replace(/\[\[#This Row\],\s*\[([^\]]+)\]\]/gi, (_, column: string) => `[@${/^[A-Za-z0-9_]+$/.test(column) ? column : `[${column}]`}]`);
}

function formulaSource(cell: RawCell, masters: Map<string, RawCell>): string | undefined {
  const info = cell.formula;
  if (!info || info.kind === "dataTable") return undefined;
  if (info.kind !== "shared" || info.text.trim()) return info.text.trim() || undefined;
  const master = masters.get(info.si ?? "");
  return master?.formula ? shiftFormula(master.formula.text, cell.row - master.row, cell.col - master.col) : undefined;
}

function sharedMasters(raw: RawCell[]): Map<string, RawCell> {
  const masters = new Map<string, RawCell>();
  for (const cell of raw) {
    if (cell.formula?.kind === "shared" && cell.formula.text.trim() && cell.formula.si !== null) masters.set(cell.formula.si, cell);
  }
  return masters;
}

/** Cells an array formula spills into (everything in its ref but the anchor). */
function spillAreas(raw: RawCell[]): CellRange[] {
  return raw.flatMap((cell) => {
    const range = cell.formula?.kind === "array" ? parseRangeRef(cell.formula.ref ?? "") : null;
    return range ? [range] : [];
  });
}

function inSpill(cell: RawCell, areas: CellRange[]): boolean {
  return areas.some((area) => rangeContains(area, cell.row, cell.col) && !(area.r1 === cell.row && area.c1 === cell.col));
}

type CellContent = { v?: CellLiteral; f?: string };

function cellContent(cell: RawCell, masters: Map<string, RawCell>, unreadable: string[]): CellContent {
  const source = formulaSource(cell, masters);
  if (source === undefined) return { v: cell.value };
  const formula = cleanFormula(source);
  if (formula.length <= MAX_FORMULA_CHARS && parseFormula(formula).ok) return { f: formula };
  unreadable.push(cellKey(cell.row, cell.col));
  return { v: cell.value };
}

function shiftDate(value: CellLiteral | undefined, style: CellStyle | undefined, date1904: boolean): CellLiteral | undefined {
  return date1904 && typeof value === "number" && isDateFormat(style?.format) ? value + DATE_1904_OFFSET : value;
}

const INHERITED_FLAGS = ["bold", "italic", "underline", "strike", "wrap"] as const;

/** A stored cell owns its whole format in Excel, so column or row formatting
 * it does not use is switched off explicitly. */
function withoutInherited(style: CellStyle | undefined, inherited: (CellStyle | undefined)[]): CellStyle | undefined {
  const off = INHERITED_FLAGS.filter((key) => !style?.[key] && inherited.some((item) => item?.[key]));
  return off.length ? { ...style, ...Object.fromEntries(off.map((key) => [key, false])) } : style;
}

type Inherited = { cols: Record<string, SheetColumn>; rows: Record<string, SheetRow> };

function takeCell(context: BookContext): boolean {
  if (context.budget.cells <= 0) {
    context.budget.exceeded = true;
    return false;
  }
  context.budget.cells -= 1;
  return true;
}

function buildCells(raw: RawCell[], context: SheetContext, inherited: Inherited): Record<string, SheetCell> {
  const masters = sharedMasters(raw);
  const spills = spillAreas(raw);
  const unreadable: string[] = [];
  const cells: Record<string, SheetCell> = {};
  for (const cell of raw) {
    const content = inSpill(cell, spills) ? {} : cellContent(cell, masters, unreadable);
    const style = withoutInherited(cell.style, [inherited.cols[columnLabel(cell.col)]?.s, inherited.rows[String(cell.row + 1)]?.s]);
    const entry = compact<SheetCell>({ f: content.f, v: shiftDate(content.v, style, context.date1904), s: style });
    if (entry && takeCell(context)) cells[cellKey(cell.row, cell.col)] = entry;
  }
  warnFormulas(raw, unreadable, context);
  return cells;
}

function warnFormulas(raw: RawCell[], unreadable: string[], context: SheetContext): void {
  if (unreadable.length) {
    context.log.add(`Kept the last calculated values of ${plural(unreadable.length, "formula")} on "${context.name}" that Aperture can't read (first at ${quoteSheetName(context.name)}!${unreadable[0]}).`);
  }
  if (raw.some((cell) => cell.formula?.kind === "dataTable")) {
    context.log.add(`What-if data tables on "${context.name}" were imported as their current values.`);
  }
}

/* ------------------------------------------------------------------ layout */

function readCols(root: Element, context: BookContext): Record<string, SheetColumn> {
  const cols: Record<string, SheetColumn> = {};
  for (const item of kids(kid(root, "cols"), "col")) {
    const first = (num(item, "min") ?? 1) - 1;
    const last = Math.min(num(item, "max") ?? first + 1, MAX_SHEET_COLS) - 1;
    const width = num(item, "width");
    const entry = compact<SheetColumn>({
      w: width === undefined ? undefined : excelWidthToPx(width),
      hidden: flag(item, "hidden") || undefined,
      s: context.styles.cell(num(item, "style")),
    });
    for (let col = first; entry && col <= last; col += 1) cols[columnLabel(col)] = entry;
  }
  return cols;
}

function readMerges(root: Element, context: SheetContext): string[] {
  const merges = kids(kid(root, "mergeCells"), "mergeCell")
    .map((item) => parseRangeRef(attr(item, "ref") ?? ""))
    .filter((range): range is CellRange => Boolean(range) && (range!.r1 !== range!.r2 || range!.c1 !== range!.c2))
    .map(formatRangeRef);
  return capped(merges, MAX_MERGES_PER_SHEET, context.log, `Only the first ${MAX_MERGES_PER_SHEET} merged ranges on "${context.name}" were imported.`);
}

function readView(root: Element): Pick<Sheet, "freeze" | "gridlines"> {
  const view = kid(kid(root, "sheetViews"), "sheetView");
  const pane = kid(view, "pane");
  const frozen = /^frozen/.test(attr(pane, "state") ?? "");
  return {
    gridlines: flag(view, "showGridLines") === false ? false : undefined,
    freeze: frozen ? { rows: num(pane, "ySplit") ?? 0, cols: num(pane, "xSplit") ?? 0 } : undefined,
  };
}

type Geometry = { colPx(col: number): number; rowPx(row: number): number };

function lengthPx(entry: (SheetColumn & SheetRow) | undefined, fallback: number): number {
  if (!entry) return fallback;
  return entry.hidden ? 0 : entry.w ?? entry.h ?? fallback;
}

function sheetGeometry(root: Element, cols: Record<string, SheetColumn>, rows: Record<string, SheetRow>): Geometry {
  const format = kid(root, "sheetFormatPr");
  const colDefault = excelWidthToPx(num(format, "defaultColWidth") ?? 8.43);
  const rowDefault = pointsToPx(num(format, "defaultRowHeight") ?? 15);
  return { colPx: (col) => lengthPx(cols[columnLabel(col)], colDefault), rowPx: (row) => lengthPx(rows[String(row + 1)], rowDefault) };
}

/* ------------------------------------------------------------------ filter */

const COMPARE_OPERATORS = new Map<string, CellOperator>([
  ["equal", "eq"], ["notEqual", "neq"], ["lessThan", "lt"], ["lessThanOrEqual", "lte"],
  ["greaterThan", "gt"], ["greaterThanOrEqual", "gte"], ["between", "between"], ["notBetween", "notBetween"],
]);

/** Excel writes text tests in custom filters as wildcard comparisons,
 * keyed here by operator and where the "*" sits around the text. */
const WILDCARD_TESTS = new Map<string, TextOperator>([
  ["equal *x*", "contains"], ["notEqual *x*", "notContains"], ["equal x*", "begins"], ["equal *x", "ends"],
]);

function wildcardCondition(operator: string, value: string): { op: TextOperator; value: string } | undefined {
  const leading = value.startsWith("*") ? "*" : "";
  const trailing = value.endsWith("*") ? "*" : "";
  const op = WILDCARD_TESTS.get(`${operator} ${leading}x${trailing}`);
  return op ? { op, value: value.slice(leading.length, value.length - trailing.length) } : undefined;
}

function customCondition(filter: Element): SheetFilterCriteria | undefined {
  const operator = attr(filter, "operator") ?? "equal";
  const value = attr(filter, "val") ?? "";
  const text = wildcardCondition(operator, value);
  if (text) return { condition: text };
  const op = COMPARE_OPERATORS.get(operator);
  return op ? { condition: { op, value } } : undefined;
}

/** Excel's between is an and-pair of inclusive bounds, its not-between an or-pair of exclusive ones. */
const RANGE_PAIRS = new Map<string, "between" | "notBetween">([
  ["and greaterThanOrEqual lessThanOrEqual", "between"], ["or lessThan greaterThan", "notBetween"],
]);

function rangeCondition(both: boolean, [low, high]: Element[]): SheetFilterCriteria | undefined {
  // A missing operator means "equal", which no pair uses, so it matches nothing either way.
  const op = RANGE_PAIRS.get([both ? "and" : "or", attr(low, "operator"), attr(high, "operator")].join(" "));
  return op ? { condition: { op, value: attr(low, "val") || "", value2: attr(high, "val") || "" } } : undefined;
}

function columnCriteria(column: Element): SheetFilterCriteria | undefined {
  const filters = kid(column, "filters");
  if (filters) {
    const values = kids(filters, "filter").map((item) => attr(item, "val") || "");
    if (flag(filters, "blank")) values.push("");
    return values.length ? { values } : undefined;
  }
  const customFilters = kid(column, "customFilters");
  const custom = kids(customFilters, "customFilter");
  if (custom.length === 2) return rangeCondition(flag(customFilters, "and") === true, custom);
  return custom.length === 1 ? customCondition(custom[0]) : undefined;
}

function filterSort(sortState: Element | null): SheetFilter["sort"] {
  const condition = kid(sortState, "sortCondition");
  const range = parseRangeRef(attr(condition, "ref") ?? "");
  return range ? { col: columnLabel(range.c1), desc: flag(condition, "descending") === true } : undefined;
}

function readFilter(root: Element, context: SheetContext): SheetFilter | undefined {
  const filter = kid(root, "autoFilter");
  const range = parseRangeRef(attr(filter, "ref") ?? "");
  if (!filter || !range) return undefined;
  const criteria: Record<string, SheetFilterCriteria> = {};
  let skipped = 0;
  for (const column of kids(filter, "filterColumn")) {
    const entry = columnCriteria(column);
    if (entry) criteria[columnLabel(range.c1 + (num(column, "colId") ?? 0))] = entry;
    else skipped += 1;
  }
  if (skipped) context.log.add(`Some filter conditions on "${context.name}" were left out; only value lists and simple comparisons are imported.`);
  return compact<SheetFilter>({ ref: formatRangeRef(range), criteria, sort: filterSort(kid(filter, "sortState") ?? kid(root, "sortState")) });
}

/* ------------------------------------------------------------------ rule operands */

/** A rule operand (Excel formula text) in the editor's form: numbers and
 * TRUE/FALSE stay, a string literal becomes its text, and anything else is a
 * formula written with a leading "=" (the inverse of xlsx/operands.ts). */
function operandValue(formula: string | undefined): string | undefined {
  if (formula === undefined) return undefined;
  const text = formula.trim();
  if (!text) return undefined;
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text) || /^(TRUE|FALSE)$/i.test(text)) return text;
  const literal = /^"((?:[^"]|"")*)"$/.exec(text);
  return literal ? literal[1].replace(/""/g, '"') : `=${cleanFormula(text)}`;
}

function sqrefRanges(sqref: string): string[] {
  return sqref
    .split(/\s+/)
    .map((part) => parseRangeRef(part))
    .filter((range): range is CellRange => Boolean(range))
    .map(formatRangeRef);
}

/* ------------------------------------------------------------------ conditional formatting */

type RuleBody = ConditionalRule extends infer R ? (R extends unknown ? Omit<R, "id" | "ref"> : never) : never;
type RuleReader = (rule: Element, context: SheetContext) => RuleBody | undefined;

const TEXT_RULES = new Map<string, TextOperator>([["containsText", "contains"], ["notContainsText", "notContains"], ["beginsWith", "begins"], ["endsWith", "ends"]]);

function ruleStyle(rule: Element, context: SheetContext): ConditionalStyle {
  return context.styles.dxf(num(rule, "dxfId")) ?? {};
}

function ruleFormulas(rule: Element): string[] {
  return kids(rule, "formula").map((item) => textOf(item));
}

function scaleRule(rule: Element, context: SheetContext): RuleBody | undefined {
  const colors = kids(kid(rule, "colorScale"), "color").map((item) => resolveColor(item, context.styles.palette));
  if (colors.some((color) => !color)) return undefined;
  if (colors.length === 2) return { type: "scale", min: colors[0]!, max: colors[1]! };
  return colors.length === 3 ? { type: "scale", min: colors[0]!, mid: colors[1]!, max: colors[2]! } : undefined;
}

function cellIsRule(rule: Element, context: SheetContext): RuleBody | undefined {
  const op = COMPARE_OPERATORS.get(attr(rule, "operator") ?? "");
  const [first, second] = ruleFormulas(rule).map(operandValue);
  if (!op || !first) return undefined;
  const value2 = op === "between" || op === "notBetween" ? second : undefined;
  return compact({ type: "cell" as const, op, value: first, value2, style: ruleStyle(rule, context) }) as RuleBody;
}

function textRule(rule: Element, context: SheetContext): RuleBody | undefined {
  const op = TEXT_RULES.get(attr(rule, "type") ?? "");
  const text = attr(rule, "text");
  return op && text ? { type: "text", op, text, style: ruleStyle(rule, context) } : undefined;
}

function formulaRule(rule: Element, context: SheetContext): RuleBody | undefined {
  const formula = ruleFormulas(rule)[0];
  return formula ? { type: "formula", formula: cleanFormula(formula), style: ruleStyle(rule, context) } : undefined;
}

const styled = (type: "duplicate" | "unique" | "blank" | "notBlank"): RuleReader => (rule, context) => ({ type, style: ruleStyle(rule, context) });

const RULE_READERS = new Map<string, RuleReader>([
  ["colorScale", scaleRule],
  ["dataBar", (rule, context) => ({ type: "bar", color: resolveColor(kid(kid(rule, "dataBar"), "color"), context.styles.palette) ?? "#638ec6" })],
  ["cellIs", cellIsRule],
  ["containsText", textRule],
  ["notContainsText", textRule],
  ["beginsWith", textRule],
  ["endsWith", textRule],
  ["top10", (rule, context) => compact({ type: flag(rule, "bottom") ? "bottom" : "top", count: num(rule, "rank") ?? 10, percent: flag(rule, "percent") || undefined, style: ruleStyle(rule, context) }) as RuleBody],
  ["duplicateValues", styled("duplicate")],
  ["uniqueValues", styled("unique")],
  ["aboveAverage", (rule, context) => ({ type: flag(rule, "aboveAverage") === false ? "below" : "above", style: ruleStyle(rule, context) })],
  ["containsBlanks", styled("blank")],
  ["notContainsBlanks", styled("notBlank")],
  ["expression", formulaRule],
]);

/** Rule types without a reader (time periods, errors) still carry the
 * equivalent formula, which the editor can evaluate. Icon sets cannot. */
function ruleBody(rule: Element, context: SheetContext): RuleBody | undefined {
  const reader = RULE_READERS.get(attr(rule, "type") ?? "");
  if (reader) return reader(rule, context);
  return attr(rule, "type") === "iconSet" ? undefined : formulaRule(rule, context);
}

function readConditional(root: Element, context: SheetContext): ConditionalRule[] {
  const entries = kids(root, "conditionalFormatting").flatMap((block) => kids(block, "cfRule").map((rule) => ({ rule, ranges: sqrefRanges(attr(block, "sqref") ?? "") })));
  entries.sort((a, b) => (num(a.rule, "priority") ?? 0) - (num(b.rule, "priority") ?? 0));
  const rules: ConditionalRule[] = [];
  let skipped = 0;
  for (const { rule, ranges } of entries) {
    const body = ruleBody(rule, context);
    if (!body) skipped += 1;
    else for (const ref of ranges) rules.push({ id: context.ids.next("cf"), ref, ...body } as ConditionalRule);
  }
  if (skipped) context.log.add(`Left out ${plural(skipped, "conditional format")} on "${context.name}" that Aperture can't show (such as icon sets).`);
  return capped(rules, MAX_RULES_PER_SHEET, context.log, `Only the first ${MAX_RULES_PER_SHEET} conditional formats on "${context.name}" were imported.`);
}

/* ------------------------------------------------------------------ data validation */

type ValidationBody = Omit<SheetValidation, "id" | "ref">;

const NUMERIC_VALIDATIONS = new Set<ValidationKind>(["whole", "decimal", "date", "textLength"]);

/** Formula text from <formula1> or, in Excel 2010 extensions, <x14:formula1><xm:f>. */
function validationFormula(element: Element, name: string): string | undefined {
  const holder = kid(element, name);
  return holder ? textOf(kid(holder, "f") ?? holder).trim() : undefined;
}

function listValidation(element: Element, context: SheetContext, base: Pick<ValidationBody, "strict" | "message">): ValidationBody | undefined {
  const formula = validationFormula(element, "formula1") ?? "";
  const literal = /^"([\s\S]*)"$/.exec(formula);
  if (literal) return { kind: "list", items: literal[1].split(","), ...base };
  const source = rangeText(context.names.get(formula.toLowerCase()) ?? formula);
  return source ? { kind: "list", source, ...base } : undefined;
}

function numericValidation(element: Element, kind: ValidationKind, base: Pick<ValidationBody, "strict" | "message">): ValidationBody | undefined {
  const op = COMPARE_OPERATORS.get(attr(element, "operator") ?? "between") ?? "between";
  const value = operandValue(validationFormula(element, "formula1"));
  const value2 = op === "between" || op === "notBetween" ? operandValue(validationFormula(element, "formula2")) : undefined;
  return value ? (compact({ kind, op, value, value2, ...base }) as ValidationBody) : undefined;
}

/** Strict when Excel shows a "Stop" alert; warnings and notes only flag. */
function validationAlert(element: Element): Pick<ValidationBody, "strict" | "message"> {
  const strict = flag(element, "showErrorMessage") === true && (attr(element, "errorStyle") ?? "stop") === "stop";
  return { strict, message: (attr(element, "error") ?? attr(element, "prompt"))?.trim() || undefined };
}

/** null for rules that check nothing; undefined for rules Aperture can't check. */
function validationBody(element: Element, context: SheetContext): ValidationBody | null | undefined {
  const kind = attr(element, "type") ?? "none";
  if (kind === "none" || kind === "any") return null;
  if (kind === "list") return listValidation(element, context, validationAlert(element));
  return NUMERIC_VALIDATIONS.has(kind as ValidationKind) ? numericValidation(element, kind as ValidationKind, validationAlert(element)) : undefined;
}

function validationElements(root: Element): Element[] {
  const extensions = kids(kid(root, "extLst"), "ext").flatMap((ext) => kids(kid(ext, "dataValidations"), "dataValidation"));
  return [...kids(kid(root, "dataValidations"), "dataValidation"), ...extensions];
}

function readValidations(root: Element, context: SheetContext): SheetValidation[] {
  const validations: SheetValidation[] = [];
  let skipped = 0;
  for (const element of validationElements(root)) {
    const body = validationBody(element, context);
    if (body === undefined) skipped += 1;
    if (!body) continue;
    for (const ref of sqrefRanges(attr(element, "sqref") ?? textOf(kid(element, "sqref")))) validations.push({ id: context.ids.next("dv"), ref, ...body });
  }
  if (skipped) context.log.add(`Left out ${plural(skipped, "data validation rule")} on "${context.name}" that Aperture can't check (custom formulas, times, or computed lists).`);
  return capped(validations, MAX_RULES_PER_SHEET, context.log, `Only the first ${MAX_RULES_PER_SHEET} data validation rules on "${context.name}" were imported.`);
}

/* ------------------------------------------------------------------ tables */

/** Built-in styles come in groups of seven: a neutral one, then accents 1-6. */
function tableLook(styleName: string | null): { accent: AccentSlot; tone: TableTone } {
  const match = /^TableStyle(Light|Medium|Dark)(\d+)$/.exec(styleName ?? "");
  if (!match) return { accent: 1, tone: "medium" };
  const offset = (Number(match[2]) - 1) % 7;
  return { accent: (offset || 1) as AccentSlot, tone: match[1].toLowerCase() as TableTone };
}

function tableFrom(root: Element, context: SheetContext): SheetTable | undefined {
  const range = parseRangeRef(attr(root, "ref") ?? "");
  const name = attr(root, "displayName") ?? attr(root, "name") ?? "";
  if (!range) return undefined;
  if (attr(root, "headerRowCount") === "0") {
    context.log.add(`Table "${name}" on "${context.name}" has no header row, so its cells were imported without the table.`);
    return undefined;
  }
  const info = kid(root, "tableStyleInfo");
  return {
    id: context.ids.next("table"),
    name,
    ref: formatRangeRef(range),
    ...tableLook(attr(info, "name")),
    banded: flag(info, "showRowStripes") ?? true,
    totals: (num(root, "totalsRowCount") ?? 0) > 0,
    filterButtons: kid(root, "autoFilter") !== null,
    ...(flag(info, "showFirstColumn") ? { firstColumn: true } : {}),
  };
}

function readTables(context: SheetContext): SheetTable[] {
  const tables = relsOfType(context.rels, "table")
    .map((rel) => parseXml(context.parts.get(rel.target)))
    .flatMap((root) => (root ? [tableFrom(root, context)] : []))
    .filter((table): table is SheetTable => Boolean(table));
  return capped(tables, MAX_OBJECTS_PER_SHEET, context.log, `Only the first ${MAX_OBJECTS_PER_SHEET} tables on "${context.name}" were imported.`);
}

/* ------------------------------------------------------------------ notes */

/** Comment text without the "Author:" line Excel prepends; threaded comments
 * written for older Excel keep only the conversation. */
function noteText(text: string, author: string | undefined): string {
  const threaded = /^\[Threaded comment\][\s\S]*?\nComment:[ \t]*\r?\n/.exec(text);
  if (threaded) return text.slice(threaded[0].length).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("\n");
  const prefix = author ? `${author}:` : "";
  return (prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text).trim();
}

function readNotes(context: SheetContext): Map<string, string> {
  const notes = new Map<string, string>();
  for (const rel of relsOfType(context.rels, "comments")) {
    const root = parseXml(context.parts.get(rel.target));
    const authors = kids(kid(root, "authors"), "author").map((item) => textOf(item));
    for (const comment of kids(kid(root, "commentList"), "comment")) {
      const point = parseCellKey(attr(comment, "ref") ?? "");
      const text = noteText(richText(kid(comment, "text")), authors[num(comment, "authorId") ?? -1]);
      if (point && text) notes.set(cellKey(point.row, point.col), text);
    }
  }
  return notes;
}

function addNotes(cells: Record<string, SheetCell>, notes: Map<string, string>, context: SheetContext): void {
  for (const [key, note] of notes) {
    if (cells[key]) cells[key] = { ...cells[key], n: note };
    else if (takeCell(context)) cells[key] = { n: note };
  }
}

/* ------------------------------------------------------------------ charts */

const CHART_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const CHART_KINDS = new Map<string, (plot: Element) => SheetChartType>([
  ["barChart", (plot) => (attr(kid(plot, "barDir"), "val") === "bar" ? "bar" : "column")],
  ["bar3DChart", (plot) => (attr(kid(plot, "barDir"), "val") === "bar" ? "bar" : "column")],
  ["lineChart", () => "line"],
  ["line3DChart", () => "line"],
  ["areaChart", () => "area"],
  ["area3DChart", () => "area"],
  ["pieChart", () => "pie"],
  ["pie3DChart", () => "pie"],
  ["ofPieChart", () => "pie"],
  ["doughnutChart", () => "doughnut"],
  ["scatterChart", () => "scatter"],
]);
const OTHER_PLOTS = new Set(["radarChart", "stockChart", "surfaceChart", "surface3DChart", "bubbleChart"]);
const LEGEND_POSITIONS = new Map<string, SheetChartLegend>([["r", "right"], ["tr", "right"], ["l", "right"], ["b", "bottom"], ["t", "top"]]);
const SERIES_PARTS = ["tx", "cat", "val", "xVal", "yVal"];

type ChartBox = { at: string; w: number; h: number };
type ChartProblem = "type" | "offSheet" | "noData" | "outside";

/** A chart data reference as a range on `sheetName`, or null when it is on
 * another sheet, spans several areas, or is not a range. */
function chartRange(text: string, sheetName: string): CellRange | null {
  if (text.includes(",")) return null;
  const { sheet, ref } = splitSheetQualifiedRef(text.replace(/^\(|\)$/g, ""));
  if (sheet !== null && sheet.toLowerCase() !== sheetName.toLowerCase()) return null;
  return parseRangeRef(ref.replace(/\$/g, ""));
}

function union(a: CellRange | null, b: CellRange): CellRange {
  return a ? { r1: Math.min(a.r1, b.r1), c1: Math.min(a.c1, b.c1), r2: Math.max(a.r2, b.r2), c2: Math.max(a.c2, b.c2) } : b;
}

function seriesFormulas(series: Element, parts: string[]): string[] {
  return parts.flatMap((part) => descendants(kid(series, part), "f").map((item) => textOf(item).trim()));
}

function chartSource(plot: Element, sheetName: string): { source: string; seriesBy: SheetChart["seriesBy"] } | ChartProblem {
  const series = kids(plot, "ser");
  const refs = series.flatMap((item) => seriesFormulas(item, SERIES_PARTS));
  if (!refs.length) return "noData";
  let box: CellRange | null = null;
  for (const text of refs) {
    const range = chartRange(text, sheetName);
    if (!range) return "offSheet";
    box = union(box, range);
  }
  const values = chartRange(seriesFormulas(series[0], ["val", "yVal"])[0] ?? "", sheetName);
  const byRows = values !== null && values.r1 === values.r2 && values.c2 > values.c1;
  return { source: formatRangeRef(box!), seriesBy: byRows ? "rows" : "columns" };
}

function titleText(title: Element | null): string | undefined {
  const tx = kid(title, "tx");
  const rich = kid(tx, "rich");
  const text = rich
    ? kids(rich, "p").map((paragraph) => descendants(paragraph, "t").map((item) => textOf(item)).join("")).join(" ")
    : descendants(kid(tx, "strRef"), "v").map((item) => textOf(item)).join(" ");
  return text.trim() || undefined;
}

function axisTitles(plotArea: Element | null): Pick<SheetChart, "xTitle" | "yTitle"> {
  const valueAxes = kids(plotArea, "valAx");
  const category = kid(plotArea, "catAx") ?? kid(plotArea, "dateAx") ?? valueAxes.find((axis) => /^[bt]$/.test(attr(kid(axis, "axPos"), "val") ?? "")) ?? null;
  const value = valueAxes.find((axis) => axis !== category) ?? null;
  return { xTitle: titleText(kid(category, "title")), yTitle: titleText(kid(value, "title")) };
}

function chartLegend(chart: Element | null): SheetChartLegend {
  const legend = kid(chart, "legend");
  return legend ? LEGEND_POSITIONS.get(attr(kid(legend, "legendPos"), "val") ?? "r") ?? "right" : "none";
}

function readChart(root: Element, box: ChartBox, context: SheetContext): SheetChart | ChartProblem {
  const chart = kid(root, "chart");
  const plotArea = kid(chart, "plotArea");
  const plots = kids(plotArea).filter((item) => CHART_KINDS.has(item.localName) || OTHER_PLOTS.has(item.localName));
  const plot = plots.find((item) => CHART_KINDS.has(item.localName));
  if (!plot) return "type";
  const data = chartSource(plot, context.name);
  if (typeof data === "string") return data;
  if (plots.length > 1) context.log.add(`Combination charts on "${context.name}" were imported as a single chart type.`);
  return compact<SheetChart>({
    id: context.ids.next("chart"),
    type: CHART_KINDS.get(plot.localName)!(plot),
    title: titleText(kid(chart, "title")),
    ...data,
    stacked: /stacked/i.test(attr(kid(plot, "grouping"), "val") ?? "") || undefined,
    legend: chartLegend(chart),
    showValues: descendants(plot, "showVal").some(onOff) || undefined,
    ...axisTitles(plotArea),
    ...box,
  })!;
}

/* ------------------------------------------------------------------ drawings */

type Marker = { col: number; row: number; colOff: number; rowOff: number };
type DrawingTally = { charts: SheetChart[]; images: number; shapes: number; problems: Map<ChartProblem, number> };

function marker(element: Element | null): Marker | undefined {
  if (!element) return undefined;
  const value = (name: string) => Number(textOf(kid(element, name))) || 0;
  return { col: value("col"), row: value("row"), colOff: value("colOff"), rowOff: value("rowOff") };
}

function span(from: number, to: number, size: (index: number) => number): number {
  let total = 0;
  for (let index = from; index < to; index += 1) total += size(index);
  return total;
}

/** Extent in px: the frame's own size, the anchor's ext, or the cells it spans. */
function anchorSize(anchor: Element, from: Marker, geometry: Geometry): { w: number; h: number } {
  const frame = kid(kid(descendants(anchor, "graphicFrame")[0], "xfrm"), "ext");
  const ext = frame && num(frame, "cx") ? frame : kid(anchor, "ext");
  if (ext && num(ext, "cx")) return { w: Math.round((num(ext, "cx") ?? 0) / EMU_PER_PX), h: Math.round((num(ext, "cy") ?? 0) / EMU_PER_PX) };
  const to = marker(kid(anchor, "to")) ?? from;
  return {
    w: Math.round(span(from.col, to.col, geometry.colPx) + (to.colOff - from.colOff) / EMU_PER_PX),
    h: Math.round(span(from.row, to.row, geometry.rowPx) + (to.rowOff - from.rowOff) / EMU_PER_PX),
  };
}

function anchorBox(anchor: Element, geometry: Geometry): ChartBox | undefined {
  const from = marker(kid(anchor, "from")) ?? { col: 0, row: 0, colOff: 0, rowOff: 0 };
  if (from.col >= MAX_SHEET_COLS || from.row >= MAX_SHEET_ROWS) return undefined;
  return { at: cellKey(from.row, from.col), ...anchorSize(anchor, from, geometry) };
}

/** The chart an anchor holds; chartex parts (waterfall, treemap, ...) count
 * as unsupported types. */
function anchorChart(anchor: Element, chartRef: Element, drawingRels: Relationships, geometry: Geometry, context: SheetContext): SheetChart | ChartProblem {
  const box = anchorBox(anchor, geometry);
  if (!box) return "outside";
  const rel = drawingRels.get(relationId(chartRef));
  const root = rel?.type === "chart" && chartRef.namespaceURI === CHART_NS ? parseXml(context.parts.get(rel.target)) : null;
  return root ? readChart(root, box, context) : "type";
}

function readAnchor(anchor: Element, drawingRels: Relationships, geometry: Geometry, context: SheetContext, tally: DrawingTally): void {
  const chartRef = descendants(anchor, "chart")[0];
  const pictures = descendants(anchor, "pic").length;
  if (chartRef) {
    const result = anchorChart(anchor, chartRef, drawingRels, geometry, context);
    if (typeof result === "string") tally.problems.set(result, (tally.problems.get(result) ?? 0) + 1);
    else tally.charts.push(result);
  } else if (pictures) tally.images += pictures;
  else tally.shapes += 1;
}

const ANCHORS = new Set(["twoCellAnchor", "oneCellAnchor", "absoluteAnchor"]);

const CHART_PROBLEMS: Record<ChartProblem, string> = {
  type: "a chart type Aperture can't draw yet",
  offSheet: "its data is on another sheet",
  noData: "no cell data",
  outside: "placed past the sheet's last row or column",
};

function warnDrawings(tally: DrawingTally, context: SheetContext): void {
  const sheet = `"${context.name}"`;
  if (tally.images) context.log.add(`Left out ${plural(tally.images, "picture")} on ${sheet}; Aperture sheets don't hold pictures yet.`);
  if (tally.shapes) context.log.add(`Left out ${plural(tally.shapes, "shape or drawing object", "shapes or drawing objects")} on ${sheet}.`);
  for (const [problem, count] of tally.problems) context.log.add(`Left out ${plural(count, "chart")} on ${sheet} (${CHART_PROBLEMS[problem]}).`);
}

function readDrawings(context: SheetContext, geometry: Geometry): SheetChart[] {
  const tally: DrawingTally = { charts: [], images: 0, shapes: 0, problems: new Map() };
  for (const rel of relsOfType(context.rels, "drawing")) {
    const root = parseXml(context.parts.get(rel.target));
    const drawingRels = relationshipsFor(context.parts, rel.target);
    for (const anchor of kids(root).filter((item) => ANCHORS.has(item.localName))) readAnchor(anchor, drawingRels, geometry, context, tally);
  }
  warnDrawings(tally, context);
  return capped(tally.charts, MAX_OBJECTS_PER_SHEET, context.log, `Only the first ${MAX_OBJECTS_PER_SHEET} charts on "${context.name}" were imported.`);
}

/* ------------------------------------------------------------------ sheets */

function warnSheetLimits(data: SheetData, context: SheetContext): void {
  if (data.cutRows) context.log.add(`Only the first ${MAX_SHEET_ROWS.toLocaleString("en-US")} rows of "${context.name}" were imported.`);
  if (data.cutCols) context.log.add(`Only columns A–${columnLabel(MAX_SHEET_COLS - 1)} of "${context.name}" were imported (the first ${MAX_SHEET_COLS} columns).`);
  if (relsOfType(context.rels, "pivotTable").length) context.log.add(`Pivot tables on "${context.name}" were imported as values.`);
}

function nonEmpty<T>(items: T[]): T[] | undefined {
  return items.length ? items : undefined;
}

function nonEmptyRecord<T>(record: Record<string, T>): Record<string, T> | undefined {
  return Object.keys(record).length ? record : undefined;
}

function readSheet(entry: SheetEntry, index: number, book: BookContext): Sheet {
  const context: SheetContext = { ...book, name: entry.name, path: entry.path, rels: relationshipsFor(book.parts, entry.path) };
  const base: Sheet = { id: `sheet-${index + 1}`, name: entry.name, ...(entry.hidden ? { hidden: true } : {}), cells: {} };
  const root = parseXml(book.parts.get(entry.path));
  if (!root) {
    book.log.add(`Sheet "${entry.name}" could not be read, so it was imported empty.`);
    return base;
  }
  const cols = readCols(root, context);
  const data = readSheetData(kid(root, "sheetData"), context, num(kid(root, "sheetFormatPr"), "defaultRowHeight") ?? 15);
  const cells = buildCells(data.raw, context, { cols, rows: data.rows });
  addNotes(cells, readNotes(context), context);
  warnSheetLimits(data, context);
  return compact<Sheet>({
    ...base,
    color: resolveColor(kid(kid(root, "sheetPr"), "tabColor"), book.styles.palette),
    cells,
    cols: nonEmptyRecord(cols),
    rows: nonEmptyRecord(data.rows),
    merges: nonEmpty(readMerges(root, context)),
    ...readView(root),
    filter: readFilter(root, context),
    tables: nonEmpty(readTables(context)),
    charts: nonEmpty(readDrawings(context, sheetGeometry(root, cols, data.rows))),
    conditional: nonEmpty(readConditional(root, context)),
    validations: nonEmpty(readValidations(root, context)),
  })!;
}
