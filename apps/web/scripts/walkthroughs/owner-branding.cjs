/* Platform branding, applied for real and checked where it shows.
 *
 * Inputs: CAPTURE_BRAND_LOGO, a synthetic wide wordmark PNG for the Logo card,
 * and CAPTURE_BRAND_ICON, a synthetic square PNG for the Icon card (neither may
 * contain a real company mark). Run from a freshly reset instance.
 *
 * owner-branding clears the optional platform name (the wordmark already
 * spells it), records the domain, uploads the wordmark in the Logo card, pastes
 * the address of a wide image into Browser icon URL to show the real
 * too-wide warning, uploads the square icon instead, sets the theme colors,
 * records the real validation message for a one-sided gradient, applies the
 * branding, then opens the sidebar, the signed-out sign-in page, and the
 * installable-app manifest and icon to show each place it appears, and finally
 * resets to the defaults. The wide image is the project's own public default
 * wordmark on GitHub, loaded by the browser only to measure its shape; it is
 * never applied.
 */
const fs = require("node:fs");

const BRAND = {
  domain: "assistant.example.com",
  accent: "#2f5d8a",
  start: "#12263f",
  end: "#0a1726",
  text: "#14202c",
};
// A public, wide image (the project's default wordmark, 768 x 178) for the
// hosted-address path of the Icon card.
const WIDE_IMAGE_ORIGIN = "https://raw.githubusercontent.com";
const WIDE_IMAGE_URL = `${WIDE_IMAGE_ORIGIN}/Aperture-Chat/Aperture-Chat/main/apps/web/public/brand/aperture-chat-logo.png`;

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

/* Wait until every preview image has loaded, so the tiles show the artwork. */
async function previewSettled(page) {
  await page.waitForFunction(() => [...document.querySelectorAll(".branding-preview img, .branding-image-stage img")].every((img) => img.complete && img.naturalWidth > 0), null, { timeout: 20000 });
  await page.waitForTimeout(500);
}

const branding = {
  role: "owner",
  description: "Upload a logo and an icon, see the too-wide warning, set theme colors, apply, check every surface, and reset.",
  externalOrigins: () => [WIDE_IMAGE_ORIGIN],
  frames: [
    "owner/br-panel", "owner/br-name-domain", "owner/br-logo-card", "owner/br-icon-wide", "owner/br-icon-card",
    "owner/br-gradient-error", "owner/br-colors", "owner/br-applied", "owner/br-signin", "owner/br-app-icon", "owner/br-reset",
  ],
  async run(kit) {
    const { shot } = kit;
    const logo = kit.env("CAPTURE_BRAND_LOGO");
    const icon = kit.env("CAPTURE_BRAND_ICON");
    for (const file of [logo, icon]) if (!fs.existsSync(file)) throw new Error(`${file} does not exist.`);
    const page = await kit.app("owner", "/platform/org-settings");
    let panel = await brandingPanel(page);
    if ((await panel.getByLabel("Platform name", { exact: true }).inputValue()) !== "Aperture Chat") throw new Error("Start from the default branding.");
    await scrollTo(page, panel, "start");
    await previewSettled(page);
    await shot("br-panel");

    // The wordmark about to be uploaded already spells the company name, so
    // the optional platform name is cleared; the domain is recorded for
    // administrators and the API.
    await panel.getByLabel("Platform name", { exact: true }).fill("");
    await panel.getByLabel("Platform domain", { exact: true }).fill(BRAND.domain);
    await scrollTo(page, panel, "start");
    await previewSettled(page);
    await shot("br-name-domain");

    // Logo card: the wide wordmark. The preview tiles switch to it at once.
    await panel.getByLabel("Upload logo", { exact: true }).setInputFiles(logo);
    await panel.getByText(/is ready\. Apply branding to update the platform logo\./).waitFor();
    await scrollTo(page, panel, "start");
    await previewSettled(page);
    await shot("br-logo-card");

    // Icon card, hosted-address path: a wide image is measured and refused for compact spaces.
    const iconCard = panel.locator(".branding-image-field[aria-label='Icon']");
    await panel.getByLabel("Browser icon URL", { exact: true }).fill(WIDE_IMAGE_URL);
    await iconCard.getByText("Too wide for an icon, so compact spaces show the Aperture Chat icon instead.").waitFor({ timeout: 30000 });
    await scrollTo(page, iconCard, "center");
    await previewSettled(page);
    await shot("br-icon-wide");

    // Upload the square icon instead; the browser tab and compact tiles use it.
    await panel.getByLabel("Upload icon", { exact: true }).setInputFiles(icon);
    await panel.getByText(/is ready\. Apply branding to update the browser tab and compact icon\./).waitFor();
    if (await iconCard.locator(".branding-image-warning").count()) throw new Error("The square icon still shows the too-wide warning.");
    await scrollTo(page, panel, "start");
    await previewSettled(page);
    await shot("br-icon-card");

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
    await panel.getByText("Image-only branding saved through the platform API and will persist across reloads.").waitFor();
    await page.reload();
    await page.getByRole("navigation", { name: "Primary" }).waitFor();
    panel = await brandingPanel(page);
    const saved = await kit.api("owner", "GET", "/api/auth/options").catch(() => null);
    const tenant = saved?.tenant_branding ?? {};
    if (!tenant.logo_url?.startsWith("data:image/png") || !tenant.icon_url?.startsWith("data:image/png") || tenant.custom_domain !== BRAND.domain) {
      throw new Error("Branding did not persist across reload.");
    }
    await scrollTo(page, panel, "start");
    await page.evaluate(() => window.scrollBy(0, -120));
    await previewSettled(page);
    await shot("br-applied");

    // Signed out: the sign-in page carries the logo.
    const signin = kit.use(await kit.anonymous());
    await signin.getByRole("heading", { name: "Sign in to continue" }).waitFor();
    await signin.locator(".auth-brand img").first().waitFor();
    await signin.waitForFunction(() => [...document.querySelectorAll(".auth-brand img")].every((img) => img.complete && img.naturalWidth > 0));
    await signin.waitForTimeout(800);
    await shot("br-signin");

    // The installable app reads its name and icon from the manifest; with the
    // name left blank it keeps Aperture Chat, and the icon endpoint now serves
    // the uploaded Icon.
    const manifestResponse = await fetch(`${kit.API}/api/pwa/manifest.webmanifest`, { headers: { host: new URL(kit.APP).host } });
    const manifestBody = await manifestResponse.json();
    if (manifestBody.name !== "Aperture Chat") throw new Error(`Manifest name is ${manifestBody.name}`);
    const appIcon = kit.use(await kit.anonymous("/api/pwa/icon-512.png"));
    await appIcon.locator("img").waitFor();
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
