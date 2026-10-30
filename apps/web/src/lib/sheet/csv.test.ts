import { describe, expect, it } from "vitest";
import { parseDelimited, sheetToDelimited, workbookFromDelimited } from "./csv";
import { parseCellKey } from "./address";
import { MAX_SHEET_COLS, MAX_SHEET_ROWS, MAX_WORKBOOK_CELLS, type Sheet, parseWorkbook, workbookCellCount } from "./sheetModel";

const BOM = "﻿";

function textOf(sheet: Sheet) {
  return (row: number, col: number) => {
    const key = Object.keys(sheet.cells).find((item) => {
      const point = parseCellKey(item);
      return point?.row === row && point.col === col;
    });
    const value = key ? sheet.cells[key].v : undefined;
    return { text: value === undefined ? "" : String(value) };
  };
}

function sheetWith(cells: Record<string, string | number>): Sheet {
  return { id: "sheet-1", name: "Sheet1", cells: Object.fromEntries(Object.entries(cells).map(([key, v]) => [key, { v }])) };
}

describe("parseDelimited", () => {
  it("splits plain comma rows and ignores the final line break", () => {
    expect(parseDelimited("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("reads quoted fields with delimiters, escaped quotes, and line breaks inside", () => {
    const text = 'name,quote\r\n"Smith, Ana","She said ""hi""\r\nthen left"\r\n';
    expect(parseDelimited(text)).toEqual([
      ["name", "quote"],
      ["Smith, Ana", 'She said "hi"\r\nthen left'],
    ]);
  });

  it("strips a UTF-8 byte-order mark and keeps empty fields", () => {
    expect(parseDelimited(`${BOM}a,,c\n,,\n`)).toEqual([
      ["a", "", "c"],
      ["", "", ""],
    ]);
  });

  it("detects semicolon, tab, and pipe delimiters from the first lines", () => {
    expect(parseDelimited("a;b;c\n1;2,5;3")).toEqual([
      ["a", "b", "c"],
      ["1", "2,5", "3"],
    ]);
    expect(parseDelimited("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseDelimited("a|b\n1|2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("ignores delimiters inside quotes when detecting", () => {
    expect(parseDelimited('"a,b,c";d\n"e,f";g')).toEqual([
      ["a,b,c", "d"],
      ["e,f", "g"],
    ]);
  });

  it("honours an explicit delimiter", () => {
    expect(parseDelimited("a;b,c", ",")).toEqual([["a;b", "c"]]);
  });

  it("returns no rows for empty text", () => {
    expect(parseDelimited("")).toEqual([]);
    expect(parseDelimited(BOM)).toEqual([]);
  });

  it("treats a quote that is not at the start of a field as text", () => {
    expect(parseDelimited('5" pipe,x')).toEqual([['5" pipe', "x"]]);
  });

  it("keeps the rest of the text when a quote never closes", () => {
    expect(parseDelimited('a,"open, never\nclosed')).toEqual([["a", "open, never\nclosed"]]);
  });

  it("reads old Mac line endings (a lone carriage return)", () => {
    expect(parseDelimited("a,b\rc,d\r")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("breaks detection ties by quote-aware counts, consistency, then count", () => {
    expect(parseDelimited('"a,b";c\n"d,e";f')[0]).toEqual(["a,b", "c"]);
    expect(parseDelimited("a;b,c\nd;e,f;g")[0]).toEqual(["a;b", "c"]);
    expect(parseDelimited("a;b;c,d\ne;f,g\nh;i,j")[0]).toEqual(["a;b;c", "d"]);
    expect(parseDelimited("a;b;c,d\ne;f;g,h")[0]).toEqual(["a", "b", "c,d"]);
  });
});

describe("workbookFromDelimited", () => {
  it("builds one valid sheet named after the file, with typed values", () => {
    const { workbook, warnings } = workbookFromDelimited("Q1 Sales.csv", "Region,Units\nEast,12\nWest,7.5\n");
    expect(warnings).toEqual([]);
    expect(parseWorkbook(workbook).ok).toBe(true);
    expect(workbook.sheets).toHaveLength(1);
    const sheet = workbook.sheets[0];
    expect(sheet.name).toBe("Q1 Sales");
    expect(sheet.cells.A2.v).toBe("East");
    expect(sheet.cells.B2.v).toBe(12);
    expect(sheet.cells.B3.v).toBe(7.5);
  });

  it("keeps text that looks like a formula as a literal, never a formula", () => {
    const { workbook } = workbookFromDelimited("x.csv", 'a,b\n=SUM(A1:A9),"=HYPERLINK(""http://example.test"")"\n');
    const sheet = workbook.sheets[0];
    expect(sheet.cells.A2).toEqual({ v: "=SUM(A1:A9)" });
    expect(sheet.cells.B2.v).toBe('=HYPERLINK("http://example.test")');
    expect(Object.values(sheet.cells).every((cell) => cell.f === undefined)).toBe(true);
  });

  it("bolds the first row when it reads as a header over numbers", () => {
    const { workbook } = workbookFromDelimited("x.csv", "Item,Cost\nPens,4\n");
    const sheet = workbook.sheets[0];
    expect(sheet.cells.A1.s?.bold).toBe(true);
    expect(sheet.cells.B1.s?.bold).toBe(true);
    expect(sheet.cells.A2.s).toBeUndefined();
  });

  it("still reads a header that has a blank column", () => {
    const sheet = workbookFromDelimited("x.csv", "Item,,Cost\nPens,,4\n").workbook.sheets[0];
    expect(sheet.cells.A1.s?.bold).toBe(true);
    expect(sheet.cells.C1.s?.bold).toBe(true);
  });

  it("leaves the first row plain when it holds numbers or the next row has none", () => {
    const numeric = workbookFromDelimited("x.csv", "Item,2024\nPens,4\n").workbook.sheets[0];
    expect(numeric.cells.A1.s).toBeUndefined();
    const allText = workbookFromDelimited("x.csv", "Item,Note\nPens,blue\n").workbook.sheets[0];
    expect(allText.cells.A1.s).toBeUndefined();
    const single = workbookFromDelimited("x.csv", "Item,Note\n").workbook.sheets[0];
    expect(single.cells.A1.s).toBeUndefined();
  });

  it("sizes columns from their longest value within bounds", () => {
    const long = "x".repeat(400);
    const { workbook } = workbookFromDelimited("x.csv", `a,bb,c\n1,${"y".repeat(30)},${long}\n`);
    const cols = workbook.sheets[0].cols!;
    expect(cols.A.w).toBeLessThan(cols.B.w!);
    expect(cols.B.w).toBeLessThan(cols.C.w!);
    expect(cols.C.w).toBeLessThanOrEqual(400);
    expect(cols.A.w).toBeGreaterThanOrEqual(48);
    expect(cols.B.w).toBe(30 * 7 + 16);
  });

  it("keeps the first rows and columns that fit and says so", () => {
    const rows = Array.from({ length: MAX_SHEET_ROWS + 5 }, (_, index) => String(index + 1)).join("\n");
    const tall = workbookFromDelimited("tall.csv", rows);
    expect(Object.keys(tall.workbook.sheets[0].cells)).toHaveLength(MAX_SHEET_ROWS);
    expect(tall.warnings.join(" ")).toMatch(/first 20,000 rows/);

    const wide = workbookFromDelimited("wide.csv", Array.from({ length: MAX_SHEET_COLS + 3 }, () => "v").join(","));
    expect(Object.keys(wide.workbook.sheets[0].cells)).toHaveLength(MAX_SHEET_COLS);
    expect(wide.warnings.join(" ")).toMatch(/first 256 columns \(A–IV\)/);
  }, 30_000);

  it("does not warn when the text fills the sheet limits exactly", () => {
    const rows = Array.from({ length: MAX_SHEET_ROWS }, () => "1").join("\n");
    expect(workbookFromDelimited("tall.csv", rows).warnings).toEqual([]);
    expect(workbookFromDelimited("wide.csv", Array.from({ length: MAX_SHEET_COLS }, () => "v").join(",")).warnings).toEqual([]);
  }, 30_000);

  it("stops at the workbook cell limit", () => {
    // Blank fields make no cells, so they do not count against the limit.
    const line = `${Array.from({ length: 200 }, () => "1").join(",")},,,`;
    const text = Array.from({ length: MAX_WORKBOOK_CELLS / 200 + 3 }, () => line).join("\n");
    const { workbook, warnings } = workbookFromDelimited("big.csv", text);
    expect(workbookCellCount(workbook)).toBe(MAX_WORKBOOK_CELLS);
    expect(warnings.join(" ")).toMatch(/200,000/);
  }, 30_000);

  it("returns a blank sheet for an empty file", () => {
    const { workbook } = workbookFromDelimited(".csv", "");
    expect(workbook.sheets[0].cells).toEqual({});
    expect(workbook.sheets[0].name).toBe("Sheet1");
  });
});

describe("sheetToDelimited", () => {
  it("writes the used range from A1 with CRLF rows and a BOM by default", () => {
    const sheet = sheetWith({ A1: "a", C2: 3 });
    expect(sheetToDelimited(sheet, textOf(sheet))).toBe(`${BOM}a,,\r\n,,3\r\n`);
  });

  it("ends the used range at the last value, ignoring formatting-only cells", () => {
    const sheet: Sheet = { id: "sheet-1", name: "Sheet1", cells: { A1: { v: "x" }, A2: { f: "A1" }, C5: { s: { bold: true } } } };
    const text = (row: number) => ({ text: row === 0 ? "x" : "=A1" });
    expect(sheetToDelimited(sheet, text, { bom: false })).toBe("x\r\n'=A1\r\n");
  });

  it("writes a caller-chosen range, such as one that includes spilled results", () => {
    const sheet = sheetWith({ B2: 1 });
    const text = (row: number, col: number) => ({ text: `${row}:${col}` });
    expect(sheetToDelimited(sheet, text, { bom: false, range: { r1: 1, c1: 1, r2: 2, c2: 2 } })).toBe("1:1,1:2\r\n2:1,2:2\r\n");
  });

  it("omits the BOM on request and quotes fields that need it", () => {
    const sheet = sheetWith({ A1: "x,y", B1: 'say "hi"', C1: "two\nlines", D1: "plain" });
    expect(sheetToDelimited(sheet, textOf(sheet), { bom: false })).toBe('"x,y","say ""hi""","two\nlines",plain\r\n');
  });

  it("quotes on the chosen delimiter", () => {
    const sheet = sheetWith({ A1: "a;b", B1: "c,d" });
    expect(sheetToDelimited(sheet, textOf(sheet), { delimiter: ";", bom: false })).toBe('"a;b";c,d\r\n');
  });

  it("neutralises formula injection but leaves plain numbers alone", () => {
    const sheet = sheetWith({ A1: "=1+2", B1: "+cmd", C1: "-2", D1: "@SUM(A1)", E1: "-x", F1: "+3.5", G1: "\tTAB" });
    expect(sheetToDelimited(sheet, textOf(sheet), { bom: false })).toBe("'=1+2,'+cmd,-2,'@SUM(A1),'-x,+3.5,'\tTAB\r\n");
  });

  it("writes nothing but the BOM for an empty sheet", () => {
    const sheet = sheetWith({});
    expect(sheetToDelimited(sheet, textOf(sheet))).toBe(BOM);
    expect(sheetToDelimited(sheet, textOf(sheet), { bom: false })).toBe("");
  });

  it("round-trips through parseDelimited", () => {
    const sheet = sheetWith({ A1: "Name", B1: "Note", A2: "Ana", B2: 'multi\nline, "quoted"' });
    const text = sheetToDelimited(sheet, textOf(sheet));
    expect(parseDelimited(text)).toEqual([
      ["Name", "Note"],
      ["Ana", 'multi\nline, "quoted"'],
    ]);
  });
});
