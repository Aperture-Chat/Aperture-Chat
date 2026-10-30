/** XML text helpers shared by every part of the .xlsx writer.
 *
 * Cell text passes through `cellText` exactly once, where it enters the file:
 * characters XML 1.0 cannot hold are removed, text is cut to Excel's cell
 * limit, and a literal "_xHHHH_" is escaped so Excel does not decode it. Each
 * repair is counted in the export's WarningLog instead of failing silently.
 */

import { MAX_CELL_TEXT_CHARS } from "../sheetModel";

export const XML_HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

export const NS = {
  main: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  rel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  pkgRel: "http://schemas.openxmlformats.org/package/2006/relationships",
  drawingMain: "http://schemas.openxmlformats.org/drawingml/2006/main",
  chart: "http://schemas.openxmlformats.org/drawingml/2006/chart",
  sheetDrawing: "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
} as const;

// Anything outside XML 1.0's Char production, including lone surrogates.
const ILLEGAL_XML = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/** Escapes markup and drops characters XML 1.0 cannot hold, so no text can
 * make a part malformed (cell text is cleaned and counted earlier). */
export function escapeXml(value: string): string {
  return value
    .replace(ILLEGAL_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** "#087d8b" -> "FF087D8B" (opaque ARGB, as SpreadsheetML colors are written). */
export function argb(color: string): string {
  return `FF${color.replace(/^#/, "").toUpperCase()}`;
}

/** "#087d8b" -> "087D8B" (DrawingML srgbClr). */
export function rgb(color: string): string {
  return color.replace(/^#/, "").toUpperCase();
}

/** Serializes attributes, skipping undefined and false values. */
export function attrs(values: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([name, value]) => ` ${name}="${value === true ? "1" : escapeXml(String(value))}"`)
    .join("");
}

/** `<t>` with xml:space="preserve" when Excel would otherwise trim it. */
export function textElement(tag: string, value: string): string {
  const preserve = /^\s|\s$|\n/.test(value) ? ` xml:space="preserve"` : "";
  return `<${tag}${preserve}>${escapeXml(value)}</${tag}>`;
}

type CountedWarning = "illegalChars" | "truncated" | "badFormula";

const COUNTED_MESSAGES: Record<CountedWarning, (n: number) => string> = {
  illegalChars: (n) => `Removed characters Excel cannot store from ${n} ${n === 1 ? "cell" : "cells"}.`,
  truncated: (n) => `Shortened ${n} ${n === 1 ? "cell" : "cells"} to Excel's 32,767-character limit.`,
  badFormula: (n) => `Exported ${n} ${n === 1 ? "formula" : "formulas"} Excel cannot read as text.`,
};

/** Export warnings: plain messages once each, per-cell repairs as one count. */
export class WarningLog {
  private readonly messages = new Set<string>();
  private readonly counts: Record<CountedWarning, number> = { illegalChars: 0, truncated: 0, badFormula: 0 };

  add(message: string): void {
    this.messages.add(message);
  }

  count(kind: CountedWarning): void {
    this.counts[kind] += 1;
  }

  list(): string[] {
    const counted = (Object.keys(this.counts) as CountedWarning[])
      .filter((kind) => this.counts[kind] > 0)
      .map((kind) => COUNTED_MESSAGES[kind](this.counts[kind]));
    return [...counted, ...this.messages];
  }
}

/** Text that is safe to store in a cell. Repairs are counted when `log` is
 * given: for what the author typed, not for results derived from it. */
export function cellText(value: string, log?: WarningLog): string {
  let text = value.replace(/\r\n?/g, "\n");
  const cleaned = text.replace(ILLEGAL_XML, "");
  if (cleaned !== text) log?.count("illegalChars");
  text = cleaned;
  if (text.length > MAX_CELL_TEXT_CHARS) {
    text = text.slice(0, MAX_CELL_TEXT_CHARS);
    log?.count("truncated");
  }
  return text.replace(/_(x[0-9A-Fa-f]{4}_)/g, "_x005F_$1");
}

/** Text for names, titles, and messages: illegal characters dropped, no count. */
export function plainText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(ILLEGAL_XML, "");
}
