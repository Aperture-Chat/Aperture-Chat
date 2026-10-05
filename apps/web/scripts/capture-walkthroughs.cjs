/* Capture complete, path-by-path training walkthroughs against an isolated
 * synthetic stack. Each module under ./walkthroughs/ performs its task from the
 * first click to the verified result, for real: an SSO module registers the
 * application at a local identity provider, saves it in the console, tests it,
 * and signs a synthetic person in. Nothing is simulated, so a step that fails
 * in the product fails the capture.
 *
 * Required: CAPTURE_APP_URL and CAPTURE_API_URL (loopback origins; the app
 * origin may be a *.localhost name), CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=
 * I_HAVE_REVIEWED_SYNTHETIC_DATA, CAPTURE_MUTATION_ACK=isolated-synthetic, and
 * actual sign-in response files for the roles a module uses:
 * CAPTURE_OWNER_SESSION_FILE, CAPTURE_ADMIN_SESSION_FILE, CAPTURE_USER_SESSION_FILE.
 * Modules list any further inputs (for example a local identity provider's
 * origin and an ignored admin-credential file) in their own header.
 * Optional: CAPTURE_OUTPUT_DIRECTORY (default tmp/training-captures/walkthroughs),
 * CAPTURE_CHROMIUM_EXECUTABLE_PATH.
 *
 * Usage: node apps/web/scripts/capture-walkthroughs.cjs sso-oidc[,sso-golive]
 *        node apps/web/scripts/capture-walkthroughs.cjs --publish sso-oidc
 *
 * Captures stage under the output directory with a manifest of PNG hashes and
 * measured focus regions (<role>/measured-rects.json, ready for
 * apply-training-focus.cjs). --publish copies a complete, reviewed batch into
 * public/training/<role>/ and refuses a partial one.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const { validateCaptureSource } = require("./training-capture-run.cjs");
const { measureFrameFocus } = require("./training-focus-measurement.cjs");
const { WALKTHROUGHS } = require("./walkthroughs/index.cjs");

const VIEWPORT = { width: 1185, height: 855 };
const FONT_ORIGINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];
const ROLES = { user: "USER", admin: "TENANT_ADMIN", owner: "PLATFORM_OWNER" };
const repoRoot = path.resolve(__dirname, "../../..");
const publicRoot = path.resolve(__dirname, "../public");

function origin(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  validateCaptureSource(value, process.env.CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION);
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`${name} must be an origin.`);
  return url.origin;
}

function outputDirectory() {
  return path.resolve(repoRoot, process.env.CAPTURE_OUTPUT_DIRECTORY || "tmp/training-captures/walkthroughs");
}

async function readSession(api, audience) {
  const file = process.env[`CAPTURE_${audience.toUpperCase()}_SESSION_FILE`];
  if (!file) throw new Error(`A real ${audience} sign-in response file is required.`);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!saved.user?.id || !saved.session?.token) throw new Error(`Invalid ${audience} sign-in response file.`);
  const result = await fetch(api + "/api/auth/session", { headers: { "x-aperture-session": saved.session.token } });
  if (!result.ok) throw new Error(`The ${audience} session is not valid.`);
  const actual = await result.json();
  if (actual.user?.id !== saved.user.id || actual.user?.role !== ROLES[audience]) throw new Error(`${audience} session role mismatch.`);
  if (!/^[^@]+@[^@]+\.(test|invalid)$/i.test(actual.user.email || "")) throw new Error("Capture accounts must use a reserved synthetic domain.");
  return { user: actual.user, token: saved.session.token };
}

function createKit({ APP, API, OUT, module, manifest }) {
  const sessions = {};
  const measures = { user: {}, admin: {}, owner: {} };
  const allowedOrigins = new Set([APP, API, ...(module.externalOrigins?.() ?? [])]);
  let browser;
  const contexts = new Set();
  let current = null;

  async function launch() {
    browser ??= await chromium.launch({
      ...(process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH } : {}),
    });
    return browser;
  }

  async function newPage({ storageState, session } = {}) {
    const context = await (await launch()).newContext({
      viewport: VIEWPORT, deviceScaleFactor: 2, serviceWorkers: "block",
      ...(storageState && fs.existsSync(storageState) ? { storageState } : {}),
    });
    contexts.add(context);
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (FONT_ORIGINS.includes(url.origin) && route.request().method() === "GET") return route.continue();
      if (!allowedOrigins.has(url.origin)) {
        manifest.blockedRequests.push({ method: route.request().method(), url: url.origin + url.pathname });
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    if (session) {
      await context.addInitScript(({ user, token }) => {
        localStorage.setItem("aperture-session-user-id", user);
        localStorage.setItem("aperture-session-token", token);
      }, { user: session.user.id, token: session.token });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    current = page;
    return page;
  }

  const kit = {
    APP, API, OUT,
    env(name) {
      const value = process.env[name];
      if (!value) throw new Error(`${module.name} requires ${name}.`);
      return value;
    },
    async session(audience) {
      return sessions[audience] ??= await readSession(API, audience);
    },
    /** A page signed in as a synthetic role, opened on the app origin. */
    async app(audience, route = "/") {
      const page = await newPage({ session: await kit.session(audience) });
      await page.goto(APP + route);
      await page.getByRole("navigation", { name: "Primary" }).waitFor();
      return page;
    },
    /** A signed-out browser, as a new person would arrive. */
    async anonymous(route = "/") {
      const page = await newPage();
      await page.goto(APP + route);
      return page;
    },
    /** A page on a declared external origin, optionally with saved storage. */
    async external(url, { storageState } = {}) {
      const page = await newPage({ storageState });
      await page.goto(url);
      return page;
    },
    use(page) {
      current = page;
      return page;
    },
    async api(audience, method, pathname, body) {
      const { token } = await kit.session(audience);
      const response = await fetch(API + pathname, {
        method,
        headers: { "x-aperture-session": token, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${pathname} returned ${response.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    },
    /** Stage one frame for the module's role. Every focus region the deck
     * declares on this frame is measured from the live DOM at this moment. */
    async shot(name, { page = current, role = module.role, keepPointer = false, keepFocus = false, maskedExternalSecrets = false } = {}) {
      if (!page) throw new Error(`No page is open for ${name}.`);
      if (!module.frames.includes(`${role}/${name}`)) throw new Error(`${module.name} does not declare ${role}/${name}.`);
      if (!keepPointer) await page.mouse.move(1, 1);
      // A focus ring on the last field typed into competes with the highlight.
      if (!keepFocus) await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.addStyleTag({ content: ".apx-tooltip{display:none!important}" }).catch(() => {});
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(450);
      const appPage = new URL(page.url()).origin === APP;
      for (const input of await page.locator('input[type="password"], input[autocomplete="one-time-code"]').all()) {
        if (!(await input.isVisible()) || !(await input.inputValue())) continue;
        // Only the viewport is captured; a filled field scrolled out of view is not in the frame.
        const box = await input.boundingBox();
        if (!box || box.y + box.height <= 0 || box.y >= VIEWPORT.height || box.x + box.width <= 0 || box.x >= VIEWPORT.width) continue;
        // External consoles mask their own secrets; this product's proof fields
        // must be empty in every published frame.
        if (appPage || !maskedExternalSecrets || (await input.getAttribute("type")) !== "password") {
          throw new Error(`Proof fields must be empty in training captures (${name}).`);
        }
      }
      // Authenticator QR codes, setup secrets, and recovery codes are never
      // captured by this runner; the auth capture pipeline masks them.
      if (appPage && await page.locator(".account-security-qr, .account-security-secret, .account-security-codes").count()) {
        throw new Error(`Secret-bearing authentication screens require capture-auth-onboarding-frames.cjs (${name}).`);
      }
      const measured = await measureFrameFocus(page, role, name);
      Object.assign(measures[role], measured);
      const dir = path.join(OUT, role);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${name}.png`);
      await page.screenshot({ path: file });
      const png = fs.readFileSync(file);
      manifest.frames[`${role}/${name}`] = {
        sha256: crypto.createHash("sha256").update(png).digest("hex"),
        url: new URL(page.url()).origin + new URL(page.url()).pathname,
        focus: Object.keys(measured),
      };
      // apply-training-focus.cjs reads each PNG beside its measurements file.
      // Modules share a role directory, so merge rather than replace.
      const measuredFile = path.join(dir, "measured-rects.json");
      const earlier = fs.existsSync(measuredFile) ? JSON.parse(fs.readFileSync(measuredFile, "utf8")) : {};
      fs.writeFileSync(measuredFile, JSON.stringify({ ...earlier, ...measures[role] }, null, 2));
      save(OUT, manifest);
      console.log(`  ${role}/${name} (${Object.keys(measured).join(", ") || "no focus"})`);
    },
    async close() {
      for (const context of contexts) await context.close().catch(() => {});
      contexts.clear();
      await browser?.close();
      browser = undefined;
    },
  };
  return kit;
}

function save(OUT, manifest) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "capture-manifest.json"), JSON.stringify(manifest, null, 2));
}

function publish(names, OUT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "capture-manifest.json"), "utf8"));
  for (const name of names) {
    const module = WALKTHROUGHS[name];
    if (!manifest.completed.includes(name)) throw new Error(`${name} has no complete staged batch in ${OUT}.`);
    for (const frame of module.frames) {
      const [role, file] = frame.split("/");
      const staged = path.join(OUT, role, `${file}.png`);
      const png = fs.readFileSync(staged);
      const hash = crypto.createHash("sha256").update(png).digest("hex");
      if (manifest.frames[frame]?.sha256 !== hash) throw new Error(`${frame} changed after capture; recapture before publishing.`);
      fs.copyFileSync(staged, path.join(publicRoot, "training", role, `${file}.png`));
    }
    console.log(`published ${module.frames.length} frames for ${name}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const publishing = args.includes("--publish");
  const names = args.filter((arg) => !arg.startsWith("--")).flatMap((arg) => arg.split(",")).filter(Boolean);
  if (!names.length) throw new Error(`Usage: capture-walkthroughs.cjs [--publish] ${Object.keys(WALKTHROUGHS).join(",")}`);
  for (const name of names) if (!WALKTHROUGHS[name]) throw new Error(`Unknown walkthrough: ${name}`);
  const OUT = outputDirectory();
  if (publishing) return publish(names, OUT);

  if (process.env.CAPTURE_MUTATION_ACK !== "isolated-synthetic") {
    throw new Error("Walkthrough captures change their isolated instance; set CAPTURE_MUTATION_ACK=isolated-synthetic.");
  }
  const APP = origin("CAPTURE_APP_URL");
  const API = origin("CAPTURE_API_URL");
  const manifestPath = path.join(OUT, "capture-manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : { viewport: VIEWPORT, deviceScaleFactor: 2, completed: [], frames: {}, blockedRequests: [] };
  manifest.capturedAt = new Date().toISOString();
  for (const name of names) {
    const module = { name, ...WALKTHROUGHS[name] };
    manifest.completed = manifest.completed.filter((item) => item !== name);
    console.log(`${name}: ${module.description}`);
    const kit = createKit({ APP, API, OUT, module, manifest });
    try {
      await module.run(kit);
    } finally {
      await kit.close();
    }
    const missing = module.frames.filter((frame) => !manifest.frames[frame]);
    if (missing.length) throw new Error(`${name} did not capture ${missing.join(", ")}`);
    manifest.completed.push(name);
    save(OUT, manifest);
  }
  console.log(`Staged in ${OUT}. Review every PNG, then publish with --publish ${names.join(",")}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
