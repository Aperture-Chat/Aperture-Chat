import { describe, expect, it } from "vitest";
import { compareWorkbooks } from "./compare";
import { parseWorkbook } from "./sheetModel";

const book = (value: unknown) => {
  const parsed = parseWorkbook(value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.workbook;
};

describe("compareWorkbooks", () => {
  it("lists added, cleared, changed, and reformatted cells and sheet changes", () => {
    const before = book({ sheets: [
      { id: "a", name: "Data", cells: { A1: { v: "Units" }, A2: { v: 3 }, A3: { f: "A2*2" }, B1: { v: "x", s: { bold: true } } } },
      { id: "b", name: "Old", cells: {} },
    ] });
    const after = book({ sheets: [
      { id: "a", name: "Data 2027", cells: { A1: { v: "Units" }, A2: { v: 4 }, A4: { v: "new" }, B1: { v: "x" } } },
      { id: "c", name: "Summary", cells: { A1: { f: "SUM('Data 2027'!A2:A4)" } } },
    ] });
    const result = compareWorkbooks(before, after);
    expect(result.renamedSheets).toEqual([{ from: "Data", to: "Data 2027" }]);
    expect(result.removedSheets).toEqual(["Old"]);
    expect(result.addedSheets).toEqual(["Summary"]);
    expect(result.changes.map((change) => [change.sheet, change.address, change.kind, change.before, change.after])).toEqual([
      ["Data 2027", "B1", "formatted", "x", "x"],
      ["Data 2027", "A2", "changed", "3", "4"],
      ["Data 2027", "A3", "removed", "=A2*2", ""],
      ["Data 2027", "A4", "added", "", "new"],
      ["Summary", "A1", "added", "", "=SUM('Data 2027'!A2:A4)"],
    ]);
  });
});
