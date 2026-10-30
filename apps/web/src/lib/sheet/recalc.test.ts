import { describe, expect, it } from "vitest";
import { parseFormula, tokenizeFormula } from "./formula/parser";
import { isError } from "./formula/values";
import { computeWorkbook } from "./recalc";
import { parseWorkbook, type Workbook } from "./sheetModel";

function book(sheets: Record<string, Record<string, string | number | boolean>>, extra: Partial<Workbook> = {}): Workbook {
  const parsed = parseWorkbook({
    ...extra,
    sheets: Object.entries(sheets).map(([name, cells], index) => ({
      id: `sheet-${index + 1}`,
      name,
      cells: Object.fromEntries(Object.entries(cells).map(([address, input]) => [
        address,
        typeof input === "string" && input.startsWith("=") ? { f: input.slice(1) } : { v: input },
      ])),
      ...(extra.sheets?.[index] ?? {}),
    })),
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.workbook;
}

function valueAt(workbook: Workbook, address: string, sheetIndex = 0) {
  const engine = computeWorkbook(workbook);
  const match = /^([A-Z]+)(\d+)$/.exec(address)!;
  const col = match[1].split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const value = engine.value(workbook.sheets[sheetIndex].id, Number(match[2]) - 1, col);
  return isError(value) ? value.code : value;
}

describe("formula parser", () => {
  it("follows Excel precedence quirks", () => {
    const wb = book({ S: { A1: "=-2^2", A2: "=2^3^2", A3: "=1+2*3&\"x\"", A4: "=50%*4", A5: "=(1+2)*3" } });
    expect(["A1", "A2", "A3", "A4", "A5"].map((a) => valueAt(wb, a))).toEqual([4, 64, "7x", 2, 9]);
  });

  it("reads sheet-qualified, absolute, whole-column, and whole-row references", () => {
    const tokens = tokenizeFormula("SUM('Q1 Data'!$A$1:B2)+Sheet2!C:C-1:1");
    expect(tokens.filter((t) => t.t === "ref" || t.t === "colref" || t.t === "rowref").map((t) => t.t)).toEqual(["ref", "ref", "colref", "colref", "rowref", "rowref"]);
    expect(parseFormula("SUM(A1:").ok).toBe(false);
    expect(parseFormula("_xlfn.XLOOKUP(1,A:A,B:B)").ok && (parseFormula("_xlfn.XLOOKUP(1,A:A,B:B)") as { ast: { name: string } }).ast.name).toBe("XLOOKUP");
  });

  it("treats LOG10( as a function, not cell LOG10", () => {
    const parsed = parseFormula("LOG10(100)");
    expect(parsed.ok && parsed.ast.type).toBe("call");
  });
});

describe("recalculation", () => {
  it("evaluates dependencies across sheets in any order", () => {
    const wb = book({ Summary: { A1: "=Data!B3*2" }, Data: { B1: 5, B2: "=B1+1", B3: "=SUM(B1:B2)" } });
    expect(valueAt(wb, "A1")).toBe(22);
  });

  it("reports circular references instead of looping", () => {
    const wb = book({ S: { A1: "=B1+1", B1: "=A1+1", C1: "=C1" } });
    expect(valueAt(wb, "A1")).toBe("#REF!");
    expect(valueAt(wb, "C1")).toBe("#REF!");
    expect(computeWorkbook(wb).formulaProblems().some((p) => /Circular/.test(p.error.message ?? ""))).toBe(true);
  });

  it("spills array results and blocks a spill onto typed values", () => {
    const wb = book({ S: { A1: 1, A2: 2, A3: 3, C1: "=A1:A3*10", D1: "=SUM(C1:C3)", E1: "=A1:A3", E3: "x" } });
    expect(["C1", "C2", "C3", "D1"].map((a) => valueAt(wb, a))).toEqual([10, 20, 30, 60]);
    expect(valueAt(wb, "E1")).toBe("#SPILL!");
  });

  it("sees spilled cells read before their anchor was visited", () => {
    const wb = book({ S: { A1: "=SUM(B2:B3)", B1: "=C1:C3", C1: 4, C2: 5, C3: 6 } });
    expect(valueAt(wb, "A1")).toBe(11);
  });

  it("propagates errors and divides by zero like Excel", () => {
    const wb = book({ S: { A1: "=1/0", A2: "=A1+1", A3: "=IFERROR(A2,\"none\")", A4: "=NOPE(1)", A5: "=\"a\"+1" } });
    expect(["A1", "A2", "A3", "A4", "A5"].map((a) => valueAt(wb, a))).toEqual(["#DIV/0!", "#DIV/0!", "none", "#NAME?", "#VALUE!"]);
  });

  it("resolves defined names and table references", () => {
    const parsed = parseWorkbook({
      names: [{ name: "Rates", ref: "S!B2:B3" }],
      sheets: [{
        id: "s1",
        name: "S",
        cells: { A1: { v: "Item" }, B1: { v: "Cost" }, A2: { v: "x" }, B2: { v: 2 }, A3: { v: "y" }, B3: { v: 3 }, D1: { f: "SUM(Rates)" }, D2: { f: "SUM(Costs[Cost])" }, C2: { f: "Costs[@Cost]*10" } },
        tables: [{ id: "t", name: "Costs", ref: "A1:B3" }],
      }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(["D1", "D2", "C2"].map((a) => valueAt(parsed.workbook, a))).toEqual([5, 5, 20]);
  });

  it("reads a table's columns without the table name from inside the table, as Excel's calculated columns do", () => {
    const parsed = parseWorkbook({
      sheets: [{
        id: "s1",
        name: "S",
        cells: {
          A1: { v: "Item" }, B1: { v: "Qty" }, C1: { v: "Unit Price" }, D1: { v: "Total" },
          A2: { v: "x" }, B2: { v: 2 }, C2: { v: 5 }, D2: { f: "[@Qty]*[@[Unit Price]]" },
          A3: { v: "y" }, B3: { v: 3 }, C3: { v: 7 }, D3: { f: "Sales[@[Qty]]*Sales[@[Unit Price]]" },
          F1: { f: "SUM(Sales[Total])" }, F2: { f: "[@Qty]" }, F3: { f: "SUM([Qty])" },
        },
        tables: [{ id: "t", name: "Sales", ref: "A1:D3" }],
      }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(["D2", "D3", "F1"].map((a) => valueAt(parsed.workbook, a))).toEqual([10, 21, 31]);
    // Outside every table a reference without a table name has nothing to read.
    expect(["F2", "F3"].map((a) => valueAt(parsed.workbook, a))).toEqual(["#REF!", "#REF!"]);
  });

  it("places pivot output at its anchor and lets formulas read it", () => {
    const parsed = parseWorkbook({
      sheets: [{
        id: "s1",
        name: "S",
        cells: {
          A1: { v: "Region" }, B1: { v: "Rep" }, C1: { v: "Sales" },
          A2: { v: "East" }, B2: { v: "Ann" }, C2: { v: 10 },
          A3: { v: "West" }, B3: { v: "Bo" }, C3: { v: 5 },
          A4: { v: "East" }, B4: { v: "Cy" }, C4: { v: 7 },
          H1: { f: "F4" },
        },
        pivots: [{ id: "p1", source: "A1:C4", at: "E1", rows: ["Region"], values: [{ field: "Sales", agg: "sum" }] }],
      }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const engine = computeWorkbook(parsed.workbook);
    const grid = [0, 1, 2, 3].map((row) => [4, 5].map((col) => engine.value("s1", row, col)));
    expect(grid).toEqual([["Region", "Sum of Sales"], ["East", 17], ["West", 5], ["Grand Total", 22]]);
    expect(engine.value("s1", 0, 7)).toBe(22);
    expect(engine.derivedSource("s1", 2, 5)).toEqual({ kind: "pivot", pivotId: "p1" });
  });
});
