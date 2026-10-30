import { describe, expect, test } from "vitest";
import { parseMarkdownBlocks, replaceMarkdownTable, serializeMarkdownTable, type MarkdownTable } from "./markdown";

const REPLY = [
  "To build the matrix, which of these should it cover?",
  "",
  "| Focus | What it includes |",
  "| --- | ---: |",
  "| **State taxes** | Filing requirements |",
  "| Internal P&L | Margins by state |",
  "",
  "Tell me more about the entity.",
].join("\n");

function firstTable(content: string): MarkdownTable {
  const block = parseMarkdownBlocks(content).find((item) => item.kind === "table");
  if (!block || block.kind !== "table") throw new Error("no table");
  return { headers: block.headers, rows: block.rows, aligns: block.aligns };
}

describe("markdown tables as editable data", () => {
  test("an escaped pipe stays inside its cell", () => {
    const table = firstTable("| Plan | Price |\n| --- | --- |\n| Basic \\| Monthly | $10 |");
    expect(table.rows).toEqual([["Basic | Monthly", "$10"]]);
  });

  test("serializing writes pipes escaped, line breaks flattened, and alignments kept", () => {
    const text = serializeMarkdownTable({
      headers: ["Plan", "Price"],
      rows: [["Basic | Monthly", "$10\nper seat"]],
      aligns: [null, "right"],
    });
    expect(text).toBe("| Plan | Price |\n| --- | ---: |\n| Basic \\| Monthly | $10 per seat |");
    expect(firstTable(text)).toEqual({ headers: ["Plan", "Price"], rows: [["Basic | Monthly", "$10 per seat"]], aligns: [null, "right"] });
  });

  test("replacing a table rewrites only its lines and keeps the prose around it", () => {
    const previous = firstTable(REPLY);
    const next: MarkdownTable = {
      ...previous,
      headers: ["Focus", "What it includes", "Owner"],
      rows: [
        ["**State taxes**", "Filing requirements", "Tax"],
        ["Internal P&L", "Margins by state and region", "Finance"],
        ["Payroll", "Withholding", "HR"],
      ],
      aligns: [null, "right", "center"],
    };

    const updated = replaceMarkdownTable(REPLY, previous, next, 0);

    expect(updated).toBe(
      [
        "To build the matrix, which of these should it cover?",
        "",
        "| Focus | What it includes | Owner |",
        "| --- | ---: | :---: |",
        "| **State taxes** | Filing requirements | Tax |",
        "| Internal P&L | Margins by state and region | Finance |",
        "| Payroll | Withholding | HR |",
        "",
        "Tell me more about the entity.",
      ].join("\n"),
    );
    expect(firstTable(updated!)).toEqual(next);
  });

  test("the occurrence picks among identical tables, and a table inside a code fence is never touched", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const content = ["```md", table, "```", "", table, "", table].join("\n");
    const previous = firstTable(table);
    const next = { ...previous, rows: [["1", "3"]] };

    const updated = replaceMarkdownTable(content, previous, next, 1);

    expect(updated).toBe(["```md", table, "```", "", table, "", "| A | B |\n| --- | --- |\n| 1 | 3 |"].join("\n"));
  });

  test("without an occurrence, the first matching table is the one replaced", () => {
    const previous = firstTable(REPLY);
    const updated = replaceMarkdownTable(REPLY, previous, { ...previous, headers: ["Area", "What it includes"] });
    expect(updated).toContain("| Area | What it includes |");
  });

  test("returns null when the table is no longer in the reply", () => {
    const previous = firstTable(REPLY);
    expect(replaceMarkdownTable("No tables here.", previous, previous, 0)).toBeNull();
    expect(replaceMarkdownTable(REPLY, { ...previous, rows: [["x", "y"]] }, previous, 0)).toBeNull();
  });
});
