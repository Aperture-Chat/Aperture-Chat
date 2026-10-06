/* Getting into the workspace, performed for real from a signed-out browser.
 *
 * Inputs (beyond the runner's): CAPTURE_IDP_URL and CAPTURE_IDP_ADMIN_FILE for
 * the user workstream's own Keycloak realm (examplecorp-user; the shared
 * examplecorp realm is never touched). The isolated instance's API base URL
 * must equal CAPTURE_APP_URL so the SSO redirect URI is the one the server sends.
 *
 * user-access requests access as a new person, then (as the administrator's
 * part, through the admin API) approves the request and issues a temporary
 * password. The person signs in, sees a real wrong-password refusal, replaces
 * the temporary password, and lands on the welcome card. A second person signs
 * in through Organization SSO at the realm and arrives in the workspace.
 *
 * user-security signs a local account in, turns on two-step verification in the
 * account panel (the QR, setup key, and recovery-code screens are never shot;
 * their published frames come from capture-auth-onboarding-frames.cjs), replaces
 * recovery codes, signs out, signs back in with the authenticator challenge and
 * a recovery code, proves the code was consumed, and changes the password.
 * Every password, authenticator secret, and recovery code is random per run and
 * kept in memory only.
 */
const { helpers } = require("./user-common.cjs");
const { scrollTo, syntheticPassword, userRealm, freshTotp } = helpers;

const SSO_DOMAIN = "examplecorp.test";
const SAM = { username: "sam.rivera", email: `sam.rivera@${SSO_DOMAIN}`, firstName: "Sam", lastName: "Rivera" };
const TAYLOR = { first: "Taylor", last: "Reed", email: "taylor.reed@example.test" };

async function adminUserByEmail(kit, email) {
  const users = await kit.api("admin", "GET", "/api/admin/users");
  return users.find((user) => user.email === email);
}

/* Setup only: the realm, a person at the identity provider, and the instance's
 * SSO connection (the owner lessons teach this panel; this lesson teaches the
 * person signing in). Enforcement stays off so password sign-in remains. */
async function ensureSso(kit) {
  const realm = userRealm(kit);
  const secret = await realm.recreate({ redirectUri: `${kit.APP}/api/auth/sso/callback`, displayName: "Example Corporation" });
  const samPassword = syntheticPassword();
  await realm.addPerson(SAM, samPassword);
  const existing = await kit.api("owner", "GET", "/api/admin/sso-configs");
  const body = {
    provider: "keycloak", issuer_url: realm.issuer, client_id: "aperture-chat", enabled: true, client_secret: secret,
    settings: {
      protocol: "OIDC", enforced: false, domains: [SSO_DOMAIN], jit_provisioning: true, group_claim: "groups",
      require_platform_mfa: false, client_secret_set: true, mfa_enforced: false, status: "ready",
    },
  };
  if (existing.length) await kit.api("owner", "PATCH", `/api/admin/sso-configs/${existing[0].id}`, body);
  else await kit.api("owner", "POST", "/api/admin/sso-configs", body);
  return samPassword;
}

async function signedOut(kit) {
  const page = await kit.anonymous();
  await page.locator(".auth-heading").waitFor();
  await page.waitForTimeout(800);
  return page;
}

const userAccess = {
  role: "user",
  description: "Request access, replace a temporary password, and sign in with a password or Organization SSO.",
  externalOrigins: () => [new URL(process.env.CAPTURE_IDP_URL || "http://invalid.localhost").origin],
  frames: [
    "user/access-sign-in-page", "user/access-request-filled", "user/access-request-sent",
    "user/access-password-method", "user/access-wrong-password", "user/access-set-password", "user/access-first-welcome",
    "user/access-trouble", "user/access-sso-email", "user/access-sso-idp", "user/access-sso-welcome",
  ],
  async run(kit) {
    const { shot } = kit;
    if (await adminUserByEmail(kit, TAYLOR.email)) throw new Error("Reset the instance first: the synthetic requester already exists.");
    const samPassword = await ensureSso(kit);

    // 1. The sign-in page, as a new person arrives.
    const page = kit.use(await signedOut(kit));
    if (!(await page.locator(".auth-method-switch").count())) throw new Error("Both sign-in methods should be offered.");
    await shot("access-sign-in-page");

    // 2. Request access.
    await page.locator(".auth-request-button").click();
    const form = page.locator("form.auth-access-form");
    await form.getByLabel("First name").fill(TAYLOR.first);
    await form.getByLabel("Last name").fill(TAYLOR.last);
    await form.getByLabel("Work email").fill(TAYLOR.email);
    await shot("access-request-filled");
    await form.getByRole("button", { name: "Submit access request" }).click();
    await page.locator(".auth-access-success").waitFor();
    await shot("access-request-sent");

    // 3. The administrator's part (taught in the admin lessons): approve the
    //    request and issue a temporary password, delivered outside the app.
    const requester = await adminUserByEmail(kit, TAYLOR.email);
    if (!requester || requester.active) throw new Error("The access request did not create a pending account.");
    await kit.api("admin", "POST", `/api/admin/access-requests/${requester.id}/approve`, { role: "USER" });
    const temporary = syntheticPassword();
    await kit.api("admin", "POST", `/api/admin/users/${requester.id}/password`, { password: temporary, temporary: true });

    // 4. Sign in with email and password: first a real refusal, then the temporary password.
    await page.getByRole("button", { name: "Back to sign in" }).click();
    await page.locator(".auth-method-switch").getByRole("button", { name: /Email & password/ }).click();
    await page.getByLabel("Email").fill(TAYLOR.email);
    await shot("access-password-method");
    const passwordField = page.getByLabel("Password", { exact: true });
    await passwordField.fill(syntheticPassword());
    await page.locator(".auth-submit-button").click();
    await page.locator(".auth-error").filter({ hasText: "Invalid local credentials." }).waitFor();
    await passwordField.fill("");
    await shot("access-wrong-password");
    await passwordField.fill(temporary);
    await page.locator(".auth-submit-button").click();
    await page.getByRole("heading", { name: "Set a new password" }).waitFor();
    await shot("access-set-password");
    const chosen = syntheticPassword();
    const fields = page.locator('.auth-panel input[autocomplete="new-password"]');
    await fields.nth(0).fill(chosen);
    await fields.nth(1).fill(chosen);
    await page.getByRole("button", { name: "Set password and continue" }).click();
    await page.locator(".first-run-welcome").waitFor();
    await page.waitForTimeout(1200);
    await shot("access-first-welcome");

    // 5. Trouble signing in.
    const help = kit.use(await signedOut(kit));
    await help.getByRole("button", { name: "Trouble signing in?" }).click();
    await help.locator(".auth-help-section .auth-field-help").waitFor();
    await shot("access-trouble");

    // 6. Organization SSO at the identity provider.
    const sso = kit.use(await signedOut(kit));
    await sso.locator(".auth-method-switch").getByRole("button", { name: /Organization SSO/ }).click();
    await sso.getByLabel("Email").fill(SAM.email);
    await sso.waitForTimeout(400);
    await shot("access-sso-email");
    await sso.getByRole("button", { name: "Continue with SSO" }).click();
    await sso.locator("#kc-form-login").waitFor();
    await sso.fill("#username", SAM.username);
    await shot("access-sso-idp");
    await sso.fill("#password", samPassword);
    await sso.click("#kc-login");
    await sso.waitForURL((url) => url.origin === kit.APP);
    await sso.locator(".first-run-welcome").waitFor();
    await sso.waitForTimeout(1500);
    await shot("access-sso-welcome");
    const sam = await adminUserByEmail(kit, SAM.email);
    if (!sam || sam.auth_method !== "sso") throw new Error("The SSO sign-in did not create an SSO account.");
  },
};

const MORGAN = { email: "morgan.example@example.test", name: "Morgan Example" };

async function openSecurity(page) {
  await page.locator("button.account-card").click();
  const drawer = page.locator(".account-utility-drawer");
  await drawer.waitFor();
  const toggle = drawer.locator(".account-security-section").getByRole("button", { name: "Manage security" });
  if (await toggle.count()) await toggle.click();
  await drawer.locator(".account-security").waitFor();
  await page.waitForTimeout(500);
  return drawer;
}

async function passwordSignIn(kit, password) {
  const page = kit.use(await signedOut(kit));
  const local = page.locator(".auth-method-switch").getByRole("button", { name: /Email & password/ });
  if (await local.count()) await local.click();
  await page.getByLabel("Email").fill(MORGAN.email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.locator(".auth-submit-button").click();
  return page;
}

const userSecurity = {
  role: "user",
  description: "Turn on two-step verification, use a recovery code at sign-in, and change the password.",
  externalOrigins: () => [],
  frames: [
    "user/security-overview", "user/security-start", "user/security-enabled", "user/security-replace",
    "user/security-sign-in-code", "user/security-sign-in-recovery", "user/security-codes-remaining",
    "user/security-password-form", "user/security-password-updated",
  ],
  async run(kit) {
    const { shot } = kit;
    if (await adminUserByEmail(kit, MORGAN.email)) throw new Error("Reset the instance first: the synthetic account already exists.");
    // Setup: a local account with a permanent password (the access lesson shows the temporary-password path).
    const created = await kit.api("admin", "POST", "/api/admin/users", { email: MORGAN.email, display_name: MORGAN.name, role: "USER", auth_method: "local" });
    let password = syntheticPassword();
    await kit.api("admin", "POST", `/api/admin/users/${created.id}/password`, { password, temporary: false });

    // 1. Signed in, open Account › Manage security.
    let page = await passwordSignIn(kit, password);
    await page.getByRole("navigation", { name: "Primary" }).waitFor();
    await page.waitForTimeout(1200);
    let drawer = await openSecurity(page);
    await shot("security-overview");

    // 2. Set up authenticator: confirm the current password.
    await drawer.getByRole("button", { name: "Set up authenticator" }).click();
    await drawer.getByLabel("Current password").waitFor();
    await shot("security-start");
    await drawer.getByLabel("Current password").fill(password);
    await drawer.getByRole("button", { name: "Continue setup" }).click();
    // The QR and setup-key screen is secret-bearing and never shot here.
    const secret = (await drawer.locator(".account-security-secret").innerText()).replace(/\s+/g, "");
    await drawer.getByLabel("I added this account to my authenticator.").check();
    await drawer.getByLabel("Authenticator code").fill(await freshTotp(secret, page));
    await drawer.getByRole("button", { name: "Verify authenticator" }).click();
    await drawer.locator(".account-security-codes").waitFor();
    const codes = (await drawer.locator(".account-security-codes li").allInnerTexts()).map((code) => code.trim());
    if (codes.length < 2) throw new Error("No recovery codes were issued.");
    await drawer.getByLabel("I stored these recovery codes somewhere safe.").check();
    await drawer.getByRole("button", { name: "Done" }).click();
    await drawer.getByText(/recovery codes remain/).waitFor();
    await scrollTo(page, drawer.locator(".account-security"), "center");
    await shot("security-enabled");

    // 3. Replace recovery codes with a current authenticator code.
    await drawer.getByRole("button", { name: "Replace recovery codes" }).click();
    await drawer.getByText("Replace your recovery codes?").waitFor();
    await scrollTo(page, drawer.locator(".account-security"), "center");
    await shot("security-replace");
    await drawer.locator('.account-security input[autocomplete="one-time-code"]').fill(await freshTotp(secret, page));
    await drawer.getByRole("button", { name: "Create new recovery codes" }).click();
    await drawer.locator(".account-security-codes").waitFor();
    codes.splice(0, codes.length, ...(await drawer.locator(".account-security-codes li").allInnerTexts()).map((code) => code.trim()));
    await drawer.getByLabel("I stored these recovery codes somewhere safe.").check();
    await drawer.getByRole("button", { name: "Done" }).click();
    await drawer.getByText(/recovery codes remain/).waitFor();
    await page.context().close();

    // 4. Sign in again: the authenticator challenge, then a recovery code.
    page = await passwordSignIn(kit, password);
    await page.getByRole("heading", { name: "Two-step verification" }).waitFor();
    await shot("security-sign-in-code");
    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await page.waitForTimeout(400);
    await shot("security-sign-in-recovery");
    await page.locator('.auth-panel input[autocomplete="one-time-code"]').fill(codes[0]);
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await page.getByRole("navigation", { name: "Primary" }).waitFor();
    await page.waitForTimeout(1200);
    drawer = await openSecurity(page);
    if (!(await drawer.getByText(`${codes.length - 1} recovery codes remain`).count())) throw new Error("The recovery code was not consumed.");
    await scrollTo(page, drawer.locator(".account-security"), "center");
    await shot("security-codes-remaining");

    // 5. Change the password from the Password card.
    const card = drawer.locator(".account-password-card");
    await card.getByRole("button", { name: "Edit" }).click();
    await card.getByLabel("Current password").waitFor();
    await scrollTo(page, card, "center");
    await shot("security-password-form");
    const next = syntheticPassword();
    await card.getByLabel("Current password").fill(password);
    await card.getByLabel("New password", { exact: true }).fill(next);
    await card.getByLabel("Confirm new password").fill(next);
    await card.getByRole("button", { name: "Update password" }).click();
    await drawer.getByText("Password updated.").waitFor();
    password = next;
    await scrollTo(page, drawer.getByText("Password updated."), "center");
    await shot("security-password-updated");
  },
};

module.exports = { "user-access": userAccess, "user-security": userSecurity };
