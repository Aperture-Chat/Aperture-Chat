/* Capture the current training additions against an isolated synthetic stack.
 *
 * Required: CAPTURE_APP_URL and CAPTURE_API_URL (loopback origins),
 * CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=I_HAVE_REVIEWED_SYNTHETIC_DATA,
 * CAPTURE_MUTATION_ACK=isolated-synthetic, and actual sign-in response files:
 * CAPTURE_USER_SESSION_FILE, CAPTURE_ADMIN_SESSION_FILE,
 * CAPTURE_OWNER_SESSION_FILE. Supply the roles used by the selected modes;
 * admin also requires the user file to identify the intended request and trace.
 * Admin and owner fixtures must contain clearly synthetic chats with real tag
 * rows; the script fails instead of capturing an empty tag demonstration.
 * Optional: CAPTURE_CHROMIUM_EXECUTABLE_PATH, CAPTURE_MODEL_ID,
 * CAPTURE_DRAFT_TITLE (defaults to a synthetic onboarding checklist).
 *
 * Usage: node apps/web/scripts/capture-training-refresh.cjs user,admin,owner
 *        node apps/web/scripts/capture-training-refresh.cjs more
 *
 * Fixtures: user needs a genuinely requestable catalog model; admin needs that
 * user's pending request and an eligible group. `more` requires usable model
 * controls and a saved DRAFT_TITLE from the user pass. All roles must already
 * have finished their first-run onboarding. No provider result is
 * simulated. Captures show the real server's state, including unavailable states.
 *
 * `user` submits a model request, saves a manually written synthetic draft,
 * and deliberately disconnects the browser to capture a failed account save.
 * It may withdraw the same user's selected pending request first. `admin` changes an unsaved group selection but does not approve
 * or decline requests. `owner` and `more` are read-only. No live-instance or
 * provider mutations are permitted. All PNGs, hashes, and measured rectangles
 * stay in ignored review storage; even a complete batch is never published.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const { validateCaptureSource } = require("./training-capture-run.cjs");
const VIEWPORT = { width: 1185, height: 855 };
const ROLES = { user: "USER", admin: "TENANT_ADMIN", owner: "PLATFORM_OWNER" };
const EXPECTED = {
  user: ["model-access", "model-access-pending", "theme-schedule", "search-commands", "draft-save-state", "drafts", "draft-settings", "draft-history", "search-recent", "unsynced-work"],
  admin: ["model-access-requests", "model-access-trace", "retention-policy", "retention-tags"],
  owner: ["search-index", "model-browsing-policy", "provider-catalog", "branding-actions", "retention-tags"],
  more: ["model-favorites", "composer-send-options", "composer-shortcuts-help", "search-palette", "search-recent"],
};
let APP, API, OUT, page, role, browser, context, currentMode, offline = false;
const DRAFT_TITLE = process.env.CAPTURE_DRAFT_TITLE || "Workspace onboarding checklist";
const measures = { user: {}, admin: {}, owner: {} };
const sessions = {};
const manifest = { capturedAt: new Date().toISOString(), viewport: VIEWPORT, deviceScaleFactor: 2, complete: false, completedModes: [], frames: {}, blockedRequests: [] };

function origin(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  validateCaptureSource(value, process.env.CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION);
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`${name} must be an origin.`);
  return url.origin;
}
function xpathLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return "concat(" + value.split("'").map(part => `'${part}'`).join(', "\'", ') + ")";
}
function saveManifest() {
  if (OUT) fs.writeFileSync(path.join(OUT, "capture-manifest.json"), JSON.stringify(manifest, null, 2));
}
async function validateSession(audience) {
  if (sessions[audience]) return sessions[audience];
  const file = process.env[`CAPTURE_${audience.toUpperCase()}_SESSION_FILE`];
  if (!file) throw new Error(`A real ${audience} sign-in response file is required.`);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!saved.user?.id || !saved.session?.token) throw new Error("Invalid sign-in response file.");
  const result = await fetch(API + "/api/auth/session", { headers: { "x-aperture-session": saved.session.token } });
  if (!result.ok) throw new Error(`The ${audience} session is not valid.`);
  const actual = await result.json();
  if (actual.user?.id !== saved.user.id || actual.user?.role !== ROLES[audience]) throw new Error("Session role mismatch.");
  if (!/^[^@]+@[^@]+\.(test|invalid)$/i.test(actual.user.email || "")) throw new Error("The account must use a reserved synthetic domain.");
  return sessions[audience] = { user: actual.user, token: saved.session.token };
}
function allowedWrite(method, pathname) {
  if (currentMode !== "user") return false;
  return (method === "POST" && ["/api/me/model-access-requests", "/api/drafts", "/api/auth/first-run-guide/seen"].includes(pathname))
    || (method === "DELETE" && /^\/api\/me\/model-access-requests\/[^/]+$/.test(pathname))
    || (method === "PUT" && /^\/api\/drafts\/[^/]+$/.test(pathname));
}
async function open(audience) {
  const auth = await validateSession(audience);
  browser = await chromium.launch({ ...(process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH } : {}) });
  context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, serviceWorkers: "block" });
  offline = false;
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (![APP, API].includes(url.origin)) return route.abort("blockedbyclient");
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (offline) return route.abort("internetdisconnected");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && !allowedWrite(request.method(), url.pathname)) {
      manifest.blockedRequests.push({ method: request.method(), path: url.pathname });
      return route.abort("blockedbyclient");
    }
    const response = await route.fetch({ url: API + url.pathname + url.search, maxRedirects: 0 });
    await route.fulfill({ response });
  });
  await context.addInitScript(({ user, token }) => {
    localStorage.setItem("aperture-session-user-id", user);
    localStorage.setItem("aperture-session-token", token);
  }, { user: auth.user.id, token: auth.token });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(APP);
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
  await page.addStyleTag({ content: ".apx-tooltip{display:none!important}" });
}
async function setOffline(value) {
  offline = value;
  await context.setOffline(value);
}
async function shot(name, targets, { keepPointer = false } = {}) {
  if (!keepPointer) await page.mouse.move(1, 1);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  for (const input of await page.locator('input[type="password"], input[autocomplete="one-time-code"]').all()) {
    if (await input.isVisible() && await input.inputValue()) throw new Error("Proof fields must be empty in training captures.");
  }
  if (await page.locator(".account-security-qr, .account-security-secret, .account-security-codes").count()) throw new Error("Secret-bearing authentication screens require the dedicated masked capture pipeline.");
  const dir = path.join(OUT, role);
  fs.mkdirSync(dir, { recursive: true });
  for (const [key, loc] of Object.entries(targets)) {
    const box = await loc.boundingBox();
    if (!box) throw new Error(`Missing ${key}.`);
    const x = Math.max(0, box.x), y = Math.max(0, box.y);
    const right = Math.min(VIEWPORT.width, box.x + box.width), bottom = Math.min(VIEWPORT.height, box.y + box.height);
    if (right <= x || bottom <= y) throw new Error(`Outside viewport: ${key}.`);
    measures[role][key] = { frame: `training/${role}/${name}.png`, rect: { x, y, w: right - x, h: bottom - y }, zoom: 1 };
  }
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file });
  const png = fs.readFileSync(file);
  manifest.frames[`${role}/${name}`] = { sha256: crypto.createHash("sha256").update(png).digest("hex"), mode: currentMode };
  fs.writeFileSync(path.join(dir, "measured-rects.json"), JSON.stringify(measures[role], null, 2));
  saveManifest();
  console.log(`Captured ${role}/${name}.`);
}
function unionTarget(...locators) {
  return { boundingBox: async () => {
    const boxes = await Promise.all(locators.map(locator => locator.boundingBox()));
    if (!boxes.length || boxes.some(box => !box)) return null;
    const x = Math.min(...boxes.map(box => box.x));
    const y = Math.min(...boxes.map(box => box.y));
    return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x,
      height: Math.max(...boxes.map(box => box.y + box.height)) - y };
  } };
}
async function expandPanel(title) {
  const panel = page.locator('.panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await panel.waitFor();
  if (await panel.locator('.panel-header button[aria-label="Expand panel"]').count()) {
    await panel.getByRole('button', { name: 'Expand panel', exact: true }).click();
  }
  return panel;
}
async function retentionTags() {
  await page.goto(APP + (role === 'owner' ? '/platform/audit' : '/admin/audit'));
  await expandPanel('Data Retention');
  await page.getByRole('button', { name: 'Tags and holds', exact: true }).click();
  const chips = page.locator('.retention-tag-chip:not(.is-archived):not(.is-matter)');
  await chips.first().waitFor();
  await page.locator('.retention-view-switch').evaluate(element => element.scrollIntoView({ block: 'start' }));
  const chipBox = await chips.first().boundingBox();
  if (!chipBox || chipBox.y < 0 || chipBox.y + chipBox.height > VIEWPORT.height) throw new Error('Synthetic retention tag chips must be fully inside the captured viewport.');
  await shot("retention-tags", {
    retentionTagsSwitch: page.locator('.retention-view-switch'),
    retentionTagsExplorer: unionTarget(page.locator('.retention-tags-toolbar'), page.locator('.retention-batch-bar'), page.locator('.retention-tagged-list')),
  });
}
async function runUser(){
  role='user'; await open('user');
  const unavailable = page.getByRole("button", { name: "No connected models. Why isn't a model available?" });
  if (await unavailable.isVisible()) await unavailable.click();
  else {
    await page.getByRole("button", { name: "Select model", exact: true }).click();
    await page.getByRole("button", { name: "Why isn't a model listed?", exact: true }).click();
  }
  const dialog = page.getByRole("dialog", { name: "Models in your organization" });
  await dialog.getByText("Checking model access…").waitFor({ state: "hidden" });
  const rows = dialog.locator("[data-model-id]");
  // Resolve a real catalog row. The optional ID disambiguates fixtures;
  // otherwise prefer the first entry that can be requested or withdrawn.
  const targetRow = process.env.CAPTURE_MODEL_ID
    ? rows.locator(`xpath=self::*[@data-model-id=${xpathLiteral(process.env.CAPTURE_MODEL_ID)}]`)
    : rows.filter({ has: page.getByRole("button", { name: /^(Request access|Withdraw request)$/ }).and(page.locator(":enabled")) }).first();
  await targetRow.waitFor();
  if (await targetRow.getByRole("button", { name: "Withdraw request", exact: true }).count()) {
    await targetRow.getByRole("button", { name: "Withdraw request", exact: true }).click();
  }
  await targetRow.getByRole("button", { name: "Request access", exact: true }).waitFor();
  if (!await targetRow.getByRole("button", { name: "Request access", exact: true }).isEnabled()) {
    throw new Error("The selected model must permit a real access request.");
  }
  await targetRow.scrollIntoViewIfNeeded();
  await shot("model-access",{modelAccessOverview:dialog,modelAccessRequest:targetRow});
  await targetRow.getByRole('button',{name:'Request access',exact:true}).click();
  await dialog.getByText('Request pending',{exact:false}).first().waitFor();
  await targetRow.scrollIntoViewIfNeeded();
  await shot("model-access-pending",{modelAccessPending:targetRow});
  await page.getByRole('button',{name:'Close model access dialog'}).click();
  await page.getByRole('button',{name:'Theme schedule',exact:true}).click();
  await shot("theme-schedule",{themeSchedule:page.getByRole('dialog',{name:'Theme schedule'})});
  await page.getByRole('button',{name:'Close theme schedule'}).click();
  await page.getByRole('button',{name:'Search',exact:true}).click();
  const input=page.getByRole('combobox');
  await input.fill('>'); await page.getByRole('option').first().waitFor();
  await shot("search-commands",{searchCommands:page.locator('.command-palette-panel')});
  await page.getByRole('option').filter({hasText:'Drafts'}).first().click();
  await page.getByRole('textbox',{name:'Document title',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'Document title',exact:true}).fill(DRAFT_TITLE);
  await page.getByRole('textbox',{name:'Document body',exact:true}).fill('Workspace onboarding checklist\nConfirm your account security settings.\nRequest only the models your work requires.\nSave a version before leaving your draft.');
  await page.getByRole('button',{name:'Save version',exact:true}).click();
  await page.locator('.document-server-save-state').filter({hasText:'Saved'}).waitFor();
  await page.waitForTimeout(1200);
  if(await page.getByRole('button',{name:'Save version',exact:true}).isEnabled()){await page.getByRole('button',{name:'Save version',exact:true}).click();await page.waitForTimeout(700);}
  await shot("draft-save-state",{draftSaveState:page.locator('.document-editor-topbar')});
  await shot("drafts",{
    draftModeToggle:page.getByRole('group',{name:'Draft format'}),
    draftComposer:page.locator('.draft-command-box'),
    draftModel:page.getByRole('button',{name:'Document drafting model'}),
    draftToolbar:page.locator('[aria-label="Document formatting"]'),
    draftVersions:page.locator('.document-editor-topbar'),
  });
  await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
  await shot("draft-settings",{draftSettings:page.locator('.draft-settings-panel')});
  await page.getByRole('button',{name:'Draft history',exact:true}).click();
  await page.locator('.draft-history-document-card').first().hover();
  await page.locator('.draft-history-preview').waitFor();
  await shot("draft-history",{draftHistory:page.locator('.draft-history-panel'),draftHistoryPreview:page.locator('.draft-history-preview')},{keepPointer:true});
  await page.getByRole('button',{name:'Back to chat',exact:true}).click();
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await shot("search-recent",{searchRecent:page.locator('.command-palette-panel')});
  await page.getByRole('button',{name:'Close search dialog'}).click();
  await page.getByRole('link',{name:'Drafts',exact:true}).click();
  await setOffline(true);
  await page.getByRole('textbox',{name:'Document body',exact:true}).fill('Offline preparation notes\nThis manually written draft has not reached the server.');
  await page.getByRole('button',{name:'Save version',exact:true}).click();
  await page.getByText('Local only — server save failed',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Back to chat',exact:true}).click();
  await page.getByRole('button',{name:/only on this device/i}).first().click();
  await shot("unsynced-work",{unsyncedWork:page.getByRole('dialog',{name:'Only on this device'})});
  await setOffline(false);
  await browser.close();
}
async function runMore(){
  role='user';await open('user');
  await page.getByRole('button',{name:'Select model',exact:true}).click();
  await shot("model-favorites",{modelFavorites:page.locator('.workspace-header .model-menu')});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Send options',exact:true}).click();
  await shot("composer-send-options",{
    sendKnowledge:page.getByRole('menuitemcheckbox',{name:/^Knowledge/}),
    sendWeb:page.getByRole('menuitemcheckbox',{name:/^Web/}),
    sendAgent:page.getByRole('menuitemcheckbox',{name:/^Agent/}),
    sendReasoning:page.getByRole('group',{name:'Reasoning level'}),
    sendStreaming:page.locator('.send-menu-stream'),
  });
  await page.getByRole('button',{name:'Resources',exact:true}).click();
  await shot("composer-shortcuts-help",{composerShortcuts:page.getByRole('dialog',{name:'Send options'})});
  await page.getByRole('button',{name:'Close send options'}).click();
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.getByRole('combobox').fill(DRAFT_TITLE);
  await page.getByRole('option').filter({hasText:DRAFT_TITLE}).first().waitFor();
  await shot("search-palette",{searchPalette:page.locator('.command-palette-panel')});
  await page.getByRole('option').filter({hasText:DRAFT_TITLE}).first().click();
  await page.getByRole('textbox',{name:'Document body',exact:true}).waitFor();
  await page.getByRole('button',{name:'Back to chat',exact:true}).click();
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.locator('.command-palette-panel').getByText('Recent',{exact:true}).waitFor();
  await shot("search-recent",{searchRecent:page.locator('.command-palette-panel')});
  await browser.close();
}
async function runAdmin(){
  role='admin';await open('admin');
  await page.goto(APP+'/admin/model-access');
  const requester = await validateSession('user');
  const requestRow = page.locator('.model-access-request-row').filter({ hasText: requester.user.email }).first();
  await requestRow.waitFor();
  const selector=requestRow.locator('select');
  const widen=await selector.locator('option').evaluateAll(ns=>ns.find(n=>n.textContent.includes('also grant'))?.value);
  if(widen)await selector.selectOption(widen);
  await shot("model-access-requests",{maRequests:page.locator('.model-access-requests-panel'),maRequestGroup:requestRow.locator('.model-access-request-actions')});
  await page.goto(APP+'/admin/users');
  const targetUser = await validateSession('user');
  await page.getByRole('button', { name: `Model access for ${targetUser.user.display_name}`, exact: true }).click();
  await page.getByText('Evaluating…').waitFor({state:'hidden'});
  await shot("model-access-trace",{maUserTrace:page.getByRole('dialog',{name:/Model access trace/})});
  await page.goto(APP+'/admin/audit');
  const retention = await expandPanel('Data Retention');
  await retention.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await shot("retention-policy",{retentionPanel:retention,retentionToggles:unionTarget(...await retention.locator('.policy-toggle-row').all())});
  await retentionTags();
  await browser.close();
}
async function runOwner(){
  role='owner';await open('owner');await page.goto(APP+'/platform/org-settings');
  const index=page.locator('.search-index-card'); await index.scrollIntoViewIfNeeded();
  await shot("search-index",{searchIndex:index});
  const policies=page.locator('.panel').filter({has:page.getByRole('heading',{name:'Policy Controls',exact:true})});
  if(!(await page.getByRole('switch',{name:'Users can browse the model catalog',exact:true}).isVisible()))await policies.getByRole('button',{name:'Expand panel'}).click();
  const browse=page.locator('.policy-toggle-row').filter({has:page.getByRole('switch',{name:'Users can browse the model catalog',exact:true})});
  await browse.scrollIntoViewIfNeeded();
  await shot("model-browsing-policy",{modelBrowsingPolicy:browse});
  await page.goto(APP+'/platform/providers');
  const catalog = page.locator('.provider-summary dl').filter({has:page.locator('dt').filter({hasText:/^Catalog$/})}).first();
  await catalog.scrollIntoViewIfNeeded();
  await shot("provider-catalog",{providerStats:catalog});
  await page.goto(APP+'/platform/org-settings');
  const branding = await expandPanel('Platform Branding');
  await branding.getByRole('button',{name:'Apply branding',exact:true}).scrollIntoViewIfNeeded();
  await shot("branding-actions",{brandActions:unionTarget(page.locator('.branding-actions'),branding.getByRole('button',{name:'Apply branding',exact:true}))});
  await retentionTags();
  await browser.close();
}

async function main() {
  APP = origin("CAPTURE_APP_URL");
  API = origin("CAPTURE_API_URL");
  if (process.env.CAPTURE_MUTATION_ACK !== "isolated-synthetic") throw new Error("CAPTURE_MUTATION_ACK=isolated-synthetic is required.");
  const parts = (process.argv[2] || "user,admin,owner").split(",");
  if (parts.some(part => !Object.hasOwn(EXPECTED, part)) || new Set(parts).size !== parts.length) throw new Error("Choose user, admin, owner, or more, each at most once.");
  const work = path.join(__dirname, "../../../tmp/training-captures");
  fs.mkdirSync(work, { recursive: true });
  OUT = fs.mkdtempSync(path.join(work, "capture-training-refresh-"));
  saveManifest();
  try {
    for (const part of parts) {
      currentMode = part;
      await ({ user: runUser, admin: runAdmin, owner: runOwner, more: runMore })[part]();
      const audience = part === "more" ? "user" : part;
      if (EXPECTED[part].some(name => !manifest.frames[`${audience}/${name}`])) throw new Error(`Incomplete ${part} frame batch.`);
      if (manifest.blockedRequests.length) throw new Error("An unexpected write was blocked.");
      manifest.completedModes.push(part);
      saveManifest();
    }
    manifest.complete = true;
    saveManifest();
    console.log(`Complete review batch: ${path.relative(process.cwd(), OUT)}. No public files were changed.`);
  } finally {
    if (context && offline) await context.setOffline(false).catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}
if (require.main === module) main().catch(error => {
  manifest.error = { mode: currentMode || "validate inputs", type: error.name };
  saveManifest();
  console.error(`Training refresh capture failed in ${currentMode || "input validation"} (${error.name}). No public files were changed.`);
  process.exitCode = 1;
});
