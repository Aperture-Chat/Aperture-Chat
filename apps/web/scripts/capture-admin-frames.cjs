/* Captures Admin Console screens for the admin training videos.
 *
 * Run against a local dev stack seeded with the demo tenant (Alex Morgan et
 * al.) — the live deployment's admin scope only contains the QA admin, so
 * management tabs look empty there. Analytics/audit frames with real usage
 * are captured separately from the live site (see the deck source notes).
 *
 *   CAPTURE_APP_URL=http://localhost:5173 CAPTURE_USER_ID=user-admin \
 *     node scripts/capture-admin-frames.js
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "public", "training", "admin");
const APP = process.env.CAPTURE_APP_URL || "http://localhost:5173";
const USER = process.env.CAPTURE_USER_ID || "user-admin";
const TOKEN = process.env.CAPTURE_SESSION_TOKEN || "";
const POLICIES_ONLY = process.env.CAPTURE_POLICIES_ONLY === "1";

(async () => {
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
  await page.getByRole("navigation", { name: "Primary" }).waitFor({ timeout: 20000 });
  await hideTooltips();

  // The consoles live in the account drawer's Management disclosure.
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.locator("summary.account-collapsible-summary").first().click();
  await page.waitForTimeout(400);
  await page.locator("button:visible", { hasText: "Admin console" }).first().click();
  await page.waitForTimeout(1000);
  await hideTooltips();

  const measured = {};
  const shot = async (name, rectSpecs = {}) => {
    await page.waitForTimeout(550);
    // Policy frames feed a native 1185 x 855 Remotion composition. Saving
    // those at CSS scale keeps measured borders one-to-one with the video.
    await page.screenshot({
      path: `${OUT}/${name}.png`,
      scale: name.startsWith("policies-") ? "css" : "device",
    });
    for (const [key, selector] of Object.entries(rectSpecs)) {
      const box = await page.evaluate((sel) => {
        const union = sel.startsWith("union:");
        const nth = sel.match(/^nth:(\d+):/);
        const query = union ? sel.slice(6) : nth ? sel.slice(nth[0].length) : sel;
        const matches = [...document.querySelectorAll(query)];
        const candidates = union ? matches : nth ? [matches[Number(nth[1])]].filter(Boolean) : matches.slice(0, 1);
        const els = candidates.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!els.length) return null;
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (const el of els) {
          const r = el.getBoundingClientRect();
          left = Math.min(left, r.left);
          top = Math.min(top, r.top);
          right = Math.max(right, r.right);
          bottom = Math.max(bottom, r.bottom);
        }
        return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
      }, selector);
      measured[key] = box ? { frame: `training/admin/${name}.png`, rect: box } : `MISSING ${selector}`;
    }
    console.log("captured", name);
  };
  const tab = async (label) => {
    await page.getByRole("tab", { name: label }).click();
    await page.waitForTimeout(700);
  };
  const setPanelExpanded = async (title, expanded) => {
    await page.evaluate(({ panelTitle, shouldExpand }) => {
      const heading = [...document.querySelectorAll(".panel-header h2")].find(
        (candidate) => candidate.textContent.trim() === panelTitle,
      );
      const panel = heading?.closest(".panel");
      if (!panel) return;
      const isCollapsed = panel.classList.contains("is-panel-collapsed");
      if (isCollapsed === shouldExpand) panel.querySelector(".panel-header")?.click();
    }, { panelTitle: title, shouldExpand: expanded });
    await page.waitForTimeout(500);
  };
  const capturePolicies = async () => {
    // Capture the default collapsed overview and each expandable governance
    // surface independently so walkthrough focus regions stay aligned.
    await tab("Policies");
    await shot("policies-collapsed", {
      policyCollapsed: "union:[role='tabpanel'] .panel",
    });
    await setPanelExpanded("Policy Controls", true);
    await shot("policies-controls", {
      policyServiceAvailability:
        "union:.tenant-policy-panel > .policy-callout:nth-child(2), .tenant-policy-panel > .policy-toggle-stack:nth-child(3)",
      policyDefaults:
        "union:.tenant-policy-panel > .policy-callout:nth-child(4), .tenant-policy-panel > .policy-toggle-stack:nth-child(5)",
    });
    await setPanelExpanded("Policy Controls", false);
    await setPanelExpanded("Personalization Memory", true);
    await shot("policies-memory", {
      policyMemory: "nth:1:[role='tabpanel'] .panel",
    });
    await setPanelExpanded("Personalization Memory", false);
    await setPanelExpanded("Memory by User", true);
    await shot("policies-counts", {
      policyCounts: "nth:2:[role='tabpanel'] .panel",
    });
    await setPanelExpanded("Memory by User", false);
  };

  if (POLICIES_ONLY) {
    await capturePolicies();
    fs.writeFileSync(path.join(OUT, "measured-rects.json"), JSON.stringify(measured, null, 2));
    await browser.close();
    return;
  }

  await tab("Users");
  await shot("users");

  // Groups: open the Corporate editor (it carries the agent-authoring grant).
  await tab("Groups");
  await page.getByText("Corporate", { exact: true }).first().click();
  await page.waitForTimeout(600);
  await shot("groups");
  await page.getByRole("tab", { name: "Permissions" }).click();
  await page.waitForTimeout(500);
  const grid = page.locator(".group-permission-grid").first();
  await grid.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot("groups-permissions");

  await tab("Model Access");
  await shot("model-access", {
    maStatusFilter: ".status-filter",
    maColumns: ".model-access-table thead tr, .model-access-header-row",
  });

  await tab("Connections");
  await shot("connections");
  const actionsPanel = page.getByText("Chat output actions", { exact: true }).first();
  await actionsPanel.evaluate((el) => el.closest("section, .panel, div")?.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(500);
  await shot("response-actions");

  // SSO: open the add form so the field layout is visible.
  await tab("SSO");
  const addSso = page.getByRole("button", { name: /Add SSO configuration/ }).first();
  if (await addSso.isVisible().catch(() => false)) {
    await addSso.click();
    await page.waitForTimeout(600);
  }
  await shot("sso-form");

  await capturePolicies();

  // Alerts: rules list first, then the form prefilled from the template.
  await tab("Alerts");
  await shot("alerts");
  await page.getByRole("button", { name: "Suspicious-activity template" }).click();
  await page.waitForTimeout(600);
  const ruleForm = page.locator("form").filter({ hasText: "Rule name" }).first();
  await ruleForm.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
  await shot("alerts-rule-form");

  fs.writeFileSync(path.join(OUT, "measured-rects.json"), JSON.stringify(measured, null, 2));

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
