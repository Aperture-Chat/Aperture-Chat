/** Typed cell entry, read with US conventions. Numbers, currency, percents,
 * scientific notation, dates, and times become values with the format that
 * shows them the way they were typed; anything else stays text. */

import type { CellLiteral } from "../sheetModel";
import { parseDateText } from "../formula/values";

export type ParsedInput =
  | { kind: "empty" }
  | { kind: "formula"; formula: string }
  | { kind: "value"; value: CellLiteral; format?: string };

type Entry = { value: CellLiteral; format?: string };

export function parseCellInput(text: string): ParsedInput {
  if (!text.trim()) return { kind: "empty" };
  if (text.startsWith("=") && text.length > 1) return { kind: "formula", formula: text.slice(1) };
  if (text.startsWith("'")) return { kind: "value", value: text.slice(1) };
  const entry = parseBoolean(text) ?? parseNumber(text) ?? parseDateEntry(text) ?? { value: text };
  return { kind: "value", ...entry };
}

function parseBoolean(text: string): Entry | null {
  const upper = text.trim().toUpperCase();
  return upper === "TRUE" || upper === "FALSE" ? { value: upper === "TRUE" } : null;
}

/* ------------------------------------------------------------------ numbers */

/** Sign, then an optional currency symbol, then an optional sign, then digits
 * (grouped by commas or not), then a percent sign; the whole may sit in
 * parentheses to mean negative. */
const NUMBER_ENTRY = /^([+-]?)([$€£¥]?)([+-]?)\s*(\d{1,3}(?:,\d{3})+(?:\.\d*)?|\d+\.?\d*|\.\d+)\s*(%?)$/;
const SCIENTIFIC_ENTRY = /^[+-]?(?:\d+\.?\d*|\.\d+)e[+-]?\d+$/i;

type NumberShape = { negative: boolean; parens: boolean; currency: string; digits: string; percent: boolean };

function parseNumber(text: string): Entry | null {
  const trimmed = text.trim();
  if (SCIENTIFIC_ENTRY.test(trimmed)) return { value: Number(trimmed), format: "0.00E+00" };
  const shape = numberShape(trimmed);
  if (!shape) return null;
  // "33.3e-2" reads as exactly 0.333, where 33.3 / 100 does not.
  const magnitude = Number(`${shape.digits.replace(/,/g, "")}${shape.percent ? "e-2" : ""}`);
  // 0 - magnitude, not -magnitude, so "-0" is a plain zero.
  return { value: shape.negative ? 0 - magnitude : magnitude, ...numberEntryFormat(shape) };
}

function numberShape(trimmed: string): NumberShape | null {
  const parens = /^\(.*\)$/.test(trimmed);
  const match = NUMBER_ENTRY.exec(parens ? trimmed.slice(1, -1).trim() : trimmed);
  if (!match) return null;
  const [, before, currency, after, digits, percent] = match;
  const signs = before + after;
  if (!signsAllowed(signs, parens) || (currency && percent)) return null;
  return { negative: parens || signs === "-", parens, currency, digits, percent: percent === "%" };
}

/** One sign at most, and none inside parentheses: "(-5)" and "--5" stay text. */
function signsAllowed(signs: string, parens: boolean): boolean {
  return parens ? signs === "" : signs.length <= 1;
}

function numberEntryFormat(shape: NumberShape): { format?: string } {
  const [, fraction = ""] = shape.digits.split(".");
  const decimals = fraction.length;
  if (shape.percent) return { format: decimals ? `0.${"0".repeat(Math.min(decimals, 30))}%` : "0%" };
  if (shape.currency) return { format: currencyFormat(shape.currency, decimals > 0, shape.parens) };
  if (shape.digits.includes(",")) return { format: decimals ? "#,##0.00" : "#,##0" };
  return {};
}

/** "$#,##0.00", with Excel's parenthesised negative section when the entry
 * used parentheses. Symbols other than "$" are quoted. */
function currencyFormat(symbol: string, cents: boolean, parens: boolean): string {
  const base = `${symbol === "$" ? "$" : `"${symbol}"`}#,##0${cents ? ".00" : ""}`;
  return parens ? `${base}_);(${base})` : base;
}

/* ------------------------------------------------------------------ dates */

const TIME_SUFFIX = /(?:^|\s)\d{1,2}:\d{2}(:\d{2})?\s*([ap]m)?$/i;

const DATE_SHAPES: Array<{ pattern: RegExp; format: (match: RegExpExecArray) => string }> = [
  { pattern: /^\d{4}-\d{1,2}-\d{1,2}$/, format: () => "yyyy-mm-dd" },
  { pattern: /^\d{1,2}[/-]\d{1,2}[/-](?:\d{2}|\d{4})$/, format: () => "m/d/yyyy" },
  { pattern: /^\d{1,2}[\s-]([a-z]{3,9})[\s-,]+\d{4}$/i, format: (match) => `d-${monthCode(match[1])}-yyyy` },
  { pattern: /^([a-z]{3,9})\.?\s+\d{1,2},?\s+\d{4}$/i, format: (match) => `${monthCode(match[1])} d, yyyy` },
];

/** "Mar" keeps the short month; a spelled-out month keeps the full name. */
function monthCode(month: string): string {
  return month.length > 3 ? "mmmm" : "mmm";
}

function parseDateEntry(text: string): Entry | null {
  const value = parseDateText(text);
  if (value === null) return null;
  const trimmed = text.trim();
  const time = TIME_SUFFIX.exec(trimmed);
  const datePart = time ? trimmed.slice(0, time.index).trim() : trimmed;
  const timeFormat = time ? `h:mm${time[1] ? ":ss" : ""}${time[2] ? " AM/PM" : ""}` : "";
  return { value, format: [dateFormat(datePart), timeFormat].filter(Boolean).join(" ") };
}

/** The code for the date part; "" for a time typed alone. */
function dateFormat(datePart: string): string {
  if (!datePart) return "";
  for (const shape of DATE_SHAPES) {
    const match = shape.pattern.exec(datePart);
    if (match) return shape.format(match);
  }
  return "m/d/yyyy";
}
