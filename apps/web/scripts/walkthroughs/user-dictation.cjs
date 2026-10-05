/* Dictation and diagrams, performed for real as the synthetic standard user.
 *
 * Dictation records from the microphone and sends the recording to a
 * transcription model. Headless Chromium has no microphone, so this module
 * starts its own Chromium with Chromium's fake capture device (a test tone)
 * and the same signed-in synthetic session, records, stops, and captures the
 * real outcome: this workspace has no transcription model, so the server
 * refuses with its own message. Nothing about the transcript is staged.
 *
 * The diagram half asks the local model for a Mermaid flowchart, records the
 * rendered figure and its Code view, and checks a real PNG download. The Edit
 * dialog is not captured: it renders clipped inside the message column (it is
 * not portaled), which is reported as a product bug.
 */
const { helpers } = require("./user-common.cjs");
const { composer, sendChat, waitForReply, scrollTo } = helpers;

async function microphonePage(kit) {
  // Loaded here so the walkthrough registry can be read without Playwright.
  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    ...(process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const context = await browser.newContext({ viewport: { width: 1185, height: 855 }, deviceScaleFactor: 2, serviceWorkers: "block" });
  await context.grantPermissions(["microphone"], { origin: kit.APP });
  await context.route("**/*", (route) => {
    const origin = new URL(route.request().url()).origin;
    if (origin === kit.APP || origin === "https://fonts.googleapis.com" || origin === "https://fonts.gstatic.com") return route.continue();
    return route.abort("blockedbyclient");
  });
  const { user, token } = await kit.session("user");
  await context.addInitScript(({ id, value }) => {
    localStorage.setItem("aperture-session-user-id", id);
    localStorage.setItem("aperture-session-token", value);
  }, { id: user.id, value: token });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(kit.APP + "/chat");
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
  return { browser, page };
}

const userDictation = {
  role: "user",
  description: "Record dictation (and see the real refusal without a transcription model), and work with a Mermaid diagram.",
  externalOrigins: () => [],
  frames: ["user/dictation-recording", "user/dictation-error", "user/diagram-rendered", "user/diagram-code"],
  async run(kit) {
    const { shot } = kit;

    // 1. Dictation with Chromium's fake microphone.
    const mic = await microphonePage(kit);
    try {
      const page = kit.use(mic.page);
      await composer(page).waitFor();
      await page.locator("form.composer .dictation-button").click();
      await page.locator("form.composer .dictation-button.is-recording").waitFor();
      await page.waitForTimeout(2500);
      await shot("dictation-recording", { page });
      await page.locator("form.composer .dictation-button").click();
      const error = page.locator(".composer-error");
      await error.waitFor({ timeout: 60000 });
      if (!/dictation/i.test(await error.innerText())) throw new Error(`Unexpected dictation result: ${await error.innerText()}`);
      await shot("dictation-error", { page });
    } finally {
      await mic.browser.close();
    }

    // 2. A Mermaid diagram from the model.
    const page = await kit.app("user", "/chat");
    await composer(page).waitFor();
    let figure;
    for (let attempt = 0; attempt < 3 && !figure; attempt += 1) {
      const before = await sendChat(page, "Show the stages of a synthetic vendor onboarding process as a Mermaid flowchart. Use exactly this style: a mermaid code block with flowchart LR and four simple nodes written like A[Request] --> B[Screening], no subgraphs and no styling. After the code block, add one sentence.");
      const reply = await waitForReply(page, before);
      const panel = reply.locator(".md-diagram-panel");
      await panel.first().waitFor({ timeout: 30000 }).catch(() => {});
      await scrollTo(page, panel.first(), "center").catch(() => {});
      await page.waitForTimeout(2000);
      if (await reply.locator(".md-diagram-panel:not(.is-loading):not(.is-deferred) .md-diagram-canvas svg").count()) figure = reply.locator(".md-diagram-panel").first();
    }
    if (!figure) throw new Error("The model did not return a diagram that renders.");
    await scrollTo(page, figure, "center");
    await shot("diagram-rendered");
    await figure.locator(".md-code-action").filter({ hasText: "Code" }).click();
    await page.waitForTimeout(600);
    await shot("diagram-code");
    await figure.locator(".md-code-action").filter({ hasText: "Diagram" }).click();
    await page.waitForTimeout(800);
    await scrollTo(page, figure, "center");
    const download = page.waitForEvent("download");
    await figure.locator(".md-code-action").filter({ hasText: "PNG" }).click();
    const saved = await download;
    if (!/\.png$/.test(saved.suggestedFilename())) throw new Error(`Unexpected download ${saved.suggestedFilename()}`);
  },
};

module.exports = { "user-dictation": userDictation };
