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

const OUT = path.join(__dirname, "..", "public", "training", "admin");
const APP = process.env.CAPTURE_APP_URL || "http://localhost:5173";
const USER = process.env.CAPTURE_USER_ID || "user-admin";
const TOKEN = process.env.CAPTURE_SESSION_TOKEN || "";
const CONFIRMATION = process.env.CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION || "";

(async () => {
  if (CONFIRMATION !== "I_HAVE_REVIEWED_SYNTHETIC_DATA") {
    throw new Error(
      "Refusing to overwrite public training assets without synthetic-data confirmation.",
    );
  }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1185, height: 855 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(
    ({ user, token }) => {
      localStorage.setItem("aperture-session-user-id", user);
      if (token) localStorage.setItem("aperture-session-token", token);
    },
    { user: USER, token: TOKEN },
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

  const measured = {};
  const shot = async (name, rectSpecs = {}) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    for (const [key, selector] of Object.entries(rectSpecs)) {
      const box = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }, selector);
      measured[key] = box ? { frame: `training/admin/${name}.png`, rect: box } : `MISSING ${selector}`;
    }
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
  await shot("analytics", {
    anFilters: "[aria-label='Runtime events filter']",
    anRuntime: ".chat-feedback-panel .feedback-summary-grid",
  });
  await scrollToText("Model Activity");
  await shot("analytics-activity", {
    anUsage: ".model-activity-chart-grid",
  });
  await scrollToText("Workspace Usage Budget");
  await shot("analytics-usage-budget", {
    anBudget: ".tenant-budget-panel",
  });

  await page.getByRole("tab", { name: "Audit" }).click();
  await page.waitForTimeout(1500);
  await shot("audit", {
    auCards: ".audit-summary-grid",
  });
  await expandSection("User Prompt Activity");
  await expandSection("Security Alerts");
  await scrollToText("User Prompt Activity");
  await shot("audit-alerts", {
    auPromptSelect: "[aria-label='Prompt activity filter']",
  });
  await expandSection("Audit Trail");
  await scrollToText("Audit Trail");
  await shot("audit-trail", {
    auTrailFilters: ".audit-filter-toolbar",
  });

  fs.writeFileSync(path.join(OUT, "measured-rects.json"), JSON.stringify(measured, null, 2));

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
