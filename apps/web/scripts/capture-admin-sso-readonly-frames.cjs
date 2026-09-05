/* Capture the actual policy-restricted SSO panel from an existing synthetic
 * tenant-admin session. This never changes delegation or opens a provider.
 * Keep the editable form capture separate so each narration shows its state.
 * Output and bounds stay in ignored review storage until visual approval.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { captureCredentials } = require("./training-capture-run.cjs");
const { openReadOnlyContext, stagedCapture, screenshotWithBounds } = require("./capture-user-support-frames.cjs");

(async () => {
  const auth = captureCredentials();
  const capture = stagedCapture(__filename, "admin");
  const metadata = { role: "admin", capturedAt: new Date().toISOString(), readOnly: true, frames: {}, pending: [] };
  const browser = await chromium.launch();
  try {
    const { page, attemptedWrites } = await openReadOnlyContext(browser, auth, "TENANT_ADMIN");
    await page.getByRole("button", { name: /^Account:/ }).click();
    const account = page.getByRole("dialog", { name: "Account", exact: true });
    await account.locator("summary.account-collapsible-summary").first().click();
    await account.getByRole("button", { name: /Admin console/i }).click();
    await page.getByRole("tab", { name: "SSO", exact: true }).click();
    const panel = page.locator(".panel").filter({
      has: page.getByRole("heading", { name: "SSO and Provisioning", exact: true }),
    });
    await panel.getByText("Organization policy makes SSO configuration read-only in this console.", { exact: true }).waitFor();
    if (await panel.locator(".sso-create-form").count()) throw new Error("Expected an actual restricted SSO panel.");
    const shot = (name, regions) => screenshotWithBounds(page, capture.outputDirectory, name, regions, metadata);
    await shot("sso-readonly", { ssoPanel: panel });
    fs.writeFileSync(path.join(capture.outputDirectory, "support-capture-metadata.json"), JSON.stringify(metadata, null, 2));
    if (attemptedWrites.length) throw new Error(`Capture attempted ${attemptedWrites.length} mutation requests.`);
    await browser.close();
    capture.complete();
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error.message); process.exit(1); });
