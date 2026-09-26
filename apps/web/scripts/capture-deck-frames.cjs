/* Captures the Drafts deck (PowerPoint) editor for the deck training video.
 *
 *   CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=I_HAVE_REVIEWED_SYNTHETIC_DATA \
 *   CAPTURE_APP_URL=http://127.0.0.1:5173 \
 *   CAPTURE_SESSION_FILE=path/to/user-sign-in-response.json \
 *   CAPTURE_DRAFT_TITLE="Synthetic training memo" \
 *   CAPTURE_BRAND_PPTX=apps/web/scripts/fixtures/brand-template.pptx \
 *     node scripts/capture-deck-frames.cjs
 *
 * Restores the account's memo document from Document history so the Deck
 * toggle shows the real conversion dialog, converts it into slides, and
 * exercises the deck tools: one real whole-slide AI edit from the drafting
 * model (reviewed, then accepted), the synthetic background in
 * fixtures/deck-background.jpg uploaded as the user's own image, presenter
 * view, export, and the uploaded brand template's slides. The AI slide image
 * dialog needs an image-generation model; set
 * CAPTURE_KEEP_PUBLISHED_FRAMES=deck-ai-image to keep the published frame
 * when the isolated instance has none. Decks, templates, and provider calls
 * can persist server-side: use an isolated synthetic stack.
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
const BACKGROUND = path.join(__dirname, "fixtures", "deck-background.jpg");

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

  const moveTo = async (locator) => {
    // Point without Playwright's scroll-into-view so the frame keeps its layout.
    const box = await locator.boundingBox();
    if (!box) throw new Error("Hover target is not visible.");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };
  const thumb = (index) => page.locator(".deck-filmstrip").getByRole("button", { name: new RegExp(`^Slide ${index}: `) });

  await nav.getByRole("link", { name: "Drafts", exact: true }).click();
  await page.waitForTimeout(1500);

  // Restore the memo document so the Deck toggle shows the conversion dialog.
  await step("restore memo from history", async () => {
    await page.getByRole("button", { name: "Document history" }).click();
    await page.waitForTimeout(800);
    await page
      .locator(".draft-history-document-card")
      .filter({ hasText: DRAFT_TITLE || /memo/i })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await closeOverlays();
    await page.waitForFunction(
      () => (document.querySelector("[aria-label='Document body']")?.textContent || "").length > 300,
      null,
      { timeout: 20000 },
    );
  });

  // Deck toggle over the document → conversion dialog.
  await step("convert into slides", async () => {
    await page.getByRole("button", { name: "Deck", exact: true }).click();
    await page.getByRole("dialog", { name: "Switch to deck mode" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Convert into slides" }).click();
    await page.waitForTimeout(1800);
    await hideTooltips();
    await page.locator(".deck-filmstrip").evaluate((element) => { element.scrollTop = 0; });
    // Hovering a thumbnail reveals its move, duplicate, and delete actions.
    await moveTo(thumb(2));
    await page.waitForTimeout(400);
    await shot("deck-editor");
  });

  // The Layouts strip above the stage, for the second slide.
  await step("layouts strip", async () => {
    await thumb(2).click();
    await page.getByRole("button", { name: "Layouts", exact: true }).click();
    await page.mouse.move(1, 1);
    await shot("deck-layouts");
  });

  // One real whole-slide AI edit, reviewed before and after, then accepted.
  await step("slide ai edit", async () => {
    await page.getByRole("button", { name: "Edit slide with AI" }).click();
    await page.getByRole("option", { name: "Make it punchier", exact: true }).click();
    await page.locator(".ai-composer.is-review").waitFor({ timeout: 240000 });
    await page.mouse.move(1, 1);
    await shot("deck-ai-edit");
    await page.getByRole("button", { name: "Accept AI suggestion" }).click();
    await page.waitForTimeout(600);
  });

  // Speaker notes on the title slide.
  await step("speaker notes", async () => {
    await thumb(1).click();
    await page.locator("button", { hasText: "Speaker notes" }).first().click();
    await page.waitForTimeout(400);
    await page
      .locator("textarea[aria-label='Speaker notes']")
      .fill("Open with the why: consistent AI habits keep client data protected.");
    await shot("deck-notes");
  });

  // Upload the synthetic background, then show the per-slide/all-slides menu.
  await step("background upload", async () => {
    if (!fs.existsSync(BACKGROUND)) throw new Error("Synthetic slide background is missing.");
    await page.locator("input[aria-label='Upload slide background image']").setInputFiles(BACKGROUND);
    await page.waitForFunction(
      () => (document.querySelector(".deck-stage")?.style.backgroundImage || "").includes("data:image/"),
      null,
      { timeout: 20000 },
    );
    await page.getByRole("button", { name: "Slide background", exact: true }).click();
    await page.locator(".deck-background-menu").waitFor();
    await page.mouse.move(1, 1);
    await shot("deck-background");
    await page.getByRole("button", { name: "Slide background", exact: true }).click();
    await page.waitForTimeout(300);
  });

  // Presenter view: current slide, next slide, timer, and notes.
  await step("presenter view", async () => {
    await page.getByRole("button", { name: "Present deck" }).click();
    await page.getByRole("dialog", { name: "Deck presentation" }).waitFor();
    await page.waitForTimeout(600);
    await page.keyboard.press("p");
    await page.locator(".deck-presenter-side").waitFor();
    await page.mouse.move(1, 1);
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
    await page.mouse.move(1, 1);
    await shot("deck-export");
    await page.getByRole("button", { name: "Close export options", exact: true }).click();
    await page.waitForTimeout(300);
  });

  // Deck starters & brand themes with the brand template, then the branded deck.
  await step("templates drawer + brand slides", async () => {
    await page.getByRole("button", { name: "Deck starters & brand themes" }).click();
    await page.waitForTimeout(800);
    if (!BRAND || !fs.existsSync(BRAND)) throw new Error("Synthetic brand template is missing.");
    await page.locator("input[aria-label='Upload PowerPoint brand template']").setInputFiles(BRAND);
    await page.waitForTimeout(400);
    await page.waitForFunction(() => !/Reading /.test(document.body.textContent || ""), null, { timeout: 120000 });
    await page.waitForTimeout(800);
    await page.mouse.move(1, 1);
    await shot("deck-templates");
    await page.getByRole("button", { name: /Load all \d+ slides/ }).click();
    await page.waitForTimeout(1500);
    await closeOverlays();
    await page.waitForTimeout(600);
    await page.mouse.move(1, 1);
    await shot("deck-editor-brand");
  });

  // Generating a slide image needs an image-generation model. Without one,
  // keep the published frame (CAPTURE_KEEP_PUBLISHED_FRAMES=deck-ai-image).
  if (!capture.keeps("deck-ai-image")) {
    await step("ai image dialog", async () => {
      const button = page.getByRole("button", { name: "Generate AI slide image" }).first();
      if (await button.isDisabled()) throw new Error("No image-generation model is enabled for this workspace.");
      await button.click();
      await page.waitForTimeout(600);
      await shot("deck-ai-image");
      await page.getByRole("button", { name: "Close AI image dialog" }).click();
    });
  }

  await browser.close();
  capture.complete();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
