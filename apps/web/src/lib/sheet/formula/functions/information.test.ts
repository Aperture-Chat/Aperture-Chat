import { describe, expect, it } from "vitest";
import { calc, recalculate } from "./testWorkbook";

const results = (formulas: string[], cells: Record<string, string | number | boolean> = {}) => formulas.map((formula) => calc(formula, cells));

describe("IS functions", () => {
  const cells = { A2: '=""', A3: 1, A4: "x", A5: true, A6: "=1/0", A7: "=NA()" };

  it("tell values apart by type without propagating errors", () => {
    expect(results(["=ISBLANK(A1)", "=ISBLANK(A2)", "=ISNUMBER(A3)", '=ISNUMBER("1")', "=ISTEXT(A4)", "=ISNONTEXT(A3)", "=ISNONTEXT(A1)", "=ISLOGICAL(A5)"], cells))
      .toEqual([true, false, true, false, true, true, true, true]);
    expect(results(["=ISERROR(A6)", "=ISERROR(A3)", "=ISERR(A6)", "=ISERR(A7)", "=ISNA(A7)", "=ISNA(A6)"], cells)).toEqual([true, false, true, false, true, false]);
  });

  it("ISEVEN and ISODD truncate and need numbers", () => {
    expect(results(["=ISEVEN(2.5)", "=ISODD(-3)", "=ISEVEN(A1)", '=ISEVEN("x")', "=ISODD(TRUE)", "=ISEVEN(1/0)"])).toEqual([true, true, true, "#VALUE!", "#VALUE!", "#DIV/0!"]);
  });

  it("ISREF looks at the argument, not its value", () => {
    expect(results(["=ISREF(A1)", "=ISREF(A1:B2)", '=ISREF("A1")', "=ISREF(1/0)"])).toEqual([true, true, false, false]);
  });

  it("lift over ranges", () => {
    expect(recalculate({ Sheet1: { ...cells, B1: "=ISNUMBER(A3:A5)" } })("B1")).toEqual([[true], [false], [false]]);
  });
});

describe("NA, ERROR.TYPE, TYPE, N, and T", () => {
  it("report on values", () => {
    expect(results(["=NA()", "=ERROR.TYPE(1/0)", "=ERROR.TYPE(NA())", "=ERROR.TYPE(1)", '=ERROR.TYPE(#NAME?)'])).toEqual(["#N/A", 2, 7, "#N/A", 5]);
    expect(results(['=TYPE(1)', '=TYPE("a")', "=TYPE(TRUE)", "=TYPE(1/0)", "=TYPE({1,2})", "=TYPE(A1)"])).toEqual([1, 2, 4, 16, 64, 1]);
    expect(results(["=N(TRUE)", '=N("a")', "=N(5)", "=N(1/0)", '=T("a")', "=T(1)", "=T(1/0)"])).toEqual([1, 0, 5, "#DIV/0!", "a", "", "#DIV/0!"]);
  });

  it("checks argument counts", () => {
    expect(results(["=NA(1)", "=ISBLANK()", "=TYPE(1,2)"])).toEqual(["#VALUE!", "#VALUE!", "#VALUE!"]);
  });
});
