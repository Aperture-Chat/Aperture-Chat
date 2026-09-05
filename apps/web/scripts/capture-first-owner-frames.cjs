/* Capture actual first-owner setup against an EMPTY, isolated loopback API.
 * This script creates an owner and acknowledges the welcome; it never seeds or
 * replaces a database. Start the isolated API separately with demo/owner seeds
 * disabled. Re-run with CAPTURE_SETUP_MODE=relogin after restarting that API
 * to verify persisted credentials, acknowledgment, and session revocation.
 *
 * Required environment:
 * CAPTURE_WEB_ORIGIN, CAPTURE_API_ORIGIN: loopback HTTP origins
 * CAPTURE_MUTATION_ACK=isolated-synthetic
 * CAPTURE_OWNER_FILE: private JSON {email, displayName, password}; reserved
 *   example.test or local.invalid email only. Updated with private test state.
 * CAPTURE_OUTPUT_DIR: ignored/private directory for PNGs and safe evidence.
 * Optional CAPTURE_SETUP_MODE=create (default) or relogin.
 *
 * Frame contract: first-owner-setup, first-owner-welcome,
 * first-owner-setup-blocked, first-owner-providers.
 * No passwords, tokens, or provider credentials are printed or photographed.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

function required(name) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env[name];
}
function loopbackOrigin(name) {
  const url = new URL(required(name));
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be a loopback HTTP origin`);
  }
  return url.origin;
}

let browser;
let stage = "configuration";
async function main() {
  const webOrigin = loopbackOrigin("CAPTURE_WEB_ORIGIN");
  const apiOrigin = loopbackOrigin("CAPTURE_API_ORIGIN");
  if (required("CAPTURE_MUTATION_ACK") !== "isolated-synthetic") throw new Error("Synthetic mutation acknowledgment required");
  const ownerFile = path.resolve(required("CAPTURE_OWNER_FILE"));
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  if (!/^[^@\s]+@(example\.test|local\.invalid)$/.test(owner.email ?? "")
    || typeof owner.displayName !== "string" || !owner.displayName.trim()
    || typeof owner.password !== "string" || owner.password.length < 12) throw new Error("Invalid synthetic owner fixture");
  if ((fs.statSync(ownerFile).mode & 0o077) !== 0) throw new Error("Owner fixture must be private (mode 600)");
  const outputDir = path.resolve(required("CAPTURE_OUTPUT_DIR"));
  fs.mkdirSync(outputDir, { recursive: true });
  const mode = process.env.CAPTURE_SETUP_MODE ?? "create";
  if (!["create", "relogin"].includes(mode)) throw new Error("Unsupported capture mode");
  const checks = owner.checks ?? {};
  const targets = {};
  const save = () => {
    fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, checks }), { mode: 0o600 });
    fs.writeFileSync(path.join(outputDir, "first-owner-evidence.json"), JSON.stringify({ stage, checks }, null, 2));
    if (Object.keys(targets).length) fs.writeFileSync(path.join(outputDir, "first-owner-measured-targets.json"), JSON.stringify(targets, null, 2));
  };
  function check(value, key) {
    if (!value) throw new Error(key);
    checks[key] = true;
    save();
  }
  browser = await chromium.launch();
  async function context() {
    const current = await browser.newContext({ viewport: { width: 1185, height: 855 }, deviceScaleFactor: 2, serviceWorkers: "block" });
    await current.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== webOrigin && url.origin !== apiOrigin) return route.abort("blockedbyclient");
      // Vite also serves source files under /src/lib/api; proxy API requests only.
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const response = await route.fetch({ url: apiOrigin + url.pathname + url.search, maxRedirects: 0 });
      await route.fulfill({ response });
    });
    return current;
  }
  async function responseFor(page, endpoint, action, expected) {
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint);
    await action();
    const response = await pending;
    check(response.status() === expected, `${endpoint.split("/").pop()}_returns_${expected}`);
    // Sign-out unmounts the authenticated page. Its keepalive request only
    // needs a successful status; reading its detached response can stall.
    if (endpoint === "/api/auth/logout") return {};
    return response.json();
  }
  async function shot(page, name, selectors) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(450);
    const measured = {};
    for (const [key, selector] of Object.entries(selectors)) {
      const rect = await page.locator(selector).first().boundingBox();
      if (!rect) throw new Error(`Missing capture target ${key}`);
      measured[key] = { selector, rect };
    }
    await page.screenshot({ path: path.join(outputDir, `${name}.png`) });
    targets[name] = { viewport: { width: 1185, height: 855 }, scale: 2, targets: measured, redactedSelectors: [], state: "Actual isolated synthetic setup; real API requests." };
    save();
  }
  const current = await context();
  const page = await current.newPage();
  page.setDefaultTimeout(20000);
  const options = await current.request.get(`${apiOrigin}/api/auth/options`);
  check(options.status() === 200, "isolated_api_ready");
  const bootstrapRequired = (await options.json()).bootstrap_required;
  await page.goto(webOrigin);
  if (mode === "create") {
    check(bootstrapRequired === true, "isolated_store_is_empty");
    stage = "first owner creation";
    await page.getByRole("heading", { name: "Create the first platform owner" }).waitFor();
    const staleContext = await context();
    const stale = await staleContext.newPage();
    await stale.goto(webOrigin);
    await stale.getByRole("heading", { name: "Create the first platform owner" }).waitFor();
    await page.getByLabel("Email", { exact: true }).fill(owner.email);
    await page.getByLabel("Display name", { exact: true }).fill(owner.displayName);
    await shot(page, "first-owner-setup", { form: ".auth-form", heading: ".auth-heading", submit: ".auth-submit-button" });
    await page.getByLabel("Create password", { exact: true }).fill(owner.password);
    await page.getByLabel("Confirm password", { exact: true }).fill(owner.password);
    const created = await responseFor(page, "/api/auth/bootstrap-owner", () => page.getByRole("button", { name: "Create platform owner", exact: true }).click(), 201);
    owner.userId = created.user.id;
    check(created.user.role === "PLATFORM_OWNER" && !created.user.first_run_guide_seen_at, "new_owner_has_unacknowledged_welcome");
    await page.locator(".first-run-welcome").waitFor();
    await shot(page, "first-owner-welcome", { welcome: ".first-run-welcome", steps: ".first-run-steps", actions: ".first-run-actions" });
    await stale.getByLabel("Email", { exact: true }).fill(owner.email);
    await stale.getByLabel("Display name", { exact: true }).fill(owner.displayName);
    await stale.getByLabel("Create password", { exact: true }).fill(owner.password);
    await stale.getByLabel("Confirm password", { exact: true }).fill(owner.password);
    await responseFor(stale, "/api/auth/bootstrap-owner", () => stale.getByRole("button", { name: "Create platform owner", exact: true }).click(), 409);
    await stale.getByRole("alert").filter({ hasText: "A platform owner already exists." }).waitFor();
    await stale.getByLabel("Create password", { exact: true }).fill("");
    await stale.getByLabel("Confirm password", { exact: true }).fill("");
    await shot(stale, "first-owner-setup-blocked", { error: ".auth-error", heading: ".auth-heading" });
    const ack = await responseFor(page, "/api/auth/first-run-guide/seen", () => page.getByRole("button", { name: "Set up models", exact: true }).click(), 200);
    check(Boolean(ack.first_run_guide_seen_at), "welcome_acknowledged_by_setup_action");
    await page.getByRole("heading", { name: "Connect your first model provider" }).waitFor();
    check(await page.getByRole("tab", { name: "Providers", exact: true }).getAttribute("aria-selected") === "true", "setup_action_opens_providers");
    await shot(page, "first-owner-providers", { console: ".console-header", providers: ".provider-connections-panel", readiness: ".provider-setup-empty" });
    await staleContext.close();
  } else {
    check(bootstrapRequired === false, "persisted_store_disables_bootstrap");
    stage = "persisted owner sign in";
    if (owner.revokedToken) {
      const previous = await current.request.get(`${apiOrigin}/api/auth/session`, { headers: { "x-aperture-session": owner.revokedToken } });
      check(previous.status() === 401, "previous_logout_remains_revoked");
    }
    await page.getByRole("heading", { name: "Sign in to continue" }).waitFor();
    await page.getByLabel("Email", { exact: true }).fill(owner.email);
    await page.getByLabel("Password", { exact: true }).fill(owner.password);
    const login = await responseFor(page, "/api/auth/login", () => page.getByRole("button", { name: "Sign in", exact: true }).click(), 200);
    check(login.user.id === owner.userId && login.user.role === "PLATFORM_OWNER", "persisted_owner_identity_matches");
    check(Boolean(login.user.first_run_guide_seen_at), "explicit_welcome_ack_persisted");
    await page.getByRole("navigation", { name: "Primary" }).waitFor();
    check(await page.locator(".first-run-welcome").count() === 0, "acknowledged_welcome_not_repeated");
    await page.getByRole("button", { name: /^Account:/ }).click();
    await page.locator(".account-console-card summary").click();
    await page.locator(".account-console-link").filter({ hasText: "Platform owner console" }).click();
    await page.getByRole("heading", { name: "Platform Owner Console", exact: true }).waitFor();
    check(true, "persisted_owner_console_available");
  }
  stage = "browser sign out";
  const endedToken = await page.evaluate(() => localStorage.getItem("aperture-session-token"));
  await page.getByRole("button", { name: /^Account:/ }).click();
  await responseFor(page, "/api/auth/logout", () => page.getByRole("button", { name: /^Sign out/ }).click(), 200);
  await page.getByRole("heading", { name: "Sign in to continue" }).waitFor();
  check(await page.evaluate(() => localStorage.getItem("aperture-session-token")) === null, "browser_session_removed");
  const ended = await current.request.get(`${apiOrigin}/api/auth/session`, { headers: { "x-aperture-session": endedToken } });
  check(ended.status() === 401, "server_rejects_signed_out_session");
  owner.revokedToken = endedToken;
  stage = "completed";
  save();
  console.log(JSON.stringify({ stage, mode, checks, frames: Object.keys(targets) }));
  await browser.close();
}
main().catch(async (error) => {
  // Playwright call logs can include fill values; keep failures secret-safe.
  console.error(JSON.stringify({ stage, errorType: error.name }));
  if (browser) await browser.close();
  process.exitCode = 1;
});
