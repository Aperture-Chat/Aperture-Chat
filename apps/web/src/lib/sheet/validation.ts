/** Data validation: whether a typed entry satisfies the rules covering a
 * cell, and the items a dropdown list offers. Strict rules reject the entry
 * (Excel's "Stop" style); others accept it with a warning. */

import { parseRangeRef, rangeContains, splitSheetQualifiedRef } from "./address";
import { isError } from "./formula/values";
import { formatCellValue, parseCellInput } from "./numberFormat";
import type { WorkbookEngine } from "./recalc";
import { type Sheet, type SheetValidation, type Workbook, sheetByName } from "./sheetModel";

export function validationAt(sheet: Sheet, row: number, col: number): SheetValidation | null {
  for (const rule of sheet.validations ?? []) {
    const range = parseRangeRef(rule.ref);
    if (range && rangeContains(range, row, col)) return rule;
  }
  return null;
}

/** Items a list rule allows: its literal items or the values in its source range. */
export function listItems(rule: SheetValidation, sheet: Sheet, workbook: Workbook, engine: WorkbookEngine): string[] {
  if (rule.items?.length) return rule.items;
  if (!rule.source) return [];
  const { sheet: name, ref } = splitSheetQualifiedRef(rule.source);
  const host = name ? sheetByName(workbook, name) : sheet;
  const range = parseRangeRef(ref);
  if (!host || !range) return [];
  const items: string[] = [];
  const used = engine.usedRange(host.id);
  const last = Math.min(range.r2, used?.r2 ?? range.r1);
  for (let row = range.r1; row <= last && items.length < 500; row += 1) {
    for (let col = range.c1; col <= range.c2; col += 1) {
      const value = engine.value(host.id, row, col);
      if (value === null || value === "" || isError(value)) continue;
      const text = formatCellValue(value).text;
      if (!items.includes(text)) items.push(text);
    }
  }
  return items;
}

function compare(op: SheetValidation["op"], value: number, a: number, b: number | null): boolean {
  switch (op) {
    case "gt": return value > a;
    case "gte": return value >= a;
    case "lt": return value < a;
    case "lte": return value <= a;
    case "eq": return value === a;
    case "neq": return value !== a;
    case "notBetween": return b !== null && (value < Math.min(a, b) || value > Math.max(a, b));
    default: return b !== null && value >= Math.min(a, b) && value <= Math.max(a, b);
  }
}

function describe(rule: SheetValidation): string {
  if (rule.message) return rule.message;
  const words: Record<string, string> = { between: "between", notBetween: "not between", gt: "greater than", gte: "at least", lt: "less than", lte: "at most", eq: "equal to", neq: "not equal to" };
  const what = rule.kind === "whole" ? "a whole number" : rule.kind === "decimal" ? "a number" : rule.kind === "date" ? "a date" : "text with a length";
  const range = rule.op === "between" || rule.op === "notBetween" ? `${rule.value} and ${rule.value2}` : `${rule.value}`;
  return `Enter ${what} ${words[rule.op ?? "between"]} ${range}.`;
}

export type ValidationProblem = { strict: boolean; message: string };

export function validateEntry(
  sheet: Sheet,
  row: number,
  col: number,
  text: string,
  resolveItems?: (rule: SheetValidation) => string[],
): ValidationProblem | null {
  const rule = validationAt(sheet, row, col);
  if (!rule || !text.trim()) return null;
  const parsed = parseCellInput(text);
  if (parsed.kind !== "value") return null;
  const problem = (message: string) => ({ strict: rule.strict, message });
  if (rule.kind === "list") {
    const items = rule.items?.length ? rule.items : resolveItems?.(rule) ?? [];
    if (!items.length) return null;
    const typed = String(parsed.value).toLowerCase();
    return items.some((item) => item.toLowerCase() === typed) ? null : problem(rule.message ?? `Choose one of: ${items.slice(0, 8).join(", ")}${items.length > 8 ? "…" : ""}.`);
  }
  const a = parseCellInput(rule.value ?? "");
  const b = rule.value2 !== undefined ? parseCellInput(rule.value2) : null;
  const first = a.kind === "value" && typeof a.value === "number" ? a.value : Number(rule.value);
  const second = b && b.kind === "value" && typeof b.value === "number" ? b.value : rule.value2 !== undefined ? Number(rule.value2) : null;
  if (rule.kind === "textLength") {
    return compare(rule.op, String(parsed.value).length, first, second) ? null : problem(describe(rule));
  }
  if (typeof parsed.value !== "number") return problem(describe(rule));
  if (rule.kind === "whole" && !Number.isInteger(parsed.value)) return problem(describe(rule));
  return compare(rule.op, parsed.value, first, second) ? null : problem(describe(rule));
}
