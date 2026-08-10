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

const OUT = path.join(__dirname, "..", "public", "training", "owner");
const APP = process.env.CAPTURE_APP_URL || "http://localhost:5173";
const USER = process.env.CAPTURE_USER_ID || "user-owner";
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

  // The consoles live in the account drawer's Management disclosure.
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.locator("summary.account-collapsible-summary").first().click();
  await page.waitForTimeout(400);
  await page.locator("button:visible", { hasText: "Platform owner console" }).first().click();
  await page.waitForTimeout(1200);
  await hideTooltips();

  const measured = {};
  const shot = async (name, rectSpecs = {}) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    /* Record viewport-space boxes for FOCUS_REGIONS (logical px — the
     * screenshots are dsf2 but rects are declared in the 1185x855 space). */
    for (const [key, selector] of Object.entries(rectSpecs)) {
      const box = await page.evaluate((sel) => {
        /* "union:" measures the bounding box across every match; "nth:<n>:"
         * measures the n-th match (0-based). */
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
      measured[key] = box ? { frame: `training/owner/${name}.png`, rect: box } : `MISSING ${selector}`;
    }
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
  await expandSection("Role Boundary");
  await scrollToText("Role Boundary");
  await shot("roles", {
    rolesDisclosure: ".owner-control-panel .panel-header",
    rolesCreateForm: ".owner-management-form",
    rolesSetPassword: ".owner-user-list .owner-user-row button[aria-label^='Set a password']",
    rolesUserRows: ".owner-user-list",
  });
  await expandSection("Single Sign-On");
  await scrollToText("Single Sign-On");
  await shot("sso", {
    ssoIntro: ".sso-requirements-panel .panel-header",
    ssoProtocol: ".sso-readiness-grid label:nth-of-type(2)",
    ssoFields: ".sso-readiness-grid",
    ssoRedirect: ".sso-redirect-uri",
  });
  const testButton = page.getByRole("button", { name: /Test connection|Test SSO/i }).first();
  if (await testButton.count()) {
    await testButton.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(500);
    await shot("sso-actions", {
      ssoToggles: "union:.sso-requirements-panel .permission-row.owner-toggle-row",
      ssoEnforce: "nth:1:.sso-requirements-panel .permission-row.owner-toggle-row",
      ssoSaveTest: ".sso-action-row",
    });
  }
  await expandSection("Platform Branding");
  await scrollToText("Platform Branding");
  await shot("branding", {
    brandPreview: ".branding-preview",
    brandFields: ".platform-branding-panel .owner-form-grid",
    brandThemeColors: ".branding-theme-fields",
    brandActions: ".branding-actions",
  });
  await expandSection("Policy Controls");
  await scrollToText("Policy Controls");
  await shot("policies-current", {
    policyFloor: ".policy-toggle-stack .permission-row",
  });
  await page.evaluate(() => {
    document.querySelector(".policy-toggle-stack")?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(500);
  await shot("policies-toggles-current", {
    policyToggles: ".policy-toggle-stack",
  });
  await shot("policies-callout-current", {
    policyCallout: ".tenant-policy-panel .policy-callout",
  });
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll(".panel-header h2")].find(
      (candidate) => candidate.textContent.trim() === "Policy Controls",
    );
    heading?.closest(".panel")?.querySelector(".panel-header")?.click();
  });
  await page.waitForTimeout(500);
  await shot("policies-current-collapsed", {
    policyCollapsed: "union:[role='tabpanel'] .panel",
  });
  await expandSection("Workspace Usage Budget");
  await scrollToText("Workspace Usage Budget");
  await shot("policies-budget-current", {
    budgetControls: ".budget-control-grid",
  });

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
  await shot("analytics", {
    analyticsFilters: "[aria-label='Runtime events filter']",
    runtimeScorecards: ".chat-feedback-panel .feedback-summary-grid",
    runtimeRows: "[aria-label='Runtime clock events']",
  });
  await scrollToText("Model Activity");
  await shot("analytics-activity", {
    activityCharts: ".model-activity-panel .model-activity-chart-grid",
  });
  await scrollToText("User Usage");
  await shot("analytics-usage", {
    usageScorecards: ".usage-summary-grid",
    usageCharts: "nth:1:.model-activity-chart-grid",
  });
  // The ranked per-user list sits below the charts; give it its own frame.
  await page.evaluate(() => {
    document.querySelector("[aria-label='Usage by user']")?.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(600);
  await shot("analytics-usage-users", {
    usageByUser: "[aria-label='Usage by user']",
  });

  await tab("Audit");
  await page.waitForTimeout(1200);
  await shot("audit", {
    auditCriticalTile: ".audit-summary-card",
    auditTileGrid: ".audit-summary-grid",
  });
  await expandSection("Security Alerts");
  await scrollToText("Security Alerts");
  await shot("audit-alerts", {
    auditSecurityAlerts: "[aria-label='Security alert filter']",
  });
  await expandSection("Audit Trail");
  await scrollToText("Audit Trail");
  await shot("audit-trail", {
    trailFilters: ".audit-filter-toolbar",
    trailRows: ".audit-trail-list",
  });

  await tab("Alerts");
  await page.waitForTimeout(1000);
  await shot("alerts");

  fs.writeFileSync(path.join(OUT, "measured-rects.json"), JSON.stringify(measured, null, 2));
  console.log("wrote measured-rects.json");

  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

/* Frames land in apps/web/public/training/owner/ matching FOCUS_REGIONS in
 * src/components/trainingDecks/owner.tsx. */
