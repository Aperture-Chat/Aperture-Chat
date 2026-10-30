import { describe, expect, it } from "vitest";
import type { Matrix } from "./formula/values";
import { sheetError } from "./formula/values";
import { computePivot, pivotSourceFields, pivotValueLabel } from "./pivot";
import type { SheetPivot } from "./sheetModel";

const SOURCE: Matrix = [
  ["Region", "Quarter", "Sales", "Rep"],
  ["East", "Q1", 10, "Ana"],
  ["West", "Q1", 4, "Bo"],
  ["East", "Q2", 6, "ana"],
  [null, "Q2", 5, "Cy"],
  ["East", "Q1", "n/a", ""],
  [null, null, null, null],
];

function spec(overrides: Partial<SheetPivot>): SheetPivot {
  return { id: "p1", name: "P", source: "A1:D7", at: "F1", rows: [], columns: [], values: [], filters: [], rowTotals: true, columnTotals: true, ...overrides };
}

describe("pivot computation", () => {
  it("rejects a missing field and an empty layout", () => {
    expect(computePivot(spec({ rows: ["Nope"] }), SOURCE)).toEqual(sheetError("#REF!", 'The pivot source has no column named "Nope".'));
    expect(computePivot(spec({ filters: [{ field: "Gone", include: [] }], rows: ["Region"] }), SOURCE)).toEqual(sheetError("#REF!", 'The pivot source has no column named "Gone".'));
    expect(computePivot(spec({}), SOURCE)).toEqual(sheetError("#CALC!", "Add a row, column, or value field to build the pivot table."));
  });

  it("groups rows with one value field, sorting blanks last and totalling", () => {
    const out = computePivot(spec({ rows: ["region"], values: [{ field: "Sales", agg: "sum" }] }), SOURCE, (index) => (index === 2 ? "$#,##0" : `f${index}`));
    expect(out).toEqual({
      values: [["Region", "Sum of Sales"], ["East", 16], ["West", 4], ["(blank)", 5], ["Grand Total", 25]],
      headerRows: 1,
      labelCols: 1,
      totalRow: true,
      totalCols: 0,
      columnFormats: ["f0", "$#,##0"],
    });
  });

  it("lays out column groups with one value, right totals, and the value caption", () => {
    const out = computePivot(spec({ rows: ["Region"], columns: ["Quarter"], values: [{ field: "Sales", agg: "max" }] }), SOURCE);
    expect(out).toMatchObject({
      values: [
        ["Max of Sales", "Quarter", null, null],
        ["Region", "Q1", "Q2", "Grand Total"],
        ["East", 10, 6, 10],
        ["West", 4, null, 4],
        ["(blank)", null, 5, 5],
        ["Grand Total", 10, 6, 10],
      ],
      headerRows: 2,
      labelCols: 1,
      totalRow: true,
      totalCols: 1,
    });
  });

  it("lays out several values per column group with labelled totals", () => {
    const out = computePivot(
      spec({ rows: ["Region"], columns: ["Quarter"], values: [{ field: "Sales", agg: "count" }, { field: "Rep", agg: "countDistinct", label: " Reps " }], rowTotals: false }),
      SOURCE,
      () => "0.0",
    );
    expect(out).toEqual({
      values: [
        [null, "Quarter", null, null, null, null, null],
        [null, "Q1", null, "Q2", null, "Grand Total", null],
        ["Region", "Count of Sales", "Reps", "Count of Sales", "Reps", "Total Count of Sales", "Total Reps"],
        ["East", 2, 1, 1, 1, 3, 1],
        ["West", 1, 1, null, null, 1, 1],
        ["(blank)", null, null, 1, 1, 1, 1],
      ],
      headerRows: 3,
      labelCols: 1,
      totalRow: false,
      totalCols: 2,
      columnFormats: ["0.0", undefined, undefined, undefined, undefined, undefined, undefined],
    });
  });

  it("pivots columns only, with or without values", () => {
    const withValues = computePivot(spec({ columns: ["Quarter"], values: [{ field: "Sales", agg: "average" }], columnTotals: false }), SOURCE);
    expect(withValues).toMatchObject({
      values: [["Average of Sales", "Quarter", null], ["", "Q1", "Q2"], ["Grand Total", 7, 5.5], ["Grand Total", 7, 5.5]],
      totalCols: 0,
    });
    const labelsOnly = computePivot(spec({ rows: ["Rep"], columns: ["Quarter"] }), SOURCE);
    // Without value fields the grid is one label column wide; column labels run past it.
    expect(labelsOnly).toEqual({
      values: [[null, "Quarter"], ["Rep", "Q1", "Q2"], ["Ana"], ["Bo"], ["Cy"], ["(blank)"]],
      headerRows: 2,
      labelCols: 1,
      totalRow: false,
      totalCols: 0,
      columnFormats: [undefined],
    });
  });

  it("shows only grand totals with value fields and no row or column fields", () => {
    const out = computePivot(spec({ values: [{ field: "Sales", agg: "min" }, { field: "Region", agg: "sum" }] }), SOURCE);
    expect(out).toMatchObject({ values: [["", "Min of Sales", "Sum of Region"], ["Grand Total", 4, 0], ["Grand Total", 4, 0]], labelCols: 1, totalRow: true });
  });

  it("keeps only records whose filtered fields are included", () => {
    const out = computePivot(spec({ rows: ["Rep"], values: [{ field: "Sales", agg: "sum" }], filters: [{ field: "Region", include: ["EAST", "(blank)"] }] }), SOURCE);
    expect(out).toMatchObject({ values: [["Rep", "Sum of Sales"], ["Ana", 16], ["Cy", 5], ["(blank)", 0], ["Grand Total", 21]] });
  });

  it("refuses output beyond the size limits", () => {
    const wide: Matrix = [["Key", "N"], ...Array.from({ length: 250 }, (_, n) => [`k${n}`, n])];
    expect(computePivot(spec({ columns: ["Key"], values: [{ field: "N", agg: "sum" }] }), wide)).toEqual(
      sheetError("#CALC!", "The pivot table has too many groups. Add a filter or use fewer fields."),
    );
    const tall: Matrix = [["Key"], ...Array.from({ length: 5000 }, (_, n) => [n])];
    expect(computePivot(spec({ rows: ["Key"] }), tall)).toEqual(sheetError("#CALC!", "The pivot table has too many groups. Add a filter or use fewer fields."));
  });

  it("reads field names and value labels", () => {
    expect(pivotSourceFields([[" A ", null, 3, sheetError("#N/A")]])).toEqual(["A", "", "3", ""]);
    expect(pivotSourceFields([])).toEqual([]);
    expect(pivotValueLabel({ field: "Sales", agg: "countDistinct", label: "  " })).toBe("Distinct count of Sales");
  });
});
