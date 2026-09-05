/* Captures user-facing screens from an isolated synthetic app for Help videos.
 *
 *   CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=I_HAVE_REVIEWED_SYNTHETIC_DATA \
 *   CAPTURE_APP_URL=http://127.0.0.1:5173 \
 *   CAPTURE_SESSION_FILE=path/to/ignored/synthetic-session.json \
 *   CAPTURE_TRACE_CHAT_TITLE='Exact existing trace conversation title' \
 *   CAPTURE_IMAGE_CHAT_TITLE='Exact existing image conversation title' \
 *     node apps/web/scripts/capture-training-frames.cjs
 *
 * Requires an existing signed-in synthetic account, the saved memory-recall
 * and Mermaid examples, a pinned chat, the "Client matters" folder, and
 * accessible prompt/agent/library examples. Trace and image title overrides
 * match exact existing sidebar titles; legacy prefixes remain the defaults.
 * The trace conversation must contain an actual saved work trace, and the
 * image conversation must contain a real generated image with a download
 * control. Successful API calls alone do not establish saved UI conversations.
 * CAPTURE_TEXT_MODEL_ID optionally selects an enabled text model through the
 * real picker for chat home and drafting; no provider/model is configured here.
 * CAPTURE_REUSE_SAVED_DRAFT=1 restores CAPTURE_DRAFT_TITLE from real history.
 * CAPTURE_FOLDER_NAME optionally creates that folder through the user UI.
 * CAPTURE_OUTPUT_DIRECTORY stages a completed batch outside public assets.
 * An optional CAPTURE_AUTHORING_API_URL + CAPTURE_AUTHORING_SESSION_FILE pair
 * captures the four authoring screens from a separate local instance through
 * real API requests. This can demonstrate permitted configuration without
 * changing the generation instance's policy; no API responses are mocked.
 *
 * This is not read-only: it selects a model when requested and submits one
 * real Draft Assistant request, which can incur provider usage and persist a
 * draft. Other composer text is not sent. A complete run copies staged PNGs
 * into public training assets. Run only when these effects are authorized;
 * no responses, traces, image results, or success states are fabricated.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const PUBLIC_OUT = process.env.CAPTURE_OUTPUT_DIRECTORY
  ? path.resolve(process.env.CAPTURE_OUTPUT_DIRECTORY)
  : path.join(__dirname, "..", "public", "training", "user");
const APP = process.env.CAPTURE_APP_URL || "http://localhost:5173";
const USER = process.env.CAPTURE_USER_ID || "user-jane";
const CAPTURE_AUTH = require("./training-capture-run.cjs").captureCredentials();
const TOKEN = CAPTURE_AUTH.token;
const TRACE_CHAT_TITLE = (process.env.CAPTURE_TRACE_CHAT_TITLE || "").trim();
const IMAGE_CHAT_TITLE = (process.env.CAPTURE_IMAGE_CHAT_TITLE || "").trim();
const TEXT_MODEL_ID = (process.env.CAPTURE_TEXT_MODEL_ID || "").trim();
const DRAFT_TITLE = (process.env.CAPTURE_DRAFT_TITLE || "Synthetic training memo — AI usage guidelines").trim();
const FOLDER_NAME = (process.env.CAPTURE_FOLDER_NAME || "").trim();
const AUTHORING_API = (process.env.CAPTURE_AUTHORING_API_URL || "").trim();
const AUTHORING_SESSION = (process.env.CAPTURE_AUTHORING_SESSION_FILE || "").trim();

(async () => {
  const { createCaptureRun } = require("./training-capture-run.cjs");
  if (Boolean(AUTHORING_API) !== Boolean(AUTHORING_SESSION)) throw new Error("Both authoring API and signed session overrides are required together.");
  if (AUTHORING_API) require("./training-capture-run.cjs").validateCaptureSource(AUTHORING_API, process.env.CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION);
  const capture = createCaptureRun({
    scriptPath: __filename,
    publicDirectory: PUBLIC_OUT,
    appUrl: APP,
    confirmation: process.env.CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION || "",
  });
  const OUT = capture.outputDirectory;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1185, height: 855 }, deviceScaleFactor: 2 });
  let page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  await page.addInitScript(
    ({ user, token }) => {
      localStorage.setItem("aperture-session-user-id", user);
      if (token) localStorage.setItem("aperture-session-token", token);
    },
    { user: CAPTURE_AUTH.user || USER, token: TOKEN },
  );
  const hideTooltips = () => page.addStyleTag({ content: ".apx-tooltip{display:none!important}" });
  await page.goto(APP);
  let nav = page.getByRole("navigation", { name: "Primary" });
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
  const clearComposer = async () => {
    const textarea = page.locator(".composer textarea");
    await textarea.press("Meta+a");
    await textarea.press("Backspace");
  };
  const savedChat = (title, legacyPrefix) => page.getByRole("button", title
    ? { name: title, exact: true }
    : { name: legacyPrefix }).first();
  const openSavedChat = async (title, legacyPrefix) => {
    const match = savedChat(title, legacyPrefix);
    if (await match.isVisible()) return match.click();
    await page.getByRole("button", { name: "View all chats", exact: true }).click();
    const all = page.getByRole("dialog", { name: "All chats", exact: true });
    await all.getByRole("button", title ? { name: title, exact: true } : { name: legacyPrefix }).click();
  };
  let textModelChoice = null;
  const selectTextModel = async () => {
    if (!TEXT_MODEL_ID) return;
    await page.getByRole("button", { name: "Select model", exact: true }).click();
    const list = page.getByRole("listbox", { name: "Select model", exact: true });
    await list.waitFor({ state: "visible" });
    const listId = await list.getAttribute("id");
    for (const option of await list.getByRole("option").all()) {
      if (await option.getAttribute("id") !== `${listId}-${TEXT_MODEL_ID}`) continue;
      textModelChoice = {
        name: await option.locator("strong").innerText(),
        provider: await option.locator("small").innerText(),
      };
      await option.click();
      return;
    }
    throw new Error("CAPTURE_TEXT_MODEL_ID is not an available option in the current model picker.");
  };

  // Expand the Chats disclosure and its Recent + Pinned sections.
  await step("expand sidebar sections", async () => {
    const chats = page.getByRole("button", { name: /^Chats/ }).first();
    if (await chats.getAttribute("aria-expanded") !== "true") await chats.click();
    await page.waitForTimeout(500);
    for (const sec of ["Folders", "Recent", "Pinned"]) {
      const section = page.getByRole("button", { name: sec, exact: true }).first();
      if (await section.getAttribute("aria-expanded") !== "true") await section.click();
      await page.waitForTimeout(400);
    }
    if (FOLDER_NAME && !await page.locator(".folder-row").filter({ hasText: FOLDER_NAME }).count()) {
      await page.getByRole("button", { name: "Create chat folder", exact: true }).click();
      await page.getByRole("textbox", { name: "Folder name", exact: true }).fill(FOLDER_NAME);
      await page.locator(".folder-create-form").getByRole("button", { name: "Create", exact: true }).click();
    }
  });

  // --- Chat home ---
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.locator(".composer textarea").waitFor();
  await step("select text model", selectTextModel);
  await shot("chat-home");

  // Sidebar with a hovered row's quick actions.
  await step("sidebar row hover", async () => {
    await savedChat(TRACE_CHAT_TITLE, /^What a/).hover();
    await page.waitForTimeout(500);
  });
  await shot("sidebar-chats");
  await step("chat hover preview", async () => {
    await savedChat(TRACE_CHAT_TITLE, /^What a/).hover();
    await page.locator(".chat-hover-preview").waitFor({ state: "visible" });
    await shot("sidebar-chat-preview");
    await page.keyboard.press("Escape");
    await page.locator(".composer textarea").click();
  });

  // --- Personalization memory: account entry point and the user's private manager ---
  await step("memory manager", async () => {
    await page.locator(".account-button").click();
    await page.getByRole("dialog", { name: "Account" }).waitFor();
    await shot("memory-account");
    await page.getByRole("button", { name: /Personalization memory/ }).click();
    await page.getByRole("dialog", { name: "What the assistant remembers about you" }).waitFor();
    await page.getByText("Use memory in my chats", { exact: true }).waitFor();
    await shot("memory-manager");
    await page.getByRole("button", { name: "Close memory manager" }).click();
  });
  await step("saved memory recall", async () => {
    const title = process.env.CAPTURE_MEMORY_RECALL_TITLE || "What do you remember about me?";
    await openSavedChat(title);
    await page.locator(".message-rendered-response").first().waitFor();
    await shot("memory-recall");
  });

  // --- Open the saved trace conversation: actions and session panel ---
  await step("open thread", async () => {
    await openSavedChat(TRACE_CHAT_TITLE, /^What a/);
    await page.waitForTimeout(1500);
  });
  await shot("chat-thread");
  await step("response actions", async () => {
    const transfer = page.getByRole("button", { name: "Transfer response to Drafts", exact: true }).first();
    await transfer.scrollIntoViewIfNeeded();
    await transfer.hover();
    await shot("chat-response-actions");
  });
  await step("session panel", async () => {
    await page.getByRole("button", { name: "Session info" }).click();
    await page.locator(".session-panel").waitFor();
    await shot("chat-session-panel");
    await page.keyboard.press("Escape");
  });

  // --- Composer symbol menus (typing only, nothing sent) ---
  const textarea = page.locator(".composer textarea");
  await step("slash menu", async () => {
    await textarea.click();
    await textarea.type("/", { delay: 60 });
    await page.waitForTimeout(500);
    await shot("composer-slash");
    await clearComposer();
  });
  await step("agent menu", async () => {
    await textarea.type("@", { delay: 60 });
    await page.waitForTimeout(500);
    await shot("composer-agent");
    await clearComposer();
  });
  await step("attach menu", async () => {
    await page.getByRole("button", { name: "Add attachment" }).click();
    await page.waitForTimeout(450);
    await shot("composer-attach");
    await page.keyboard.press("Escape");
  });
  // --- Mermaid diagram reply ---
  await step("mermaid thread", async () => {
    await openSavedChat("", /^Show the stages/);
    await page.waitForTimeout(3000);
    await shot("chat-mermaid");
  });

  // --- Search palette ---
  await step("search palette", async () => {
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.waitForTimeout(700);
    await shot("search-palette");
    await page.keyboard.press("Escape");
  });

  // Runtime-only captures follow the independent navigation screens.
  await nav.getByRole("button", { name: "New chat", exact: true }).click();
  await openSavedChat(TRACE_CHAT_TITLE, /^What a/);
  await step("send options", async () => {
    await page.getByRole("button", { name: "Send options" }).click();
    await page.waitForTimeout(450);
    await shot("composer-send-options");
    await page.keyboard.press("Escape");
  });

  await step("expand trace", async () => {
    const trace = page.locator(".pending-trace-toggle").first();
    await trace.waitFor({ state: "visible" });
    if (await trace.getAttribute("aria-expanded") !== "true") await trace.click();
    await page.waitForTimeout(500);
    await shot("chat-trace-expanded");
    await trace.click();
  });
  // --- Image reply + download affordance ---
  await step("image thread", async () => {
    await openSavedChat(IMAGE_CHAT_TITLE, /^Create a minimalis/);
    const img = page.locator(".message-rendered-response .md-figure img").last();
    await img.waitFor({ state: "visible" });
    await img.scrollIntoViewIfNeeded();
    await img.evaluate((element) => element.decode());
    await shot("chat-images");
    await img.hover();
    const download = page.locator(".message-rendered-response .md-image-download").last();
    await download.waitFor({ state: "visible" });
    await download.scrollIntoViewIfNeeded();
    await download.hover();
    await page.waitForTimeout(500);
    await shot("chat-images-download");
  });

  // --- Drafts: one real assistant-generated document ---
  await step("drafts document", async () => {
    await nav.getByRole("button", { name: "Drafts", exact: true }).click();
    await page.waitForTimeout(1200);
    if (process.env.CAPTURE_REUSE_SAVED_DRAFT === "1") {
      await page.getByRole("button", { name: "Draft history", exact: true }).click();
      await page.getByText(DRAFT_TITLE, { exact: true }).first().click();
      await page.keyboard.press("Escape");
      await page.getByRole("textbox", { name: "Document body", exact: true }).waitFor();
      await page.waitForTimeout(1000);
      const body = await page.getByRole("textbox", { name: "Document body", exact: true }).innerText();
      if (body.trim().length < 300) throw new Error("The saved training memo is missing or incomplete.");
      await shot("drafts");
      return;
    }
    if (textModelChoice) {
      await page.getByRole("button", { name: "Document drafting model", exact: true }).click();
      const list = page.getByRole("listbox", { name: "Select drafting model", exact: true });
      await list.waitFor({ state: "visible" });
      const matches = [];
      for (const option of await list.getByRole("option").all()) {
        if (await option.locator("strong").innerText() === textModelChoice.name
          && await option.locator("small").innerText() === textModelChoice.provider) matches.push(option);
      }
      if (matches.length !== 1) throw new Error("The selected text model does not uniquely match an available drafting model.");
      await matches[0].click();
    }
    const draftBox = page.locator("#draft-assistant-command").first();
    const webSearch = page.getByRole("button", { name: "Disable web search", exact: true });
    if (await webSearch.isVisible()) await webSearch.click();
    await draftBox.click();
    await draftBox.fill(
      "Draft a short internal memo announcing our new AI usage guidelines: approved models only, no confidential data in unapproved tools, and where to ask questions.",
    );
    await page.locator(".draft-send-button").first().click();
    console.log("draft requested");
    await page.waitForTimeout(5000);
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector(".document-editor, [contenteditable='true']");
          return el && el.textContent && el.textContent.trim().length > 300;
        },
        null,
        { timeout: 180000 },
      );
    await page.waitForTimeout(1500);
    await page.getByRole("textbox", { name: "Document title", exact: true }).fill(DRAFT_TITLE);
    await page.getByRole("button", { name: "Save version", exact: true }).click();
    await page.getByRole("button", { name: "Current version is saved.", exact: true }).waitFor();
    await shot("drafts");
  });

  // --- Agents + Automations ---
  if (AUTHORING_API) {
    const auth = JSON.parse(fs.readFileSync(AUTHORING_SESSION, "utf8"));
    if (!auth.user?.id || !auth.session?.token) throw new Error("Authoring session file must contain an actual sign-in response.");
    const authoring = await browser.newContext({ viewport: { width: 1185, height: 855 }, deviceScaleFactor: 2 });
    await authoring.route("**/api/**", (route) => {
      const source = new URL(route.request().url());
      if (!source.pathname.startsWith("/api/")) return route.continue();
      if (!["127.0.0.1", "localhost"].includes(source.hostname)) return route.abort();
      return route.continue({ url: new URL(source.pathname + source.search, AUTHORING_API).href });
    });
    await authoring.addInitScript(({ user, token }) => {
      localStorage.setItem("aperture-session-user-id", user);
      localStorage.setItem("aperture-session-token", token);
    }, { user: auth.user.id, token: auth.session.token });
    page = await authoring.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(APP);
    nav = page.getByRole("navigation", { name: "Primary" });
    await nav.waitFor({ timeout: 30000 });
    await hideTooltips();
    fs.writeFileSync(path.join(OUT, "capture-sources.json"), JSON.stringify({
      authoringFrames: ["agents", "automations", "knowledge", "tools"],
      separateLocalAuthoringInstance: true,
      responsesMocked: false,
    }, null, 2));
  }
  await step("agents view", async () => {
    await nav.getByRole("button", { name: "Agents/Automations", exact: true }).click();
    await page.waitForTimeout(1000);
    await shot("agents");
  });
  await step("automations tab", async () => {
    await page.getByText("Automations", { exact: true }).first().click();
    await page.waitForTimeout(900);
    await shot("automations");
  });

  // --- Library: Knowledge + Tools ---
  await step("library knowledge", async () => {
    await nav.getByRole("button", { name: "Knowledge/Tools", exact: true }).click();
    await page.waitForTimeout(1000);
    await page.getByText("Knowledge", { exact: true }).first().click();
    await page.waitForTimeout(800);
    await shot("knowledge");
  });
  await step("library tools", async () => {
    await page.getByText("Tools", { exact: true }).first().click();
    await page.waitForTimeout(800);
    await shot("tools");
  });

  await browser.close();
  capture.complete();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
