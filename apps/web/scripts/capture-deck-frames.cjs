/* Captures the Drafts deck (PowerPoint) editor for the deck training video.
 *
 *   CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=I_HAVE_REVIEWED_SYNTHETIC_DATA \
 *   CAPTURE_APP_URL=http://127.0.0.1:5173 \
 *   CAPTURE_USER_ID=user-jane \
 *   CAPTURE_BRAND_PPTX=apps/web/scripts/fixtures/brand-template.pptx \
 *     node scripts/capture-deck-frames.cjs
 *
 * Restores the account's memo document from Draft history so the Deck toggle
 * shows the real conversion dialog, converts it into slides, exercises the
 * deck tools (one real AI slide image included), then loads the uploaded
 * brand template's slides for the branded filmstrip shot. Decks live in the
 * browser context's localStorage. Draft generation, template uploads, and
 * provider calls can persist server-side: use an isolated synthetic stack.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PUBLIC_OUT = process.env.CAPTURE_OUTPUT_DIRECTORY
  ? path.resolve(process.env.CAPTURE_OUTPUT_DIRECTORY)
  : path.join(__dirname, "..", "public", "training", "user");
const APP = process.env.CAPTURE_APP_URL || "http://localhost:5173";
const USER = process.env.CAPTURE_USER_ID || "user-jane";
const CAPTURE_AUTH = require("./training-capture-run.cjs").captureCredentials();
const TOKEN = CAPTURE_AUTH.token;
const DRAFT_TITLE = (process.env.CAPTURE_DRAFT_TITLE || "").trim();
const BRAND = (
  process.env.CAPTURE_BRAND_PPTX || path.join(__dirname, "fixtures", "brand-template.pptx")
).replace(/^~/, os.homedir());

(async () => {
  const { createCaptureRun } = require("./training-capture-run.cjs");
  const capture = createCaptureRun({
    scriptPath: __filename,
    publicDirectory: PUBLIC_OUT,
    appUrl: APP,
    confirmation: process.env.CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION || "",
  });
  const OUT = capture.outputDirectory;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1185, height: 855 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(25000);
  await page.addInitScript(
    ({ user, token }) => {
      localStorage.setItem("aperture-session-user-id", user);
      if (token) localStorage.setItem("aperture-session-token", token);
      delete window.showSaveFilePicker;
    },
    { user: CAPTURE_AUTH.user || USER, token: TOKEN },
  );
  const hideTooltips = () => page.addStyleTag({ content: ".apx-tooltip{display:none!important}" });
  await page.goto(APP);
  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.waitFor({ timeout: 30000 });
  await hideTooltips();

  const { measureFrameFocus } = require("./training-focus-measurement.cjs");
  const measured = {};
  const shot = async (name) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    Object.assign(measured, await measureFrameFocus(page, "user", name));
    // Keep completed-frame measurements even if a later capture fails.
    fs.writeFileSync(path.join(OUT, "measured-rects.json"), JSON.stringify(measured, null, 2));
    console.log("captured", name);
  };
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      throw new Error(`Capture failed at ${label}`, { cause: e });
    }
  };
  const closeOverlays = async () => {
    // Drawers/menus stack; close via their own close buttons, then a stage click.
    for (let i = 0; i < 3; i += 1) {
      const close = page
        .locator("button[aria-label*='Close' i]:visible, .document-tool-drawer button:has-text('×'):visible")
        .first();
      if (await close.isVisible()) {
        await close.click();
        await page.waitForTimeout(300);
      } else break;
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  };

  await nav.getByRole("button", { name: "Drafts", exact: true }).click();
  await page.waitForTimeout(1500);

  // Restore the memo document so the Deck toggle shows the conversion dialog.
  await step("restore memo from history", async () => {
    await page.getByRole("button", { name: "Draft history" }).click();
    await page.waitForTimeout(800);
    await page.getByText(DRAFT_TITLE || /Memo|memo/, { exact: Boolean(DRAFT_TITLE) }).first().click();
    await page.waitForTimeout(1200);
    await closeOverlays();
    await page
      .waitForFunction(
        () => (document.querySelector("[contenteditable='true']")?.textContent || "").length > 300,
        null,
        { timeout: 20000 },
      );
  });

  // Deck toggle over the document → conversion dialog.
  await page.getByRole("button", { name: "Deck", exact: true }).click();
  await page.waitForTimeout(700);
  const dialog = page.getByRole("dialog", { name: "Switch to deck mode" });
  await dialog.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Convert into slides" }).click();
  await page.waitForTimeout(1800);
  await hideTooltips();
  await page.locator(".deck-filmstrip").evaluate((element) => { element.scrollTop = 0; });
  await shot("deck-editor");

  // Layout menu from the toolbar.
  await step("layout menu", async () => {
    await page.getByRole("button", { name: "Slide layout" }).first().click();
    await page.waitForTimeout(500);
    await shot("deck-layouts");
    // Escape does not dismiss this menu; toggling the trigger does.
    await page.getByRole("button", { name: "Slide layout" }).first().click();
    await page.waitForTimeout(300);
  });

  // Speaker notes with a real note.
  await step("speaker notes", async () => {
    await page.locator("button", { hasText: "Speaker notes" }).first().click();
    await page.waitForTimeout(500);
    const notes = page.locator("textarea[aria-label='Speaker notes']");
    await notes.fill("Open with the why: consistent AI usage keeps client data protected.");
    await shot("deck-notes");
  });

  // Presentation mode with the notes bar showing.
  await step("present mode", async () => {
    await page.getByRole("button", { name: "Present deck" }).click();
    await page.waitForTimeout(1200);
    await shot("deck-present");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  });

  // Save a version, then the export menu.
  await step("export menu", async () => {
    await page.getByRole("button", { name: "Save version" }).click();
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: /^Export/ }).first().click();
    await page.waitForTimeout(600);
    await shot("deck-export");
    await page.getByRole("button", { name: "Close export options", exact: true }).click();
    await page.waitForTimeout(300);
  });

  // Templates drawer with the brand template, then the branded filmstrip.
  await step("templates drawer + brand slides", async () => {
    await page.getByRole("button", { name: "Choose template" }).click();
    await page.waitForTimeout(800);
    if (!BRAND || !fs.existsSync(BRAND)) throw new Error("Synthetic brand template is missing.");
    {
      await page.locator("input[aria-label='Upload PowerPoint brand template']").setInputFiles(BRAND);
      await page.waitForTimeout(400);
      await page
        .waitForFunction(() => !/Reading /.test(document.body.textContent || ""), null, { timeout: 120000 })
        ;
      await page.waitForTimeout(800);
    }
    await shot("deck-templates");
    const loadAll = page.getByRole("button", { name: /Load all \d+ slides/ });
    await loadAll.click();
    await page.waitForTimeout(1500);
    await closeOverlays();
    await page.waitForTimeout(600);
    await shot("deck-editor-brand");
  });

  // Generation-dependent controls follow saved-document navigation.
  // Selection AI edit popover over real slide text on the stage.
  await step("ai edit popover", async () => {
    const block = page.locator(".deck-stage [contenteditable='true']").first();
    await block.click({ clickCount: 3 });
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Edit selection with AI" }).click();
    await page.waitForTimeout(500);
    await page.locator("textarea[aria-label='AI edit instruction']").fill("Make this punchier");
    await shot("deck-ai-edit");
    await page.getByRole("button", { name: "Close AI edit" }).click();
    await page.waitForTimeout(300);
  });

  // Real AI slide image: capture the prefilled dialog, then generate.
  await step("ai image", async () => {
    const previousBackground = await page.locator(".deck-stage").evaluate((element) => element.style.backgroundImage);
    await page.getByRole("button", { name: "Generate AI slide image" }).first().click();
    await page.waitForTimeout(600);
    await shot("deck-ai-image");
    const generate = page.getByRole("button", { name: "Generate image" });
    await generate.click();
    console.log("generating slide image");
    await page.waitForFunction((previous) => {
      const stage = document.querySelector(".deck-stage");
      return stage && !stage.classList.contains("is-ai-editing") &&
        stage.style.backgroundImage.includes("data:image/") && stage.style.backgroundImage !== previous;
    }, previousBackground, { timeout: 180000 });
    await shot("deck-ai-applied");
  });

  await browser.close();
  capture.complete();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
