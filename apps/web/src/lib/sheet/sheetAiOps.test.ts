import { describe, expect, it } from "vitest";
import { computeWorkbook } from "./recalc";
import { blankWorkbook, type Workbook } from "./sheetModel";
import {
  applySheetOps,
  buildSheetPrompt,
  describeChanges,
  describeSheet,
  diffWorkbooks,
  parseSheetAiReply,
  workbookPlainText,
  workbookTitleFrom,
  type SheetOp,
} from "./sheetAi";

function run(ops: SheetOp[], workbook: Workbook = blankWorkbook(), sheetId = "sheet-1") {
  return applySheetOps(workbook, sheetId, ops);
}

function seeded(): Workbook {
  return run([
    { op: "set", range: "A1", values: [["Name", "Score"], ["Ana", 3], ["Bo", 9], ["Cy", 5]] },
    { op: "addSheet", name: "Other" },
  ]).workbook;
}

describe("sheet AI operations", () => {
  it("routes every known op and warns on unknown names, including inherited object keys", () => {
    const result = run([{ op: "toString" }, { op: "constructor" }, { op: "__proto__" }]);
    expect(result.warnings).toEqual([
      'Skipped an unknown change "toString".',
      'Skipped an unknown change "constructor".',
      'Skipped an unknown change "__proto__".',
    ]);
    expect(result.applied).toBe(0);
  });

  it("fills one formula across a range, shifting relative references, and warns when a set has nothing to write", () => {
    const result = run([
      { op: "set", range: "C1:D2", formula: "A1+B1" },
      { op: "set", range: "E1:E2", value: true },
      { op: "set", range: "F1" },
    ]);
    const cells = result.workbook.sheets[0].cells;
    expect(cells.C1).toEqual({ f: "A1+B1" });
    expect(cells.D2).toEqual({ f: "B2+C2" });
    expect(cells.E2).toEqual({ v: true });
    expect(result.warnings).toEqual(["A set change had no values."]);
    expect([...result.touched.get("sheet-1")!].sort()).toEqual(["C1", "C2", "D1", "D2", "E1", "E2"]);
  });

  it("clears contents and reports a missing or invalid range", () => {
    const result = run([{ op: "clear", range: "A2:B3" }, { op: "clear" }, { op: "clear", range: "nope" }], seeded());
    expect(Object.keys(result.workbook.sheets[0].cells).sort()).toEqual(["A1", "A4", "B1", "B4"]);
    expect(result.warnings).toEqual(["A change was missing its range.", '"nope" is not a valid range.']);
    expect(result.applied).toBe(1);
  });

  it("inserts and deletes rows and columns and needs an anchor", () => {
    const result = run([
      { op: "insertRows", at: 2, count: 2 },
      { op: "deleteCols", at: "A" },
      { op: "insertCols", at: "1" },
      { op: "deleteRows" },
    ], seeded());
    const cells = result.workbook.sheets[0].cells;
    expect(cells.A1).toEqual({ v: "Score" });
    expect(cells.A4).toEqual({ v: 3 });
    expect(result.warnings).toEqual(['insertCols needs "at".', 'deleteRows needs "at".']);
  });

  it("adds, renames, colors, activates, and deletes sheets", () => {
    const result = run([
      { op: "addSheet", name: "Summary", color: "#AABBCC" },
      { op: "set", range: "A1", values: [["on summary"]] },
      { op: "addSheet", name: "Summary" },
      { op: "renameSheet", sheet: "Summary", name: "Totals" },
      { op: "renameSheet", sheet: "Totals", name: "Bad/Name" },
      { op: "tabColor", sheet: "Sheet1", color: "#00FF00" },
      { op: "addSheet", name: "Scratch" },
      { op: "deleteSheet", sheet: "Scratch" },
      { op: "activateSheet", sheet: "Sheet1" },
      { op: "activateSheet", sheet: "Missing" },
    ]);
    const [first, totals] = result.workbook.sheets;
    expect(result.workbook.sheets.map((sheet) => sheet.name)).toEqual(["Sheet1", "Totals"]);
    expect(first.color).toBe("#00ff00");
    expect(totals.color).toBe("#aabbcc");
    expect(totals.cells.A1).toEqual({ v: "on summary" });
    expect(result.activeSheetId).toBe(first.id);
    expect(result.warnings).toEqual(["Sheet names cannot contain : \\ / ? * [ or ].", 'Skipped a change for missing sheet "Missing".']);
  });

  it("merges, sizes columns and rows, freezes panes, and hides gridlines", () => {
    const result = run([
      { op: "merge", range: "A1:B1" },
      { op: "merge", range: "C1:D1" },
      { op: "unmerge", range: "C1" },
      { op: "colWidth", cols: "B", width: 150 },
      { op: "colWidth", cols: "C:D", width: 90 },
      { op: "rowHeight", rows: 2, height: 40 },
      { op: "rowHeight", rows: "3:4", height: 30 },
      { op: "freeze", rows: 99, cols: "2" },
      { op: "gridlines", show: false },
    ], seeded());
    const sheet = result.workbook.sheets[0];
    expect(sheet.merges).toEqual(["A1:B1"]);
    expect(sheet.cols).toEqual({ B: { w: 150 }, C: { w: 90 }, D: { w: 90 } });
    expect(sheet.rows).toEqual({ "2": { h: 40 }, "3": { h: 30 }, "4": { h: 30 } });
    expect(sheet.freeze).toEqual({ rows: 50, cols: 2 });
    expect(sheet.gridlines).toBe(false);
    const shown = run([{ op: "gridlines" }], result.workbook);
    expect(shown.workbook.sheets[0].gridlines).toBeUndefined();
  });

  it("adds a filter, notes, and defined names", () => {
    const result = run([
      { op: "filter", range: "A1:B4" },
      { op: "note", cell: "B2", text: "checked" },
      { op: "note", cell: "Other!A1", text: "elsewhere" },
      { op: "name", name: "Scores", ref: "Sheet1!$B$2:$B$4" },
      { op: "name", name: "scores", ref: "Sheet1!$B$2" },
      { op: "name", name: "Broken" },
    ], seeded());
    const [sheet, other] = result.workbook.sheets;
    expect(sheet.filter).toEqual({ ref: "A1:B4", criteria: {} });
    expect(sheet.cells.B2).toEqual({ v: 3, n: "checked" });
    expect(other.cells.A1).toEqual({ n: "elsewhere" });
    expect(result.workbook.names).toEqual([{ name: "scores", ref: "Sheet1!B2" }]);
  });

  it("adds conditional formats and validations and skips ones the model cannot express", () => {
    const result = run([
      { op: "conditional", range: "B2:B4", rule: { type: "bar", color: "#087d8b" } },
      { op: "conditionalFormat", range: "B2:B4", type: "cell", op2: "x" },
      { op: "validation", range: "A2:A4", items: ["Ana", "Bo"] },
      { op: "validation", range: "A2:A4", kind: "nonsense" },
    ], seeded());
    const sheet = result.workbook.sheets[0];
    expect(sheet.conditional).toEqual([{ id: "rule-1", ref: "B2:B4", type: "bar", color: "#087d8b" }]);
    expect(sheet.validations).toMatchObject([{ id: "valid-1", ref: "A2:A4", kind: "list", items: ["Ana", "Bo"] }]);
    expect(result.warnings).toEqual([
      "Skipped a conditional format the editor could not read.",
      "Skipped a data validation rule the editor could not read.",
    ]);
  });

  it("sorts by column letter or 1-based number and ignores a sort with no keys", () => {
    const byLetter = run([{ op: "sort", range: "A1:B4", by: [{ col: "B", desc: true }] }], seeded());
    expect(["A2", "A3", "A4"].map((key) => byLetter.workbook.sheets[0].cells[key].v)).toEqual(["Bo", "Cy", "Ana"]);
    const byNumber = run([{ op: "sort", range: "A2:B4", col: 2, header: false }], seeded());
    expect(["B2", "B3", "B4"].map((key) => byNumber.workbook.sheets[0].cells[key].v)).toEqual([3, 5, 9]);
    const none = run([{ op: "sort", range: "A1:B4", by: ["B"] }], seeded());
    expect(none.workbook.sheets[0].cells.A2.v).toBe("Ana");
  });

  it("formats with aliases and border presets", () => {
    const result = run([
      { op: "format", range: "A1:B1", style: { background: "#FF0000", vertical: "center", border: "outer" }, borderColor: "#00AA00" },
      { op: "numberFormat", range: "B2:B4", format: "0.0%" },
      { op: "format", range: "A2", border: "weird" },
    ], seeded());
    const cells = result.workbook.sheets[0].cells;
    expect(cells.A1.s).toMatchObject({ fill: "#ff0000", valign: "middle", border: { top: { style: "thin", color: "#00aa00" }, left: { style: "thin", color: "#00aa00" } } });
    expect(cells.B2.s).toEqual({ format: "0.0%" });
    expect(cells.A2.s).toBeUndefined();
  });

  it("names tables uniquely and needs a data row", () => {
    const result = run([
      { op: "table", range: "A1:B4", name: "9 lives", tone: "dark", accent: 9, totals: true },
      { op: "table", range: "D1:E4", name: "_9_lives" },
      { op: "table", range: "G1:H1" },
    ], seeded());
    const tables = result.workbook.sheets[0].tables!;
    expect(tables.map((table) => [table.name, table.tone, table.accent, table.totals])).toEqual([
      ["_9_lives", "dark", 1, true],
      ["_9_lives2", "medium", 1, false],
    ]);
    expect(result.warnings).toEqual(["A table needs a header row and at least one data row."]);
  });

  it("restyles tables in place, one by name or every one, so formulas that read them keep working", () => {
    const built = run([
      { op: "set", range: "A1", values: [["Item", "Qty"], ["Pens", 3], ["Pads", 5]] },
      { op: "table", range: "A1:B3", name: "Sales" },
      { op: "set", range: "D1", values: [["Region", "Units"], ["East", 4], ["West", 6]] },
      { op: "table", range: "D1:E3", name: "Regions" },
    ]).workbook;
    const one = applySheetOps(built, "sheet-1", [{ op: "tableStyle", table: "sales", accent: 3, tone: "dark", banded: false, filterButtons: false, firstColumn: true }]);
    expect(one.workbook.sheets[0].tables!.map((table) => [table.name, table.ref, table.accent, table.tone, table.banded, table.filterButtons, table.firstColumn])).toEqual([
      ["Sales", "A1:B3", 3, "dark", false, false, true],
      ["Regions", "D1:E3", 1, "medium", true, true, undefined],
    ]);
    const every = applySheetOps(built, "sheet-1", [{ op: "addSheet", name: "Notes" }, { op: "tableStyle", table: "*", accent: 5, tone: "light" }]);
    expect(every.workbook.sheets[0].tables!.map((table) => [table.accent, table.tone])).toEqual([[5, "light"], [5, "light"]]);
    expect(every.workbook.sheets[1].tables).toBeUndefined();
    // A new style clears fills the model painted inside the table, so the style shows.
    const painted = applySheetOps(built, "sheet-1", [{ op: "format", range: "A1:B1", style: { fill: "#123456", bold: true } }]).workbook;
    const repainted = applySheetOps(painted, "sheet-1", [{ op: "tableStyle", table: "Sales", accent: 2 }]).workbook;
    expect(repainted.sheets[0].cells.A1.s).toEqual({ bold: true });
    const optionOnly = applySheetOps(painted, "sheet-1", [{ op: "tableStyle", table: "Sales", banded: false }]).workbook;
    expect(optionOnly.sheets[0].cells.A1.s).toEqual({ fill: "#123456", bold: true });
    const missing = applySheetOps(built, "sheet-1", [{ op: "addSheet", name: "Notes" }, { op: "tableStyle", table: "Nope", accent: 2 }]);
    expect(missing.warnings).toEqual(['There is no table named "Nope" to restyle.']);
    expect(applySheetOps(built, "sheet-1", [{ op: "tableStyle", accent: 2 }]).warnings).toEqual(['There is no table named "" to restyle.']);
  });

  it("finds a table to restyle on a later sheet, after sheets with none", () => {
    const built = run([
      { op: "addSheet", name: "Data" },
      { op: "set", range: "A1", values: [["Item", "Qty"], ["Pens", 3]] },
      { op: "table", range: "A1:B2", name: "Stock" },
    ]).workbook;
    const styled = applySheetOps(built, "sheet-1", [{ op: "tableStyle", table: "STOCK", tone: "light" }]);
    expect(styled.warnings).toEqual([]);
    expect(styled.workbook.sheets[1].tables!.map((table) => table.tone)).toEqual(["light"]);
  });

  it("takes a table accent from the six slots, falling back to the first", () => {
    const built = run([{ op: "set", range: "A1", values: [["Item"], ["Pens"]] }, { op: "table", range: "A1:A2", name: "T" }]).workbook;
    const accent = (value: unknown) => applySheetOps(built, "sheet-1", [{ op: "tableStyle", table: "T", accent: value }]).workbook.sheets[0].tables![0].accent;
    expect([accent(0), accent(9), accent(2.6), accent(6), accent("4")]).toEqual([1, 1, 3, 6, 1]);
  });

  it("replaces a table that a new one overlaps by a single corner cell, and keeps one beside it", () => {
    const built = run([
      { op: "set", range: "A1", values: [["a", "b", "c", "d"], [1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]] },
      { op: "table", range: "B2:C3", name: "Middle" },
    ]).workbook;
    const names = (range: string) => applySheetOps(built, "sheet-1", [{ op: "table", range, name: "New" }]).workbook.sheets[0].tables!.map((table) => table.name);
    expect(names("A1:B2")).toEqual(["New"]);
    expect(names("C3:D4")).toEqual(["New"]);
    expect(names("D1:D4").sort()).toEqual(["Middle", "New"]);
    expect(names("A4:D5").sort()).toEqual(["Middle", "New"]);
  });

  it("keeps a table's name when the same range is formatted as a table again", () => {
    const built = run([
      { op: "set", range: "A1", values: [["Item", "Qty"], ["Pens", 3]] },
      { op: "table", range: "A1:B2", name: "Sales" },
      { op: "set", range: "D1", values: [["=SUM(Sales[Qty])"]] },
    ]).workbook;
    const again = applySheetOps(built, "sheet-1", [{ op: "table", range: "A1:B2", name: "Sales", tone: "dark" }]).workbook;
    expect(again.sheets[0].tables!.map((table) => [table.name, table.tone])).toEqual([["Sales", "dark"]]);
  });

  it("anchors charts beside their source, clamps sizes, and reports a missing source sheet", () => {
    const result = run([
      { op: "chart", type: "pie", range: "A1:B4", width: 5000, height: 10, legend: "top", seriesBy: "rows", stacked: true, showValues: true, xTitle: "x", yTitle: "y" },
      { op: "chart", source: "Other!A1:B2", sheet: "Sheet1", at: "k9" },
      { op: "chart", source: "Gone!A1:B2" },
      { op: "chart" },
    ], seeded());
    const charts = result.workbook.sheets[0].charts!;
    expect(charts[0]).toMatchObject({ id: "chart-1", type: "pie", source: "A1:B4", at: "D1", w: 1200, h: 160, legend: "top", seriesBy: "rows", stacked: true, showValues: true, xTitle: "x", yTitle: "y" });
    expect(charts[1]).toMatchObject({ id: "chart-2", type: "column", source: "Other!A1:B2", at: "K9", w: 480, h: 300, legend: "bottom", seriesBy: "columns" });
    expect(result.warnings).toEqual(['A chart pointed at missing sheet "Gone".', "A chart was missing its data range."]);
  });

  it("places pivots on the source sheet or an existing sheet and reads value fields", () => {
    const result = run([
      { op: "pivot", source: "A1:B4", rows: "Name", values: ["Score", { field: "Score", agg: "max", label: "Best" }, { agg: "min" }, 7] },
      { op: "pivot", source: "Sheet1!A1:B4", sheet: "Other", columns: ["Name"], values: [{ field: "Score", agg: "nope" }], rowTotals: false, at: "c5" },
      { op: "pivot" },
    ], seeded());
    const [sheet, other] = result.workbook.sheets;
    expect(sheet.pivots).toMatchObject([{ id: "pivot-1", at: "D1", rows: ["Name"], columns: [], values: [{ field: "Score", agg: "sum" }, { field: "Score", agg: "max", label: "Best" }] }]);
    expect(other.pivots).toMatchObject([{ id: "pivot-2", at: "C5", rows: [], columns: ["Name"], values: [{ field: "Score", agg: "sum" }], rowTotals: false, columnTotals: true }]);
    expect(result.activeSheetId).toBe(other.id);
    expect(result.warnings).toEqual(["A pivot table was missing its source range."]);
  });

  it("ignores values it cannot write and stops adding sheets at the workbook limit", () => {
    const hostile = run([{ op: "set", range: "A1", values: [[{ toString: () => { throw new Error("boom"); } }]] }]);
    expect(hostile.warnings).toEqual([]);
    expect(hostile.workbook.sheets[0].cells).toEqual({});
    const tooMany = run(Array.from({ length: 45 }, (_, n) => ({ op: "addSheet", name: `S${n}` })));
    expect(tooMany.workbook.sheets).toHaveLength(40);
  });
});

describe("sheet AI replies and summaries", () => {
  it("parses the first usable JSON candidate", () => {
    expect(parseSheetAiReply('```\n{"message":"  Hi  "}\n```')).toEqual({ message: "Hi", ops: [] });
    expect(parseSheetAiReply('{"ops":[{"op":"set"},{"nope":1},null,"x"]}')).toEqual({ message: "", ops: [{ op: "set" }] });
    expect(parseSheetAiReply('```json\n{"message":""}\n``` then {"message":"later"}')).toBeNull();
    expect(parseSheetAiReply('```\nnot json\n```\n{"message":"plain"}')).toEqual({ message: "plain", ops: [] });
    expect(parseSheetAiReply("{not json}")).toBeNull();
    expect(parseSheetAiReply("} backwards {")).toBeNull();
    expect(parseSheetAiReply("[1, 2]")).toBeNull();
    expect(parseSheetAiReply('{"ops": []}')).toBeNull();
    const many = JSON.stringify({ ops: Array.from({ length: 450 }, () => ({ op: "set" })) });
    expect(parseSheetAiReply(many)?.ops).toHaveLength(400);
  });

  it("summarizes cell, sheet, and object changes with plurals", () => {
    const before = seeded();
    const after = run([
      { op: "set", range: "C1", values: [["x"]] },
      { op: "addSheet", name: "A" },
      { op: "addSheet", name: "B" },
      { op: "chart", sheet: "Sheet1", source: "A1:B4" },
      { op: "chart", sheet: "Sheet1", source: "A1:B4" },
      { op: "table", sheet: "Sheet1", range: "A1:B4" },
      { op: "table", sheet: "Sheet1", range: "D1:E4" },
      { op: "pivot", sheet: "Sheet1", source: "Sheet1!A1:B4", rows: ["Name"], values: ["Score"] },
      { op: "pivot", sheet: "Sheet1", source: "Sheet1!A1:B4", rows: ["Name"], values: ["Score"], at: "M1" },
      { op: "conditional", sheet: "Sheet1", range: "B2:B4", rule: { type: "bar", color: "#087d8b" } },
    ], before).workbook;
    expect(describeChanges(before, after)).toBe("1 cell, 2 new sheets, 2 charts, 2 tables, 2 pivot tables, 1 highlight rule");
    expect(describeChanges(before, before)).toBe("formatting only");
    const one = run([{ op: "set", range: "C1", values: [["x"]] }, { op: "conditional", range: "B2:B4", rule: { type: "bar", color: "#087d8b" } }, { op: "conditional", range: "B2:B4", rule: { type: "bar", color: "#087d8b" } }], before).workbook;
    expect(describeChanges(before, one)).toBe("1 cell, 2 highlight rules");
    expect(diffWorkbooks(before, one)).toEqual(new Map([["sheet-1", new Set(["C1"])]]));
  });

  it("describes a sheet's structure and rows within the budget", () => {
    const workbook = run([
      { op: "set", range: "A1", values: [["Item", "Cost"], ["Pen", 2], ["Ink", "=B2*3"]] },
      { op: "format", range: "B2", style: { format: "$#,##0.00" } },
      { op: "freeze", rows: 1 },
      { op: "table", range: "A1:B3", name: "Costs" },
      { op: "chart", source: "A1:B3", title: "Costs" },
      { op: "pivot", source: "A1:B3", rows: ["Item"], values: ["Cost"], at: "H1" },
      { op: "merge", range: "D1:E1" },
      { op: "conditional", range: "B2:B3", rule: { type: "bar", color: "#087d8b" } },
      { op: "colWidth", cols: "A", width: 160 },
    ]).workbook;
    const sheet = workbook.sheets[0];
    const engine = computeWorkbook(workbook);
    const text = describeSheet(sheet, engine, 10_000);
    expect(text.split("\n")[0]).toBe(
      'Sheet "Sheet1" (used A1:I4; frozen 1 row(s) 0 col(s); tables Costs A1:B3; charts column "Costs" of A1:B3 at D1; pivots PivotTable at H1 from Sheet1!A1:B3; merges D1:E1; 1 conditional format rule(s))',
    );
    expect(text).toContain("Column widths px: A=160");
    expect(text).toContain('A2: "Pen" | B2: "$2.00" [$#,##0.00]');
    expect(text).toContain("B3: =B2*3 → 6");
    expect(describeSheet(sheet, engine, 150)).toMatch(/… more cells omitted …$/);
    expect(describeSheet(blankWorkbook().sheets[0], computeWorkbook(blankWorkbook()), 100)).toBe('Sheet "Sheet1" (used (empty))');
  });

  it("shows the head and tail of a long sheet and the rows around a focus", () => {
    const values = Array.from({ length: 120 }, (_, n) => [`r${n + 1}`]);
    const workbook = run([{ op: "set", range: "A1", values }]).workbook;
    const engine = computeWorkbook(workbook);
    const lines = describeSheet(workbook.sheets[0], engine, 100_000).split("\n");
    expect(lines.slice(40, 43)).toEqual(['A40: "r40"', "… rows 41-110 omitted (same columns) …", 'A111: "r111"']);
    expect(lines.at(-1)).toBe('A120: "r120"');
    const focused = describeSheet(workbook.sheets[0], engine, 100_000, { r1: 59, c1: 0, r2: 59, c2: 0 }).split("\n");
    expect(focused.slice(1, 7)).toEqual(['A58: "r58"', 'A59: "r59"', 'A60: "r60"', 'A61: "r61"', 'A62: "r62"', 'A1: "r1"']);
    expect(focused.some((line) => line.includes("omitted"))).toBe(false);
  });

  it("tells the model to keep Excel's gridlines and to place charts clear of the data", () => {
    const prompt = buildSheetPrompt({ instruction: "Build a P&L", workbook: blankWorkbook(), engine: computeWorkbook(blankWorkbook()), sheetId: "sheet-1", scope: "workbook" });
    expect(prompt).toContain("Keep gridlines on, as Excel does");
    expect(prompt).toContain('{"op":"gridlines","show":false} only when the user asks to hide gridlines');
    expect(prompt).not.toMatch(/\{"op":"gridlines","show":false\}(?! only when)/);
    expect(prompt).toContain("Anchor a chart two rows below its data or two columns to its right");
  });

  it("builds prompts for a cell selection, sources, and a retry", () => {
    const workbook = seeded();
    const engine = computeWorkbook(workbook);
    const prompt = buildSheetPrompt({ instruction: "  Explain  ", workbook, engine, sheetId: "missing", scope: "cell", selection: { r1: 1, c1: 1, r2: 1, c2: 1 }, sources: "SRC", previousReply: "x".repeat(500) });
    expect(prompt).toContain('Selected range Sheet1!B2:\nB2: "3"\n\nWorkbook with 2 sheet(s): "Sheet1", "Other".\n\nACTIVE Sheet "Sheet1" (used A1:B4)\nA1: "Name" | B1: "Score"');
    expect(prompt).toContain('A4: "Cy" | B4: "5"\n\nSheet "Other" (used (empty))');
    expect(prompt).toContain("Reference material the user attached (use it as the source of truth for facts and numbers):\nSRC");
    expect(prompt).toContain(`Previous reply started: ${"x".repeat(400)}\n`);
    expect(prompt.endsWith("User request: Explain")).toBe(true);
    const blank = buildSheetPrompt({ instruction: "Go", workbook: blankWorkbook(), engine: computeWorkbook(blankWorkbook()), sheetId: "sheet-1", scope: "workbook" });
    expect(blank).toContain("The workbook is empty: build it from scratch");
  });

  it("flattens displayed values to plain text up to the limit", () => {
    const workbook = run([
      { op: "set", range: "A1", values: [["Name", "Paid"], ["Ana", 0.5], [null, null]] },
      { op: "format", range: "B2", style: { format: "0%" } },
    ]).workbook;
    const engine = computeWorkbook(workbook);
    expect(workbookPlainText(workbook, engine)).toBe("# Sheet1\nName\tPaid\nAna\t50%");
    expect(workbookPlainText(workbook, engine, 12)).toBe("# Sheet1\nNam");
  });
});

describe("naming a workbook after the assistant builds it", () => {
  it("reads a short title from the reply", () => {
    expect(parseSheetAiReply('{"message":"Built it.","title":"  Monthly expense tracker  ","ops":[]}')).toEqual({ message: "Built it.", title: "Monthly expense tracker", ops: [] });
    expect(parseSheetAiReply('{"message":"Built it.","title":7,"ops":[]}')).toEqual({ message: "Built it.", ops: [] });
    expect(parseSheetAiReply('{"message":"Built it.","title":"   ","ops":[]}')).toEqual({ message: "Built it.", ops: [] });
    expect(parseSheetAiReply(`{"message":"m","title":"${"x".repeat(140)}"}`)?.title).toHaveLength(120);
    // Markdown the model slips into a name never reaches the title bar.
    expect(parseSheetAiReply('{"message":"m","title":"## **Q3 Budget**"}')?.title).toBe("Q3 Budget");
    expect(parseSheetAiReply('{"message":"m","title":"Title: `Sales tracker`."}')?.title).toBe("Sales tracker");
    expect(parseSheetAiReply('{"message":"m","title":"## "}')).toEqual({ message: "m", ops: [] });
  });

  it("asks for a title in the reply format", () => {
    const prompt = buildSheetPrompt({ instruction: "Build a budget", workbook: blankWorkbook(), engine: computeWorkbook(blankWorkbook()), sheetId: "sheet-1", scope: "workbook" });
    expect(prompt).toContain('"title": "<a short name for the whole workbook');
  });

  it("uses the reply's title, else the first sheet's new name, else nothing", () => {
    const before = blankWorkbook();
    const renamed = run([{ op: "renameSheet", sheet: "Sheet1", name: "Illustrative P&L" }]).workbook;
    expect(workbookTitleFrom("Five-year P&L", before, renamed)).toBe("Five-year P&L");
    expect(workbookTitleFrom(undefined, before, renamed)).toBe("Illustrative P&L");
    expect(workbookTitleFrom(undefined, before, run([{ op: "set", range: "A1", values: [[1]] }]).workbook)).toBeNull();
    // A first sheet that already had its own name tells us nothing new.
    expect(workbookTitleFrom(undefined, renamed, renamed)).toBeNull();
  });
});

