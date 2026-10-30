import { describe, expect, it } from "vitest";
import { MAX_SHEET_COLS, MAX_SHEET_ROWS } from "../address";
import { FormulaSyntaxError, formulaFunctionNames, parseFormula, tokenizeFormula } from "./parser";

const kinds = (source: string) => tokenizeFormula(source).map((token) => token.t);

function syntaxError(source: string): { message: string; position: number } | null {
  try {
    tokenizeFormula(source);
    return null;
  } catch (error) {
    if (!(error instanceof FormulaSyntaxError)) throw error;
    return { message: error.message, position: error.position };
  }
}

describe("formula tokenizer", () => {
  it("reads whitespace, text with doubled quotes, and error values", () => {
    expect(tokenizeFormula(' "a""b" \t#n/a')).toEqual([
      { t: "ws", start: 0, end: 1 },
      { t: "str", value: 'a"b', start: 1, end: 7 },
      { t: "ws", start: 7, end: 9 },
      { t: "err", value: "#N/A", start: 9, end: 13 },
    ]);
    expect(syntaxError('"open')).toEqual({ message: "A text value is missing its closing quote.", position: 0 });
    expect(syntaxError("1+#OOPS")).toEqual({ message: "Unknown error value.", position: 2 });
  });

  it("reads cell references with sheet prefixes and absolute markers", () => {
    expect(tokenizeFormula("$B$2")).toEqual([{ t: "ref", sheet: null, col: 1, row: 1, colAbs: true, rowAbs: true, start: 0, end: 4 }]);
    expect(tokenizeFormula("'Q1 ''Plan'''!c3")).toEqual([{ t: "ref", sheet: "Q1 'Plan'", col: 2, row: 2, colAbs: false, rowAbs: false, start: 0, end: 16 }]);
    expect(tokenizeFormula("Data!A$1")).toEqual([{ t: "ref", sheet: "Data", col: 0, row: 0, colAbs: false, rowAbs: true, start: 0, end: 8 }]);
    expect(kinds("A0")).toEqual(["word"]);
    expect(kinds("XFE1")).toEqual(["word"]);
    expect(kinds("A1048577")).toEqual(["word"]);
    expect(kinds("LOG10(1)")).toEqual(["func", "(", "num", ")"]);
    expect(kinds("A1.5")).toEqual(["word"]);
  });

  it("reads whole columns and rows only as one side of a colon", () => {
    expect(tokenizeFormula("$A:c")).toEqual([
      { t: "colref", sheet: null, col: 0, abs: true, start: 0, end: 2 },
      { t: ":", start: 2, end: 3 },
      { t: "colref", sheet: null, col: 2, abs: false, start: 3, end: 4 },
    ]);
    expect(tokenizeFormula("Data!2 : $5")).toEqual([
      { t: "rowref", sheet: "Data", row: 1, abs: false, start: 0, end: 6 },
      { t: "ws", start: 6, end: 7 },
      { t: ":", start: 7, end: 8 },
      { t: "ws", start: 8, end: 9 },
      { t: "rowref", sheet: null, row: 4, abs: true, start: 9, end: 11 },
    ]);
    expect(kinds("A1:B")).toEqual(["ref", ":", "word"]);
    expect(kinds("1:2.5")).toEqual(["num", ":", "num"]);
    expect(kinds("0:3")).toEqual(["num", ":", "num"]);
    expect(kinds("XFE:XFF")).toEqual(["word", ":", "word"]);
  });

  it("reads a sheet's deleted reference and rejects a bare sheet prefix", () => {
    expect(tokenizeFormula("'Gone'!#REF!+1").slice(0, 1)).toEqual([{ t: "err", value: "#REF!", start: 0, end: 12 }]);
    expect(syntaxError("Data!#BAD")).toEqual({ message: "A sheet name must be followed by a cell or range.", position: 0 });
    expect(syntaxError("1+Data!")).toEqual({ message: "A sheet name must be followed by a cell or range.", position: 2 });
    expect(syntaxError("'Open!A1")).toEqual({ message: "Unexpected character \"'\".", position: 0 });
  });

  it("reads numbers, names, functions, and structured references", () => {
    expect(tokenizeFormula("1.5e3 .5 7.")).toEqual([
      { t: "num", value: 1500, start: 0, end: 5 },
      { t: "ws", start: 5, end: 6 },
      { t: "num", value: 0.5, start: 6, end: 8 },
      { t: "ws", start: 8, end: 9 },
      { t: "num", value: 7, start: 9, end: 11 },
    ]);
    expect(tokenizeFormula("Sum (Rate)")).toEqual([
      { t: "func", value: "Sum", start: 0, end: 3 },
      { t: "ws", start: 3, end: 4 },
      { t: "(", start: 4, end: 5 },
      { t: "word", value: "Rate", start: 5, end: 9 },
      { t: ")", start: 9, end: 10 },
    ]);
    expect(tokenizeFormula("Sales[[#This Row],[Qty]]")).toEqual([{ t: "struct", table: "Sales", spec: "[#This Row],[Qty]", start: 0, end: 24 }]);
    expect(tokenizeFormula("_xlfn.ÉTÉ[Col]")).toEqual([{ t: "struct", table: "_xlfn.ÉTÉ", spec: "Col", start: 0, end: 14 }]);
    expect(syntaxError("T[[a]")).toEqual({ message: "A table reference is missing its closing bracket.", position: 0 });
    // Inside a table Excel drops the table name: [@Qty], [@[Unit Price]], [Qty].
    expect(tokenizeFormula("[@Qty]*2")).toEqual([
      { t: "struct", table: "", spec: "@Qty", start: 0, end: 6 },
      { t: "op", value: "*", start: 6, end: 7 },
      { t: "num", value: 2, start: 7, end: 8 },
    ]);
    expect(tokenizeFormula("SUM([Qty])")[2]).toEqual({ t: "struct", table: "", spec: "Qty", start: 4, end: 9 });
    expect(tokenizeFormula("[@[Unit Price]]")).toEqual([{ t: "struct", table: "", spec: "@[Unit Price]", start: 0, end: 15 }]);
    expect(syntaxError("[@Qty")).toEqual({ message: "A table reference is missing its closing bracket.", position: 0 });
  });

  it("reads operators and punctuation and rejects anything else", () => {
    expect(tokenizeFormula("<><=>=+-*/^&=<>%(),;{}:").map((token) => ("value" in token ? token.value : token.t))).toEqual([
      "<>", "<=", ">=", "+", "-", "*", "/", "^", "&", "=", "<>", "%", "(", ")", ",", ";", "{", "}", ":",
    ]);
    expect(syntaxError("1 ? 2")).toEqual({ message: 'Unexpected character "?".', position: 2 });
    expect(tokenizeFormula("")).toEqual([]);
  });
});

describe("formula parser", () => {
  const ast = (source: string) => {
    const parsed = parseFormula(source);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.ast;
  };

  it("parses literals, names, references, and ranges", () => {
    expect(ast("=TRUE")).toEqual({ type: "bool", value: true });
    expect(ast("false")).toEqual({ type: "bool", value: false });
    expect(ast("Rate")).toEqual({ type: "name", name: "Rate" });
    expect(ast('"x"')).toEqual({ type: "str", value: "x" });
    expect(ast("#DIV/0!")).toEqual({ type: "err", code: "#DIV/0!" });
    expect(ast("Data!C5:A1")).toEqual({ type: "range", sheet: "Data", r1: 0, c1: 0, r2: 4, c2: 2 });
    expect(ast("B2")).toEqual({ type: "ref", sheet: null, row: 1, col: 1 });
    expect(ast("C:A")).toEqual({ type: "range", sheet: null, r1: 0, c1: 0, r2: MAX_SHEET_ROWS - 1, c2: 2 });
    expect(ast("5:2")).toEqual({ type: "range", sheet: null, r1: 1, c1: 0, r2: 4, c2: MAX_SHEET_COLS - 1 });
    expect(ast("T[Col]")).toEqual({ type: "struct", table: "T", spec: "Col" });
  });

  it("follows Excel precedence, unary minus, and percent", () => {
    expect(ast("-2^2")).toEqual({ type: "binary", op: "^", left: { type: "unary", op: "-", arg: { type: "num", value: 2 } }, right: { type: "num", value: 2 } });
    expect(ast("1+2*3&4=5")).toMatchObject({ type: "binary", op: "=", left: { op: "&", left: { op: "+", right: { op: "*" } } } });
    expect(ast("50%")).toEqual({ type: "unary", op: "%", arg: { type: "num", value: 50 } });
    expect(ast("2^3^2")).toMatchObject({ op: "^", left: { op: "^" } });
    expect(ast("(1+2)*3")).toMatchObject({ op: "*", left: { op: "+" } });
  });

  it("parses calls with empty and trailing arguments", () => {
    expect(ast("_xlfn._xlws.sort(A1:A3)")).toMatchObject({ type: "call", name: "SORT" });
    expect(ast("NOW()")).toEqual({ type: "call", name: "NOW", args: [] });
    expect(ast("IF(,1,)")).toEqual({ type: "call", name: "IF", args: [{ type: "empty" }, { type: "num", value: 1 }, { type: "empty" }] });
    expect(formulaFunctionNames(ast("SUM(-A1, IF(B1, {1,2}, MAX(1)))%"))).toEqual(new Set(["SUM", "IF", "MAX"]));
  });

  it("parses array constants", () => {
    expect(ast("{1,-2;\"a\",TRUE}")).toEqual({
      type: "array",
      rows: [
        [{ type: "num", value: 1 }, { type: "unary", op: "-", arg: { type: "num", value: 2 } }],
        [{ type: "str", value: "a" }, { type: "bool", value: true }],
      ],
    });
  });

  it("reports syntax errors with their position", () => {
    const failures: [string, string, number][] = [
      ["", "The formula is empty.", 0],
      ["1 2", "Unexpected text after the end of the formula.", 2],
      ["1+", "The formula ends too early.", 2],
      ["*2", '"*" needs a value before it.', 0],
      ["A:1", "Unexpected text after the end of the formula.", 1],
      ["A:ZZZ", "A column range needs a second column, like A:C.", 2],
      ["2:2000000", "A row range needs a second row, like 2:5.", 2],
      ["(1", "A parenthesis is not closed.", 2],
      ["SUM(1", "The formula ends too early.", 5],
      ["sum(1,", "SUM is missing a closing parenthesis.", 0],
      ["SUM(1 2)", 'Expected "," or ")" in SUM.', 6],
      ["{1;2,3}", "Every row of an array constant needs the same number of items.", 0],
      ["{A1}", "Array constants can hold only numbers, text, and TRUE/FALSE.", 1],
      [")", 'Unexpected ")".', 0],
    ];
    for (const [source, error, position] of failures) expect([source, parseFormula(source)]).toEqual([source, { ok: false, error, position }]);
  });
});
