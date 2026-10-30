import { describe, expect, it } from "vitest";
import { DropdownLists } from "./dropdownLists";
import { SharedStrings } from "./sharedStrings";
import { WarningLog } from "./xml";

describe("the hidden dropdown-list sheet", () => {
  it("gives each distinct list its own column and reuses it for repeats", () => {
    const lists = new DropdownLists([{ id: "a", name: "Data", cells: {} }]);
    expect(lists.used).toBe(false);
    expect(lists.reference(["North", "South", "East"])).toBe("'Dropdown lists'!$A$1:$A$3");
    expect(lists.reference(["Yes, please", "No"])).toBe("'Dropdown lists'!$B$1:$B$2");
    expect(lists.reference(["North", "South", "East"])).toBe("'Dropdown lists'!$A$1:$A$3");
    expect(lists.used).toBe(true);
  });

  it("writes the lists column by column, ragged rows included", () => {
    const lists = new DropdownLists([]);
    lists.reference(["North", "South", "East"]);
    lists.reference(["Yes", "No"]);
    const strings = new SharedStrings(new WarningLog());
    const doc = new DOMParser().parseFromString(lists.sheetXml(strings), "application/xml");
    expect(doc.getElementsByTagName("dimension")[0].getAttribute("ref")).toBe("A1:B3");
    const rows = Array.from(doc.getElementsByTagName("row"), (row) => [row.getAttribute("r"), Array.from(row.getElementsByTagName("c"), (c) => c.getAttribute("r"))]);
    expect(rows).toEqual([["1", ["A1", "B1"]], ["2", ["A2", "B2"]], ["3", ["A3"]]]);
    const sst = new DOMParser().parseFromString(strings.toXml(), "application/xml");
    const texts = Array.from(sst.getElementsByTagName("t"), (t) => t.textContent);
    const valueAt = (ref: string) => texts[Number(Array.from(doc.getElementsByTagName("c")).find((c) => c.getAttribute("r") === ref)!.textContent)];
    expect([valueAt("A1"), valueAt("B2"), valueAt("A3")]).toEqual(["North", "No", "East"]);
  });

  it("avoids a sheet name the workbook already uses", () => {
    expect(new DropdownLists([{ id: "a", name: "Dropdown lists", cells: {} }]).sheetName).toBe("Dropdown lists (2)");
  });
});
