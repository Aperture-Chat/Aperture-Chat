import { describe, expect, it } from "vitest";
import { MAX_SHEET_COLS, MAX_SHEET_ROWS } from "../address";
import { formulaReferenceSpans, formulaReferences, invalidateSheetInFormula, renameSheetInFormula, rewriteReferences, shiftFormula } from "./references";

describe("reference spans", () => {
  it("finds cells, ranges, whole columns, and whole rows with their absolute parts", () => {
    expect(formulaReferences("=SUM($A1:B$2, 'My Data'!C:$D, 3:$5) + E7 + F")).toEqual([
      { sheet: null, kind: "range", r1: 0, c1: 0, r2: 1, c2: 1, abs: { r1: false, c1: true, r2: true, c2: false } },
      { sheet: "My Data", kind: "cols", r1: 0, c1: 2, r2: MAX_SHEET_ROWS - 1, c2: 3, abs: { r1: false, c1: false, r2: false, c2: true } },
      { sheet: null, kind: "rows", r1: 2, c1: 0, r2: 4, c2: MAX_SHEET_COLS - 1, abs: { r1: false, c1: false, r2: true, c2: false } },
      { sheet: null, kind: "cell", r1: 6, c1: 4, r2: 6, c2: 4, abs: { r1: false, c1: false, r2: false, c2: false } },
    ]);
    expect(formulaReferenceSpans("A1 + Data!B2:C3")).toEqual([
      { start: 0, end: 2, ref: expect.objectContaining({ kind: "cell" }) },
      { start: 5, end: 15, ref: expect.objectContaining({ kind: "range", sheet: "Data" }) },
    ]);
    expect(formulaReferences('"unclosed')).toEqual([]);
    expect(formulaReferenceSpans('"unclosed')).toEqual([]);
  });

  it("keeps the author's sheet prefix when the sheet stays the same", () => {
    expect(rewriteReferences("'data'!a1+data!B2", (ref) => ({ ...ref, r1: ref.r1 + 1, r2: ref.r2 + 1 }))).toBe("'data'!A2+data!B3");
    expect(rewriteReferences("Data!A1", (ref) => ({ ...ref, sheet: "Q1 Plan" }))).toBe("'Q1 Plan'!A1");
    expect(rewriteReferences("A1+B2", (ref) => (ref.c1 === 0 ? null : undefined))).toBe("#REF!+B2");
    expect(rewriteReferences("$C:$D+2:3", (ref) => ({ ...ref }))).toBe("$C:$D+2:3");
    expect(rewriteReferences('"bad', () => null)).toBe('"bad');
  });

  it("shifts whole rows and columns along their own axis only and drops references pushed off the sheet", () => {
    expect(shiftFormula("SUM(A:B)+SUM(2:3)", 4, 1)).toBe("SUM(B:C)+SUM(6:7)");
    expect(shiftFormula("SUM($A:B)+SUM($2:3)", 1, 1)).toBe("SUM($A:C)+SUM($2:4)");
    expect(shiftFormula("A1", 0, 0)).toBe("A1");
    expect(shiftFormula(`A${MAX_SHEET_ROWS}`, 1, 0)).toBe("#REF!");
    expect(shiftFormula("IV1", 0, 1)).toBe("#REF!");
    expect(shiftFormula("A1:B2", 0, -1)).toBe("#REF!");
    expect(shiftFormula("$A$1+A$1", 5, 0)).toBe("$A$1+A$1");
  });

  it("renames and invalidates only references naming that sheet", () => {
    expect(renameSheetInFormula("plan!A1+A1+Other!A1", "Plan", "Budget")).toBe("Budget!A1+A1+Other!A1");
    expect(invalidateSheetInFormula("SUM(Old!A1:B2)+old!C:C+A1", "OLD")).toBe("SUM(#REF!)+#REF!+A1");
  });
});
