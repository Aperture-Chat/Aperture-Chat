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
 *        node apps/web/scripts/capture-training-refresh.cjs drafts
 *        node apps/web/scripts/capture-training-refresh.cjs more
 *        node apps/web/scripts/capture-training-refresh.cjs symbols
 *        node apps/web/scripts/capture-training-refresh.cjs audit,alerts,elastic,open
 *
 * Fixtures: user needs a genuinely requestable catalog model; admin needs that
 * user's pending request and an eligible group. `drafts` needs a usable
 * drafting model whose real reply fills the Edit with AI review. `more`
 * requires usable model controls and a saved DRAFT_TITLE from the user or
 * drafts pass. `symbols` needs a saved chat titled CAPTURE_SYMBOLS_CHAT_TITLE
 * (default: the synthetic vendor review checklist) and at least one saved
 * prompt, agent profile, knowledge base, skill file, and automation, so every
 * symbol menu shows real items. `audit` (admin and owner) needs audit
 * events across the last two weeks and at least one security alert, so every
 * Audit Insights chart has records. `alerts` (admin and owner) needs saved
 * SMTP settings, at least one rule per scope, and real deliveries. `elastic`
 * needs a reachable synthetic Elastic cluster already saved in the panel, and
 * runs one connection check. `open` opens a generated synthetic Markdown file
 * from the Drafts paperclip menu. All roles must already have finished their first-run
 * onboarding. No provider result is simulated. Captures show the real
 * server's state, including unavailable states.
 *
 * `user` submits a model request, saves a manually written synthetic draft,
 * and deliberately disconnects the browser to capture a failed account save.
 * It may withdraw the same user's selected pending request first. `drafts`
 * saves a manually written synthetic document, requests one real inline AI
 * suggestion, and discards it. `admin` changes an unsaved group selection but
 * does not approve or decline requests. `alerts` opens a rule template but
 * cancels it unsaved. `open` may save the opened synthetic document. `owner`,
 * `more`, `symbols`, and `audit` are read-only; `symbols` types each symbol into
 * the composer but never sends. No
 * live-instance or provider mutations are permitted. All PNGs, hashes, and
 * measured rectangles stay in ignored review storage; even a complete batch
 * is never published.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const { validateCaptureSource } = require("./training-capture-run.cjs");
const VIEWPORT = { width: 1185, height: 855 };
// The app's own web font stylesheet; every other outside origin stays blocked.
const FONT_ORIGINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];
const ROLES = { user: "USER", admin: "TENANT_ADMIN", owner: "PLATFORM_OWNER" };
const EXPECTED = {
  user: ["model-access", "model-access-pending", "theme-schedule", "search-commands", "search-recent", "unsynced-work"],
  drafts: ["draft-save-state", "drafts", "draft-settings", "draft-history", "draft-ai-edit", "draft-slash", "draft-find"],
  admin: ["model-access-requests", "model-access-trace", "retention-policy", "retention-tags"],
  owner: ["search-index", "model-browsing-policy", "provider-catalog", "branding-actions", "retention-tags"],
  more: ["model-favorites", "composer-send-options", "composer-shortcuts-help", "search-palette", "search-recent"],
  symbols: ["chat-session-panel", "session-shortcuts", "composer-slash", "composer-agent", "composer-hash", "composer-skill", "composer-automation"],
  audit: [
    "admin/audit", "admin/audit-insights", "admin/audit-investigation", "admin/audit-alerts", "admin/audit-trail",
    "owner/audit", "owner/audit-insights", "owner/audit-insights-activity", "owner/audit-investigation", "owner/audit-alerts", "owner/audit-trail",
  ],
  alerts: ["admin/alerts", "admin/alerts-rule-form", "owner/alerts", "owner/alerts-deliveries", "owner/alerts-rule-form"],
  elastic: ["owner/elastic-connection", "owner/elastic-streams", "owner/elastic-checks", "owner/elastic-delivery"],
  open: ["draft-open-menu", "draft-opened-file"],
};
// Synthetic content for the `open` mode's "Open in editor" file.
const OPEN_FILE_NAME = "Synthetic vendor onboarding policy.md";
const OPEN_FILE_TEXT = [
  "# Synthetic vendor onboarding policy",
  "## Purpose",
  "This synthetic policy explains how a new vendor is reviewed before its first engagement.",
  "## Review steps",
  "- Confirm the vendor's security questionnaire is complete.",
  "- Record the data the vendor will receive and who approved it.",
  "- Schedule a follow-up review after ninety days.",
  "## Owners",
  "The procurement lead owns this checklist, and the security team signs off on access.",
  "",
].join("\n");
let APP, API, OUT, page, role, browser, context, currentMode, offline = false;
const DRAFT_TITLE = process.env.CAPTURE_DRAFT_TITLE || "Workspace onboarding checklist";
const SYMBOLS_CHAT_TITLE = process.env.CAPTURE_SYMBOLS_CHAT_TITLE || "Synthetic training — vendor review checklist";
// Typed with Markdown shortcuts so the outline has real headings. The last
// paragraph is the one the Edit with AI frame rewrites.
const DRAFT_LINES = [
  "# Workspace onboarding checklist",
  "## Before you start",
  "Confirm your account security settings and add an authenticator app.",
  "## Working with models",
  "Request only the models your work requires, and save a version before you leave your draft so you can compare changes later.",
];
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
  if (currentMode === "elastic") return method === "POST" && pathname === "/api/platform/elastic/test";
  if (currentMode === "open") {
    return (method === "POST" && pathname === "/api/drafts") || (method === "PUT" && /^\/api\/drafts\/[^/]+$/.test(pathname));
  }
  if (currentMode === "drafts") {
    return (method === "POST" && ["/api/drafts", "/api/chat/complete"].includes(pathname))
      || (method === "PUT" && /^\/api\/drafts\/[^/]+$/.test(pathname));
  }
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
    if (FONT_ORIGINS.includes(url.origin) && request.method() === "GET") return route.continue();
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
function unionAll(locator) {
  return { boundingBox: async () => unionTarget(...await locator.all()).boundingBox() };
}
// Matches measureFrameFocus: a small margin keeps the highlight border off
// text that sits flush with the element's edge.
function padded(target, margin = 3) {
  return { boundingBox: async () => {
    const box = await target.boundingBox();
    return box && { x: box.x - margin, y: box.y - margin, width: box.width + 2 * margin, height: box.height + 2 * margin };
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
async function saveDraftVersion(){
  const save = page.getByRole('button',{name:'Save version',exact:true});
  await save.click();
  await page.locator('.document-server-save-state').filter({hasText:'Saved'}).waitFor();
  await page.waitForTimeout(1200);
  // Leaving the editor can normalize pagination markup; save that too so the
  // frame shows a clean saved version.
  if(await save.isEnabled()){await save.click();await page.locator('.document-server-save-state').filter({hasText:'Saved'}).waitFor();await page.waitForTimeout(700);}
}
async function selectEditorText(text){
  await page.getByRole('textbox',{name:'Document body',exact:true}).evaluate((body, wanted) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent.indexOf(wanted);
      if (start === -1) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + wanted.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return;
    }
    throw new Error('Synthetic draft text is missing.');
  }, text);
}
async function runDrafts(){
  role='user'; await open('user');
  await page.getByRole('link',{name:'Drafts',exact:true}).click();
  const body=page.getByRole('textbox',{name:'Document body',exact:true});
  await body.waitFor();
  await page.getByRole('textbox',{name:'Document title',exact:true}).fill(DRAFT_TITLE);
  await body.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  // Typed at a person's pace; the editor reformats Markdown as it goes.
  for(const [index,line] of DRAFT_LINES.entries()){
    await page.keyboard.type(line,{delay:45});
    if(index<DRAFT_LINES.length-1) await page.keyboard.press('Enter');
  }
  await saveDraftVersion();
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
  await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
  await page.getByRole('button',{name:'Document history',exact:true}).click();
  // Point at the card without Playwright's scroll-into-view, which would hide
  // the Active/Archived filter above it.
  const card=page.locator('.draft-history-document-card').first();
  await card.waitFor();
  const cardBox=await card.boundingBox();
  await page.mouse.move(cardBox.x+cardBox.width/2,cardBox.y+cardBox.height/2);
  await page.locator('.draft-history-preview').waitFor();
  await shot("draft-history",{draftHistory:page.locator('.draft-history-panel'),draftHistoryPreview:page.locator('.draft-history-preview')},{keepPointer:true});
  await page.getByRole('button',{name:'Document history',exact:true}).click();
  // One real suggestion from the drafting model, reviewed and then discarded.
  await selectEditorText(DRAFT_LINES.at(-1));
  await page.locator('.document-selection-toolbar').getByRole('button',{name:/^Ask AI/}).click();
  await page.getByRole('option',{name:'Improve writing',exact:true}).click();
  await page.locator('.ai-composer.is-review').waitFor({timeout:240000});
  await shot("draft-ai-edit",{draftAiEdit:page.locator('.ai-composer')});
  await page.getByRole('button',{name:'Discard AI suggestion'}).click();
  await body.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await page.locator('.document-slash-menu').waitFor();
  await shot("draft-slash",{draftSlashMenu:page.locator('.document-slash-menu')});
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.getByRole('button',{name:'Document outline',exact:true}).click();
  await page.getByRole('button',{name:'Find and replace',exact:true}).click();
  await page.keyboard.type('version');
  await shot("draft-find",{draftStatusBar:page.locator('.document-status-bar')});
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
async function openSymbolMenu(symbol) {
  const textarea = page.locator('.composer textarea');
  await textarea.click();
  await textarea.press('Meta+a');
  await textarea.press('Backspace');
  await textarea.pressSequentially(symbol, { delay: 60 });
  const menu = page.locator(".composer-command-menu[role='listbox']");
  await menu.waitFor();
  await page.locator('.composer-command-loading').filter({ hasText: 'Loading files' }).waitFor({ state: 'detached' });
  if (!await menu.getByRole('option').count()) throw new Error(`The ${symbol} menu has no synthetic items to show.`);
  return menu;
}
async function runSymbols(){
  role='user';await open('user');
  const chat = page.getByRole('button',{name:SYMBOLS_CHAT_TITLE,exact:true}).first();
  if (await chat.isVisible()) await chat.click();
  else {
    await page.getByRole('button',{name:'View all chats',exact:true}).click();
    await page.getByRole('dialog',{name:'All chats',exact:true}).getByRole('button',{name:SYMBOLS_CHAT_TITLE,exact:true}).click();
  }
  await page.locator('.assistant-message').first().waitFor();
  await page.getByRole('button',{name:'Session info',exact:true}).click();
  const panel = page.locator('.session-panel');
  await panel.waitFor();
  await shot("chat-session-panel",{
    sessionSummary:padded(unionAll(panel.locator('.audit-list > .audit-heading:first-child, .audit-list > .audit-row'))),
    contextWindow:padded(panel.locator('.context-window-detail')),
  });
  // The symbol menus keep the panel scrolled to its shortcut list, so the
  // reference and the live menu appear side by side.
  await panel.evaluate(element => element.scrollTo(0, element.scrollHeight));
  await shot("session-shortcuts",{sessionShortcuts:padded(panel.locator('.session-shortcuts'))});
  await shot("composer-slash",{slashMenu:padded(await openSymbolMenu('/'))});
  await shot("composer-agent",{agentMenu:padded(await openSymbolMenu('@'))});
  const hashMenu = padded(await openSymbolMenu('#'));
  await shot("composer-hash",{hashMenu,composerField:padded(page.locator('.composer'))});
  await shot("composer-skill",{skillMenu:padded(await openSymbolMenu('$'))});
  await shot("composer-automation",{automationMenu:padded(await openSymbolMenu('>'))});
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

// Every target gets the same small margin so highlight borders never sit on
// flush-left text.
function padAll(targets) {
  return Object.fromEntries(Object.entries(targets).map(([key, target]) => [key, padded(target)]));
}
// Scrolls the element's nearest scroller so its top edge sits at `top`.
async function scrollToY(locator, top = 0) {
  await locator.evaluate((element, offset) => {
    let scroller = element.parentElement;
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) {
      scroller = scroller.parentElement;
    }
    (scroller || document.scrollingElement).scrollTop += element.getBoundingClientRect().top - offset;
  }, top);
  await page.waitForTimeout(300);
}
function consolePanel(title) {
  return page.locator('.panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}
async function auditFrames() {
  const owner = role === 'owner';
  await page.goto(APP + (owner ? '/platform/audit' : '/admin/audit'));
  const board = page.locator('.audit-summary-board');
  await board.waitFor();
  const listLayout = board.getByRole('radio', { name: 'List', exact: true });
  if (await listLayout.getAttribute('aria-checked') !== 'true') await listLayout.click();
  await shot("audit", padAll(owner
    ? { auditAttention: page.locator('.audit-summary-attention'), auditSignalBoard: board }
    : { auSignals: board }));
  const insights = page.locator('.audit-insights');
  const insightsPanel = page.locator('.panel').filter({ has: insights });
  const byDay = insights.locator('.audit-chart-card[aria-label="Audit events by day"]');
  if (!await byDay.locator('button.audit-chart-slot').count()) throw new Error('Audit Insights needs synthetic audit events in range.');
  if (!await insights.locator('.audit-chart-card[aria-label="Alert breakdown"] .audit-bar-row').count()) throw new Error('Audit Insights needs at least one synthetic security alert.');
  await scrollToY(insightsPanel, 0);
  const trends = unionTarget(insights.locator('.audit-insights-toolbar'), byDay);
  await shot("audit-insights", padAll(owner ? { auditInsightsTrends: trends } : { auInsights: trends }));
  if (owner) {
    const people = insights.locator('.audit-chart-card[aria-label="Most active people"]');
    await scrollToY(people, 16);
    await shot("audit-insights-activity", padAll({ auditInsightsPeople: unionTarget(people, insights.locator('.audit-chart-card[aria-label="Activity by area"]'), insights.locator('.audit-chart-card[aria-label="Activity by hour"]')) }));
  }
  // A chart mark opens the same investigation as a signal; today's column
  // holds the real flagged prompts and sign-ins from this fixture.
  await scrollToY(insightsPanel, 0);
  await byDay.locator('button.audit-chart-slot').last().click();
  const dialog = page.locator('.audit-investigation-modal');
  await dialog.waitFor();
  await shot("audit-investigation", padAll(owner ? { auditInvestigation: dialog } : { auInvestigation: dialog }));
  await dialog.getByRole('button', { name: /^Close .* investigation$/ }).click();
  if (owner) {
    const alertsPanel = await expandPanel('Security Alerts');
    const alertList = alertsPanel.locator('.security-alert-list');
    await alertList.waitFor();
    await scrollToY(alertsPanel, 0);
    await shot("audit-alerts", padAll({ auditSecurityAlerts: unionTarget(alertsPanel.locator("[aria-label='Security alert filter']"), alertList) }));
  } else {
    const prompts = await expandPanel('User Prompt Activity');
    await prompts.locator("[aria-label='Prompt activity filter']").waitFor();
    await scrollToY(prompts, 0);
    await shot("audit-alerts", padAll({ auPromptSelect: prompts.locator("[aria-label='Prompt activity filter']") }));
  }
  const trail = await expandPanel('Audit Trail');
  const filters = trail.locator('.audit-filter-toolbar');
  await filters.waitFor();
  await scrollToY(trail, 0);
  await shot("audit-trail", padAll(owner
    ? { trailFilters: filters, trailRows: trail.locator('[aria-label="Export audit trail CSV"]') }
    : { auTrailFilters: filters }));
}
async function runAudit() {
  for (const audience of ['admin', 'owner']) {
    role = audience; await open(audience);
    await auditFrames();
    await browser.close();
  }
}
async function alertsFrames() {
  const owner = role === 'owner';
  await page.goto(APP + (owner ? '/platform/alerts' : '/admin/alerts'));
  const email = consolePanel('Email Delivery');
  const rules = consolePanel('Alert Rules');
  const deliveries = consolePanel('Alert Deliveries');
  await deliveries.locator('.alert-notification-row, [role="listitem"]').first().waitFor();
  if (!await deliveries.getByText('sent', { exact: true }).count()) throw new Error('The alerts fixture needs at least one real sent delivery.');
  if (owner) {
    await shot("alerts", padAll({ alertSmtp: email }));
    await scrollToY(rules, 0);
    await shot("alerts-deliveries", padAll({
      alertRules: rules,
      alertTemplates: rules.locator('.panel-actions'),
      alertDeliveries: page.locator("[role='list'][aria-label='Alert deliveries']"),
    }));
  } else {
    await shot("alerts", padAll({ alEmail: email, alRules: rules, alDeliveries: deliveries }));
  }
  // The template only prefills the form; it is cancelled without saving.
  await rules.getByRole('button', { name: 'Prompt-injection template', exact: true }).click();
  const form = page.locator('.alert-rule-form');
  const detections = form.locator('.alert-detection-field');
  await detections.waitFor();
  await scrollToY(form, 90);
  const box = await detections.boundingBox();
  if (box.y + box.height > 845) await scrollToY(form, 90 - (box.y + box.height - 845));
  await shot("alerts-rule-form", padAll(owner
    ? { alertRuleForm: form, alertDetections: detections }
    : { alRuleForm: form, alRuleDetections: detections }));
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
}
async function runAlerts() {
  for (const audience of ['admin', 'owner']) {
    role = audience; await open(audience);
    await alertsFrames();
    await browser.close();
  }
}
async function runElastic() {
  role = 'owner'; await open('owner');
  await page.goto(APP + '/platform/org-settings');
  const panel = await expandPanel('Elastic Analytics');
  await panel.locator('.elastic-stream-table').waitFor();
  if (!await panel.locator('.elastic-card').getByText('Connected', { exact: true }).count()) {
    throw new Error('Save a reachable synthetic Elastic cluster before capturing.');
  }
  const keyHelp = panel.locator('.elastic-key-help');
  await keyHelp.locator('summary').click();
  await scrollToY(panel, 0);
  await shot("elastic-connection", padAll({
    elasticStatus: panel.locator('.elastic-card'),
    elasticConnection: panel.locator('.elastic-section').first(),
  }));
  await keyHelp.locator('summary').click();
  await scrollToY(panel.locator('.elastic-section').nth(1), 24);
  await shot("elastic-streams", padAll({
    elasticStreams: panel.locator('.elastic-toggle-list'),
    elasticActions: panel.locator('.elastic-actions'),
  }));
  await panel.getByRole('button', { name: 'Check connection', exact: true }).click();
  const checks = panel.locator('.elastic-check-list');
  await checks.waitFor({ timeout: 60000 });
  await scrollToY(panel.locator('.elastic-actions'), 330);
  await shot("elastic-checks", padAll({ elasticChecks: unionTarget(panel.locator('.elastic-notice'), checks) }));
  await scrollToY(panel.locator('.elastic-section:has(.elastic-stream-table)'), 120);
  await shot("elastic-delivery", padAll({
    elasticDelivery: panel.locator('.elastic-stream-table'),
    elasticKibana: panel.locator('.elastic-kibana-row'),
  }));
  await browser.close();
}
async function runOpen() {
  role = 'user'; await open('user');
  await page.getByRole('link', { name: 'Drafts', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document body', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Attach file', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Add draft attachment' });
  await menu.waitFor();
  await shot("draft-open-menu", padAll({
    draftOpenFromDevice: unionTarget(menu.locator('.attach-menu-label').first(), menu.locator('.attach-option-row')),
  }));
  const file = path.join(OUT, OPEN_FILE_NAME);
  fs.writeFileSync(file, OPEN_FILE_TEXT);
  const chooser = page.waitForEvent('filechooser');
  await menu.getByRole('menuitem', { name: /Open in editor/ }).click();
  await (await chooser).setFiles(file);
  const note = page.locator('.draft-event').filter({ hasText: `Opened ${OPEN_FILE_NAME} in the editor.` });
  await note.waitFor();
  const body = page.getByRole('textbox', { name: 'Document body', exact: true });
  await body.getByText('Review steps', { exact: true }).waitFor();
  await page.waitForTimeout(1000);
  await shot("draft-opened-file", padAll({ draftOpenedFile: note, draftOpenedDocument: body }));
  await browser.close();
}

async function main() {
  APP = origin("CAPTURE_APP_URL");
  API = origin("CAPTURE_API_URL");
  if (process.env.CAPTURE_MUTATION_ACK !== "isolated-synthetic") throw new Error("CAPTURE_MUTATION_ACK=isolated-synthetic is required.");
  const parts = (process.argv[2] || "user,admin,owner").split(",");
  if (parts.some(part => !Object.hasOwn(EXPECTED, part)) || new Set(parts).size !== parts.length) throw new Error("Choose user, drafts, admin, owner, more, symbols, audit, alerts, elastic, or open, each at most once.");
  const work = path.join(__dirname, "../../../tmp/training-captures");
  fs.mkdirSync(work, { recursive: true });
  OUT = fs.mkdtempSync(path.join(work, "capture-training-refresh-"));
  saveManifest();
  try {
    for (const part of parts) {
      currentMode = part;
      await ({ user: runUser, drafts: runDrafts, admin: runAdmin, owner: runOwner, more: runMore, symbols: runSymbols,
        audit: runAudit, alerts: runAlerts, elastic: runElastic, open: runOpen })[part]();
      const audience = ["more", "drafts", "symbols", "open"].includes(part) ? "user" : part;
      // Multi-role modes list role-qualified frame names.
      if (EXPECTED[part].some(name => !manifest.frames[name.includes("/") ? name : `${audience}/${name}`])) throw new Error(`Incomplete ${part} frame batch.`);
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
