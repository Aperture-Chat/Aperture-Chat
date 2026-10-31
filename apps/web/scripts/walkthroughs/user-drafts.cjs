/* Drafts: documents and decks, performed for real as the synthetic standard
 * user against the local training model.
 *
 * user-drafts starts from a blank document, has the assistant write it (the
 * work trace is captured while it runs and again when it finishes), edits a
 * passage with AI (reviewed, then accepted; the review notes when the original
 * formatting is kept), uses the slash menu and the status bar's Outline and
 * Find, saves a version, exports a real Word file and a real server-built PDF
 * (both downloads are checked), opens Print, opens a long synthetic Markdown
 * file from this device in the editor and moves through its pages, and sends a
 * real chat reply through the Transfer to Drafts chooser.
 *
 * user-decks converts that kind of document into slides, builds a deck from an
 * outline request with the assistant (its fit check is in the rail), shows the
 * layouts strip and the seven theme designs on that deck, writes speaker notes,
 * presents it in presenter view, exports a real PowerPoint file, starts a deck
 * from a starter template, and applies the repository's synthetic brand
 * template to it.
 *
 * user-draft-history archives a saved draft, finds it under Archived, restores
 * it, previews a card, opens an earlier version, and records the delete
 * confirmation (cancelled). It then takes the browser offline so a real save
 * fails (Local only, with Retry), opens the sidebar's "only on this device"
 * list, and comes back online and retries. Finally it types and saves a
 * spreadsheet, which Document history lists and previews beside documents.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { helpers } = require("./user-common.cjs");
const { composer, scrollTo, sendChat, waitForReply } = helpers;

const REQUEST = "Draft a one-page synthetic vendor onboarding checklist with the headings Purpose, Before you start, Review steps, and Owners. Keep it under 200 words.";
const OPEN_FILE = "synthetic-vendor-policy.md";
const OPEN_SECTIONS = [
  ["Scope", "This policy covers every synthetic vendor that receives customer data, system access, or confidential documents from Example Corporation.", "Small suppliers follow the same steps as large ones, because the risk comes from what they receive, not from their size."],
  ["Owners", "The vendor manager owns each review. The security team approves access, and the legal team signs the agreement before any data moves.", "Each review names one person from each team, so a question never waits for someone to claim it."],
  ["Questionnaires", "Each vendor answers the security questionnaire before its first review meeting. Missing answers hold the review until the vendor supplies them.", "The vendor manager checks that every answer has evidence attached, such as a certificate or a test summary."],
  ["Data handling", "The review records what data the vendor will receive, where the vendor stores it, how long it is kept, and who approved the transfer.", "Anything not listed in that record stays out of the engagement until the record is updated and approved again."],
  ["Access", "Vendor accounts are named, time limited, and removed when the engagement ends. Shared accounts are not permitted under this synthetic policy.", "The security team checks the account list every quarter and closes any account that no longer has an owner."],
  ["Incidents", "A vendor reports a suspected incident within one business day. The security team records the report and decides whether the engagement continues.", "A confirmed incident reopens the review, and the vendor's access is limited until the review is finished."],
  ["Renewals", "Every renewal repeats the questionnaire. A vendor whose answers changed returns to the full review before the renewal is signed.", "Renewal reminders go out ninety days ahead, which leaves time for a full review when one is needed."],
  ["Exceptions", "An exception needs written approval from the security team, names an owner, and expires after six months unless it is approved again.", "Expired exceptions are closed automatically, and the vendor returns to the standard review."],
  ["Records", "The questionnaire, approvals, and signed agreement stay in the vendor file for seven years, then follow the normal retention schedule.", "The file also keeps each renewal decision, so an auditor can read the whole history in one place."],
  ["Reporting", "The vendor manager sends a summary of open reviews to the operations team each month.", "The summary lists overdue items first, with the owner of each one, so the team can act on them at the next meeting."],
];
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
  // Long enough to run across several pages, so the page navigator has work to do.
  ...OPEN_SECTIONS.flatMap(([title, first, second]) => [`## ${title}`, "", first, "", second, ""]),
].join("\n");

const TRANSFER_REQUEST = "Give me a short vendor renewal note for the operations team: a one-line purpose, then three bullet points on what to check.";

const body = (page) => page.getByRole("textbox", { name: "Document body", exact: true });

async function openDrafts(kit) {
  const page = await kit.app("user", "/drafts");
  await body(page).waitFor();
  await page.waitForTimeout(1500);
  return page;
}

/** Ask the assistant and wait until it has finished writing on the page. The
 * optional `whileRunning` sees the run in progress, with its trace on screen. */
async function askAssistant(page, text, whileRunning) {
  const box = page.locator("#draft-assistant-command");
  await box.fill(text);
  await page.getByRole("button", { name: "Apply instruction" }).click();
  const busy = page.getByText(/^(Writing…|Building slides…)$/).first();
  await busy.waitFor({ timeout: 30000 });
  if (whileRunning) await whileRunning();
  await busy.waitFor({ state: "detached", timeout: 3600000 });
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
  await page.locator(".document-save-state").filter({ hasText: "Saved" }).waitFor();
  await page.waitForTimeout(1200);
  if (await save.isEnabled()) {
    await save.click();
    await page.locator(".document-save-state").filter({ hasText: "Saved" }).waitFor();
    await page.waitForTimeout(700);
  }
}

const userDrafts = {
  role: "user",
  description: "Write a document with the assistant, edit with AI, save, export Word, and open a file in the editor.",
  externalOrigins: () => [],
  frames: [
    "user/drafts-blank", "user/drafts-request", "user/drafts-running", "user/drafts-generated", "user/drafts-ai-menu", "user/drafts-ai-review",
    "user/draft-slash", "user/draft-find", "user/drafts-saved", "user/drafts", "user/drafts-export-menu", "user/drafts-exported",
    "user/drafts-pdf-exported", "user/drafts-print",
    "user/drafts-open-menu", "user/drafts-opened", "user/drafts-pages", "user/drafts-transfer-menu", "user/drafts-transferred",
  ],
  async run(kit) {
    const { shot } = kit;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-drafts-"));
    try {
      const page = await openDrafts(kit);
      if ((await body(page).innerText()).trim()) throw new Error("Drafts should open on a blank document.");
      await shot("drafts-blank");

      // 1. The assistant writes the document.
      await page.locator("#draft-assistant-command").fill(REQUEST);
      await shot("drafts-request", { keepFocus: true });
      await askAssistant(page, REQUEST, async () => {
        // The trace lands one step at a time; show it with a few steps down.
        await page.locator(".work-trace.is-running .work-trace-step:not(.is-next)").nth(2).waitFor({ timeout: 120000 });
        await page.waitForTimeout(500);
        await shot("drafts-running", { keepFocus: true });
      });
      const words = (await body(page).innerText()).split(/\s+/).filter(Boolean).length;
      if (words < 40) throw new Error(`The assistant wrote only ${words} words.`);
      await page.locator(".work-trace.is-complete").waitFor();
      await page.evaluate(() => document.querySelector(".document-page, [aria-label='Document body']")?.scrollIntoView({ block: "start" }));
      await shot("drafts-generated");

      // The first draft sets its own title; the person types theirs afterward.
      await page.getByRole("textbox", { name: "Document title", exact: true }).fill("Synthetic vendor onboarding checklist");

      // 2. Edit a passage with AI, review it, and accept it.
      await selectFirstParagraph(page);
      await page.locator(".document-selection-toolbar").getByRole("button", { name: /^Ask AI/ }).click();
      await page.locator(".ai-composer").waitFor();
      await page.waitForTimeout(500);
      await shot("drafts-ai-menu", { keepFocus: true });
      // A word-level edit keeps the passage's formatting, and the review says so.
      await page.getByRole("option", { name: "Improve writing", exact: true }).click();
      let kept = false;
      for (let attempt = 0; attempt < 3 && !kept; attempt += 1) {
        if (attempt) await page.locator(".ai-composer").getByRole("button", { name: "Try again" }).click();
        await page.locator(".ai-composer.is-review").waitFor({ timeout: 3600000 });
        await page.waitForTimeout(800);
        kept = await page.locator(".ai-composer .ai-composer-kept").isVisible();
      }
      if (!kept) throw new Error("The Improve writing review did not keep the original formatting.");
      await shot("drafts-ai-review");
      await page.getByRole("button", { name: "Accept AI suggestion" }).click();
      await page.waitForTimeout(1000);

      // The slash menu on a new empty line, then Outline and Find.
      await body(page).evaluate((root) => {
        root.focus();
        const paragraph = [...root.querySelectorAll("p")].find((node) => node.textContent.trim().length > 40);
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      await page.locator(".document-slash-menu").waitFor();
      await page.waitForTimeout(500);
      await shot("draft-slash", { keepFocus: true });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Backspace");
      await page.getByRole("button", { name: "Document outline", exact: true }).click();
      await page.getByRole("button", { name: "Find and replace", exact: true }).click();
      await page.keyboard.type("vendor");
      await page.waitForTimeout(600);
      await shot("draft-find", { keepFocus: true });
      await page.keyboard.press("Escape");
      if (await page.locator(".document-outline").isVisible().catch(() => false)) await page.getByRole("button", { name: "Document outline", exact: true }).click();
      await page.waitForTimeout(400);

      // 3. Save a version.
      await saveVersion(page);
      await shot("drafts-saved");
      // An overview of the editor: assistant rail, format switch, toolbar, page.
      await page.evaluate(() => document.querySelector("[aria-label='Document body']")?.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(500);
      await shot("drafts");

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

      // 5. The same saved version as a server-built PDF; the file is checked.
      const pdfDownload = page.waitForEvent("download", { timeout: 180000 });
      await panel.getByRole("button", { name: /PDF document/ }).click();
      const pdf = await pdfDownload;
      if (!/\.pdf$/.test(pdf.suggestedFilename())) throw new Error(`Unexpected export ${pdf.suggestedFilename()}`);
      const pdfPath = path.join(dir, pdf.suggestedFilename());
      await pdf.saveAs(pdfPath);
      const pdfBytes = fs.readFileSync(pdfPath);
      if (pdfBytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("The PDF export is not a PDF file.");
      await panel.locator(".document-export-receipt, .document-export-print-notice").filter({ hasText: pdf.suggestedFilename() }).first().waitFor();
      await shot("drafts-pdf-exported", { keepFocus: true });

      // 6. Print opens the browser's own dialog; headless Chromium shows none.
      await panel.getByRole("button", { name: /^Print/ }).click();
      await panel.getByText("Print dialog opened with the saved version.").waitFor({ timeout: 30000 });
      await shot("drafts-print", { keepFocus: true });
      if (await panel.isVisible()) await page.getByRole("button", { name: "Close export options" }).click();

      // 7. Open a file from this device in the editor.
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

      // 8. A long document: the navigator beside the page and the status bar stay put.
      const navigator = page.locator(".document-page-navigator");
      await page.waitForFunction(() => /Page 1 of [2-9]/.test(document.querySelector(".document-page-navigator")?.getAttribute("aria-label") || ""), null, { timeout: 30000 });
      await navigator.getByRole("button", { name: "Next page" }).click();
      await page.waitForFunction(() => /Page 2 of /.test(document.querySelector(".document-page-navigator")?.getAttribute("aria-label") || ""));
      await page.waitForTimeout(1200);
      await shot("drafts-pages");
      await page.context().close();

      // 9. A finished chat reply, sent to Drafts through the chooser.
      const chat = kit.use(await kit.app("user", "/chat"));
      await composer(chat).waitFor();
      const before = await sendChat(chat, TRANSFER_REQUEST);
      const reply = await waitForReply(chat, before, { timeout: 3600000 });
      const transfer = reply.locator(".transfer-draft-button");
      await scrollTo(chat, transfer);
      await transfer.click();
      const chooser2 = chat.getByRole("menu", { name: "Open in Drafts as" });
      await chooser2.waitFor();
      await chat.waitForTimeout(500);
      await shot("drafts-transfer-menu", { keepFocus: true });
      await chooser2.getByRole("menuitem", { name: /^Word document/ }).click();
      await body(chat).waitFor({ timeout: 30000 });
      await chat.locator(".document-save-state").filter({ hasText: "Saved" }).waitFor({ timeout: 60000 });
      await chat.waitForTimeout(1500);
      await shot("drafts-transferred");
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

const BRAND = path.join(__dirname, "..", "fixtures", "brand-template.pptx");

// The last sentence keeps a small local model's reply in the deck format; the lesson says so.
const OUTLINE = "Build a kickoff deck for a synthetic vendor review with exactly 4 slides. Slide 1: title. Slide 2: goals. Slide 3: timeline. Slide 4: next steps. Each slide's layout value is just the layout's name, with its fields beside it.";
const OUTLINE_ATTEMPTS = 5;

/** Ask for the outline deck in a fresh blank deck. This model can still answer
 * in a shape the deck rejects, which ends in a thin fallback deck (the lesson's
 * troubleshooting covers it). A person would ask again, so the module does. */
async function buildOutlineDeck(kit) {
  const { shot } = kit;
  for (let attempt = 1; attempt <= OUTLINE_ATTEMPTS; attempt += 1) {
    const page = await newDraft(kit);
    await page.locator(".deck-mode-switch").getByRole("button", { name: "Deck", exact: true }).click();
    await page.locator(".deck-filmstrip").waitFor();
    await page.getByRole("textbox", { name: "Document title", exact: true }).fill("Vendor review kickoff deck");
    await page.locator("#draft-assistant-command").fill(OUTLINE);
    await shot("deck-outline-request", { keepFocus: true });
    await askAssistant(page, OUTLINE);
    // The rail's "Drafted N slides" event marks the end.
    const drafted = page.locator(".draft-event").filter({ hasText: /Drafted \d+ slides? with|Deck request failed/ }).last();
    await drafted.waitFor({ timeout: 3600000 });
    if (/Deck request failed/.test(await drafted.innerText())) throw new Error(await drafted.innerText());
    await page.waitForTimeout(1500);
    const slides = await page.locator(".deck-filmstrip").getByRole("button", { name: /^Slide \d+: / }).count();
    if (slides >= 3) return page;
    console.log(`  attempt ${attempt}: ${(await drafted.innerText()).split("\n")[0]}`);
    await page.context().close();
  }
  throw new Error(`The deck assistant did not build a full deck in ${OUTLINE_ATTEMPTS} attempts.`);
}

/** Scroll a theme into view in the gallery and apply it to the deck. */
async function chooseTheme(page, name) {
  const card = page.getByRole("button", { name: `Apply ${name} theme`, exact: true });
  await card.evaluate((node) => node.scrollIntoView({ block: "nearest", inline: "center" }));
  await page.waitForTimeout(300);
  await card.click();
  await page.waitForTimeout(900);
}

const userDecks = {
  role: "user",
  description: "Convert a document into slides, build a deck from an outline, present, export PowerPoint, and start from a template or brand.",
  externalOrigins: () => [],
  frames: [
    "user/deck-convert-dialog", "user/deck-converted", "user/deck-outline-request", "user/deck-generated", "user/deck-layouts",
    "user/deck-themes", "user/deck-themes-more", "user/deck-theme-sorter",
    "user/deck-notes", "user/deck-presenter", "user/deck-export-menu", "user/deck-exported",
    "user/deck-starters", "user/deck-template-started", "user/deck-templates", "user/deck-editor-brand",
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

    // 2. Start a new deck from a starter template, then apply a brand template.
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

    // Your organization's PowerPoint brand template (synthetic), applied to this deck.
    await page.getByRole("button", { name: "Deck starters & brand themes" }).click();
    await templates.waitFor();
    const brand = page.waitForEvent("filechooser");
    await templates.getByRole("button", { name: /^(Upload|Replace) brand template$/ }).click();
    await (await brand).setFiles(BRAND);
    await templates.getByRole("button", { name: /Applied — remove|Apply to deck/ }).first().waitFor({ timeout: 120000 });
    const apply = templates.getByRole("button", { name: "Apply to deck" });
    if (await apply.isVisible().catch(() => false)) await apply.click();
    await templates.getByRole("button", { name: "Applied — remove" }).waitFor();
    await page.waitForTimeout(800);
    await shot("deck-templates", { keepFocus: true });
    // Load all N slides starts the deck from the brand template's own slide designs.
    await templates.getByRole("button", { name: /^Load all \d+ slides$/ }).click();
    const discard = page.getByRole("button", { name: "Discard and continue" });
    if (await discard.isVisible().catch(() => false)) await discard.click();
    await page.waitForTimeout(1500);
    if (await templates.isVisible().catch(() => false)) await page.getByRole("button", { name: "Deck starters & brand themes" }).click();
    await page.locator(".deck-filmstrip button.deck-slide-thumb").first().click();
    await page.waitForTimeout(1000);
    await shot("deck-editor-brand");

    // 3. A deck built from an outline request by the deck assistant.
    await page.context().close();
    page = await buildOutlineDeck(kit);
    const title = page.getByRole("textbox", { name: "Document title", exact: true });
    if ((await title.inputValue()) !== "Vendor review kickoff deck") await title.fill("Vendor review kickoff deck");
    await saveVersion(page);
    const fitCheck = page.locator(".draft-event").filter({ hasText: /Fit check/ }).last();
    await fitCheck.waitFor();
    await fitCheck.evaluate((node) => node.scrollIntoView({ block: "end" }));
    await page.waitForTimeout(400);
    await shot("deck-generated");

    // The layouts and themes strip above the slide folds away for more room.
    const strip = page.locator("section.deck-design-browser");
    const show = page.getByRole("button", { name: "Show layouts and themes" });
    if (await show.isVisible().catch(() => false)) await show.click();
    await strip.locator(".deck-layout-gallery").evaluate((gallery) => { gallery.scrollLeft = gallery.scrollWidth; });
    await page.waitForTimeout(600);
    await shot("deck-layouts");

    // Each theme is a whole design. Open a content slide, so a design shows on
    // more than the title; the gallery scrolls to the rest of the seven.
    await page.locator(".deck-filmstrip button.deck-slide-thumb").nth(1).click();
    await page.waitForTimeout(600);
    await strip.getByRole("button", { name: "Themes", exact: true }).click();
    await chooseTheme(page, "Signal");
    await shot("deck-themes");
    await chooseTheme(page, "Midnight");
    await shot("deck-themes-more");
    await chooseTheme(page, "Swiss");
    await page.getByRole("button", { name: "Slide sorter", exact: true }).click();
    await page.locator(".deck-sorter").waitFor();
    await page.waitForTimeout(800);
    await shot("deck-theme-sorter");
    await page.getByRole("button", { name: "Slide sorter", exact: true }).click();
    await chooseTheme(page, "Aperture");
    await strip.getByRole("button", { name: "Layouts", exact: true }).click();

    // Speaker notes for the first slide; they export and follow you into presenter view.
    await page.locator(".deck-filmstrip button.deck-slide-thumb").first().click();
    await page.locator(".deck-notes-strip button", { hasText: "Speaker notes" }).first().click();
    await page.locator("textarea[aria-label='Speaker notes']").fill("Open with why the review matters: every vendor gets the same checks before it touches customer data.");
    await page.waitForTimeout(600);
    await shot("deck-notes", { keepFocus: true });
    await saveVersion(page);

    // 4. Present it in presenter view.
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

    // 5. Export a real PowerPoint file.
    await page.locator(".document-export-button").click();
    await page.locator("#document-export-panel").waitFor();
    await page.waitForTimeout(400);
    await shot("deck-export-menu", { keepFocus: true });
    await exportDownload(page, /PowerPoint deck/, /\.pptx$/);
    await shot("deck-exported", { keepFocus: true });
  },
};

const RENEWALS = [
  ["Vendor", "Renewal date", "Owner"],
  ["Northwind Example Supplies", "2026-12-01", "Vendor manager"],
  ["Contoso Example Services", "2027-01-15", "Security team"],
];

/** Type one row at a person's pace, then return to its first column. */
async function typeRow(page, cells) {
  for (const [index, text] of cells.entries()) {
    await page.keyboard.type(text, { delay: 40 });
    await page.keyboard.press(index === cells.length - 1 ? "Enter" : "Tab");
    await page.waitForTimeout(250);
  }
  for (let moved = 1; moved < cells.length; moved += 1) {
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(120);
  }
}

const userDraftHistory = {
  role: "user",
  description: "Archive, restore, preview, and reopen versions; see the delete confirmation; recover from a failed save.",
  externalOrigins: () => [],
  frames: [
    "user/history-open", "user/draft-history", "user/history-archived", "user/history-restored", "user/history-versions",
    "user/history-delete", "user/drafts-save-failed", "user/unsynced-work", "user/history-local-changes", "user/history-spreadsheet",
  ],
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

    const toggle = page.getByRole("button", { name: "Document history", exact: true });
    await toggle.click();
    const panel = page.locator(".draft-history-panel");
    await panel.waitFor();
    const card = panel.locator(".draft-history-document-card").filter({ hasText: "Quarterly vendor summary" }).first();
    await card.waitFor();
    await page.waitForTimeout(600);
    await shot("history-open");
    // Point at a card to preview it, without scrolling the list.
    const box = await card.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator(".draft-history-preview").waitFor();
    await page.waitForTimeout(600);
    await shot("draft-history", { keepPointer: true });
    await page.mouse.move(1, 1);

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
    await page.waitForTimeout(400);
    await toggle.click();

    // A save that cannot reach the server: the browser is offline.
    await page.context().setOffline(true);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Offline note: the third vendor's renewal is still being negotiated.", { delay: 15 });
    await page.getByRole("button", { name: "Save version", exact: true }).click();
    const chip = page.locator(".document-save-state").filter({ hasText: "Local only" });
    await chip.waitFor({ timeout: 60000 });
    await page.locator(".document-save-action").filter({ hasText: "Retry" }).waitFor();
    await page.waitForTimeout(800);
    await shot("drafts-save-failed");

    // Back online: nothing retries by itself, so the change is still only here.
    await page.context().setOffline(false);

    // The sidebar counts what is only on this device.
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page.getByRole("button", { name: /only on this device/i }).first().click();
    const dialog = page.getByRole("dialog", { name: "Only on this device" });
    await dialog.waitFor();
    await page.waitForTimeout(600);
    await shot("unsynced-work");

    // Open Drafts, find the draft marked Local changes in Document history,
    // open it, and retry the save.
    await dialog.getByRole("button", { name: /Open Drafts/ }).first().click();
    await body(page).waitFor();
    await page.getByRole("button", { name: "Document history", exact: true }).click();
    const local = page.locator(".draft-history-document-card").filter({ hasText: "Local changes" }).filter({ hasText: "Quarterly vendor summary" }).first();
    await local.waitFor();
    await page.waitForTimeout(600);
    await shot("history-local-changes");
    await local.click();
    const retry = page.locator(".document-save-action").filter({ hasText: "Retry" });
    const saved = page.locator(".document-save-state").filter({ hasText: "Saved" });
    await retry.waitFor({ timeout: 30000 });
    await retry.click();
    await saved.waitFor({ timeout: 60000 });
    await page.context().close();

    // A spreadsheet saves and returns the same way; its card carries a grid icon.
    const sheet = kit.use(await newDraft(kit));
    await sheet.locator(".deck-mode-switch").getByRole("button", { name: "Spreadsheet", exact: true }).click();
    const grid = sheet.getByRole("grid").first();
    await grid.waitFor();
    await sheet.getByRole("textbox", { name: "Document title", exact: true }).fill("Vendor renewal tracker");
    await grid.click({ position: { x: 90, y: 40 } });
    for (const row of RENEWALS) await typeRow(sheet, row);
    await saveVersion(sheet);
    await sheet.getByRole("button", { name: "Document history", exact: true }).click();
    const workbook = sheet.locator(".draft-history-document-card").filter({ hasText: "Vendor renewal tracker" }).first();
    await workbook.waitFor();
    const workbookBox = await workbook.boundingBox();
    await sheet.mouse.move(workbookBox.x + workbookBox.width / 2, workbookBox.y + workbookBox.height / 2);
    await sheet.locator(".draft-history-preview").filter({ hasText: "Northwind Example Supplies" }).waitFor();
    await sheet.waitForTimeout(600);
    await shot("history-spreadsheet", { keepPointer: true });
  },
};

module.exports = { "user-drafts": userDrafts, "user-decks": userDecks, "user-draft-history": userDraftHistory };
