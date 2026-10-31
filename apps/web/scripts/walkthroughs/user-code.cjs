/* Working with code in a reply, performed for real as the synthetic standard
 * user against the local training model.
 *
 * user-code asks for a small Python function, reads its trace, checks the file
 * Download really saves, edits the code in place and confirms the edit reached
 * the saved reply, then selects lines and has the model rewrite them through
 * Ask AI: review, refine, Replace, and a Discard that must leave the code alone.
 * It then asks for a one-page HTML file, opens it in the artifact
 * canvas, reads the code, edits the page and sees the preview change, expands
 * the canvas, and closes it to the pull tab. Every reply and suggestion is the
 * model's real output.
 *
 * Ask AI sends a second system message, which hosted providers accept and the
 * local training model's chat template refuses. Run this module through a local
 * proxy that merges consecutive system messages into one before forwarding.
 */
const fs = require("node:fs");
const { helpers } = require("./user-common.cjs");
const { composer, sendChat, waitForReply, scrollTo, scrollBelowHeader, toolbarAction: action, threadIdOf, savedReply } = helpers;

const PYTHON = "Write a short Python function named renewals_due that takes a list of (vendor, days_left) pairs and returns the vendors with 30 days or fewer left. Use one python code block and no explanation.";
const HTML = "Write one self-contained HTML file titled Vendor renewal countdown. Show three made-up vendors as cards with the days left until renewal, using inline CSS and no outside links. Use one html code block and no explanation.";

/** Ask until the model answers with a code block; a small model sometimes does not. */
async function askForCode(page, prompt) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await sendChat(page, prompt);
    const reply = await waitForReply(page, before, { timeout: 2400000 });
    if (await reply.locator(".md-code-panel").count()) return reply;
  }
  throw new Error("The model did not return a code block.");
}

/** Drag across code rows with the real mouse, as a reader selects them. */
async function selectRows(page, panel, first, last) {
  const rows = panel.locator("[data-code-row] .md-code-line-text");
  const start = await rows.nth(first).boundingBox();
  const end = await rows.nth(last).boundingBox();
  await page.mouse.move(start.x + 1, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width - 2, end.y + end.height / 2, { steps: 10 });
  await page.mouse.up();
}

const userCode = {
  role: "user",
  description: "Highlighted code, a named Download, edit and save, Ask AI on a selection, and the artifact canvas.",
  externalOrigins: () => [],
  frames: [
    "user/code-trace", "user/code-reply", "user/code-editing", "user/code-saved", "user/code-ask-ai",
    "user/code-ai-menu", "user/code-ai-review", "user/code-ai-refined", "user/code-ai-applied", "user/canvas-reply", "user/canvas-preview",
    "user/canvas-code", "user/canvas-edited", "user/canvas-expanded", "user/canvas-tab",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("user", "/chat");
    await composer(page).waitFor();

    // 1. A reply with a code block. A trace the reader watched stays open.
    let reply = await askForCode(page, PYTHON);
    let panel = reply.locator(".md-code-panel").first();
    await page.waitForTimeout(4000);
    await scrollBelowHeader(page, reply.locator(".work-trace"), 80);
    await shot("code-trace");
    await reply.locator(".work-trace-toggle").click();
    await page.waitForTimeout(400);

    // 2. The colors are real highlight tokens, and Download saves a named file.
    await panel.locator(".md-code-lines [class*='hljs-']").first().waitFor();
    await scrollTo(page, panel, "center");
    await shot("code-reply");
    const pending = page.waitForEvent("download");
    await action(panel, "Download").click();
    const saved = await pending;
    if (saved.suggestedFilename() !== "renewals_due.py") throw new Error(`Unexpected download name ${saved.suggestedFilename()}`);
    if (!/def renewals_due/.test(fs.readFileSync(await saved.path(), "utf8"))) throw new Error("The download does not hold the function.");

    // 3. Edit in place and save into the reply.
    const threadId = threadIdOf(page);
    await action(panel, "Edit").click();
    const input = panel.locator("textarea.code-edit-input");
    await input.waitFor();
    const code = await input.inputValue();
    if (!/\b30\b/.test(code)) throw new Error(`The function has no 30 to change: ${code}`);
    await input.fill(code.replace(/\b30\b/, "45"));
    await scrollTo(page, panel, "center");
    await shot("code-editing", { keepFocus: true });
    await action(panel, "Done").click();
    await panel.locator(".md-code-save-status.is-saved").waitFor();
    await shot("code-saved");
    if (!/\b45\b/.test(await savedReply(kit, threadId))) throw new Error("The edit did not reach the saved reply.");

    // 4. Select lines and ask the model to change only those.
    await page.waitForTimeout(600);
    const rowCount = await panel.locator("[data-code-row]").count();
    await selectRows(page, panel, 0, rowCount - 1);
    await page.locator(".code-ai-offer").waitFor();
    await shot("code-ask-ai");
    await page.locator(".code-ai-offer button").click();
    const composerDialog = page.locator(".ai-composer");
    await composerDialog.waitFor();
    await page.waitForTimeout(500);
    await shot("code-ai-menu", { keepFocus: true });
    await composerDialog.locator(".ai-composer-list").getByText("Add comments", { exact: true }).click();
    const diff = composerDialog.locator(".code-ai-diff");
    await diff.waitFor({ timeout: 600000 });
    const replace = composerDialog.getByRole("button", { name: "Accept AI suggestion" });
    await replace.waitFor();
    await page.waitForTimeout(800);
    await shot("code-ai-review", { keepFocus: true });

    // A follow-up reworks the suggestion in place.
    await composerDialog.getByLabel("Refine the AI suggestion").fill("Use one short comment on each line.");
    await composerDialog.getByRole("button", { name: "Refine suggestion" }).click();
    await page.locator(".ai-composer.is-working").waitFor();
    await page.locator(".ai-composer.is-review").waitFor({ timeout: 600000 });
    await page.waitForTimeout(800);
    await shot("code-ai-refined", { keepFocus: true });

    // Replace writes only the selected lines, and saves them into the reply.
    await replace.click();
    await composerDialog.waitFor({ state: "detached" });
    await panel.locator(".md-code-save-status.is-saved").waitFor();
    await scrollTo(page, panel, "center");
    await shot("code-ai-applied");
    const replaced = await savedReply(kit, threadId);
    if (!/#/.test(replaced)) throw new Error("The accepted comments did not reach the saved reply.");

    // Discard leaves the code exactly as it was.
    await page.waitForTimeout(600);
    await selectRows(page, panel, 0, 0);
    await page.locator(".code-ai-offer button").click();
    await composerDialog.waitFor();
    await composerDialog.locator(".ai-composer-list").getByText("Simplify", { exact: true }).click();
    await diff.waitFor({ timeout: 600000 });
    await composerDialog.getByRole("button", { name: "Discard AI suggestion" }).click();
    await composerDialog.waitFor({ state: "detached" });
    if ((await savedReply(kit, threadId)) !== replaced) throw new Error("Discard changed the saved reply.");

    // 5. An HTML page: run it in the artifact canvas.
    reply = await askForCode(page, HTML);
    panel = reply.locator(".md-code-panel").first();
    await page.waitForTimeout(4000);
    await reply.locator(".work-trace-toggle").click();
    await page.waitForTimeout(400);
    await scrollTo(page, panel.locator(".md-code-toolbar"), "center");
    await shot("canvas-reply");
    await action(panel, "Preview").click();
    const canvas = page.locator(".artifact-canvas");
    await canvas.waitFor();
    const frame = page.frameLocator(".artifact-canvas-frame");
    await frame.locator("body").waitFor();
    await page.waitForTimeout(1200);
    await shot("canvas-preview");

    // 6. The source, then an edit the preview picks up.
    await canvas.locator(".artifact-canvas-view").getByRole("radio", { name: "Code" }).click();
    await canvas.locator(".md-code-lines").waitFor();
    await page.waitForTimeout(600);
    await shot("canvas-code");
    await action(canvas, "Edit").click();
    const source = canvas.locator("textarea.code-edit-input");
    await source.waitFor();
    const html = await source.inputValue();
    if (!/Vendor renewal countdown/.test(html)) throw new Error("The page does not carry the requested title.");
    await source.fill(html.replaceAll("Vendor renewal countdown", "Vendor renewals this quarter"));
    await action(canvas, "Done").click();
    await canvas.locator(".artifact-canvas-view").getByRole("radio", { name: "Preview" }).click();
    await frame.getByText("Vendor renewals this quarter").first().waitFor();
    await page.waitForTimeout(1000);
    await shot("canvas-edited");

    // 7. Full window, then back to the chat with the pull tab.
    await canvas.locator(".artifact-canvas-expand").click();
    await page.waitForTimeout(700);
    await shot("canvas-expanded");
    await canvas.locator(".artifact-canvas-expand").click();
    await page.waitForTimeout(400);
    await canvas.locator(".artifact-canvas-close").click();
    await page.locator(".artifact-canvas-tab").waitFor();
    await page.waitForTimeout(700);
    await shot("canvas-tab");
    if (!/Vendor renewals this quarter/.test(await savedReply(kit, threadIdOf(page)))) throw new Error("The canvas edit did not reach the saved reply.");
  },
};

module.exports = { "user-code": userCode };
