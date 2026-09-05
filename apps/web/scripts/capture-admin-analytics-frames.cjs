/* Captures the Admin Console Analytics and Audit tabs for public training.
 *
 * Public assets must be produced only from an isolated local instance seeded
 * with synthetic users and data. Review every resulting image before commit:
 *
 *   CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=I_HAVE_REVIEWED_SYNTHETIC_DATA \
 *   CAPTURE_APP_URL=http://127.0.0.1:5173 \
 *   CAPTURE_USER_ID=user-admin \
 *     node scripts/capture-admin-analytics-frames.cjs
 *
 * Do not point this script at a live, customer, employee, or production-like
 * environment. It writes directly to tracked public assets.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const PUBLIC_OUT = path.join(__dirname, "..", "public", "training", "admin");
const APP = process.env.CAPTURE_APP_URL || "http://localhost:5173";
const USER = process.env.CAPTURE_USER_ID || "user-admin";
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

  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.locator("summary.account-collapsible-summary").first().click();
  await page.waitForTimeout(400);
  await page.locator("button:visible", { hasText: "Admin console" }).first().click();
  await page.waitForTimeout(1200);
  await hideTooltips();

  const { measureFrameFocus } = require("./training-focus-measurement.cjs");
  const measured = {};
  const shot = async (name) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    Object.assign(measured, await measureFrameFocus(page, "admin", name));
    // Keep completed-frame measurements even if a later capture fails.
    fs.writeFileSync(path.join(OUT, "measured-rects.json"), JSON.stringify(measured, null, 2));
    console.log("captured", name);
  };
  const scrollToText = async (text) => {
    const target = page.getByText(text, { exact: true }).first();
    await target.evaluate((el) => el.closest("section, .panel, div")?.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(600);
  };
  /* Analytics/audit sections start collapsed; the panel header expands them. */
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

  await page.getByRole("tab", { name: "Analytics" }).click();
  await page.waitForTimeout(1500);
  for (const section of [
    "Runtime Clock Metadata",
    "Chat Feedback Analytics",
    "Model Activity",
    "User Usage",
    "Workspace Usage Budget",
    "Token Allocations",
  ]) {
    await expandSection(section);
  }
  await page.evaluate(() => {
    document.querySelector(".analytics-console-grid")?.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(400);
  await shot("analytics");
  await scrollToText("Model Activity");
  await shot("analytics-activity");
  await scrollToText("Workspace Usage Budget");
  await shot("analytics-usage-budget");

  await page.getByRole("tab", { name: "Audit" }).click();
  await page.waitForTimeout(1500);
  await shot("audit");
  await expandSection("User Prompt Activity");
  await expandSection("Security Alerts");
  await scrollToText("User Prompt Activity");
  await shot("audit-alerts");
  await expandSection("Audit Trail");
  await scrollToText("Audit Trail");
  await shot("audit-trail");

  fs.writeFileSync(path.join(OUT, "measured-rects.json"), JSON.stringify(measured, null, 2));

  await browser.close();
  capture.complete();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
