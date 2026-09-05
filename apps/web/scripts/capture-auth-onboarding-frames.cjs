/* Capture a real synthetic access-request and account-security lifecycle.
 *
 * Required environment:
 *   CAPTURE_APP_URL / CAPTURE_API_URL: explicit loopback origins
 *   CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=I_HAVE_REVIEWED_SYNTHETIC_DATA
 *   CAPTURE_AUTH_MUTATION_CONFIRMATION=I_APPROVE_SYNTHETIC_AUTH_MUTATIONS
 *   CAPTURE_SESSION_FILE: private actual tenant-admin sign-in response, or
 *     CAPTURE_USER_ID and CAPTURE_SESSION_TOKEN
 *   CAPTURE_AUTH_PRIVATE_STATE_FILE: new private recovery-state file
 *
 * This creates and approves one reserved-domain account, sets its temporary
 * and permanent passwords, enrolls an authenticator, replaces recovery codes,
 * and finally disables verification and checks session revocation. Credentials
 * are generated at runtime and saved only to the explicitly supplied private
 * state file. Screenshots never contain passwords, QR secrets, or recovery codes.
 * All output remains in ignored review storage; publication is a separate step.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { captureCredentials, validateCaptureSource } = require("./training-capture-run.cjs");

const VIEWPORT = { width: 1185, height: 855 };
const EXPECTED = [
  "access-request-form", "access-request-received", "access-requests",
  "access-handoff", "access-temporary-password", "access-own-password", "access-welcome",
  "account-security-overview", "account-authenticator-start", "account-authenticator-verify",
  "account-recovery-save", "account-recovery-replace", "account-security-enabled",
];
const WORK = path.join(__dirname, "../../../tmp/training-captures");
let stage = "validate inputs";
let browser;
let state;
let privateStateFile;
let outputDirectory;
const metadata = { capturedAt: new Date().toISOString(), viewport: VIEWPORT, scale: 2, checks: {}, frames: {} };

function required(name) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  return process.env[name];
}

function loopbackOrigin(name) {
  const value = required(name);
  validateCaptureSource(value, required("CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION"));
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`${name} must be an origin.`);
  return url.origin;
}

function check(value, name) {
  if (!value) {
    const failure = new Error("Capture validation failed.");
    failure.captureCheck = name;
    throw failure;
  }
  metadata.checks[name] = true;
}

function save() {
  if (state && privateStateFile) {
    fs.writeFileSync(privateStateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.chmodSync(privateStateFile, 0o600);
  }
  if (outputDirectory) {
    fs.writeFileSync(path.join(outputDirectory, "auth-capture-metadata.json"), JSON.stringify({ stage, ...metadata }, null, 2));
    fs.writeFileSync(path.join(outputDirectory, "measured-targets.json"), JSON.stringify(metadata.frames, null, 2));
  }
}

function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret.replace(/=+$/, "")].map((letter) => alphabet.indexOf(letter).toString(2).padStart(5, "0")).join("");
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}

async function api(origin, method, endpoint, body, token) {
  const response = await fetch(origin + endpoint, {
    method, redirect: "error",
    headers: { "Content-Type": "application/json", ...(token ? { "x-aperture-session": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

async function response(page, endpointPattern, action, expectedStatus) {
  const pending = page.waitForResponse((item) => endpointPattern.test(new URL(item.url()).pathname) && item.request().method() !== "OPTIONS");
  await action();
  const result = await pending;
  check(result.status() === expectedStatus, `expected_http_${expectedStatus}_at_${stage.replaceAll(" ", "_")}`);
  return result.json();
}

async function contextFor(app, apiOrigin, auth) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, serviceWorkers: "block" });
  // The explicit API origin controls every API operation, including when the
  // web development server has a proxy configured for another local instance.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== app && url.origin !== apiOrigin) return route.abort("blockedbyclient");
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const actual = await route.fetch({ url: apiOrigin + url.pathname + url.search, maxRedirects: 0 });
    await route.fulfill({ response: actual });
  });
  if (auth) await context.addInitScript(({ user, token }) => {
    localStorage.setItem("aperture-session-user-id", user);
    localStorage.setItem("aperture-session-token", token);
  }, auth);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(app);
  return page;
}

async function shot(page, name, selectors, masks = []) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(450);
  // Capture empty proof fields; the UI itself is never replaced or rewritten.
  for (const input of await page.locator('input[type="password"], input[autocomplete="one-time-code"]').all()) {
    if (await input.isVisible()) check((await input.inputValue()) === "", `empty_proof_field_${name}`);
  }
  for (const selector of masks) check(await page.locator(selector).isVisible(), `redaction_target_present_${name}`);
  const targets = {};
  for (const [key, selector] of Object.entries(selectors)) {
    const locator = page.locator(selector).first();
    check(await locator.isVisible(), `visible_target_${name}_${key}`);
    targets[key] = { selector, rect: await locator.boundingBox() };
  }
  await page.screenshot({ path: path.join(outputDirectory, `${name}.png`), mask: masks.map((selector) => page.locator(selector)), maskColor: "#dbe5e8" });
  metadata.frames[name] = { viewport: VIEWPORT, scale: 2, targets, redactedSelectors: masks };
  save();
}

async function main() {
  const app = loopbackOrigin("CAPTURE_APP_URL");
  const apiOrigin = loopbackOrigin("CAPTURE_API_URL");
  if (required("CAPTURE_AUTH_MUTATION_CONFIRMATION") !== "I_APPROVE_SYNTHETIC_AUTH_MUTATIONS") {
    throw new Error("Explicit synthetic authentication mutation acknowledgment is required.");
  }
  privateStateFile = path.resolve(required("CAPTURE_AUTH_PRIVATE_STATE_FILE"));
  const repository = fs.realpathSync(path.join(__dirname, "../../.."));
  const actualParent = fs.realpathSync(path.dirname(privateStateFile));
  const resolvedStatePath = path.join(actualParent, path.basename(privateStateFile));
  if (resolvedStatePath.startsWith(repository + path.sep)) {
    try {
      execFileSync("git", ["check-ignore", "--quiet", "--", resolvedStatePath], { cwd: repository, stdio: "ignore" });
    } catch {
      throw new Error("The private state file must be outside the repository or in ignored storage.");
    }
  }
  const auth = captureCredentials();
  check(Boolean(auth.user && auth.token), "existing_administrator_session_supplied");
  const session = await api(apiOrigin, "GET", "/api/auth/session", undefined, auth.token);
  check(session.status === 200 && session.data.user.id === auth.user, "administrator_session_valid");
  // Approval lessons must demonstrate the operator role that performs the task.
  check(session.data.user.role === "TENANT_ADMIN", "tenant_administrator_role_required");
  check(/^[^@]+@[^@]+\.(test|invalid)$/i.test(session.data.user.email || ""), "administrator_uses_reserved_synthetic_domain");
  metadata.administratorRole = session.data.user.role;
  // Exclusive creation preserves evidence and credentials from any earlier run.
  const stateHandle = fs.openSync(privateStateFile, "wx", 0o600);
  fs.closeSync(stateHandle);
  fs.mkdirSync(WORK, { recursive: true });
  outputDirectory = fs.mkdtempSync(path.join(WORK, "capture-auth-onboarding-"));
  state = {
    email: `onboarding-${crypto.randomBytes(6).toString("hex")}@training.invalid`,
    name: "Morgan Example",
    temporaryPassword: crypto.randomBytes(24).toString("base64url"),
    newPassword: crypto.randomBytes(28).toString("base64url"),
  };
  save();
  browser = await chromium.launch();
  const page = await contextFor(app, apiOrigin);
  stage = "access request";
  await page.getByRole("button", { name: "Request access", exact: true }).click();
  await page.getByRole("heading", { name: "Ask to join" }).waitFor();
  await page.getByLabel("First name", { exact: true }).fill("Morgan");
  await page.getByLabel("Last name", { exact: true }).fill("Example");
  await page.getByLabel("Work email", { exact: true }).fill(state.email);
  await shot(page, "access-request-form", { form: ".auth-access-form", submit: ".auth-submit-button" });
  await response(page, /^\/api\/auth\/access-requests$/, () => page.getByRole("button", { name: "Submit access request" }).click(), 202);
  await page.getByRole("heading", { name: "Request received" }).waitFor();
  await shot(page, "access-request-received", { receipt: ".auth-access-success", steps: ".auth-next-steps" });

  stage = "administrator approval";
  const admin = await contextFor(app, apiOrigin, auth);
  await admin.getByRole("navigation", { name: "Primary" }).waitFor();
  await admin.getByRole("button", { name: /^Account:/ }).click();
  await admin.locator(".account-console-card summary").click();
  await admin.locator(".account-console-link").filter({ hasText: "Admin console" }).click();
  await admin.getByRole("heading", { name: "Access requests", exact: true }).waitFor();
  const request = admin.locator(".access-request-card").filter({ hasText: state.email });
  await request.scrollIntoViewIfNeeded();
  await shot(admin, "access-requests", { queue: ".access-request-queue", request: ".access-request-card", role: ".access-request-role", actions: ".access-request-actions" });
  const approved = await response(admin, /^\/api\/admin\/access-requests\/[^/]+\/approve$/, () => request.getByRole("button", { name: "Approve", exact: true }).click(), 200);
  state.userId = approved.id;
  save();
  await admin.getByRole("heading", { name: `Finish sign-in setup for ${state.name}` }).waitFor();
  await admin.locator(".access-handoff").scrollIntoViewIfNeeded();
  await shot(admin, "access-handoff", { handoff: ".access-handoff", actions: ".access-handoff-actions" });
  await admin.getByRole("button", { name: "Set temporary password", exact: true }).click();
  await admin.getByRole("dialog", { name: `Set a password for ${state.name}` }).waitFor();
  await shot(admin, "access-temporary-password", { dialog: ".password-reset-modal", password: ".password-reset-form input", temporary: ".password-reset-form .toggle", actions: ".password-reset-form .connector-config-actions" });
  await admin.locator(".password-reset-form input").fill(state.temporaryPassword);
  await response(admin, /^\/api\/admin\/users\/[^/]+\/password$/, () => admin.getByRole("button", { name: "Set password", exact: true }).click(), 200);

  stage = "first password sign in";
  await page.getByRole("button", { name: "Back to sign in", exact: true }).click();
  const local = page.getByRole("button", { name: "Email & password", exact: true });
  if (await local.isVisible()) await local.click();
  await page.getByLabel("Email", { exact: true }).fill(state.email);
  await page.getByLabel("Password", { exact: true }).fill(state.temporaryPassword);
  const login = await response(page, /^\/api\/auth\/login$/, () => page.getByRole("button", { name: "Sign in", exact: true }).click(), 200);
  check(login.must_change_password, "temporary_password_requires_replacement");
  state.temporaryToken = login.session.token;
  await page.getByRole("heading", { name: "Set a new password" }).waitFor();
  await shot(page, "access-own-password", { panel: ".auth-panel", newPassword: 'input[autocomplete="new-password"]', continue: ".auth-submit-button" });
  await page.getByLabel("New password", { exact: true }).fill(state.newPassword);
  await page.getByLabel("Confirm password", { exact: true }).fill(state.newPassword);
  await response(page, /^\/api\/auth\/password$/, () => page.getByRole("button", { name: "Set password and continue" }).click(), 200);
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
  state.passwordToken = await page.evaluate(() => localStorage.getItem("aperture-session-token"));
  check((await api(apiOrigin, "GET", "/api/auth/session", undefined, state.temporaryToken)).status === 401, "temporary_session_revoked_after_password_change");
  const restored = await api(apiOrigin, "GET", "/api/auth/session", undefined, state.passwordToken);
  check(restored.status === 200 && restored.data.user.first_run_guide_seen_at === null, "new_account_welcome_is_unacknowledged");
  await page.locator(".first-run-welcome").waitFor();
  await page.locator(".first-run-welcome").scrollIntoViewIfNeeded();
  await shot(page, "access-welcome", { welcome: ".first-run-welcome", steps: ".first-run-steps", actions: ".first-run-actions" });

  stage = "authenticator enrollment";
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("button", { name: "Manage security", exact: true }).click();
  await page.getByRole("button", { name: "Set up authenticator" }).waitFor();
  await page.locator(".account-security").scrollIntoViewIfNeeded();
  await shot(page, "account-security-overview", { security: ".account-security", setup: ".account-security > button", drawer: ".utility-drawer" });
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  await page.locator(".account-security").scrollIntoViewIfNeeded();
  await shot(page, "account-authenticator-start", { security: ".account-security", password: '.account-security input[autocomplete="current-password"]' });
  await page.locator(".account-security").getByLabel("Current password", { exact: true }).fill(state.newPassword);
  state.enrollment = await response(page, /^\/api\/auth\/mfa\/enroll$/, () => page.getByRole("button", { name: "Continue setup" }).click(), 201);
  save();
  await page.getByLabel("I added this account to my authenticator.").check();
  await page.locator(".account-security").scrollIntoViewIfNeeded();
  await shot(page, "account-authenticator-verify", { code: '.account-security input[autocomplete="one-time-code"]', actions: ".account-security .account-security-actions" }, [".account-security-qr", ".account-security-secret"]);
  await page.getByLabel("Authenticator code", { exact: true }).fill(totp(state.enrollment.secret));
  const confirmed = await response(page, /^\/api\/auth\/mfa\/enroll\/confirm$/, () => page.getByRole("button", { name: "Verify authenticator" }).click(), 200);
  state.mfaToken = confirmed.session.token;
  state.recoveryCodes = confirmed.recovery_codes;
  check(confirmed.session.mfa_assured, "enrollment_creates_assured_session");
  check((await api(apiOrigin, "GET", "/api/auth/session", undefined, state.passwordToken)).status === 401, "enrollment_revokes_password_only_session");
  await page.getByRole("heading", { name: "Save your recovery codes" }).waitFor();
  check(await page.getByRole("button", { name: "Done", exact: true }).isDisabled(), "recovery_acknowledgment_required");
  await page.locator(".account-security").scrollIntoViewIfNeeded();
  await shot(page, "account-recovery-save", { recovery: ".account-security-form", acknowledgment: ".account-security-check", actions: ".account-security .primary-button" }, [".account-security-codes"]);
  await page.getByLabel("I stored these recovery codes somewhere safe.").check();
  await page.getByRole("button", { name: "Done", exact: true }).click();

  stage = "replace recovery codes";
  await page.getByRole("button", { name: "Replace recovery codes", exact: true }).click();
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code", { exact: true }).scrollIntoViewIfNeeded();
  await shot(page, "account-recovery-replace", { security: ".account-security", proof: '.account-security input[autocomplete="one-time-code"]' });
  await page.getByLabel("Recovery code", { exact: true }).fill(state.recoveryCodes[0]);
  const replaced = await response(page, /^\/api\/auth\/mfa\/recovery-codes\/regenerate$/, () => page.getByRole("button", { name: "Create new recovery codes" }).click(), 200);
  state.replacementCodes = replaced.recovery_codes;
  check(!state.replacementCodes.some((code) => state.recoveryCodes.includes(code)), "replacement_codes_are_new");
  save();
  await page.getByLabel("I stored these recovery codes somewhere safe.").check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const challenge = await api(apiOrigin, "POST", "/api/auth/login", { email: state.email, auth_method: "local", password: state.newPassword });
  check(challenge.status === 202, "password_login_requires_mfa");
  const stale = await api(apiOrigin, "POST", "/api/auth/mfa/preauth/verify", { challenge_token: challenge.data.challenge_token, method: "recovery_code", code: state.recoveryCodes[1] });
  check(stale.status === 401, "old_recovery_code_rejected");
  const second = await api(apiOrigin, "POST", "/api/auth/mfa/preauth/verify", { challenge_token: challenge.data.challenge_token, method: "recovery_code", code: state.replacementCodes[0] });
  check(second.status === 200 && second.data.session.mfa_assured, "new_recovery_code_authenticates");
  state.secondMfaToken = second.data.session.token;
  await page.locator(".account-security").scrollIntoViewIfNeeded();
  await shot(page, "account-security-enabled", { security: ".account-security" });

  stage = "disable verification and revoke sessions";
  await page.getByRole("button", { name: "Turn off verification", exact: true }).click();
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code", { exact: true }).fill(state.replacementCodes[1]);
  await response(page, /^\/api\/auth\/mfa\/disable$/, () => page.getByRole("button", { name: "Turn off and sign out" }).click(), 200);
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  check(await page.evaluate(() => localStorage.getItem("aperture-session-token")) === null, "disabling_verification_clears_browser_session");
  for (const key of ["mfaToken", "secondMfaToken"]) check((await api(apiOrigin, "GET", "/api/auth/session", undefined, state[key])).status === 401, `${key}_revoked_after_disable`);
  const finalLogin = await api(apiOrigin, "POST", "/api/auth/login", { email: state.email, auth_method: "local", password: state.newPassword });
  check(finalLogin.status === 200 && !finalLogin.data.session.mfa_assured, "fresh_password_login_works_after_disable");
  state.finalToken = finalLogin.data.session.token;
  const finalStatus = await api(apiOrigin, "GET", "/api/auth/mfa/status", undefined, state.finalToken);
  check(finalStatus.status === 200 && !finalStatus.data.enabled && finalStatus.data.recovery_codes_remaining === 0, "capture_account_finishes_with_mfa_disabled");
  for (const name of EXPECTED) check(Boolean(metadata.frames[name]) && fs.existsSync(path.join(outputDirectory, `${name}.png`)), `frame_complete_${name}`);
  stage = "completed";
  save();
  console.log(`Staged ${EXPECTED.length} actual authentication frames in ${path.relative(process.cwd(), outputDirectory)}. Review the masked captures and measured targets before publication.`);
}

main().catch((error) => {
  // Browser error messages may include filled values, so logs report only the
  // stage and error class. Recovery details remain in the private state file.
  metadata.error = { stage, type: error.name, ...(error.captureCheck ? { check: error.captureCheck } : {}) };
  save();
  console.error(`Authentication capture failed at ${stage} (${error.name}).`);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
});
