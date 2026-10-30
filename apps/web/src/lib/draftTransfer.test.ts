import { describe, expect, test } from "vitest";
import { cellKey } from "./sheet/address";
import { parseWorkbook } from "./sheet/sheetModel";
import { plainCellText, suggestDraftFormat, transferTableCount, workbookFromMarkdown } from "./draftTransfer";

const MATRIX_REPLY = [
  "To build the state-by-state P&L matrix, which of these should the matrix cover?",
  "",
  "| Focus | What the state-by-state matrix would include |",
  "| --- | --- |",
  "| **State taxes and compliance** | Taxes affecting profit, filing requirements, treatment of losses |",
  "| **Internal P&L management** | Rules for assigning revenue, allocating expenses, tracking margins |",
  "| **Multistate operations** | How to organize state-level P&Ls |",
  "| **Combined practical guide** | Management practices alongside state-specific tax considerations |",
  "",
  "What type of business and entity are you working with?",
].join("\n");

const REPORT = [
  "# Remote work policy",
  "",
  "Our company supports flexible work for every team that can do its job away from the office. ".repeat(6),
  "",
  "## Eligibility",
  "",
  "Employees who have finished onboarding may work remotely up to three days a week. ".repeat(5),
  "",
  "| Role | Days |",
  "| --- | --- |",
  "| Engineer | 3 |",
  "",
  "## Equipment",
  "",
  "The company provides a laptop, a monitor, and a monthly stipend for internet service. ".repeat(5),
].join("\n");

const SLIDES = [
  "## Slide 1: Why we are here",
  "- Q3 revenue grew 12%",
  "## Slide 2: What changed",
  "- New pricing",
  "## Slide 3: Next steps",
  "- Hire two engineers",
].join("\n");

describe("suggestDraftFormat", () => {
  test("follows the request when it named a spreadsheet, deck, or document", () => {
    expect(suggestDraftFormat(MATRIX_REPLY, "Create a state-by-state matrix for P&L management")).toBe("spreadsheet");
    expect(suggestDraftFormat(MATRIX_REPLY, "Make a slide deck for the board about state P&L")).toBe("deck");
    expect(suggestDraftFormat(SLIDES, "Write a report on Q3")).toBe("document");
  });

  test("otherwise reads the reply: mostly table is a spreadsheet, slides are a deck, prose is a document", () => {
    expect(suggestDraftFormat(MATRIX_REPLY)).toBe("spreadsheet");
    expect(suggestDraftFormat(MATRIX_REPLY, "What should I think about for multistate operations?")).toBe("spreadsheet");
    expect(suggestDraftFormat(SLIDES)).toBe("deck");
    expect(suggestDraftFormat("**Slide 1 — Title**\n\nIntro\n\n**Slide 2 — Agenda**\n\n- One")).toBe("deck");
    expect(suggestDraftFormat(REPORT)).toBe("document");
    expect(suggestDraftFormat("Just a short answer.")).toBe("document");
    expect(suggestDraftFormat("## Slide 1: only one heading named like a slide\n\nText")).toBe("document");
  });

  test("a table that is at least half the reply's text tips it to a spreadsheet; nothing at all is a document", () => {
    // "A B" (3 characters of table) against "abc" (3 of prose): half and half.
    expect(suggestDraftFormat("abc\n\n| A | B |\n| --- | --- |")).toBe("spreadsheet");
    expect(suggestDraftFormat("abcd\n\n| A | B |\n| --- | --- |")).toBe("document");
    expect(suggestDraftFormat("")).toBe("document");
  });
});

describe("plainCellText", () => {
  test("strips inline markdown and citation markers to what a cell should hold", () => {
    expect(plainCellText("**State taxes** and *losses* [K1]")).toBe("State taxes and losses");
    expect(plainCellText("See [IRS guidance](https://irs.gov) and `Form 1120`")).toBe("See IRS guidance and Form 1120");
    expect(plainCellText("![chart](https://x.test/c.png) Growth \\(x^2\\)")).toBe("chart Growth x^2");
    expect(plainCellText("snake_case_name stays")).toBe("snake_case_name stays");
  });
});

describe("workbookFromMarkdown", () => {
  test("each table becomes a sheet named for its heading, with a bold frozen header and typed values", () => {
    const content = [
      "## Revenue by state",
      "",
      "| State | Revenue | Margin |",
      "| --- | ---: | ---: |",
      "| **Texas** | $1,200 | 12% |",
      "| Ohio **north** | 950 | 8.5% |",
      "",
      "## History",
      "",
      "| Year | Note |",
      "| --- | --- |",
      "| 2024 | Opened the Austin office, which took most of the year to staff and set up. |",
    ].join("\n");

    const { workbook, tables } = workbookFromMarkdown(content);

    expect(tables).toBe(2);
    expect(parseWorkbook(workbook).ok).toBe(true);
    const [revenue, history] = workbook.sheets;
    expect(revenue!.name).toBe("Revenue by state");
    expect(history!.name).toBe("History table");
    expect(revenue!.freeze).toEqual({ rows: 1, cols: 0 });
    expect(revenue!.cells[cellKey(0, 0)]).toMatchObject({ v: "State", s: { bold: true } });
    // A cell bold from end to end in the reply stays bold; partly bold text does not.
    expect(revenue!.cells[cellKey(1, 0)]).toMatchObject({ v: "Texas", s: { bold: true } });
    expect(revenue!.cells[cellKey(2, 0)]?.s?.bold).toBeUndefined();
    expect(revenue!.cells[cellKey(1, 1)]).toMatchObject({ v: 1200, s: { align: "right" } });
    expect(revenue!.cells[cellKey(1, 1)]?.s?.format).toBeTruthy();
    expect(revenue!.cells[cellKey(2, 2)]?.v).toBeCloseTo(0.085);
    expect(revenue!.cells[cellKey(2, 0)]?.v).toBe("Ohio north");
    expect(history!.cells[cellKey(1, 1)]?.s?.wrap).toBe(true);
    expect(history!.cols?.B?.w).toBeGreaterThan(history!.cols?.A?.w ?? 0);
  });

  test("columns are sized to their longest text within limits, and text past 40 characters wraps", () => {
    const forty = "x".repeat(40);
    const content = `| Year | Revenue by quarter | Note |\n| --- | --- | --- |\n| 2024 | ${forty} | ${forty}y |`;
    const sheet = workbookFromMarkdown(content).workbook.sheets[0]!;
    expect(sheet.cols?.A?.w).toBe(64);
    // 40 characters: 40 × 7 + 16.
    expect(sheet.cols?.B?.w).toBe(296);
    expect(sheet.cols?.C?.w).toBe(303);
    expect(sheet.cells[cellKey(1, 1)]?.s?.wrap).toBeUndefined();
    expect(sheet.cells[cellKey(1, 2)]?.s?.wrap).toBe(true);
    const wide = workbookFromMarkdown(`| A | B |\n| --- | --- |\n| ${"y".repeat(60)} | 1 |`).workbook.sheets[0]!;
    expect(wide.cols?.A?.w).toBe(320);
    expect(workbookFromMarkdown("| Revenue by quarter | B |\n| --- | --- |\n| 1 | 2 |").workbook.sheets[0]!.cols?.A?.w).toBe(142);
  });

  test("tables without a heading are numbered, and formula-looking text stays text", () => {
    const content = "| A | B |\n| --- | --- |\n| =SUM(1,2) | x |\n\nText\n\n| C | D |\n| --- | --- |\n| 1 | 2 |";
    const { workbook } = workbookFromMarkdown(content);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["Table 1", "Table 2"]);
    expect(workbook.sheets.map((sheet) => sheet.id)).toEqual(["sheet-1", "sheet-2"]);
    expect(workbook.sheets[0]!.cells[cellKey(1, 0)]).toMatchObject({ v: "=SUM(1,2)" });
    expect(workbook.sheets[0]!.cells[cellKey(1, 0)]?.f).toBeUndefined();
  });

  test("a reply with no table lays its lines down one column, headings in bold", () => {
    const { workbook, tables } = workbookFromMarkdown("## Plan\n\n- Hire two engineers\n- Ship pricing\n\nReview in May.");
    expect(tables).toBe(0);
    const sheet = workbook.sheets[0]!;
    expect(sheet.cells[cellKey(0, 0)]).toMatchObject({ v: "Plan", s: { bold: true } });
    expect(sheet.cells[cellKey(1, 0)]).toEqual({ v: "Hire two engineers", s: { valign: "top" } });
    expect(sheet.cells[cellKey(2, 0)]).toEqual({ v: "Ship pricing", s: { valign: "top" } });
    expect(sheet.cells[cellKey(3, 0)]).toEqual({ v: "Review in May.", s: { valign: "top" } });
    expect(sheet.cols?.A?.w).toBe(640);
    expect(workbook.sheets.map((item) => item.id)).toEqual(["sheet-1"]);
  });

  test("code, math, quotes, and images keep their text down the column", () => {
    const content = "> Quoted *line*\n\n```\nraw **code**\n```\n\n$$\nx^2\n$$\n\n![Chart of sales](https://x.test/c.png)\n\n---";
    const sheet = workbookFromMarkdown(content).workbook.sheets[0]!;
    expect([0, 1, 2, 3].map((row) => sheet.cells[cellKey(row, 0)])).toEqual([
      { v: "Quoted line", s: { valign: "top" } },
      { v: "raw **code**", s: { valign: "top" } },
      { v: "$$\nx^2\n$$", s: { valign: "top" } },
      { v: "Chart of sales", s: { valign: "top" } },
    ]);
    expect(sheet.cells[cellKey(4, 0)]).toBeUndefined();
  });

  test("counts the tables a transfer would carry", () => {
    expect(transferTableCount(MATRIX_REPLY)).toBe(1);
    expect(transferTableCount("No tables")).toBe(0);
  });
});

describe("row heights", () => {
  test("a row is as tall as its wrapped words need, measured word by word; short rows keep the default", () => {
    const word = "abcdefghijklmnop";
    const content = `| Area | Detail |\n| --- | --- |\n| Short | ok |\n| Long | ${Array(10).fill(word).join(" ")} |`;
    // At 10 pixels a character, two 16-letter words (330px) overflow the 312px
    // the 320px column leaves, so ten words take ten lines, not ceil(1690 / 312) = 6.
    const sheet = workbookFromMarkdown(content, (text) => text.length * 10).workbook.sheets[0]!;
    expect(sheet.rows?.["1"]).toBeUndefined();
    expect(sheet.rows?.["2"]).toBeUndefined();
    expect(sheet.rows?.["3"]?.h).toBe(Math.ceil(10 * ((10 * 4) / 3) * 1.2 + 8));
  });

  test("a line that exactly fills the cell stays one line; a few pixels more wraps", () => {
    // 10px a letter, 12px a space, so the 320px column leaves exactly 312px.
    const measure = (text: string) => (text === " " ? 12 : text.length * 10);
    const word = (letters: number, char: string) => char.repeat(letters);
    // 150 + 12 + 150 = 312 fills the line, so even a short third word starts a new one.
    const exact = [word(15, "a"), word(15, "b"), word(10, "c")].join(" ");
    const over = [word(15, "d"), word(16, "e"), word(16, "f")].join(" "); // 150 + 12 + 160 = 322 > 312
    const long = [word(31, "g"), word(9, "h")].join(" "); // a first word of 310 fits its line alone
    // A one-column table reads as text, so a second (empty) column keeps it a table.
    const rows = [exact, over, long].map((text) => `| ${text} |  |`).join("\n");
    const content = `| ${word(48, "n")} | B |\n| --- | --- |\n${rows}`;
    const sheet = workbookFromMarkdown(content, measure).workbook.sheets[0]!;
    const height = (lines: number) => Math.ceil(lines * ((10 * 4) / 3) * 1.2 + 8);
    expect(sheet.rows?.["2"]?.h).toBe(height(2));
    expect(sheet.rows?.["3"]?.h).toBe(height(3));
    expect(sheet.rows?.["4"]?.h).toBe(height(2));
    // The header is one 48-letter word: wider than the cell, still one line.
    expect(sheet.rows?.["1"]).toBeUndefined();
  });

  test("a long header wraps and its row grows; empty cells and the default measure work", () => {
    const header = "Long header ".repeat(5).trim();
    const words = Array(10).fill("abcdefghij").join(" ");
    const content = `| ${header} | B |\n| --- | --- |\n| ${words} |  |`;
    const sheet = workbookFromMarkdown(content).workbook.sheets[0]!;
    // 7px a letter by default: four 70px words fit the 312px a 320px column leaves.
    expect(sheet.rows?.["2"]?.h).toBe(Math.ceil(3 * ((10 * 4) / 3) * 1.2 + 8));
    expect(sheet.rows?.["1"]?.h).toBeGreaterThan(24);
  });

  test("cells sit at the top of their row, as in the chat table", () => {
    const sheet = workbookFromMarkdown("| A | B |\n| --- | --- |\n| 1 | two |").workbook.sheets[0]!;
    expect(sheet.cells[cellKey(0, 0)]?.s?.valign).toBe("top");
    expect(sheet.cells[cellKey(1, 1)]?.s?.valign).toBe("top");
  });
});
