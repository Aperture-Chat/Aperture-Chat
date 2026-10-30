import { describe, expect, it } from "vitest";
import { parseCellStyle, parseWorkbook, type Sheet } from "./sheetModel";

function onlySheet(raw: Record<string, unknown>): Sheet {
  const parsed = parseWorkbook({ sheets: [{ name: "S", cells: {}, ...raw }] });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.workbook.sheets[0];
}

describe("workbook gate: conditional formats", () => {
  it("keeps each rule type with its defaults and drops malformed ones", () => {
    const sheet = onlySheet({
      conditional: [
        { id: "scale", ref: "a1:a9", type: "scale", min: "#FFFFFF", mid: "#nope", max: "#000000" },
        { id: "scaleBad", ref: "A1:A9", type: "scale", min: "#ffffff" },
        { id: "bar", ref: "A1:A9", type: "bar" },
        { id: "cell", ref: "A1:A9", type: "cell", op: "gt", value: 5, value2: 9, style: { fill: "#AA0000", bold: true, color: "bad" } },
        { id: "between", ref: "A1:A9", type: "cell", op: "notBetween", value: "1", value2: "3", style: "x" },
        { id: "cellNoValue", ref: "A1:A9", type: "cell", op: "gt" },
        { id: "cellBadOp", ref: "A1:A9", type: "cell", op: "over", value: "1" },
        { id: "betweenOne", ref: "A1:A9", type: "cell", op: "between", value: "1" },
        { id: "text", ref: "A1:A9", type: "text", op: "begins", text: "Ab", style: {} },
        { id: "textEmpty", ref: "A1:A9", type: "text", op: "begins", text: "" },
        { id: "top", ref: "A1:A9", type: "top", count: 5000, percent: true },
        { id: "bottom", ref: "A1:A9", type: "bottom", count: "3" },
        ...["duplicate", "unique", "above", "below", "blank", "notBlank"].map((type) => ({ id: type, ref: "A1:A9", type, style: { color: "#123ABC" } })),
        { id: "formula", ref: "A1:A9", type: "formula", formula: " =$A1>0 " },
        { id: "formulaEmpty", ref: "A1:A9", type: "formula", formula: "=" },
        { id: "mystery", ref: "A1:A9", type: "mystery" },
        { id: "bad id!", ref: "A1:A9", type: "bar" },
        { id: "noRef", ref: "nope", type: "bar" },
        { id: "bar", ref: "B1", type: "bar", color: "#111111" },
      ],
    });
    expect(sheet.conditional).toEqual([
      { id: "scale", ref: "A1:A9", type: "scale", min: "#ffffff", max: "#000000" },
      { id: "bar", ref: "A1:A9", type: "bar", color: "#087d8b" },
      { id: "cell", ref: "A1:A9", type: "cell", op: "gt", value: "5", style: { fill: "#aa0000", bold: true } },
      { id: "between", ref: "A1:A9", type: "cell", op: "notBetween", value: "1", value2: "3", style: { fill: "#f8d7da" } },
      { id: "text", ref: "A1:A9", type: "text", op: "begins", text: "Ab", style: { fill: "#f8d7da" } },
      { id: "top", ref: "A1:A9", type: "top", count: 1000, percent: true, style: { fill: "#f8d7da" } },
      { id: "bottom", ref: "A1:A9", type: "bottom", count: 10, style: { fill: "#f8d7da" } },
      ...["duplicate", "unique", "above", "below", "blank", "notBlank"].map((type) => ({ id: type, ref: "A1:A9", type, style: { color: "#123abc" } })),
      // The "=" is stripped before trimming, so a padded one stays.
      { id: "formula", ref: "A1:A9", type: "formula", formula: "$A1>0", style: { fill: "#f8d7da" } },
    ]);
  });
});

describe("workbook gate: validations, filters, pivots, charts, tables", () => {
  it("keeps list and comparison validations", () => {
    const sheet = onlySheet({
      validations: [
        { id: "v1", ref: "A1:A9", kind: "list", source: "Lists!$A$1:$A$5", items: ["x"], strict: false, message: "  Pick one  " },
        { id: "v2", ref: "A1:A9", kind: "list", items: [" a ", 1, null, "a"] },
        { id: "v3", ref: "A1:A9", kind: "list", items: [] },
        { id: "v4", ref: "A1:A9", kind: "whole", value: 1, value2: 10 },
        { id: "v5", ref: "A1:A9", kind: "decimal", op: "gt", value: "0.5", value2: "9", message: " " },
        { id: "v6", ref: "A1:A9", kind: "date", op: "between", value: "2027-01-01" },
        { id: "v7", ref: "A1:A9", kind: "textLength", op: "lte" },
        { id: "v8", ref: "A1:A9", kind: "color" },
        { id: "v9", ref: "", kind: "list", items: ["a"] },
      ],
    });
    expect(sheet.validations).toEqual([
      { id: "v1", ref: "A1:A9", kind: "list", source: "Lists!A1:A5", strict: false, message: "Pick one" },
      { id: "v2", ref: "A1:A9", kind: "list", items: ["a", "1", "null"], strict: true },
      { id: "v4", ref: "A1:A9", kind: "whole", op: "between", value: "1", value2: "10", strict: true },
      { id: "v5", ref: "A1:A9", kind: "decimal", op: "gt", value: "0.5", strict: true },
    ]);
  });

  it("keeps filter criteria for real columns and a sort", () => {
    const sheet = onlySheet({
      filter: {
        ref: "a1:c9",
        criteria: { b: { values: ["x", 2, null], condition: { op: "contains", value: "y" } }, C: { condition: { op: "gt", value: 4 } }, D: { condition: { op: "nope", value: 1 } }, "1": { values: ["x"] }, E: "x" },
        sort: { col: "c", desc: true },
      },
    });
    expect(sheet.filter).toEqual({
      ref: "A1:C9",
      criteria: { B: { values: ["x", "2", "null"], condition: { op: "contains", value: "y" } }, C: { condition: { op: "gt", value: "4" } } },
      sort: { col: "C", desc: true },
    });
    expect(onlySheet({ filter: { ref: "A1:B2", criteria: "x", sort: { col: "1" } } }).filter).toEqual({ ref: "A1:B2", criteria: {} });
    expect(onlySheet({ filter: { ref: "bad" } }).filter).toBeUndefined();
  });

  it("keeps pivot fields, values, and filters", () => {
    const sheet = onlySheet({
      pivots: [
        {
          id: "p1",
          source: "A1:D9",
          at: "$f$1",
          name: "  ",
          rows: ["Region", "", 3, " Team "],
          columns: "Quarter",
          values: [{ field: "Sales", agg: "max", label: " Top " }, { field: " " }, "Sales", { field: "Units" }],
          filters: [{ field: "Region", include: ["East", 2, "x".repeat(300)] }, { field: "Team" }, { include: [] }],
          rowTotals: false,
          columnTotals: "no",
        },
        { id: "p2", source: "A1:D9" },
      ],
    });
    expect(sheet.pivots).toEqual([
      {
        id: "p1",
        name: "PivotTable",
        source: "A1:D9",
        at: "F1",
        rows: ["Region", "Team"],
        columns: [],
        values: [{ field: "Sales", agg: "max", label: "Top" }, { field: "Units", agg: "sum" }],
        filters: [{ field: "Region", include: ["East", "x".repeat(255)] }],
        rowTotals: false,
        columnTotals: true,
      },
    ]);
  });

  it("keeps charts with clamped sizes and optional titles", () => {
    const sheet = onlySheet({
      charts: [
        { id: "c1", type: "pie", source: "'My Data'!A1:B4", at: "c3", title: "  Mix  ", seriesBy: "rows", stacked: true, legend: "none", showValues: true, xTitle: " x ", yTitle: "", w: 5000, h: 10 },
        { id: "c2", type: "line", source: "Plain!A1:B4", at: "C3", stacked: "yes" },
        { id: "c3", type: "line", source: "A1:B4" },
        { type: "line", source: "A1:B4", at: "A1" },
      ],
    });
    expect(sheet.charts).toEqual([
      { id: "c1", type: "pie", title: "Mix", source: "'My Data'!A1:B4", seriesBy: "rows", stacked: true, legend: "none", showValues: true, xTitle: "x", at: "C3", w: 1600, h: 140 },
      { id: "c2", type: "line", source: "Plain!A1:B4", seriesBy: "columns", legend: "bottom", at: "C3", w: 480, h: 300 },
    ]);
  });

  it("keeps tables with their style defaults and unique names across sheets", () => {
    const parsed = parseWorkbook({
      sheets: [
        { name: "A", cells: {}, tables: [{ id: "bad id", name: " Sales ", ref: "A1:B3", accent: 9.4, tone: "neon", banded: false, totals: true, filterButtons: false, firstColumn: true }] },
        { name: "B", cells: {}, tables: [{ name: "SALES", ref: "A1:B3" }, { name: "Other", ref: "A1:B3", firstColumn: "yes" }] },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.workbook.sheets.map((sheet) => sheet.tables)).toEqual([
      [{ id: "Sales", name: "Sales", ref: "A1:B3", accent: 6, tone: "medium", banded: false, totals: true, filterButtons: false, firstColumn: true }],
      [{ id: "Other", name: "Other", ref: "A1:B3", accent: 1, tone: "medium", banded: true, totals: false, filterButtons: true }],
    ]);
  });
});

describe("workbook gate: sheets and cells", () => {
  it("reads cell literals, notes, styles, sizes, merges, and freeze panes", () => {
    const sheet = onlySheet({
      id: "keep-me",
      color: "#ABCDEF",
      hidden: true,
      gridlines: false,
      cells: { a1: { v: true, n: " note " }, B1: { v: Infinity }, C1: { v: "x".repeat(40_000) }, D1: { f: "  ", v: "kept" }, E1: { v: {} }, F1: { s: { size: 100 } }, A0: { v: 1 } },
      cols: { a: { w: 5, hidden: true }, IW: { w: 50 }, B: { s: { bold: true } }, C: {} },
      rows: { "1": { h: 5000 }, "0": { h: 30 }, "20001": { h: 30 }, "2": { hidden: false } },
      merges: ["a1:b2", "A1:B2", "C3", "bad", "D1:E1"],
      freeze: { rows: 200, cols: -1 },
    });
    expect(sheet).toEqual({
      id: "keep-me",
      name: "S",
      color: "#abcdef",
      hidden: undefined,
      cells: { A1: { v: true, n: "note" }, C1: { v: "x".repeat(32_767) }, D1: { v: "kept" }, F1: { s: { size: 72 } } },
      cols: { A: { w: 24, hidden: true }, B: { s: { bold: true } } },
      rows: { "1": { h: 1000 } },
      merges: ["A1:B2", "D1:E1"],
      freeze: { rows: 100, cols: 0 },
      gridlines: false,
    });
  });

  it("gives duplicate sheet ids fresh ones and keeps one sheet visible", () => {
    const parsed = parseWorkbook(JSON.stringify({ sheets: [{ id: "x", name: "A", cells: {}, hidden: true }, { id: "x", name: "B", cells: {}, hidden: true }, "junk", { name: "", cells: {} }] }));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.workbook.sheets.map((sheet) => [sheet.id, sheet.name, sheet.hidden])).toEqual([["x", "A", true], ["sheet-1", "B", true], ["sheet-4", "Sheet4", undefined]]);
    const allHidden = parseWorkbook({ sheets: [{ name: "A", cells: {}, hidden: true }, { name: "B", cells: {}, hidden: true }] });
    expect(allHidden.ok && allHidden.workbook.sheets.map((sheet) => sheet.hidden)).toEqual([undefined, true]);
    expect(parseWorkbook("{nope")).toEqual({ ok: false, error: "The workbook is not valid JSON." });
    expect(parseWorkbook([1])).toEqual({ ok: false, error: "The workbook is not an object." });
    expect(parseWorkbook({ sheets: ["junk"] })).toEqual({ ok: false, error: "A workbook needs at least one sheet." });
  });

  it("keeps only the first sheets and defined names that do not clash with tables", () => {
    const sheets = Array.from({ length: 42 }, (_, n) => ({ name: `S${n}`, cells: {}, ...(n === 0 ? { tables: [{ name: "Rates", ref: "A1:A2" }] } : {}) }));
    const parsed = parseWorkbook({ sheets, names: [{ name: "Rates", ref: "S0!A1" }, { name: "Tax", ref: "S0!$B$2" }, { name: "tax", ref: "S0!B3" }, { name: "1x", ref: "A1" }, { name: "Bad", ref: "nope" }] });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.workbook.sheets).toHaveLength(40);
    expect(parsed.warnings).toEqual(["Only the first 40 sheets were kept."]);
    expect(parsed.workbook.names).toEqual([{ name: "Tax", ref: "S0!B2" }]);
    const plain = parseWorkbook({ sheets: [{ cells: {} }], names: [] });
    expect(plain.ok && "names" in plain.workbook).toBe(false);
  });

  it("parses cell styles field by field", () => {
    expect(parseCellStyle({
      bold: false, italic: true, underline: 1, strike: true, font: "Arial Narrow", size: 11.6, color: "#ABCDEF", fill: "#zzzzzz",
      align: "center", valign: "middle", wrap: true, indent: 0, format: "General",
      border: { top: { style: "thin", color: "#FF0000" }, right: { style: "zig" }, bottom: "x", left: { style: "double" } },
    })).toEqual({ bold: false, italic: true, strike: true, font: "Arial Narrow", size: 12, color: "#abcdef", align: "center", valign: "middle", wrap: true, border: { top: { style: "thin", color: "#ff0000" }, left: { style: "double" } } });
    expect(parseCellStyle({ font: "<b>", format: "0.00\u0000", indent: 3, border: {} })).toEqual({ indent: 3, format: "0.00" });
    expect(parseCellStyle({ format: "x".repeat(256) })).toBeUndefined();
    expect(parseCellStyle("bold")).toBeUndefined();
  });
});
