/* Capture an already validated synthetic provider without opening its keys or
 * running another sync. The real Connected state must exist before this run.
 * Output and bounds stay in ignored review storage until visual approval.
 *
 * CAPTURE_PROVIDER_NAME selects an existing provider by its exact visible name.
 * Use the same session, local URL, and synthetic confirmation variables as the
 * other training capture scripts.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { captureCredentials } = require("./training-capture-run.cjs");
const { openReadOnlyContext, stagedCapture, screenshotWithBounds } = require("./capture-user-support-frames.cjs");

(async () => {
  const auth = captureCredentials();
  const capture = stagedCapture(__filename, "owner");
  const metadata = { role: "owner", capturedAt: new Date().toISOString(), readOnly: true, frames: {}, pending: [] };
  const browser = await chromium.launch();
  try {
    const { page, attemptedWrites } = await openReadOnlyContext(browser, auth, "PLATFORM_OWNER");
    await page.getByRole("button", { name: /^Account:/ }).click();
    const account = page.getByRole("dialog", { name: "Account", exact: true });
    await account.locator("summary.account-collapsible-summary").first().click();
    await account.getByRole("button", { name: /Platform owner console/i }).click();
    await page.getByRole("tab", { name: "Providers", exact: true }).click();
    const providerName = process.env.CAPTURE_PROVIDER_NAME || "OpenRouter";
    const card = page.locator(".provider-card").filter({
      has: page.getByRole("heading", { name: providerName, exact: true }),
    });
    if (await card.count() !== 1) throw new Error("The requested provider card is missing or ambiguous.");
    await card.getByText("Connected", { exact: true }).waitFor();
    // A collapsed summary shows status, model counts, and actions without
    // exposing credential material or changing the connection configuration.
    if (await card.locator(".provider-keys, .provider-connection-editor").count()) {
      throw new Error("Provider editor or key vault is open; capture only the collapsed summary.");
    }
    await card.scrollIntoViewIfNeeded();
    const shot = (name, regions) => screenshotWithBounds(page, capture.outputDirectory, name, regions, metadata);
    await shot("first-provider-validated", { firstProviderValidated: card });
    fs.writeFileSync(path.join(capture.outputDirectory, "support-capture-metadata.json"), JSON.stringify(metadata, null, 2));
    if (attemptedWrites.length) throw new Error(`Capture attempted ${attemptedWrites.length} mutation requests.`);
    await browser.close();
    capture.complete();
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error.message); process.exit(1); });
