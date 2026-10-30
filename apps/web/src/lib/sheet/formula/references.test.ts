import { describe, expect, it } from "vitest";
import {
  adjustFormulaForDelete,
  adjustFormulaForInsert,
  adjustFormulaForMove,
  renameSheetInFormula,
  shiftFormula,
} from "./references";

describe("formula reference rewriting", () => {
  it("shifts only the relative parts when a formula is copied", () => {
    expect(shiftFormula("SUM(A1:B2) + $C$3 + C$4 * $D5", 2, 1)).toBe("SUM(B3:C4) + $C$3 + D$4 * $D7");
    expect(shiftFormula("A1+1", -1, 0)).toBe("#REF!+1");
    expect(shiftFormula("SUM(B:B)", 5, 1)).toBe("SUM(C:C)");
  });

  it("keeps spacing, strings, and function names untouched", () => {
    expect(shiftFormula('IF( A1 > 0 , "A1 stays" , b2 )', 1, 0)).toBe('IF( A2 > 0 , "A1 stays" , B3 )');
  });

  it("moves and stretches references when rows are inserted", () => {
    expect(adjustFormulaForInsert("SUM(A2:A10)+A1+A12", "S", "S", "rows", 4, 3)).toBe("SUM(A2:A13)+A1+A15");
    expect(adjustFormulaForInsert("Data!B5+B5", "S", "Data", "rows", 0, 1)).toBe("Data!B6+B5");
    expect(adjustFormulaForInsert("SUM($B$2:$B$4)", "S", "S", "cols", 0, 2)).toBe("SUM($D$2:$D$4)");
  });

  it("shrinks ranges and invalidates deleted cells when rows are deleted", () => {
    expect(adjustFormulaForDelete("SUM(A2:A10)", "S", "S", "rows", 3, 2)).toBe("SUM(A2:A8)");
    expect(adjustFormulaForDelete("A5*2", "S", "S", "rows", 3, 4)).toBe("#REF!*2");
    expect(adjustFormulaForDelete("SUM(A4:A6)", "S", "S", "rows", 3, 3)).toBe("SUM(#REF!)");
    expect(adjustFormulaForDelete("C9", "S", "S", "rows", 3, 2)).toBe("C7");
  });

  it("follows cut-and-paste moves and sheet renames", () => {
    expect(adjustFormulaForMove("A1+B2", "S", "S", { r1: 0, c1: 0, r2: 0, c2: 0 }, 2, 2)).toBe("C3+B2");
    expect(renameSheetInFormula("'Q1 Data'!A1+Other!B2", "Q1 Data", "Summary")).toBe("Summary!A1+Other!B2");
    expect(renameSheetInFormula("Plan!A1", "Plan", "Plan 2027")).toBe("'Plan 2027'!A1");
  });
});
