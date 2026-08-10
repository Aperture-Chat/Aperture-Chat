/* Captures the Drafts deck (PowerPoint) editor for the deck training video.
 *
 *   CAPTURE_APP_URL=https://your-instance.example \
 *   CAPTURE_USER_ID=<user-id> \
 *   CAPTURE_SESSION_TOKEN=$(cat /tmp/aperture-jordan-token.txt) \
 *   CAPTURE_BRAND_PPTX=apps/web/scripts/fixtures/brand-template.pptx \
 *     node scripts/capture-deck-frames.cjs
 *
 * Restores the account's memo document from Draft history so the Deck toggle
 * shows the real conversion dialog, converts it into slides, exercises the
 * deck tools (one real AI slide image included), then loads the uploaded
 * brand template's slides for the branded filmstrip shot. Decks live in the
 * browser context's localStorage, so nothing persists after the run.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const OUT = path.join(__dirname, "..", "public", "training", "user");
const APP = process.env.CAPTURE_APP_URL || "http://localhost:5173";
const USER = process.env.CAPTURE_USER_ID || "user-jane";
const TOKEN = process.env.CAPTURE_SESSION_TOKEN || "";
const BRAND = (
  process.env.CAPTURE_BRAND_PPTX || path.join(__dirname, "fixtures", "brand-template.pptx")
).replace(/^~/, os.homedir());

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
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
    { user: USER, token: TOKEN },
  );
  const hideTooltips = () => page.addStyleTag({ content: ".apx-tooltip{display:none!important}" });
  await page.goto(APP);
  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.waitFor({ timeout: 30000 });
  await hideTooltips();

  const shot = async (name) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log("captured", name);
  };
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      console.log(`SKIPPED ${label}:`, String(e).split("\n")[0]);
    }
  };
  const closeOverlays = async () => {
    // Drawers/menus stack; close via their own close buttons, then a stage click.
    for (let i = 0; i < 3; i += 1) {
      const close = page
        .locator("button[aria-label*='Close' i]:visible, .document-tool-drawer button:has-text('×'):visible")
        .first();
      if (await close.isVisible().catch(() => false)) {
        await close.click().catch(() => {});
        await page.waitForTimeout(300);
      } else break;
    }
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
  };

  await nav.getByRole("button", { name: "Drafts", exact: true }).click();
  await page.waitForTimeout(1500);

  // Restore the memo document so the Deck toggle shows the conversion dialog.
  await step("restore memo from history", async () => {
    await page.getByRole("button", { name: "Draft history" }).click();
    await page.waitForTimeout(800);
    await page.getByText(/Memo|memo/).first().click();
    await page.waitForTimeout(1200);
    await closeOverlays();
    await page
      .waitForFunction(
        () => (document.querySelector("[contenteditable='true']")?.textContent || "").length > 300,
        null,
        { timeout: 20000 },
      )
      .catch(() => console.log("  (memo content wait timed out)"));
  });

  // Deck toggle over the document → conversion dialog.
  await page.getByRole("button", { name: "Deck", exact: true }).click();
  await page.waitForTimeout(700);
  const dialog = page.getByRole("dialog", { name: "Switch to deck mode" });
  if (await dialog.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Convert into slides" }).click();
  } else {
    console.log("no conversion dialog — deck opened directly");
  }
  await page.waitForTimeout(1800);
  await hideTooltips();
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
    await page.getByRole("button", { name: "Generate AI slide image" }).first().click();
    await page.waitForTimeout(600);
    await shot("deck-ai-image");
    const generate = page.getByRole("button", { name: "Generate image" });
    if (await generate.isEnabled().catch(() => false)) {
      await generate.click();
      console.log("  generating slide image…");
      await page
        .waitForFunction(() => !document.querySelector(".deck-stage.is-ai-editing"), null, { timeout: 180000 })
        .catch(() => {});
      await page.waitForTimeout(2000);
      await shot("deck-ai-applied");
    } else {
      await page.keyboard.press("Escape");
    }
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
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  // Templates drawer with the brand template, then the branded filmstrip.
  await step("templates drawer + brand slides", async () => {
    await page.getByRole("button", { name: "Choose template" }).click();
    await page.waitForTimeout(800);
    if (BRAND && fs.existsSync(BRAND)) {
      await page.locator("input[aria-label='Upload PowerPoint brand template']").setInputFiles(BRAND);
      await page.waitForTimeout(400);
      await page
        .waitForFunction(() => !/Reading /.test(document.body.textContent || ""), null, { timeout: 120000 })
        .catch(() => console.log("  (brand parse wait timed out)"));
      await page.waitForTimeout(800);
    }
    await shot("deck-templates");
    const loadAll = page.getByRole("button", { name: /Load all \d+ slides/ });
    if (await loadAll.isVisible().catch(() => false)) {
      await loadAll.click();
      await page.waitForTimeout(1500);
    }
    await closeOverlays();
    await page.waitForTimeout(600);
    await shot("deck-editor-brand");
  });

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
