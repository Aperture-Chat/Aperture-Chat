import { describe, expect, it } from "vitest";
import { cellKey, MAX_SHEET_ROWS } from "./address";
import { parseFormula } from "./formula/parser";
import { isError, type Scalar } from "./formula/values";
import { computeWorkbook, mayReturnArray, resolveStructuredSpec, tableAt, tableRanges, WorkbookEngine } from "./recalc";
import { SHEET_SCHEMA_VERSION, type Sheet, type SheetCell, type Workbook } from "./sheetModel";

function cellsOf(rows: Record<string, string | number>): Record<string, SheetCell> {
  return Object.fromEntries(Object.entries(rows).map(([address, input]) => [address, typeof input === "string" && input.startsWith("=") ? { f: input.slice(1) } : { v: input }]));
}

function book(sheets: Partial<Sheet>[], extra: Partial<Workbook> = {}): Workbook {
  return { schema: SHEET_SCHEMA_VERSION, sheets: sheets.map((sheet, index) => ({ id: `s${index + 1}`, name: `S${index + 1}`, cells: {}, ...sheet })), ...extra };
}

const shown = (value: Scalar) => (isError(value) ? `${value.code} ${value.message ?? ""}`.trim() : value);
const grid = (engine: WorkbookEngine, sheetId: string, rows: number, cols: number) =>
  Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => shown(engine.value(sheetId, row, col))));

describe("which formulas may spill", () => {
  it("knows ranges, arrays, names, array functions, and pass-through wrappers", () => {
    const may = (formula: string) => {
      const parsed = parseFormula(formula);
      if (!parsed.ok) throw new Error(parsed.error);
      return mayReturnArray(parsed.ast);
    };
    expect(["A1:B2", "{1,2}", "Rate", "T[Col]", "SEQUENCE(3)", "IF(A1,B1:B3,0)", "-A1:A3", "1+A1:A2", "A1:A2*2", "IFERROR(SORT(A1:A3),0)"].map(may)).toEqual(Array(10).fill(true));
    expect(["A1", "SUM(A1:A3)", "IF(A1,1,2)", "1+2", '"x"', "-1", "INDEX(1,1)"].map(may)).toEqual(Array(7).fill(false));
  });

  it("knows a scalar function given a range lifts over it, as Excel's dynamic arrays do", () => {
    const may = (formula: string) => {
      const parsed = parseFormula(formula);
      if (!parsed.ok) throw new Error(parsed.error);
      return mayReturnArray(parsed.ast);
    };
    expect(["LEN(A1:A3)", "ROUND(A1:A3*1.1,2)", "UPPER(T[Col])", "ISNUMBER(A1:A3)", "LEFT(A2:A9,3)", "ABS(-A1:A3)"].map(may)).toEqual(Array(6).fill(true));
    expect(["LEN(A1)", "ROUND(1.5,0)", "SUM(LEN(A1:A3))", "UPPER(\"a\")", "NOPE(A1:A3)"].map(may)).toEqual(Array(5).fill(false));
  });

  it("lets cells read a lifted function's spill whatever order they are computed in", () => {
    const engine = computeWorkbook(book([{ cells: cellsOf({ A1: "ab", A2: "abc", A3: "abcd", D1: "=C2*10", C1: "=LEN(A1:A3)" }) }]));
    expect(engine.value("s1", 0, 3)).toBe(30);
    expect(grid(engine, "s1", 3, 3).map((row) => row[2])).toEqual([2, 3, 4]);
  });
});

describe("spilled results", () => {
  it("spills, blocks on other spills, and stops at the sheet edge", () => {
    const engine = computeWorkbook(book([{ cells: cellsOf({ A1: "=SEQUENCE(2,2)", D1: "=SEQUENCE(3)", E2: "x", E1: "=SEQUENCE(1,2)", B4: "=SEQUENCE(2)", A5: "=SEQUENCE(1,2)", A7: "=SEQUENCE(1,1)", A8: "=FILTER(A1:A2,A1:A2>9)", [cellKey(MAX_SHEET_ROWS - 1, 0)]: "=SEQUENCE(2)" }) }]));
    expect(grid(engine, "s1", 8, 6)).toEqual([
      [1, 2, null, 1, 1, 2],
      [3, 4, null, 2, "x", null],
      [null, null, null, 3, null, null],
      [null, 1, null, null, null, null],
      ["#SPILL! The result would overlap other results at B5.", 2, null, null, null, null],
      [null, null, null, null, null, null],
      [1, null, null, null, null, null],
      ["#CALC! No rows match the filter.", null, null, null, null, null],
    ]);
    expect(shown(engine.value("s1", MAX_SHEET_ROWS - 1, 0))).toBe("#SPILL! The result runs past the edge of the sheet.");
    expect(engine.spillRange("s1", 0, 0)).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(engine.spillRange("s1", 6, 0)).toBeNull();
    expect(engine.derivedSource("s1", 1, 1)).toEqual({ kind: "spill", row: 0, col: 0 });
    expect(engine.derivedSource("s1", 0, 0)).toBeNull();
    expect(engine.derivedSource("nope", 0, 0)).toBeNull();
    expect(engine.usedRange("s1")).toEqual({ r1: 0, c1: 0, r2: MAX_SHEET_ROWS - 1, c2: 5 });
    expect(engine.usedRange("nope")).toBeNull();
  });

  it("reports which spills were blocked and why", () => {
    const engine = computeWorkbook(book([{ cells: cellsOf({ A1: "=SEQUENCE(1,3)", C1: 5, A3: "=SEQUENCE(2)", A4: "=SEQUENCE(1,1)" }) }]));
    expect(shown(engine.value("s1", 0, 0))).toBe("#SPILL! The result needs 1×3 cells, but C1 is not empty.");
    expect(grid(engine, "s1", 5, 1).map((line) => line[0])).toEqual(["#SPILL! The result needs 1×3 cells, but C1 is not empty.", null, "#SPILL! The result needs 2×1 cells, but A4 is not empty.", 1, null]);
    expect(engine.formulaProblems().map((problem) => [problem.address, problem.error.code])).toEqual([["A1", "#SPILL!"], ["A3", "#SPILL!"]]);
  });

  it("lets an empty-looking cell read a spill whose anchor was not visited yet", () => {
    const engine = new WorkbookEngine(book([{ cells: cellsOf({ B1: "=SEQUENCE(3)", A1: "=B3*10" }) }]));
    expect(engine.value("s1", 0, 0)).toBe(30);
    expect(engine.value("s1", 2, 1)).toBe(3);
  });
});

describe("pivot results in the engine", () => {
  const source = cellsOf({ A1: "Region", B1: "Sales", A2: "East", B2: 5, A3: "West", B3: 7 });
  source.B2 = { v: 5, s: { format: "$#,##0" } };

  it("places output, formats value cells, and lets formulas read it", () => {
    const engine = computeWorkbook(book([{ cells: { ...source, H1: { f: "E3*2" } }, pivots: [{ id: "p1", name: "P", source: "A1:B3", at: "D1", rows: ["Region"], columns: [], values: [{ field: "Sales", agg: "sum" }], filters: [], rowTotals: true, columnTotals: true }] }]));
    expect(grid(engine, "s1", 4, 5).map((line) => line.slice(3))).toEqual([["Region", "Sum of Sales"], ["East", 5], ["West", 7], ["Grand Total", 12]]);
    expect(engine.value("s1", 0, 7)).toBe(14);
    expect(engine.pivotResult("s1", "p1").range).toEqual({ r1: 0, c1: 3, r2: 3, c2: 4 });
    expect([engine.pivotCellFormat("s1", 0, 4), engine.pivotCellFormat("s1", 1, 4), engine.pivotCellFormat("s1", 1, 3), engine.pivotCellFormat("s1", 9, 9)]).toEqual([undefined, "$#,##0", undefined, undefined]);
    expect(engine.derivedSource("s1", 2, 3)).toEqual({ kind: "pivot", pivotId: "p1" });
    expect(engine.pivotResult("s1", "nope")).toEqual({ range: null, output: null });
  });

  it("takes a value format from the source column and reads another sheet", () => {
    const data = { name: "Data", cells: cellsOf({ A1: "Region", B1: "Sales", A2: "East", B2: 5 }), cols: { B: { s: { format: "0.0" } } } };
    const engine = computeWorkbook(book([{ pivots: [{ id: "p1", name: "P", source: "Data!A1:B2", at: "A1", rows: ["Region"], columns: [], values: [{ field: "Sales", agg: "max" }], filters: [], rowTotals: false, columnTotals: true }] }, data]));
    expect(grid(engine, "s1", 2, 2)).toEqual([["Region", "Max of Sales"], ["East", 5]]);
    expect(engine.pivotCellFormat("s1", 1, 1)).toBe("0.0");
  });

  it("reports blocked, invalid, and missing sources", () => {
    const pivot = { id: "p1", name: "P", rows: ["Region"], columns: [], values: [{ field: "Sales", agg: "sum" as const }], filters: [], rowTotals: true, columnTotals: true };
    const blocked = computeWorkbook(book([{ cells: { ...source, E2: { v: "x" } }, pivots: [{ ...pivot, source: "A1:B3", at: "D1" }] }]));
    expect(blocked.pivotResult("s1", "p1")).toMatchObject({ range: { r1: 0, c1: 3, r2: 0, c2: 3 }, output: { code: "#SPILL!", message: "The pivot table needs empty cells for its results." } });
    expect(blocked.value("s1", 0, 3)).toBeNull();
    const bad = computeWorkbook(book([{ cells: source, pivots: [{ ...pivot, source: "nope", at: "D1" }, { ...pivot, id: "p2", source: "Gone!A1:B3", at: "H1" }] }]));
    expect(bad.pivotResult("s1", "p1").output).toMatchObject({ code: "#REF!", message: "The pivot table's source range is not valid." });
    expect(bad.pivotResult("s1", "p2").output).toMatchObject({ code: "#REF!", message: 'There is no sheet named "Gone".' });
  });
});

describe("tableAt", () => {
  const tables = [{ id: "t", name: "Sales", ref: "B2:D6" }, { id: "u", name: "Costs", ref: "F2:G3" }] as never;

  it("finds the table a cell sits in, corners included", () => {
    for (const [row, col] of [[1, 1], [1, 3], [5, 1], [5, 3]]) expect(tableAt(tables, row, col)?.name).toBe("Sales");
    expect(tableAt(tables, 2, 6)?.name).toBe("Costs");
  });

  it("finds nothing just outside a table or on a sheet without tables", () => {
    for (const [row, col] of [[0, 1], [6, 1], [1, 0], [1, 4]]) expect(tableAt(tables, row, col)).toBeNull();
    expect(tableAt(undefined, 1, 1)).toBeNull();
  });
});

describe("structured references", () => {
  const table = { id: "t", name: "Sales", ref: "B2:D6", accent: 1 as const, tone: "medium" as const, banded: true, totals: true, filterButtons: true };
  const ranges = tableRanges(table)!;
  const headers = ["Region", "Qty", "Price"];
  const resolve = (spec: string, row = 3) => {
    const result = resolveStructuredSpec(spec, ranges, headers, { row, col: 0 });
    return isError(result) ? `${result.code} ${result.message}` : result;
  };

  it("resolves sections, columns, spans, and this-row references", () => {
    expect(resolve("Qty")).toEqual({ r1: 2, r2: 4, c1: 2, c2: 2 });
    expect(resolve("[#All],[Price]")).toEqual({ r1: 1, r2: 5, c1: 3, c2: 3 });
    expect(resolve("[#Headers]")).toEqual({ r1: 1, r2: 1, c1: 1, c2: 3 });
    expect(resolve("[#Totals],[Qty],[Region]")).toEqual({ r1: 5, r2: 5, c1: 1, c2: 2 });
    expect(resolve("[#Data]")).toEqual({ r1: 2, r2: 4, c1: 1, c2: 3 });
    expect(resolve("[Price]:[Region]")).toEqual({ r1: 2, r2: 4, c1: 1, c2: 3 });
    expect(resolve("@Qty")).toEqual({ r1: 3, r2: 3, c1: 2, c2: 2 });
    expect(resolve("[#This Row],[price]")).toEqual({ r1: 3, r2: 3, c1: 3, c2: 3 });
    expect(resolve("[@]")).toEqual({ r1: 3, r2: 3, c1: 1, c2: 3 });
    // Excel spells "this row" @Qty, @[Qty], or [@[Qty]] (Sales[@[Qty]] reaches the resolver as "@[Qty]").
    expect(resolve("@[Qty]")).toEqual({ r1: 3, r2: 3, c1: 2, c2: 2 });
    expect(resolve(" @ [Price] ")).toEqual({ r1: 3, r2: 3, c1: 3, c2: 3 });
    expect(resolve("[@[Qty]]")).toEqual({ r1: 3, r2: 3, c1: 2, c2: 2 });
    expect(resolve("@[Qty]:[Price]")).toEqual({ r1: 3, r2: 3, c1: 2, c2: 3 });
    expect(resolve("[]")).toEqual({ r1: 2, r2: 4, c1: 1, c2: 3 });
  });

  it("reports missing columns, a missing totals row, and this-row outside the table", () => {
    expect(resolve("Nope")).toBe('#REF! The table has no column named "Nope".');
    expect(resolve("[Qty]:[Nope]")).toBe("#REF! The table has no column with that name.");
    expect(resolve("@Qty", 9)).toBe("#VALUE! [@Column] only works on a row inside the table.");
    const noTotals = tableRanges({ ...table, totals: false })!;
    expect(resolveStructuredSpec("[#Totals]", noTotals, headers, { row: 0, col: 0 })).toMatchObject({ code: "#REF!", message: "This table has no totals row." });
    expect(resolveStructuredSpec("[Pr'[ice]", noTotals, ["Pr[ice"], { row: 0, col: 0 })).toEqual({ r1: 2, r2: 5, c1: 1, c2: 1 });
  });
});
