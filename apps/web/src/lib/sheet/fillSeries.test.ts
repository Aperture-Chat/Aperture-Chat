import { describe, expect, it } from "vitest";
import { parseRangeRef } from "./address";
import { fillFromEdge, fillRange } from "./fillSeries";
import { dateToSerial } from "./formula/values";
import type { SheetCell, Workbook } from "./sheetModel";
import { SHEET_SCHEMA_VERSION } from "./sheetModel";

const R = (text: string) => parseRangeRef(text)!;

function book(cells: Record<string, SheetCell>): Workbook {
  return { schema: SHEET_SCHEMA_VERSION, sheets: [{ id: "s1", name: "S", cells }] };
}

const fill = (cells: Record<string, SheetCell>, source: string, target: string) => fillRange(book(cells), "s1", R(source), R(target)).sheets[0].cells;
const DATE = { format: "yyyy-mm-dd" };
const date = (year: number, month: number, day: number) => dateToSerial(year, month, day);

describe("fill series", () => {
  it("steps dates by day, by the example gap, by month, and by year", () => {
    expect(fill({ A1: { v: date(2027, 1, 30), s: DATE } }, "A1", "A1:A3")).toEqual({
      A1: { v: date(2027, 1, 30), s: DATE },
      A2: { v: date(2027, 1, 31), s: DATE },
      A3: { v: date(2027, 2, 1), s: DATE },
    });
    expect(fill({ A1: { v: date(2027, 1, 1), s: DATE }, A2: { v: date(2027, 1, 8), s: DATE } }, "A1:A2", "A1:A4")).toMatchObject({ A3: { v: date(2027, 1, 15) }, A4: { v: date(2027, 1, 22) } });
    expect(fill({ A1: { v: date(2027, 1, 31), s: DATE }, A2: { v: date(2027, 3, 31), s: DATE } }, "A1:A2", "A1:A4")).toMatchObject({ A3: { v: date(2027, 5, 31) }, A4: { v: date(2027, 7, 31) } });
    expect(fill({ A1: { v: date(2027, 11, 30), s: DATE }, A2: { v: date(2027, 12, 30), s: DATE } }, "A1:A2", "A1:A4")).toMatchObject({ A3: { v: date(2028, 1, 30) }, A4: { v: date(2028, 2, 29) } });
    expect(fill({ A1: { v: date(2025, 6, 15) + 0.25, s: DATE }, A2: { v: date(2026, 6, 15) + 0.25, s: DATE } }, "A1:A2", "A1:A3").A3).toEqual({ v: date(2027, 6, 15) + 0.25, s: DATE });
    // Feb 29 and Mar 1 share no day of the month, so the gap repeats in days.
    expect(fill({ A1: { v: date(2024, 2, 29), s: DATE }, A2: { v: date(2025, 3, 1), s: DATE } }, "A1:A2", "A1:A3").A3).toEqual({ v: date(2025, 3, 1) + 366, s: DATE });
    expect(fill({ A1: { v: date(2025, 6, 15), s: DATE }, A2: { v: date(2026, 6, 15), s: DATE } }, "A1:A2", "A1:A3").A3).toEqual({ v: date(2027, 6, 15), s: DATE });
  });

  it("extends a least-squares trend and keeps each cell's own style", () => {
    const cells = fill({ A1: { v: 1, s: { bold: true } }, A2: { v: 2 }, A3: { v: 4 } }, "A1:A3", "A1:A6");
    expect(cells.A4).toEqual({ v: 5.33333333333333, s: { bold: true } });
    expect(cells.A5).toEqual({ v: 6.83333333333333 });
    expect(cells.A6).toEqual({ v: 8.33333333333333 });
    expect(fill({ A1: { v: 0.1 }, A2: { v: 0.2 } }, "A1:A2", "A1:A3").A3).toEqual({ v: 0.3 });
  });

  it("cycles month and weekday names in steps, matching the case", () => {
    expect(fill({ A1: { v: "MONDAY" }, A2: { v: "Wednesday" } }, "A1:A2", "A1:A4")).toMatchObject({ A3: { v: "Friday" }, A4: { v: "Sunday" } });
    expect(fill({ A1: { v: "sat" } }, "A1", "A1:A3")).toMatchObject({ A2: { v: "sun" }, A3: { v: "mon" } });
    expect(fill({ A1: { v: "Jan" }, A2: { v: "jan" } }, "A1:A2", "A1:A3").A3).toEqual({ v: "feb" });
    expect(fill({ A1: { v: "March" }, A2: { v: "Mon" } }, "A1:A2", "A1:A4")).toMatchObject({ A3: { v: "March" }, A4: { v: "Mon" } });
  });

  it("counts quarters and numbered text, padding zeros and stopping at zero", () => {
    expect(fill({ A1: { v: "Qtr 4" } }, "A1", "A1:A3")).toMatchObject({ A2: { v: "Qtr 1" }, A3: { v: "Qtr 2" } });
    expect(fill({ A1: { v: " quarter 2" } }, "A1", "A1:A2").A2).toEqual({ v: "quarter 3" });
    expect(fill({ A1: { v: "ID-007" }, A2: { v: "ID-009" } }, "A1:A2", "A1:A4")).toMatchObject({ A3: { v: "ID-011" }, A4: { v: "ID-013" } });
    expect(fill({ A1: { v: "Lot 3" }, A2: { v: "Lot 1" } }, "A1:A2", "A1:A5")).toMatchObject({ A3: { v: "Lot 0" }, A4: { v: "Lot 0" } });
    expect(fill({ A1: { v: "Box 1" }, A2: { v: "Crate 2" } }, "A1:A2", "A1:A4")).toMatchObject({ A3: { v: "Box 1" }, A4: { v: "Crate 2" } });
  });

  it("repeats mixed values, blanks, and formulas with shifted references", () => {
    expect(fill({ A1: { v: 1 }, A2: { v: "x" } }, "A1:A2", "A1:A4")).toMatchObject({ A3: { v: 1 }, A4: { v: "x" } });
    expect(fill({ A1: { v: true } }, "A1", "A1:A2").A2).toEqual({ v: true });
    const gaps = fill({ A1: { v: 1 }, A3: { v: 3 } }, "A1:A3", "A1:A6");
    expect([gaps.A4, gaps.A5, gaps.A6]).toEqual([{ v: 1 }, undefined, { v: 3 }]);
    expect(fill({ B1: { f: "A1+$A$1" }, B2: { v: 5 } }, "B1:B2", "B1:B5")).toMatchObject({ B3: { f: "A3+$A$1" }, B4: { v: 5 }, B5: { f: "A5+$A$1" } });
    expect(fill({ B1: { s: { bold: true } } }, "B1", "B1:B2").B2).toEqual({ s: { bold: true } });
  });

  it("fills right, left, and up line by line, and ignores a target that does not grow", () => {
    const right = fill({ A1: { v: 1 }, B1: { v: 2 }, A2: { v: "Mon" } }, "A1:B2", "A1:D2");
    expect([right.C1, right.D1, right.C2, right.D2]).toEqual([{ v: 3 }, { v: 4 }, { v: "Mon" }, undefined]);
    expect(fill({ C1: { v: 5 }, D1: { v: 6 } }, "C1:D1", "A1:D1")).toMatchObject({ B1: { v: 4 }, A1: { v: 3 } });
    expect(fill({ A3: { f: "B3" } }, "A3", "A1:A3")).toMatchObject({ A2: { f: "B2" }, A1: { f: "B1" } });
    expect(fill({ C1: { f: "D1" } }, "C1", "A1:C1")).toMatchObject({ B1: { f: "C1" }, A1: { f: "B1" } });
    const same = book({ A1: { v: 1 } });
    expect(fillRange(same, "s1", R("A1"), R("A1"))).toBe(same);
  });
});

describe("fill from edge", () => {
  it("copies the first row down and the first column right, shifting formulas", () => {
    const start = book({ A1: { v: 1 }, B1: { f: "A1*2" }, A2: { v: 9 }, C1: { s: { bold: true } } });
    expect(fillFromEdge(start, "s1", R("A1:C3"), "down").sheets[0].cells).toEqual({
      A1: { v: 1 }, B1: { f: "A1*2" }, C1: { s: { bold: true } },
      A2: { v: 1 }, B2: { f: "A2*2" }, C2: { s: { bold: true } },
      A3: { v: 1 }, B3: { f: "A3*2" }, C3: { s: { bold: true } },
    });
    expect(fillFromEdge(start, "s1", R("A1:C2"), "right").sheets[0].cells).toEqual({
      A1: { v: 1 }, B1: { v: 1 }, C1: { v: 1 },
      A2: { v: 9 }, B2: { v: 9 }, C2: { v: 9 },
    });
  });
});
