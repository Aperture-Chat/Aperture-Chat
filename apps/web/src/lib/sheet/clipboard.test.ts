import { describe, expect, it } from "vitest";
import { parseRangeRef } from "./address";
import { blockToHtml, copyBlock, externalBlock, inCutArea, parseHtmlTable, parseTsv, pasteBlock, type ClipBlock } from "./clipboard";
import { sheetError } from "./formula/values";
import { SHEET_SCHEMA_VERSION, type SheetCell, type Workbook } from "./sheetModel";

const R = (text: string) => parseRangeRef(text)!;

function book(cells: Record<string, SheetCell>, other: Record<string, SheetCell> = {}): Workbook {
  return { schema: SHEET_SCHEMA_VERSION, sheets: [{ id: "s1", name: "Data", cells }, { id: "s2", name: "Other", cells: other }] };
}

const SOURCE = {
  A1: { v: 2, s: { bold: true } },
  B1: { f: "A1*3", s: { fill: "#ff0000" } },
  A2: { f: "1/0" },
  B2: { v: "x", n: "note" },
};

function copied(cut = false): ClipBlock {
  const values: Record<string, unknown> = { "0,0": 2, "0,1": 6, "1,0": sheetError("#DIV/0!"), "1,1": "x" };
  return copyBlock(book(SOURCE).sheets[0], R("A1:B2"), cut, (row, col) => values[`${row},${col}`] as never);
}

const pasted = (mode: Parameters<typeof pasteBlock>[4], target: Record<string, SheetCell> = { D4: { v: 9, s: { italic: true } }, E5: { s: { color: "#00ff00" } } }) =>
  pasteBlock(book({ ...SOURCE, ...target }), "s1", R("D4"), copied(), mode).workbook.sheets[0].cells;

describe("paste modes", () => {
  it("pastes everything, shifting formulas relative to the copy", () => {
    const cells = pasted("all");
    expect([cells.D4, cells.E4, cells.D5, cells.E5]).toEqual([{ v: 2, s: { bold: true } }, { f: "D4*3", s: { fill: "#ff0000" } }, { f: "1/0" }, { v: "x", n: "note" }]);
  });

  it("pastes computed values over the target's own formats, skipping errors and blanks", () => {
    const cells = pasted("values");
    expect([cells.D4, cells.E4, cells.D5, cells.E5]).toEqual([{ v: 2, s: { italic: true } }, { v: 6 }, undefined, { v: "x", s: { color: "#00ff00" } }]);
    const blank = pasteBlock(book({ D4: { v: 1, s: { bold: true } } }), "s1", R("D4"), externalBlock([[""]]), "values").workbook.sheets[0].cells;
    expect(blank.D4).toEqual({ s: { bold: true } });
  });

  it("pastes formulas and literals without formats", () => {
    const cells = pasted("formulas");
    expect([cells.D4, cells.E4, cells.D5, cells.E5]).toEqual([{ v: 2, s: { italic: true } }, { f: "D4*3" }, { f: "1/0" }, { v: "x", s: { color: "#00ff00" } }]);
    const empty = pasteBlock(book({ D4: { v: 1 } }), "s1", R("D4"), { rows: 1, cols: 1, cells: [[null]], origin: null, cut: false }, "formulas").workbook.sheets[0].cells;
    expect(empty.D4).toBeUndefined();
  });

  it("pastes formats only, keeping the target's contents", () => {
    const cells = pasted("formats");
    expect([cells.D4, cells.E4, cells.D5, cells.E5]).toEqual([{ v: 9, s: { bold: true } }, { s: { fill: "#ff0000" } }, undefined, undefined]);
  });

  it("transposes rows and columns, dropping the origin so formulas stay as typed", () => {
    const result = pasteBlock(book(SOURCE), "s1", R("D4"), copied(), "transpose");
    expect(result.range).toEqual(R("D4:E5"));
    const cells = result.workbook.sheets[0].cells;
    expect([cells.D4, cells.E4, cells.D5, cells.E5]).toEqual([{ v: 2, s: { bold: true } }, { f: "1/0" }, { f: "A1*3", s: { fill: "#ff0000" } }, { v: "x", n: "note" }]);
    const wide = externalBlock([["a", "b", "c"]]);
    expect(pasteBlock(book({}), "s1", R("A1"), wide, "transpose").range).toEqual(R("A1:A3"));
  });

  it("tiles only when the selection is a whole multiple of the block", () => {
    const block = externalBlock([["1", "2"]]);
    expect(pasteBlock(book({}), "s1", R("A1:D3"), block).range).toEqual(R("A1:D3"));
    expect(pasteBlock(book({}), "s1", R("A1:C1"), block).range).toEqual(R("A1:B1"));
  });
});

describe("cut and paste", () => {
  it("moves the block and re-points formulas that referenced it, as Excel's move does", () => {
    const start = book({ A1: { v: 5 }, B1: { f: "A1*2" }, C9: { f: "SUM(A1:B1)" } }, { A1: { f: "Data!A1" } });
    const block = copyBlock(start.sheets[0], R("A1:B1"), true);
    expect(inCutArea(block, "s1", 0, 1)).toBe(true);
    expect(inCutArea(block, "s2", 0, 1)).toBe(false);
    expect(inCutArea(null, "s1", 0, 0)).toBe(false);
    const moved = pasteBlock(start, "s1", R("A3"), block).workbook;
    expect(moved.sheets[0].cells).toEqual({ A3: { v: 5 }, B3: { f: "A3*2" }, C9: { f: "SUM(A3:B3)" } });
    expect(moved.sheets[1].cells).toEqual({ A1: { f: "Data!A3" } });
  });

  it("moves references inside the block with it and keeps references outside it, absolute ones too", () => {
    const start = book({ A1: { v: 5 }, B1: { f: "$A$1+C5+SUM(A1:B1)" }, C5: { v: 1 } });
    const moved = pasteBlock(start, "s1", R("D2"), copyBlock(start.sheets[0], R("A1:B1"), true)).workbook;
    expect(moved.sheets[0].cells).toEqual({ C5: { v: 1 }, D2: { v: 5 }, E2: { f: "$D$2+C5+SUM(D2:E2)" } });
  });

  it("follows the block onto another sheet, from every sheet, and keeps the moved formulas' outside references on the old sheet", () => {
    const start = book(
      { A1: { v: 5 }, B1: { f: "A1*2+E9" }, C1: { f: "A1" }, D1: { f: "C5+B1" }, E9: { v: 1 } },
      { A1: { f: "Data!A1" }, F1: { f: "Data!C1" } },
    );
    const moved = pasteBlock(start, "s2", R("B2"), copyBlock(start.sheets[0], R("A1:B1"), true)).workbook;
    expect(moved.sheets[0].cells).toEqual({ C1: { f: "Other!B2" }, D1: { f: "C5+Other!C2" }, E9: { v: 1 } });
    expect(moved.sheets[1].cells).toEqual({ A1: { f: "B2" }, F1: { f: "Data!C1" }, B2: { v: 5 }, C2: { f: "B2*2+Data!E9" } });
  });

  it("moves a block that does not start at A1, skipping its empty cells", () => {
    const start = book({ B2: { v: 5 }, D2: { f: "B2+1" }, F9: { f: "D2*B2" } });
    const moved = pasteBlock(start, "s1", R("C5"), copyBlock(start.sheets[0], R("B2:D2"), true)).workbook;
    expect(moved.sheets[0].cells).toEqual({ C5: { v: 5 }, E5: { f: "C5+1" }, F9: { f: "E5*C5" } });
  });

  it("moves whole columns, re-pointing whole-column references", () => {
    const start = book({ A1: { v: 5 }, H1: { f: "SUM(A:A)" } });
    const block = copyBlock(start.sheets[0], R("A:A"), true);
    expect(pasteBlock(start, "s1", R("C1"), block).workbook.sheets[0].cells).toEqual({ C1: { v: 5 }, H1: { f: "SUM(C:C)" } });
  });

  it("pastes a block cut from a sheet that is gone as a plain copy", () => {
    const start = book({ A1: { v: 5 } });
    const block = { ...copyBlock(start.sheets[0], R("A1"), true), origin: { sheetId: "deleted", range: R("A1") } };
    expect(pasteBlock(start, "s1", R("B1"), block).workbook.sheets[0].cells).toEqual({ A1: { v: 5 }, B1: { v: 5 } });
  });

  it("pastes a moved block once, even into a larger selection", () => {
    const start = book({ A1: { v: 5 } });
    const result = pasteBlock(start, "s1", R("C1:D4"), copyBlock(start.sheets[0], R("A1"), true));
    expect(result.workbook.sheets[0].cells).toEqual({ C1: { v: 5 } });
    expect(result.range).toEqual(R("C1"));
  });

  it("copies a cut block like a copy when pasting values", () => {
    const start = book({ A1: { v: 5 } });
    const block = copyBlock(start.sheets[0], R("A1"), true);
    expect(pasteBlock(start, "s1", R("B1"), block, "values").workbook.sheets[0].cells).toEqual({ A1: { v: 5 }, B1: { v: 5 } });
  });
});

describe("tiling a copy", () => {
  it("repeats a copied block down and across to fill a larger selection", () => {
    const start = book({ A1: { v: 1 }, A2: { f: "A1+1" } });
    const down = pasteBlock(start, "s1", R("C3:C6"), copyBlock(start.sheets[0], R("A1:A2"))).workbook.sheets[0].cells;
    expect(down).toMatchObject({ C3: { v: 1 }, C4: { f: "C3+1" }, C5: { v: 1 }, C6: { f: "C5+1" } });
    const across = pasteBlock(start, "s1", R("C3:F3"), copyBlock(start.sheets[0], R("A1"))).workbook.sheets[0].cells;
    expect(across).toMatchObject({ C3: { v: 1 }, D3: { v: 1 }, E3: { v: 1 }, F3: { v: 1 } });
    expect(across.G3).toBeUndefined();
    const wide = book({ A1: { v: 1 }, B1: { f: "A1*2" } });
    const pair = pasteBlock(wide, "s1", R("C3:F3"), copyBlock(wide.sheets[0], R("A1:B1"))).workbook.sheets[0].cells;
    expect(pair).toMatchObject({ C3: { v: 1 }, D3: { f: "C3*2" }, E3: { v: 1 }, F3: { f: "E3*2" } });
  });

  it("pastes once when the selection is smaller than the block", () => {
    const start = book({ A1: { v: 1 }, B1: { v: 2 } });
    const result = pasteBlock(start, "s1", R("D4"), copyBlock(start.sheets[0], R("A1:B1")));
    expect(result.range).toEqual(R("D4:E4"));
  });
});

describe("external clipboard formats", () => {
  it("reads an HTML table's text, emphasis, colors, and column spans", () => {
    const html = `<meta charset="utf-8"><table>
      <tr><th>Head</th><td style="font-weight:700;color:rgb(255, 0, 0);background-color:#FFF">A&nbsp;b</td><td colspan="3" style="background:#abc">wide</td></tr>
      <tr><td><b>x</b></td><td style="font-style:italic;color:#000000;background:#FFFFFF">i</td><td><em>e</em></td><td style="font-weight:400;color:red">plain</td></tr>
    </table><table><tr><td>second</td></tr></table>`;
    expect(parseHtmlTable(html)).toEqual({
      texts: [["Head", "A b", "wide", "", ""], ["x", "i", "e", "plain"]],
      styles: [[{ bold: true }, { bold: true, color: "#ff0000" }, { fill: "#aabbcc" }, undefined, undefined], [{ bold: true }, { italic: true }, { italic: true }, undefined]],
    });
  });

  it("ignores text without a table and tables without rows", () => {
    expect(parseHtmlTable("<p>no table</p>")).toBeNull();
    expect(parseHtmlTable("<table></table>")).toBeNull();
    expect(parseHtmlTable("<div>&lt;table</div>")).toBeNull();
  });

  it("parses quoted TSV fields and line endings", () => {
    expect(parseTsv('a\t"b\nc"\t"say ""hi"""\rx\n')).toEqual([["a", "b\nc", 'say "hi"'], ["x"]]);
    expect(parseTsv('ab"c\t"\n')).toEqual([['ab"c', ""]]);
    expect(parseTsv("")).toEqual([[""]]);
  });

  it("writes an HTML table with visible formatting", () => {
    expect(blockToHtml([["<b>", "x"], ["y"]], [[{ bold: true, italic: true, underline: true, strike: true, color: "#ff0000", fill: "#00ff00", align: "center", size: 14 }, { strike: true }], [undefined]])).toBe(
      '<table><tbody><tr><td style="font-weight:700;font-style:italic;text-decoration:underline line-through;color:#ff0000;background:#00ff00;text-align:center;font-size:14pt">&lt;b&gt;</td><td style="text-decoration:line-through">x</td></tr><tr><td>y</td></tr></tbody></table>',
    );
  });

  it("builds blocks from outside text with typed values and styles", () => {
    expect(externalBlock([["1", "=A1"], ["x"]], [[{ bold: true }]])).toEqual({
      rows: 2,
      cols: 2,
      cells: [[{ v: 1, s: { bold: true } }, { f: "A1" }], [{ v: "x" }, null]],
      origin: null,
      cut: false,
    });
  });
});
