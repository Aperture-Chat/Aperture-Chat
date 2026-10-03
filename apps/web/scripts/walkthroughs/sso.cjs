/* Single sign-on, performed end to end against a local Keycloak.
 *
 * Inputs: CAPTURE_IDP_URL (the Keycloak origin, e.g. http://sso.localhost:8180)
 * and CAPTURE_IDP_ADMIN_FILE (ignored JSON with a Keycloak master-realm admin
 * "username" and "password"). The isolated instance must have no SSO
 * configuration and its API base URL must equal CAPTURE_APP_URL, so the
 * redirect URI the panel shows is the one the server sends.
 *
 * sso-oidc creates the examplecorp realm, registers the application, adds the
 * groups mapper, groups, and a test person through the Keycloak admin console,
 * then saves and tests the connection in the Platform console and signs the
 * person in through Keycloak. sso-golive maps groups, proves they sync on the
 * next sign-in, turns enforcement on, and records the real messages for a
 * blocked local password and an address outside the allowed domains.
 * sso-providers types each vendor preset into the panel without saving (the
 * identity providers themselves are taught with instruction cards) and saves
 * the Google preset last, because Google's public discovery document lets
 * Test connection genuinely pass. Passwords for synthetic people are random
 * per run and never written to disk.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");

const REALM = "examplecorp";
const CLIENT_ID = "aperture-chat";
const DOMAIN = "examplecorp.test";
const PEOPLE = {
  riley: { username: "riley.chen", email: `riley.chen@${DOMAIN}`, firstName: "Riley", lastName: "Chen", groups: ["litigation"] },
  pat: { username: "pat.kim", email: "pat.kim@contractor.test", firstName: "Pat", lastName: "Kim", groups: [] },
};
const passwords = {};
const password = (key) => (passwords[key] ??= `Synthetic-${crypto.randomBytes(12).toString("base64url")}`);

function idp(kit) {
  const base = kit.env("CAPTURE_IDP_URL").replace(/\/$/, "");
  const admin = JSON.parse(fs.readFileSync(kit.env("CAPTURE_IDP_ADMIN_FILE"), "utf8"));
  async function token() {
    const response = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: admin.username, password: admin.password }),
    });
    if (!response.ok) throw new Error(`Keycloak admin sign-in failed: ${response.status}`);
    return (await response.json()).access_token;
  }
  async function call(method, path, body) {
    const response = await fetch(`${base}/admin/realms${path}`, {
      method,
      headers: { authorization: `Bearer ${await token()}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Keycloak ${method} ${path}: ${response.status} ${await response.text()}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  return {
    base,
    admin,
    issuer: `${base}/realms/${REALM}`,
    consoleUrl: `${base}/admin/master/console/`,
    call,
    async userId(username) {
      const [user] = (await call("GET", `/${REALM}/users?exact=true&username=${encodeURIComponent(username)}`)) ?? [];
      if (!user) throw new Error(`Keycloak has no user ${username}.`);
      return user.id;
    },
    async setPassword(username, value) {
      await call("PUT", `/${REALM}/users/${await this.userId(username)}/reset-password`, { type: "password", value, temporary: false });
    },
  };
}

/* The Keycloak admin console collapses its navigation below 1200 px; open it,
 * choose the section, and close it again so the page is unobstructed. */
async function keycloakSection(page, testId) {
  await page.click("#nav-toggle");
  await page.click(`[data-testid=${testId}]`);
  await page.waitForTimeout(700);
  await page.click("#nav-toggle");
  await page.waitForTimeout(500);
}

async function keycloakConsole(kit, server) {
  const page = await kit.external(server.consoleUrl);
  await page.fill("#username", server.admin.username);
  await page.fill("#password", server.admin.password);
  await page.click("#kc-login");
  await page.locator("#nav-toggle").waitFor();
  await page.waitForTimeout(1200);
  return page;
}

async function dismissKeycloakAlerts(page) {
  for (const close of await page.locator(".pf-v5-c-alert-group button[aria-label^='Close']").all()) await close.click().catch(() => {});
  await page.waitForTimeout(300);
}

async function openSsoPanel(page) {
  const panel = page.locator(".sso-requirements-panel");
  await panel.scrollIntoViewIfNeeded();
  const toggle = panel.locator(".panel-collapse-button");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.waitForTimeout(500);
  return panel;
}

async function scrollTo(page, locator, block = "start") {
  await locator.evaluate((element, where) => element.scrollIntoView({ block: where }), block);
  await page.waitForTimeout(350);
}

async function field(panel, label) {
  return panel.locator(".sso-readiness-grid > label").filter({ hasText: label }).locator("input, select").first();
}

/* Sign a synthetic person in through the identity provider from a fresh,
 * signed-out browser and return the page where the app lands. */
async function ssoSignIn(kit, person, { capture } = {}) {
  const page = await kit.anonymous();
  await page.getByLabel("Email").waitFor();
  await page.getByLabel("Email").fill(person.email);
  await page.waitForTimeout(400);
  if (capture?.signIn) await capture.signIn(page);
  await page.getByRole("button", { name: "Continue with SSO" }).click();
  await page.locator("#kc-form-login, #username").first().waitFor();
  await page.fill("#username", person.username);
  if (capture?.idpLogin) await capture.idpLogin(page);
  await page.fill("#password", password(person.username));
  await page.click("#kc-login");
  await page.waitForURL((url) => url.origin === kit.APP);
  await page.waitForTimeout(2500);
  return page;
}

const ssoOidc = {
  role: "owner",
  description: "Register the app at Keycloak, connect it, and sign the first person in.",
  externalOrigins: () => [new URL(process.env.CAPTURE_IDP_URL || "http://invalid.localhost").origin],
  frames: [
    "owner/sso-panel-open", "owner/sso-redirect-copied",
    "owner/idp-realm-create", "owner/idp-client-general", "owner/idp-client-capability", "owner/idp-client-redirect",
    "owner/idp-client-secret", "owner/idp-group-mapper", "owner/idp-groups", "owner/idp-user-create",
    "owner/sso-form-filled", "owner/sso-access-settings", "owner/sso-actions", "owner/sso-saved-tested",
    "owner/sso-signin-sso", "owner/idp-login", "owner/sso-first-welcome", "owner/sso-jit-user",
  ],
  async run(kit) {
    const { shot } = kit;
    const server = idp(kit);
    if ((await kit.api("owner", "GET", "/api/admin/sso-configs")).length) throw new Error("Start from an instance with no SSO configuration.");
    if (await server.call("GET", `/${REALM}`)) throw new Error(`Delete the ${REALM} realm before capturing.`);

    // 1. Aperture Chat: open the panel and copy the redirect URI first.
    const console = await kit.app("owner", "/platform/org-settings");
    const panel = await openSsoPanel(console);
    await scrollTo(console, panel);
    await shot("sso-panel-open");
    const redirect = panel.locator(".sso-redirect-uri");
    const redirectUri = (await redirect.locator("code").innerText()).trim();
    if (redirectUri !== `${kit.APP}/api/auth/sso/callback`) throw new Error(`Unexpected redirect URI ${redirectUri}`);
    await console.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: kit.APP });
    await scrollTo(console, redirect, "center");
    await redirect.getByRole("button", { name: "Copy redirect URI" }).click();
    await redirect.getByText("Copied").waitFor();
    await shot("sso-redirect-copied");

    // 2. Keycloak: realm, client, secret, groups mapper, groups, test person.
    const keycloak = kit.use(await keycloakConsole(kit, server));
    await keycloakSection(keycloak, "nav-item-realms");
    await keycloak.click("[data-testid=add-realm]");
    await keycloak.fill("#realm", REALM);
    await shot("idp-realm-create");
    await keycloak.click("[data-testid=create]");
    await keycloak.getByText("Realm created successfully").waitFor();
    await dismissKeycloakAlerts(keycloak);
    await keycloak.waitForTimeout(800);
    // The display name is what people see on the realm's sign-in page.
    await server.call("PUT", `/${REALM}`, { displayName: "Example Corporation" });

    await keycloak.goto(`${server.consoleUrl}#/${REALM}/clients`);
    await keycloak.waitForTimeout(1500);
    await keycloak.getByRole("link", { name: "Create client" }).or(keycloak.getByRole("button", { name: "Create client" })).first().click();
    await keycloak.fill("#clientId", CLIENT_ID);
    await keycloak.fill("#name", "Aperture Chat");
    await shot("idp-client-general");
    await keycloak.getByRole("button", { name: "Next" }).click();
    await keycloak.locator("#kc-authentication").check({ force: true });
    await keycloak.locator("#kc-flow-direct").uncheck({ force: true });
    await keycloak.locator("#kc-pkce-required-switch").check({ force: true });
    await keycloak.waitForTimeout(500);
    await shot("idp-client-capability");
    await keycloak.getByRole("button", { name: "Next" }).click();
    await keycloak.fill("[data-testid=redirectUris0]", redirectUri);
    await shot("idp-client-redirect");
    await keycloak.getByRole("button", { name: "Save" }).click();
    await keycloak.getByText("Client created successfully").waitFor();
    await dismissKeycloakAlerts(keycloak);
    await keycloak.getByRole("tab", { name: "Credentials" }).click();
    const secretInput = keycloak.locator("#kc-client-secret");
    await secretInput.waitFor();
    const clientSecret = await secretInput.inputValue();
    if (!clientSecret) throw new Error("Keycloak did not issue a client secret.");
    await shot("idp-client-secret", { maskedExternalSecrets: true });

    await keycloak.getByTestId("clientScopesTab").click();
    await keycloak.getByRole("link", { name: `${CLIENT_ID}-dedicated` }).click();
    await keycloak.getByRole("button", { name: "Configure a new mapper" }).click();
    await keycloak.getByRole("link", { name: "Group Membership" }).or(keycloak.getByText("Group Membership", { exact: true })).first().click();
    await keycloak.fill("#name", "groups");
    await keycloak.fill('[id="config.claim🍺name"]', "groups");
    await keycloak.locator('[id="full.path"]').uncheck({ force: true });
    await keycloak.waitForTimeout(400);
    await shot("idp-group-mapper");
    await keycloak.getByTestId("save").click();
    await keycloak.getByText(/Mapping successfully created|Mapper created successfully/).waitFor();
    await dismissKeycloakAlerts(keycloak);

    await keycloakSection(keycloak, "nav-item-groups");
    for (const name of ["litigation", "finance"]) {
      await keycloak.getByRole("button", { name: "Create group" }).first().click();
      await keycloak.locator("[role=dialog] #name").fill(name);
      await keycloak.getByTestId("createGroup").click();
      await keycloak.getByText("Group created").waitFor();
      await dismissKeycloakAlerts(keycloak);
    }
    await shot("idp-groups");

    await keycloakSection(keycloak, "nav-item-users");
    await keycloak.getByRole("button", { name: /Create new user|Add user/ }).first().click();
    const riley = PEOPLE.riley;
    await keycloak.locator("#emailVerified").check({ force: true });
    await keycloak.fill("#username", riley.username);
    await keycloak.fill("#email", riley.email);
    await keycloak.fill("#firstName", riley.firstName);
    await keycloak.fill("#lastName", riley.lastName);
    await keycloak.getByTestId("join-groups-button").click();
    await keycloak.locator("[role=dialog]").getByRole("checkbox", { name: /litigation/ }).or(
      keycloak.locator("[role=dialog] tr:has-text('litigation') input[type=checkbox]")).first().check({ force: true });
    await keycloak.locator("[role=dialog]").getByRole("button", { name: "Join" }).click();
    await keycloak.waitForTimeout(500);
    await shot("idp-user-create");
    await keycloak.getByTestId("user-creation-save").click();
    await keycloak.getByText("The user has been created").waitFor();
    await server.setPassword(riley.username, password(riley.username));

    // A second person outside the allowed domains, used by sso-golive.
    const pat = PEOPLE.pat;
    await server.call("POST", `/${REALM}/users`, {
      username: pat.username, email: pat.email, firstName: pat.firstName, lastName: pat.lastName,
      enabled: true, emailVerified: true,
    });
    await server.setPassword(pat.username, password(pat.username));

    // 3. Aperture Chat: enter the provider details, save, and test.
    kit.use(console);
    await console.reload();
    await console.getByRole("navigation", { name: "Primary" }).waitFor();
    const form = await openSsoPanel(console);
    await (await field(form, "Provider name")).fill("Keycloak");
    await (await field(form, "Issuer URL")).fill(server.issuer);
    await (await field(form, "Client ID")).fill(CLIENT_ID);
    await scrollTo(console, form.locator(".sso-readiness-grid > label").filter({ hasText: "Provider name" }), "start");
    await shot("sso-form-filled");
    await (await field(form, "Allowed email domains")).fill(DOMAIN);
    await (await field(form, "Group claim")).fill("groups");
    await (await field(form, "MFA methods enforced by provider")).fill("");
    await (await field(form, "Authenticator app")).selectOption("Identity provider");
    await scrollTo(console, form.locator(".sso-readiness-grid > label").filter({ hasText: "Allowed email domains" }), "start");
    await shot("sso-access-settings");
    const actions = form.locator(".sso-action-row");
    await scrollTo(console, actions, "center");
    await shot("sso-actions");
    // The secret is pasted last, so no published frame contains it.
    await (await field(form, "Client secret")).fill(clientSecret);
    await actions.getByRole("button", { name: "Save SSO" }).click();
    await console.getByText(/baseline saved through the admin SSO API/).waitFor();
    await actions.getByRole("button", { name: "Test connection" }).click();
    await form.locator(".sso-test-result").waitFor();
    const result = await form.locator(".sso-test-result").innerText();
    if (!/Discovery document/.test(result) || /failed/i.test(result)) throw new Error(`Test connection did not pass: ${result}`);
    await scrollTo(console, form.locator(".sso-test-result"), "center");
    await shot("sso-saved-tested");

    // 4. Sign the test person in from a fresh browser.
    const landed = await ssoSignIn(kit, riley, {
      capture: {
        signIn: async (page) => { kit.use(page); await shot("sso-signin-sso"); },
        idpLogin: async (page) => { kit.use(page); await shot("idp-login"); },
      },
    });
    kit.use(landed);
    await landed.locator(".first-run-welcome").waitFor();
    await shot("sso-first-welcome");

    // 5. Confirm the account the sign-in created.
    const admin = kit.use(await kit.app("owner", "/admin/users"));
    const row = admin.locator("tr").filter({ hasText: riley.email });
    await row.waitFor();
    if (!/sso/.test(await row.innerText())) throw new Error("The new account is not marked as an SSO sign-in.");
    await scrollTo(admin, row, "center");
    await shot("sso-jit-user");
  },
};

const ssoGolive = {
  role: "owner",
  description: "Map groups, prove they sync, enforce SSO, and record the real refusals.",
  externalOrigins: ssoOidc.externalOrigins,
  frames: [
    "owner/sso-admin-mapping", "owner/sso-groups-synced", "owner/sso-enforce-saved",
    "owner/sso-password-blocked", "owner/sso-domain-rejected",
  ],
  async run(kit) {
    const { shot } = kit;
    idp(kit);
    const [config] = await kit.api("owner", "GET", "/api/admin/sso-configs");
    if (!config || config.issuer_url !== `${process.env.CAPTURE_IDP_URL.replace(/\/$/, "")}/realms/${REALM}`) throw new Error("Run sso-oidc first.");
    if (!passwords[PEOPLE.riley.username]) throw new Error("Run sso-golive in the same invocation as sso-oidc.");

    // A person who already had a local account on the domain before SSO.
    const morganPassword = password("morgan.lee");
    const morgan = await kit.api("owner", "POST", "/api/admin/users", {
      email: `morgan.lee@${DOMAIN}`, display_name: "Morgan Lee", role: "USER", auth_method: "local",
    });
    await kit.api("owner", "POST", `/api/admin/users/${morgan.id}/password`, { password: morganPassword, temporary: false });

    // Map identity-provider groups to workspace groups on the SSO tab.
    const admin = await kit.app("owner", "/admin/sso");
    const card = admin.locator(".settings-card").filter({ hasText: "Keycloak" });
    await card.waitFor();
    for (const [value, group] of [["litigation", "Litigation"], ["finance", "Finance Team"]]) {
      await card.getByRole("button", { name: "Add mapping" }).click();
      const rows = card.locator(".sso-mapping-row");
      const last = rows.nth((await rows.count()) - 1);
      await last.locator("input").fill(value);
      await last.locator("select").selectOption({ label: group });
    }
    await card.getByRole("button", { name: "Save mappings" }).click();
    await admin.getByText("Keycloak group mappings saved.").waitFor();
    await scrollTo(admin, card.locator(".sso-mapping-editor"), "center");
    await shot("sso-admin-mapping");

    // Membership follows the claim at the next sign-in.
    await ssoSignIn(kit, PEOPLE.riley);
    const users = kit.use(await kit.app("owner", "/admin/users"));
    // Filter to the mapped group: the table shows one group chip per row.
    await users.getByLabel("Filter users by group").selectOption({ label: "Litigation" });
    const row = users.locator("tr").filter({ hasText: PEOPLE.riley.email });
    await row.waitFor();
    const groups = await row.locator(".group-chip-list").getAttribute("title");
    if (!/Litigation/.test(groups || "")) throw new Error(`Mapped groups did not sync at sign-in: ${groups}`);
    await scrollTo(users, row, "center");
    await shot("sso-groups-synced");

    // Enforce SSO for the domain in the owner panel.
    const owner = kit.use(await kit.app("owner", "/platform/org-settings"));
    const panel = await openSsoPanel(owner);
    const enforce = panel.locator(".owner-toggle-row").filter({ hasText: "Enforce SSO for these domains" });
    await enforce.getByRole("switch").click();
    await panel.getByRole("button", { name: "Save SSO" }).click();
    await owner.getByText(/baseline saved through the admin SSO API/).waitFor();
    await scrollTo(owner, enforce, "center");
    await shot("sso-enforce-saved");

    // A local password on the enforced domain is refused with a real message.
    const blocked = kit.use(await kit.anonymous());
    await blocked.getByRole("button", { name: /Email & password/ }).click();
    await blocked.getByLabel("Email").fill(`morgan.lee@${DOMAIN}`);
    await blocked.getByLabel("Password", { exact: true }).fill(morganPassword);
    await blocked.getByRole("button", { name: "Sign in" }).click();
    await blocked.getByText(/SSO is enforced for this email domain/).waitFor();
    await blocked.getByLabel("Password", { exact: true }).fill("");
    await shot("sso-password-blocked");

    // An identity-provider account outside the allowed domains is refused.
    const rejected = kit.use(await kit.anonymous());
    await rejected.getByRole("button", { name: "Continue with SSO" }).click();
    await rejected.fill("#username", PEOPLE.pat.username);
    await rejected.fill("#password", password(PEOPLE.pat.username));
    await rejected.click("#kc-login");
    await rejected.waitForURL((url) => url.origin === kit.APP);
    await rejected.getByText(/is outside the domains allowed for this SSO provider/).waitFor();
    await shot("sso-domain-rejected");
  },
};

const PRESETS = {
  entra: { chip: "Microsoft Entra ID", issuer: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0", clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  okta: { chip: "Okta", issuer: "https://your-org.okta.com/oauth2/default", clientId: "0oaEXAMPLEclientid123" },
};

async function fillPreset(page, preset) {
  await page.reload();
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
  const panel = await openSsoPanel(page);
  await panel.getByRole("button", { name: preset.chip, exact: true }).click();
  await (await field(panel, "Issuer URL")).fill(preset.issuer);
  await (await field(panel, "Client ID")).fill(preset.clientId);
  await scrollTo(page, panel.locator(".sso-issuer-presets"), "center");
}

const ssoProviders = {
  role: "owner",
  description: "Show each vendor preset filled in, and genuinely test Google's public issuer.",
  externalOrigins: () => [],
  frames: ["owner/sso-preset-entra", "owner/sso-preset-okta", "owner/sso-preset-google", "owner/sso-google-tested"],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("owner", "/platform/org-settings");
    await fillPreset(page, PRESETS.entra);
    await shot("sso-preset-entra");
    await fillPreset(page, PRESETS.okta);
    await shot("sso-preset-okta");
    // Google's issuer is public, so this configuration is saved and tested for
    // real; it replaces the Keycloak baseline, so it runs after every other module.
    await page.reload();
    await page.getByRole("navigation", { name: "Primary" }).waitFor();
    const panel = await openSsoPanel(page);
    await panel.getByRole("button", { name: "Google Workspace", exact: true }).click();
    await (await field(panel, "Client ID")).fill("000000000000-examplecorp.apps.googleusercontent.com");
    // The Google lesson keeps enforcement off until a real sign-in works.
    const enforce = panel.locator(".owner-toggle-row").filter({ hasText: "Enforce SSO for these domains" }).getByRole("switch");
    if ((await enforce.getAttribute("aria-checked")) === "true") await enforce.click();
    await scrollTo(page, panel.locator(".sso-issuer-presets"), "center");
    await shot("sso-preset-google");
    await (await field(panel, "Client secret")).fill(`synthetic-${crypto.randomBytes(9).toString("hex")}`);
    await (await field(panel, "Allowed email domains")).fill(DOMAIN);
    await panel.getByRole("button", { name: "Save SSO" }).click();
    await page.getByText(/baseline saved through the admin SSO API/).waitFor();
    await panel.getByRole("button", { name: "Test connection" }).click();
    await panel.locator(".sso-test-result").waitFor();
    const result = await panel.locator(".sso-test-result").innerText();
    if (!/accounts\.google\.com/.test(result) || /failed/i.test(result)) throw new Error(`Google discovery did not pass: ${result}`);
    await scrollTo(page, panel.locator(".sso-test-result"), "center");
    await shot("sso-google-tested");
  },
};

module.exports = { "sso-oidc": ssoOidc, "sso-golive": ssoGolive, "sso-providers": ssoProviders };
