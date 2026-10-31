/* Editing a table and a diagram inside a reply, performed for real as the
 * synthetic standard user against the local training model.
 *
 * user-replies asks for a comparison table, edits a cell, adds a row, confirms
 * the edits reached the saved reply, and sends the edited table to a
 * spreadsheet. It then asks for a structure diagram, changes its theme,
 * connectors, and corners, drags a card, recolors a header, bends an arrow, and
 * checks a real PNG download. The table and the chart are the model's real
 * output; only the reader's own edits change them.
 */
const fs = require("node:fs");
const { helpers } = require("./user-common.cjs");
const { composer, sendChat, waitForReply, scrollTo, scrollBelowHeader, toolbarAction: action, threadIdOf, savedReply } = helpers;

const TABLE = "Compare three made-up vendors by renewal date, annual cost, and risk in a markdown table. Only the table, no other text.";
const DIAGRAM = "Draw a process flow diagram of synthetic vendor onboarding. Put Request, Screening, and Contract in the first row, and Security review and Onboarded in the second row. Connect each box to the next box with an arrow. Use plain cards with short titles and nothing else in each box.";

const NEW_COST = "$48,000";
const NEW_VENDOR = "Example Freight";

/** Ask until the reply holds what the check wants; a small model can miss. */
async function ask(page, prompt, found) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await sendChat(page, prompt);
    const reply = await waitForReply(page, before, { timeout: 2400000 });
    await page.waitForTimeout(3000);
    if (await found(reply).count()) return reply;
  }
  throw new Error(`The model did not deliver: ${prompt}`);
}

/** Replace what the open cell holds, as a person typing over it. */
async function typeInCell(page, text) {
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text, { delay: 20 });
}

/** A real point on an SVG arrow, in page coordinates. */
async function pointOnPath(path) {
  return path.evaluate((element) => {
    const point = element.getPointAtLength(element.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
}

/** An arrow running straight between aligned boxes has no bend handle, so
 * walk the arrows until one that has a corner offers it. */
async function selectBendableArrow(page, figure) {
  const arrows = figure.locator(".sdc-edge-hit");
  for (let index = (await arrows.count()) - 1; index >= 0; index -= 1) {
    const at = await pointOnPath(arrows.nth(index));
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(300);
    if (await figure.locator(".sdc-bend-handle").count()) return;
  }
  throw new Error("No arrow in this chart offers a bend handle.");
}

async function dragBy(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
}

const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

async function editTable(kit, page, shot) {
  // Vendor, renewal date, annual cost, risk: four columns, as the steps below expect.
  const reply = await ask(page, TABLE, (item) => item.locator(".md-table-block:has(thead th:nth-child(4)):not(:has(thead th:nth-child(5)))"));
  await reply.locator(".work-trace-toggle").click();
  await page.waitForTimeout(400);
  const block = reply.locator(".md-table-block");
  await scrollTo(page, block, "center");
  await shot("table-reply");

  // A click opens the cell where you clicked.
  await block.locator("tbody tr").first().locator("td").nth(2).click();
  await block.locator(".md-table-cell-editor").waitFor();
  await typeInCell(page, NEW_COST);
  await shot("table-editing", { keepFocus: true });

  // Add row keeps the typing; then fill the new last row, with Tab moving across it.
  await block.locator("tbody tr").last().locator("td").first().click();
  await block.locator(".md-table-cell-editor").waitFor();
  await block.getByRole("button", { name: "Add row below" }).click();
  await page.waitForTimeout(500);
  await block.locator("tbody tr").last().locator("td").first().click();
  await block.locator(".md-table-cell-editor").waitFor();
  await page.waitForTimeout(200);
  await typeInCell(page, NEW_VENDOR);
  for (const value of ["2027-03-01", "$12,500", "Low"]) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(200);
    await typeInCell(page, value);
  }
  await shot("table-row-added", { keepFocus: true });
  await block.getByRole("button", { name: "Done editing table" }).click();
  await block.locator(".md-table-cell-editor").waitFor({ state: "detached" });
  await page.waitForTimeout(700);

  const threadId = threadIdOf(page);
  const saved = await savedReply(kit, threadId);
  if (!saved.includes(NEW_COST) || !saved.includes(NEW_VENDOR)) throw new Error("The table edits did not reach the saved reply.");

  // The chooser counts the tables; the sheet carries the edits.
  await reply.locator(".transfer-draft-button").click();
  await page.locator(".transfer-draft-menu").waitFor();
  await scrollTo(page, page.locator(".transfer-draft-menu"), "center");
  await shot("table-transfer");
  await page.locator(".transfer-draft-option").filter({ hasText: "Spreadsheet" }).click();
  await page.waitForURL(/\/drafts/);
  await page.locator(".sheet-editor").waitFor();
  await page.locator(".sheet-pane").filter({ hasText: NEW_VENDOR }).first().waitFor();
  await page.waitForTimeout(1500);
  await shot("table-sheet");
}

async function styleDiagram(kit, page, shot) {
  const reply = await ask(page, DIAGRAM, (item) => item.locator(".md-diagram-panel .sdc-canvas:has(.sdc-edge-hit)"));
  const threadId = threadIdOf(page);
  await reply.locator(".work-trace-toggle").click();
  await page.waitForTimeout(400);
  const figure = reply.locator(".md-diagram-panel").first();
  const cardTitle = (name) => figure.locator(".sdc-text").filter({ hasText: name }).first();
  await scrollTo(page, figure, "center");
  await shot("diagram-structure");

  // Theme, connectors, corners: each choice applies and saves at once.
  await action(figure, "Style").click();
  const tray = figure.locator(".sdc-style-tray");
  await tray.waitFor();
  await scrollBelowHeader(page, figure, 80);
  await tray.locator(".sdc-theme").filter({ hasText: "Forest" }).click();
  await page.waitForTimeout(700);
  await shot("diagram-theme");
  await tray.getByRole("radio", { name: "Curved" }).click();
  await tray.getByRole("radio", { name: "Square" }).click();
  await page.waitForTimeout(700);
  await shot("diagram-connectors");
  await action(figure, "Style").click();
  await tray.waitFor({ state: "detached" });
  await page.waitForTimeout(400);
  await scrollTo(page, figure, "center");

  // Drag a card to a free spot; its arrows follow.
  await dragBy(page, center(await cardTitle("Onboarded").boundingBox()), 70, 40);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  await shot("diagram-dragged");

  // Header color for the card just moved, from the chip beside it.
  const chip = figure.locator(".sdc-card-chip");
  await chip.waitFor();
  await chip.getByRole("button", { name: "Header color" }).click();
  await chip.locator(".sdc-chip-swatches").waitFor();
  await page.waitForTimeout(300);
  await shot("diagram-card-swatches");
  await chip.getByRole("button", { name: "Amber header" }).click();
  await page.waitForTimeout(800);
  await shot("diagram-card-color");

  // Select an arrow that has a corner, and bend it.
  await selectBendableArrow(page, figure);
  await figure.locator(".sdc-edge-chip").waitFor();
  await dragBy(page, center(await figure.locator(".sdc-bend-handle").boundingBox()), 24, 30);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  await shot("diagram-arrow");

  // Deselect, then a real PNG of the chart as drawn.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const pending = page.waitForEvent("download");
  await action(figure, "PNG").click();
  const saved = await pending;
  if (saved.suggestedFilename() !== "aperture-structure-diagram.png") throw new Error(`Unexpected download ${saved.suggestedFilename()}`);
  const bytes = fs.readFileSync(await saved.path());
  if (bytes.subarray(1, 4).toString() !== "PNG" || bytes.length < 5000) throw new Error("The download is not a real PNG.");
  const pendingSvg = page.waitForEvent("download");
  await action(figure, "SVG").click();
  const svg = fs.readFileSync(await (await pendingSvg).path(), "utf8");
  if (!svg.includes("<svg") || !svg.includes("Onboarded")) throw new Error("The SVG does not hold the chart.");
  await shot("diagram-final");

  // Every choice lives in the saved reply, so reopening the chat keeps it.
  const stored = await savedReply(kit, threadId);
  for (const mark of ['"theme": "forest"', '"connector": "curved"', '"corners": "square"', '"color": "amber"']) {
    if (!stored.includes(mark)) throw new Error(`The saved reply lost ${mark}.`);
  }
}

const userReplies = {
  role: "user",
  description: "Edit a table in place and send it to a spreadsheet; restyle a structure diagram, drag, recolor, bend, and export it.",
  externalOrigins: () => [],
  frames: [
    "user/table-reply", "user/table-editing", "user/table-row-added", "user/table-transfer", "user/table-sheet",
    "user/diagram-structure", "user/diagram-theme", "user/diagram-connectors", "user/diagram-dragged",
    "user/diagram-card-swatches", "user/diagram-card-color", "user/diagram-arrow", "user/diagram-final",
  ],
  async run(kit) {
    const { shot } = kit;
    const tablePage = kit.use(await kit.app("user", "/chat"));
    await composer(tablePage).waitFor();
    await editTable(kit, tablePage, shot);
    // One open page at a time: a second page picks up the first one's running reply.
    await tablePage.context().close();
    const diagramPage = kit.use(await kit.app("user", "/chat"));
    await composer(diagramPage).waitFor();
    await styleDiagram(kit, diagramPage, shot);
  },
};

module.exports = { "user-replies": userReplies };
