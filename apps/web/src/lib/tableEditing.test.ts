import { describe, expect, test } from "vitest";
import type { MarkdownTable } from "./markdown";
import {
  canDeleteColumn,
  canDeleteRow,
  deleteTableColumn,
  deleteTableRow,
  inlineHtmlToMarkdown,
  insertTableColumn,
  insertTableRow,
  moveTableCell,
  setTableCell,
  tableCellText,
} from "./tableEditing";

const TABLE: MarkdownTable = {
  headers: ["Focus", "Includes"],
  rows: [
    ["**Taxes**", "Filing"],
    ["P&L", "Margins"],
  ],
  aligns: [null, "right"],
};

describe("table edits", () => {
  test("a cell edit changes that cell only, header or body", () => {
    expect(setTableCell(TABLE, { row: -1, col: 1 }, "What it includes").headers).toEqual(["Focus", "What it includes"]);
    expect(setTableCell(TABLE, { row: 1, col: 0 }, "Internal P&L").rows).toEqual([
      ["**Taxes**", "Filing"],
      ["Internal P&L", "Margins"],
    ]);
    expect(TABLE.rows[1]![0]).toBe("P&L");
    expect(tableCellText(TABLE, { row: -1, col: 0 })).toBe("Focus");
    expect(tableCellText(TABLE, { row: 0, col: 0 })).toBe("**Taxes**");
    // A cell past the table's edge (a row just deleted) reads as empty.
    expect(tableCellText(TABLE, { row: 5, col: 0 })).toBe("");
    expect(tableCellText(TABLE, { row: -1, col: 9 })).toBe("");
  });

  test("rows are added below the chosen cell (the header adds a first row) and removed down to one", () => {
    expect(insertTableRow(TABLE, 0).rows).toEqual([["**Taxes**", "Filing"], ["", ""], ["P&L", "Margins"]]);
    expect(insertTableRow(TABLE, -1).rows[0]).toEqual(["", ""]);
    const one = deleteTableRow(TABLE, 0);
    expect(one.rows).toEqual([["P&L", "Margins"]]);
    expect(canDeleteRow(TABLE, { row: 0, col: 0 })).toBe(true);
    expect(canDeleteRow(one, { row: 0, col: 0 })).toBe(false);
    expect(canDeleteRow(TABLE, { row: -1, col: 0 })).toBe(false);
  });

  test("columns are added to the right with their alignment slot and removed down to two", () => {
    const wider = insertTableColumn(TABLE, 0);
    expect(wider.headers).toEqual(["Focus", "New column", "Includes"]);
    expect(wider.rows[0]).toEqual(["**Taxes**", "", "Filing"]);
    expect(wider.aligns).toEqual([null, null, "right"]);
    expect(canDeleteColumn(wider)).toBe(true);
    const back = deleteTableColumn(wider, 1);
    expect(back).toEqual(TABLE);
    expect(canDeleteColumn(TABLE)).toBe(false);
    // With three columns, "right of the first" is second, never before the last.
    const three = insertTableColumn(wider, 0);
    expect(three.headers).toEqual(["Focus", "New column", "New column", "Includes"]);
    expect(insertTableColumn(back, 1).headers).toEqual(["Focus", "Includes", "New column"]);
  });

  test("keyboard movement walks cells like a spreadsheet and stops at the edges", () => {
    expect(moveTableCell(TABLE, { row: -1, col: 1 }, "next")).toEqual({ row: 0, col: 0 });
    expect(moveTableCell(TABLE, { row: 0, col: 0 }, "previous")).toEqual({ row: -1, col: 1 });
    expect(moveTableCell(TABLE, { row: 0, col: 1 }, "down")).toEqual({ row: 1, col: 1 });
    expect(moveTableCell(TABLE, { row: 0, col: 1 }, "up")).toEqual({ row: -1, col: 1 });
    expect(moveTableCell(TABLE, { row: 1, col: 1 }, "next")).toBeNull();
    expect(moveTableCell(TABLE, { row: 1, col: 0 }, "down")).toBeNull();
    expect(moveTableCell(TABLE, { row: -1, col: 0 }, "up")).toBeNull();
    // The first and last cells are reachable; only past them is the edge.
    expect(moveTableCell(TABLE, { row: -1, col: 1 }, "previous")).toEqual({ row: -1, col: 0 });
    expect(moveTableCell(TABLE, { row: -1, col: 0 }, "previous")).toBeNull();
    expect(moveTableCell(TABLE, { row: 1, col: 0 }, "next")).toEqual({ row: 1, col: 1 });
  });
});

function editor(html: string) {
  const element = document.createElement("span");
  element.innerHTML = html;
  return element;
}

describe("inlineHtmlToMarkdown", () => {
  test("keeps bold, italics, code, and safe links as markdown", () => {
    expect(
      inlineHtmlToMarkdown(
        editor('<strong>State</strong> taxes, <em>losses</em>, <code>1099</code> and <a href="https://irs.gov">IRS</a>'),
      ),
    ).toBe("**State** taxes, *losses*, `1099` and [IRS](https://irs.gov)");
  });

  test("reads the browser's own bold and italic tags and keeps spaces outside the markers", () => {
    expect(inlineHtmlToMarkdown(editor("<b>Bold </b>and<i> italic</i>"))).toBe("**Bold** and *italic*");
  });

  test("flattens line breaks and blocks to spaces and drops empty formatting", () => {
    expect(inlineHtmlToMarkdown(editor("One<br>two<div>three</div><strong> </strong>&nbsp;four"))).toBe(
      "One two three four",
    );
  });

  test("never writes a link to anything but a web or platform address", () => {
    expect(inlineHtmlToMarkdown(editor('<a href="javascript:alert(1)">click</a>'))).toBe("click");
  });
});
