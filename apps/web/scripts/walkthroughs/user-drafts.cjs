/* Drafts: documents and decks, performed for real as the synthetic standard
 * user against the local training model.
 *
 * user-drafts starts from a blank document, has the assistant write it, edits
 * a passage with AI (reviewed, then accepted), saves a version, exports a real
 * Word file (the download is checked), and opens a synthetic Markdown file
 * from this device in the editor.
 *
 * user-decks converts that kind of document into slides, builds a deck from an
 * outline request with the assistant, starts one from a starter template,
 * presents it in presenter view, and exports a real PowerPoint file.
 *
 * user-draft-history archives a saved draft, finds it under Archived, restores
 * it, opens an earlier version, and records the delete confirmation (cancelled).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { helpers } = require("./user-common.cjs");
const { scrollTo } = helpers;

const REQUEST = "Draft a one-page synthetic vendor onboarding checklist with the headings Purpose, Before you start, Review steps, and Owners. Keep it under 200 words.";
const OPEN_FILE = "synthetic-vendor-policy.md";
const OPEN_TEXT = [
  "# Synthetic vendor policy",
  "",
  "## Purpose",
  "",
  "This synthetic policy explains how a new vendor is reviewed before its first engagement.",
  "",
  "## Review steps",
  "",
  "- Confirm the vendor's security questionnaire is complete.",
  "- Record the data the vendor will receive and who approved it.",
  "- Schedule a follow-up review after ninety days.",
  "",
].join("\n");

const body = (page) => page.getByRole("textbox", { name: "Document body", exact: true });

async function openDrafts(kit) {
  const page = await kit.app("user", "/drafts");
  await body(page).waitFor();
  await page.waitForTimeout(1500);
  return page;
}

/** Ask the assistant and wait until it has finished writing on the page. */
async function askAssistant(page, text) {
  const box = page.locator("#draft-assistant-command");
  await box.fill(text);
  await page.getByRole("button", { name: "Apply instruction" }).click();
  const busy = page.getByText(/^(Writing…|Building slides…)$/).first();
  await busy.waitFor({ timeout: 30000 });
  await busy.waitFor({ state: "detached", timeout: 600000 });
  await page.waitForTimeout(1500);
}

async function selectFirstParagraph(page) {
  await body(page).evaluate((root) => {
    const paragraph = [...root.querySelectorAll("p, li")].find((node) => node.textContent.trim().length > 40);
    if (!paragraph) throw new Error("No paragraph to select.");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    paragraph.scrollIntoView({ block: "center" });
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.waitForTimeout(600);
}

async function saveVersion(page) {
  const save = page.getByRole("button", { name: "Save version", exact: true });
  if (await save.isEnabled()) await save.click();
  await page.locator(".document-server-save-state").filter({ hasText: "Saved" }).waitFor();
  await page.waitForTimeout(1200);
  if (await save.isEnabled()) {
    await save.click();
    await page.locator(".document-server-save-state").filter({ hasText: "Saved" }).waitFor();
    await page.waitForTimeout(700);
  }
}

const userDrafts = {
  role: "user",
  description: "Write a document with the assistant, edit with AI, save, export Word, and open a file in the editor.",
  externalOrigins: () => [],
  frames: [
    "user/drafts-blank", "user/drafts-request", "user/drafts-generated", "user/drafts-ai-menu", "user/drafts-ai-review",
    "user/drafts-saved", "user/drafts-export-menu", "user/drafts-exported", "user/drafts-open-menu", "user/drafts-opened",
  ],
  async run(kit) {
    const { shot } = kit;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-drafts-"));
    try {
      const page = await openDrafts(kit);
      if ((await body(page).innerText()).trim()) throw new Error("Drafts should open on a blank document.");
      await page.getByRole("textbox", { name: "Document title", exact: true }).fill("Synthetic vendor onboarding checklist");
      await shot("drafts-blank");

      // 1. The assistant writes the document.
      await page.locator("#draft-assistant-command").fill(REQUEST);
      await shot("drafts-request", { keepFocus: true });
      await askAssistant(page, REQUEST);
      const words = (await body(page).innerText()).split(/\s+/).filter(Boolean).length;
      if (words < 40) throw new Error(`The assistant wrote only ${words} words.`);
      // The assistant can replace the title with a template's name (reported);
      // the person types their own title back, as the lesson teaches.
      const title = page.getByRole("textbox", { name: "Document title", exact: true });
      if ((await title.inputValue()) !== "Synthetic vendor onboarding checklist") await title.fill("Synthetic vendor onboarding checklist");
      await page.evaluate(() => document.querySelector(".document-page, [aria-label='Document body']")?.scrollIntoView({ block: "start" }));
      await shot("drafts-generated");

      // 2. Edit a passage with AI, review it, and accept it.
      await selectFirstParagraph(page);
      await page.locator(".document-selection-toolbar").getByRole("button", { name: /^Ask AI/ }).click();
      await page.locator(".ai-composer").waitFor();
      await page.waitForTimeout(500);
      await shot("drafts-ai-menu", { keepFocus: true });
      await page.getByRole("option", { name: "Make shorter", exact: true }).click();
      await page.locator(".ai-composer.is-review").waitFor({ timeout: 240000 });
      await page.waitForTimeout(800);
      await shot("drafts-ai-review");
      await page.getByRole("button", { name: "Accept AI suggestion" }).click();
      await page.waitForTimeout(1000);

      // 3. Save a version.
      await saveVersion(page);
      await shot("drafts-saved");

      // 4. Export a real Word file.
      await page.locator(".document-export-button").click();
      const panel = page.locator("#document-export-panel");
      await panel.waitFor();
      await page.waitForTimeout(400);
      await shot("drafts-export-menu", { keepFocus: true });
      // "Choose a location" asks the browser for a save dialog; downloads are capturable.
      const destination = panel.getByLabel("Export destination");
      if (await destination.count()) await destination.selectOption({ label: "Browser downloads" });
      const download = page.waitForEvent("download");
      await panel.getByRole("button", { name: /Word document/ }).click();
      const file = await download;
      if (!/\.docx$/.test(file.suggestedFilename())) throw new Error(`Unexpected export ${file.suggestedFilename()}`);
      const saved = path.join(dir, file.suggestedFilename());
      await file.saveAs(saved);
      if (fs.readFileSync(saved).subarray(0, 2).toString() !== "PK") throw new Error("The Word export is not a .docx package.");
      await panel.getByText(/Sent to your browser downloads|Saved to your selected location/).waitFor();
      await shot("drafts-exported", { keepFocus: true });
      await page.keyboard.press("Escape");
      if (await panel.isVisible()) await page.locator(".document-export-button").click();

      // 5. Open a file from this device in the editor.
      const source = path.join(dir, OPEN_FILE);
      fs.writeFileSync(source, OPEN_TEXT);
      await page.getByRole("button", { name: "Attach file", exact: true }).click();
      const menu = page.getByRole("menu", { name: "Add draft attachment" });
      await menu.waitFor();
      await page.waitForTimeout(400);
      await shot("drafts-open-menu", { keepFocus: true });
      const chooser = page.waitForEvent("filechooser");
      await menu.getByRole("menuitem", { name: /Open in editor/ }).click();
      await (await chooser).setFiles(source);
      const keep = page.getByRole("button", { name: "Save copy and continue" });
      if (await keep.isVisible().catch(() => false)) await keep.click();
      await page.locator(".draft-event").filter({ hasText: `Opened ${OPEN_FILE} in the editor.` }).waitFor();
      await body(page).getByText("Review steps", { exact: true }).waitFor();
      await page.waitForTimeout(1000);
      await shot("drafts-opened");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

// Typed as a person would: a list continues on Enter, and a second Enter ends it.
const DOC_KEYS = [
  "# Vendor review kickoff", "Enter",
  "## Goals", "Enter",
  "- Agree on the review scope and owners", "Enter",
  "Confirm the timeline for questionnaires", "Enter", "Enter",
  "## Risks", "Enter",
  "- Late security questionnaires", "Enter",
  "Unclear data-processing terms",
];

async function newDraft(kit) {
  const page = await openDrafts(kit);
  if ((await body(page).innerText()).trim()) throw new Error("Drafts should open on a blank document.");
  return page;
}

async function exportDownload(page, label, pattern) {
  const panel = page.locator("#document-export-panel");
  const destination = panel.getByLabel("Export destination");
  if (await destination.count()) await destination.selectOption({ label: "Browser downloads" });
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: label }).click();
  const file = await download;
  if (!pattern.test(file.suggestedFilename())) throw new Error(`Unexpected export ${file.suggestedFilename()}`);
  const target = path.join(os.tmpdir(), `aperture-${Date.now()}-${file.suggestedFilename()}`);
  await file.saveAs(target);
  const zip = fs.readFileSync(target).subarray(0, 2).toString() === "PK";
  fs.rmSync(target, { force: true });
  if (!zip) throw new Error(`${file.suggestedFilename()} is not an Office package.`);
  await panel.getByText(/Sent to your browser downloads|Saved to your selected location/).waitFor();
}

const userDecks = {
  role: "user",
  description: "Convert a document into slides, build a deck from an outline, start from a template, present, and export PowerPoint.",
  externalOrigins: () => [],
  frames: [
    "user/deck-convert-dialog", "user/deck-converted", "user/deck-outline-request", "user/deck-generated",
    "user/deck-starters", "user/deck-template-started", "user/deck-presenter", "user/deck-export-menu", "user/deck-exported",
  ],
  async run(kit) {
    const { shot } = kit;
    // 1. A document converted into slides.
    let page = await newDraft(kit);
    await page.getByRole("textbox", { name: "Document title", exact: true }).fill("Vendor review kickoff");
    await body(page).click();
    for (const key of DOC_KEYS) {
      if (key === "Enter") await page.keyboard.press("Enter");
      else await page.keyboard.type(key, { delay: 25 });
    }
    if (await body(page).getByText("## Risks").count()) throw new Error("The Markdown shortcuts did not format the document.");
    await saveVersion(page);
    await page.locator(".deck-mode-switch").getByRole("button", { name: "Deck", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Switch to deck mode" });
    await dialog.waitFor();
    await shot("deck-convert-dialog");
    await dialog.getByRole("button", { name: "Convert into slides" }).click();
    await page.locator(".deck-filmstrip").waitFor();
    await page.waitForTimeout(1500);
    await shot("deck-converted");

    // 2. A deck built from an outline request by the deck assistant.
    await page.context().close();
    page = await newDraft(kit);
    await page.locator(".deck-mode-switch").getByRole("button", { name: "Deck", exact: true }).click();
    await page.locator(".deck-filmstrip").waitFor();
    await page.getByRole("textbox", { name: "Document title", exact: true }).fill("Vendor review kickoff deck");
    const outline = "Build a 4-slide kickoff deck for a synthetic vendor review: goals, scope, timeline, and next steps.";
    await page.locator("#draft-assistant-command").fill(outline);
    await shot("deck-outline-request", { keepFocus: true });
    await askAssistant(page, outline);
    const slides = await page.locator(".deck-filmstrip").getByRole("button", { name: /^Slide \d+: / }).count();
    if (slides < 3) throw new Error(`The deck assistant built only ${slides} slides.`);
    const title = page.getByRole("textbox", { name: "Document title", exact: true });
    if ((await title.inputValue()) !== "Vendor review kickoff deck") await title.fill("Vendor review kickoff deck");
    await saveVersion(page);
    await shot("deck-generated");

    // 3. Present it in presenter view.
    await page.getByRole("button", { name: "Present deck" }).click();
    await page.getByRole("dialog", { name: "Deck presentation" }).waitFor();
    await page.waitForTimeout(800);
    await page.keyboard.press("p");
    await page.locator(".deck-presenter-side").waitFor();
    await page.waitForTimeout(1200);
    await shot("deck-presenter", { keepFocus: true });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    if (await page.getByRole("dialog", { name: "Deck presentation" }).isVisible()) await page.keyboard.press("Escape");

    // 4. Export a real PowerPoint file.
    await page.locator(".document-export-button").click();
    await page.locator("#document-export-panel").waitFor();
    await page.waitForTimeout(400);
    await shot("deck-export-menu", { keepFocus: true });
    await exportDownload(page, /PowerPoint deck/, /\.pptx$/);
    await shot("deck-exported", { keepFocus: true });

    // 5. Start a new deck from a starter template.
    await page.context().close();
    page = await newDraft(kit);
    await page.locator(".deck-mode-switch").getByRole("button", { name: "Deck", exact: true }).click();
    await page.locator(".deck-filmstrip").waitFor();
    await page.getByRole("button", { name: "Deck starters & brand themes" }).click();
    const templates = page.locator(".draft-template-panel[aria-label='Deck templates']");
    await templates.waitFor();
    await templates.getByText("Project kickoff", { exact: true }).first().click();
    await page.waitForTimeout(500);
    await shot("deck-starters", { keepFocus: true });
    await templates.getByRole("button", { name: /^Start Project kickoff/ }).click();
    const keep = page.getByRole("button", { name: "Discard and continue" });
    if (await keep.isVisible().catch(() => false)) await keep.click();
    await page.getByText(/template started with \d+ slides/).first().waitFor();
    await page.waitForTimeout(1200);
    await shot("deck-template-started");
  },
};

const userDraftHistory = {
  role: "user",
  description: "Archive a saved draft, find and restore it, open an earlier version, and see the delete confirmation.",
  externalOrigins: () => [],
  frames: ["user/history-open", "user/history-archived", "user/history-restored", "user/history-versions", "user/history-delete"],
  async run(kit) {
    const { shot } = kit;
    const page = await newDraft(kit);
    // A saved draft with two versions, typed for real.
    await page.getByRole("textbox", { name: "Document title", exact: true }).fill("Quarterly vendor summary");
    await body(page).click();
    await page.keyboard.type("Quarterly vendor summary", { delay: 25 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("Three synthetic vendors completed their reviews this quarter.", { delay: 15 });
    await saveVersion(page);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Two renewals are due before the end of November.", { delay: 15 });
    await saveVersion(page);

    const toggle = page.getByRole("button", { name: "Document history" });
    await toggle.click();
    const panel = page.locator(".draft-history-panel");
    await panel.waitFor();
    const card = panel.locator(".draft-history-document-card").filter({ hasText: "Quarterly vendor summary" }).first();
    await card.waitFor();
    await page.waitForTimeout(600);
    await shot("history-open");

    // Archive it, then find it under Archived and restore it.
    await card.hover();
    await panel.getByRole("button", { name: "Archive Quarterly vendor summary" }).click();
    await page.getByText("Draft archived. Open Archived to restore it.").first().waitFor();
    await panel.getByRole("button", { name: "Archived", exact: true }).click();
    const archived = panel.locator(".draft-history-document-card").filter({ hasText: "Quarterly vendor summary" }).first();
    await archived.waitFor();
    await page.waitForTimeout(600);
    await shot("history-archived");
    await archived.hover();
    await panel.getByRole("button", { name: "Unarchive Quarterly vendor summary" }).click();
    await page.getByText("Draft returned to history.").first().waitFor();
    await panel.getByRole("button", { name: "Active", exact: true }).click();
    await panel.locator(".draft-history-document-card").filter({ hasText: "Quarterly vendor summary" }).first().waitFor();
    await page.waitForTimeout(600);
    await shot("history-restored");

    // Versions of this draft.
    const versions = panel.locator(".draft-version-card");
    await versions.first().waitFor();
    await scrollTo(page, versions.first(), "center");
    await shot("history-versions");

    // Delete asks first; cancel keeps the draft.
    const restored = panel.locator(".draft-history-document-card").filter({ hasText: "Quarterly vendor summary" }).first();
    await restored.hover();
    await panel.getByRole("button", { name: "Delete Quarterly vendor summary" }).click();
    await page.getByRole("button", { name: "Delete draft" }).waitFor();
    await page.waitForTimeout(500);
    await shot("history-delete");
    await page.getByRole("button", { name: "Cancel" }).last().click();
  },
};

module.exports = { "user-drafts": userDrafts, "user-decks": userDecks, "user-draft-history": userDraftHistory };
