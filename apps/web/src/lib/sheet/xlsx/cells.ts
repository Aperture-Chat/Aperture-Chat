/** `<c>` elements: literal values, cached formula results, and the sparse
 * grid that orders them into `<row>`s. Cached values come from the engine;
 * Excel recalculates on open (fullCalcOnLoad) but other readers show them. */

import { cellKey, type CellRange } from "../address";
import { isError, type Scalar } from "../formula/values";
import type { ExportContext } from "./context";
import { attrs, cellText, escapeXml } from "./xml";

/** Error codes every Excel version reads; newer ones are stored as #VALUE!
 * (Excel 365 itself does this, with the real kind in rich-value metadata). */
const FILE_ERRORS = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A"]);

function errorCode(code: string): string {
  return FILE_ERRORS.has(code) ? code : "#VALUE!";
}

type Cached = { t?: string; v: string };

function cachedNumber(value: number): Cached {
  return Number.isFinite(value) ? { v: String(value) } : { t: "e", v: "#NUM!" };
}

/** A formula result as its `t` attribute and `<v>` text. Excel recalculates
 * results, so their text is cleaned without adding to the warnings. */
function cachedResult(value: Scalar): Cached | null {
  if (value === null) return null;
  if (isError(value)) return { t: "e", v: errorCode(value.code) };
  if (typeof value === "boolean") return { t: "b", v: value ? "1" : "0" };
  if (typeof value === "number") return cachedNumber(value);
  return { t: "str", v: escapeXml(cellText(value)) };
}

/** A value without a formula. Stored text goes to the shared string table;
 * a cell inside a dynamic array's spill range holds text that is a
 * formula result (t="str") rather than a constant that would block the spill.
 * (`inSpill` marks those cells.) */
export function valueCellXml(ctx: ExportContext, row: number, col: number, value: Scalar, style: number, inSpill = false): string {
  const r = cellKey(row, col);
  if (typeof value === "string" && !inSpill) return `<c${attrs({ r, s: style || undefined, t: "s" })}><v>${ctx.strings.index(value)}</v></c>`;
  const cached = cachedResult(value);
  if (!cached) return style ? `<c r="${r}" s="${style}"/>` : "";
  return `<c${attrs({ r, s: style || undefined, t: cached.t })}><v>${cached.v}</v></c>`;
}

export type FormulaCell = {
  row: number;
  col: number;
  /** Formula text as the file stores it (prefixed, no "="). */
  text: string;
  value: Scalar;
  style: number;
  /** The dynamic-array extent (A1 text) when written as one. */
  arrayRef: string | null;
};

export function formulaCellXml(cell: FormulaCell): string {
  const cached = cachedResult(cell.value);
  const dynamic = cell.arrayRef !== null;
  const head = attrs({ r: cellKey(cell.row, cell.col), s: cell.style || undefined, t: cached?.t, cm: dynamic ? 1 : undefined });
  const f = dynamic ? `<f t="array" ref="${cell.arrayRef}">` : "<f>";
  return `<c${head}>${f}${escapeXml(cell.text)}</f>${cached ? `<v>${cached.v}</v>` : ""}</c>`;
}

/** Cells by row then column; later writes replace earlier ones. */
export class CellGrid {
  private readonly rows = new Map<number, Map<number, string>>();

  set(row: number, col: number, xml: string): void {
    let line = this.rows.get(row);
    if (!line) {
      line = new Map();
      this.rows.set(row, line);
    }
    if (xml) line.set(col, xml);
    else line.delete(col);
  }

  /** Row indexes that hold at least one cell, ascending. */
  rowIndexes(): number[] {
    return Array.from(this.rows.keys()).filter((row) => this.rows.get(row)!.size).sort((a, b) => a - b);
  }

  rowXml(row: number): string {
    const line = this.rows.get(row);
    if (!line) return "";
    return Array.from(line.keys()).sort((a, b) => a - b).map((col) => line.get(col)).join("");
  }

  /** The written extent, or null when the sheet has no cells. */
  extent(): CellRange | null {
    const rows = this.rowIndexes();
    if (!rows.length) return null;
    let c1 = Infinity;
    let c2 = -Infinity;
    for (const row of rows) {
      for (const col of this.rows.get(row)!.keys()) {
        c1 = Math.min(c1, col);
        c2 = Math.max(c2, col);
      }
    }
    return { r1: rows[0], c1, r2: rows[rows.length - 1], c2 };
  }
}
