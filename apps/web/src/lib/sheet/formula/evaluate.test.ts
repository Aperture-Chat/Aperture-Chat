import { describe, expect, it } from "vitest";
import { Evaluator, evaluateFormula, isRefResult, type FunctionTable } from "./evaluate";
import { parseFormula, type FormulaNode } from "./parser";
import type { EvalHost, RangeRef } from "./types";
import { isError, sheetError, type Value } from "./values";

/** A 3×3 grid: A1=1 B1=2 C1="x", A2=3 B2=#N/A C2=TRUE, row 3 empty. */
const GRID: Value[][] = [[1, 2, "x"], [3, sheetError("#N/A"), true], [null, null, null]];

function host(): EvalHost & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    cell: (sheet, row, col) => {
      reads.push(`${sheet ?? ""}!${row},${col}`);
      return (GRID[row]?.[col] ?? null) as never;
    },
    range: (ref) => (ref.sheet === "Gone" ? sheetError("#REF!") : GRID.slice(ref.r1, ref.r2 + 1).map((line) => line.slice(ref.c1, ref.c2 + 1)) as never),
    resolveName: (name) => ({ rate: { sheet: null, r1: 0, c1: 1, r2: 0, c2: 1 }, block: { sheet: null, r1: 0, c1: 0, r2: 1, c2: 1 } } as Record<string, RangeRef>)[name.toLowerCase()] ?? null,
    resolveTable: (table) => (table === "T" ? { sheet: null, r1: 0, c1: 0, r2: 1, c2: 0 } : sheetError("#REF!", "no table")),
    current: { sheet: "S", row: 4, col: 4 },
    now: 0,
    random: () => 0.5,
  };
}

const seen: { refs: (RangeRef | undefined)[] }[] = [];
const FUNCTIONS: FunctionTable = {
  ONE: { min: 1, max: 1, fn: (args) => args[0] },
  PAIR: { min: 2, max: 2, fn: ([a, b]) => `${String(a)}|${String(b)}` },
  SOME: { min: 1, max: 3, fn: (args) => args.length },
  MANY: { min: 0, max: Infinity, fn: (args, ctx) => { seen.push({ refs: ctx.refs }); return args.length; } },
  NOFN: { min: 0, max: 0 },
  LETX: { min: 2, max: 2, lazy: (args, ctx) => ctx.evaluateWith(new Map([["X", ctx.evaluate(args[0])]]), args[1]) },
  OFFSET: { min: 1, max: 1, lazy: (args, ctx) => { const ref = ctx.reference(args[0]); return ref && !isError(ref) ? { ref: { ...ref, r1: ref.r1 + 1, r2: ref.r2 + 1 } } : sheetError("#VALUE!"); } },
  PLAIN: { min: 1, max: 1, lazy: () => 42 },
};

function run(formula: string, h = host()): unknown {
  const parsed = parseFormula(formula);
  if (!parsed.ok) throw new Error(parsed.error);
  const value = evaluateFormula(parsed.ast, h, FUNCTIONS);
  return isError(value) ? `${value.code}${value.message ? ` ${value.message}` : ""}` : value;
}

describe("evaluator operators", () => {
  it("does arithmetic with Excel's error rules", () => {
    expect(["1+2", "5-7", "3*4", "7/2", "2^10", "-2^2", "50%", "+A1", "1/0", "0^0", "0^-1", "10^400", '"3"*2', '"x"*2', "B2+1", "1+B2", "A1:B1*2"].map((formula) => run(formula))).toEqual([
      3, -2, 12, 3.5, 1024, 4, 0.5, 1, "#DIV/0! Division by zero.", "#NUM! The number is out of range.", "#DIV/0! Division by zero.", "#NUM! The number is out of range.", 6, '#VALUE! "x" is not a number.', "#N/A", "#N/A", [[2, 4]],
    ]);
  });

  it("compares and concatenates, propagating errors", () => {
    expect(["1=1", "1<>1", "1<2", "1>2", "2<=2", "1>=2", '"a"="A"', "B2=1", "1<B2", '"a"&1', "A1&B2", "B2&1", "{1,2}=1"].map((formula) => run(formula))).toEqual([
      true, false, true, false, true, false, true, "#N/A", "#N/A", "a1", "#N/A", "#N/A", [[true, false]],
    ]);
  });

  it("negates and takes percent element by element", () => {
    expect(run("-A1:B1")).toEqual([[-1, -2]]);
    expect(run("A1:A2%")).toEqual([[0.01], [0.03]]);
    expect(run('-"x"')).toBe('#VALUE! "x" is not a number.');
    expect(run("-B2")).toBe("#N/A");
  });
});

describe("evaluator leaves", () => {
  it("reads literals, cells, ranges, arrays, and empty arguments", () => {
    expect(["7", '"t"', "TRUE", "#DIV/0!", "A2", "C2", "A3", "Other!A1"].map((formula) => run(formula))).toEqual([7, "t", true, "#DIV/0!", 3, true, null, 1]);
    expect(run("A1:C2")).toEqual([[1, 2, "x"], [3, sheetError("#N/A"), true]]);
    expect(run("Gone!A1:B2")).toBe("#REF!");
    expect(run('{1,3;-2,"q"}')).toEqual([[1, 3], [-2, "q"]]);
    expect(run("PAIR(,)")).toBe("null|null");
  });

  it("resolves LET bindings before defined names and reports unknown names", () => {
    expect(run("Rate")).toBe(2);
    expect(run("Block")).toEqual([[1, 2], [3, sheetError("#N/A")]]);
    expect(run("Nope")).toBe('#NAME? "Nope" is not a known name.');
    expect(run("LETX(5,x*2)")).toBe(10);
    expect(run("LETX(5,LETX(x+1,x*10))")).toBe(60);
    expect(run("LETX(5,Rate)")).toBe(2);
  });

  it("reads structured references through the host", () => {
    expect(run("T[Col]")).toEqual([[1], [3]]);
    expect(run("U[Col]")).toBe("#REF! no table");
  });
});

describe("evaluator calls", () => {
  it("checks argument counts with a readable message", () => {
    expect(run("ONE()")).toBe("#VALUE! ONE takes 1 argument.");
    expect(run("PAIR(1)")).toBe("#VALUE! PAIR takes 2 arguments.");
    expect(run("SOME(1,2,3,4)")).toBe("#VALUE! SOME takes 1 to 3 arguments.");
    expect(run("NOPE(1)")).toBe("#NAME? NOPE is not a function Aperture knows.");
    expect(run("NOFN()")).toBe("#CALC! The calculation could not finish.");
    expect(run("SOME(1,2)")).toBe(2);
  });

  it("passes the reference behind each reference argument to eager functions", () => {
    seen.length = 0;
    expect(run("MANY(A1, A1:B2, Rate, T[x], Nope, U[x], 1, OFFSET(A1))")).toBe(8);
    // Unknown names and tables, literals, and calls leave no reference behind.
    expect(seen[0].refs).toEqual([
      { sheet: null, r1: 0, c1: 0, r2: 0, c2: 0 },
      { sheet: null, r1: 0, c1: 0, r2: 1, c2: 1 },
      { sheet: null, r1: 0, c1: 1, r2: 0, c2: 1 },
      { sheet: null, r1: 0, c1: 0, r2: 1, c2: 0 },
    ]);
  });

  it("reads the reference a lazy function returns and resolves lazy references", () => {
    expect(run("OFFSET(A1)")).toBe(3);
    expect(run("OFFSET(1)")).toBe("#VALUE!");
    expect(run("PLAIN(A1)")).toBe(42);
    const evaluator = new Evaluator(host(), FUNCTIONS);
    const node = (formula: string) => (parseFormula(formula) as { ast: FormulaNode }).ast;
    expect(evaluator.reference(node("OFFSET(B1)"))).toEqual({ sheet: null, r1: 1, c1: 1, r2: 1, c2: 1 });
    expect(evaluator.reference(node("PLAIN(B1)"))).toBeNull();
    expect(evaluator.reference(node("ONE(B1)"))).toBeNull();
    expect(evaluator.reference(node("Data!B1:C2"))).toEqual({ sheet: "Data", r1: 0, c1: 1, r2: 1, c2: 2 });
    expect(evaluator.reference(node("U[x]"))).toMatchObject({ code: "#REF!" });
    expect(evaluator.reference(node("Nope"))).toBeNull();
    expect(evaluator.reference(node("1+1"))).toBeNull();
    expect(isRefResult({ ref: {} })).toBe(true);
    expect([isRefResult(null), isRefResult([1]), isRefResult(sheetError("#REF!")), isRefResult({ other: 1 })]).toEqual([false, false, false, false]);
  });

  it("stops formulas that nest too deeply", () => {
    expect(run(`${"-".repeat(450)}1`)).toBe("#CALC! The formula nests too deeply.");
    expect(run(`${"-".repeat(398)}1`)).toBe(1);
  });
});
