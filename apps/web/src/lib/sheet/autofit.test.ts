import { describe, expect, it } from "vitest";
import { MAX_SHEET_COLS, MAX_SHEET_ROWS } from "./address";
import { fitRowHeights, fittedRowHeight, headerSpan } from "./autofit";
import { computeWorkbook } from "./recalc";
import { type Sheet, type Workbook, parseWorkbook } from "./sheetModel";

/** 7px a character, as jsdom's canvas fallback measures. */
const measure = (text: string) => text.length * 7;

const WHOLE_COLS_B_TO_D = { r1: 0, r2: MAX_SHEET_ROWS - 1, c1: 1, c2: 3 };
const WHOLE_ROWS_2_TO_4 = { r1: 1, r2: 3, c1: 0, c2: MAX_SHEET_COLS - 1 };

describe("headerSpan", () => {
  it("acts on the whole selected run when the edge belongs to selected whole columns", () => {
    expect(headerSpan("cols", 1, WHOLE_COLS_B_TO_D)).toEqual([1, 3]);
    expect(headerSpan("cols", 2, WHOLE_COLS_B_TO_D)).toEqual([1, 3]);
    expect(headerSpan("cols", 3, WHOLE_COLS_B_TO_D)).toEqual([1, 3]);
  });

  it("acts on one column outside the run, or when the selection is not whole columns", () => {
    expect(headerSpan("cols", 0, WHOLE_COLS_B_TO_D)).toEqual([0, 0]);
    expect(headerSpan("cols", 4, WHOLE_COLS_B_TO_D)).toEqual([4, 4]);
    expect(headerSpan("cols", 2, { ...WHOLE_COLS_B_TO_D, r1: 1 })).toEqual([2, 2]);
    expect(headerSpan("cols", 2, { ...WHOLE_COLS_B_TO_D, r2: MAX_SHEET_ROWS - 2 })).toEqual([2, 2]);
  });

  it("does the same for rows", () => {
    expect(headerSpan("rows", 1, WHOLE_ROWS_2_TO_4)).toEqual([1, 3]);
    expect(headerSpan("rows", 3, WHOLE_ROWS_2_TO_4)).toEqual([1, 3]);
    expect(headerSpan("rows", 0, WHOLE_ROWS_2_TO_4)).toEqual([0, 0]);
    expect(headerSpan("rows", 4, WHOLE_ROWS_2_TO_4)).toEqual([4, 4]);
    expect(headerSpan("rows", 2, { ...WHOLE_ROWS_2_TO_4, c1: 1 })).toEqual([2, 2]);
    expect(headerSpan("rows", 2, { ...WHOLE_ROWS_2_TO_4, c2: MAX_SHEET_COLS - 2 })).toEqual([2, 2]);
  });
});

describe("fittedRowHeight", () => {
  it("gives one 10pt line the default 24px row", () => {
    expect(fittedRowHeight("Revenue", undefined, 100, measure)).toBe(24);
  });

  it("adds a line for each line break, and grows with the font size", () => {
    expect(fittedRowHeight("one\ntwo\nthree", undefined, 100, measure)).toBe(56);
    expect(fittedRowHeight("Title", { size: 20 }, 100, measure)).toBe(40);
  });

  it("wraps long text to the column, counting a blank line as a line", () => {
    // 40 characters = 280px in a 92px text area: 4 lines.
    expect(fittedRowHeight("x".repeat(40), { wrap: true }, 100, measure)).toBe(72);
    // 80 characters = 560px in a 292px text area: 2 lines.
    expect(fittedRowHeight("x".repeat(80), { wrap: true }, 300, measure)).toBe(40);
    expect(fittedRowHeight("a\n\nb", { wrap: true }, 100, measure)).toBe(56);
  });
});

function sheetOf(input: unknown): { workbook: Workbook; sheet: Sheet } {
  const parsed = parseWorkbook(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return { workbook: parsed.workbook, sheet: parsed.workbook.sheets[0] };
}

function fit(workbook: Workbook, sheet: Sheet, r1: number, r2: number, lastCol: number) {
  const engine = computeWorkbook(workbook);
  return fitRowHeights(workbook, sheet, { r1, r2, lastCol }, (row, col) => engine.value(sheet.id, row, col), measure).sheets[0];
}

describe("fitRowHeights", () => {
  it("sets each row to its tallest cell and clears rows that fit the default", () => {
    const { workbook, sheet } = sheetOf({
      sheets: [{ id: "s", name: "Notes", cells: { A1: { v: "short" }, B1: { v: "x".repeat(40), s: { wrap: true } }, A2: { v: "plain" } }, rows: { "2": { h: 80 } } }],
    });
    const fitted = fit(workbook, sheet, 0, 1, 1);
    expect(fitted.rows?.["1"]?.h).toBe(72);
    expect(fitted.rows?.["2"]).toBeUndefined();
  });

  it("uses each column's own width", () => {
    const { workbook, sheet } = sheetOf({
      sheets: [{ id: "s", name: "Notes", cells: { B1: { v: "x".repeat(80), s: { wrap: true } } }, cols: { B: { w: 300 } } }],
    });
    expect(fit(workbook, sheet, 0, 0, 1).rows?.["1"]?.h).toBe(40);
  });

  it("reads widths from a sheet that has none set", () => {
    const { workbook, sheet } = sheetOf({ sheets: [{ id: "s", name: "Notes", cells: { A1: { v: "x".repeat(40), s: { wrap: true } } } }] });
    const bare: Sheet = { ...sheet, cols: undefined };
    expect(fit({ ...workbook, sheets: [bare] }, bare, 0, 0, 0).rows?.["1"]?.h).toBe(72);
  });

  it("ignores merged cells, as Excel's AutoFit does", () => {
    const { workbook, sheet } = sheetOf({
      sheets: [{ id: "s", name: "Notes", cells: { A1: { v: "x".repeat(40), s: { wrap: true } } }, merges: ["A1:C1"] }],
    });
    expect(fit(workbook, sheet, 0, 0, 2).rows?.["1"]).toBeUndefined();
  });

  it("looks only as far right as the last used column", () => {
    const { workbook, sheet } = sheetOf({ sheets: [{ id: "s", name: "Notes", cells: { C1: { v: "x".repeat(40), s: { wrap: true } } } }] });
    expect(fit(workbook, sheet, 0, 0, 1).rows?.["1"]).toBeUndefined();
    expect(fit(workbook, sheet, 0, 0, 2).rows?.["1"]?.h).toBe(72);
  });
});
