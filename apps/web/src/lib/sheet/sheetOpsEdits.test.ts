import { describe, expect, it } from "vitest";
import { MAX_SHEET_COLS, MAX_SHEET_ROWS, parseRangeRef } from "./address";
import type { Scalar } from "./formula/values";
import { SHEET_SCHEMA_VERSION, type Sheet, type SheetCell, type Workbook } from "./sheetModel";
import {
  applyBorders,
  applyStyle,
  cellFromInput,
  cellInputText,
  clearRange,
  deleteCols,
  deleteRows,
  deleteSheet,
  effectiveStyle,
  insertCols,
  insertRows,
  removeDuplicateRows,
  renameSheet,
  sortRange,
  type BorderPreset,
} from "./sheetOps";

const R = (text: string) => parseRangeRef(text)!;

function book(sheets: Partial<Sheet>[], extra: Partial<Workbook> = {}): Workbook {
  return { schema: SHEET_SCHEMA_VERSION, sheets: sheets.map((sheet, index) => ({ id: `s${index + 1}`, name: `S${index + 1}`, cells: {}, ...sheet })), ...extra };
}

const literal = (cells: Record<string, SheetCell>) => (row: number, col: number): Scalar => {
  const key = `${String.fromCharCode(65 + col)}${row + 1}`;
  return (cells[key]?.v as Scalar | undefined) ?? null;
};

describe("borders", () => {
  const borders = (preset: BorderPreset, color?: string) => {
    const start = book([{ cells: { B2: { v: 1, s: { bold: true, border: { top: { style: "dotted" } } } } } }]);
    const cells = applyBorders(start, "s1", R("A1:B2"), preset, color).sheets[0].cells;
    return Object.fromEntries(["A1", "B1", "A2", "B2"].map((key) => [key, cells[key]?.s?.border ?? null]));
  };
  const thin = { style: "thin" };

  it("draws every preset on the right edges", () => {
    expect(borders("all")).toEqual({ A1: { top: thin, bottom: thin, left: thin, right: thin }, B1: { top: thin, bottom: thin, left: thin, right: thin }, A2: { top: thin, bottom: thin, left: thin, right: thin }, B2: { top: thin, bottom: thin, left: thin, right: thin } });
    expect(borders("outer")).toEqual({ A1: { top: thin, left: thin }, B1: { top: thin, right: thin }, A2: { bottom: thin, left: thin }, B2: { top: { style: "dotted" }, bottom: thin, right: thin } });
    expect(borders("thickOuter", "#ff0000")).toMatchObject({ A1: { top: { style: "medium", color: "#ff0000" }, left: { style: "medium", color: "#ff0000" } } });
    expect(borders("inner")).toEqual({ A1: { bottom: thin, right: thin }, B1: { bottom: thin }, A2: { right: thin }, B2: { top: { style: "dotted" } } });
    expect(borders("bottomDouble", "#00ff00")).toEqual({ A1: null, B1: null, A2: { bottom: { style: "double", color: "#00ff00" } }, B2: { top: { style: "dotted" }, bottom: { style: "double", color: "#00ff00" } } });
    expect(borders("top")).toEqual({ A1: { top: thin }, B1: { top: thin }, A2: null, B2: { top: { style: "dotted" } } });
    expect(borders("bottom")).toEqual({ A1: null, B1: null, A2: { bottom: thin }, B2: { top: { style: "dotted" }, bottom: thin } });
    expect(borders("left")).toEqual({ A1: { left: thin }, B1: null, A2: { left: thin }, B2: { top: { style: "dotted" } } });
    expect(borders("right")).toEqual({ A1: null, B1: { right: thin }, A2: null, B2: { top: { style: "dotted" }, right: thin } });
  });

  it("removes borders with none and keeps the rest of the style", () => {
    const start = book([{ cells: { A1: { v: 1, s: { bold: true, border: { top: { style: "thin" }, right: { style: "thin" } } } } } }]);
    expect(applyBorders(start, "s1", R("A1:B1"), "none").sheets[0].cells).toEqual({ A1: { v: 1, s: { bold: true } } });
  });
});

describe("structure edits re-anchor every object", () => {
  const sheets = (): Partial<Sheet>[] => [
    {
      cells: { A1: { v: 1 }, B2: { f: "A1+S2!B2" }, C3: { v: 3 }, D4: { v: 4 } },
      cols: { B: { w: 120 }, C: { hidden: true } },
      rows: { "2": { h: 30 }, "3": { hidden: true } },
      merges: ["B2:C3", "C3:D3"],
      tables: [{ id: "t1", name: "T1", ref: "B2:D4", accent: 1, tone: "medium", banded: true, totals: false, filterButtons: true }, { id: "t2", name: "T2", ref: "C1:C2", accent: 1, tone: "medium", banded: true, totals: false, filterButtons: true }],
      charts: [{ id: "c1", type: "line", source: "B2:D4", seriesBy: "columns", legend: "bottom", at: "F2", w: 400, h: 300 }, { id: "c2", type: "line", source: "C2:C3", seriesBy: "columns", legend: "bottom", at: "C9", w: 400, h: 300 }],
      pivots: [{ id: "p1", name: "P", source: "B2:D4", at: "F10", rows: [], columns: [], values: [], filters: [], rowTotals: true, columnTotals: true }, { id: "p2", name: "P2", source: "A1:B3", at: "C5", rows: [], columns: [], values: [], filters: [], rowTotals: true, columnTotals: true }],
      conditional: [{ id: "r1", ref: "B2:D4", type: "formula", formula: "C2>0", style: {} }, { id: "r2", ref: "C1:C9", type: "bar", color: "#087d8b" }],
      validations: [{ id: "v1", ref: "B2:D4", kind: "list", source: "S2!A1:A3", strict: true }, { id: "v2", ref: "C2", kind: "whole", op: "gt", value: "1", strict: true }],
      filter: { ref: "B2:D4", criteria: {} },
    },
    { cells: { A1: { f: "S1!C3*2" } }, charts: [{ id: "c3", type: "line", source: "S1!C2:D3", seriesBy: "columns", legend: "bottom", at: "C3", w: 400, h: 300 }], validations: [{ id: "v3", ref: "A1", kind: "list", source: "S1!C1:C3", strict: true }] },
  ];
  const names = { names: [{ name: "Cee", ref: "S1!C1:C3" }, { name: "Gone", ref: "S1!C2" }, { name: "Other", ref: "S2!C1" }, { name: "Plain", ref: "C4" }] };

  it("deletes a column and drops what lived only in it", () => {
    const next = deleteCols(book(sheets(), names), "s1", 2, 1);
    const [first, second] = next.sheets;
    expect(first.cells).toEqual({ A1: { v: 1 }, B2: { f: "A1+S2!B2" }, C4: { v: 4 } });
    expect(first.cols).toEqual({ B: { w: 120 } });
    expect(first.rows).toEqual({ "2": { h: 30 }, "3": { hidden: true } });
    expect(first.merges).toEqual(["B2:B3"]);
    expect(first.tables?.map((table) => [table.name, table.ref])).toEqual([["T1", "B2:C4"]]);
    expect(first.charts?.map((chart) => [chart.id, chart.source, chart.at])).toEqual([["c1", "B2:C4", "E2"]]);
    // A pivot anchored in the deleted column goes with it.
    expect(first.pivots?.map((pivot) => [pivot.id, pivot.source, pivot.at])).toEqual([["p1", "B2:C4", "E10"]]);
    expect(first.conditional).toEqual([{ id: "r1", ref: "B2:C4", type: "formula", formula: "#REF!>0", style: {} }]);
    expect(first.validations?.map((rule) => [rule.id, rule.ref, rule.source])).toEqual([["v1", "B2:C4", "S2!A1:A3"]]);
    expect(first.filter).toEqual({ ref: "B2:C4", criteria: {} });
    expect(second.cells.A1).toEqual({ f: "#REF!*2" });
    // Re-anchored references are re-quoted ("S1" looks like a cell, so it gets quotes).
    expect(second.charts?.map((chart) => [chart.source, chart.at])).toEqual([["'S1'!C2:C3", "C3"]]);
    expect(second.validations?.[0].source).toBeUndefined();
    // Unqualified names belong to the first sheet.
    expect(next.names).toEqual([{ name: "Other", ref: "S2!C1" }]);
  });

  it("inserts rows, moving cells, sizes, objects, rule formulas, and names", () => {
    const next = insertRows(book(sheets(), names), "s1", 2, 2);
    const [first, second] = next.sheets;
    expect(first.cells).toEqual({ A1: { v: 1 }, B2: { f: "A1+S2!B2" }, C5: { v: 3 }, D6: { v: 4 } });
    expect(first.rows).toEqual({ "2": { h: 30 }, "5": { hidden: true } });
    expect(first.cols).toEqual({ B: { w: 120 }, C: { hidden: true } });
    expect(first.merges).toEqual(["B2:C5", "C5:D5"]);
    expect(first.tables?.map((table) => table.ref)).toEqual(["B2:D6", "C1:C2"]);
    expect(first.charts?.map((chart) => [chart.source, chart.at])).toEqual([["B2:D6", "F2"], ["C2:C5", "C11"]]);
    expect(first.pivots?.map((pivot) => [pivot.source, pivot.at])).toEqual([["B2:D6", "F12"], ["A1:B5", "C7"]]);
    expect(first.conditional?.map((rule) => rule.ref)).toEqual(["B2:D6", "C1:C11"]);
    expect(first.conditional?.[0]).toMatchObject({ formula: "C2>0" });
    expect(first.validations?.map((rule) => [rule.ref, rule.source])).toEqual([["B2:D6", "S2!A1:A3"], ["C2", undefined]]);
    expect(first.filter?.ref).toBe("B2:D6");
    expect(second.cells.A1).toEqual({ f: "S1!C5*2" });
    expect(second.charts?.[0]).toMatchObject({ source: "'S1'!C2:D5", at: "C3" });
    expect(second.validations?.[0].source).toBe("'S1'!C1:C5");
    expect(next.names).toEqual([{ name: "Cee", ref: "'S1'!C1:C5" }, { name: "Gone", ref: "'S1'!C2" }, { name: "Other", ref: "S2!C1" }, { name: "Plain", ref: "C6" }]);
  });

  it("drops cells pushed past the sheet edge and ignores empty edits", () => {
    const edge = book([{ cells: { A1: { v: 1 }, [`A${MAX_SHEET_ROWS}`]: { v: 2 } } }]);
    expect(insertRows(edge, "s1", 0, 1).sheets[0].cells).toEqual({ A2: { v: 1 } });
    const wide = book([{ cells: { [`${"IV"}1`]: { v: 1 } }, cols: { IV: { w: 50 } } }]);
    expect(insertCols(wide, "s1", 0, 1).sheets[0]).toMatchObject({ cells: {} });
    expect(insertCols(wide, "s1", 0, 1).sheets[0].cols).toBeUndefined();
    expect(MAX_SHEET_COLS).toBe(256);
    const start = book([{ cells: { A1: { v: 1 } } }]);
    expect(insertRows(start, "s1", 0, 0)).toBe(start);
    expect(deleteRows(start, "nope", 0, 1)).toBe(start);
    expect(deleteRows(book([{ cells: { A1: { v: 1 } } }], { names: [{ name: "X", ref: "S1!A1" }] }), "s1", 0, 1).names).toBeUndefined();
  });
});

describe("sheet rename and delete", () => {
  const start = () =>
    book(
      [
        { name: "Data", cells: { A1: { v: 1 } } },
        {
          name: "Calc",
          cells: { A1: { f: "Data!A1+1" }, B1: { v: 2 } },
          charts: [{ id: "c1", type: "line", source: "data!A1:A3", seriesBy: "columns", legend: "bottom", at: "C3", w: 400, h: 300 }, { id: "c2", type: "line", source: "A1:A3", seriesBy: "columns", legend: "bottom", at: "C3", w: 400, h: 300 }],
          pivots: [{ id: "p1", name: "P", source: "Data!A1:B3", at: "F1", rows: [], columns: [], values: [], filters: [], rowTotals: true, columnTotals: true }],
          validations: [{ id: "v1", ref: "A1", kind: "list", source: "Data!A1:A3", strict: true }, { id: "v2", ref: "A2", kind: "list", items: ["x"], strict: true }],
        },
      ],
      { names: [{ name: "One", ref: "Data!A1" }, { name: "Two", ref: "Calc!B1" }] },
    );

  it("rewrites formulas, object sources, and names, and refuses bad names", () => {
    const renamed = renameSheet(start(), "s1", "  Raw Data ").workbook;
    const calc = renamed.sheets[1];
    expect(renamed.sheets[0].name).toBe("Raw Data");
    expect(calc.cells.A1).toEqual({ f: "'Raw Data'!A1+1" });
    expect(calc.charts?.map((chart) => chart.source)).toEqual(["'Raw Data'!A1:A3", "A1:A3"]);
    expect(calc.pivots?.[0].source).toBe("'Raw Data'!A1:B3");
    expect(calc.validations?.map((rule) => rule.source)).toEqual(["'Raw Data'!A1:A3", undefined]);
    expect(renamed.names).toEqual([{ name: "One", ref: "'Raw Data'!A1" }, { name: "Two", ref: "Calc!B1" }]);
    const same = start();
    expect(renameSheet(same, "s1", "Data")).toEqual({ workbook: same });
    expect(renameSheet(same, "zz", "New")).toEqual({ workbook: same });
    expect(renameSheet(same, "s1", "a/b").error).toBe("Sheet names cannot contain : \\ / ? * [ or ].");
    expect(renameSheet(same, "s1", "CALC").error).toBe('A sheet named "CALC" already exists.');
    expect("names" in renameSheet(book([{}]), "s1", "X").workbook).toBe(false);
  });

  it("invalidates references to a deleted sheet and keeps one sheet visible", () => {
    const workbook = start();
    workbook.sheets[1].hidden = true;
    const next = deleteSheet(workbook, "s1");
    expect(next.sheets.map((sheet) => [sheet.name, sheet.hidden])).toEqual([["Calc", undefined]]);
    expect(next.sheets[0].cells.A1).toEqual({ f: "#REF!+1" });
    expect(next.sheets[0].charts?.map((chart) => chart.id)).toEqual(["c2"]);
    expect(next.sheets[0].pivots).toEqual([]);
    expect(next.names).toEqual([{ name: "Two", ref: "Calc!B1" }]);
    expect(deleteSheet(next, "s2")).toBe(next);
    expect(deleteSheet(workbook, "zz")).toBe(workbook);
    expect(deleteSheet(book([{}, {}], { names: [{ name: "A", ref: "S2!A1" }] }), "s2").names).toBeUndefined();
  });
});

describe("sorting and duplicates", () => {
  it("sorts by several keys with blanks last either way and shifts formulas", () => {
    const cells: Record<string, SheetCell> = { A1: { v: "b" }, B1: { v: 2 }, C1: { f: "B1*2" }, A2: { v: "a" }, B2: { v: 2 }, A3: { v: "c" }, A4: { v: "a" }, B4: { v: 1 }, A5: { v: "" }, B5: { v: 9 } };
    const sorted = (keys: { col: number; desc: boolean }[]) => {
      const next = sortRange(book([{ cells }]), "s1", R("A1:C5"), keys, literal(cells)).sheets[0].cells;
      return [1, 2, 3, 4, 5].map((row) => [next[`A${row}`]?.v ?? "", next[`B${row}`]?.v ?? "", next[`C${row}`]?.f ?? ""]);
    };
    expect(sorted([{ col: 1, desc: true }, { col: 0, desc: false }])).toEqual([["", 9, ""], ["a", 2, ""], ["b", 2, "B3*2"], ["a", 1, ""], ["c", "", ""]]);
    expect(sorted([{ col: 0, desc: true }])).toEqual([["c", "", ""], ["b", 2, "B2*2"], ["a", 2, ""], ["a", 1, ""], ["", 9, ""]]);
    const start = book([{ cells }]);
    expect(sortRange(start, "s1", R("A1:A1"), [{ col: 0, desc: false }], literal(cells))).toBe(start);
    expect(sortRange(start, "s1", R("A1:A5"), [], literal(cells))).toBe(start);
  });

  it("keeps the first of each repeated key and moves the rest up", () => {
    const cells: Record<string, SheetCell> = { A1: { v: "Key" }, A2: { v: 1 }, B2: { f: "A2*2" }, A3: { v: 1 }, A4: { v: "1" }, B4: { f: "A4*3" }, A5: { v: true }, A6: { v: "TRUE" } };
    const result = removeDuplicateRows(book([{ cells }]), "s1", R("A1:B6"), [0], literal(cells), true);
    // Keys compare as lower-case text, so 1 and "1", true and "TRUE" repeat.
    expect(result.removed).toBe(3);
    expect(result.workbook.sheets[0].cells).toEqual({ A1: { v: "Key" }, A2: { v: 1 }, B2: { f: "A2*2" }, A3: { v: true } });
    const none = book([{ cells: { A1: { v: 1 }, A2: { v: 2 } } }]);
    expect(removeDuplicateRows(none, "s1", R("A1:A2"), [0], literal(none.sheets[0].cells), false)).toEqual({ workbook: none, removed: 0 });
  });
});

describe("cell entry, clearing, and styles", () => {
  it("shows what the formula bar edits and parses what is typed", () => {
    expect([undefined, { f: "A1" }, {}, { v: true }, { v: false }, { v: 3.5 }, { v: "42" }, { v: "'quoted" }, { v: "=x" }, { v: "plain" }, { s: { bold: true } }].map((cell) => cellInputText(cell as SheetCell | undefined))).toEqual(
      ["", "=A1", "", "TRUE", "FALSE", "3.5", "'42", "''quoted", "'=x", "plain", ""],
    );
    expect(cellFromInput({ v: 1, s: { bold: true }, n: "note" }, "")).toEqual({ s: { bold: true }, n: "note" });
    expect(cellFromInput(undefined, "")).toBeNull();
    expect(cellFromInput({ n: "note" }, "=SUM(A1) ")).toEqual({ n: "note", f: "SUM(A1)" });
    expect(cellFromInput({ s: { bold: true } }, "12%")).toEqual({ v: 0.12, s: { bold: true, format: "0%" } });
    expect(cellFromInput({ s: { format: "0.00" } }, "$5")).toEqual({ v: 5, s: { format: "0.00" } });
  });

  it("clears contents, formats, notes, or everything including merges", () => {
    const start = book([{ cells: { A1: { v: 1, s: { bold: true }, n: "x" }, B1: { f: "A1" }, C5: { v: 9 } }, merges: ["A1:B1", "C5:D5"] }]);
    const cleared = (mode: "all" | "contents" | "formats" | "notes") => clearRange(start, "s1", R("A1:B2"), mode).sheets[0];
    expect(cleared("contents").cells).toEqual({ A1: { s: { bold: true }, n: "x" }, C5: { v: 9 } });
    expect(cleared("formats").cells).toEqual({ A1: { v: 1, n: "x" }, B1: { f: "A1" }, C5: { v: 9 } });
    expect(cleared("notes").cells).toEqual({ A1: { v: 1, s: { bold: true } }, B1: { f: "A1" }, C5: { v: 9 } });
    expect(cleared("all")).toMatchObject({ cells: { C5: { v: 9 } }, merges: ["C5:D5"] });
    expect(clearRange(start, "s1", R("A1:B2")).sheets[0].merges).toEqual(["A1:B1", "C5:D5"]);
  });

  it("styles whole columns and rows on the line and on existing cells", () => {
    const start = book([{ cells: { B3: { v: 1 }, C1: { v: 2 } }, cols: { B: { w: 90, s: { italic: true } } }, rows: { "3": { s: { bold: true } } } }]);
    const columns = applyStyle(start, "s1", { r1: 0, c1: 1, r2: MAX_SHEET_ROWS - 1, c2: 2 }, { italic: null, fill: "#ff0000" }).sheets[0];
    expect(columns.cols).toEqual({ B: { w: 90, s: { fill: "#ff0000" } }, C: { s: { fill: "#ff0000" } } });
    expect(columns.cells).toEqual({ B3: { v: 1, s: { fill: "#ff0000" } }, C1: { v: 2, s: { fill: "#ff0000" } } });
    const rows = applyStyle(start, "s1", { r1: 2, c1: 0, r2: 3, c2: MAX_SHEET_COLS - 1 }, { bold: null }).sheets[0];
    expect(rows.rows).toEqual({});
    expect(rows.cells.B3).toEqual({ v: 1 });
    const cleared = applyStyle(book([{ cols: { B: { s: { bold: true } } } }]), "s1", { r1: 0, c1: 1, r2: MAX_SHEET_ROWS - 1, c2: 1 }, { bold: null }).sheets[0];
    expect(cleared.cols).toEqual({});
    const box = applyStyle(start, "s1", R("A1:B1"), { bold: true }).sheets[0];
    expect(box.cells).toMatchObject({ A1: { s: { bold: true } }, B1: { s: { bold: true } } });
  });

  it("layers column, row, and cell styles", () => {
    const sheet = book([{ cells: { B2: { v: 1, s: { color: "#111111" } }, A1: { s: { bold: false } } }, cols: { B: { s: { bold: true, color: "#999999" } } }, rows: { "2": { s: { italic: true } } } }]).sheets[0];
    expect(effectiveStyle(sheet, 1, 1)).toEqual({ bold: true, color: "#111111", italic: true });
    expect(effectiveStyle(sheet, 0, 0)).toEqual({ bold: false });
    expect(effectiveStyle(sheet, 5, 5)).toBeUndefined();
    expect(effectiveStyle(sheet, 5, 1)).toEqual({ bold: true, color: "#999999" });
  });
});
