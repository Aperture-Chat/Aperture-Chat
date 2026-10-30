/** Rewrites the references inside formula text: relative shifts for copy and
 * fill, row/column insert and delete, cut-and-paste moves, and sheet renames.
 * Edits are applied to token spans, so everything else in the formula (the
 * author's spacing, casing, and function names) is preserved byte for byte.
 */

import { MAX_SHEET_COLS, MAX_SHEET_ROWS, type CellRange, columnLabel, quoteSheetName } from "../address";
import { type Token, tokenizeFormula } from "./parser";

export type RefKind = "cell" | "range" | "cols" | "rows";

export type RefDescriptor = {
  /** Sheet named in the text, or null when the reference is local. */
  sheet: string | null;
  kind: RefKind;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  abs: { r1: boolean; c1: boolean; r2: boolean; c2: boolean };
};

/** Return a new descriptor, null for #REF!, or undefined to keep the text. */
export type RefMapper = (ref: RefDescriptor) => RefDescriptor | null | undefined;

type Span = { start: number; end: number; ref: RefDescriptor; prefixText: string | null };

function prefixOf(source: string, token: Token): string | null {
  const text = source.slice(token.start, token.end);
  const bang = text.lastIndexOf("!");
  return bang >= 0 ? text.slice(0, bang + 1) : null;
}

function collectSpans(source: string, tokens: Token[]): Span[] {
  const real = tokens.filter((token) => token.t !== "ws");
  const spans: Span[] = [];
  for (let index = 0; index < real.length; index += 1) {
    const token = real[index];
    const end = real[index + 1]?.t === ":" ? real[index + 2] : undefined;
    const pair = rangeSpan(source, token, end) ?? columnsSpan(source, token, end) ?? rowsSpan(source, token, end);
    if (pair) {
      spans.push(pair);
      index += 2;
    } else if (token.t === "ref") spans.push(cellSpan(source, token));
  }
  return spans;
}

type TokenOf<T extends Token["t"]> = Extract<Token, { t: T }>;

function cellSpan(source: string, token: TokenOf<"ref">): Span {
  return {
    start: token.start,
    end: token.end,
    prefixText: prefixOf(source, token),
    ref: {
      sheet: token.sheet,
      kind: "cell",
      r1: token.row,
      c1: token.col,
      r2: token.row,
      c2: token.col,
      abs: { r1: token.rowAbs, c1: token.colAbs, r2: token.rowAbs, c2: token.colAbs },
    },
  };
}

/** A1:B2 — two cell references joined by ":". */
function rangeSpan(source: string, token: Token, end: Token | undefined): Span | null {
  if (token.t !== "ref" || end?.t !== "ref") return null;
  return {
    start: token.start,
    end: end.end,
    prefixText: prefixOf(source, token),
    ref: {
      sheet: token.sheet,
      kind: "range",
      r1: token.row,
      c1: token.col,
      r2: end.row,
      c2: end.col,
      abs: { r1: token.rowAbs, c1: token.colAbs, r2: end.rowAbs, c2: end.colAbs },
    },
  };
}

function columnsSpan(source: string, token: Token, end: Token | undefined): Span | null {
  if (token.t !== "colref" || end?.t !== "colref") return null;
  return {
    start: token.start,
    end: end.end,
    prefixText: prefixOf(source, token),
    ref: { sheet: token.sheet, kind: "cols", r1: 0, c1: token.col, r2: MAX_SHEET_ROWS - 1, c2: end.col, abs: { r1: false, c1: token.abs, r2: false, c2: end.abs } },
  };
}

function rowsSpan(source: string, token: Token, end: Token | undefined): Span | null {
  if (token.t !== "rowref" || end?.t !== "rowref") return null;
  return {
    start: token.start,
    end: end.end,
    prefixText: prefixOf(source, token),
    ref: { sheet: token.sheet, kind: "rows", r1: token.row, c1: 0, r2: end.row, c2: MAX_SHEET_COLS - 1, abs: { r1: token.abs, c1: false, r2: end.abs, c2: false } },
  };
}

function cellText(row: number, col: number, rowAbs: boolean, colAbs: boolean): string {
  return `${colAbs ? "$" : ""}${columnLabel(col)}${rowAbs ? "$" : ""}${row + 1}`;
}

function dollar(abs: boolean): string {
  return abs ? "$" : "";
}

/** The reference text after any sheet prefix, by kind. */
const REF_TEXT: Record<RefKind, (ref: RefDescriptor) => string> = {
  cell: (ref) => cellText(ref.r1, ref.c1, ref.abs.r1, ref.abs.c1),
  range: (ref) => `${cellText(ref.r1, ref.c1, ref.abs.r1, ref.abs.c1)}:${cellText(ref.r2, ref.c2, ref.abs.r2, ref.abs.c2)}`,
  cols: (ref) => `${dollar(ref.abs.c1)}${columnLabel(ref.c1)}:${dollar(ref.abs.c2)}${columnLabel(ref.c2)}`,
  rows: (ref) => `${dollar(ref.abs.r1)}${ref.r1 + 1}:${dollar(ref.abs.r2)}${ref.r2 + 1}`,
};

export function formatRefDescriptor(ref: RefDescriptor, prefixText: string | null = null): string {
  const prefix = ref.sheet === null ? "" : prefixText ?? `${quoteSheetName(ref.sheet)}!`;
  return `${prefix}${REF_TEXT[ref.kind](ref)}`;
}

/** Applies `mapper` to every reference in `formula` (text without "="). Text
 * that does not tokenize is returned unchanged. */
export function rewriteReferences(formula: string, mapper: RefMapper): string {
  let tokens: Token[];
  try {
    tokens = tokenizeFormula(formula);
  } catch {
    return formula;
  }
  const spans = collectSpans(formula, tokens);
  let out = formula;
  for (const span of spans.reverse()) {
    const next = mapper(span.ref);
    if (next === undefined) continue;
    const sameSheet = next !== null && next.sheet === span.ref.sheet;
    const replacement = next === null ? "#REF!" : formatRefDescriptor(next, sameSheet ? span.prefixText : null);
    out = out.slice(0, span.start) + replacement + out.slice(span.end);
  }
  return out;
}

/** Every reference in a formula, for highlighting and dependency hints. */
export function formulaReferences(formula: string): RefDescriptor[] {
  try {
    const source = formula.startsWith("=") ? formula.slice(1) : formula;
    return collectSpans(source, tokenizeFormula(source)).map((span) => span.ref);
  } catch {
    return [];
  }
}

/** Reference spans with their positions in the formula text (without "="). */
export function formulaReferenceSpans(formula: string): { start: number; end: number; ref: RefDescriptor }[] {
  try {
    return collectSpans(formula, tokenizeFormula(formula)).map(({ start, end, ref }) => ({ start, end, ref }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ copy and fill */

/** Shifts relative parts by (dRow, dCol), as copying a formula does.
 * References pushed off the sheet become #REF!. */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  if (!dRow && !dCol) return formula;
  return rewriteReferences(formula, (ref) => shiftedRef(ref, dRow, dCol));
}

function shiftedRef(ref: RefDescriptor, dRow: number, dCol: number): RefDescriptor | null {
  const next = { ...ref, abs: { ...ref.abs } };
  if (ref.kind !== "cols") shiftRelative(next, ["r1", "r2"], dRow);
  if (ref.kind !== "rows") shiftRelative(next, ["c1", "c2"], dCol);
  return offSheet(next) ? null : next;
}

/** Moves the ends of a reference that are not anchored with "$". */
function shiftRelative(ref: RefDescriptor, ends: readonly ("r1" | "r2" | "c1" | "c2")[], delta: number): void {
  for (const end of ends) if (!ref.abs[end]) ref[end] += delta;
}

function outside(index: number, limit: number): boolean {
  return index < 0 || index >= limit;
}

function offSheet(ref: RefDescriptor): boolean {
  return outside(ref.r1, MAX_SHEET_ROWS) || outside(ref.r2, MAX_SHEET_ROWS) || outside(ref.c1, MAX_SHEET_COLS) || outside(ref.c2, MAX_SHEET_COLS);
}

/* ------------------------------------------------------------------ structure edits */

export type Axis = "rows" | "cols";

/** Where a range lands after `count` rows/columns are inserted at `at`. */
export function shiftRangeForInsert(range: CellRange, axis: Axis, at: number, count: number): CellRange {
  const [lo, hi] = axis === "rows" ? [range.r1, range.r2] : [range.c1, range.c2];
  let nextLo = lo;
  let nextHi = hi;
  if (lo >= at) {
    nextLo += count;
    nextHi += count;
  } else if (hi >= at) {
    nextHi += count;
  }
  const limit = (axis === "rows" ? MAX_SHEET_ROWS : MAX_SHEET_COLS) - 1;
  nextLo = Math.min(nextLo, limit);
  nextHi = Math.min(nextHi, limit);
  return axis === "rows" ? { ...range, r1: nextLo, r2: nextHi } : { ...range, c1: nextLo, c2: nextHi };
}

/** Where a range lands after rows/columns [at, at+count) are deleted, or null
 * when the whole range was deleted. */
export function shiftRangeForDelete(range: CellRange, axis: Axis, at: number, count: number): CellRange | null {
  const [lo, hi] = axis === "rows" ? [range.r1, range.r2] : [range.c1, range.c2];
  const end = at + count - 1;
  if (lo >= at && hi <= end) return null;
  const mapIndex = (index: number, isLow: boolean) => {
    if (index < at) return index;
    if (index > end) return index - count;
    return isLow ? at : at - 1;
  };
  const nextLo = mapIndex(lo, true);
  const nextHi = mapIndex(hi, false);
  if (nextHi < nextLo) return null;
  return axis === "rows" ? { ...range, r1: nextLo, r2: nextHi } : { ...range, c1: nextLo, c2: nextHi };
}

function refTargets(ref: RefDescriptor, hostSheet: string, targetSheet: string): boolean {
  return (ref.sheet ?? hostSheet).toLowerCase() === targetSheet.toLowerCase();
}

/** Adjusts a formula living on `hostSheet` after rows or columns were
 * inserted on `targetSheet`. Absolute references move too, as in Excel. */
export function adjustFormulaForInsert(formula: string, hostSheet: string, targetSheet: string, axis: Axis, at: number, count: number): string {
  return rewriteReferences(formula, (ref) => {
    if (!refTargets(ref, hostSheet, targetSheet)) return undefined;
    if ((axis === "rows" && ref.kind === "cols") || (axis === "cols" && ref.kind === "rows")) return undefined;
    const moved = shiftRangeForInsert(ref, axis, at, count);
    if (ref.kind === "cell") {
      // A single cell moves only when it sits at or after the insert point.
      const index = axis === "rows" ? ref.r1 : ref.c1;
      if (index < at) return undefined;
    }
    return { ...ref, ...moved, kind: ref.kind };
  });
}

/** Adjusts a formula after rows or columns [at, at+count) were deleted on
 * `targetSheet`. References that lose all their cells become #REF!. */
export function adjustFormulaForDelete(formula: string, hostSheet: string, targetSheet: string, axis: Axis, at: number, count: number): string {
  return rewriteReferences(formula, (ref) => {
    if (!refTargets(ref, hostSheet, targetSheet)) return undefined;
    if ((axis === "rows" && ref.kind === "cols") || (axis === "cols" && ref.kind === "rows")) return undefined;
    const moved = shiftRangeForDelete(ref, axis, at, count);
    if (!moved) return null;
    return { ...ref, ...moved, kind: ref.kind };
  });
}

/** Re-points references into a block that was cut from `source` and pasted
 * (dRow, dCol) away on the same sheet. */
export function adjustFormulaForMove(formula: string, hostSheet: string, targetSheet: string, source: CellRange, dRow: number, dCol: number): string {
  return adjustFormulaForBlockMove(formula, hostSheet, { fromSheet: targetSheet, toSheet: targetSheet, source, dRow, dCol });
}

/** A cut-and-paste: the cells in `source` on `fromSheet` now sit `dRow`/`dCol`
 * away, on `toSheet`. */
export type BlockMove = { fromSheet: string; toSheet: string; source: CellRange; dRow: number; dCol: number };

function sameSheetName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Whole-column (row) references span every row (column), so they fall
 * inside only when whole columns (rows) were moved. */
function insideBlock(ref: RefDescriptor, source: CellRange): boolean {
  return ref.r1 >= source.r1 && ref.r2 <= source.r2 && ref.c1 >= source.c1 && ref.c2 <= source.c2;
}

/** The sheet prefix a reference to the moved cells needs from `newHost`:
 * none on the block's new sheet, the new sheet's name elsewhere. A move
 * within one sheet keeps the prefix as written. */
function movedSheetPrefix(ref: RefDescriptor, move: BlockMove, newHost: string): string | null {
  if (sameSheetName(move.toSheet, newHost)) return sameSheetName(move.fromSheet, move.toSheet) ? ref.sheet : null;
  return move.toSheet;
}

/** Re-points a formula written on `hostSheet` after a cut-and-paste, as
 * Excel's move does: references wholly inside the block follow it, onto its
 * new sheet. `newHost` is where the formula itself now lives (the moved
 * cells' formulas change sheets with them); its local references to other
 * cells keep pointing at `hostSheet`. */
export function adjustFormulaForBlockMove(formula: string, hostSheet: string, move: BlockMove, newHost: string = hostSheet): string {
  return rewriteReferences(formula, (ref) => {
    if (refTargets(ref, hostSheet, move.fromSheet) && insideBlock(ref, move.source)) {
      return { ...ref, sheet: movedSheetPrefix(ref, move, newHost), r1: ref.r1 + move.dRow, r2: ref.r2 + move.dRow, c1: ref.c1 + move.dCol, c2: ref.c2 + move.dCol };
    }
    if (ref.sheet === null && !sameSheetName(hostSheet, newHost)) return { ...ref, sheet: hostSheet };
    return undefined;
  });
}

export function renameSheetInFormula(formula: string, oldName: string, newName: string): string {
  return rewriteReferences(formula, (ref) => {
    if (ref.sheet === null || ref.sheet.toLowerCase() !== oldName.toLowerCase()) return undefined;
    return { ...ref, sheet: newName };
  });
}

export function invalidateSheetInFormula(formula: string, sheetName: string): string {
  return rewriteReferences(formula, (ref) => (ref.sheet !== null && ref.sheet.toLowerCase() === sheetName.toLowerCase() ? null : undefined));
}
