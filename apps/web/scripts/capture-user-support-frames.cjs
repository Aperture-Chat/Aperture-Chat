/* Capture existing synthetic account, Help, and mobile UI for training.
 *
 * CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=I_HAVE_REVIEWED_SYNTHETIC_DATA \
 * CAPTURE_SESSION_FILE=tmp/training-captures/training-user-session.json \
 *   node apps/web/scripts/capture-user-support-frames.cjs
 *
 * All frames stay in ignored review directories. Nothing is copied to public
 * assets by this script. Profile/report forms are never submitted, appearance
 * is not changed, and security/password forms stay empty. Mobile frames
 * are genuine rendered UI in a documented browser device emulation; no native
 * installation or installability event is simulated.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium, devices } = require("playwright");
const { createCaptureRun, captureCredentials, validateCaptureSource } = require("./training-capture-run.cjs");

const APP = process.env.CAPTURE_APP_URL || "http://127.0.0.1:5173";
const API = process.env.CAPTURE_API_URL || "http://127.0.0.1:8000";
const CONFIRMATION = process.env.CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION || "";
const WORK = path.join(__dirname, "../../../tmp/training-captures");
const DESKTOP = { width: 1185, height: 855 };

async function enforceReadOnlyRequests(context) {
  const attemptedWrites = [];
  // An unexpected mutation fails the run instead of persisting a UI mistake.
  // Responses are never mocked or replaced with invented success data.
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      attemptedWrites.push({ method: request.method(), path: new URL(request.url()).pathname });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return attemptedWrites;
}

async function openReadOnlyContext(browser, auth, expectedRole, options = {}, authorizedSyntheticEmail = null) {
  validateCaptureSource(APP, CONFIRMATION);
  validateCaptureSource(API, CONFIRMATION);
  if (!auth.user || !auth.token) throw new Error("A real synthetic signed-in session is required.");
  const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2, ...options });
  const attemptedWrites = await enforceReadOnlyRequests(context);
  const response = await context.request.get(`${API}/api/auth/session`, {
    headers: { "X-Aperture-Session": auth.token },
  });
  if (!response.ok()) throw new Error(`Existing session validation failed: HTTP ${response.status()}`);
  const session = await response.json();
  if (session.user?.id !== auth.user || session.user?.role !== expectedRole) {
    throw new Error("The session does not belong to the requested capture role.");
  }
  // An explicitly approved capture may use one exact reserved-test address;
  // ordinary runs retain their original example.test account restriction.
  const approvedTestAccount = typeof authorizedSyntheticEmail === "string"
    && /^[^@]+@[^@]+\.(test|invalid)$/i.test(authorizedSyntheticEmail)
    && (session.user.email || "").toLowerCase() === authorizedSyntheticEmail.toLowerCase();
  const standardTestAccount = authorizedSyntheticEmail === null && /^[^@]+@example\.test$/i.test(session.user.email || "");
  if (!approvedTestAccount && !standardTestAccount) {
    throw new Error("Use an explicitly synthetic example.test account for public training captures.");
  }
  await context.addInitScript(({ user, token }) => {
    localStorage.setItem("aperture-session-user-id", user);
    localStorage.setItem("aperture-session-token", token);
  }, auth);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(APP);
  await page.locator(".composer textarea").waitFor({ timeout: 30000 });
  await page.addStyleTag({ content: ".apx-tooltip{display:none!important}" });
  return { context, page, attemptedWrites, userId: session.user.id };
}

function stagedCapture(scriptPath, role) {
  // createCaptureRun validates complete PNG batches. Its destination here is
  // intentionally ignored review storage, never the served training folder.
  return createCaptureRun({
    scriptPath,
    publicDirectory: path.join(WORK, "review-ready", `${role}-support`),
    appUrl: APP,
    confirmation: CONFIRMATION,
  });
}

async function screenshotWithBounds(page, outputDirectory, name, regions = {}, metadata, extra = {}) {
  await page.waitForTimeout(350);
  const viewport = page.viewportSize();
  const measured = {};
  for (const [region, locator] of Object.entries(regions)) {
    const box = await locator.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) throw new Error(`Missing visible capture region: ${region}`);
    const left = Math.max(0, box.x);
    const top = Math.max(0, box.y);
    const right = Math.min(viewport.width, box.x + box.width);
    const bottom = Math.min(viewport.height, box.y + box.height);
    if (right <= left || bottom <= top) throw new Error(`Capture region is outside the viewport: ${region}`);
    measured[region] = {
      rect: { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) },
      fullElementRect: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
    };
  }
  await page.screenshot({ path: path.join(outputDirectory, `${name}.png`), scale: "device" });
  const fit = Math.min(DESKTOP.width / viewport.width, DESKTOP.height / viewport.height);
  metadata.frames[name] = {
    viewport, deviceScaleFactor: 2,
    pixelDimensions: { width: viewport.width * 2, height: viewport.height * 2 },
    compositionViewport: DESKTOP,
    containPlacement: {
      x: (DESKTOP.width - viewport.width * fit) / 2,
      y: (DESKTOP.height - viewport.height * fit) / 2,
      width: viewport.width * fit, height: viewport.height * fit, scale: fit,
    },
    regions: measured,
    ...extra,
  };
  fs.writeFileSync(path.join(outputDirectory, "support-capture-metadata.json"), JSON.stringify(metadata, null, 2));
  console.log(`Captured ${name}`);
}

async function main() {
  const capture = stagedCapture(__filename, "user");
  const auth = captureCredentials();
  const metadata = {
    role: "user", capturedAt: new Date().toISOString(), readOnly: true, frames: {},
    pending: [
      { frame: "help-report-received", reason: "An actual issue submission is required; this read-only run does not submit reports." },
      { frame: "access-welcome", reason: "Existing training accounts have already reviewed their first-run guide; no new-account state is fabricated." },
    ],
  };
  const browser = await chromium.launch();
  let desktop;
  let mobile;
  let anonymousWrites = [];
  try {
    desktop = await openReadOnlyContext(browser, auth, "USER");
    let page = desktop.page;
    const shot = (name, regions, extra) => screenshotWithBounds(page, capture.outputDirectory, name, regions, metadata, extra);

    await page.getByRole("button", { name: /^(Light|Dark) mode$/ }).waitFor();
    await shot("appearance-control", { appearanceControl: page.locator(".sidebar-bottom") });

    await page.getByRole("button", { name: "Composer shortcuts", exact: true }).click();
    await page.getByRole("note", { name: "Composer shortcuts", exact: true }).waitFor();
    await shot("composer-shortcuts-help", { composerShortcuts: page.getByRole("note", { name: "Composer shortcuts", exact: true }) });
    await page.getByRole("button", { name: "Dismiss shortcuts", exact: true }).click();

    await page.getByRole("button", { name: /^Account:/ }).click();
    const account = page.getByRole("dialog", { name: "Account", exact: true });
    await account.waitFor();
    await shot("account-overview", { accountOverview: account, accountIdentity: page.locator(".drawer-account-button") });
    await page.getByRole("button", { name: /^Edit account profile for / }).click();
    const profile = page.locator(".account-profile-form");
    await profile.waitFor();
    await profile.scrollIntoViewIfNeeded();
    await shot("account-profile-form", { accountProfileForm: profile });
    await profile.getByRole("button", { name: "Cancel", exact: true }).click();

    const security = page.locator(".account-security-section");
    await security.getByRole("button", { name: "Manage security", exact: true }).click();
    await security.getByRole("button", { name: "Set up authenticator", exact: true }).waitFor();
    await security.scrollIntoViewIfNeeded();
    await shot("account-security-overview", { accountSecurityOverview: security });
    await security.getByRole("button", { name: "Set up authenticator", exact: true }).click();
    const securityForm = security.locator(".account-security-form");
    await securityForm.waitFor();
    if (await securityForm.getByLabel("Current password", { exact: true }).inputValue()) throw new Error("Security form must stay empty.");
    if (await security.locator(".account-security-qr, .account-security-secret, .account-security-codes").count()) throw new Error("Secret-bearing security state must never be captured.");
    await security.scrollIntoViewIfNeeded();
    await shot("account-authenticator-start", { accountAuthenticatorStart: security }, { enrollmentState: "current-password form only; enrollment not started" });
    await securityForm.getByRole("button", { name: "Cancel", exact: true }).click();
    await security.getByRole("button", { name: "Close security", exact: true }).click();
    const password = page.locator(".account-password-card");
    await password.getByRole("button", { name: "Edit", exact: true }).click();
    await password.locator(".account-password-form").waitFor();
    if (await password.locator("input").evaluateAll((inputs) => inputs.some((input) => input.value))) throw new Error("Password form must stay empty.");
    await password.scrollIntoViewIfNeeded();
    await shot("account-password-form", { accountPasswordForm: password }, { passwordChangeState: "empty form; not submitted" });
    await password.locator(".account-password-edit-button").click();
    await account.getByRole("button", { name: "Close", exact: true }).click();

    await page.getByRole("button", { name: "Help", exact: true }).click();
    const help = page.getByRole("dialog", { name: "Help", exact: true });
    await help.waitFor();
    await help.getByRole("button", { name: /Report a problem/ }).waitFor();
    await shot("help-library", { helpLibrary: help, reportProblemEntry: page.locator(".report-problem-entry") });
    await help.getByRole("button", { name: /Report a problem/ }).click();
    const report = page.getByRole("dialog", { name: "Report a problem", exact: true });
    await report.getByLabel("Subject", { exact: true }).fill("Synthetic training example — not submitted");
    await report.getByLabel("Message", { exact: true }).fill("Training example only. Describe what happened, what you expected, and the steps to reproduce it. Attach a screenshot after checking it for private information.");
    await shot("help-report-form", { helpReportForm: page.locator(".issue-report-form") }, { submissionState: "unsubmitted" });
    await report.getByRole("button", { name: "Close", exact: true }).click();

    mobile = await openReadOnlyContext(browser, auth, "USER", {
      ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    });
    page = mobile.page;
    const initialInstall = page.getByRole("button", { name: "Close install prompt", exact: true });
    if (await initialInstall.isVisible()) await initialInstall.click();
    await page.getByRole("button", { name: "Open menu", exact: true }).waitFor();
    const mobileMeta = { deviceEmulation: "iPhone 13 user agent and touch viewport in Chromium; not a native installation" };
    await shot("mobile-chat-home", { mobileComposer: page.locator(".composer") }, mobileMeta);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    const nav = page.getByRole("navigation", { name: "Primary", exact: true });
    await nav.waitFor();
    await shot("mobile-navigation", { mobileNavigation: page.locator("#workspace-navigation") }, mobileMeta);
    await page.getByRole("button", { name: "Install app", exact: true }).click();
    const install = page.getByRole("dialog", { name: /^Add .+ to your home screen$/ });
    await install.waitFor();
    await install.getByText(/Add to Home Screen/).waitFor();
    await shot("mobile-install-ios", { mobileInstallInstructions: install }, { ...mobileMeta, installationState: "manual instructions only; not installed" });

    // A fresh browser context shows real public sign-in guidance without
    // changing or ending any existing authenticated session.
    const anonymous = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2 });
    anonymousWrites = await enforceReadOnlyRequests(anonymous);
    page = await anonymous.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(APP);
    await page.getByRole("button", { name: "Trouble signing in?", exact: true }).waitFor();
    await shot("access-sign-in-method", { accessSignInMethod: page.locator(".auth-panel") }, { authenticationState: "actual configured sign-in options" });
    await page.getByRole("button", { name: "Trouble signing in?", exact: true }).click();
    await page.locator(".auth-help-section [role='status']").waitFor();
    await shot("auth-sign-in-help", { authSignInHelp: page.locator(".auth-panel") }, { authenticationState: "signed out; guidance only" });
    await page.getByRole("button", { name: "Request access", exact: true }).click();
    const access = page.locator(".auth-access-form");
    await access.waitFor();
    await access.getByLabel("First name", { exact: true }).fill("Jamie");
    await access.getByLabel("Last name", { exact: true }).fill("Example");
    await access.getByLabel("Work email", { exact: true }).fill("training.request@example.test");
    await shot("access-request-form", { accessRequestForm: page.locator(".auth-panel") }, { accessRequestState: "unsubmitted synthetic form" });

    const writes = [...desktop.attemptedWrites, ...mobile.attemptedWrites, ...anonymousWrites];
    if (writes.length) throw new Error(`Capture attempted ${writes.length} mutation requests; nothing was published.`);
    await browser.close();
    capture.complete();
    console.log("Staged for review only; public training assets remain unchanged.");
  } finally {
    await browser.close();
  }
}

module.exports = { openReadOnlyContext, stagedCapture, screenshotWithBounds, API, APP, WORK };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
