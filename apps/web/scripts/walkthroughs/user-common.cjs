/* Shared helpers for the user walkthrough modules (user-*.cjs).
 *
 * This file registers no walkthrough: index.cjs reads enumerable exports only,
 * and the helpers below are attached as a non-enumerable property so the
 * registry ignores them. Nothing here fabricates a state; the helpers drive
 * the real UI, wait for real server results, or perform setup that a frame
 * never claims the user's own UI produced (an administrator's approval, an
 * identity-provider realm, a synthetic person's authenticator).
 */
const crypto = require("node:crypto");
const fs = require("node:fs");

async function scrollTo(page, locator, block = "center") {
  await locator.first().evaluate((element, where) => element.scrollIntoView({ block: where }), block);
  await page.waitForTimeout(350);
}

/** Scroll an element to the top of its scrolling container, leaving `offset`
 * pixels above it so a sticky header does not cover it. */
async function scrollBelowHeader(page, locator, offset = 90) {
  await locator.first().evaluate((element, gap) => {
    element.scrollIntoView({ block: "start" });
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
        node.scrollTop -= gap;
        return;
      }
    }
    window.scrollBy(0, -gap);
  }, offset);
  await page.waitForTimeout(350);
}

/** Dismiss transient status toasts so they never cover the subject of a frame. */
async function dismissToasts(page) {
  for (const close of await page.locator(".toast button[aria-label^='Dismiss'], .toast-close, [role=status] button[aria-label^='Close']").all()) {
    await close.click().catch(() => {});
  }
  await page.waitForTimeout(200);
}

const composer = (page) => page.locator('form.composer textarea[aria-label="Message"]');

/** Type into the chat composer and send with the real send button. */
async function sendChat(page, text) {
  const before = await page.locator("article.assistant-message").count();
  await composer(page).fill(text);
  await page.locator("form.composer .send-button").click();
  return before;
}

/** Wait until the reply that follows `before` assistant messages is complete. */
async function waitForReply(page, before, { timeout = 240000 } = {}) {
  const reply = page.locator("article.assistant-message").nth(before);
  await reply.locator(".message-quick-actions").waitFor({ timeout });
  await page.waitForTimeout(800);
  return reply;
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for a synthetic person's authenticator. */
function totp(secret, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = crypto.createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, "0");
}

/** A fresh TOTP code that will not roll over in the next few seconds. A code
 * is accepted once, so a second proof waits for the next 30-second window. */
const usedCodes = new Set();
async function freshTotp(secret, page) {
  for (;;) {
    const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
    const code = totp(secret);
    if (remaining >= 6 && !usedCodes.has(`${secret}:${code}`)) {
      usedCodes.add(`${secret}:${code}`);
      return code;
    }
    await page.waitForTimeout(remaining * 1000 + 500);
  }
}

const syntheticPassword = () => `Synthetic-${crypto.randomBytes(12).toString("base64url")}`;

/* Unauthenticated JSON call against the instance (sign-in, MFA verification). */
async function publicApi(kit, method, pathname, body, headers = {}) {
  const response = await fetch(kit.API + pathname, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** The user workstream's own Keycloak realm. The shared examplecorp realm is
 * never touched. Inputs: CAPTURE_IDP_URL and CAPTURE_IDP_ADMIN_FILE. */
function userRealm(kit, realm = "examplecorp-user") {
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
    realm,
    issuer: `${base}/realms/${realm}`,
    call,
    /** Recreate the realm with one confidential client; returns its secret. */
    async recreate({ redirectUri, displayName }) {
      if (realm === "examplecorp") throw new Error("Never modify the shared examplecorp realm.");
      if (await call("GET", `/${realm}`)) await call("DELETE", `/${realm}`);
      await call("POST", "", { realm, enabled: true, displayName });
      await call("POST", `/${realm}/clients`, {
        clientId: "aperture-chat", name: "Aperture Chat", protocol: "openid-connect", enabled: true,
        publicClient: false, standardFlowEnabled: true, directAccessGrantsEnabled: false,
        redirectUris: [redirectUri], attributes: { "pkce.code.challenge.method": "S256" },
      });
      const [client] = await call("GET", `/${realm}/clients?clientId=aperture-chat`);
      return (await call("GET", `/${realm}/clients/${client.id}/client-secret`)).value;
    },
    async addPerson({ username, email, firstName, lastName }, password) {
      await call("POST", `/${realm}/users`, { username, email, firstName, lastName, enabled: true, emailVerified: true });
      const [user] = await call("GET", `/${realm}/users?exact=true&username=${encodeURIComponent(username)}`);
      await call("PUT", `/${realm}/users/${user.id}/reset-password`, { type: "password", value: password, temporary: false });
    },
  };
}

/** Sign a synthetic person in through the real sign-in page; returns the page. */
async function signInWithPassword(kit, email, password) {
  const page = kit.use(await kit.anonymous());
  await page.locator(".auth-heading").waitFor();
  const local = page.locator(".auth-method-switch").getByRole("button", { name: /Email & password/ });
  if (await local.count()) await local.click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.locator(".auth-submit-button").click();
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
  await page.waitForTimeout(1200);
  const dismiss = page.getByRole("button", { name: "I'll explore on my own" });
  if (await dismiss.count()) {
    await dismiss.click();
    await page.waitForTimeout(500);
  }
  return page;
}

/** Setup only: a new synthetic local account with a random permanent password. */
async function createPerson(kit, { email, name, groups = ["group-litigation"] }) {
  const users = await kit.api("admin", "GET", "/api/admin/users");
  if (users.some((user) => user.email === email)) throw new Error(`Reset the instance first: ${email} already exists.`);
  const created = await kit.api("admin", "POST", "/api/admin/users", { email, display_name: name, role: "USER", auth_method: "local", group_ids: groups });
  const password = syntheticPassword();
  await kit.api("admin", "POST", `/api/admin/users/${created.id}/password`, { password, temporary: false });
  return { ...created, password };
}

const helpers = { signInWithPassword, createPerson, scrollTo, scrollBelowHeader, dismissToasts, composer, sendChat, waitForReply, totp, freshTotp, syntheticPassword, publicApi, userRealm };
Object.defineProperty(module.exports, "helpers", { value: helpers, enumerable: false });
