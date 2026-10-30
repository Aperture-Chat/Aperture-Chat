import { describe, expect, it } from "vitest";
import { operandFormula } from "./operands";

describe("rule operands as Excel formulas", () => {
  it("keeps numbers and logicals, quotes text, and reads '=' as a formula", () => {
    expect(operandFormula(" 20 ")).toBe("20");
    expect(operandFormula("true")).toBe("TRUE");
    expect(operandFormula("East")).toBe("\"East\"");
    expect(operandFormula("say \"hi\"")).toBe("\"say \"\"hi\"\"\"");
    expect(operandFormula("")).toBe("\"\"");
    expect(operandFormula("=$B$1*xlookup(1,A:A,B:B)")).toBe("$B$1*_xlfn.XLOOKUP(1,A:A,B:B)");
  });

  it("quotes a formula Excel could not read instead of writing it", () => {
    expect(operandFormula("=SUM(")).toBe("\"=SUM(\"");
  });

  it("turns typed dates into serials only for date rules", () => {
    expect(operandFormula("2026-01-01", { dates: true })).toBe("46023");
    expect(operandFormula("2026-01-01")).toBe("\"2026-01-01\"");
    expect(operandFormula("soon", { dates: true })).toBe("\"soon\"");
  });
});
