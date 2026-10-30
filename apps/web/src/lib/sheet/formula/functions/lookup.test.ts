import { describe, expect, it } from "vitest";
import { MAX_SHEET_COLS, MAX_SHEET_ROWS } from "../../address";
import { calc, recalculate } from "./testWorkbook";

const fruit = {
  A1: "Fruit", B1: "Qty", C1: "Price",
  A2: "apple", B2: 10, C2: 1.5,
  A3: "banana", B3: 20, C3: 0.25,
  A4: "cherry", B4: 30, C4: 3,
  A5: "date", B5: 40, C5: 2,
};

const results = (formulas: string[], cells: Record<string, string | number | boolean> = fruit) => formulas.map((formula) => calc(formula, cells));
const spill = (formula: string, cells: Record<string, string | number | boolean> = fruit) => recalculate({ Sheet1: { ...cells, H1: formula } })("H1");

describe("VLOOKUP and HLOOKUP", () => {
  it("exact match understands wildcards and ignores case", () => {
    expect(results(['=VLOOKUP("b*",A2:C5,2,FALSE)', '=VLOOKUP("CHERRY",A2:C5,3,FALSE)', '=VLOOKUP("fig",A2:C5,2,FALSE)', '=VLOOKUP("apple",A2:C5,4,FALSE)', '=VLOOKUP("apple",A2:C5,0,FALSE)', '=VLOOKUP("d?te",A:C,2,0)']))
      .toEqual([20, 3, "#N/A", "#REF!", "#VALUE!", 40]);
  });

  it("approximate match finds the largest value not above the lookup", () => {
    expect(results(["=VLOOKUP(25,B2:C5,2)", "=VLOOKUP(5,B2:C5,2,TRUE)", "=VLOOKUP(100,B2:C5,2)", "=VLOOKUP(20,B2:C5,2)"])).toEqual([0.25, "#N/A", 2, 0.25]);
  });

  it("HLOOKUP searches the first row", () => {
    expect(results(['=HLOOKUP("Qty",A1:C5,3,FALSE)', '=HLOOKUP("Price",A1:C3,2,0)', '=HLOOKUP("Size",A1:C3,2,0)'])).toEqual([20, 1.5, "#N/A"]);
  });

  it("propagates an error lookup value", () => {
    expect(results(["=VLOOKUP(1/0,A2:C5,2,FALSE)", "=MATCH(NA(),A2:A5,0)"])).toEqual(["#DIV/0!", "#N/A"]);
  });
});

describe("XLOOKUP and XMATCH", () => {
  const dupes = { D1: 1, D2: 2, D3: 1, D4: 3, E1: "a", E2: "b", E3: "c", E4: "d" };

  it("finds exact matches with a fallback", () => {
    expect(results(['=XLOOKUP("cherry",A2:A5,B2:B5)', '=XLOOKUP("fig",A2:A5,B2:B5,"none")', '=XLOOKUP("fig",A2:A5,B2:B5)', '=XLOOKUP("Price",A1:C1,A2:C2)'])).toEqual([30, "none", "#N/A", 1.5]);
  });

  it("match modes -1 and 1 take the next smaller or larger item", () => {
    expect(results(["=XLOOKUP(25,B2:B5,A2:A5,,-1)", "=XLOOKUP(25,B2:B5,A2:A5,,1)", "=XLOOKUP(30,B2:B5,A2:A5,,-1)", "=XLOOKUP(5,B2:B5,A2:A5,,-1)", "=XLOOKUP(45,B2:B5,A2:A5,,1)"]))
      .toEqual(["banana", "cherry", "cherry", "#N/A", "#N/A"]);
    expect(results(["=XLOOKUP(25,{40,10,30,20},{\"w\",\"x\",\"y\",\"z\"},,-1)", "=XLOOKUP(25,{40,10,30,20},{\"w\",\"x\",\"y\",\"z\"},,1)"])).toEqual(["z", "y"]);
  });

  it("the nearest item wins, and ties go to the first one searched", () => {
    expect(results(['=XLOOKUP(25,{20,10},{"a","b"},,-1)', '=XLOOKUP(25,{20,20},{"a","b"},,-1)', '=XLOOKUP(5,{10,10},{"a","b"},,1)', '=XLOOKUP(5,{10,10},{"a","b"},,1,-1)', '=XLOOKUP(5,{30,10},{"a","b"},,1)']))
      .toEqual(["a", "a", "a", "b", "b"]);
  });

  it("wildcard mode and search direction", () => {
    expect(results(["=XLOOKUP(1,D1:D4,E1:E4,,0,2)", "=XLOOKUP(1,D1:D4,E1:E4,,0,-2)", "=XLOOKUP(1,D1:D4,E1:E4,,3)", "=XMATCH(1,D1:D4,0,-2)"], dupes)).toEqual(["a", "c", "#VALUE!", 3]);
    expect(results(['=XLOOKUP("ch*",A2:A5,B2:B5,,2)', '=XLOOKUP("ch*",A2:A5,B2:B5)', "=XLOOKUP(30,B2:B5,A2:A5,,0,2)"])).toEqual([30, "#N/A", "cherry"]);
    expect(results(["=XLOOKUP(1,D1:D4,E1:E4)", "=XLOOKUP(1,D1:D4,E1:E4,,0,-1)", "=XLOOKUP(1,D1:D4,E1:E4,,0,3)", "=XLOOKUP(1,D1:D4,E1:E3)"], dupes)).toEqual(["a", "c", "#VALUE!", "#VALUE!"]);
  });

  it("returns every column of a multi-column return array", () => {
    expect(spill('=XLOOKUP("banana",A2:A5,B2:C5)')).toEqual([[20, 0.25]]);
    expect(spill('=XLOOKUP("Qty",A1:C1,A2:C5)')).toEqual([[10], [20], [30], [40]]);
  });

  it("XMATCH returns positions", () => {
    expect(results(['=XMATCH("cherry",A2:A5)', "=XMATCH(25,B2:B5,1)", "=XMATCH(25,B2:B5,-1)", "=XMATCH(1,{1,2,1},0,-1)", '=XMATCH("x",A2:A5)'])).toEqual([3, 3, 2, 3, "#N/A"]);
  });
});

describe("LOOKUP and MATCH", () => {
  it("LOOKUP searches a vector or the first column or row of an array", () => {
    expect(results(["=LOOKUP(25,B2:B5,A2:A5)", '=LOOKUP("c",A2:A5)', "=LOOKUP(25,B2:C5)", "=LOOKUP(1,B2:B5,A2:A5)"])).toEqual(["banana", "banana", 0.25, "#N/A"]);
  });

  it("MATCH needs the same type, never matches a blank lookup, and keeps exact hits in descending data", () => {
    expect(results(['=MATCH("10",B2:B5,0)', "=MATCH(G9,A1:A9,0)", "=MATCH(G9,A1:A9)", "=MATCH(30,{40,30,20,10},-1)", "=MATCH(5,{40,30,20,10},-1)", '=MATCH(25,{10,"x",20,30})'])).toEqual(["#N/A", "#N/A", "#N/A", 2, 4, 3]);
  });

  it("MATCH supports types 1, 0, and -1 and wildcards", () => {
    expect(results(["=MATCH(30,B2:B5,0)", "=MATCH(25,B2:B5)", "=MATCH(25,{40,30,20,10},-1)", '=MATCH("b*",A2:A5,0)', '=MATCH("B?NANA",A2:A5,0)', "=MATCH(99,B2:B5,0)", "=MATCH(2,{1,2,2,3})", "=MATCH(1,A2:C5,0)"]))
      .toEqual([3, 2, 2, 2, 2, "#N/A", 3, "#N/A"]);
  });
});

describe("INDEX, OFFSET, and INDIRECT", () => {
  it("INDEX picks cells, whole rows, and whole columns", () => {
    expect(results(["=INDEX(A2:C5,2,3)", "=INDEX(A2:A5,3)", "=INDEX(A2:C2,3)", "=INDEX({1,2;3,4},2,1)", "=INDEX(A2:C5,5,1)", "=INDEX(A2:C5,-1,1)", "=SUM(INDEX(B2:C5,0,1))", "=INDEX(A:A,4)"]))
      .toEqual([0.25, "cherry", 1.5, 3, "#REF!", "#VALUE!", 100, "cherry"]);
    expect(spill("=INDEX(A2:C5,0,2)")).toEqual([[10], [20], [30], [40]]);
    expect(spill("=INDEX(A2:C5,2,0)")).toEqual([["banana", 20, 0.25]]);
  });

  it("INDEX returns a reference, so ROWS sees the declared shape", () => {
    expect(results(["=ROWS(INDEX(A:C,0,1))", "=ISREF(INDEX(A2:C5,1,1))", "=ISREF(INDEX({1,2},1))"])).toEqual([MAX_SHEET_ROWS, true, false]);
  });

  it("OFFSET moves and resizes a reference", () => {
    expect(results(["=OFFSET(A1,2,1)", "=SUM(OFFSET(B2,0,0,3,1))", "=OFFSET(A1,-1,0)", "=ROWS(OFFSET(A1,0,0,7,2))", "=SUM(OFFSET(B5,0,0,-2))", "=OFFSET(A1,0,0,0)", '=OFFSET("A1",0,0)']))
      .toEqual([20, 60, "#REF!", 7, 70, "#REF!", "#VALUE!"]);
    expect(spill("=OFFSET(A1,0,0,2,2)")).toEqual([["Fruit", "Qty"], ["apple", 10]]);
  });

  it("INDIRECT reads A1 text, with an optional sheet", () => {
    const read = recalculate({
      Sheet1: { ...fruit, H1: '=INDIRECT("B3")', H2: '=SUM(INDIRECT("Sheet1!B2:B5"))', H3: '=INDIRECT("R1C1",FALSE)', H4: '=INDIRECT("nope")', H5: "=INDIRECT(\"'Other Sheet'!A1\")", H6: '=INDIRECT("$C$2")', H7: '=INDIRECT("Missing!A1")' },
      "Other Sheet": { A1: "elsewhere" },
    });
    expect(["H1", "H2", "H3", "H4", "H5", "H6", "H7"].map(read)).toEqual([20, 100, "#REF!", "#REF!", "elsewhere", 1.5, "#REF!"]);
  });
});

describe("CHOOSE, ROW, COLUMN, ROWS, and COLUMNS", () => {
  it("CHOOSE evaluates only the chosen value", () => {
    expect(results(['=CHOOSE(2,"a","b","c")', '=CHOOSE(4,"a","b")', '=CHOOSE(2,1/0,"ok")', "=SUM(CHOOSE(2,A2:A5,B2:B5))", '=CHOOSE(0,"a")'])).toEqual(["b", "#VALUE!", "ok", 100, "#VALUE!"]);
    expect(spill('=CHOOSE({1,2},"x","y")')).toEqual([["x", "y"]]);
  });

  it("ROW and COLUMN default to the current cell and spill for ranges", () => {
    expect(results(["=ROW()", "=ROW(C7)", "=COLUMN(C7)", "=COLUMN()", '=ROW("A1")'])).toEqual([1, 7, 3, 26, "#VALUE!"]);
    expect(spill("=ROW(A2:A4)")).toEqual([[2], [3], [4]]);
    expect(spill("=COLUMN(A1:C1)")).toEqual([[1, 2, 3]]);
  });

  it("ROWS and COLUMNS use the declared shape", () => {
    expect(results(["=ROWS(A2:C5)", "=COLUMNS(A2:C5)", "=ROWS({1;2;3})", "=ROWS(A:A)", "=COLUMNS(1:1)", "=ROWS(5)", "=ROWS(1/0)"])).toEqual([4, 3, 3, MAX_SHEET_ROWS, MAX_SHEET_COLS, 1, "#DIV/0!"]);
  });
});

describe("ADDRESS and HYPERLINK", () => {
  it("ADDRESS builds A1 and R1C1 text", () => {
    expect(results(["=ADDRESS(2,3)", "=ADDRESS(2,3,2)", "=ADDRESS(2,3,3)", "=ADDRESS(2,3,4)", "=ADDRESS(2,3,1,FALSE)", "=ADDRESS(2,3,4,FALSE)", '=ADDRESS(1,1,1,TRUE,"Q1 Sales")', "=ADDRESS(0,1)", "=ADDRESS(1,1,5)"]))
      .toEqual(["$C$2", "C$2", "$C2", "C2", "R2C3", "R[2]C[3]", "'Q1 Sales'!$A$1", "#VALUE!", "#VALUE!"]);
  });

  it("HYPERLINK shows the friendly name, or the link", () => {
    expect(results(['=HYPERLINK("https://example.com","Example")', '=HYPERLINK("https://example.com")'])).toEqual(["Example", "https://example.com"]);
  });
});

describe("edges", () => {
  it("VLOOKUP's column 1, an array table, and a whole-row table wider than the data", () => {
    expect(results(['=VLOOKUP("apple",A2:C5,1,FALSE)', '=VLOOKUP(2,{1,"a";2,"b"},2,FALSE)', '=HLOOKUP("Fruit",1:9,8,FALSE)'])).toEqual(["apple", "b", null]);
  });

  it("XLOOKUP rejects a two-way lookup array", () => {
    expect(results(["=XLOOKUP(1,{1,2;3,4},{1,2})", "=XLOOKUP(5,{5},{9})"])).toEqual(["#VALUE!", 9]);
  });

  it("an empty OFFSET size keeps the reference's size; an empty cell means 0", () => {
    expect(spill("=OFFSET(A1,1,1,,2)")).toEqual([[10, 1.5]]);
    expect(results(["=OFFSET(A1,0,0,G9)", `=ROWS(OFFSET(A1,${MAX_SHEET_ROWS},0))`, `=ROWS(OFFSET(A1,${MAX_SHEET_ROWS - 1},0))`, `=OFFSET(A1,0,${MAX_SHEET_COLS})`])).toEqual(["#REF!", "#REF!", 1, "#REF!"]);
  });

  it("INDEX with an explicit column on a single row or column", () => {
    expect(results(["=INDEX(A2:C2,1,3)", "=INDEX(A2:A5,2,1)", "=TYPE(ROW(C7))"])).toEqual([1.5, "banana", 1]);
  });

  it("ADDRESS accepts Excel's whole grid", () => {
    expect(results(["=ADDRESS(1048576,16384)", "=ADDRESS(1048577,1)", "=ADDRESS(1,16385)", "=ADDRESS(1,0)"])).toEqual(["$XFD$1048576", "#VALUE!", "#VALUE!", "#VALUE!"]);
  });
});

describe("argument counts", () => {
  it("rejects too few or too many arguments", () => {
    expect(results(["=VLOOKUP(1,A1:B2)", "=INDEX()", "=ROW(A1,A2)", "=XLOOKUP(1,A1:A2)", "=MATCH(1)", "=OFFSET(A1,1)"])).toEqual(["#VALUE!", "#VALUE!", "#VALUE!", "#VALUE!", "#VALUE!", "#VALUE!"]);
  });
});
