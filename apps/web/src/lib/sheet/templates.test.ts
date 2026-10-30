import { describe, expect, it } from "vitest";
import { computeWorkbook } from "./recalc";
import { SHEET_TEMPLATES, buildSheetTemplate } from "./templates";

describe("spreadsheet templates", () => {
  it.each(SHEET_TEMPLATES.map((template) => [template.name, template] as const))("%s applies cleanly with no formula errors", (_name, template) => {
    const { workbook, warnings } = buildSheetTemplate(template);
    expect(warnings).toEqual([]);
    const engine = computeWorkbook(workbook, { now: new Date(2027, 3, 1) });
    expect(engine.formulaProblems().map((problem) => `${problem.sheetName}!${problem.address} =${problem.formula} ${problem.error.code} ${problem.error.message ?? ""}`)).toEqual([]);
    expect(workbook.sheets.some((sheet) => Object.keys(sheet.cells).length > 5)).toBe(true);
  });

  it("computes the numbers a reader would check", () => {
    const loan = buildSheetTemplate(SHEET_TEMPLATES.find((template) => template.id === "loan")!).workbook;
    const engine = computeWorkbook(loan);
    const payment = engine.value(loan.sheets[0].id, 6, 1) as number;
    expect(payment).toBeCloseTo(624.62, 2);
    const finalBalance = engine.value(loan.sheets[0].id, 69, 5) as number;
    expect(finalBalance).toBeCloseTo(0, 2);
    const invoice = buildSheetTemplate(SHEET_TEMPLATES.find((template) => template.id === "invoice")!).workbook;
    const due = computeWorkbook(invoice).value(invoice.sheets[0].id, 19, 4) as number;
    expect(due).toBeCloseTo((1800 + 12 * 140 + 18 * 155 + 6 * 120) * 1.07, 2);
  });
});
