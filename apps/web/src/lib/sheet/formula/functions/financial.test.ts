import { describe, expect, it } from "vitest";
import { calc } from "./testWorkbook";

const results = (formulas: string[], cells: Record<string, string | number | boolean> = {}) => formulas.map((formula) => calc(formula, cells));

const near = (formula: string, expected: number, digits = 6, cells: Record<string, string | number | boolean> = {}) => {
  const result = calc(formula, cells);
  expect(typeof result, `${formula} -> ${JSON.stringify(result)}`).toBe("number");
  expect(result as number).toBeCloseTo(expected, digits);
};

describe("annuities", () => {
  it("PMT matches a 30-year mortgage payment", () => {
    near("=PMT(0.05/12,360,200000)", -1073.64324602, 7);
    near("=PMT(0.05/12,360,200000,0,1)", -1073.64324602 / (1 + 0.05 / 12), 7);
    expect(calc("=PMT(0,10,1000)")).toBe(-100);
  });

  it("FV, PV, and NPER match Excel's examples", () => {
    near("=FV(0.06/12,10,-200,-500,1)", 2581.40337406, 7);
    near("=PV(0.08/12,12*20,500,,0)", -59777.1458511, 6);
    near("=NPER(0.12/12,-100,-1000,10000,1)", 59.6738656742, 8);
    expect(results(["=FV(0,10,-100)", "=PV(0,10,-100)", "=NPER(0,-100,1000)", "=NPER(0.1,-100,2000)"])).toEqual([1000, 1000, 10, "#NUM!"]);
  });

  it("IPMT and PPMT split a payment into interest and principal", () => {
    near("=IPMT(0.1/12,1,36,8000)", -66.6666666667, 8);
    near("=PPMT(0.1/12,1,24,2000)", -75.6231860084, 8);
    near("=IPMT(0.1/12,1,36,8000)+PPMT(0.1/12,1,36,8000)", -258.137497551, 8);
    expect(results(["=IPMT(0.1/12,0,36,8000)", "=IPMT(0.1/12,1,36,8000,0,1)"])).toEqual(["#NUM!", 0]);
  });

  it("RATE solves for the interest rate and reports a failure to converge", () => {
    near("=RATE(48,-200,8000)", 0.00770147248820165, 12);
    near("=RATE(48,-200,8000,0,0,0.5)", 0.00770147248820165, 12);
    expect(calc("=RATE(10,100,100)")).toBe("#NUM!");
  });

  it("CUMIPMT and CUMPRINC sum a range of periods", () => {
    near("=CUMIPMT(0.09/12,360,125000,13,24,0)", -11135.2321307, 6);
    near("=CUMIPMT(0.09/12,360,125000,1,1,0)", -937.5, 9);
    near("=CUMPRINC(0.09/12,360,125000,13,24,0)", -934.107123427, 6);
    near("=CUMPRINC(0.09/12,360,125000,1,1,0)", -68.2782711809, 8);
    expect(results(["=CUMIPMT(0.09/12,360,125000,0,1,0)", "=CUMIPMT(0.09/12,360,125000,1,1,2)", "=CUMPRINC(0,360,125000,1,1,0)"])).toEqual(["#NUM!", "#NUM!", "#NUM!"]);
  });
});

describe("cash flows", () => {
  it("NPV discounts from the first period and skips text in references", () => {
    near("=NPV(0.1,-1000,300,400,500)", -1000 / 1.1 + 300 / 1.21 + 400 / 1.331 + 500 / 1.4641, 9);
    near("=NPV(0.1,A1:A3)", 100 / 1.1 + 200 / 1.21, 9, { A1: 100, A2: "note", A3: 200 });
  });

  it("IRR finds the rate where the NPV is zero", () => {
    near("=IRR({-100,30,40,50})", 0.0889633947, 9);
    near("=IRR(A1:A4,0.2)", 0.08896, 5, { A1: -100, A2: 30, A3: 40, A4: 50 });
    expect(results(["=IRR({1,2})", "=IRR({-1,-2})"])).toEqual(["#NUM!", "#NUM!"]);
  });

  it("XNPV and XIRR use actual dates", () => {
    const flows = { A1: -10000, A2: 2750, A3: 4250, A4: 3250, A5: 2750, B1: 39448, B2: 39508, B3: 39751, B4: 39859, B5: 39904 };
    near("=XNPV(0.09,A1:A5,B1:B5)", 2086.64760203, 6, flows);
    near("=XIRR(A1:A5,B1:B5)", 0.373362533519, 9, flows);
    near("=XIRR(A1:A5,B1:B5,0.5)", 0.373362533519, 9, flows);
    expect(results(["=XNPV(0.09,A1:A5,B1:B4)", "=XIRR(A2:A5,B2:B5)"], flows)).toEqual(["#NUM!", "#NUM!"]);
  });
});

describe("depreciation and rates", () => {
  it("SLN, SYD, and DDB", () => {
    expect(results(["=SLN(30000,7500,10)", "=DDB(2400,300,10,1)", "=DDB(2400,300,10,1,1.5)", "=DDB(2400,300,120,1)"])).toEqual([2250, 480, 360, 40]);
    near("=SYD(30000,7500,10,1)", 4090.90909091, 7);
    near("=DDB(2400,300,10,10)", 22.1225472, 6);
    expect(results(["=SYD(30000,7500,10,11)", "=DDB(2400,300,10,11)", "=SLN(1,1,0)"])).toEqual(["#NUM!", "#NUM!", "#DIV/0!"]);
  });

  it("EFFECT and NOMINAL convert between rates", () => {
    near("=EFFECT(0.0525,4)", 0.0535426673, 9);
    near("=NOMINAL(0.053543,4)", 0.0525003199, 9);
    expect(results(["=EFFECT(0,4)", "=NOMINAL(0.05,0)"])).toEqual(["#NUM!", "#NUM!"]);
  });
});

describe("argument edges", () => {
  it("NPER with no interest, and with a payment smaller than the interest", () => {
    expect(results(["=NPER(0,0,100)", "=NPER(0,-100,1000,-500)"])).toEqual(["#NUM!", 5]);
    near("=NPER(0.01,-100,1000)", 10.5886444594, 9);
    near("=NPER(0.1,100,1000)", -7.27254089734, 9);
  });

  it("IPMT and PPMT for the last period and for payments at the start of each period", () => {
    near("=IPMT(0.1/12,36,36,8000)", -2.13336774835, 9);
    near("=IPMT(0.1/12,2,36,8000,0,1)", -64.5332989183, 9);
    near("=PPMT(0.1/12,2,36,8000,0,1)", -191.470830884, 9);
    near("=IPMT(0.1/12,3,36,8000,0,1)", -62.9377086609, 9);
    expect(calc("=IPMT(0.1/12,37,36,8000)")).toBe("#NUM!");
  });

  it("IRR can be negative", () => {
    near("=IRR({-100,50,40})", -0.0699264745632, 10);
  });

  it("depreciation validates its inputs", () => {
    near("=SYD(30000,7500,10,10)", 409.090909091, 8);
    expect(results(["=SYD(10,0,1,1)", "=DDB(1000,0,1,1)", "=DDB(2400,300,10,1,1)"])).toEqual([10, 1000, 240]);
    expect(results(["=SYD(1,0,0,1)", "=SYD(30000,7500,10,0)"])).toEqual(["#NUM!", "#NUM!"]);
    expect(results(["=DDB(-1,0,10,1)", "=DDB(1,-1,10,1)", "=DDB(1,0,0,1)", "=DDB(1,0,10,0)", "=DDB(1,0,10,1,0)"])).toEqual(["#NUM!", "#NUM!", "#NUM!", "#NUM!", "#NUM!"]);
    expect(results(["=DDB(2400,0,10,1)", "=DDB(0,0,10,1)", "=DDB(1000,100,2,1)", "=DDB(1000,100,2,2)"])).toEqual([480, 0, 900, 0]);
  });

  it("CUMIPMT checks its periods and payment type", () => {
    expect(results(["=CUMIPMT(0.09/12,0,125000,1,1,0)", "=CUMIPMT(0.09/12,360,0,1,1,0)", "=CUMIPMT(0.09/12,360,125000,2,1,0)", "=CUMIPMT(0.09/12,360,125000,1,361,0)", "=CUMIPMT(0.09/12,360,125000,1,1,1)"]))
      .toEqual(["#NUM!", "#NUM!", "#NUM!", "#NUM!", 0]);
    near("=CUMIPMT(0.09/12,360,125000,360,360,0)", -7.48718316016, 9);
    expect(results(["=CUMIPMT(0.1,1,100,1,1,0)", "=CUMIPMT(0.1,2,1,1,1,0)"])).toEqual([-10, -0.1]);
  });
});

describe("errors and argument counts", () => {
  it("propagates errors and rejects bad argument counts", () => {
    expect(results(["=PMT(1/0,1,1)", "=NPV(0.1,A1)", "=PMT(1,2)", "=IRR()"], { A1: "=NA()" })).toEqual(["#DIV/0!", "#N/A", "#VALUE!", "#VALUE!"]);
  });
});
