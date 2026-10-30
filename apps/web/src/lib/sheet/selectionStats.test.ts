import { describe, expect, it } from "vitest";
import { computeWorkbook } from "./recalc";
import { parseWorkbook } from "./sheetModel";
import { selectionStats } from "./selectionStats";

function engineFor(cells: Record<string, unknown>) {
  const parsed = parseWorkbook({ sheets: [{ id: "s", name: "Data", cells }] });
  if (!parsed.ok) throw new Error(parsed.error);
  return computeWorkbook(parsed.workbook);
}

const A1_TO_B3 = { r1: 0, c1: 0, r2: 2, c2: 1 };

describe("selectionStats", () => {
  it("counts filled cells and sums, averages, and bounds only the numbers, as Excel's status bar does", () => {
    const engine = engineFor({ A1: { v: "Units" }, A2: { v: 12 }, A3: { v: -4 }, B1: { v: 30 }, B3: { f: "1/0" } });
    expect(selectionStats(engine, "s", A1_TO_B3)).toEqual({ count: 5, numbers: 3, sum: 38, min: -4, max: 30 });
  });

  it("skips empty cells and formulas that show nothing", () => {
    const engine = engineFor({ A1: { v: 5 }, A2: { f: "\"\"" } });
    expect(selectionStats(engine, "s", A1_TO_B3)).toEqual({ count: 1, numbers: 1, sum: 5, min: 5, max: 5 });
  });

  it("reads every row and column of the range, edges included", () => {
    const engine = engineFor({ A1: { v: 1 }, B1: { v: 2 }, A3: { v: 4 }, B3: { v: 8 } });
    expect(selectionStats(engine, "s", A1_TO_B3).sum).toBe(15);
  });

  it("stops after the cell cap so a whole-sheet selection stays fast", () => {
    const engine = engineFor({ A1: { v: 1 }, B1: { v: 2 }, A2: { v: 4 } });
    expect(selectionStats(engine, "s", A1_TO_B3, 2)).toEqual({ count: 2, numbers: 2, sum: 3, min: 1, max: 2 });
    expect(selectionStats(engine, "s", A1_TO_B3, 3).sum).toBe(7);
    expect(selectionStats(engine, "s", A1_TO_B3, 1).sum).toBe(1);
  });

  it("reports no numbers for text only", () => {
    const engine = engineFor({ A1: { v: "a" }, B2: { v: "b" } });
    expect(selectionStats(engine, "s", A1_TO_B3)).toMatchObject({ count: 2, numbers: 0, sum: 0 });
  });
});
