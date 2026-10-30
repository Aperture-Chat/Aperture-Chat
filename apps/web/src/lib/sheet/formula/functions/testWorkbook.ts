/** Test support for the function library: builds a workbook from the values
 * and formulas a user would type, recalculates it the way the editor does,
 * and reads results back with errors shown as their codes ("#N/A"). */

import { parseCellKey } from "../../address";
import { computeWorkbook } from "../../recalc";
import { parseWorkbook, type Workbook } from "../../sheetModel";
import { type Scalar, isError } from "../values";

export type CellInputs = Record<string, string | number | boolean>;
export type Shown = number | string | boolean | null;
export type Result = Shown | Shown[][];

const FORMULA_CELL = "Z1";

export function workbookOf(sheets: Record<string, CellInputs>): Workbook {
  const parsed = parseWorkbook({
    sheets: Object.entries(sheets).map(([name, cells], index) => ({
      id: `sheet-${index + 1}`,
      name,
      cells: Object.fromEntries(Object.entries(cells).map(([address, input]) => [
        address,
        typeof input === "string" && input.startsWith("=") ? { f: input.slice(1) } : { v: input },
      ])),
    })),
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.workbook;
}

function shown(value: Scalar): Shown {
  return isError(value) ? value.code : value;
}

/** Recalculates the sheets and returns a reader for the first sheet: a cell
 * that anchors a spill reads as the whole spilled matrix. */
export function recalculate(sheets: Record<string, CellInputs>, options: { now?: Date } = {}): (address: string) => Result {
  const workbook = workbookOf(sheets);
  const engine = computeWorkbook(workbook, options);
  const sheetId = workbook.sheets[0].id;
  return (address) => {
    const point = parseCellKey(address);
    if (!point) throw new Error(`Bad address ${address}`);
    const spill = engine.spillRange(sheetId, point.row, point.col);
    if (!spill) return shown(engine.value(sheetId, point.row, point.col));
    const rows: Shown[][] = [];
    for (let row = spill.r1; row <= spill.r2; row += 1) {
      const line: Shown[] = [];
      for (let col = spill.c1; col <= spill.c2; col += 1) line.push(shown(engine.value(sheetId, row, col)));
      rows.push(line);
    }
    return rows;
  };
}

/** The result of one formula typed into Z1 of a sheet holding `cells`. */
export function calc(formula: string, cells: CellInputs = {}, options: { now?: Date } = {}): Result {
  return recalculate({ Sheet1: { ...cells, [FORMULA_CELL]: formula } }, options)(FORMULA_CELL);
}
