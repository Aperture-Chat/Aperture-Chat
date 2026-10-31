/* Spreadsheets in Drafts, performed for real as the synthetic standard user.
 *
 * user-spreadsheet-build chooses Spreadsheet and has the Spreadsheet Assistant
 * build a workbook from a plain request with the local training model, then
 * reads the work trace and checks the formulas.
 *
 * user-spreadsheet-ai reopens that workbook from Document history, changes one
 * cell and then a whole table with Ask AI, asks a question that changes
 * nothing, undoes a change, revises the workbook from the assistant panel, and
 * restores a version. Every reply on screen is the model's own; run it after
 * user-spreadsheet-build with no reset between them.
 *
 * user-spreadsheet-editing needs no model. It starts a template, opens a
 * synthetic CSV, makes it a table, writes structured-reference formulas,
 * restyles the table, builds a pivot and a chart, adds conditional formatting
 * and data validation, filters, freezes the header, exports .xlsx and .csv,
 * opens the exported workbook again, and compares two versions. The downloads
 * are real: the module unzips the workbook and reads both files back, and a
 * capture fails if they do not hold what the lesson says they hold.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const INVOICE_HEADER = "Date,Vendor,Status,Units,Unit price";
const INVOICE_ROWS = [
  ["2026-07-02", "Lakeside Couriers", "Paid", 3, 24], ["2026-07-05", "Harbor Office Supply", "Paid", 13, 38],
  ["2026-07-06", "Brightline IT Services", "Paid", 8, 140], ["2026-07-08", "Harbor Office Supply", "Paid", 15, 38],
  ["2026-07-09", "Harbor Office Supply", "Paid", 15, 38], ["2026-07-11", "Pine Street Catering", "Paid", 9, 96],
  ["2026-07-13", "Cedar Facilities", "Paid", 3, 75], ["2026-07-17", "Brightline IT Services", "Paid", 3, 140],
  ["2026-07-18", "Summit Print Works", "Paid", 6, 52], ["2026-07-21", "Lakeside Couriers", "Paid", 5, 24],
  ["2026-07-23", "Brightline IT Services", "Paid", 7, 140], ["2026-07-25", "Harbor Office Supply", "Paid", 8, 38],
  ["2026-07-28", "Lakeside Couriers", "Paid", 4, 24], ["2026-07-29", "Brightline IT Services", "Paid", 8, 140],
  ["2026-07-30", "Pine Street Catering", "Late", 15, 96], ["2026-08-03", "Lakeside Couriers", "Paid", 16, 24],
  ["2026-08-05", "Lakeside Couriers", "Paid", 7, 24], ["2026-08-07", "Cedar Facilities", "Paid", 11, 75],
  ["2026-08-10", "Brightline IT Services", "Paid", 16, 140], ["2026-08-11", "Summit Print Works", "Open", 4, 52],
  ["2026-08-13", "Harbor Office Supply", "Paid", 12, 38], ["2026-08-14", "Cedar Facilities", "Late", 6, 75],
  ["2026-08-18", "Pine Street Catering", "Paid", 10, 96], ["2026-08-20", "Summit Print Works", "Open", 9, 52],
  ["2026-08-24", "Brightline IT Services", "Open", 5, 140], ["2026-08-26", "Lakeside Couriers", "Late", 14, 24],
  ["2026-08-28", "Harbor Office Supply", "Open", 17, 38], ["2026-09-01", "Cedar Facilities", "Open", 8, 75],
  ["2026-09-03", "Pine Street Catering", "Open", 6, 96], ["2026-09-08", "Summit Print Works", "Open", 11, 52],
];
const INVOICE_COUNT = INVOICE_ROWS.length;
const LAST_ROW = INVOICE_COUNT + 1;
const EXPECTED_TOTAL = INVOICE_ROWS.reduce((sum, row) => sum + row[3] * row[4], 0);

const invoiceCsv = () => [INVOICE_HEADER, ...INVOICE_ROWS.map((row) => row.join(","))].join("\n") + "\n";

const mainCell = (page, ref) => page.locator(`.sheet-pane.is-main [data-cell="${ref}"], .sheet-pane.is-top [data-cell="${ref}"]`).first();
const barInput = (page) => page.locator(".sheet-bar-input textarea");
async function showSheet(page, name) {
  await page.locator(".sheet-tabs").getByRole("tab", { name, exact: true }).click();
  await page.waitForTimeout(500);
}

const toolbarMenu = (page, name) => page.locator(".sheet-toolbar").getByRole("button", { name, exact: true });

/** Jump with the Name box, the way a person goes to a cell off screen. */
async function goTo(page, reference) {
  const box = page.getByLabel(/^Name box/);
  await box.click();
  await box.fill(reference);
  await box.press("Enter");
  await page.waitForTimeout(350);
}

async function type(page, text) {
  await page.keyboard.type(text, { delay: 12 });
}

async function enterCell(page, reference, text) {
  await goTo(page, reference);
  await type(page, text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);
}

async function chooseSpreadsheet(page) {
  await page.locator(".deck-mode-switch").getByRole("button", { name: "Spreadsheet", exact: true }).click();
  await page.locator(".sheet-editor").waitFor();
  await page.waitForTimeout(900);
}

async function openMenu(page, name) {
  await toolbarMenu(page, name).click();
  await page.getByRole("menu", { name, exact: true }).waitFor();
  await page.waitForTimeout(350);
}

async function menuChoice(page, menu, item) {
  await openMenu(page, menu);
  await page.getByRole("menu", { name: menu, exact: true }).getByRole("menuitem", { name: item, exact: true }).click();
  await page.waitForTimeout(450);
}

const panel = (page, title) => page.locator(`aside.sheet-side-panel[aria-label="${title}"]`);
const closePanel = async (page, title) => {
  await page.getByRole("button", { name: `Close ${title.toLowerCase()}` }).click();
  await page.waitForTimeout(350);
};

async function openPaperclip(page) {
  await page.getByRole("button", { name: "Attach file" }).click();
  await page.getByRole("menu", { name: "Add draft attachment" }).waitFor();
  await page.waitForTimeout(400);
}

async function chooseOpenInEditor(page, file) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: /Open in editor/ }).click();
  await (await chooser).setFiles(file);
}

async function saveVersion(page) {
  const save = page.getByRole("button", { name: "Save version", exact: true });
  await save.click();
  await page.locator('.document-save-state[aria-label="Save status"]').filter({ hasText: "Saved" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(900);
}

/** Export through the real panel and keep what the browser really downloaded. */
async function download(page, choice, dir) {
  const exportPanel = page.locator("#document-export-panel");
  if (!(await exportPanel.isVisible().catch(() => false))) await page.getByRole("button", { name: "Export", exact: true }).click();
  await exportPanel.waitFor();
  const destination = exportPanel.getByLabel("Export destination");
  if (await destination.count()) await destination.selectOption({ label: "Browser downloads" });
  const pending = page.waitForEvent("download");
  await exportPanel.getByRole("button", { name: choice }).click();
  const file = await pending;
  const saved = path.join(dir, file.suggestedFilename());
  await file.saveAs(saved);
  await exportPanel.getByText("Sent to your browser downloads.").waitFor();
  await page.waitForTimeout(500);
  return saved;
}

const unzipList = (file) => execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).split("\n").filter(Boolean);
const unzipRead = (file, entry) => execFileSync("unzip", ["-p", file, entry], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** The exported .xlsx must really be a workbook with what the lesson says it keeps. */
function assertWorkbookFile(file) {
  const entries = unzipList(file);
  const need = (pattern, what) => {
    if (!entries.some((entry) => pattern.test(entry))) throw new Error(`The exported workbook has no ${what}: ${entries.join(", ")}`);
  };
  need(/^xl\/workbook\.xml$/, "workbook part");
  need(/^xl\/tables\/table\d+\.xml$/, "table part");
  need(/^xl\/charts\/chart\d+\.xml$/, "chart part");
  const workbook = unzipRead(file, "xl/workbook.xml");
  if (!/name="Vendor invoices"/.test(workbook)) throw new Error(`The exported workbook lost its sheet: ${workbook.slice(0, 400)}`);
  const sheets = entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry)).map((entry) => unzipRead(file, entry)).join("");
  if (!/<f>[^<]*Invoices\[/.test(sheets)) throw new Error("The exported workbook has no structured-reference formula.");
  return entries;
}

function assertCsvFile(file, expectedRows) {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  if (lines.length !== expectedRows) throw new Error(`The CSV has ${lines.length} lines, expected ${expectedRows}.`);
  return lines;
}

const BUILD_REQUEST = "Make a vendor budget table on Sheet1. Put the headers Vendor, Budget, Actual, Variance in row 1. Add 6 rows of sample vendors. Variance is Budget minus Actual. In the next row, put Total in column A and sum the other columns.";
const WORKBOOK_TITLE = /Vendor Budget/i;
const LABEL_CELL = "A10";
const ANSWER_CELL = "B10";
const FIX_REQUEST = "Make row 8 the total row: use SUM formulas for rows 2 to 7 in B8, C8, and D8. Then clear row 9.";
const CELL_REQUEST = "Write a formula in this cell that counts the vendors with a negative Variance.";
const TABLE_REQUEST = "Add a Status column. Show Over if Variance is below zero, otherwise OK.";
const RAIL_REQUEST = "Add a column chart of Budget and Actual beside the table.";
/* A shared local model can queue for a long time, so model waits are generous. */
const MODEL_WAIT = 1750000;

const composer = (page) => page.locator(".ai-composer");
const assistantBusy = (page) => page.locator(".draft-assistant-title small.is-working");

async function askAssistant(page, request) {
  await page.locator("#draft-assistant-command").fill(request);
  await page.getByRole("button", { name: "Apply instruction" }).click();
  await assistantBusy(page).waitFor({ timeout: 30000 });
}

/** The assistant has finished and every trace step has played in. */
async function assistantDone(page) {
  await assistantBusy(page).waitFor({ state: "detached", timeout: MODEL_WAIT });
  await page.locator(".work-trace").getByText(/^Saved as Version \d+$/).waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
}

async function openAskAi(page) {
  await page.getByRole("button", { name: "Ask AI about the selection" }).click();
  await composer(page).waitFor();
  await page.waitForTimeout(500);
}

/** Type an instruction into Ask AI and wait for the model's own proposal. */
async function askAi(page, instruction) {
  await composer(page).getByRole("combobox", { name: "AI instruction" }).fill(instruction);
  await composer(page).getByRole("button", { name: "Run AI instruction" }).click();
  await page.locator(".ai-composer.is-review, .ai-composer.is-error").waitFor({ timeout: MODEL_WAIT });
  await page.waitForTimeout(800);
  const failure = await page.locator(".ai-composer-error").count();
  if (failure) throw new Error(`Ask AI failed: ${await page.locator(".ai-composer-error").innerText()}`);
}

async function applyAi(page) {
  await page.getByRole("button", { name: "Accept AI suggestion" }).click();
  await composer(page).waitFor({ state: "detached" });
  await page.waitForTimeout(600);
}

const userSpreadsheetBuild = {
  role: "user",
  description: "Choose Spreadsheet, ask the assistant to build a workbook from a plain request, read the trace, and check the formulas.",
  externalOrigins: () => [],
  frames: ["user/sheet-start", "user/sheet-request", "user/sheet-working", "user/sheet-built", "user/sheet-check-formula", "user/sheet-check-sum"],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("user", "/drafts");
    await page.getByRole("textbox", { name: "Document body", exact: true }).waitFor();
    await page.waitForTimeout(1200);
    await chooseSpreadsheet(page);
    await shot("sheet-start");

    await page.locator("#draft-assistant-command").fill(BUILD_REQUEST);
    await page.waitForTimeout(400);
    await shot("sheet-request");
    await page.getByRole("button", { name: "Apply instruction" }).click();
    await assistantBusy(page).waitFor({ timeout: 30000 });
    await page.locator(".work-trace").waitFor();
    await page.waitForTimeout(6000);
    await shot("sheet-working");

    await assistantDone(page);
    const sheetName = await page.locator(".sheet-tabs").getByRole("tab", { selected: true }).innerText();
    await assertBuilt(page, sheetName);
    await goTo(page, "A1");
    await shot("sheet-built");

    // Check the work: a formula, the cells it reads, and a total against the status bar.
    await goTo(page, "D3");
    await page.keyboard.press("F2");
    await page.waitForTimeout(600);
    await shot("sheet-check-formula", { keepFocus: true });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await goTo(page, "B2:B7");
    await page.waitForTimeout(500);
    const status = await page.locator(".sheet-stats").innerText();
    const total = await mainCell(page, "B8").innerText();
    if (!status.replace(/\s+/g, " ").includes(`Sum ${total}`)) throw new Error(`The status bar (${status}) should show the Total row's ${total}.`);
    await shot("sheet-check-sum");
  },
};

/** The lesson narrates one real result: the model typed the Total row as plain
 * numbers and added a row that sums it again. That is why it is worth checking.
 * If a recapture comes back different, those scenes' text must change with it,
 * so the difference stops the capture instead of slipping past the narration. */
async function assertTaughtTotals(page) {
  await goTo(page, "B8");
  const typed = await barInput(page).inputValue();
  await goTo(page, "B9");
  const sum = await barInput(page).inputValue();
  if (typed.startsWith("=") || !/^=SUM\(B2:B8\)$/i.test(sum)) throw new Error(`The totals differ from the lesson: B8=${typed} B9=${sum}. Update its Check a total scenes.`);
}

async function assertTotalsFixed(page) {
  await goTo(page, "B8");
  const formula = await barInput(page).inputValue();
  await goTo(page, "B9");
  const leftover = await barInput(page).inputValue();
  const budgets = await columnNumbers(page, "B");
  const expected = budgets.reduce((sum, value) => sum + value, 0);
  if (!/^=SUM\(B2:B7\)$/i.test(formula) || leftover !== "" || (await cellNumber(page, "B8")) !== expected) throw new Error(`The totals are not fixed: B8=${formula} B9=${leftover}`);
}

/** The six data rows of a column, read from the grid. */
async function columnNumbers(page, column) {
  const values = [];
  for (let row = 2; row <= 7; row += 1) values.push(await cellNumber(page, `${column}${row}`));
  return values;
}

/** The frames only teach from a good result, so a weak reply stops the capture. */
async function assertBuilt(page, sheetName) {
  await goTo(page, "A1");
  const header = await mainCell(page, "A1").innerText();
  const name = await mainCell(page, "B1").innerText();
  const variance = await mainCell(page, "D1").innerText();
  await goTo(page, "D3");
  const formula = await barInput(page).inputValue();
  const label = await mainCell(page, "A8").innerText();
  if (header.trim() !== "Vendor" || name.trim() !== "Budget" || variance.trim() !== "Variance" || !/^=B3\s*-\s*C3$/.test(formula) || label.trim() !== "Total") {
    throw new Error(`Weak build on ${sheetName}: A1=${header} B1=${name} D1=${variance} D3=${formula} A8=${label}`);
  }
}

const userSpreadsheetAi = {
  role: "user",
  description: "Change one cell and a whole table with Ask AI, ask a question, undo, revise from the assistant panel, and restore a version.",
  externalOrigins: () => [],
  frames: [
    "user/sheet-check-total", "user/sheet-fix-preview", "user/sheet-fix-applied", "user/sheet-ask-open", "user/sheet-ask-cell-preview", "user/sheet-ask-cell-applied", "user/sheet-ask-table-preview",
    "user/sheet-explain", "user/sheet-undo", "user/sheet-rail-update", "user/sheet-history", "user/sheet-version-restored",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("user", "/drafts");
    await page.getByRole("textbox", { name: "Document body", exact: true }).waitFor();
    await page.waitForTimeout(1200);

    // Reopen the workbook the assistant built.
    await page.getByRole("button", { name: "Document history" }).click();
    await page.locator(".draft-document-history-list").getByRole("button", { name: /^Restore .*from document history/ }).filter({ hasText: WORKBOOK_TITLE }).first().click();
    await page.locator(".sheet-editor").waitFor();
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Close draft tool drawer" }).click().catch(() => {});
    await page.waitForTimeout(500);

    // The check that matters: the bold total reaches into the Total row.
    await assertTaughtTotals(page);
    await goTo(page, "B9");
    await page.keyboard.press("F2");
    await page.waitForTimeout(600);
    await shot("sheet-check-total", { keepFocus: true });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Fix it with Ask AI, and prove the fix.
    await goTo(page, "A8:D9");
    await openAskAi(page);
    await askAi(page, FIX_REQUEST);
    await shot("sheet-fix-preview");
    await applyAi(page);
    await page.locator(".sheet-notice").waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
    await assertTotalsFixed(page);
    await goTo(page, "B8");
    await shot("sheet-fix-applied");

    // One cell: label it, select the cell beside it, and ask.
    await enterCell(page, LABEL_CELL, "Vendors over budget");
    await goTo(page, ANSWER_CELL);
    await openAskAi(page);
    await shot("sheet-ask-open", { keepFocus: true });
    await askAi(page, CELL_REQUEST);
    await shot("sheet-ask-cell-preview");
    await applyAi(page);
    await goTo(page, ANSWER_CELL);
    if (!/^=COUNTIFS?\(/i.test(await barInput(page).inputValue())) throw new Error(`Weak formula: ${await barInput(page).inputValue()}`);
    const variances = await columnNumbers(page, "D");
    const overBudget = variances.filter((value) => value < 0).length;
    if ((await cellNumber(page, ANSWER_CELL)) !== overBudget) throw new Error(`${overBudget} vendors are over budget, but the cell shows ${await mainCell(page, ANSWER_CELL).innerText()}.`);
    await shot("sheet-ask-cell-applied");

    // A whole table: select it and ask for a new column.
    await goTo(page, "A1:D8");
    await openAskAi(page);
    await askAi(page, TABLE_REQUEST);
    await shot("sheet-ask-table-preview");
    await applyAi(page);
    if ((await mainCell(page, "E1").innerText()).trim() !== "Status") throw new Error("The Status column has no header.");
    for (let row = 2; row <= 7; row += 1) {
      const status = (await mainCell(page, `E${row}`).innerText()).trim();
      if (status !== (variances[row - 2] < 0 ? "Over" : "OK")) throw new Error(`Weak Status column: E${row} shows ${status}.`);
    }

    // Undo takes the whole AI change back in one step, and Redo returns it.
    await page.locator(".sheet-notice").waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForTimeout(700);
    await goTo(page, "A2");
    await shot("sheet-undo");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.waitForTimeout(700);

    // A question: the model answers and the workbook stays as it was.
    await goTo(page, "D2:D8");
    await openAskAi(page);
    await composer(page).getByRole("option", { name: "Explain these formulas" }).click();
    await page.locator(".ai-composer.is-review, .ai-composer.is-error").waitFor({ timeout: MODEL_WAIT });
    await page.waitForTimeout(800);
    await shot("sheet-explain");
    // "Done" means the reply changed nothing; "Apply" would mean it proposed a change.
    if (!/Done/.test(await page.getByRole("button", { name: "Accept AI suggestion" }).innerText())) throw new Error("Explain these formulas proposed a change.");
    await page.getByRole("button", { name: "Accept AI suggestion" }).click();
    await composer(page).waitFor({ state: "detached" });
    await page.waitForTimeout(400);

    // The assistant panel revises the workbook and saves a version on its own.
    await saveVersion(page);
    await askAssistant(page, RAIL_REQUEST);
    await assistantDone(page);
    await goTo(page, "A1");
    // The new chart sits beside the table, so scroll right far enough to see it.
    const chart = await page.locator(".sheet-pane.is-main .sheet-chart").first().boundingBox();
    const grid = await page.locator(".sheet-scroll").boundingBox();
    await page.locator(".sheet-scroll").hover();
    await page.mouse.wheel(Math.max(0, chart.x + chart.width + 16 - (grid.x + grid.width)), 0);
    await page.waitForTimeout(700);
    await shot("sheet-rail-update");

    // Versions: open the list, restore an earlier one, and see the label change.
    await page.getByRole("button", { name: "Document history" }).click();
    await page.locator(".draft-version-list").waitFor();
    await page.locator(".draft-version-card").last().evaluate((node) => node.scrollIntoView({ block: "end" }));
    await page.waitForTimeout(600);
    await shot("sheet-history");
    await page.locator(".draft-version-card").nth(-2).click();
    await page.waitForTimeout(1200);
    // Back at column A, so the restored version reads as the workbook, not an empty stretch of grid.
    await goTo(page, "A1");
    await shot("sheet-version-restored");
  },
};

const userSpreadsheetEditing = {
  role: "user",
  description: "Start a template, open a CSV, build a table with structured formulas, pivot, chart, format, validate, filter, freeze, export, reopen, and compare.",
  externalOrigins: () => [],
  frames: [
    "user/sheet-templates", "user/sheet-template-started", "user/sheet-open-menu", "user/sheet-opened-csv",
    "user/sheet-format-menu", "user/sheet-insert-menu", "user/sheet-data-menu", "user/sheet-table-panel", "user/sheet-table-made", "user/sheet-structured-typing", "user/sheet-structured-filled",
    "user/sheet-structured-sum", "user/sheet-style-gallery", "user/sheet-pivot-panel", "user/sheet-pivot-made",
    "user/sheet-chart-panel", "user/sheet-chart-made", "user/sheet-conditional", "user/sheet-validation-panel",
    "user/sheet-validation-list", "user/sheet-validation-reject", "user/sheet-filter-menu", "user/sheet-filter-applied",
    "user/sheet-freeze", "user/sheet-export-panel", "user/sheet-exported", "user/sheet-xlsx-opened", "user/sheet-compare",
  ],
  async run(kit) {
    const { shot } = kit;
    const work = path.join(kit.OUT, "sheet-files");
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const csv = path.join(work, "Vendor invoices.csv");
    fs.writeFileSync(csv, invoiceCsv());

    const page = await kit.app("user", "/drafts");
    await page.getByRole("textbox", { name: "Document body", exact: true }).waitFor();
    await page.waitForTimeout(1200);
    await chooseSpreadsheet(page);

    // 1. Templates: a ready-made workbook with live formulas.
    await page.getByRole("button", { name: "Choose template" }).click();
    await page.locator('[aria-label="Spreadsheet templates"]').waitFor();
    await page.getByRole("button", { name: /^Sales tracker/ }).click();
    await page.waitForTimeout(500);
    await shot("sheet-templates");
    await page.getByRole("button", { name: "Start Sales tracker" }).click();
    await page.locator(".sheet-tabs").getByRole("tab").first().waitFor();
    await page.waitForTimeout(1200);
    await shot("sheet-template-started");

    // 2. Open a CSV as a new workbook.
    await openPaperclip(page);
    await shot("sheet-open-menu");
    await chooseOpenInEditor(page, csv);
    await page.locator(".draft-event").filter({ hasText: "Opened Vendor invoices.csv" }).waitFor();
    await mainCell(page, "A2").waitFor();
    await page.waitForTimeout(900);
    await shot("sheet-opened-csv");

    // 3. Fit the columns, add the Total header, and make the data a table.
    await goTo(page, "A1:E31");
    await openMenu(page, "Format");
    await shot("sheet-format-menu");
    await page.getByRole("menu", { name: "Format", exact: true }).getByRole("menuitem", { name: "Auto-fit column width", exact: true }).click();
    await page.waitForTimeout(450);
    await enterCell(page, "F1", "Total");
    await goTo(page, "A2");
    await menuChoice(page, "Format", "Format as table…");
    await panel(page, "Table").waitFor();
    await page.getByLabel("Table name").fill("Invoices");
    await page.waitForTimeout(400);
    await shot("sheet-table-panel");
    await page.getByRole("button", { name: "Create table" }).click();
    await page.waitForTimeout(700);
    await closePanel(page, "Table");
    // Auto-fit does not count the filter buttons, so make room for them by hand.
    for (const [column, extra] of [["C", 20], ["D", 22], ["E", 18]]) await dragColumnEdge(page, column, extra);
    await goTo(page, "A2");
    await shot("sheet-table-made");

    // 4. Structured references: a calculated column, then a total by table name.
    await goTo(page, `F2:F${LAST_ROW}`);
    await type(page, "=[@Units]*[@[Unit price]]");
    await page.waitForTimeout(500);
    await shot("sheet-structured-typing", { keepFocus: true });
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.waitForTimeout(700);
    await shot("sheet-structured-filled");
    await goTo(page, "A2");
    await menuChoice(page, "Insert", "Sheet");
    await page.waitForTimeout(500);
    await renameActiveTab(page, "Summary");
    await enterCell(page, "A1", "Total spend");
    await enterCell(page, "B1", "=SUM(Invoices[Total])");
    await goTo(page, "B1");
    await menuChoice(page, "More formatting", "Currency format");
    await page.waitForTimeout(300);
    const total = await mainCell(page, "B1").innerText();
    if (Number(total.replace(/[^0-9.]/g, "")) !== EXPECTED_TOTAL) throw new Error(`SUM(Invoices[Total]) shows ${total}, expected ${EXPECTED_TOTAL}.`);
    await shot("sheet-structured-sum");

    // 5. The style gallery restyles the table as you pick.
    await showSheet(page, "Vendor invoices");
    await goTo(page, "A2");
    await openMenu(page, "Table styles");
    await page.getByRole("menuitemradio", { name: "Blue · Medium" }).click();
    await page.waitForTimeout(600);
    await shot("sheet-style-gallery");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // 6. A pivot table on its own sheet, then a chart of it.
    await goTo(page, "A2");
    await openMenu(page, "Insert");
    await shot("sheet-insert-menu");
    await page.getByRole("menu", { name: "Insert", exact: true }).getByRole("menuitem", { name: "Pivot table…", exact: true }).click();
    await panel(page, "Pivot table").waitFor();
    await page.getByLabel("Use Vendor as").selectOption({ label: "Rows" });
    await page.getByLabel("Use Total as").selectOption({ label: "Values" });
    await page.waitForTimeout(500);
    await shot("sheet-pivot-panel");
    await page.getByRole("button", { name: "Create pivot table" }).click();
    await page.locator(".sheet-tabs").getByRole("tab", { name: /^Pivot/ }).waitFor();
    await page.waitForTimeout(900);
    await closePanel(page, "Pivot table");
    await goTo(page, "A1");
    await shot("sheet-pivot-made");
    await assertPivotFollowsItsSource(page);
    await goTo(page, "A3:B9");
    await menuChoice(page, "Insert", "Chart…");
    await panel(page, "Chart").waitFor();
    await page.getByRole("radio", { name: "Bar" }).click();
    await panel(page, "Chart").getByPlaceholder("Chart title").fill("Spend by vendor");
    await panel(page, "Chart").locator(".sheet-panel-body").evaluate((node) => { node.scrollTop = 0; });
    await page.waitForTimeout(500);
    await shot("sheet-chart-panel");
    await page.getByRole("button", { name: "Insert chart" }).click();
    await page.locator(".sheet-chart").first().waitFor();
    await page.waitForTimeout(700);
    await closePanel(page, "Chart");
    // The chart runs past the edge at this width, so zoom out to see all of it.
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.getByRole("button", { name: "Zoom out" }).click();
    await goTo(page, "A1");
    await page.locator(".sheet-chart").first().dblclick({ position: { x: 40, y: 12 } });
    await panel(page, "Chart").waitFor();
    await closePanel(page, "Chart");
    await page.locator(".sheet-chart").first().click({ position: { x: 40, y: 12 } });
    await page.waitForTimeout(500);
    await shot("sheet-chart-made");
    await page.getByRole("button", { name: /^Zoom 75 percent/ }).click();
    await page.waitForTimeout(400);

    // 7. Conditional formatting: data bars on Total, red on Late.
    await showSheet(page, "Vendor invoices");
    await goTo(page, `F2:F${LAST_ROW}`);
    await menuChoice(page, "Format", "Conditional formatting…");
    await panel(page, "Conditional formatting").waitFor();
    await panel(page, "Conditional formatting").getByLabel("Format cells if").selectOption({ label: "Data bars" });
    await page.getByRole("button", { name: "Add rule" }).click();
    await page.waitForTimeout(400);
    await goTo(page, `C2:C${LAST_ROW}`);
    await panel(page, "Conditional formatting").getByLabel("Format cells if").selectOption({ label: "Text contains" });
    await panel(page, "Conditional formatting").getByLabel("Text", { exact: true }).fill("Late");
    await page.getByRole("button", { name: "Add rule" }).click();
    await page.waitForTimeout(400);
    await panel(page, "Conditional formatting").locator(".sheet-panel-body").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.waitForTimeout(400);
    await shot("sheet-conditional");
    await closePanel(page, "Conditional formatting");

    // 8. Data validation: a dropdown, then a typed entry the rule refuses.
    await goTo(page, `C2:C${LAST_ROW}`);
    await openMenu(page, "Data");
    await shot("sheet-data-menu");
    await page.getByRole("menu", { name: "Data", exact: true }).getByRole("menuitem", { name: "Data validation…", exact: true }).click();
    await panel(page, "Data validation").waitFor();
    await page.getByLabel("Choices (comma separated)").fill("Open, Paid, Late");
    await page.waitForTimeout(400);
    await shot("sheet-validation-panel");
    await panel(page, "Data validation").getByRole("button", { name: "Add rule" }).click();
    await page.waitForTimeout(500);
    await closePanel(page, "Data validation");
    await goTo(page, "C6");
    await page.getByRole("button", { name: "Choose from the list" }).first().click();
    await page.getByRole("listbox", { name: "Allowed values" }).waitFor();
    await page.waitForTimeout(400);
    await shot("sheet-validation-list");
    await page.getByRole("listbox", { name: "Allowed values" }).getByRole("option", { name: "Open", exact: true }).click();
    await page.waitForTimeout(500);
    await goTo(page, "C7");
    await type(page, "Pending");
    await page.keyboard.press("Enter");
    await page.locator(".sheet-notice").waitFor();
    await page.waitForTimeout(300);
    await shot("sheet-validation-reject", { keepFocus: true });
    await page.keyboard.press("Escape");
    await page.locator(".sheet-notice").waitFor({ state: "detached", timeout: 8000 });

    // 9. Filter on a table column.
    await goTo(page, "A1");
    await page.getByRole("button", { name: "Filter C" }).first().click();
    const filter = page.getByRole("dialog", { name: "Filter Status" });
    await filter.waitFor();
    await filter.getByRole("checkbox", { name: "Paid" }).uncheck();
    await page.waitForTimeout(400);
    await shot("sheet-filter-menu");
    await filter.getByRole("button", { name: "Apply" }).click();
    await page.waitForTimeout(700);
    await shot("sheet-filter-applied");
    await menuChoice(page, "Data", "Clear filter choices");

    // 10. Freeze the header row, then scroll.
    await menuChoice(page, "Format", "Freeze top row");
    await page.locator(".sheet-scroll").hover();
    await page.mouse.wheel(0, 260);
    await page.waitForTimeout(700);
    await shot("sheet-freeze");
    await page.mouse.wheel(0, -260);
    await page.waitForTimeout(400);

    // 11. Export a saved version: a real .xlsx and a real .csv.
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page.locator("#document-export-panel").waitFor();
    await page.waitForTimeout(500);
    await shot("sheet-export-panel");
    await page.locator("#document-export-panel .document-export-save-notice").getByRole("button", { name: "Save version" }).click();
    await page.locator("#document-export-panel .document-export-receipt").waitFor({ timeout: 30000 });
    const workbookFile = await download(page, /Excel workbook/, work);
    assertWorkbookFile(workbookFile);
    await shot("sheet-exported");
    const csvFile = await download(page, /CSV \(current sheet\)/, work);
    assertCsvFile(csvFile, INVOICE_COUNT + 1);
    await page.getByRole("button", { name: "Close export options" }).click();
    await page.waitForTimeout(400);

    // 12. The exported workbook opens again as a new workbook.
    await openPaperclip(page);
    await chooseOpenInEditor(page, workbookFile);
    await page.locator(".draft-event").filter({ hasText: `Opened ${path.basename(workbookFile)}` }).waitFor();
    await page.waitForTimeout(1200);
    await shot("sheet-xlsx-opened");
    await assertReopenedWorkbook(page);

    // 13. Change two cells, save, and compare the two versions.
    await showSheet(page, "Vendor invoices");
    await enterCell(page, "D2", "5");
    await goTo(page, "C21");
    await type(page, "Paid");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await saveVersion(page);
    await page.getByRole("button", { name: "Compare versions" }).click();
    await page.getByRole("dialog", { name: "Compare workbook versions" }).waitFor();
    await page.waitForTimeout(700);
    await shot("sheet-compare");
  },
};

const cellNumber = async (page, ref) => Number((await mainCell(page, ref).innerText()).replace(/[^0-9.-]/g, ""));

/** The lesson says a pivot follows its source: change a Units value and read it back. */
async function assertPivotFollowsItsSource(page) {
  const before = await cellNumber(page, "B10");
  await showSheet(page, "Vendor invoices");
  await enterCell(page, "D2", "4");
  await showSheet(page, "Pivot");
  if ((await cellNumber(page, "B10")) !== before + 24) throw new Error("The pivot did not follow a change to its source.");
  await showSheet(page, "Vendor invoices");
  await enterCell(page, "D2", "3");
  await showSheet(page, "Pivot");
}

/** The lesson says the export comes back whole: read the sheets, the chart, and a named-table formula. */
async function assertReopenedWorkbook(page) {
  await showSheet(page, "Pivot");
  await page.locator(".sheet-chart").first().waitFor();
  await showSheet(page, "Summary");
  await goTo(page, "B1");
  if ((await barInput(page).inputValue()) !== "=SUM(Invoices[Total])") throw new Error(`Summary!B1 came back as ${await barInput(page).inputValue()}`);
}

/** Drag a column's right edge, the way a person widens a column. */
async function dragColumnEdge(page, column, pixels) {
  const edge = await page.getByRole("separator", { name: `Resize column ${column}` }).boundingBox();
  const x = edge.x + edge.width / 2;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + pixels, y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

/** Double-click the current tab and type its new name, as a person renames one. */
async function renameActiveTab(page, name) {
  await page.locator(".sheet-tabs").getByRole("tab", { selected: true }).dblclick();
  const input = page.getByLabel("Sheet name");
  await input.fill(name);
  await input.press("Enter");
  await page.waitForTimeout(400);
}

module.exports = { "user-spreadsheet-build": userSpreadsheetBuild, "user-spreadsheet-ai": userSpreadsheetAi, "user-spreadsheet-editing": userSpreadsheetEditing };
