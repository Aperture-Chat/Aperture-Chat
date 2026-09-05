/* Captures Platform Owner Console screens for the public owner training videos.
 *
 * Public assets must be produced only from an isolated local instance seeded
 * with synthetic users and data. Review every resulting image before commit:
 *
 *   CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=I_HAVE_REVIEWED_SYNTHETIC_DATA \
 *   CAPTURE_APP_URL=http://127.0.0.1:5173 \
 *   CAPTURE_USER_ID=user-owner \
 *     node scripts/capture-owner-frames.cjs
 *
 * Do not point this script at a live, customer, employee, or production-like
 * environment. It writes directly to tracked public assets.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const PUBLIC_OUT = path.join(__dirname, "..", "public", "training", "owner");
const APP = process.env.CAPTURE_APP_URL || "http://localhost:5173";
const USER = process.env.CAPTURE_USER_ID || "user-owner";
const CAPTURE_AUTH = require("./training-capture-run.cjs").captureCredentials();
const TOKEN = CAPTURE_AUTH.token;

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
  await page.addInitScript(
    ({ user, token }) => {
      localStorage.setItem("aperture-session-user-id", user);
      if (token) localStorage.setItem("aperture-session-token", token);
    },
    { user: CAPTURE_AUTH.user || USER, token: TOKEN },
  );
  const hideTooltips = () => page.addStyleTag({ content: ".apx-tooltip{display:none!important}" });
  await page.goto(APP);
  await page.getByRole("navigation", { name: "Primary" }).waitFor({ timeout: 30000 });
  await hideTooltips();

  // The consoles live in the account drawer's Management disclosure.
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.locator("summary.account-collapsible-summary").first().click();
  await page.waitForTimeout(400);
  await page.locator("button:visible", { hasText: "Platform owner console" }).first().click();
  await page.waitForTimeout(1200);
  await hideTooltips();

  const { measureFrameFocus } = require("./training-focus-measurement.cjs");
  const measured = {};
  const shot = async (name) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    Object.assign(measured, await measureFrameFocus(page, "owner", name));
    // Keep completed-frame measurements even if a later capture fails.
    fs.writeFileSync(path.join(OUT, "measured-rects.json"), JSON.stringify(measured, null, 2));
    console.log("captured", name);
  };
  const tab = async (label) => {
    await page.getByRole("tab", { name: label }).click();
    await page.waitForTimeout(900);
  };
  const scrollToText = async (text) => {
    const target = page.getByText(text, { exact: true }).first();
    await target.evaluate((el) => el.closest("section, .panel, div")?.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(600);
  };
  /* Org Settings and Audit sections start collapsed; the panel header is the
   * expander. Pure UI state, so this stays within the read-only contract. */
  const expandSection = async (title) => {
    await page.evaluate((panelTitle) => {
      const heading = [...document.querySelectorAll(".panel-header h2")].find(
        (h) => h.textContent.trim() === panelTitle,
      );
      const panel = heading?.closest(".panel");
      if (panel?.classList.contains("is-panel-collapsed")) {
        panel.querySelector(".panel-header").click();
      }
    }, title);
    await page.waitForTimeout(500);
  };

  await tab("Models");
  await shot("models");

  await tab("Providers");
  await shot("providers");

  // The API Key Vault lives inside each provider card (metadata only).
  const apiKeys = page.locator("button", { hasText: "API Keys" }).first();
  await apiKeys.click();
  await page.waitForTimeout(800);
  await page
    .getByText("API Key Vault", { exact: true })
    .first()
    .evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(500);
  await shot("vault");

  await tab("Org Settings");
  await shot("policies-current-collapsed");
  await expandSection("Role Boundary");
  await scrollToText("Role Boundary");
  await shot("roles");
  await expandSection("Single Sign-On");
  await scrollToText("Single Sign-On");
  await shot("sso");
  const testButton = page.getByRole("button", { name: /Test connection|Test SSO/i }).first();
  if (await testButton.count()) {
    await testButton.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(500);
    await shot("sso-actions");
  }
  await expandSection("Platform Branding");
  await scrollToText("Platform Branding");
  await shot("branding");
  await expandSection("Policy Controls");
  await scrollToText("Policy Controls");
  await shot("policies-current");
  await page.evaluate(() => {
    document.querySelector(".policy-toggle-stack")?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(500);
  await shot("policies-toggles-current");
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll(".panel-header h2")].find(
      (candidate) => candidate.textContent.trim() === "Policy Controls",
    );
    heading?.closest(".panel")?.querySelector(".panel-header")?.click();
  });
  await page.waitForTimeout(500);
  await expandSection("Workspace Usage Budget");
  await scrollToText("Workspace Usage Budget");
  await shot("policies-budget-current");
  // The final policy lesson now teaches owner-managed shared connectors.
  // Keep the existing asset name while capturing its actual new target.
  await expandSection("Connectors");
  await scrollToText("Connectors");
  await shot("policies-callout-current");

  await tab("Analytics");
  await page.waitForTimeout(1200);
  // Analytics sections start collapsed; expand them all for the content shots.
  for (const section of ["Runtime Clock Metadata", "Chat Feedback Analytics", "Model Activity", "User Usage"]) {
    await expandSection(section);
  }
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    document.querySelector(".analytics-console-grid")?.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(400);
  await shot("analytics");
  await scrollToText("Model Activity");
  await shot("analytics-activity");
  await tab("Audit");
  await page.waitForTimeout(1200);
  await shot("audit");
  await expandSection("Security Alerts");
  await scrollToText("Security Alerts");
  await shot("audit-alerts");
  await expandSection("Audit Trail");
  await scrollToText("Audit Trail");
  await shot("audit-trail");

  await tab("Alerts");
  await page.waitForTimeout(1000);
  await shot("alerts");
  await page.getByRole("list", { name: "Alert deliveries", exact: true }).waitFor();
  // Keep the rule templates above the delivery list visible in their shared
  // frame; centering the list alone scrolls those narrated controls away.
  await page.getByText("Alert Rules", { exact: true }).evaluate((element) => element.closest(".panel").scrollIntoView({ block: "start" }));
  await shot("alerts-deliveries");

  // Retention captures inspect synthetic chats and confirmation UI only.
  await tab("Org Settings");
  await expandSection("Data Retention");
  await page.getByText("Tag chats that use MCP connections", { exact: true }).scrollIntoViewIfNeeded();
  await shot("retention-policy");
  await tab("Audit");
  await expandSection("User Prompt Activity");
  await page.getByRole("button", { name: "Tags", exact: true }).click();
  await page.locator(".retention-tags-toolbar").scrollIntoViewIfNeeded();
  await page.locator(".retention-tagged-row").first().waitFor();
  await shot("retention-tags");
  await page.getByRole("button", { name: /^Preview the full conversation:/ }).first().click();
  await page.getByRole("dialog", { name: "Tagged conversation" }).waitFor();
  await page.getByRole("dialog", { name: "Tagged conversation" }).locator(".prompt-output-message").first().waitFor();
  await shot("retention-preview");
  await page.getByRole("button", { name: "Close conversation preview", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select all listed chats", exact: true }).check();
  await page.getByRole("button", { name: "Archive selected", exact: true }).click();
  await page.locator(".retention-batch-bar").scrollIntoViewIfNeeded();
  await shot("retention-batch");
  await page.locator(".retention-batch-bar").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select all listed chats", exact: true }).uncheck();

  // Usage needs actual reported provider activity; capture other pages first.
  await tab("Analytics");
  await expandSection("User Usage");
  await scrollToText("User Usage");
  await shot("analytics-usage");
  // The ranked per-user list sits below the charts; give it its own frame.
  await page.evaluate(() => {
    document.querySelector("[aria-label='Usage by user']")?.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(600);
  await shot("analytics-usage-users");

  await tab("Audit");
  await expandSection("User Prompt Activity");
  fs.writeFileSync(path.join(OUT, "measured-rects.json"), JSON.stringify(measured, null, 2));
  console.log("wrote measured-rects.json");

  await browser.close();
  capture.complete();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

/* Frames land in apps/web/public/training/owner/ matching FOCUS_REGIONS in
 * src/components/trainingDecks/owner.tsx. */
