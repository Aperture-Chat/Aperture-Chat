/* Platform branding, applied for real and checked where it shows.
 *
 * Input: CAPTURE_BRAND_LOGO, a synthetic square PNG to upload (it must contain
 * no real company mark). Run from a freshly reset instance.
 *
 * owner-branding fills in the name and domain, uploads the PNG, sets the theme
 * colors, records the real validation message for a one-sided gradient,
 * applies the branding, then opens the sidebar, the signed-out sign-in page,
 * and the installable-app manifest to show each place it appears, and finally
 * resets to the defaults.
 */
const fs = require("node:fs");

const BRAND = {
  name: "Example Corp Assistant",
  domain: "assistant.example.com",
  accent: "#2f5d8a",
  start: "#12263f",
  end: "#0a1726",
  text: "#14202c",
};

async function scrollTo(page, locator, block = "center") {
  await locator.evaluate((element, where) => element.scrollIntoView({ block: where }), block);
  await page.waitForTimeout(350);
}

async function brandingPanel(page) {
  const panel = page.locator(".platform-branding-panel");
  await panel.waitFor();
  const toggle = panel.locator(".panel-collapse-button").first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await panel.locator(".branding-preview").waitFor();
  await page.waitForTimeout(400);
  return panel;
}

async function color(panel, label, value) {
  await panel.getByLabel(label, { exact: true }).fill(value);
}

const branding = {
  role: "owner",
  description: "Rename the platform, upload a logo, set theme colors, apply, check every surface, and reset.",
  frames: [
    "owner/br-panel", "owner/br-name-logo", "owner/br-colors", "owner/br-gradient-error",
    "owner/br-applied", "owner/br-signin", "owner/br-app-icon", "owner/br-reset",
  ],
  async run(kit) {
    const { shot } = kit;
    const logo = kit.env("CAPTURE_BRAND_LOGO");
    if (!fs.existsSync(logo)) throw new Error("CAPTURE_BRAND_LOGO does not exist.");
    const page = await kit.app("owner", "/platform/org-settings");
    let panel = await brandingPanel(page);
    await scrollTo(page, panel, "start");
    await shot("br-panel");

    // Name, domain, and an uploaded PNG for the logo and browser icon.
    await panel.getByLabel("Platform name", { exact: true }).fill(BRAND.name);
    await panel.getByLabel("Platform domain", { exact: true }).fill(BRAND.domain);
    await panel.locator(".branding-file-button input[type='file']").setInputFiles(logo);
    await panel.getByText(/is ready\. Apply branding to update the platform shell and favicon\./).waitFor();
    await page.waitForTimeout(500);
    await scrollTo(page, panel, "start");
    await shot("br-name-logo");

    // Theme colors: accent, sidebar gradient, and interface text.
    await color(panel, "Accent color", BRAND.accent);
    await color(panel, "Sidebar gradient start", BRAND.start);
    await color(panel, "Interface text color", BRAND.text);
    // A gradient needs both stops; Apply refuses a one-sided gradient.
    await panel.getByRole("button", { name: "Apply branding" }).click();
    await panel.getByText("Set both gradient colors (or clear both) so the sidebar gradient has a start and an end.").waitFor();
    await scrollTo(page, panel.locator(".branding-theme-fields"), "start");
    await shot("br-gradient-error");
    await color(panel, "Sidebar gradient end", BRAND.end);
    await panel.getByRole("button", { name: "Dismiss branding status" }).click();
    await page.waitForTimeout(400);
    await scrollTo(page, panel.locator(".branding-theme-fields"), "start");
    await shot("br-colors");

    // Apply: saved for everyone, and the console restyles at once.
    await panel.getByRole("button", { name: "Apply branding" }).click();
    await panel.getByText(`${BRAND.name} branding saved through the platform API and will persist across reloads.`).waitFor();
    await page.reload();
    await page.getByRole("navigation", { name: "Primary" }).waitFor();
    panel = await brandingPanel(page);
    if ((await panel.getByLabel("Platform name", { exact: true }).inputValue()) !== BRAND.name) throw new Error("Branding did not persist across reload.");
    await scrollTo(page, panel, "start");
    await page.evaluate(() => window.scrollBy(0, -120));
    await page.waitForTimeout(400);
    await shot("br-applied");

    // Signed out: the sign-in page carries the brand.
    const signin = kit.use(await kit.anonymous());
    await signin.getByRole("heading", { name: "Sign in to continue" }).waitFor();
    await signin.getByText(BRAND.name).first().waitFor();
    await signin.waitForTimeout(800);
    await shot("br-signin");

    // The installable app reads its name and icon from the manifest; the icon
    // endpoint now serves the uploaded logo.
    const manifestResponse = await fetch(`${kit.API}/api/pwa/manifest.webmanifest`, { headers: { host: new URL(kit.APP).host } });
    const manifestBody = await manifestResponse.json();
    if (manifestBody.name !== BRAND.name) throw new Error(`Manifest name is ${manifestBody.name}`);
    const icon = kit.use(await kit.anonymous("/api/pwa/icon-512.png"));
    await icon.locator("img").waitFor();
    await shot("br-app-icon");

    // Reset defaults restores the Aperture Chat look immediately.
    kit.use(page);
    await panel.getByRole("button", { name: "Reset defaults" }).click();
    await panel.getByText("Default Aperture Chat branding saved through the platform API and will persist across reloads.").waitFor();
    await page.waitForTimeout(800);
    await scrollTo(page, panel.locator(".branding-actions"), "center");
    await shot("br-reset");
  },
};

module.exports = { "owner-branding": branding };
