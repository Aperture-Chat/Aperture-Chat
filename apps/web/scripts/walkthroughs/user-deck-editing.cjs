/* Editing slides in the deck editor, performed for real as the synthetic
 * standard user against the local training model.
 *
 * user-deck-editing converts a typed document into slides, then adds a slide
 * from the left panel's "Add a slide" layouts, changes its layout with the
 * layout chip, uploads a synthetic picture with alt text from "Slide
 * pictures", tries "Find web images" (the capture browser reaches only this
 * instance, so the real no-results state is recorded), formats slide text
 * with the floating text toolbar and its theme colors, sizes a bullet box's
 * text up until it no longer fits (the toolbar's fit note), fixes it with
 * "Edit slide with AI" reviewed in the left panel, opens "Edit slide text with AI" and the slide background menu, and
 * has the deck assistant revise every slide so its fit check runs, then saves
 * a version. The picture is the repository's synthetic deck-background.jpg.
 */
const path = require("node:path");

const PICTURE = path.join(__dirname, "..", "fixtures", "deck-background.jpg");
const DOC_LINES = [
  "# Vendor review kickoff", "Enter",
  "## Goals", "Enter",
  "- Agree on the review scope and owners", "Enter",
  "Confirm the timeline for questionnaires", "Enter", "Enter",
  "## Risks", "Enter",
  "- Late security questionnaires", "Enter",
  "Unclear data-processing terms",
];
const OVERFLOW = [
  "Collect every supplier's completed questionnaire before the first review meeting",
  "Record which customer data each supplier will receive and who approved it",
];

const body = (page) => page.getByRole("textbox", { name: "Document body", exact: true });
const blade = (page) => page.locator("section.deck-blade, form.deck-blade").first();
const thumbs = (page) => page.locator(".deck-filmstrip button.deck-slide-thumb");

async function saveVersion(page) {
  const save = page.getByRole("button", { name: "Save version", exact: true });
  if (await save.isEnabled()) await save.click();
  await page.locator(".document-server-save-state").filter({ hasText: "Saved" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1200);
  if (await save.isEnabled()) {
    await save.click();
    await page.locator(".document-server-save-state").filter({ hasText: "Saved" }).waitFor({ timeout: 60000 });
    await page.waitForTimeout(700);
  }
}

/** The slide on the stage: its editable text boxes in reading order. */
const stageBlocks = (page) => page.locator(".deck-stage [data-deck-block]");

/** Select `text` inside a slide text box, as a drag across it would. */
async function selectInBlock(page, block, text) {
  await block.click();
  await block.evaluate((element, wanted) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent.indexOf(wanted);
      if (start === -1) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + wanted.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      return;
    }
    throw new Error(`No slide text contains ${wanted}.`);
  }, text);
  await page.waitForTimeout(700);
}

async function selectSlide(page, number) {
  await thumbs(page).nth(number - 1).click();
  await page.waitForTimeout(700);
}

const userDeckEditing = {
  role: "user",
  description: "Add a slide, change its layout, add a picture, format text, fix overflow with AI, and save after the fit check.",
  externalOrigins: () => [],
  frames: [
    "user/deck-add-panel", "user/deck-slide-added", "user/deck-change-layout", "user/deck-picture-panel",
    "user/deck-picture-added", "user/deck-web-images", "user/deck-text-toolbar", "user/deck-text-colors",
    "user/deck-text-fit", "user/deck-ai-review", "user/deck-ai-text", "user/deck-background", "user/deck-fit-check",
  ],
  async run(kit) {
    const { shot } = kit;
    // A typed document converted into slides (no model call).
    const page = await kit.app("user", "/drafts");
    await body(page).waitFor();
    await page.waitForTimeout(1500);
    if ((await body(page).innerText()).trim()) throw new Error("Drafts should open on a blank document.");
    await page.getByRole("textbox", { name: "Document title", exact: true }).fill("Vendor review kickoff");
    await body(page).click();
    for (const key of DOC_LINES) {
      if (key === "Enter") await page.keyboard.press("Enter");
      else await page.keyboard.type(key, { delay: 20 });
    }
    await saveVersion(page);
    await page.locator(".deck-mode-switch").getByRole("button", { name: "Deck", exact: true }).click();
    await page.getByRole("dialog", { name: "Switch to deck mode" }).getByRole("button", { name: "Convert into slides" }).click();
    await page.locator(".deck-filmstrip").waitFor();
    await page.waitForTimeout(1500);
    if ((await thumbs(page).count()) < 3) throw new Error("The document did not convert into three slides.");

    // 1. Add slide › "Add a slide": layouts grouped as Openers, Content, Pictures, Highlights.
    await selectSlide(page, 2);
    await page.locator("button.deck-add-slide").click();
    await page.getByRole("menu", { name: "Add a slide" }).waitFor();
    await page.waitForTimeout(700);
    await shot("deck-add-panel");
    await page.getByRole("menu", { name: "Add a slide" }).getByRole("menuitem", { name: "Two columns", exact: true }).click();
    await page.waitForTimeout(900);
    if (!(await thumbs(page).nth(2).getAttribute("aria-label") || await thumbs(page).nth(2).innerText()).includes("Two columns")
      && !/Two columns/.test(await page.locator(".deck-filmstrip").innerHTML())) throw new Error("The Two columns slide was not added after slide 2.");
    const blocks = stageBlocks(page);
    const texts = ["Scope and owners", "Security questionnaires and data terms", "Vendor manager and security team"];
    for (let index = 0; index < Math.min(texts.length, await blocks.count()); index += 1) {
      await blocks.nth(index).click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type(texts[index], { delay: 15 });
    }
    await page.locator(".deck-stage").click({ position: { x: 4, y: 4 } }).catch(() => {});
    await page.waitForTimeout(800);
    await shot("deck-slide-added");

    // 2. The layout chip opens "Change layout"; the slide keeps its words.
    await page.locator("button.deck-layout-control").first().click();
    await page.getByRole("menu", { name: "Switch this slide's layout" }).waitFor();
    await page.waitForTimeout(700);
    await shot("deck-change-layout");
    await page.getByRole("menu", { name: "Switch this slide's layout" }).getByRole("menuitem", { name: "Image + caption", exact: true }).click();
    await page.waitForTimeout(900);
    if (!/Scope and owners/.test(await page.locator(".deck-stage").innerText())) throw new Error("Changing the layout lost the slide title.");

    // 3. Slide pictures: upload a synthetic picture and give it alt text.
    await page.getByRole("button", { name: "Slide pictures" }).click();
    await page.locator("button.deck-image-upload").waitFor();
    await page.waitForTimeout(700);
    await shot("deck-picture-panel");
    const chooser = page.waitForEvent("filechooser");
    await page.locator("button.deck-image-upload").click();
    await (await chooser).setFiles(PICTURE);
    await page.locator(".deck-stage img.deck-media-image").first().waitFor({ timeout: 30000 });
    await page.getByLabel("Picture alt text").fill("Abstract teal pattern (synthetic image)");
    await page.waitForTimeout(900);
    await shot("deck-picture-added");

    // 4. Find web images: the real result in this environment.
    await page.getByLabel("Picture description").fill("vendor security review");
    await blade(page).getByRole("button", { name: "Find web images" }).click();
    await page.getByText(/No web images were found for|Use /).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(700);
    await shot("deck-web-images");
    await blade(page).getByRole("button", { name: "Done" }).click();
    await page.waitForTimeout(700);

    // 5. Format slide text with the floating text toolbar.
    await selectSlide(page, 2);
    const bullets = stageBlocks(page).nth(1);
    await selectInBlock(page, bullets, "review scope");
    const toolbar = page.locator(".deck-text-toolbar");
    await toolbar.waitFor();
    await shot("deck-text-toolbar", { keepFocus: true });
    await toolbar.getByRole("button", { name: "Text color" }).click();
    const colors = page.getByRole("menu", { name: "Theme colors" });
    await colors.waitFor();
    await page.waitForTimeout(500);
    await shot("deck-text-colors", { keepFocus: true });
    await colors.getByRole("menuitem", { name: "Accent 1" }).click();
    await page.waitForTimeout(500);
    await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
    await page.waitForTimeout(500);

    // 6. Bigger text than the box holds: it shrinks to fit, and the toolbar says so.
    await bullets.click();
    await page.keyboard.press("ControlOrMeta+End");
    for (const line of OVERFLOW) {
      await page.keyboard.press("Enter");
      await page.keyboard.type(line, { delay: 5 });
    }
    const note = page.locator(".deck-text-toolbar-notes [role=status]").filter({ hasText: /Shrunk to fit|Text overflows this box/ }).first();
    for (let step = 0; step < 10 && !(await note.isVisible().catch(() => false)); step += 1) {
      await page.locator(".deck-text-toolbar").getByRole("button", { name: "Increase font size" }).click();
      await page.waitForTimeout(500);
    }
    await note.waitFor({ timeout: 5000 });
    await page.waitForTimeout(600);
    await shot("deck-text-fit", { keepFocus: true });

    // 7. Edit slide with AI, reviewed in the left panel, fixes it.
    await page.locator(".deck-stage").click({ position: { x: 4, y: 4 } }).catch(() => {});
    await page.getByRole("button", { name: "Edit slide with AI" }).click();
    const ai = page.locator(".ai-composer.is-embedded");
    await ai.waitFor();
    await ai.getByRole("option", { name: "Cut the text in half" }).click();
    await page.locator(".ai-composer.is-review .slide-ai-preview").waitFor({ timeout: 600000 });
    await page.waitForTimeout(900);
    await shot("deck-ai-review");
    await page.getByRole("button", { name: "Accept AI suggestion" }).click();
    await page.waitForTimeout(1200);

    // 8. Paths: Edit slide text with AI, and the slide background menu.
    await selectInBlock(page, stageBlocks(page).first(), (await stageBlocks(page).first().innerText()).trim().split(/\s+/).slice(0, 2).join(" "));
    await page.locator(".deck-text-toolbar").getByRole("button", { name: /Ask AI to edit highlighted slide text/ }).click();
    await page.locator(".ai-composer.is-embedded").waitFor();
    await page.waitForTimeout(700);
    await shot("deck-ai-text", { keepFocus: true });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    if (await page.locator(".ai-composer.is-embedded").isVisible().catch(() => false)) await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Slide background", exact: true }).click();
    await page.getByRole("menu", { name: "Slide background options" }).or(page.locator(".deck-background-menu")).first().waitFor();
    await page.waitForTimeout(500);
    await shot("deck-background", { keepFocus: true });
    await page.keyboard.press("Escape");
    if (await page.locator(".deck-background-menu").isVisible().catch(() => false)) await page.getByRole("button", { name: "Slide background", exact: true }).click();

    // 9. The deck assistant revises every slide and checks that each one fits.
    await page.locator("#draft-assistant-command").fill("Make every slide title five words or fewer.");
    await page.getByRole("button", { name: "Apply instruction" }).click();
    const busy = page.locator(".draft-assistant-title small.is-working");
    await busy.waitFor({ timeout: 30000 });
    await busy.waitFor({ state: "detached", timeout: 1800000 });
    await page.locator(".draft-event").filter({ hasText: /Fit check/ }).last().waitFor({ timeout: 60000 });
    await saveVersion(page);
    await page.locator(".draft-event").filter({ hasText: /Fit check/ }).last().evaluate((node) => node.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(800);
    await shot("deck-fit-check");
  },
};

module.exports = { "user-deck-editing": userDeckEditing };
