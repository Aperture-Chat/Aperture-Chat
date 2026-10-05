/* Tenant SSO from the Admin console, performed end to end against a local
 * Keycloak realm that belongs to this capture (never the owner's examplecorp
 * realm).
 *
 * Inputs: CAPTURE_IDP_URL and CAPTURE_IDP_ADMIN_FILE (see sso.cjs). The
 * instance must start with no SSO configuration, with "Tenant admins can
 * manage SSO mappings" off, and its API base URL must equal CAPTURE_APP_URL.
 *
 * admin-sso records the read-only tab, then (with SSO management allowed by
 * service policy as setup) the Policies status row, every provider preset, then creates a Custom OIDC
 * configuration, tests it, signs a test person in, maps and syncs groups,
 * enforces SSO and records the real refusal, and finally records the
 * read-only card once service policy stops allowing SSO management. admin-access-sso (same invocation)
 * approves an access request for a person who then signs in through SSO.
 * The realm is created through Keycloak's admin API: the identity-provider
 * steps are taught with an instruction card and the lesson's written paths.
 * Passwords for synthetic people are random per run and never written down.
 */
const crypto = require("node:crypto");
const { helpers } = require("./admin-shared.cjs");

const { removeUsers, scrollTo, toast, dismissToast, openTab, expandPanel, keycloak, ssoSignIn } = helpers;
const REALM = "examplecorp-admin";
const CLIENT_ID = "aperture-chat";
const DOMAIN = "examplecorp.test";
const PROVIDER = "Keycloak";
const PEOPLE = {
  sam: { username: "sam.rivera", email: `sam.rivera@${DOMAIN}`, firstName: "Sam", lastName: "Rivera", groups: ["litigation"] },
  jordan: { username: "jordan.ellis", email: `jordan.ellis@${DOMAIN}`, firstName: "Jordan", lastName: "Ellis", groups: [] },
};
const passwords = {};
const password = (key) => (passwords[key] ??= `Synthetic-${crypto.randomBytes(12).toString("base64url")}`);
const idpOrigins = () => [new URL(process.env.CAPTURE_IDP_URL || "http://invalid.localhost").origin];

async function ssoTab(kit) {
  const page = await kit.app("admin", "/admin/users");
  await openTab(page, "SSO");
  await page.locator(".panel").filter({ hasText: "SSO and Provisioning" }).first().waitFor();
  return page;
}

async function choosePreset(page, label) {
  await page.getByLabel("Identity provider preset").selectOption({ label });
  await page.waitForTimeout(400);
}

const adminSso = {
  role: "admin",
  description: "Check policy, create, test, sign in, map groups, enforce, and see the read-only state on the SSO tab.",
  externalOrigins: idpOrigins,
  frames: [
    "admin/sso-readonly-empty", "admin/sso-policy-available", "admin/sso-add-entra", "admin/sso-add-okta",
    "admin/sso-add-google", "admin/sso-add-custom", "admin/sso-created", "admin/sso-tested",
    "admin/sso-signin", "admin/sso-idp-login", "admin/sso-first-welcome", "admin/sso-jit-user",
    "admin/sso-mappings-saved", "admin/sso-groups-synced", "admin/sso-enforced", "admin/sso-password-refused",
    "admin/sso-readonly-card",
  ],
  async run(kit) {
    const { shot } = kit;
    // Setup: undo an earlier run (owner-side cleanup, never captured).
    for (const config of await kit.api("owner", "GET", "/api/admin/sso-configs")) {
      await kit.api("owner", "DELETE", `/api/admin/sso-configs/${config.id}`);
    }
    await kit.api("owner", "PATCH", "/api/platform/settings", { tenant_admins_can_manage_sso: false });
    await removeUsers(kit, [PEOPLE.sam.email, PEOPLE.jordan.email, `morgan.blake@${DOMAIN}`]);

    // 1. Without delegation the tab is read-only.
    let admin = await ssoTab(kit);
    await admin.getByText("Organization policy makes SSO configuration read-only in this console.").waitFor();
    await shot("sso-readonly-empty");

    // 2. Setup: service policy allows tenant admins to manage SSO (the
    //    platform owner's switch, set through the API; the admin library never
    //    shows the Platform console). The admin confirms it on Policies.
    await kit.api("owner", "PATCH", "/api/platform/settings", { tenant_admins_can_manage_sso: true });
    await admin.reload();
    await admin.getByRole("tablist", { name: "Admin sections" }).waitFor();
    await openTab(admin, "Policies");
    const controls = await expandPanel(admin, "Policy Controls");
    const ssoRow = controls.locator(".policy-toggle-row").filter({ hasText: "SSO configuration" });
    await ssoRow.getByText("Available", { exact: true }).waitFor();
    await scrollTo(admin, ssoRow, "center");
    await shot("sso-policy-available");

    // 3. The identity provider (setup; taught with a card and written paths).
    const server = keycloak(kit, REALM);
    const redirectUri = `${kit.APP}/api/auth/sso/callback`;
    const clientSecret = await server.createRealm({ displayName: "Example Corporation", clientId: CLIENT_ID, redirectUri, groups: ["litigation", "finance"] });
    for (const person of Object.values(PEOPLE)) await server.addPerson(person, password(person.username));

    // 4. Admin console: the presets, then a Custom OIDC configuration.
    admin = kit.use(await ssoTab(kit));
    await admin.getByRole("button", { name: "Add SSO configuration" }).click();
    const form = admin.locator(".sso-create-form");
    await form.waitFor();
    await scrollTo(admin, form, "center");
    await shot("sso-add-entra");
    await choosePreset(admin, "Okta");
    await shot("sso-add-okta");
    await choosePreset(admin, "Google Workspace");
    await shot("sso-add-google");
    await choosePreset(admin, "Custom OIDC provider");
    await form.getByLabel("SSO display name").fill(PROVIDER);
    await form.getByLabel("Issuer URL").fill(server.issuer);
    await form.getByLabel("Client ID").fill(CLIENT_ID);
    await form.getByLabel("Allowed email domains").fill(DOMAIN);
    const shownRedirect = (await form.locator(".sso-redirect-hint code").innerText()).trim();
    if (shownRedirect !== redirectUri) throw new Error(`The form shows redirect URI ${shownRedirect}`);
    await scrollTo(admin, form, "center");
    await shot("sso-add-custom");
    // The secret is pasted last, so no published frame contains it.
    await form.getByLabel("Client secret").fill(clientSecret);
    await form.getByRole("button", { name: "Create SSO configuration" }).click();
    await toast(admin, `${PROVIDER} SSO configuration created. Test the connection before enforcing it.`);
    // The card is found by its issuer: the name typed above is not kept by
    // the server today (reported), so the card shows a provider-type label.
    const card = admin.locator(".settings-card").filter({ hasText: server.issuer });
    await card.waitFor();
    const cardName = (await card.locator("header strong").innerText()).trim();
    await scrollTo(admin, card, "start");
    await shot("sso-created");

    // 5. Test connection: discovery, signing keys, and sign-in readiness.
    await card.getByRole("button", { name: "Test connection" }).click();
    const result = card.locator(".sso-test-result");
    await result.waitFor({ timeout: 30000 });
    const text = await result.innerText();
    if (!/Sign-in is ready/.test(text) || /failed|incomplete/i.test(text)) throw new Error(`Test connection did not pass: ${text}`);
    await toast(admin, `${cardName} connection test passed.`);
    await scrollTo(admin, result, "center");
    await shot("sso-tested");

    // 6. A test person signs in from a fresh browser; JIT creates the account.
    const landed = await ssoSignIn(kit, PEOPLE.sam, password("sam.rivera"), {
      beforeContinue: async (page) => { kit.use(page); await shot("sso-signin"); },
      atProvider: async (page) => { kit.use(page); await shot("sso-idp-login"); },
    });
    kit.use(landed);
    await landed.locator(".first-run-welcome").waitFor();
    await shot("sso-first-welcome");

    const users = kit.use(await kit.app("admin", "/admin/users"));
    const samRow = users.locator("tr").filter({ hasText: PEOPLE.sam.email });
    await samRow.waitFor();
    if (!/\bsso\b/.test(await samRow.innerText())) throw new Error("The new account is not marked as an SSO sign-in.");
    await scrollTo(users, samRow, "center");
    await shot("sso-jit-user");

    // 7. Map identity-provider groups to tenant groups.
    admin = kit.use(await ssoTab(kit));
    const mapped = admin.locator(".settings-card").filter({ hasText: server.issuer });
    for (const [value, group] of [["litigation", "Litigation"], ["finance", "Finance Team"]]) {
      await mapped.getByRole("button", { name: "Add mapping" }).click();
      const rows = mapped.locator(".sso-mapping-row");
      const last = rows.nth((await rows.count()) - 1);
      await last.locator("input").fill(value);
      await last.locator("select").selectOption({ label: group });
    }
    await mapped.getByRole("button", { name: "Save mappings" }).click();
    await toast(admin, `${cardName} group mappings saved.`);
    await scrollTo(admin, mapped.locator(".sso-mapping-editor"), "center");
    await shot("sso-mappings-saved");

    // 8. Membership follows the claim at the next sign-in.
    await ssoSignIn(kit, PEOPLE.sam, password("sam.rivera"));
    const synced = kit.use(await kit.app("admin", "/admin/users"));
    await synced.getByLabel("Filter users by group").selectOption({ label: "Litigation" });
    const syncedRow = synced.locator("tr").filter({ hasText: PEOPLE.sam.email });
    await syncedRow.waitFor();
    const groups = await syncedRow.locator(".group-chip-list").getAttribute("title");
    if (!/Litigation/.test(groups || "")) throw new Error(`Mapped groups did not sync at sign-in: ${groups}`);
    await scrollTo(synced, syncedRow, "center");
    await shot("sso-groups-synced");

    // 9. Enforce SSO for the domain, then a local password there is refused.
    const localPassword = password("morgan.blake");
    const morgan = await kit.api("admin", "POST", "/api/admin/users", {
      email: `morgan.blake@${DOMAIN}`, display_name: "Morgan Blake", role: "USER",
    });
    await kit.api("admin", "POST", `/api/admin/users/${morgan.id}/password`, { password: localPassword, temporary: false });
    admin = kit.use(await ssoTab(kit));
    const enforceCard = admin.locator(".settings-card").filter({ hasText: server.issuer });
    await enforceCard.getByRole("switch", { name: `Enforce ${cardName}` }).click();
    await toast(admin, `${cardName} SSO enforcement synced with the admin API.`);
    const enforceRow = enforceCard.locator(".permission-row").filter({ hasText: "Enforce for tenant sign-in" });
    await scrollTo(admin, enforceRow, "center");
    await shot("sso-enforced");

    const blocked = kit.use(await kit.anonymous());
    await blocked.getByRole("button", { name: /Email & password/ }).click();
    await blocked.getByLabel("Email").fill(`morgan.blake@${DOMAIN}`);
    await blocked.getByLabel("Password", { exact: true }).fill(localPassword);
    await blocked.getByRole("button", { name: "Sign in" }).click();
    await blocked.getByText(/SSO is enforced for this email domain/).waitFor();
    await blocked.getByLabel("Password", { exact: true }).fill("");
    await shot("sso-password-refused");

    // 10. Setup: service policy stops allowing SSO management; the card is read-only.
    await kit.api("owner", "PATCH", "/api/platform/settings", { tenant_admins_can_manage_sso: false });
    admin = kit.use(await ssoTab(kit));
    const readonly = admin.locator(".settings-card").filter({ hasText: server.issuer });
    await readonly.waitFor();
    if (await readonly.getByRole("button", { name: "Test connection" }).count()) throw new Error("The card is still editable.");
    await dismissToast(admin);
    await shot("sso-readonly-card");
  },
};

const adminAccessSso = {
  role: "admin",
  description: "Approve an access request for a person who signs in through organization SSO.",
  externalOrigins: idpOrigins,
  frames: ["admin/access-sso-approved", "admin/access-sso-signin", "admin/access-sso-welcome", "admin/access-sso-row"],
  async run(kit) {
    const { shot } = kit;
    if (!passwords["jordan.ellis"]) throw new Error("Run admin-access-sso in the same invocation as admin-sso.");
    const person = PEOPLE.jordan;

    // The person asks to join from the public sign-in page.
    const visitor = await kit.anonymous();
    await visitor.getByRole("button", { name: /Request access/ }).first().click();
    await visitor.getByLabel("First name").fill(person.firstName);
    await visitor.getByLabel("Last name").fill(person.lastName);
    await visitor.getByLabel("Work email").fill(person.email);
    await visitor.getByRole("button", { name: "Submit access request" }).click();
    await visitor.getByText("Request received").waitFor();

    // Approve as User, then choose Done: no password is set for SSO people.
    const users = kit.use(await kit.app("admin", "/admin/users"));
    const request = users.locator(".access-request-card").filter({ hasText: person.email });
    await request.waitFor();
    await request.getByRole("button", { name: "Approve" }).click();
    await toast(users, `${person.firstName} ${person.lastName} was approved as User.`);
    const handoff = users.locator(".access-handoff");
    await handoff.waitFor();
    await scrollTo(users, handoff, "center");
    await shot("access-sso-approved");
    await handoff.getByRole("button", { name: "Done" }).click();

    // The person signs in through the identity provider.
    const landed = await ssoSignIn(kit, person, password(person.username), {
      beforeContinue: async (page) => { kit.use(page); await shot("access-sso-signin"); },
    });
    kit.use(landed);
    await landed.locator(".first-run-welcome").waitFor();
    await shot("access-sso-welcome");

    const after = kit.use(await kit.app("admin", "/admin/users"));
    const row = after.locator("tr").filter({ hasText: person.email });
    await row.waitFor();
    if (!/Active/.test(await row.innerText())) throw new Error("The approved SSO account is not active.");
    await scrollTo(after, row, "center");
    await shot("access-sso-row");
  },
};

module.exports = { "admin-sso": adminSso, "admin-access-sso": adminAccessSso };
