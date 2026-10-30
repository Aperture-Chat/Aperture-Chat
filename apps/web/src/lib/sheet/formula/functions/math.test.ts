import { afterEach, describe, expect, it, vi } from "vitest";
import { calc, recalculate } from "./testWorkbook";

const near = (formula: string, expected: number, cells = {}, digits = 9) => {
  const result = calc(formula, cells);
  expect(typeof result, `${formula} -> ${JSON.stringify(result)}`).toBe("number");
  expect(result as number).toBeCloseTo(expected, digits);
};

const results = (formulas: string[], cells = {}) => formulas.map((formula) => calc(formula, cells));

describe("SUM and the conditional sums", () => {
  const sales = {
    A1: "Region", B1: "Date", C1: "Amount",
    A2: "East", B2: "=DATE(2027,1,15)", C2: 100,
    A3: "West", B3: "=DATE(2027,2,1)", C3: 250,
    A4: "East", B4: "=DATE(2027,2,20)", C4: 75,
    A5: "east", B5: "=DATE(2027,3,5)", C5: 30,
    A6: "Eastern", B6: "=DATE(2027,3,9)", C6: "n/a",
  };

  it("skips text and booleans in references but coerces typed arguments", () => {
    expect(calc('=SUM(A1:A3,"2",TRUE)', { A1: 1, A2: "x", A3: true })).toBe(4);
    expect(calc('=SUM("x")')).toBe("#VALUE!");
  });

  it("propagates errors from references", () => {
    expect(calc("=SUM(A1:A3)", { A1: 1, A2: "=1/0", A3: 3 })).toBe("#DIV/0!");
  });

  it("SUMIF matches operators and wildcards, and resizes sum_range from its top-left", () => {
    expect(calc('=SUMIF(C2:C6,">=75")', sales)).toBe(425);
    expect(calc('=SUMIF(A2:A6,"east",C2:C6)', sales)).toBe(205);
    expect(calc('=SUMIF(A2:A6,"East*",C2)', sales)).toBe(205);
    expect(calc('=SUMIF(A:A,"West",C:C)', sales)).toBe(250);
  });

  it("SUMIFS combines criteria, including >= date criteria", () => {
    expect(calc('=SUMIFS(C2:C6,A2:A6,"East",B2:B6,">="&DATE(2027,2,1))', sales)).toBe(105);
    expect(calc('=SUMIFS(C:C,A:A,"East",B:B,">=2/1/2027")', sales)).toBe(105);
    expect(calc('=SUMIFS(C2:C6,A2:A5,"East")', sales)).toBe("#VALUE!");
  });

  it("SUMPRODUCT multiplies matching arrays and treats non-numbers as zero", () => {
    expect(calc("=SUMPRODUCT({1,2,3},{4,5,6})")).toBe(32);
    expect(calc('=SUMPRODUCT((A2:A6="East")*C2:C6)', sales)).toBe("#VALUE!");
    expect(calc('=SUMPRODUCT(--(A2:A5="East"),C2:C5)', sales)).toBe(205);
    expect(calc("=SUMPRODUCT({1,2},{1,2,3})")).toBe("#VALUE!");
    expect(calc('=SUMPRODUCT({1,"x",3},{1,1,1})')).toBe(4);
  });

  it("SUMSQ and PRODUCT aggregate numbers", () => {
    expect(results(["=SUMSQ(3,4)", "=PRODUCT(2,3,4)", "=PRODUCT(A1:A2)"], { A1: "x" })).toEqual([25, 24, 0]);
  });
});

describe("rounding", () => {
  it("rounds half away from zero without binary drift", () => {
    expect(results(["=ROUND(2.675,2)", "=ROUND(-2.5,0)", "=ROUND(1234.567,-2)", "=ROUND(1.005,2)"])).toEqual([2.68, -3, 1200, 1.01]);
    expect(results(["=ROUNDUP(3.2,0)", "=ROUNDUP(-3.2,0)", "=ROUNDDOWN(-3.7,0)", "=ROUNDUP(0.1+0.2,1)"])).toEqual([4, -4, -3, 0.3]);
  });

  it("MROUND, INT, TRUNC, EVEN, and ODD", () => {
    expect(results(["=MROUND(10,3)", "=MROUND(-10,-3)", "=MROUND(5,-2)", "=MROUND(5,0)"])).toEqual([9, -9, "#NUM!", 0]);
    expect(results(["=INT(-8.9)", "=TRUNC(-8.9)", "=TRUNC(3.14159,2)", "=INT(\"7.5\")"])).toEqual([-9, -8, 3.14, 7]);
    expect(results(["=EVEN(1.5)", "=EVEN(3)", "=EVEN(-1)", "=EVEN(0)"])).toEqual([2, 4, -2, 0]);
    expect(results(["=ODD(1.5)", "=ODD(2)", "=ODD(-1)", "=ODD(0)"])).toEqual([3, 3, -1, 1]);
  });

  it("CEILING and FLOOR follow the sign rules", () => {
    expect(results(["=CEILING(2.5,1)", "=CEILING(-2.5,-2)", "=CEILING(-2.5,2)", "=CEILING(2.5,-1)", "=CEILING(4,0)"])).toEqual([3, -4, -2, "#NUM!", 0]);
    expect(results(["=CEILING.MATH(-5.5,2,-1)", "=CEILING.MATH(-5.5)", "=CEILING.MATH(24.3,5)"])).toEqual([-6, -5, 25]);
    expect(results(["=FLOOR(3.7,2)", "=FLOOR(-2.5,-2)", "=FLOOR(-2.5,2)", "=FLOOR(2.5,-2)", "=FLOOR(3,0)"])).toEqual([2, -2, -4, "#NUM!", "#DIV/0!"]);
    expect(results(["=FLOOR.MATH(-5.5)", "=FLOOR.MATH(-5.5,2,-1)", "=FLOOR.MATH(24.3,5)"])).toEqual([-6, -4, 20]);
  });

  it("lifts over arrays so the result spills", () => {
    const read = recalculate({ Sheet1: { B2: 1, B3: 2.5, B4: 10, D2: "=ROUND(B2:B4*1.1,2)", E2: "=SUM(D2:D4)" } });
    expect(read("D2")).toEqual([[1.1], [2.75], [11]]);
    expect(read("E2")).toBeCloseTo(14.85, 9);
  });
});

describe("arithmetic", () => {
  it("MOD takes the sign of the divisor", () => {
    expect(results(["=MOD(3,2)", "=MOD(-3,2)", "=MOD(3,-2)", "=MOD(-3,-2)", "=MOD(1,0)"])).toEqual([1, 1, -1, -1, "#DIV/0!"]);
  });

  it("powers, roots, and logarithms report domain errors", () => {
    expect(results(["=ABS(-2)", "=SIGN(-5)", "=SQRT(16)", "=SQRT(-1)", "=POWER(2,10)", "=POWER(0,0)", "=POWER(-8,1/3)"])).toEqual([2, -1, 4, "#NUM!", 1024, "#NUM!", "#NUM!"]);
    near("=EXP(1)", Math.E);
    expect(results(["=LN(EXP(2))", "=LOG(8,2)", "=LOG(100)", "=LOG10(1000)", "=LN(0)", "=LOG(10,1)"])).toEqual([2, 3, 2, 3, "#NUM!", "#DIV/0!"]);
  });

  it("counting functions", () => {
    expect(results(["=FACT(5)", "=FACT(-1)", "=FACT(5.9)", "=COMBIN(8,2)", "=PERMUT(100,3)", "=COMBIN(2,3)"])).toEqual([120, "#NUM!", 120, 28, 970200, "#NUM!"]);
    expect(results(["=GCD(24,36)", "=GCD(A1:A3)", "=LCM(4,6)", "=LCM(3,0)", "=GCD(-2,4)", "=QUOTIENT(-10,3)", "=QUOTIENT(1,0)"], { A1: 12, A2: 18, A3: 30 }))
      .toEqual([12, 6, 12, 0, "#NUM!", -3, "#DIV/0!"]);
  });

  it("trigonometry", () => {
    near("=PI()", Math.PI);
    near("=DEGREES(PI())", 180);
    near("=RADIANS(180)", Math.PI);
    near("=SIN(PI()/2)", 1);
    near("=COS(0)", 1);
    near("=TAN(PI()/4)", 1);
    near("=ACOS(0)", Math.PI / 2);
    near("=ATAN(1)", Math.PI / 4);
    near("=ATAN2(1,1)", Math.PI / 4);
    near("=ATAN2(-1,0)", Math.PI);
    expect(results(["=ASIN(2)", "=ATAN2(0,0)"])).toEqual(["#NUM!", "#DIV/0!"]);
  });

  it("domain edges: zero, empty selections, and boundary significance", () => {
    expect(results(["=MROUND(0,3)", "=MROUND(0.4,0.5)", "=POWER(0,2)", "=POWER(5,0)", "=POWER(0,-1)", "=POWER(0,0.5)"])).toEqual([0, 0.5, 0, 1, "#DIV/0!", 0]);
    expect(results(["=LOG(10,0)", "=LOG(1)", "=LOG(8,0.5)", "=LN(-1)", "=LOG(-1)"])).toEqual(["#NUM!", 0, -3, "#NUM!", "#NUM!"]);
    near("=LOG(27,3)", 3);
    expect(results(["=CEILING(0,-1)", "=CEILING(0.5,-1)", "=CEILING(2.3,0.5)", "=FLOOR(3,1)", "=FLOOR(0,0)", "=FLOOR(0,-1)", "=FLOOR(0.5,-1)", "=FLOOR(2.7,0.5)"])).toEqual([0, "#NUM!", 2.5, 3, 0, 0, "#NUM!", 2.5]);
    expect(results(["=CEILING.MATH(5,0)", "=CEILING.MATH(0.5,1,1)", "=EVEN(0.5)", "=FACT(0)"])).toEqual([0, 1, 2, 1]);
    expect(results(["=PERMUT(0,0)", "=PERMUT(5,0)", "=PERMUT(3,3)", "=PERMUT(-1,0)", "=PERMUT(3,-1)"])).toEqual([1, 1, 6, "#NUM!", "#NUM!"]);
    expect(results(["=COMBIN(0,0)", "=COMBIN(5,0)", "=COMBIN(4,4)", "=COMBIN(-1,0)", "=COMBIN(3,-1)", "=COMBIN(10,7)"])).toEqual([1, 1, 1, "#NUM!", "#NUM!", 120]);
    expect(results(["=ROUND(1.5,400)", "=ROUND(123,-400)", "=ROUND(1E+300,100)", "=TRUNC(-1.99,1)"])).toEqual([1.5, 0, 1e300, -1.9]);
  });

  it("RANDBETWEEN covers every whole number in its range", () => {
    const spy = vi.spyOn(Math, "random");
    spy.mockReturnValue(0.99);
    expect(results(["=RANDBETWEEN(3,5)", "=RANDBETWEEN(2.5,5.5)", "=RAND()"])).toEqual([5, 5, 0.99]);
    spy.mockReturnValue(0);
    expect(calc("=RANDBETWEEN(3,5)")).toBe(3);
  });

  it("RAND and RANDBETWEEN stay in range", () => {
    const value = calc("=RAND()") as number;
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
    const whole = calc("=RANDBETWEEN(3,5)") as number;
    expect([3, 4, 5]).toContain(whole);
    expect(results(["=RANDBETWEEN(2,2)", "=RANDBETWEEN(5,1)"])).toEqual([2, "#NUM!"]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SUBTOTAL and MMULT", () => {
  const cells = { A1: 1, A2: 2, A3: 3, A4: 4, A5: 5 };

  it("SUBTOTAL dispatches on function numbers 1-11 and 101-111", () => {
    expect(results(["=SUBTOTAL(9,A1:A5)", "=SUBTOTAL(1,A1:A5)", "=SUBTOTAL(2,A1:A5)", "=SUBTOTAL(4,A1:A5)", "=SUBTOTAL(104,A1:A5)", "=SUBTOTAL(109,A1:A3,A5)", "=SUBTOTAL(6,A1:A4)"], cells))
      .toEqual([15, 3, 5, 5, 5, 11, 24]);
    near("=SUBTOTAL(7,A1:A5)", Math.sqrt(2.5), cells);
    near("=SUBTOTAL(110,A1:A5)", 2.5, cells);
    expect(results(["=SUBTOTAL(12,A1:A5)", "=SUBTOTAL(0,A1:A5)", "=SUBTOTAL(100,A1:A5)", "=SUBTOTAL(112,A1:A5)", "=SUBTOTAL(101,A1:A5)", "=SUBTOTAL(111,A1:A5)", "=SUBTOTAL(9.9,A1:A5)"], cells))
      .toEqual(["#VALUE!", "#VALUE!", "#VALUE!", "#VALUE!", 3, 2, 15]);
    expect(calc("=SUBTOTAL(9,B1)", { B1: "text" })).toBe(0);
  });

  it("MMULT multiplies matrices and checks their shapes", () => {
    expect(calc("=MMULT({1,2},{3;4})")).toBe(11);
    const read = recalculate({ Sheet1: { A1: "=MMULT({1,2;3,4},{5;6})", C1: "=MMULT({1,2},{1,2})", D1: '=MMULT({1,"x"},{1;2})' } });
    expect(read("A1")).toEqual([[17], [39]]);
    expect(read("C1")).toBe("#VALUE!");
    expect(read("D1")).toBe("#VALUE!");
  });
});

describe("argument counts", () => {
  it("reads an empty-text argument as #VALUE!, not as zero", () => {
    expect(results(['=ABS("")', '=FACT("")'])).toEqual(["#VALUE!", "#VALUE!"]);
  });

  it("rejects too few or too many arguments", () => {
    expect(results(["=ROUND(1)", "=PI(1)", "=MOD(1,2,3)", "=SUMIF(A1:A2)"])).toEqual(["#VALUE!", "#VALUE!", "#VALUE!", "#VALUE!"]);
  });
});
