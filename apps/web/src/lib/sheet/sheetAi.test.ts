import { describe, expect, it } from "vitest";
import { computeWorkbook } from "./recalc";
import { blankWorkbook } from "./sheetModel";
import { applySheetOps, buildSheetPrompt, describeChanges, parseSheetAiReply, problemsInTouched } from "./sheetAi";

describe("sheet AI replies", () => {
  it("reads JSON inside code fences and ignores prose around it", () => {
    const reply = parseSheetAiReply('Sure!\n```json\n{"message":"Added totals.","ops":[{"op":"set","range":"A1","values":[[1]]}]}\n```');
    expect(reply).toEqual({ message: "Added totals.", ops: [{ op: "set", range: "A1", values: [[1]] }] });
    expect(parseSheetAiReply("no json here")).toBeNull();
  });

  it("builds a multi-sheet workbook with formulas, formats, a table, a chart, and a pivot", () => {
    const ops = [
      { op: "renameSheet", sheet: "Sheet1", name: "Data" },
      { op: "set", range: "A1", values: [["Region", "Units", "Price", "Revenue"], ["East", 10, 5, "=B2*C2"], ["West", 4, 7, null]] },
      { op: "set", range: "D3", formula: "=B3*C3" },
      { op: "format", range: "A1:D1", style: { bold: true, fill: "#087D8B", color: "#FFFFFF", border: "bottom" } },
      { op: "format", range: "C2:D3", style: { format: "$#,##0.00" } },
      { op: "table", range: "A1:D3", name: "Sales Data", accent: 2 },
      { op: "chart", type: "column", source: "A1:A3,D1:D3", title: "bad source" },
      { op: "chart", type: "column", source: "A1:D3", title: "Revenue" },
      { op: "pivot", source: "Data!A1:D3", sheet: "Pivot", rows: ["Region"], values: [{ field: "Revenue", agg: "sum" }] },
      { op: "freeze", rows: 1 },
      { op: "explode" },
    ];
    const result = applySheetOps(blankWorkbook(), "sheet-1", ops);
    const [data, pivot] = result.workbook.sheets;
    expect(data.name).toBe("Data");
    expect(data.cells.D3).toEqual({ f: "B3*C3", s: { format: "$#,##0.00" } });
    expect(data.cells.A1.s).toMatchObject({ bold: true, fill: "#087d8b", border: { bottom: { style: "thin" } } });
    expect(data.tables?.[0]).toMatchObject({ name: "Sales_Data", accent: 2, ref: "A1:D3" });
    expect(data.charts).toHaveLength(1);
    expect(pivot.name).toBe("Pivot");
    expect(pivot.freeze).toEqual({ rows: 1, cols: 0 });
    expect(result.activeSheetId).toBe(pivot.id);
    expect(result.warnings.some((warning) => /unknown change "explode"/.test(warning))).toBe(true);
    const engine = computeWorkbook(result.workbook);
    expect(engine.value(data.id, 2, 3)).toBe(28);
    expect([3, 4, 5].map((row) => engine.value(pivot.id, row, 1))).toEqual([50, 28, 78]);
    expect(describeChanges(blankWorkbook(), result.workbook)).toMatch(/cells.*1 new sheet.*1 chart.*1 table.*1 pivot/);
  });

  it("keeps numeric-looking IDs with leading zeros as text", () => {
    const result = applySheetOps(blankWorkbook(), "sheet-1", [{ op: "set", range: "A1", values: [["00742", "42", 42]] }]);
    expect(result.workbook.sheets[0].cells).toMatchObject({ A1: { v: "00742" }, C1: { v: 42 } });
  });

  it("flags formula errors in cells the AI touched for the fix round", () => {
    const result = applySheetOps(blankWorkbook(), "sheet-1", [{ op: "set", range: "A1", values: [["=1/0", "=NOPE()"]] }]);
    const problems = problemsInTouched(computeWorkbook(result.workbook), result.touched);
    expect(problems.map((problem) => [problem.address, problem.error.code])).toEqual([["A1", "#DIV/0!"], ["B1", "#NAME?"]]);
    const prompt = buildSheetPrompt({ instruction: "Fix it", workbook: result.workbook, engine: computeWorkbook(result.workbook), sheetId: "sheet-1", scope: "workbook", problems });
    expect(prompt).toContain("Sheet1!A1: =1/0 → #DIV/0!");
    expect(prompt).toContain("User request: Fix it");
  });
});
