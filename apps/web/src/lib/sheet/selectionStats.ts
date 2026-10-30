import type { CellRange } from "./address";
import { isError } from "./formula/values";
import type { WorkbookEngine } from "./recalc";

/** Excel's status-bar figures for a selection: how many cells are filled,
 * and the sum, count, and bounds of the numbers among them. */
export type SelectionStats = { count: number; numbers: number; sum: number; min: number; max: number };

/** Cells read before the figures stop, so a whole-sheet selection stays fast. */
export const MAX_STAT_CELLS = 200_000;

export function selectionStats(engine: WorkbookEngine, sheetId: string, range: CellRange, cap = MAX_STAT_CELLS): SelectionStats {
  const stats: SelectionStats = { count: 0, numbers: 0, sum: 0, min: Infinity, max: -Infinity };
  let seen = 0;
  for (let row = range.r1; row <= range.r2; row += 1) {
    for (let col = range.c1; col <= range.c2; col += 1) {
      if (seen === cap) return stats;
      seen += 1;
      tally(stats, engine.value(sheetId, row, col));
    }
  }
  return stats;
}

function tally(stats: SelectionStats, value: ReturnType<WorkbookEngine["value"]>) {
  if (value === null || value === "") return;
  stats.count += 1;
  if (typeof value !== "number" || isError(value)) return;
  stats.numbers += 1;
  stats.sum += value;
  stats.min = Math.min(stats.min, value);
  stats.max = Math.max(stats.max, value);
}
