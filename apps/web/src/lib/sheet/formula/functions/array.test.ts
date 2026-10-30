import { describe, expect, it } from "vitest";
import { calc, recalculate } from "./testWorkbook";

const people = {
  A1: "Name", B1: "Team", C1: "Score",
  A2: "Ana", B2: "Red", C2: 72,
  A3: "Bo", B3: "Blue", C3: 95,
  A4: "Cy", B4: "Red", C4: 88,
  A5: "Di", B5: "Blue", C5: 60,
  A6: "Ed", B6: "red", C6: 88,
};

const spill = (formula: string, cells: Record<string, string | number | boolean> = people) => recalculate({ Sheet1: { ...cells, H1: formula } })("H1");

describe("FILTER", () => {
  it("keeps the rows whose include value is TRUE and spills them", () => {
    expect(spill('=FILTER(A2:A6,B2:B6="Red")')).toEqual([["Ana"], ["Cy"], ["Ed"]]);
    expect(spill("=FILTER(A2:C6,C2:C6>80)")).toEqual([["Bo", "Blue", 95], ["Cy", "Red", 88], ["Ed", "red", 88]]);
    expect(spill("=FILTER(A1:C1,{1,0,1})")).toEqual([["Name", "Score"]]);
  });

  it("returns #CALC! when nothing matches, unless if_empty is given", () => {
    expect(spill('=FILTER(A2:A6,C2:C6>100)')).toBe("#CALC!");
    expect(spill('=FILTER(A2:A6,C2:C6>100,"none")')).toBe("none");
    expect(spill("=FILTER(A2:A6,C2:C5>1)")).toBe("#VALUE!");
    expect(spill("=FILTER(A2:A6,C2:C6/0)")).toBe("#DIV/0!");
  });

  it("feeds aggregates", () => {
    expect(calc('=SUM(FILTER(C2:C6,B2:B6="Blue"))', people)).toBe(155);
  });
});

describe("SORT, SORTBY, and UNIQUE", () => {
  it("SORT orders rows by a column, ascending or descending", () => {
    expect(spill("=SORT(C2:C6)")).toEqual([[60], [72], [88], [88], [95]]);
    expect(spill("=SORT(A2:C6,3,-1)")).toEqual([["Bo", "Blue", 95], ["Cy", "Red", 88], ["Ed", "red", 88], ["Ana", "Red", 72], ["Di", "Blue", 60]]);
    expect(spill("=SORT({3,1,2},1,1,TRUE)")).toEqual([[1, 2, 3]]);
    expect(spill('=SORT({"b";"A";"c"})')).toEqual([["A"], ["b"], ["c"]]);
    expect(spill("=SORT(A2:C6,4)")).toBe("#VALUE!");
  });

  it("SORT takes several sort columns", () => {
    expect(spill("=SORT(B2:C6,{1,2},{1,-1})")).toEqual([["Blue", 95], ["Blue", 60], ["Red", 88], ["red", 88], ["Red", 72]]);
  });

  it("SORTBY orders by other arrays", () => {
    expect(spill("=SORTBY(A2:A6,C2:C6,-1)")).toEqual([["Bo"], ["Cy"], ["Ed"], ["Ana"], ["Di"]]);
    expect(spill("=SORTBY(A2:A6,B2:B6,1,C2:C6,1)")).toEqual([["Di"], ["Bo"], ["Ana"], ["Cy"], ["Ed"]]);
    expect(spill("=SORTBY(A2:A6,C2:C5)")).toBe("#VALUE!");
  });

  it("UNIQUE drops repeats case-insensitively, by row or column, or keeps only singletons", () => {
    expect(spill("=UNIQUE(B2:B6)")).toEqual([["Red"], ["Blue"]]);
    expect(spill("=UNIQUE(C2:C6,FALSE,TRUE)")).toEqual([[72], [95], [60]]);
    expect(spill("=UNIQUE({1,2,1},TRUE)")).toEqual([[1, 2]]);
    expect(spill("=UNIQUE({1,1;2,2})")).toEqual([[1, 1], [2, 2]]);
    expect(spill("=UNIQUE({1;1},FALSE,TRUE)")).toBe("#CALC!");
  });

  it("composes: sorted unique teams", () => {
    expect(spill("=SORT(UNIQUE(B2:B6))")).toEqual([["Blue"], ["Red"]]);
  });
});

describe("generating arrays", () => {
  it("SEQUENCE fills rows then columns", () => {
    expect(spill("=SEQUENCE(3)")).toEqual([[1], [2], [3]]);
    expect(spill("=SEQUENCE(2,3,10,5)")).toEqual([[10, 15, 20], [25, 30, 35]]);
    expect(spill("=SEQUENCE(0)")).toBe("#CALC!");
  });

  it("RANDARRAY stays in bounds and can return whole numbers", () => {
    const values = (spill("=RANDARRAY(3,2,5,7,TRUE)") as number[][]).flat();
    expect(values).toHaveLength(6);
    for (const value of values) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(7);
    }
    expect(spill("=RANDARRAY(1,1,5,1)")).toBe("#VALUE!");
  });
});

describe("reshaping", () => {
  it("TRANSPOSE swaps rows and columns", () => {
    expect(spill("=TRANSPOSE({1,2,3;4,5,6})")).toEqual([[1, 4], [2, 5], [3, 6]]);
  });

  it("VSTACK and HSTACK pad with #N/A", () => {
    expect(spill("=VSTACK({1,2},{3})")).toEqual([[1, 2], [3, "#N/A"]]);
    expect(spill("=HSTACK({1;2},{3})")).toEqual([[1, 3], [2, "#N/A"]]);
    expect(spill("=VSTACK(A1:B1,A2:B2)")).toEqual([["Name", "Team"], ["Ana", "Red"]]);
  });

  it("TOCOL and TOROW flatten, optionally skipping blanks and errors", () => {
    const cells = { A1: 1, A2: 2, B1: "=1/0", B2: 4 };
    expect(spill("=TOCOL(A1:B2)", cells)).toEqual([[1], ["#DIV/0!"], [2], [4]]);
    expect(spill("=TOCOL(A1:B2,2,TRUE)", cells)).toEqual([[1], [2], [4]]);
    expect(spill("=TOROW(A1:C2,1)", cells)).toEqual([[1, "#DIV/0!", 2, 4]]);
  });

  it("TAKE and DROP keep or remove rows and columns from either end", () => {
    expect(spill("=TAKE(A2:C6,2)")).toEqual([["Ana", "Red", 72], ["Bo", "Blue", 95]]);
    expect(spill("=TAKE(A2:C6,-1,2)")).toEqual([["Ed", "red"]]);
    expect(spill("=DROP(A2:C6,3,2)")).toEqual([[60], [88]]);
    expect(spill("=DROP(A2:C6,-4)")).toEqual([["Ana", "Red", 72]]);
    expect(spill("=DROP(A2:C6,5)")).toBe("#CALC!");
  });

  it("CHOOSECOLS and CHOOSEROWS pick by position, negatives from the end", () => {
    expect(spill("=CHOOSECOLS(A2:C3,3,1)")).toEqual([[72, "Ana"], [95, "Bo"]]);
    expect(spill("=CHOOSEROWS(A2:C6,-1,1)")).toEqual([["Ed", "red", 88], ["Ana", "Red", 72]]);
    expect(spill("=CHOOSECOLS(A2:C3,4)")).toBe("#VALUE!");
  });

  it("EXPAND pads to a larger size", () => {
    expect(spill("=EXPAND({1,2},2,3)")).toEqual([[1, 2, "#N/A"], ["#N/A", "#N/A", "#N/A"]]);
    expect(spill("=EXPAND({1,2},2,,0)")).toEqual([[1, 2], [0, 0]]);
    expect(spill("=EXPAND({1,2},1,1)")).toBe("#VALUE!");
  });

  it("WRAPROWS and WRAPCOLS fold a vector", () => {
    expect(spill("=WRAPROWS({1,2,3,4,5},2)")).toEqual([[1, 2], [3, 4], [5, "#N/A"]]);
    expect(spill('=WRAPCOLS({1,2,3},2,"")')).toEqual([[1, 3], [2, ""]]);
    expect(spill("=WRAPROWS({1,2;3,4},2)")).toBe("#VALUE!");
  });
});

describe("edges", () => {
  it("one sort order applies to every sort column; an empty order is ascending; 0 is not an order", () => {
    expect(spill("=SORT(B2:C6,{1,2},-1)")).toEqual([["Red", 88], ["red", 88], ["Red", 72], ["Blue", 95], ["Blue", 60]]);
    expect(spill("=SORT(C2:C6,1,)")).toEqual([[60], [72], [88], [88], [95]]);
    expect(spill("=SORT(C2:C6,1,0)")).toBe("#VALUE!");
  });

  it("SEQUENCE sizes", () => {
    expect([spill("=SEQUENCE(1,1)"), spill("=SEQUENCE(-1)"), spill("=SEQUENCE(1,0)"), spill("=SEQUENCE(1,-1)"), spill("=SEQUENCE(2000001)"), spill("=SEQUENCE(1000,2001)")]).toEqual([1, "#VALUE!", "#CALC!", "#VALUE!", "#NUM!", "#NUM!"]);
  });

  it("TAKE and DROP with counts of 0, 1, and more than there are", () => {
    expect([spill("=TAKE(A2:C6,0)"), spill("=TAKE(A2:C6,1)"), spill("=ROWS(TAKE(A2:C6,-9))"), spill("=DROP(A2:C6,-9)"), spill("=ROWS(DROP(A2:C6,0))")]).toEqual(["#CALC!", [["Ana", "Red", 72]], 5, "#CALC!", 5]);
  });

  it("EXPAND to the same size, and WRAPROWS of a column, by 1, by 0, and by an exact multiple", () => {
    expect([spill("=EXPAND({1,2},0)"), spill("=EXPAND({1,2},1,2)"), spill("=EXPAND({1,2},2,0)")]).toEqual(["#VALUE!", [[1, 2]], "#VALUE!"]);
    expect([spill("=WRAPROWS({1;2;3},2)"), spill("=WRAPROWS({1,2},1)"), spill("=WRAPROWS({1,2},0)"), spill("=WRAPROWS({1,2,3,4},2)")]).toEqual([[[1, 2], [3, "#N/A"]], [[1], [2]], "#NUM!", [[1, 2], [3, 4]]]);
  });
});

describe("argument counts", () => {
  it("rejects too few or too many arguments", () => {
    expect([spill("=FILTER(A1:A2)"), spill("=SEQUENCE()"), spill("=TRANSPOSE({1},{2})"), spill("=TAKE({1})")]).toEqual(["#VALUE!", "#VALUE!", "#VALUE!", "#VALUE!"]);
  });
});
