/* Captures Admin Console screens for the admin training videos.
 *
 * Run against an isolated local stack seeded with synthetic tenant data.
 * Analytics/audit frames use the same synthetic stack in the separate script.
 *
 *   CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=I_HAVE_REVIEWED_SYNTHETIC_DATA \
 *   CAPTURE_APP_URL=http://localhost:5173 CAPTURE_USER_ID=user-admin \
 *     node scripts/capture-admin-frames.cjs
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const PUBLIC_OUT = path.join(__dirname, "..", "public", "training", "admin");
const APP = process.env.CAPTURE_APP_URL || "http://localhost:5173";
const USER = process.env.CAPTURE_USER_ID || "user-admin";
const CAPTURE_AUTH = require("./training-capture-run.cjs").captureCredentials();
const TOKEN = CAPTURE_AUTH.token;
const POLICIES_ONLY = process.env.CAPTURE_POLICIES_ONLY === "1";

(async () => {
  const { createCaptureRun } = require("./training-capture-run.cjs");
  const capture = createCaptureRun({
    scriptPath: __filename,
    publicDirectory: PUBLIC_OUT,
    appUrl: APP,
    confirmation: process.env.CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION || "",
    policiesOnly: POLICIES_ONLY,
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
  await page.getByRole("navigation", { name: "Primary" }).waitFor({ timeout: 20000 });
  await hideTooltips();

  // The consoles live in the account drawer's Management disclosure.
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.locator("summary.account-collapsible-summary").first().click();
  await page.waitForTimeout(400);
  await page.locator("button:visible", { hasText: "Admin console" }).first().click();
  await page.waitForTimeout(1000);
  await hideTooltips();

  const { measureFrameFocus, readFocusRegions } = require("./training-focus-measurement.cjs");
  const measured = {};
  const shot = async (name, { focusFrame = name, onlyKeys } = {}) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${name}.png`, scale: name.startsWith("policies-") ? "css" : "device" });
    const frameMeasurements = await measureFrameFocus(page, "admin", focusFrame, { onlyKeys });
    for (const value of Object.values(frameMeasurements)) value.frame = `training/admin/${name}.png`;
    Object.assign(measured, frameMeasurements);
    // Keep completed-frame measurements even if a later capture fails.
    fs.writeFileSync(path.join(OUT, "measured-rects.json"), JSON.stringify(measured, null, 2));
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
      if (!panel) throw new Error(`Missing panel: ${panelTitle}`);
      const isCollapsed = panel.classList.contains("is-panel-collapsed");
      if (isCollapsed === shouldExpand) panel.querySelector(".panel-header")?.click();
    }, { panelTitle: title, shouldExpand: expanded });
    await page.waitForTimeout(500);
  };
  const capturePolicies = async () => {
    // Capture the default collapsed overview and each expandable governance
    // surface independently so walkthrough focus regions stay aligned.
    await tab("Policies");
    await shot("policies-collapsed");
    await setPanelExpanded("Policy Controls", true);
    await page.locator(".tenant-policy-panel").evaluate((element) => element.scrollIntoView({ block: "start" }));
    await shot("policies-controls");
    await setPanelExpanded("Policy Controls", false);
    await setPanelExpanded("Personalization Memory", true);
    await shot("policies-memory");
    await setPanelExpanded("Personalization Memory", false);
    await setPanelExpanded("Memory by User", true);
    await shot("policies-counts");
    await setPanelExpanded("Memory by User", false);
  };

  if (POLICIES_ONLY) {
    await capturePolicies();
    fs.writeFileSync(path.join(OUT, "measured-rects.json"), JSON.stringify(measured, null, 2));
    await browser.close();
    capture.complete();
    return;
  }

  await tab("Users");
  await shot("users");
  // The Actions column needs a dedicated view when the real table overflows
  // a laptop-sized viewport. Horizontal scrolling changes only UI position.
  await page.locator(".user-table-scroll").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await shot("users-actions", {
    focusFrame: path.basename(readFocusRegions("admin").usersActions.frame, ".png"),
    onlyKeys: ["usersActions"],
  });

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
  await shot("model-access");

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
  const ruleForm = page.locator(".alert-rule-form").first();
  await ruleForm.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot("alerts-rule-form");

  // Retention captures inspect synthetic chats and confirmation UI only.
  await tab("Policies");
  await setPanelExpanded("Data Retention", true);
  await page.getByText("Tag chats that use MCP connections", { exact: true }).scrollIntoViewIfNeeded();
  await shot("retention-policy");
  await tab("Audit");
  await setPanelExpanded("User Prompt Activity", true);
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

  fs.writeFileSync(path.join(OUT, "measured-rects.json"), JSON.stringify(measured, null, 2));

  await browser.close();
  capture.complete();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
