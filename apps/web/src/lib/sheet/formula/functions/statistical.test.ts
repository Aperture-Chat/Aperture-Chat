import { describe, expect, it } from "vitest";
import { MAX_SHEET_ROWS } from "../../address";
import { calc, recalculate } from "./testWorkbook";

const data = { A1: 2, A2: 4, A3: 4, A4: 4, A5: 5, A6: 5, A7: 7, A8: 9 };
const pairs = { B1: 1, B2: 2, B3: 3, B4: 4, B5: 5, C1: 2, C2: 4, C3: 5, C4: 4, C5: 5 };

const near = (formula: string, expected: number, cells: Record<string, string | number | boolean> = data, digits = 9) => {
  const result = calc(formula, cells);
  expect(typeof result, `${formula} -> ${JSON.stringify(result)}`).toBe("number");
  expect(result as number).toBeCloseTo(expected, digits);
};

const results = (formulas: string[], cells: Record<string, string | number | boolean> = data) => formulas.map((formula) => calc(formula, cells));

describe("averages and counts", () => {
  it("AVERAGE, MEDIAN, MODE, MAX, and MIN over a range", () => {
    expect(results(["=AVERAGE(A1:A8)", "=MEDIAN(A1:A8)", "=MODE(A1:A8)", "=MODE.SNGL(A1:A8)", "=MAX(A1:A8)", "=MIN(A1:A8)"])).toEqual([5, 4.5, 4, 4, 9, 2]);
    expect(results(["=AVERAGE(D1:D3)", "=MAX(D1:D3)", "=MIN(D1:D3)", "=MODE(1,2,3)", "=MEDIAN(D1)"], { D1: "x" })).toEqual(["#DIV/0!", 0, 0, "#N/A", "#NUM!"]);
  });

  it("the A variants count text as 0 and TRUE as 1", () => {
    const cells = { A1: 10, A2: "x", A3: true };
    near("=AVERAGEA(A1:A3)", 11 / 3, cells);
    expect(results(["=MAXA(B1:B2)", "=MINA(C1:C2)", "=AVERAGEA(D1:D3)", "=AVERAGEA(C2)", '=AVERAGEA({1,"x"})', '=MAXA("x")'], { B1: -1, B2: true, C1: 5, C2: "x" })).toEqual([1, 0, "#DIV/0!", 0, 0.5, "#VALUE!"]);
  });

  it("COUNT counts numbers; COUNTA counts anything not empty; COUNTBLANK counts blanks", () => {
    const cells = { A1: 1, A2: "a", A4: "=1/0", A5: true };
    expect(results(['=COUNT(A1:A5,"1",TRUE,"x")', "=COUNTA(A1:A5)", "=COUNTBLANK(A1:A5)", '=COUNTA(1,"a")', "=COUNT(1,)", "=COUNTA(1,)", "=COUNTA(A3)", "=COUNT(A3)"], cells)).toEqual([3, 4, 1, 2, 2, 2, 0, 0]);
    expect(calc("=COUNTBLANK(A:A)", cells)).toBe(MAX_SHEET_ROWS - 4);
  });

  it("COUNTIF and COUNTIFS, including blanks below the data in a whole column", () => {
    const cells = { A1: "East", A2: "West", A3: "east", A5: 12, B1: 5, B2: 9, B3: 1, B5: 3 };
    expect(results(['=COUNTIF(A:A,"<>")', '=COUNTIF(A1:A5,"east")', '=COUNTIF(B1:B5,">=5")', '=COUNTIF(A1:A5,"")', '=COUNTIF(A1:A5,"<>East")'], cells)).toEqual([4, 2, 2, 1, 3]);
    expect(calc('=COUNTIF(A:A,"")', cells)).toBe(MAX_SHEET_ROWS - 4);
    expect(results(['=COUNTIFS(A1:A5,"east",B1:B5,">1")', '=COUNTIFS(A1:A5,"*",B1:B5,"<10")', '=COUNTIFS(A1:A5,"east",B1:B4,">1")'], cells)).toEqual([1, 3, "#VALUE!"]);
  });

  it("criteria ranges: single error cells are data, arrays and rows work, and odd pairs fail", () => {
    expect(results(['=COUNTIF(A1,"<>")', "=COUNTIF(A2,0)", "=COUNTIF(A3,FALSE)", "=COUNTIF({1,2,2},2)", '=COUNTIF(Nope!A1:A3,"x")', '=COUNTIFS(A1:A3,"<>",B1:B3)'], { A1: "=NA()", A2: 0, A3: false }))
      .toEqual([1, 1, 1, 2, "#REF!", "#VALUE!"]);
  });

  it("counts blanks below the data, one row or many columns", () => {
    expect(results(['=COUNTIF(A1:A3,"")', '=COUNTIF(A:B,"")'], { A1: 1, A2: 2, B1: 3 })).toEqual([1, MAX_SHEET_ROWS * 2 - 3]);
  });

  it("lines up ranges that were trimmed differently on two sheets", () => {
    const read = recalculate({ Sheet1: { A1: "x", A2: "x", A3: "y", A4: "x", B1: '=COUNTIFS(A1:A4,"x",Other!A1:A4,"")' }, Other: { A1: "filled" } });
    expect(read("B1")).toBe(2);
  });

  it("SUMIF resizes sum_range to the criteria's full shape, even a whole column", () => {
    expect(results(['=SUMIF(A1:A2,"",B1)', '=SUMIF(A:A,"x",B1)', '=SUMIF(A1:B2,">0",C1)'], { A2: "x", A3: "x", B1: 5, B2: 6, B3: 7, C1: 1, C2: 2, D1: 3, D2: 4 }))
      .toEqual([5, 13, 7]);
  });

  it("AVERAGEIF(S), MAXIFS, and MINIFS", () => {
    const cells = { A1: "East", A2: "West", A3: "East", A4: "East", B1: 10, B2: 20, B3: 30, B4: "n/a", C1: 1, C2: 1, C3: 2, C4: 2 };
    expect(results(['=AVERAGEIF(A1:A4,"East",B1:B4)', '=AVERAGEIF(B1:B4,">15")', '=AVERAGEIF(A1:A4,"North",B1:B4)'], cells)).toEqual([20, 25, "#DIV/0!"]);
    expect(results(['=AVERAGEIFS(B1:B4,A1:A4,"East",C1:C4,2)', '=MAXIFS(B1:B4,A1:A4,"East")', '=MINIFS(B1:B4,A1:A4,"East",C1:C4,">1")', '=MAXIFS(B1:B4,A1:A4,"North")'], cells))
      .toEqual([30, 30, 30, 0]);
  });
});

describe("spread", () => {
  it("variance and standard deviation, sample and population", () => {
    near("=STDEV.P(A1:A8)", 2);
    near("=STDEVP(A1:A8)", 2);
    near("=VAR.P(A1:A8)", 4);
    near("=VARP(A1:A8)", 4);
    near("=STDEV(A1:A8)", Math.sqrt(32 / 7));
    near("=STDEV.S(A1:A8)", Math.sqrt(32 / 7));
    near("=VAR(A1:A8)", 32 / 7);
    near("=VAR.S(A1:A8)", 32 / 7);
    expect(results(["=STDEV(5)", "=VAR.P(D1)"])).toEqual(["#DIV/0!", "#DIV/0!"]);
  });

  it("AVEDEV, DEVSQ, GEOMEAN, HARMEAN, and STANDARDIZE", () => {
    near("=AVEDEV(A1:A8)", 1.5);
    near("=DEVSQ(A1:A8)", 32);
    near("=GEOMEAN(4,9)", 6);
    near("=HARMEAN(1,2,4)", 12 / 7);
    near("=STANDARDIZE(7,5,2)", 1);
    expect(results(["=GEOMEAN(4,-1)", "=HARMEAN(0,1)", "=STANDARDIZE(1,1,0)"])).toEqual(["#NUM!", "#NUM!", "#NUM!"]);
  });
});

describe("ranks and percentiles", () => {
  it("LARGE, SMALL, and RANK", () => {
    expect(results(["=LARGE(A1:A8,2)", "=SMALL(A1:A8,3)", "=LARGE(A1:A8,9)", "=SMALL(A1:A8,0)"])).toEqual([7, 4, "#NUM!", "#NUM!"]);
    expect(results(["=RANK(5,A1:A8)", "=RANK.EQ(4,A1:A8,1)", "=RANK.AVG(4,A1:A8,1)", "=RANK.AVG(5,A1:A8)", "=RANK(6,A1:A8)"])).toEqual([3, 2, 3, 3.5, "#N/A"]);
  });

  it("LARGE lifts over an array of k", () => {
    const read = recalculate({ Sheet1: { ...data, C1: "=LARGE(A1:A8,{1;2;3})" } });
    expect(read("C1")).toEqual([[9], [7], [5]]);
  });

  it("PERCENTILE and QUARTILE, inclusive and exclusive", () => {
    expect(results(["=PERCENTILE(A1:A8,0.25)", "=PERCENTILE.EXC(A1:A8,0.5)", "=PERCENTILE.EXC(A1:A8,0.9)", "=PERCENTILE.INC(A1:A8,1.5)"])).toEqual([4, 4.5, "#NUM!", "#NUM!"]);
    near("=PERCENTILE.INC(A1:A8,0.9)", 7.6);
    expect(results(["=QUARTILE(A1:A8,1)", "=QUARTILE.INC(A1:A8,3)", "=QUARTILE.EXC(A1:A8,1)", "=QUARTILE.EXC(A1:A8,3)", "=QUARTILE(A1:A8,5)", "=QUARTILE.EXC(A1:A8,0)"]))
      .toEqual([4, 5.5, 4, 6.5, "#NUM!", "#NUM!"]);
  });

  it("PERCENTRANK.INC interpolates and truncates to the significance", () => {
    expect(results(["=PERCENTRANK.INC(A1:A8,5)", "=PERCENTRANK.INC(A1:A8,6)", "=PERCENTRANK.INC(A1:A8,2)", "=PERCENTRANK.INC(A1:A8,9)", "=PERCENTRANK.INC(A1:A8,5,1)", "=PERCENTRANK.INC(A1:A8,10)"]))
      .toEqual([0.571, 0.785, 0, 1, 0.5, "#N/A"]);
  });
});

describe("edges", () => {
  it("MODE of zeros, COUNT of a typed error, and COUNTBLANK over two columns", () => {
    expect(results(["=MODE(0,0,1)", "=COUNT(1/0)", "=COUNTBLANK(A1:B3)"], { A1: 1, B2: "x" })).toEqual([0, 0, 4]);
  });

  it("PERCENTILE.EXC at its exact bounds and QUARTILE quarters", () => {
    expect(results(["=PERCENTILE.EXC({1,2,3,4},0.2)", "=PERCENTILE.EXC({1,2,3,4},0.8)", "=PERCENTILE.EXC({1,2,3,4},0.19)", "=PERCENTILE.EXC({1,2,3,4},0.81)", "=PERCENTILE.EXC(D1,0.5)"])).toEqual([1, 4, "#NUM!", "#NUM!", "#NUM!"]);
    expect(results(["=QUARTILE(A1:A8,-1)", "=QUARTILE.EXC(A1:A8,2)", "=QUARTILE.INC(A1:A8,4.5)", "=QUARTILE.INC(A1:A8,0)", "=QUARTILE.EXC(A1:A8,4)"])).toEqual(["#NUM!", 4.5, 9, 2, "#NUM!"]);
  });

  it("PERCENTRANK.INC outside the data, with significance 0, and with ties", () => {
    expect(results(["=PERCENTRANK.INC(A1:A8,5,0)", "=PERCENTRANK.INC(A1:A8,1)", "=PERCENTRANK.INC(D1:D2,1)", "=PERCENTRANK.INC({5},5)", "=PERCENTRANK.INC({1,2,2,3},2)", "=PERCENTRANK.INC({1,2,2,3},2.5)"]))
      .toEqual(["#NUM!", "#N/A", "#N/A", 0, 0.333, 0.833]);
  });

  it("CORREL skips a pair when either side is not a number", () => {
    near('=CORREL({1,2,3,4},{2,"x",6,8})', 1);
  });
});

describe("correlation and regression", () => {
  it("pairs values position by position", () => {
    near("=CORREL(B1:B5,C1:C5)", 6 / Math.sqrt(60), pairs);
    near("=PEARSON(B1:B5,C1:C5)", 6 / Math.sqrt(60), pairs);
    near("=RSQ(C1:C5,B1:B5)", 0.6, pairs);
    near("=SLOPE(C1:C5,B1:B5)", 0.6, pairs);
    near("=INTERCEPT(C1:C5,B1:B5)", 2.2, pairs);
    near("=FORECAST(6,C1:C5,B1:B5)", 5.8, pairs);
    near("=FORECAST.LINEAR(6,C1:C5,B1:B5)", 5.8, pairs);
    near("=COVARIANCE.P(B1:B5,C1:C5)", 1.2, pairs);
    near("=COVARIANCE.S(B1:B5,C1:C5)", 1.5, pairs);
    expect(results(["=CORREL(B1:B5,C1:C4)", "=SLOPE({1,1},{2,2})"], pairs)).toEqual(["#N/A", "#DIV/0!"]);
  });
});

describe("normal distribution", () => {
  it("matches Excel's documented values", () => {
    near("=NORM.S.DIST(1,TRUE)", 0.841344746068543, {}, 13);
    near("=NORM.S.DIST(0,FALSE)", 0.398942280401433, {}, 13);
    near("=NORM.S.DIST(-6,TRUE)", 9.86587645037698e-10, {}, 18);
    near("=NORM.DIST(42,40,1.5,TRUE)", 0.908788780274132, {}, 13);
    near("=NORM.DIST(42,40,1.5,FALSE)", 0.109340049783996, {}, 13);
    near("=NORM.S.INV(0.975)", 1.95996398454005, {}, 12);
    near("=NORM.S.INV(0.908789)", 1.3333347, {}, 6);
    near("=NORM.INV(0.908789,40,1.5)", 42.000002, {}, 5);
    near("=NORM.S.INV(0.001)", -3.09023230616781, {}, 11);
    expect(results(["=NORM.S.INV(0)", "=NORM.INV(0.5,0,0)", "=NORM.DIST(1,0,-1,TRUE)"])).toEqual(["#NUM!", "#NUM!", "#NUM!"]);
  });
});

describe("FREQUENCY", () => {
  it("counts values into bins and spills one more row than there are bins", () => {
    const read = recalculate({ Sheet1: { ...data, C1: "=FREQUENCY(A1:A8,{4;6})", D1: "=FREQUENCY(A1:A8,{6;4})" } });
    expect(read("C1")).toEqual([[4], [2], [2]]);
    expect(read("D1")).toEqual([[2], [4], [2]]);
  });
});

describe("errors and argument counts", () => {
  it("propagates errors and rejects bad argument counts", () => {
    expect(results(["=AVERAGE(A1:A2)", "=COUNTIF(A1:A2)", "=LARGE(A1:A2)", "=NORM.S.DIST(1)", "=MEDIAN()"], { A1: 1, A2: "=1/0" })).toEqual(["#DIV/0!", "#VALUE!", "#VALUE!", "#VALUE!", "#VALUE!"]);
  });
});
