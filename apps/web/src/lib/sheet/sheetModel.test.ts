import { describe, expect, it } from "vitest";
import { columnIndex, columnLabel, formatRangeRef, parseCellKey, parseRangeRef, quoteSheetName, splitSheetQualifiedRef } from "./address";
import {
  MAX_WORKBOOK_CELLS,
  blankWorkbook,
  contentLooksLikeWorkbook,
  parseWorkbook,
  serializeWorkbook,
  sheetNameProblem,
  tableNameProblem,
  uniqueSheetName,
} from "./sheetModel";

describe("A1 addressing", () => {
  it("converts column labels both ways, including past Z", () => {
    expect([0, 25, 26, 51, 255].map(columnLabel)).toEqual(["A", "Z", "AA", "AZ", "IV"]);
    expect(["A", "Z", "AA", "iv"].map(columnIndex)).toEqual([0, 25, 26, 255]);
    expect(columnIndex("A1")).toBe(-1);
  });

  it("parses cells, ranges, whole columns, and whole rows", () => {
    expect(parseCellKey("$B$12")).toEqual({ row: 11, col: 1 });
    expect(parseCellKey("IW1")).toBeNull();
    expect(parseRangeRef("C5:A1")).toEqual({ r1: 0, c1: 0, r2: 4, c2: 2 });
    expect(formatRangeRef(parseRangeRef("B:D")!)).toBe("B:D");
    expect(formatRangeRef(parseRangeRef("3:2")!)).toBe("2:3");
    expect(parseRangeRef("A1:B2:C3")).toBeNull();
  });

  it("quotes sheet names only when a formula needs it", () => {
    expect(quoteSheetName("Sales")).toBe("Sales");
    expect(quoteSheetName("Q1 Sales")).toBe("'Q1 Sales'");
    expect(quoteSheetName("A1")).toBe("'A1'");
    expect(quoteSheetName("Bob's")).toBe("'Bob''s'");
    expect(splitSheetQualifiedRef("'Bob''s'!A1:B2")).toEqual({ sheet: "Bob's", ref: "A1:B2" });
  });
});

describe("parseWorkbook", () => {
  it("round-trips a blank workbook to canonical, key-sorted JSON", () => {
    const text = serializeWorkbook(blankWorkbook());
    expect(text).toBe('{"schema":"aperture-sheet-v1","sheets":[{"cells":{},"id":"sheet-1","name":"Sheet1"}]}');
    expect(contentLooksLikeWorkbook(text)).toBe(true);
    const parsed = parseWorkbook(text);
    expect(parsed.ok && serializeWorkbook(parsed.workbook)).toBe(text);
  });

  it("keeps formulas without the equals sign and drops junk cells and keys", () => {
    const parsed = parseWorkbook({
      sheets: [{
        name: "Data",
        cells: {
          A1: { v: "Units", s: { bold: true, fill: "#FFAA00", script: "x" } },
          B1: { f: "=SUM(A2:A9)", v: 99 },
          C1: { v: Number.NaN },
          "$D$1": { v: 1 },
          ZZZ9: { v: 1 },
          E1: { v: "", n: "  " },
        },
        evil: "<script>",
      }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.workbook.sheets[0].cells).toEqual({
      A1: { v: "Units", s: { bold: true, fill: "#ffaa00" } },
      B1: { f: "SUM(A2:A9)" },
    });
    expect(parsed.workbook.sheets[0]).not.toHaveProperty("evil");
  });

  it("renames invalid and duplicate sheet names instead of failing", () => {
    const parsed = parseWorkbook({ sheets: [{ name: "Plan", cells: {} }, { name: "plan", cells: {} }, { name: "a/b", cells: {} }] });
    expect(parsed.ok && parsed.workbook.sheets.map((sheet) => sheet.name)).toEqual(["Plan", "plan (2)", "Sheet3"]);
    expect(parsed.ok && parsed.warnings.length).toBe(2);
  });

  it("refuses an empty workbook, a newer schema, and too many cells", () => {
    expect(parseWorkbook({ sheets: [] }).ok).toBe(false);
    expect(parseWorkbook({ schema: "aperture-sheet-v9", sheets: [{ cells: {} }] }).ok).toBe(false);
    const cells: Record<string, { v: number }> = {};
    for (let row = 1; row <= MAX_WORKBOOK_CELLS / 200 + 1; row += 1) {
      for (let col = 0; col < 200; col += 1) cells[`${columnLabel(col)}${row}`] = { v: 1 };
    }
    expect(parseWorkbook({ sheets: [{ name: "Big", cells }] }).ok).toBe(false);
  });

  it("keeps valid tables, charts, pivots, rules, and validations only", () => {
    const parsed = parseWorkbook({
      sheets: [{
        name: "Sales",
        cells: {},
        tables: [
          { id: "t1", name: "SalesTable", ref: "A1:D9", accent: 3, tone: "dark" },
          { id: "t2", name: "salestable", ref: "F1:G9" },
          { id: "t3", name: "A1", ref: "F1:G9" },
          { id: "t4", name: "OneRow", ref: "F1:G1" },
        ],
        charts: [{ id: "c1", type: "line", source: "A1:B9", at: "f2" }, { id: "c2", type: "radar", source: "A1:B9", at: "F2" }],
        pivots: [{ id: "p1", source: "'Raw Data'!A1:F90", at: "H1", rows: ["Region"], values: [{ field: "Revenue", agg: "nope" }] }],
        conditional: [
          { id: "r1", ref: "B2:B9", type: "scale", min: "#ffffff", max: "#087d8b" },
          { id: "r2", ref: "B2:B9", type: "cell", op: "between", value: 1 },
        ],
        validations: [{ id: "v1", ref: "C2:C9", kind: "list", items: ["Open", "Open", "Closed", ""] }],
      }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const sheet = parsed.workbook.sheets[0];
    expect(sheet.tables?.map((table) => [table.name, table.accent, table.tone, table.banded])).toEqual([["SalesTable", 3, "dark", true]]);
    expect(sheet.charts).toEqual([{ id: "c1", type: "line", source: "A1:B9", seriesBy: "columns", legend: "bottom", at: "F2", w: 480, h: 300 }]);
    expect(sheet.pivots?.[0]).toMatchObject({ source: "'Raw Data'!A1:F90", values: [{ field: "Revenue", agg: "sum" }], rowTotals: true });
    expect(sheet.conditional?.map((rule) => rule.id)).toEqual(["r1"]);
    expect(sheet.validations?.[0].items).toEqual(["Open", "Closed"]);
  });
});

describe("name rules", () => {
  it("follows Excel's sheet and table naming rules", () => {
    expect(sheetNameProblem("History")).toMatch(/reserved/);
    expect(sheetNameProblem("x".repeat(32))).toMatch(/31/);
    expect(sheetNameProblem("'Quoted")).toMatch(/apostrophe/);
    expect(sheetNameProblem("Budget 2027")).toBeNull();
    expect(tableNameProblem("R1C1")).toMatch(/address/);
    expect(tableNameProblem("Sales_2027")).toBeNull();
    expect(uniqueSheetName("Sheet1", [{ name: "sheet1" }])).toBe("Sheet1 (2)");
  });
});
