/** Formula text as Excel stores it inside an .xlsx file.
 *
 * Only token spans change, so the author's spacing and casing survive:
 * function names gain the _xlfn. / _xlfn._xlws. prefixes newer Excel
 * functions need, and this-row table references ("Sales[@Revenue]") take the
 * "[#This Row]" form the file format uses (the "@" spelling is UI-only).
 */

import { MAX_SHEET_COLS, MAX_SHEET_ROWS, columnLabel, parseRangeRef, quoteSheetName } from "../address";
import { excelFileFunctionName } from "../formula/excelNames";
import { SHEET_FUNCTIONS } from "../formula/functions";
import { canonicalFunctionName, parseFormula, tokenizeFormula, type FormulaNode, type Token } from "../formula/parser";
import { mayReturnArray } from "../recalc";

function thisRowSpec(spec: string): string {
  const rest = spec.slice(1).trim();
  if (!rest) return "#This Row";
  return rest.startsWith("[") ? `[#This Row],${rest}` : `[#This Row],[${rest}]`;
}

/** A table reference as the file stores it: with its table's name (a cell
 * inside a table may leave it out), and "this row" as [#This Row]. */
function tableText(token: Extract<Token, { t: "struct" }>, hostTable: string): string {
  const table = token.table || hostTable;
  const spec = token.spec.trimStart();
  return spec.startsWith("@") ? `${table}[${thisRowSpec(spec)}]` : `${table}[${token.spec}]`;
}

function tokenText(token: Token, source: string, hostTable: string): string {
  if (token.t === "func") return excelFileFunctionName(canonicalFunctionName(token.value));
  if (token.t === "struct") return tableText(token, hostTable);
  return source.slice(token.start, token.end);
}

function leavesTableOut(token: Token): boolean {
  return token.t === "struct" && !token.table;
}

/** Whether the formula calls a function the engine cannot evaluate. Excel
 * still computes it on open, and many such functions return arrays. */
function callsUnknownFunction(node: FormulaNode): boolean {
  switch (node.type) {
    case "call":
      return !SHEET_FUNCTIONS[node.name] || node.args.some(callsUnknownFunction);
    case "unary":
      return callsUnknownFunction(node.arg);
    case "binary":
      return callsUnknownFunction(node.left) || callsUnknownFunction(node.right);
    case "array":
      return node.rows.some((row) => row.some(callsUnknownFunction));
    default:
      return false;
  }
}

export type PreparedFormula = {
  /** The formula as the file stores it. */
  text: string;
  /** Whether its result can be a multi-cell array (a dynamic-array formula). */
  mayArray: boolean;
};

/** The formula ready for the file, or null when Excel could not read it, so
 * the caller never writes a formula Excel would repair away. `hostTable` is
 * the table the formula's cell sits in, for references that leave it out. */
export function prepareFormula(formula: string, hostTable = ""): PreparedFormula | null {
  const parsed = parseFormula(formula);
  if (!parsed.ok) return null;
  const tokens = tokenizeFormula(formula);
  if (!hostTable && tokens.some(leavesTableOut)) return null;
  const text = tokens.map((token) => tokenText(token, formula, hostTable)).join("");
  return { text, mayArray: mayReturnArray(parsed.ast) || callsUnknownFunction(parsed.ast) };
}

/** "B2:D9" on "Regional sales" -> "'Regional sales'!$B$2:$D$9". */
export function absoluteRef(sheet: string | null, ref: string): string {
  const range = parseRangeRef(ref);
  const prefix = sheet === null ? "" : `${quoteSheetName(sheet)}!`;
  if (!range) return `${prefix}${ref}`;
  const wholeCols = range.r1 === 0 && range.r2 === MAX_SHEET_ROWS - 1;
  const wholeRows = range.c1 === 0 && range.c2 === MAX_SHEET_COLS - 1;
  const col = (c: number) => `$${columnLabel(c)}`;
  const row = (r: number) => `$${r + 1}`;
  if (wholeCols) return `${prefix}${col(range.c1)}:${col(range.c2)}`;
  if (wholeRows) return `${prefix}${row(range.r1)}:${row(range.r2)}`;
  const start = `${col(range.c1)}${row(range.r1)}`;
  if (range.r1 === range.r2 && range.c1 === range.c2) return `${prefix}${start}`;
  return `${prefix}${start}:${col(range.c2)}${row(range.r2)}`;
}
