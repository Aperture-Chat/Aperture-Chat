import { describe, expect, it } from "vitest";
import { parseRangeRef } from "./address";
import { parseWorkbook, type Workbook } from "./sheetModel";
import { computeWorkbook } from "./recalc";
import { clearTableFills, formatRangeAsTable, hasOwnColors, nextTableName, regionForTable, restyledWorkbook, sharedTableLook, styleMeetsOwnColors, tableTargets } from "./tableStyles";

const R = (text: string) => parseRangeRef(text)!;

function workbookOf(sheets: unknown[]): Workbook {
  const parsed = parseWorkbook({ sheets });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.workbook;
}

const PAINTED = {
  A1: { v: "Item", s: { fill: "#123456", color: "#ffffff", bold: true } },
  B1: { v: "Qty", s: { fill: "#123456" } },
  A2: { v: "Pens" },
  B2: { v: 3, s: { format: "0", fill: "#ffff00" } },
  D1: { v: "Note", s: { fill: "#00ff00" } },
};

const table = (name: string, ref: string, accent = 1, tone = "medium") => ({ id: name, name, ref, accent, tone, banded: true, totals: false, filterButtons: true });

describe("nextTableName", () => {
  it("takes the first TableN no table uses, in any case, on any sheet", () => {
    expect(nextTableName(workbookOf([{ id: "a", name: "A", cells: {} }]))).toBe("Table1");
    const book = workbookOf([
      { id: "a", name: "A", cells: { A1: { v: "x" }, A2: { v: 1 } }, tables: [table("table1", "A1:A2")] },
      { id: "b", name: "B", cells: { A1: { v: "x" }, A2: { v: 1 } }, tables: [table("Table2", "A1:A2")] },
    ]);
    expect(nextTableName(book)).toBe("Table3");
  });
});

describe("formatRangeAsTable", () => {
  it("makes the range a banded table with filter buttons in the picked style, clearing the colors that would hide it", () => {
    const book = formatRangeAsTable(workbookOf([{ id: "a", name: "A", cells: PAINTED }]), "a", R("A1:B2"), { accent: 3, tone: "dark" })!;
    const sheet = book.sheets[0];
    expect(sheet.tables).toEqual([{ id: "Table1", name: "Table1", ref: "A1:B2", accent: 3, tone: "dark", banded: true, totals: false, filterButtons: true }]);
    expect([sheet.cells.A1.s, sheet.cells.B1.s, sheet.cells.B2.s]).toEqual([{ bold: true }, undefined, { format: "0" }]);
    expect(sheet.cells.D1.s).toEqual({ fill: "#00ff00" });
  });

  it("needs a header row and a data row, and never overlaps a table", () => {
    const plain = workbookOf([{ id: "a", name: "A", cells: PAINTED }]);
    expect(formatRangeAsTable(plain, "a", R("A1:B1"), { accent: 1, tone: "medium" })).toBeNull();
    expect(formatRangeAsTable(plain, "gone", R("A1:B2"), { accent: 1, tone: "medium" })).toBeNull();
    const tabled = workbookOf([{ id: "a", name: "A", cells: PAINTED, tables: [table("Sales", "A1:B2")] }]);
    expect(formatRangeAsTable(tabled, "a", R("B2:C3"), { accent: 1, tone: "medium" })).toBeNull();
    expect(formatRangeAsTable(tabled, "a", R("D1:E2"), { accent: 1, tone: "medium" })!.sheets[0].tables!.map((item) => item.name)).toEqual(["Sales", "Table1"]);
  });
});

describe("tables a restyle reaches", () => {
  const book = workbookOf([
    { id: "a", name: "A", cells: PAINTED, tables: [table("Sales", "A1:B2", 2, "light")] },
    { id: "b", name: "B", cells: { A1: { v: "x", s: { color: "#ff0000" } }, A2: { v: 1 } }, tables: [table("Notes", "A1:A2", 2, "light")] },
    { id: "c", name: "C", cells: { A1: { v: "plain" } } },
  ]);

  it("pick one table out of several on a sheet, and none for a name on another sheet", () => {
    const two = workbookOf([{ id: "a", name: "A", cells: PAINTED, tables: [table("Sales", "A1:B2"), table("Notes", "D1:D2")] }]);
    expect(tableTargets(two, { sheetId: "a", tableId: "Notes" })).toEqual([{ sheetId: "a", range: R("D1:D2") }]);
    expect(tableTargets(two, { sheetId: "b", tableId: "Notes" })).toEqual([]);
  });

  it("are one table, or every table in the workbook", () => {
    expect(tableTargets(book, { sheetId: "b", tableId: "Notes" })).toEqual([{ sheetId: "b", range: R("A1:A2") }]);
    expect(tableTargets(book)).toEqual([{ sheetId: "a", range: R("A1:B2") }, { sheetId: "b", range: R("A1:A2") }]);
  });

  it("clears fills and text colors inside them only, keeping other formatting", () => {
    const one = clearTableFills(book, { sheetId: "b", tableId: "Notes" });
    expect(one.sheets[1].cells.A1.s).toBeUndefined();
    expect(one.sheets[0].cells.A1.s).toEqual(PAINTED.A1.s);
    const every = clearTableFills(book);
    expect(every.sheets[0].cells.A1.s).toEqual({ bold: true });
    expect(every.sheets[0].cells.D1.s).toEqual({ fill: "#00ff00" });
    expect(every.sheets[2]).toBe(book.sheets[2]);
  });

  it("knows when a cell's own colors would hide a table style", () => {
    expect(hasOwnColors(book.sheets[0], R("A1:B2"))).toBe(true);
    expect(hasOwnColors(book.sheets[0], R("A2:A9"))).toBe(false);
    expect(hasOwnColors(book.sheets[1], R("A1:A2"))).toBe(true);
    expect(hasOwnColors(book.sheets[0], R("C1:C9"))).toBe(false);
  });

  it("names the style every table shares, or none when they differ", () => {
    expect(sharedTableLook(book)).toEqual({ accent: 2, tone: "light" });
    const mixed = workbookOf([{ id: "a", name: "A", cells: PAINTED, tables: [table("Sales", "A1:B2", 2, "light"), table("More", "D1:D2", 2, "dark")] }]);
    expect(sharedTableLook(mixed)).toBeNull();
    expect(sharedTableLook(workbookOf([{ id: "a", name: "A", cells: {} }]))).toBeNull();
    const lone = workbookOf([{ id: "a", name: "A", cells: PAINTED, tables: [table("Sales", "A1:B2", 6, "dark")] }]);
    expect(sharedTableLook(lone)).toEqual({ accent: 6, tone: "dark" });
  });
});

describe("restyledWorkbook", () => {
  const book = workbookOf([{ id: "a", name: "A", cells: PAINTED, tables: [table("Sales", "A1:B2")] }]);

  it("clears the colors hiding a table when its style changes, and keeps them for an option", () => {
    const styled = restyledWorkbook(book, { accent: 4 }, { sheetId: "a", tableId: "Sales" });
    expect(styled.sheets[0].tables![0].accent).toBe(4);
    expect(styled.sheets[0].cells.B1.s).toBeUndefined();
    expect(restyledWorkbook(book, { tone: "dark" }, undefined).sheets[0].cells.B1.s).toBeUndefined();
    const banded = restyledWorkbook(book, { banded: false }, { sheetId: "a", tableId: "Sales" });
    expect(banded.sheets[0].tables![0].banded).toBe(false);
    expect(banded.sheets[0].cells.B1.s).toEqual({ fill: "#123456" });
  });
});

describe("what a picked style reaches", () => {
  const data = workbookOf([{ id: "a", name: "A", cells: { ...PAINTED, A3: { v: "Pads" }, B3: { v: 5 }, F9: { v: "alone" } } }]);
  const engine = computeWorkbook(data);
  const at = (row: number, col: number) => ({ row, col });

  it("is the selection when it spans cells, else the data around the cursor, and needs two rows", () => {
    expect(regionForTable(engine, "a", R("A1:B3"), at(0, 0))).toEqual(R("A1:B3"));
    expect(regionForTable(engine, "a", R("A2"), at(1, 0))).toEqual(R("A1:B3"));
    expect(regionForTable(engine, "a", R("F9"), at(8, 5))).toBeNull();
    expect(regionForTable(engine, "a", R("H20"), at(19, 7))).toBeNull();
    expect(regionForTable(engine, "a", R("A2:C2"), at(1, 0))).toBeNull();
  });

  it("is the data around the cursor when the selection is whole columns or the whole sheet", () => {
    expect(regionForTable(engine, "a", R("A:B"), at(0, 0))).toEqual(R("A1:B3"));
    expect(regionForTable(engine, "a", R("1:3"), at(0, 0))).toEqual(R("A1:B3"));
    // A selection far down or far right is still just a selection.
    expect(regionForTable(engine, "a", R("A10000:B10001"), at(9999, 0))).toEqual(R("A10000:B10001"));
    expect(regionForTable(engine, "a", R("EA1:EB2"), at(0, 130))).toEqual(R("EA1:EB2"));
  });

  it("meets cells with their own colors in this table, every table, or the data to format", () => {
    const tabled = workbookOf([
      { id: "a", name: "A", cells: PAINTED, tables: [table("Sales", "A2:A3")] },
      { id: "b", name: "B", cells: { A1: { v: "x", s: { fill: "#ff0000" } }, A2: { v: 1 } }, tables: [table("Notes", "A1:A2")] },
    ]);
    const sales = tabled.sheets[0].tables![0];
    expect(styleMeetsOwnColors(tabled, "a", sales, null)).toBe(false);
    expect(styleMeetsOwnColors(tabled, "a", null, null)).toBe(true);
    expect(styleMeetsOwnColors(data, "a", null, R("A1:B3"))).toBe(true);
    expect(styleMeetsOwnColors(data, "a", null, R("A3:B3"))).toBe(false);
    expect(styleMeetsOwnColors(data, "a", null, null)).toBe(false);
  });
});
