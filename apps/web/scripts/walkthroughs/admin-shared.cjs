/* Helpers shared by the admin-*.cjs walkthrough modules. index.cjs registers
 * every enumerable export of a file in this directory as a capture module, so
 * this file exports nothing enumerable and exposes its helpers on a hidden
 * `helpers` property instead. */
const fs = require("node:fs");

/** Scroll an element to a block position and let layout settle. */
async function scrollTo(page, locator, block = "start") {
  await locator.evaluate((element, where) => element.scrollIntoView({ block: where }), block);
  await page.waitForTimeout(350);
}

/** The admin console reports every mutation in one status toast at the top. */
async function toast(page, text) {
  const status = page.locator(".action-status-toast").filter({ hasText: text });
  try {
    await status.waitFor({ timeout: 30000 });
  } catch {
    const shown = await page.locator(".action-status-toast").allInnerTexts().catch(() => []);
    throw new Error(`Expected the status "${text}", saw: ${shown.join(" | ") || "no status"}`);
  }
  return status;
}

async function dismissToast(page) {
  const close = page.locator(".action-status-toast .action-status-close");
  if (await close.count()) await close.first().click().catch(() => {});
  await page.waitForTimeout(250);
}

/** Open an admin console tab from the tab row, the way a person would. */
async function openTab(page, name) {
  await page.getByRole("tablist", { name: "Admin sections" }).getByRole("tab", { name, exact: true }).click();
  await page.waitForTimeout(700);
}

/** Expand a collapsed console panel by its heading. */
async function expandPanel(page, title) {
  const panel = page.locator(".panel").filter({ has: page.locator(`.panel-header h2:text-is(${JSON.stringify(title)})`) }).first();
  await panel.waitFor();
  const toggle = panel.locator(".panel-header .panel-collapse-button").first();
  if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
    await page.waitForTimeout(600);
  }
  return panel;
}

/* A realm on the shared local Keycloak, configured through its admin REST API.
 * The admin lessons teach the identity-provider side with instruction cards and
 * point to the owner SSO lessons, which perform those steps in the Keycloak
 * console on camera; here the realm is setup, never a captured claim. */
function keycloak(kit, realm) {
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
  const server = {
    base,
    realm,
    issuer: `${base}/realms/${realm}`,
    call,
    async userId(username) {
      const [user] = (await call("GET", `/${realm}/users?exact=true&username=${encodeURIComponent(username)}`)) ?? [];
      if (!user) throw new Error(`Keycloak has no user ${username}.`);
      return user.id;
    },
    async setPassword(username, value) {
      await call("PUT", `/${realm}/users/${await server.userId(username)}/reset-password`, { type: "password", value, temporary: false });
    },
    async groupId(name) {
      const groups = (await call("GET", `/${realm}/groups?search=${encodeURIComponent(name)}`)) ?? [];
      const group = groups.find((item) => item.name === name);
      if (!group) throw new Error(`Keycloak has no group ${name}.`);
      return group.id;
    },
    async joinGroup(username, name) {
      await call("PUT", `/${realm}/users/${await server.userId(username)}/groups/${await server.groupId(name)}`);
    },
    async addPerson(person, passwordValue) {
      await call("POST", `/${realm}/users`, {
        username: person.username, email: person.email, firstName: person.firstName, lastName: person.lastName,
        enabled: true, emailVerified: true,
      });
      for (const group of person.groups ?? []) await server.joinGroup(person.username, group);
      await server.setPassword(person.username, passwordValue);
    },
    /** A confidential OIDC client with PKCE S256 and a groups claim in the ID token. */
    async createRealm({ displayName, clientId, redirectUri, groups }) {
      if (await call("GET", `/${realm}`)) await call("DELETE", `/${realm}`);
      await call("POST", "", { realm, enabled: true, displayName });
      await call("POST", `/${realm}/clients`, {
        clientId, name: "Aperture Chat", protocol: "openid-connect", publicClient: false,
        standardFlowEnabled: true, directAccessGrantsEnabled: false, redirectUris: [redirectUri],
        attributes: { "pkce.code.challenge.method": "S256" },
        protocolMappers: [{
          name: "groups", protocol: "openid-connect", protocolMapper: "oidc-group-membership-mapper",
          config: { "claim.name": "groups", "full.path": "false", "id.token.claim": "true", "access.token.claim": "true", "userinfo.token.claim": "true" },
        }],
      });
      const [client] = await call("GET", `/${realm}/clients?clientId=${encodeURIComponent(clientId)}`);
      const secret = (await call("GET", `/${realm}/clients/${client.id}/client-secret`)).value;
      if (!secret) throw new Error("Keycloak did not issue a client secret.");
      for (const name of groups) await call("POST", `/${realm}/groups`, { name });
      return secret;
    },
  };
  return server;
}

/* Sign a synthetic person in through the identity provider from a fresh,
 * signed-out browser and return the page where the app lands. */
async function ssoSignIn(kit, person, passwordValue, { beforeContinue, atProvider } = {}) {
  const page = await kit.anonymous();
  await page.getByLabel("Email").waitFor();
  await page.getByLabel("Email").fill(person.email);
  await page.waitForTimeout(400);
  if (beforeContinue) await beforeContinue(page);
  await page.getByRole("button", { name: "Continue with SSO" }).click();
  await page.locator("#kc-form-login").waitFor();
  await page.fill("#username", person.username);
  if (atProvider) await atProvider(page);
  await page.fill("#password", passwordValue);
  await page.click("#kc-login");
  await page.waitForURL((url) => url.origin === kit.APP);
  await page.waitForTimeout(2500);
  return page;
}

/* The shared fixture carries four approved "Morgan Example" accounts left by
 * an earlier access-request capture. They are synthetic but crowd every Users
 * frame, so each module that shows the Users table removes them first. */
async function tidyFixture(kit) {
  const users = await kit.api("admin", "GET", "/api/admin/users");
  for (const user of users) {
    if (user.id.startsWith("user-request-") && user.display_name === "Morgan Example") {
      await kit.api("admin", "DELETE", `/api/admin/users/${user.id}`);
    }
  }
}

/** Remove what an earlier run of a module created, so a module can rerun
 * without restoring the whole instance. Setup only; never captured. */
async function removeUsers(kit, emails) {
  const users = await kit.api("admin", "GET", "/api/admin/users");
  for (const user of users) if (emails.includes(user.email)) await kit.api("admin", "DELETE", `/api/admin/users/${user.id}`);
}

async function removeGroups(kit, names) {
  const groups = await kit.api("admin", "GET", "/api/admin/groups");
  for (const group of groups) if (names.includes(group.name)) await kit.api("admin", "DELETE", `/api/admin/groups/${group.id}`);
}

module.exports = {};
Object.defineProperty(module.exports, "helpers", {
  enumerable: false,
  value: { tidyFixture, removeUsers, removeGroups, scrollTo, toast, dismissToast, openTab, expandPanel, keycloak, ssoSignIn },
});
