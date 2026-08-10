/* Captures real user-facing screens from the live app for the Help training videos.
 *
 *   CAPTURE_APP_URL=https://your-instance.example \
 *   CAPTURE_USER_ID=<user-id> \
 *   CAPTURE_SESSION_TOKEN=$(cat /tmp/aperture-jordan-token.txt) \
 *     node scripts/capture-training-frames.cjs
 *
 * Expects the account to already hold the demo chats (vendor agreement,
 * welcome note, retention schedules, mermaid workflow, lighthouse image)
 * plus the "Client matters" folder and one pinned chat. The capture only
 * navigates, types in the composer without sending, and generates one real
 * draft through the Draft Assistant.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "public", "training", "user");
const APP = process.env.CAPTURE_APP_URL || "http://localhost:5173";
const USER = process.env.CAPTURE_USER_ID || "user-jane";
const TOKEN = process.env.CAPTURE_SESSION_TOKEN || "";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1185, height: 855 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  await page.addInitScript(
    ({ user, token }) => {
      localStorage.setItem("aperture-session-user-id", user);
      if (token) localStorage.setItem("aperture-session-token", token);
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
  const clearComposer = async () => {
    const textarea = page.locator(".composer textarea");
    await textarea.press("Meta+a");
    await textarea.press("Backspace");
  };

  // Expand the Chats disclosure and its Recent + Pinned sections.
  await step("expand sidebar sections", async () => {
    await page.getByRole("button", { name: /^Chats/ }).first().click();
    await page.waitForTimeout(500);
    for (const sec of ["Recent", "Pinned"]) {
      await page.getByRole("button", { name: sec, exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(400);
    }
  });

  // --- Chat home ---
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.locator(".composer textarea").waitFor();
  await shot("chat-home");

  // Sidebar with a hovered row's quick actions.
  await step("sidebar row hover", async () => {
    await page.getByRole("button", { name: /^Show the stages/ }).first().hover();
    await page.waitForTimeout(500);
  });
  await shot("sidebar-chats");

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

  // --- Open the vendor-agreement thread: trace, actions, session panel ---
  await step("open thread", async () => {
    await page.getByRole("button", { name: /^What a/ }).first().click();
    await page.waitForTimeout(1500);
  });
  await shot("chat-thread");
  await step("expand trace", async () => {
    await page.locator(".pending-trace-toggle").first().click();
    await page.waitForTimeout(500);
    await shot("chat-trace-expanded");
    await page.locator(".pending-trace-toggle").first().click();
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
  await step("send options", async () => {
    await page.getByRole("button", { name: "Send options" }).click();
    await page.waitForTimeout(450);
    await shot("composer-send-options");
    await page.keyboard.press("Escape");
  });

  // --- Image reply + download affordance ---
  await step("image thread", async () => {
    await page.getByRole("button", { name: /^Create a minimalis/ }).first().click();
    await page.waitForTimeout(1800);
    await shot("chat-images");
    const img = page.locator("main img").last();
    await img.hover();
    await page.waitForTimeout(500);
    await shot("chat-images-download");
  });

  // --- Mermaid diagram reply ---
  await step("mermaid thread", async () => {
    await page.getByRole("button", { name: /^Show the stages/ }).first().click();
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

  // --- Agents + Automations ---
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
    await page.getByText("Knowledge", { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    await shot("knowledge");
  });
  await step("library tools", async () => {
    await page.getByText("Tools", { exact: true }).first().click();
    await page.waitForTimeout(800);
    await shot("tools");
  });

  // --- Drafts: one real assistant-generated document ---
  await step("drafts document", async () => {
    await nav.getByRole("button", { name: "Drafts", exact: true }).click();
    await page.waitForTimeout(1200);
    const draftBox = page.locator("#draft-assistant-command").first();
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
      )
      .catch(() => console.log("  (draft wait timed out)"));
    await page.waitForTimeout(1500);
    await shot("drafts");
  });

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
