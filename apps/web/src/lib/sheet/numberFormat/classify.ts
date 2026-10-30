/** What kind of format a code is, judged from the section that formats
 * positive numbers, as Excel's Format Cells categories do. */

import { minuteTokens } from "./dateBody";
import { type NumberBody, compileNumberBody } from "./numberBody";
import { type Token, customCode, isDateSection, isDateToken, planSections, sectionHead, tokenizeFormat } from "./tokens";

export type NumberFormatKind =
  | "general"
  | "number"
  | "currency"
  | "accounting"
  | "percent"
  | "date"
  | "time"
  | "datetime"
  | "scientific"
  | "fraction"
  | "text"
  | "custom";

/** The first number section's tokens without color or condition; null when
 * the code has no number section ("@" alone). */
function leadSection(code: string): Token[] | null {
  const first = planSections(tokenizeFormat(code)).numeric[0];
  return first ? sectionHead(first).tokens : null;
}

export function isDateFormat(format: string | undefined): boolean {
  const code = customCode(format);
  const tokens = code === null ? null : leadSection(code);
  return tokens !== null && isDateSection(tokens);
}

export function numberFormatKind(format: string | undefined): NumberFormatKind {
  const code = customCode(format);
  if (code === null) return "general";
  const tokens = leadSection(code);
  return tokens ? sectionKind(tokens) : "text";
}

function sectionKind(tokens: Token[]): NumberFormatKind {
  if (isDateSection(tokens)) return dateKind(tokens);
  if (tokens.some((token) => token.kind === "general")) return tokens.every((token) => token.kind === "general") ? "general" : "custom";
  const body = compileNumberBody(tokens);
  const rule = NUMBER_KINDS.find(([, test]) => test(tokens, body));
  return rule ? rule[0] : "number";
}

function dateKind(tokens: Token[]): "date" | "time" | "datetime" {
  const minutes = minuteTokens(tokens);
  const calendar = tokens.map((token, index) => isCalendarToken(token, minutes[index]));
  const hasDate = calendar.includes(true);
  const hasTime = tokens.some((token, index) => isDateToken(token) && !calendar[index]);
  if (hasDate && hasTime) return "datetime";
  return hasDate ? "date" : "time";
}

function isCalendarToken(token: Token, minute: boolean): boolean {
  return token.kind === "date" && !minute && (token.ch === "y" || token.ch === "m" || token.ch === "d");
}

/** Checked in order; a code that passes none is a plain number. */
const NUMBER_KINDS: Array<[NumberFormatKind, (tokens: Token[], body: NumberBody) => boolean]> = [
  ["scientific", (_tokens, body) => body.mode === "scientific"],
  ["fraction", (_tokens, body) => body.mode === "fraction"],
  ["percent", (tokens) => tokens.some((token) => token.kind === "percent")],
  ["accounting", (tokens) => tokens.some((token) => token.kind === "fill")],
  ["currency", (tokens) => tokens.some(isCurrencyToken)],
  ["custom", (tokens, body) => body.multiplier !== 1 || !tokens.some((token) => token.kind === "digit") || tokens.some(isWordLiteral)],
];

function isCurrencyToken(token: Token): boolean {
  return token.kind === "currency" || (token.kind === "literal" && /^\s*[$€£¥]\s*$/.test(token.text));
}

/** Literal text beyond the spaces, parentheses, and signs a number format uses. */
function isWordLiteral(token: Token): boolean {
  return token.kind === "literal" && !/^[\s()+-]*$/.test(token.text);
}
