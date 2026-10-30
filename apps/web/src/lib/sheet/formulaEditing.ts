/** Helpers for typing formulas: colour-coded references, the point where a
 * clicked cell can be inserted as a reference, function autocomplete, the
 * argument hint, and F4's absolute-reference cycle. */

import { SHEET_FUNCTIONS, SHEET_FUNCTION_NAMES } from "./formula/functions";
import { formulaReferenceSpans, type RefDescriptor } from "./formula/references";
import type { FunctionSpec } from "./formula/types";

const REF_COLORS = ["#2f6eba", "#c2475a", "#7a5ac8", "#3d8b5a", "#c9821a", "#087d8b", "#b5487f", "#5b6b7b"];

export function referenceColor(index: number): string {
  return REF_COLORS[index % REF_COLORS.length];
}

export type FormulaSegment = { text: string; color?: string; ref?: RefDescriptor };

/** Splits "=SUM(A1:B2)+C3" into plain and coloured reference segments. The
 * same reference text keeps the same colour, as in Excel. */
export function formulaSegments(text: string): FormulaSegment[] {
  if (!text.startsWith("=")) return [{ text }];
  const body = text.slice(1);
  const spans = formulaReferenceSpans(body);
  const colors = new Map<string, string>();
  const segments: FormulaSegment[] = [{ text: "=" }];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) segments.push({ text: body.slice(cursor, span.start) });
    const refText = body.slice(span.start, span.end);
    const key = refText.replace(/\$/g, "").toUpperCase();
    if (!colors.has(key)) colors.set(key, referenceColor(colors.size));
    segments.push({ text: refText, color: colors.get(key), ref: span.ref });
    cursor = span.end;
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor) });
  return segments;
}

/** Whether a clicked cell should be inserted as a reference at `caret`. */
export function canInsertReference(text: string, caret: number): boolean {
  if (!text.startsWith("=")) return false;
  const before = text.slice(0, caret).replace(/\s+$/, "");
  if (!before.length) return false;
  if (insideString(text, caret)) return false;
  return /[=(,+\-*/^&<>:;{]$/.test(before);
}

function insideString(text: string, caret: number): boolean {
  let quoted = false;
  for (let index = 0; index < caret; index += 1) if (text[index] === '"') quoted = !quoted;
  return quoted;
}

/** The function-name prefix being typed at the caret, if any. */
export function functionPrefixAt(text: string, caret: number): { start: number; prefix: string } | null {
  if (!text.startsWith("=") || insideString(text, caret)) return null;
  const match = /([A-Za-z][A-Za-z0-9.]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const start = caret - match[1].length;
  const before = text.slice(0, start).replace(/\s+$/, "");
  if (!/[=(,+\-*/^&<>;{]$/.test(before)) return null;
  if (/^[A-Za-z]{1,3}\d+$/.test(match[1])) return null;
  return { start, prefix: match[1] };
}

export type FunctionSuggestion = { name: string; spec: FunctionSpec };

const POPULAR = ["SUM", "AVERAGE", "COUNT", "COUNTA", "COUNTIF", "SUMIF", "SUMIFS", "IF", "IFERROR", "XLOOKUP", "VLOOKUP", "INDEX", "MATCH", "MAX", "MIN", "ROUND", "TODAY", "TEXT", "CONCAT", "FILTER", "SORT", "UNIQUE"];

export function suggestFunctions(prefix: string, limit = 8): FunctionSuggestion[] {
  const upper = prefix.toUpperCase();
  const starts = SHEET_FUNCTION_NAMES.filter((name) => name.startsWith(upper));
  starts.sort((a, b) => {
    const pa = POPULAR.indexOf(a);
    const pb = POPULAR.indexOf(b);
    if (pa >= 0 || pb >= 0) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
    return a.length - b.length || a.localeCompare(b);
  });
  return starts.slice(0, limit).map((name) => ({ name, spec: SHEET_FUNCTIONS[name] }));
}

/** The innermost function call around the caret and which argument it is in. */
export function activeFunctionCall(text: string, caret: number): { name: string; argIndex: number; spec: FunctionSpec } | null {
  if (!text.startsWith("=")) return null;
  const stack: { name: string; args: number }[] = [];
  let quoted = false;
  for (let index = 1; index < caret; index += 1) {
    const ch = text[index];
    if (ch === '"') quoted = !quoted;
    if (quoted) continue;
    if (ch === "(") {
      const name = /([A-Za-z][A-Za-z0-9._]*)\s*$/.exec(text.slice(0, index))?.[1] ?? "";
      stack.push({ name: name.toUpperCase().replace(/^_XLFN\./, ""), args: 0 });
    } else if (ch === ")") stack.pop();
    else if (ch === "," && stack.length) stack[stack.length - 1].args += 1;
  }
  for (let level = stack.length - 1; level >= 0; level -= 1) {
    const spec = SHEET_FUNCTIONS[stack[level].name];
    if (spec) return { name: stack[level].name, argIndex: stack[level].args, spec };
  }
  return null;
}

/** Splits a signature into argument labels for the hint ("number1", "[number2]", "..."). */
export function signatureParts(signature: string): string[] {
  return signature.split(",").map((part) => part.trim()).filter(Boolean);
}

/** F4: cycles the reference at the caret A1 → $A$1 → A$1 → $A1 → A1. */
export function toggleAbsoluteAt(text: string, caret: number): { text: string; caret: number } {
  if (!text.startsWith("=")) return { text, caret };
  const body = text.slice(1);
  const spans = formulaReferenceSpans(body);
  const span = spans.find((item) => caret - 1 >= item.start && caret - 1 <= item.end);
  if (!span) return { text, caret };
  const refText = body.slice(span.start, span.end);
  const cycled = refText.replace(/(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g, (_, colAbs: string, col: string, rowAbs: string, row: string) => {
    const state = `${colAbs ? 1 : 0}${rowAbs ? 1 : 0}`;
    const next = state === "00" ? "11" : state === "11" ? "01" : state === "01" ? "10" : "00";
    return `${next[0] === "1" ? "$" : ""}${col}${next[1] === "1" ? "$" : ""}${row}`;
  });
  const nextBody = body.slice(0, span.start) + cycled + body.slice(span.end);
  return { text: `=${nextBody}`, caret: 1 + span.start + cycled.length };
}
