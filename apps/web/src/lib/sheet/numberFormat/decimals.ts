/** "More decimals" and "fewer decimals": rewrites a code's decimal
 * placeholders in place, in every number section, leaving quoted text,
 * colors, and other sections exactly as they were. */

import type { Scalar } from "../formula/values";
import { formatGeneral } from "./general";
import { analyzeLayout } from "./numberBody";
import { type Token, customCode, isDateSection, planSections, sectionHead, tokenizeFormat } from "./tokens";

const MAX_DECIMALS = 30;

type Edit = { start: number; end: number; insert: string };

export function adjustDecimals(format: string | undefined, delta: 1 | -1, sample?: Scalar): string {
  const code = customCode(format);
  if (code === null) return generalWithDecimals(delta, sample);
  const sections = planSections(tokenizeFormat(code)).numeric.map((tokens) => sectionHead(tokens).tokens);
  const lead = sections[0] ? decimalTokens(sections[0]) : null;
  if (!lead) return code;
  const padTarget = clampDecimals(lead.decimals.length + delta);
  return applyEdits(code, sections.flatMap((tokens) => sectionEdits(tokens, delta, padTarget)));
}

/** General starts from the decimals the sample shows in General. Cell values
 * are finite, so a number sample can go straight to formatGeneral. */
function generalWithDecimals(delta: 1 | -1, sample: Scalar | undefined): string {
  const shown = typeof sample === "number" ? formatGeneral(sample) : "0";
  const [mantissa, exponent] = shown.split("E");
  const [, fraction = ""] = mantissa.split(".");
  const decimals = fraction.length + delta;
  if (decimals < 0) return "General";
  const code = decimals > 0 ? `0.${"0".repeat(clampDecimals(decimals))}` : "0";
  return exponent === undefined ? code : `${code}E+00`;
}

function clampDecimals(decimals: number): number {
  return Math.min(Math.max(decimals, 0), MAX_DECIMALS);
}

type DecimalTokens = { point: Token | undefined; decimals: Token[]; lastWhole: Token | undefined };

/** The point, decimal placeholders, and last whole-digit placeholder of a
 * fixed or scientific section with "0" or "#" placeholders; null for dates,
 * fractions, General, and sections without digits. */
function decimalTokens(tokens: Token[]): DecimalTokens | null {
  if (sectionShape(tokens) !== "digits") return null;
  const layout = analyzeLayout(tokens);
  if (layout.mode === "fraction") return null;
  const digits = tokens.map((token, index) => ({ token, role: layout.roleAt(index) })).filter(({ token }) => token.kind === "digit");
  return {
    point: tokens[layout.pointAt],
    decimals: digits.filter(({ role }) => role === "dec").map(({ token }) => token),
    lastWhole: digits.filter(({ role }) => role === "int").map(({ token }) => token).pop(),
  };
}

/** "digits" has "0" or "#" placeholders; "label" has none (the accounting
 * zero section); "other" is a date or General section. */
function sectionShape(tokens: Token[]): "digits" | "label" | "other" {
  if (isDateSection(tokens) || tokens.some((token) => token.kind === "general")) return "other";
  return tokens.some((token) => token.kind === "digit" && token.ch !== "?") ? "digits" : "label";
}

function sectionEdits(tokens: Token[], delta: 1 | -1, padTarget: number): Edit[] {
  const parts = decimalTokens(tokens);
  if (parts) return delta === 1 ? addDecimal(parts) : removeDecimal(parts);
  return sectionShape(tokens) === "label" ? resizePad(tokens, padTarget) : [];
}

/** A "0" after the last decimal placeholder, or ".0" after the last whole one. */
function addDecimal({ point, decimals, lastWhole }: DecimalTokens): Edit[] {
  if (decimals.length >= MAX_DECIMALS) return [];
  const after = [point, ...decimals].at(-1);
  if (after) return [{ start: after.end, end: after.end, insert: "0" }];
  return lastWhole ? [{ start: lastWhole.end, end: lastWhole.end, insert: ".0" }] : [];
}

function removeDecimal({ point, decimals, lastWhole }: DecimalTokens): Edit[] {
  const last = decimals[decimals.length - 1];
  if (!last) return [];
  if (decimals.length > 1 || !point) return [{ start: last.start, end: last.end, insert: "" }];
  // ".0" with no whole-digit placeholder becomes "0", not an empty code.
  return [{ start: point.start, end: last.end, insert: lastWhole ? "" : "0" }];
}

/** The accounting zero section pads its dash with one "?" per decimal so the
 * dash lines up with the units digit: "-"?? for two decimals. A label section
 * holds only "?" placeholders, so every digit token is a pad. */
function resizePad(tokens: Token[], target: number): Edit[] {
  const dash = tokens.find((token) => token.kind === "literal" && token.text === "-");
  if (!dash) return [];
  const pads = tokens.filter((token) => token.kind === "digit");
  if (pads.length >= target) return pads.slice(target).map(({ start, end }) => ({ start, end, insert: "" }));
  return [{ start: dash.end, end: dash.end, insert: "?".repeat(target - pads.length) }];
}

function applyEdits(code: string, edits: Edit[]): string {
  return [...edits].sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.insert + text.slice(edit.end), code);
}
