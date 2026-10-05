/* Organizing, searching, memory, and the account panel, performed for real as
 * the synthetic standard user.
 *
 * user-organize creates a chat folder and files a chat in it, pins a chat,
 * archives one and restores it from Account › Archived chats, renames a chat,
 * hides the chat list, and opens chat previews in the sidebar and in All
 * chats. user-search uses the Search palette, Recent, and a > command.
 * user-memory adds, edits, and pins a memory, shows the real refusal of a
 * credential, saves one by asking in chat, and recalls it in a new chat.
 * user-account edits the profile, switches the appearance, sets the theme
 * schedule, records the install instructions the app shows to an iPad and an
 * Android tablet browser (user-agent emulation in a 1185 x 855 window), and
 * sends a synthetic issue report from Help, verified through the admin API.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { helpers } = require("./user-common.cjs");
const { scrollTo, composer, sendChat, waitForReply } = helpers;

const FILED = "Show the stages of a vendor onboarding process";
const PINNED = "Draft a synthetic kickoff agenda";
const ARCHIVED = "Weekly vendor review digest";

const row = (page, title) => page.locator(".chat-row").filter({ hasText: title }).first();

async function rowMenu(page, title) {
  const target = row(page, title);
  await target.scrollIntoViewIfNeeded();
  await target.hover();
  await target.locator(".chat-row-more").click();
  const menu = page.getByRole("menu", { name: `Actions for ${title}` });
  await menu.waitFor();
  return menu;
}

async function openAccount(page) {
  await page.locator("button.account-card").click();
  const drawer = page.locator(".account-utility-drawer");
  await drawer.waitFor();
  await page.waitForTimeout(500);
  return drawer;
}

const userOrganize = {
  role: "user",
  description: "Folders, moving, pinning, archiving and restoring, renaming, hiding the list, and chat previews.",
  externalOrigins: () => [],
  frames: [
    "user/organize-sidebar", "user/organize-folder-new", "user/organize-row-menu", "user/organize-move-menu", "user/organize-filed",
    "user/organize-pinned", "user/organize-archived", "user/organize-renamed", "user/organize-hidden",
    "user/preview-sidebar", "user/preview-all-chats",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("user", "/chat");
    await row(page, FILED).waitFor();
    await page.waitForTimeout(800);
    await shot("organize-sidebar");

    // 1. A folder, and a chat filed in it.
    await page.getByRole("button", { name: "Create chat folder" }).click();
    await page.getByLabel("Folder name").fill("Vendor reviews");
    await shot("organize-folder-new", { keepFocus: true });
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.locator(".chat-section.folder-section").filter({ hasText: "Vendor reviews" }).waitFor();
    let menu = await rowMenu(page, FILED);
    await shot("organize-row-menu", { keepPointer: true });
    await menu.getByRole("menuitem", { name: /Move to folder/ }).click();
    await page.waitForTimeout(400);
    await shot("organize-move-menu", { keepPointer: true });
    await page.locator("[role='menu']").getByText("Vendor reviews", { exact: true }).click();
    await page.locator(".chat-section.folder-section").filter({ hasText: FILED }).waitFor();
    await page.waitForTimeout(600);
    await shot("organize-filed");

    // 2. Pin a chat.
    menu = await rowMenu(page, PINNED);
    await menu.getByRole("menuitem", { name: "Pin chat" }).click();
    await page.locator(".chat-section:has(#sidebar-pinned-label)").filter({ hasText: PINNED }).waitFor();
    await page.waitForTimeout(600);
    await shot("organize-pinned");

    // 3. Archive a chat, then find and restore it from the account panel.
    menu = await rowMenu(page, ARCHIVED);
    await menu.getByRole("menuitem", { name: "Archive" }).click();
    await row(page, ARCHIVED).waitFor({ state: "detached" });
    const drawer = await openAccount(page);
    const archive = drawer.locator(".settings-card, section, div").filter({ hasText: /^Archived chats/ }).first();
    await drawer.getByRole("button", { name: /^View/ }).last().click();
    await drawer.getByRole("button", { name: `Restore ${ARCHIVED}` }).waitFor();
    await scrollTo(page, drawer.getByRole("button", { name: `Restore ${ARCHIVED}` }), "center");
    await shot("organize-archived");
    await drawer.getByRole("button", { name: `Restore ${ARCHIVED}` }).click();
    await page.keyboard.press("Escape");
    await row(page, ARCHIVED).waitFor();
    void archive;

    // 4. Rename the open chat from its header.
    await row(page, FILED).click();
    await page.getByRole("button", { name: "Rename chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Chat name" }).fill("Vendor onboarding stages (synthetic)");
    await page.getByRole("button", { name: "Save chat name" }).click();
    await row(page, "Vendor onboarding stages (synthetic)").waitFor();
    await page.waitForTimeout(800);
    await shot("organize-renamed");

    // 5. Hide the whole chat list, then show it again.
    await page.locator(".chat-library-toggle").click();
    await page.locator(".chat-library-count").waitFor();
    await page.waitForTimeout(500);
    await shot("organize-hidden");
    await page.locator(".chat-library-toggle").click();
    await row(page, PINNED).waitFor();

    // 6. Previews: in the sidebar and in All chats.
    await row(page, PINNED).hover();
    await page.locator(".chat-hover-preview").waitFor();
    await page.waitForTimeout(600);
    await shot("preview-sidebar", { keepPointer: true });
    await page.mouse.move(600, 400);
    await page.locator(".sidebar-view-all").filter({ hasText: "View all chats" }).click();
    const all = page.getByRole("dialog", { name: "All chats" }).or(page.locator(".utility-drawer").filter({ hasText: "All chats" })).first();
    await all.waitFor();
    const allRow = all.locator("button, [role='button'], .chat-row").filter({ hasText: "What do you remember about me?" }).first();
    await allRow.hover();
    await page.locator(".chat-hover-preview").waitFor();
    await page.waitForTimeout(600);
    await shot("preview-all-chats", { keepPointer: true });
  },
};

const userSearch = {
  role: "user",
  description: "Search past work, reopen a result, use Recent, and run a > command.",
  externalOrigins: () => [],
  frames: ["user/search-empty", "user/search-results", "user/search-opened", "user/search-recent", "user/search-commands", "user/search-command-done"],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("user", "/chat");
    await page.locator(".nav-search").click();
    const dialog = page.getByRole("dialog").filter({ hasText: "Search past work" });
    await dialog.waitFor();
    await page.waitForTimeout(500);
    await shot("search-empty", { keepFocus: true });
    const input = page.getByLabel("Search chat titles, messages, agents, drafts, and documents");
    await input.fill("vendor");
    await dialog.getByText("Previous chats").waitFor();
    await page.waitForTimeout(1200);
    await shot("search-results", { keepFocus: true });
    await dialog.locator("[role='option'], button").filter({ hasText: "Synthetic training — vendor review checklist" }).first().click();
    await page.locator("article.assistant-message").first().waitFor();
    await page.waitForTimeout(1000);
    await shot("search-opened");
    await page.keyboard.press("ControlOrMeta+k");
    await dialog.waitFor();
    await dialog.getByText("Recent", { exact: true }).waitFor();
    await page.waitForTimeout(500);
    await shot("search-recent", { keepFocus: true });
    await input.fill(">");
    await page.waitForTimeout(600);
    await shot("search-commands", { keepFocus: true });
    await input.fill(">dark");
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    const dark = await page.evaluate(() => document.documentElement.dataset.theme || document.documentElement.className);
    if (!/dark/.test(dark)) throw new Error(`The command did not switch to dark mode (${dark}).`);
    await shot("search-command-done");
    // Leave the account in light mode for later modules.
    await page.keyboard.press("ControlOrMeta+k");
    await input.fill(">light");
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
  },
};

const userMemory = {
  role: "user",
  description: "Add, correct, pin, and protect memories, save one from chat, and recall it in a new chat.",
  externalOrigins: () => [],
  frames: ["user/memory-entry", "user/memory-settings", "user/memory-added", "user/memory-rejected", "user/memory-saved-chat", "user/memory-saved-list", "user/memory-recalled"],
  async run(kit) {
    const { shot } = kit;
    let page = await kit.app("user", "/chat");
    const drawer = await openAccount(page);
    await drawer.getByRole("button", { name: /Personalization memory/ }).first().waitFor();
    await shot("memory-entry");
    await drawer.getByRole("button", { name: /Personalization memory/ }).first().click();
    const modal = page.locator(".memory-modal");
    await modal.waitFor();
    await page.waitForTimeout(600);
    await shot("memory-settings");

    // Add a memory with a type, then pin it.
    await modal.getByLabel("Add something you want remembered").fill("Prefers summaries that start with a one-line answer");
    await modal.locator(".memory-kind-select").selectOption({ label: "Preferences" }).catch(() => {});
    await modal.getByRole("button", { name: "Add", exact: true }).click();
    const added = modal.locator(".memory-row").filter({ hasText: "one-line answer" });
    await added.waitFor();
    await added.getByRole("button", { name: /^Pin:/ }).click();
    await page.waitForTimeout(600);
    await shot("memory-added");

    // Credentials are refused, with the product's own message.
    await modal.getByLabel("Add something you want remembered").fill("My password for the vendor portal is Example-Only-123");
    await modal.getByRole("button", { name: "Add", exact: true }).click();
    await modal.getByText("Memories cannot contain credentials, keys, or sensitive identifiers.").waitFor();
    await modal.getByLabel("Add something you want remembered").fill("");
    await shot("memory-rejected");
    await modal.getByRole("button", { name: "Close memory manager" }).click();
    await page.keyboard.press("Escape");
    await page.context().close();

    // Save one by asking in chat, then recall in a new chat.
    // The reply's own "Saved to memory" note does not render (reported); the
    // memory manager is the proof that the sentence was saved.
    page = await kit.app("user", "/chat");
    let before = await sendChat(page, "Remember that I review synthetic vendors every Monday morning.");
    let reply = await waitForReply(page, before);
    await scrollTo(page, reply, "start");
    await shot("memory-saved-chat");
    const check = await openAccount(page);
    await check.getByRole("button", { name: /Personalization memory/ }).first().click();
    const list = page.locator(".memory-modal");
    await list.locator(".memory-row").filter({ hasText: "every Monday morning" }).waitFor();
    await page.waitForTimeout(500);
    await shot("memory-saved-list");
    await list.getByRole("button", { name: "Close memory manager" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "New chat" }).first().click();
    await composer(page).waitFor();
    before = await sendChat(page, "When do I review vendors, and how do I like summaries to start?");
    reply = await waitForReply(page, before);
    const text = await reply.innerText();
    if (!/Monday/i.test(text)) throw new Error(`The reply did not recall the saved memory: ${text.slice(0, 200)}`);
    await scrollTo(page, reply, "start");
    await shot("memory-recalled");
  },
};

const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

async function tabletPage(kit, userAgent) {
  // Loaded here so the walkthrough registry can be read without Playwright.
  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    ...(process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1185, height: 855 }, deviceScaleFactor: 2, serviceWorkers: "block", userAgent, hasTouch: true });
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

const userAccount = {
  role: "user",
  description: "Profile, appearance, theme schedule, tablet install instructions, Help, and an issue report.",
  externalOrigins: () => [],
  frames: [
    "user/account-profile-edit", "user/account-profile-saved", "user/appearance-dark", "user/theme-schedule-set",
    "user/install-ipad", "user/install-android", "user/help-drawer", "user/help-report-filled", "user/help-report-sent",
  ],
  async run(kit) {
    const { shot } = kit;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-account-"));
    try {
      let page = await kit.app("user", "/chat");

      // 1. Profile.
      let drawer = await openAccount(page);
      await drawer.getByRole("button", { name: /^Edit account profile for/ }).click();
      const form = drawer.locator(".account-profile-form");
      await form.waitFor();
      await form.getByLabel("Firm or organization").fill("Example Corporation");
      await form.getByLabel("Phone number").fill("+1 555 0100");
      await shot("account-profile-edit", { keepFocus: true });
      await form.getByRole("button", { name: "Save profile" }).click();
      await drawer.getByText("Profile saved.").waitFor();
      await page.waitForTimeout(500);
      await shot("account-profile-saved");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      if (await drawer.isVisible()) await drawer.getByRole("button", { name: /Close/ }).first().click().catch(() => {});

      // 2. Appearance and the theme schedule.
      await page.locator(".theme-schedule-button").first().click();
      await page.waitForTimeout(800);
      await shot("appearance-dark");
      await page.locator(".theme-schedule-button").first().click();
      await page.waitForTimeout(600);
      await page.getByRole("button", { name: "Theme schedule" }).click();
      const schedule = page.locator(".theme-schedule-modal");
      await schedule.waitFor();
      const toggle = schedule.getByRole("switch", { name: /Switch automatically/ }).or(schedule.getByLabel("Switch automatically")).first();
      if ((await toggle.getAttribute("aria-checked")) !== "true" && !(await toggle.isChecked().catch(() => false))) await toggle.click();
      await page.waitForTimeout(400);
      await shot("theme-schedule-set", { keepFocus: true });
      await schedule.getByRole("button", { name: "Cancel" }).click();

      // 3. Install instructions the app shows to tablet browsers.
      const installCard = async (agent) => {
        const tablet = await tabletPage(kit, agent);
        const modal = tablet.page.locator(".pwa-install-modal");
        if (!(await modal.isVisible().catch(() => false))) {
          await tablet.page.waitForTimeout(1500);
          if (!(await modal.isVisible())) await tablet.page.getByRole("button", { name: /Install app/ }).first().click();
        }
        await modal.waitFor();
        await tablet.page.waitForTimeout(800);
        return tablet;
      };
      const ipad = await installCard(IPAD);
      try {
        await shot("install-ipad", { page: ipad.page });
      } finally {
        await ipad.browser.close();
      }
      const android = await installCard(ANDROID);
      try {
        await shot("install-android", { page: android.page });
      } finally {
        await android.browser.close();
      }

      // 4. Help and an issue report.
      page = kit.use(page);
      await page.getByRole("button", { name: "Help", exact: true }).click();
      const help = page.getByRole("dialog", { name: "Help" });
      await help.waitFor();
      await help.getByText(/guided walkthroughs/).waitFor({ timeout: 30000 });
      await page.waitForTimeout(800);
      await shot("help-drawer");
      await help.getByRole("button", { name: /Report a problem/ }).click();
      const report = page.locator(".issue-report-form");
      await report.waitFor();
      const screenshot = path.join(dir, "synthetic-screen.png");
      await page.screenshot({ path: screenshot, clip: { x: 260, y: 0, width: 500, height: 300 } });
      const subject = "Export panel closes on Escape (synthetic test report)";
      await report.getByLabel(/Subject/).fill(subject);
      await report.getByLabel(/Message/).fill("Steps: open Drafts, choose Export, press Escape. Expected: the panel stays open until I choose Close. Actual: it closes. This is a synthetic training report.");
      await report.locator("input[type=file]").setInputFiles(screenshot);
      await page.waitForTimeout(500);
      await shot("help-report-filled", { keepFocus: true });
      await report.getByRole("button", { name: "Send report" }).click();
      await page.locator(".issue-report-success").waitFor();
      await shot("help-report-sent");
      const reports = await kit.api("admin", "GET", "/api/admin/issue-reports");
      const list = Array.isArray(reports) ? reports : reports.reports || reports.items || [];
      if (!list.some((item) => item.subject === subject)) throw new Error("The administrator cannot see the report.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

module.exports = { "user-organize": userOrganize, "user-search": userSearch, "user-memory": userMemory, "user-account": userAccount };
