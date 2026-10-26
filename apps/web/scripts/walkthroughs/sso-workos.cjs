/* Single sign-on with WorkOS, performed end to end against the official WorkOS
 * API emulator (the `@workos/emulate` package that `workos emulate` runs).
 *
 * Inputs: CAPTURE_WORKOS_URL (the emulator origin, e.g. http://localhost:4110)
 * and CAPTURE_WORKOS_API_KEY_FILE (ignored, privately readable file holding the
 * emulator's synthetic API key). Start the emulator with only that key seeded,
 * interactive sign-in pages, and *.localhost allowed as a redirect host, and
 * start the isolated API with APERTURE_WORKOS_API_BASE_URL set to the same
 * origin. The instance must have no SSO configuration.
 *
 * sso-workos creates the WorkOS side through the WorkOS API (a litigation
 * role, the Example Corporation organization with its verified domain, and a
 * member), then, in the Platform console, chooses WorkOS AuthKit, copies the
 * redirect URI, enters the client ID, organization, and domains, pastes the API
 * key last, saves, and tests. A synthetic person then signs in from a fresh
 * browser through the emulator's hosted page (not captured: lessons teach the
 * real AuthKit page with an instruction card), and the WorkOS role is mapped to
 * a workspace group and proven to sync at the next sign-in.
 */
const fs = require("node:fs");

const CLIENT_ID = "client_01JEXAMPLECORPSSO4K8P";
const DOMAIN = "examplecorp.test";
const PERSON = { email: `avery.brooks@${DOMAIN}`, first_name: "Avery", last_name: "Brooks" };
const ROLE = { slug: "litigation", name: "Litigation" };

function workos(kit) {
  const base = kit.env("CAPTURE_WORKOS_URL").replace(/\/$/, "");
  const apiKey = fs.readFileSync(kit.env("CAPTURE_WORKOS_API_KEY_FILE"), "utf8").trim();
  async function call(method, path, body) {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`WorkOS ${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  return { base, apiKey, call };
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

const label = (panel, text) => panel.locator(".sso-readiness-grid > label").filter({ hasText: text });
const field = (panel, text) => label(panel, text).locator("input, select").first();

/* Sign the person in from a fresh, signed-out browser through the emulator's
 * hosted page and return the page where the app lands. */
async function workosSignIn(kit, server, { onSignIn } = {}) {
  const page = await kit.anonymous();
  await page.getByLabel("Email").waitFor();
  await page.getByLabel("Email").fill(PERSON.email);
  await page.getByText("Sign in with WorkOS").waitFor();
  await page.waitForTimeout(400);
  if (onSignIn) await onSignIn(page);
  await page.getByRole("button", { name: "Continue with SSO" }).click();
  await page.waitForURL((url) => url.origin === server.base);
  // The typed email arrives as AuthKit's login hint.
  const hinted = await page.locator("input[type=email], input[name=email]").first().inputValue();
  if (hinted !== PERSON.email) throw new Error(`The login hint did not reach WorkOS (${hinted}).`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.origin === kit.APP);
  await page.waitForTimeout(2500);
  return page;
}

const ssoWorkos = {
  role: "owner",
  description: "Connect WorkOS AuthKit with your own keys, test it, and sign the first person in.",
  externalOrigins: () => [new URL(process.env.CAPTURE_WORKOS_URL || "http://invalid.localhost").origin],
  frames: [
    "owner/workos-protocol", "owner/workos-redirect-copied", "owner/workos-form-filled", "owner/workos-access",
    "owner/workos-tested", "owner/workos-initiate-uri", "owner/workos-signin", "owner/workos-welcome",
    "owner/workos-jit-user", "owner/workos-role-mapping", "owner/workos-role-synced",
  ],
  async run(kit) {
    const { shot } = kit;
    const server = workos(kit);
    if ((await kit.api("owner", "GET", "/api/admin/sso-configs")).length) throw new Error("Start from an instance with no SSO configuration.");
    if ((await server.call("GET", "/organizations?limit=1")).data.length) throw new Error("Start from an emulator with no organizations.");

    // 1. WorkOS: the role, organization, and person, through the WorkOS API.
    await server.call("POST", "/authorization/roles", { slug: ROLE.slug, name: ROLE.name });
    const organization = await server.call("POST", "/organizations", {
      name: "Example Corporation",
      domain_data: [{ domain: DOMAIN, state: "verified" }],
    });
    const person = await server.call("POST", "/user_management/users", { ...PERSON, email_verified: true });
    await server.call("POST", "/user_management/organization_memberships", {
      user_id: person.id, organization_id: organization.id, role_slug: ROLE.slug,
    });

    // 2. Aperture Chat: choose WorkOS AuthKit and copy the redirect URI.
    const console = await kit.app("owner", "/platform/org-settings");
    const panel = await openSsoPanel(console);
    await (await field(panel, "Protocol")).selectOption("WORKOS");
    await scrollTo(console, panel);
    await shot("workos-protocol");
    const redirect = panel.locator(".sso-redirect-uri").first();
    const redirectUri = (await redirect.locator("code").innerText()).trim();
    if (redirectUri !== `${kit.APP}/api/auth/sso/callback`) throw new Error(`Unexpected redirect URI ${redirectUri}`);
    await console.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: kit.APP });
    await scrollTo(console, redirect, "center");
    await redirect.getByRole("button", { name: "Copy redirect URI" }).click();
    await redirect.getByText("Copied").waitFor();
    await shot("workos-redirect-copied");

    // 3. Enter the WorkOS details. The API key is pasted last, so no
    // published frame contains it.
    await (await field(panel, "WorkOS client ID")).fill(CLIENT_ID);
    await (await field(panel, "WorkOS organization ID")).fill(organization.id);
    await scrollTo(console, label(panel, "Provider name"));
    await shot("workos-form-filled");
    await (await field(panel, "Allowed email domains")).fill(DOMAIN);
    if ((await (await field(panel, "Group claim")).inputValue()) !== "roles") throw new Error("WorkOS did not default the group claim to roles.");
    await scrollTo(console, label(panel, "Allowed email domains"));
    await shot("workos-access");
    await (await field(panel, "WorkOS API key")).fill(server.apiKey);
    const actions = panel.locator(".sso-action-row");
    await actions.getByRole("button", { name: "Save SSO" }).click();
    await console.getByText(/baseline saved through the admin SSO API/).waitFor();
    await actions.getByRole("button", { name: "Test connection" }).click();
    await panel.locator(".sso-test-result").waitFor();
    const result = await panel.locator(".sso-test-result").innerText();
    if (!/WorkOS verified/.test(result) || /failed/i.test(result)) throw new Error(`Test connection did not pass: ${result}`);
    await scrollTo(console, panel.locator(".sso-test-result"), "center");
    await shot("workos-tested");
    // The key is saved; clear the field before showing the top of the form.
    await (await field(panel, "WorkOS API key")).fill("");
    const initiate = panel.locator(".sso-redirect-uri").filter({ hasText: "Initiate login URI" });
    await initiate.waitFor();
    await scrollTo(console, initiate, "center");
    await shot("workos-initiate-uri");

    // 4. The person signs in from a fresh browser.
    const landed = await workosSignIn(kit, server, {
      onSignIn: async (page) => { kit.use(page); await shot("workos-signin"); },
    });
    kit.use(landed);
    await landed.locator(".first-run-welcome").waitFor();
    await shot("workos-welcome");

    // 5. The account the sign-in created.
    const users = kit.use(await kit.app("owner", "/admin/users"));
    const row = users.locator("tr").filter({ hasText: PERSON.email });
    await row.waitFor();
    if (!/sso/.test(await row.innerText())) throw new Error("The new account is not marked as an SSO sign-in.");
    await scrollTo(users, row, "center");
    await shot("workos-jit-user");

    // 6. Map the WorkOS role to a workspace group, then prove it syncs.
    const admin = kit.use(await kit.app("owner", "/admin/sso"));
    const card = admin.locator(".settings-card").filter({ hasText: "WorkOS AuthKit" });
    await card.waitFor();
    await card.getByRole("button", { name: "Add mapping" }).click();
    const mapping = card.locator(".sso-mapping-row").last();
    await mapping.locator("input").fill(ROLE.slug);
    await mapping.locator("select").selectOption({ label: "Litigation" });
    await card.getByRole("button", { name: "Save mappings" }).click();
    await admin.getByText("WorkOS group mappings saved.").waitFor();
    await scrollTo(admin, card.locator(".sso-mapping-editor"), "center");
    await shot("workos-role-mapping");

    await workosSignIn(kit, server);
    const synced = kit.use(await kit.app("owner", "/admin/users"));
    await synced.getByLabel("Filter users by group").selectOption({ label: "Litigation" });
    const member = synced.locator("tr").filter({ hasText: PERSON.email });
    await member.waitFor();
    const groups = await member.locator(".group-chip-list").getAttribute("title");
    if (!/Litigation/.test(groups || "")) throw new Error(`The WorkOS role did not sync at sign-in: ${groups}`);
    await scrollTo(synced, member, "center");
    await shot("workos-role-synced");
  },
};

module.exports = { "sso-workos": ssoWorkos };
