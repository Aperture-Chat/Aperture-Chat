import { describe, expect, it } from "vitest";
import { parseRangeRef } from "./address";
import { blockToTsv, copyBlock, externalBlock, parseTsv, pasteBlock } from "./clipboard";
import { fillRange } from "./fillSeries";
import { computeWorkbook } from "./recalc";
import { parseWorkbook, type Workbook } from "./sheetModel";
import {
  applyStyle,
  autoSumFormula,
  cellInputText,
  deleteRows,
  deleteSheet,
  effectiveStyle,
  insertCols,
  insertRows,
  mergeRange,
  removeDuplicateRows,
  renameSheet,
  setCellInput,
  sortRange,
} from "./sheetOps";

const R = (text: string) => parseRangeRef(text)!;

function wb(cells: Record<string, unknown>, extra: Record<string, unknown> = {}, more: unknown[] = []): Workbook {
  const parsed = parseWorkbook({ sheets: [{ id: "s1", name: "Data", cells, ...extra }, ...more] });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.workbook;
}

describe("cell entry", () => {
  it("types values the way Excel does and keeps the typed format", () => {
    let book = wb({});
    book = setCellInput(book, "s1", 0, 0, "$1,200.50");
    book = setCellInput(book, "s1", 1, 0, "=A1*2");
    book = setCellInput(book, "s1", 2, 0, "'0042");
    expect(book.sheets[0].cells.A1).toEqual({ v: 1200.5, s: { format: "$#,##0.00" } });
    expect(book.sheets[0].cells.A2).toEqual({ f: "A1*2" });
    expect(cellInputText(book.sheets[0].cells.A3)).toBe("'0042");
    expect(computeWorkbook(book).value("s1", 1, 0)).toBe(2401);
  });

  it("clearing a cell keeps its style but drops the value", () => {
    let book = setCellInput(wb({ A1: { v: 5, s: { bold: true } } }), "s1", 0, 0, "");
    expect(book.sheets[0].cells.A1).toEqual({ s: { bold: true } });
    book = applyStyle(book, "s1", R("B:B"), { fill: "#ffeeaa" });
    expect(effectiveStyle(book.sheets[0], 40, 1)).toEqual({ fill: "#ffeeaa" });
  });
});

describe("structure edits keep references in sync", () => {
  it("inserting rows moves cells, stretches ranges, and updates other sheets", () => {
    const book = wb(
      { A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 }, B1: { f: "SUM(A1:A3)" } },
      { merges: ["C2:D3"], tables: [{ id: "t", name: "T", ref: "A1:A3" }] },
      [{ id: "s2", name: "Summary", cells: { A1: { f: "Data!A3*10" } }, charts: [{ id: "c", type: "column", source: "Data!A1:A3", at: "C2" }] }],
    );
    const next = insertRows(book, "s1", 1, 2);
    const [data, summary] = next.sheets;
    expect(data.cells.A4).toEqual({ v: 2 });
    expect(data.cells.B1).toEqual({ f: "SUM(A1:A5)" });
    expect(data.merges).toEqual(["C4:D5"]);
    expect(data.tables?.[0].ref).toBe("A1:A5");
    expect(summary.cells.A1).toEqual({ f: "Data!A5*10" });
    expect(summary.charts?.[0].source).toBe("Data!A1:A5");
    expect(summary.charts?.[0].at).toBe("C2");
    expect(computeWorkbook(next).value("s2", 0, 0)).toBe(30);
  });

  it("deleting rows turns lost references into #REF! and shrinks ranges", () => {
    const book = wb({ A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 }, B1: { f: "SUM(A1:A3)" }, B4: { f: "A2" } });
    const next = deleteRows(book, "s1", 1, 1);
    expect(next.sheets[0].cells.B1).toEqual({ f: "SUM(A1:A2)" });
    expect(next.sheets[0].cells.B3).toEqual({ f: "#REF!" });
  });

  it("inserting columns shifts column-keyed widths", () => {
    const book = wb({ B1: { v: 1 } }, { cols: { B: { w: 180 } } });
    const next = insertCols(book, "s1", 0, 1);
    expect(next.sheets[0].cols).toEqual({ C: { w: 180 } });
    expect(next.sheets[0].cells.C1).toEqual({ v: 1 });
  });

  it("renaming and deleting sheets rewrites references", () => {
    const book = wb({}, {}, [{ id: "s2", name: "Calc", cells: { A1: { f: "Data!B2+1" } } }]);
    const renamed = renameSheet(book, "s1", "Raw Data").workbook;
    expect(renamed.sheets[1].cells.A1).toEqual({ f: "'Raw Data'!B2+1" });
    expect(renameSheet(book, "s1", "calc").error).toMatch(/already exists/);
    expect(deleteSheet(renamed, "s1").sheets[0].cells.A1).toEqual({ f: "#REF!+1" });
  });
});

describe("data tools", () => {
  it("sorts rows by a column with blanks last and formulas following their row", () => {
    const book = wb({
      A1: { v: "Name" }, B1: { v: "Score" }, C1: { v: "Double" },
      A2: { v: "Cy" }, B2: { v: 7 }, C2: { f: "B2*2" },
      A3: { v: "Ann" }, B3: { v: 9 }, C3: { f: "B3*2" },
      A4: { v: "Bo" }, C4: { f: "B4*2" },
    });
    const engine = computeWorkbook(book);
    const sorted = sortRange(book, "s1", R("A1:C4"), [{ col: 1, desc: true }], (r, c) => engine.value("s1", r, c), true);
    const after = computeWorkbook(sorted);
    expect([1, 2, 3].map((row) => [after.value("s1", row, 0), after.value("s1", row, 2)])).toEqual([["Ann", 18], ["Cy", 14], ["Bo", 0]]);
  });

  it("removes duplicate rows case-insensitively", () => {
    const book = wb({ A1: { v: "Key" }, A2: { v: "a" }, A3: { v: "A" }, A4: { v: "b" } });
    const engine = computeWorkbook(book);
    const result = removeDuplicateRows(book, "s1", R("A1:A4"), [0], (r, c) => engine.value("s1", r, c), true);
    expect(result.removed).toBe(1);
    expect(result.workbook.sheets[0].cells).toEqual({ A1: { v: "Key" }, A2: { v: "a" }, A3: { v: "b" } });
  });

  it("builds an AutoSum over the numbers above", () => {
    const numbers = new Set(["0,1", "1,1", "2,1"]);
    expect(autoSumFormula(3, 1, (r, c) => numbers.has(`${r},${c}`))).toBe("SUM(B1:B3)");
    expect(autoSumFormula(0, 0, () => false)).toBeNull();
  });

  it("merging keeps only the top-left value", () => {
    const merged = mergeRange(wb({ A1: { v: "Title" }, B1: { v: "x" } }), "s1", R("A1:C1"));
    expect(merged.sheets[0].cells).toEqual({ A1: { v: "Title" } });
    expect(merged.sheets[0].merges).toEqual(["A1:C1"]);
  });
});

describe("fill handle", () => {
  const fill = (cells: Record<string, unknown>, source: string, target: string) => {
    const book = fillRange(wb(cells), "s1", R(source), R(target));
    return book.sheets[0].cells;
  };

  it("continues numeric trends and repeats single numbers", () => {
    expect(fill({ A1: { v: 2 }, A2: { v: 4 } }, "A1:A2", "A1:A5")).toMatchObject({ A3: { v: 6 }, A4: { v: 8 }, A5: { v: 10 } });
    expect(fill({ A1: { v: 7 } }, "A1", "A1:A3")).toMatchObject({ A2: { v: 7 }, A3: { v: 7 } });
  });

  it("counts on text with numbers, cycles months, and steps dates", () => {
    expect(fill({ A1: { v: "Item 9" } }, "A1", "A1:A3")).toMatchObject({ A2: { v: "Item 10" }, A3: { v: "Item 11" } });
    expect(fill({ A1: { v: "Nov" } }, "A1", "A1:C1")).toMatchObject({ B1: { v: "Dec" }, C1: { v: "Jan" } });
    expect(fill({ A1: { v: "Q3" } }, "A1", "A1:A3")).toMatchObject({ A2: { v: "Q4" }, A3: { v: "Q1" } });
    const monthly = fill({ A1: { v: 46022, s: { format: "m/d/yyyy" } }, A2: { v: 46053, s: { format: "m/d/yyyy" } } }, "A1:A2", "A1:A3");
    expect(monthly.A3).toEqual({ v: 46081, s: { format: "m/d/yyyy" } });
  });

  it("shifts formulas as it fills and fills upward", () => {
    expect(fill({ B1: { f: "A1*2" } }, "B1", "B1:B3")).toMatchObject({ B2: { f: "A2*2" }, B3: { f: "A3*2" } });
    expect(fill({ A3: { v: 3 }, A4: { v: 4 } }, "A3:A4", "A1:A4")).toMatchObject({ A2: { v: 2 }, A1: { v: 1 } });
  });
});

describe("clipboard", () => {
  it("copies formulas relative to where they land and pastes values", () => {
    const book = wb({ A1: { v: 2 }, B1: { f: "A1*3" } });
    const block = copyBlock(book.sheets[0], R("B1"), false, (r, c) => computeWorkbook(book).value("s1", r, c));
    const pasted = pasteBlock(book, "s1", R("B2"), block).workbook;
    expect(pasted.sheets[0].cells.B2).toEqual({ f: "A2*3" });
    const values = pasteBlock(book, "s1", R("C1"), block, "values").workbook;
    expect(values.sheets[0].cells.C1).toEqual({ v: 6 });
  });

  it("cut and paste moves cells and re-points formulas that used them", () => {
    const book = wb({ A1: { v: 5 }, C1: { f: "A1+1" } });
    const block = copyBlock(book.sheets[0], R("A1"), true);
    const moved = pasteBlock(book, "s1", R("A5"), block).workbook;
    expect(moved.sheets[0].cells).toEqual({ A5: { v: 5 }, C1: { f: "A5+1" } });
  });

  it("tiles a block over a larger selection and round-trips TSV", () => {
    const block = externalBlock(parseTsv("1\t2\r\n3\t4\r\n"));
    const result = pasteBlock(wb({}), "s1", R("A1:D2"), block);
    expect(result.range).toEqual(R("A1:D2"));
    expect(result.workbook.sheets[0].cells.D2).toEqual({ v: 4 });
    expect(blockToTsv([["a\tb", "c"], ["\"q\"", ""]])).toBe('"a\tb"\tc\r\n"""q"""\t');
    expect(parseTsv('"a\tb"\tc\r\n"""q"""\t')).toEqual([["a\tb", "c"], ['"q"', ""]]);
  });
});

describe("chart data", () => {
  it("charts numeric columns of a table and skips text columns", async () => {
    const { readChartData } = await import("./chartData");
    const book = wb({
      A1: { v: "Region" }, B1: { v: "Rep" }, C1: { v: "Units" },
      A2: { v: "East" }, B2: { v: "Ann" }, C2: { v: 3 },
      A3: { v: "West" }, B3: { v: "Bo" }, C3: { v: 5 },
    });
    const data = readChartData({ id: "c", type: "column", source: "A1:C3", seriesBy: "columns", legend: "bottom", at: "E2", w: 400, h: 300 }, book.sheets[0], book, computeWorkbook(book));
    expect(data?.categories).toEqual(["East", "West"]);
    expect(data?.series.map((series) => [series.name, series.values])).toEqual([["Units", [3, 5]]]);
  });
});
