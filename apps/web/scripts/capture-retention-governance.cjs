/* Capture retention controls only on an isolated, reviewed synthetic stack.
 * CAPTURE_APP_URL, CAPTURE_API_URL: loopback origins; actual sign-in response
 * files: CAPTURE_OWNER_SESSION_FILE / CAPTURE_ADMIN_SESSION_FILE.
 * Both acknowledgements below are required. Seed a clearly synthetic client
 * source, a matching saved conversation, and an inactive Forever policy first.
 * Optional CAPTURE_RETENTION_CHAT_TITLE and CAPTURE_RETENTION_SOURCE_KEY choose
 * the synthetic fixture. Outputs stay in ignored review storage; inspect and
 * publish PNGs before applying their measured focus rectangles.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const APP = new URL(process.env.CAPTURE_APP_URL).origin;
const API = new URL(process.env.CAPTURE_API_URL).origin;
const viewport = { width: 1185, height: 855 };
const title = process.env.CAPTURE_RETENTION_CHAT_TITLE || "Northwind client review";
const source = process.env.CAPTURE_RETENTION_SOURCE_KEY || "client:training-client";
if (![APP, API].every(value => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname))
 || process.env.CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION !== "I_HAVE_REVIEWED_SYNTHETIC_DATA"
 || process.env.CAPTURE_MUTATION_ACK !== "isolated-synthetic") throw Error("Use reviewed synthetic loopback fixtures and both capture acknowledgements.");
(async () => {
 for (const role of (process.argv[2] || "owner,admin").split(",")) {
  if (!["owner", "admin"].includes(role)) throw Error("Unsupported capture role");
  const saved = JSON.parse(fs.readFileSync(process.env[`CAPTURE_${role.toUpperCase()}_SESSION_FILE`], "utf8"));
  const response = await fetch(API + "/api/auth/session", { headers: { "x-aperture-session": saved.session.token } });
  if (!response.ok) throw Error("Sign-in response must still be valid");
  const actual = await response.json();
  if (actual.user.id !== saved.user.id || actual.user.role !== (role === "owner" ? "PLATFORM_OWNER" : "TENANT_ADMIN") || !/\.(test|invalid)$/i.test(actual.user.email)) throw Error("Synthetic account and role verification failed");
  const browser = await chromium.launch(process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH } : {});
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: "reduce", serviceWorkers: "block" });
  await context.addInitScript(({ user, token }) => { localStorage.setItem("aperture-session-user-id", user); localStorage.setItem("aperture-session-token", token); }, { user: actual.user.id, token: saved.session.token });
  await context.route("**/*", route => {
   const req = route.request(), url = new URL(req.url());
   if (![APP, API].includes(url.origin)) return route.abort("blockedbyclient");
   if (url.pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method()) && !(req.method() === "POST" && ["/api/admin/retention/scan", "/api/admin/retention/preview"].includes(url.pathname))) return route.abort("blockedbyclient");
   return route.continue();
  });
  const page = await context.newPage();
  const out = path.resolve("tmp", "retention-capture", role); fs.mkdirSync(out, { recursive: true }); const measured = {};
  const group = locator => ({
   evaluate: fn => locator.first().evaluate(fn),
   boundingBox: () => locator.evaluateAll(elements => {
    const boxes = elements.map(element => element.getBoundingClientRect());
    const x = Math.min(...boxes.map(r => r.x)), y = Math.min(...boxes.map(r => r.y));
    return { x, y, width: Math.max(...boxes.map(r => r.right))-x, height: Math.max(...boxes.map(r => r.bottom))-y };
   }),
  });
  async function shot(name, key, locator) {
   await locator.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" })); await page.mouse.move(1,1); await page.waitForTimeout(500);
   const r = await locator.boundingBox(); if (!r || r.y < 0 || r.y+r.height > viewport.height) throw Error(`Focus region must be visible: ${key}`);
   const x = Math.max(0, r.x-8), y = Math.max(0, r.y-6);
   measured[key] = { frame: `training/${role}/${name}.png`, rect: { x, y, w: Math.min(viewport.width-x, r.width+16), h: Math.min(viewport.height-y, r.height+12) }, zoom: 1 };
   await page.screenshot({ path: path.join(out, name+".png") });
  }
  await page.goto(APP+(role === "owner" ? "/platform/audit" : "/admin/audit"));
  const light = page.getByRole("button", { name: "Light mode", exact: true }); if (await light.isVisible()) { await light.click(); await page.waitForTimeout(1600); }
  await shot("retention-navigation", "retentionNavigation", page.getByRole("tab", { name: "Audit", exact: true }));
  const panel = page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Data Retention", exact: true }) });
  await panel.getByRole("button", { name: "Expand panel", exact: true }).click();
  if (await panel.getByRole("slider").getAttribute("aria-valuetext") !== "Forever") throw Error("Fixture policy must start at Forever");
  await shot("retention-workspace", "retentionWorkspace", panel.locator(".retention-view-switch"));
  await shot("retention-policy", "retentionPanel", group(panel.locator(".retention-schedule-fields > label:first-child, .retention-duration-slider, .retention-preset-labels")));
  await shot("retention-sources", "retentionSources", group(panel.locator(".retention-source-section > h4, .retention-source-section > p:not(.retention-explanation), .retention-source-section > .retention-field-grid, .retention-source-section > label:not(.retention-checkbox), .retention-source-section > button")));
  await shot("retention-sensitive", "retentionSensitive", panel.locator(".retention-checkbox").last());
  await panel.getByRole("button", { name: "7 years", exact: true }).click(); await panel.getByRole("button", { name: "Preview effect" }).click(); await panel.locator(".retention-impact").waitFor();
  await shot("retention-schedule-preview", "retentionSchedulePreview", group(panel.locator(".retention-impact, .retention-governance > .retention-actions")));
  const prompt = panel;
  await prompt.getByRole("button", { name: "Tags and holds", exact: true }).click(); await prompt.getByRole("button", { name: "Scan existing chats" }).click(); await prompt.getByText(/saved chats; .* new suggestions/).waitFor();
  await prompt.getByRole("searchbox", { name: "Search chats and tags" }).fill(title);
  await prompt.getByRole("checkbox", { name: "Select all listed chats" }).check(); await prompt.getByRole("combobox", { name: "Retention label to apply" }).selectOption(source);
  await shot("retention-tags", "retentionTagsExplorer", prompt.locator(".retention-tag-management"));
  await prompt.getByText("Legal holds", { exact: true }).click(); await prompt.getByLabel("Hold name", { exact: true }).fill("Synthetic records review");
  await shot("retention-holds", "retentionHolds", prompt.locator(".retention-tag-management details"));
  await prompt.getByRole("button", { name: `Preview the full conversation: ${title}`, exact: true }).first().click(); await page.getByRole("dialog").waitFor();
  await shot("retention-preview", "retentionPreview", page.getByRole("dialog")); await page.keyboard.press("Escape");
  await prompt.getByRole("button", { name: "Delete selected", exact: true }).click();
  await shot("retention-batch", "retentionBatch", prompt.locator(".retention-batch-bar"));
  fs.writeFileSync(path.join(out,"measured-rects.json"), JSON.stringify(measured,null,2));
  await browser.close(); console.log(`${role}: ${Object.keys(measured).length} frames captured for review; no deletion or finite policy was saved.`);
 }
})().catch(error => { console.error(error.message); process.exit(1); });
