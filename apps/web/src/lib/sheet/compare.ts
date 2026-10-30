/** Compares two saved workbook versions cell by cell, for "Compare versions"
 * in spreadsheet mode: what each changed cell held before and after (inputs,
 * so formulas show as formulas), plus sheets that were added, removed, or
 * renamed. */

import { parseCellKey } from "./address";
import type { Workbook } from "./sheetModel";
import { cellInputText } from "./sheetOps";

export type CellChange = { sheet: string; address: string; before: string; after: string; kind: "added" | "removed" | "changed" | "formatted" };
export type WorkbookComparison = {
  addedSheets: string[];
  removedSheets: string[];
  renamedSheets: { from: string; to: string }[];
  changes: CellChange[];
  /** Changes beyond the list limit. */
  more: number;
};

const LIMIT = 2_000;

function order(a: string, b: string): number {
  const pa = parseCellKey(a)!;
  const pb = parseCellKey(b)!;
  return pa.row - pb.row || pa.col - pb.col;
}

export function compareWorkbooks(base: Workbook, comparison: Workbook): WorkbookComparison {
  const result: WorkbookComparison = { addedSheets: [], removedSheets: [], renamedSheets: [], changes: [], more: 0 };
  for (const sheet of base.sheets) {
    const after = comparison.sheets.find((item) => item.id === sheet.id);
    if (!after) result.removedSheets.push(sheet.name);
    else if (after.name !== sheet.name) result.renamedSheets.push({ from: sheet.name, to: after.name });
  }
  for (const sheet of comparison.sheets) {
    const before = base.sheets.find((item) => item.id === sheet.id);
    if (!before) result.addedSheets.push(sheet.name);
    const keys = Array.from(new Set([...Object.keys(before?.cells ?? {}), ...Object.keys(sheet.cells)])).sort(order);
    for (const address of keys) {
      const oldCell = before?.cells[address];
      const newCell = sheet.cells[address];
      const oldText = cellInputText(oldCell);
      const newText = cellInputText(newCell);
      let kind: CellChange["kind"] | null = null;
      if (oldText !== newText) kind = !oldText ? "added" : !newText ? "removed" : "changed";
      else if (JSON.stringify(oldCell?.s ?? null) !== JSON.stringify(newCell?.s ?? null) && (oldText || newText)) kind = "formatted";
      if (!kind) continue;
      if (result.changes.length >= LIMIT) {
        result.more += 1;
        continue;
      }
      result.changes.push({ sheet: sheet.name, address, before: oldText, after: newText, kind });
    }
  }
  return result;
}
