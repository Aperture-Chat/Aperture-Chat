/* Workspace connectors in the Admin console › Connections, performed for real.
 *
 * Inputs: CAPTURE_SEARXNG_URL, the address of a real local SearXNG instance
 * (JSON output enabled) that the API can reach.
 *
 * admin-connectors: read the Connectors panel; turn Web Search on (it starts
 * off, as setup), configure and save it, and run real test searches with
 * DuckDuckGo and with SearXNG; choose a keyed engine and record the real
 * result; save and test Google Drive,
 * OneDrive / SharePoint (Microsoft Graph), Box, and iManage with synthetic
 * identifiers, recording the real answer each test returns (vendor consoles
 * are taught with instruction cards); hide Box and confirm from a person's
 * paperclip menu that it is gone, then show it again; and record what the
 * admin sees when the service team turns a source off for every workspace
 * (set through the platform API as setup, then restored).
 *
 * Secret fields hold random placeholders typed only after each frame that
 * shows the form, and a successful save clears them, so every frame shows
 * them empty. Tests run from the API to the real vendor endpoints; with
 * synthetic identifiers they return the vendors' real rejections.
 */
const crypto = require("node:crypto");
const { helpers } = require("./admin-shared.cjs");

const { scrollTo, toast, dismissToast, openTab } = helpers;
const placeholder = (prefix) => `${prefix}-${crypto.randomBytes(9).toString("hex")}`;

function selectIn(scope, label) {
  return scope.locator("label").filter({ hasText: new RegExp(`^\\s*${label}`) }).locator("select").first();
}

async function connectorsPanel(page) {
  const panel = page.locator(".panel").filter({ has: page.locator(".panel-header h2", { hasText: /^Connectors$/ }) }).first();
  await panel.waitFor();
  return panel;
}

async function connectorBlock(page, panel, name) {
  const block = panel.locator(".connector-config-block").filter({ has: page.locator(".connector-row-name", { hasText: new RegExp(`^${name.replace(/[/]/g, "\\/")}$`) }) });
  await block.waitFor();
  return block;
}

async function configure(page, panel, name) {
  const block = await connectorBlock(page, panel, name);
  const button = block.getByRole("button", { name: "Configure" });
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const form = block.locator(".connector-config-form");
  await form.waitFor();
  return { block, form };
}

async function closeConfigure(block) {
  const button = block.getByRole("button", { name: "Configure" });
  if ((await button.getAttribute("aria-expanded")) === "true") await button.click();
}

async function fillFields(form, values) {
  for (const [label, value] of Object.entries(values)) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await form.locator("label").filter({ has: form.page().locator(".connector-field-label", { hasText: new RegExp(`^${escaped}\\s*\\*?$`) }) }).locator("input").first().fill(value);
  }
}

/** Save configuration, then Test connection once the saved record exists. */
async function saveAndTest(page, form, name) {
  await form.getByRole("button", { name: "Save configuration" }).click();
  await toast(page, `${name} configuration saved.`);
  const test = form.getByRole("button", { name: /Test connection|Testing/ });
  for (let i = 0; i < 80 && (await test.isDisabled()); i += 1) await page.waitForTimeout(250);
  await page.waitForTimeout(400);
  return retest(page, form);
}

async function retest(page, form) {
  const test = form.getByRole("button", { name: /Test connection|Testing/ });
  await test.click();
  await form.locator(".sso-test-result").waitFor({ timeout: 90000 });
  for (let i = 0; i < 240 && /Testing/.test(await test.innerText()); i += 1) await page.waitForTimeout(250);
  await page.waitForTimeout(800);
  return (await form.locator(".sso-test-result").innerText()).trim();
}

/** The person's paperclip menu in a fresh chat; returns the open menu. */
async function openAttachMenu(kit) {
  const person = await kit.app("user", "/");
  await person.getByRole("button", { name: "New chat" }).first().click().catch(() => {});
  await person.getByRole("button", { name: "Add attachment" }).first().click();
  const menu = person.getByRole("menu", { name: "Add attachment" });
  await menu.waitFor();
  await person.waitForTimeout(400);
  return { person, menu };
}

const adminConnectors = {
  role: "admin",
  description: "Turn a source on, configure and test each connector, hide a cloud source from people, and the off-for-all state.",
  frames: [
    "admin/cn-panel", "admin/cn-web-on", "admin/cn-web-tested", "admin/cn-web-searxng", "admin/cn-web-keyed",
    "admin/cn-gdrive-form", "admin/cn-gdrive-tested", "admin/cn-graph-form", "admin/cn-graph-tested",
    "admin/cn-box-tested", "admin/cn-imanage-tested", "admin/cn-user-attach", "admin/cn-box-hidden",
    "admin/cn-user-attach-hidden", "admin/cn-box-shown", "admin/cn-off-for-all",
  ],
  async run(kit) {
    const { shot } = kit;
    // Setup: every connector allowed for the deployment, Box shown, and Web
    // Search switched off in this workspace so it can be turned on below.
    for (const connector of await kit.api("owner", "GET", "/api/admin/connectors")) {
      if (connector.platform_enabled === false) {
        await kit.api("owner", "PATCH", `/api/platform/connectors/${connector.id}`, { platform_enabled: true, tenant_enabled: true });
      }
    }
    const tenantId = (await kit.api("admin", "GET", "/api/admin/groups"))[0].tenant_id;
    const records = await kit.api("admin", "GET", "/api/admin/connector-configs");
    const web = records.find((record) => record.connector_id === "web" && record.tenant_id === tenantId);
    if (web) await kit.api("admin", "PATCH", `/api/admin/connector-configs/${web.id}`, { enabled: false, settings: { engine: "duckduckgo", max_results: 5 } });
    else await kit.api("admin", "POST", "/api/admin/connector-configs", { connector_id: "web", tenant_id: tenantId, enabled: false, settings: { engine: "duckduckgo", max_results: 5 } });
    for (const record of records) {
      if (record.connector_id === "box" && record.tenant_id === tenantId && record.hidden) {
        await kit.api("admin", "PATCH", `/api/admin/connector-configs/${record.id}`, { hidden: false });
      }
    }

    // 1. Admin console › Connections › Connectors.
    const page = kit.use(await kit.app("admin", "/admin/users"));
    await openTab(page, "Connections");
    const panel = await connectorsPanel(page);
    await shot("cn-panel");

    // 2. Turn Web Search on for everyone in the workspace.
    const webBlock = await connectorBlock(page, panel, "Web Search");
    await webBlock.getByRole("switch", { name: "Enable Web Search" }).click();
    await toast(page, "Web Search is now on for everyone in this workspace.");
    if ((await webBlock.getByRole("switch", { name: "Enable Web Search" }).getAttribute("aria-checked")) !== "true") {
      throw new Error("Web Search did not switch on.");
    }
    await scrollTo(page, webBlock, "center");
    await shot("cn-web-on");
    await dismissToast(page);

    // 3. Configure Web Search: DuckDuckGo needs no key; the test runs a real query.
    let { block, form } = await configure(page, panel, "Web Search");
    await selectIn(form, "Search engine").selectOption("duckduckgo");
    let result = await saveAndTest(page, form, "Web Search");
    // DuckDuckGo limits automated queries; retrying a little later is what a person would do.
    for (let attempt = 0; attempt < 4 && /failed/i.test(result); attempt += 1) {
      await page.waitForTimeout(20000);
      result = await retest(page, form);
    }
    console.log(`  web search test: ${result.split("\n")[0].slice(0, 200)}`);
    await dismissToast(page);
    await scrollTo(page, block, "start");
    await shot("cn-web-tested");

    // SearXNG: the workspace's own search instance (a real local SearXNG for
    // this capture, given in CAPTURE_SEARXNG_URL), searched for real.
    await selectIn(form, "Search engine").selectOption("searxng");
    await form.locator("label").filter({ hasText: /^\s*SearXNG instance URL/ }).locator("input").fill(kit.env("CAPTURE_SEARXNG_URL"));
    result = await saveAndTest(page, form, "Web Search");
    console.log(`  searxng test: ${result.split("\n")[0].slice(0, 200)}`);
    if (!/Web search is working through searxng/.test(result)) throw new Error(`The SearXNG test did not pass: ${result}`);
    await dismissToast(page);
    await scrollTo(page, block, "start");
    await shot("cn-web-searxng");

    // A keyed engine reuses that provider's key for the workspace.
    await selectIn(form, "Search engine").selectOption("openai");
    result = await saveAndTest(page, form, "Web Search");
    console.log(`  keyed engine test: ${result.split("\n")[0].slice(0, 200)}`);
    await dismissToast(page);
    await scrollTo(page, block, "start");
    await shot("cn-web-keyed");
    await selectIn(form, "Search engine").selectOption("duckduckgo");
    await form.getByRole("button", { name: "Save configuration" }).click();
    await toast(page, "Web Search configuration saved.");
    await dismissToast(page);
    await closeConfigure(block);

    // 4. Google Drive: OAuth client fields, saved and tested.
    ({ block, form } = await configure(page, panel, "Google Drive"));
    await selectIn(form, "Authentication method").selectOption("oauth-client");
    await fillFields(form, {
      "OAuth client ID": "000000000000-examplecorp.apps.googleusercontent.com",
      "Drive folder ID": "1ExampleFolderIdForPolicyLibrary",
      "Source label": "Policy Library",
    });
    await scrollTo(page, block, "start");
    await shot("cn-gdrive-form");
    await form.locator("input[type='password']").first().fill(placeholder("synthetic-secret"));
    result = await saveAndTest(page, form, "Google Drive");
    console.log(`  google drive test: ${result.split("\n")[0].slice(0, 200)}`);
    await dismissToast(page);
    await scrollTo(page, form.locator(".connector-config-actions"), "start");
    await page.evaluate(() => window.scrollBy(0, -260));
    await page.waitForTimeout(300);
    await shot("cn-gdrive-tested");
    await closeConfigure(block);

    // 5. OneDrive / SharePoint through Microsoft Graph, app-only.
    ({ block, form } = await configure(page, panel, "OneDrive / SharePoint / Outlook"));
    await selectIn(form, "Authentication method").selectOption("client-credentials");
    await fillFields(form, {
      "Directory (tenant) ID": "11111111-2222-3333-4444-555555555555",
      "Application (client) ID": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "SharePoint site ID": "",
      "Drive ID": "",
      "Root folder / item ID": "",
    });
    await scrollTo(page, block, "start");
    await shot("cn-graph-form");
    await form.locator("input[type='password']").first().fill(placeholder("synthetic-secret"));
    result = await saveAndTest(page, form, "OneDrive / SharePoint / Outlook");
    console.log(`  graph test: ${result.split("\n")[0].slice(0, 200)}`);
    await dismissToast(page);
    await scrollTo(page, form.locator(".connector-config-actions"), "start");
    await page.evaluate(() => window.scrollBy(0, -260));
    await page.waitForTimeout(300);
    await shot("cn-graph-tested");
    await closeConfigure(block);

    // 6. Box: Client Credentials Grant.
    ({ block, form } = await configure(page, panel, "Box"));
    await selectIn(form, "Authentication method").selectOption("client-credentials");
    await fillFields(form, { "Client ID": "examplecorpboxclient000000000000", "Enterprise ID": "123456", "Folder ID": "12345" });
    await form.locator("input[type='password']").first().fill(placeholder("synthetic-secret"));
    result = await saveAndTest(page, form, "Box");
    console.log(`  box test: ${result.split("\n")[0].slice(0, 200)}`);
    await dismissToast(page);
    await scrollTo(page, block, "start");
    await shot("cn-box-tested");
    await closeConfigure(block);

    // 7. iManage: each person signs in; the test explains how verification finishes.
    ({ block, form } = await configure(page, panel, "iManage"));
    await selectIn(form, "Authentication method").selectOption("oauth-client");
    await fillFields(form, {
      "Instance URL": "https://imanage.example.com",
      "API key (client ID)": "examplecorp-aperture",
      "Customer ID": "100",
      "Library ID": "ACTIVE",
    });
    await form.locator("input[type='password']").first().fill(placeholder("synthetic-secret"));
    result = await saveAndTest(page, form, "iManage");
    console.log(`  imanage test: ${result.split("\n")[0].slice(0, 200)}`);
    await dismissToast(page);
    await scrollTo(page, form.locator(".connector-config-actions"), "start");
    await page.evaluate(() => window.scrollBy(0, -300));
    await page.waitForTimeout(300);
    await shot("cn-imanage-tested");
    await closeConfigure(block);

    // 8. What a person sees: every cloud source in the paperclip menu.
    let { person, menu } = await openAttachMenu(kit);
    if (!(await menu.getByRole("menuitem", { name: "Box" }).count())) throw new Error("Box is missing from the attach menu before hiding.");
    kit.use(person);
    await shot("cn-user-attach");
    await person.close();

    // 9. Hide Box: its switch and credentials stay as they are.
    kit.use(page);
    const boxBlock = await connectorBlock(page, panel, "Box");
    await boxBlock.getByRole("button", { name: "Hide Box from the attach menu" }).click();
    await toast(page, "Box is hidden. People in this workspace no longer see it in the attach menu.");
    await boxBlock.getByText("Hidden", { exact: true }).waitFor();
    await scrollTo(page, boxBlock, "center");
    await shot("cn-box-hidden");
    await dismissToast(page);

    // 10. The person's menu no longer offers Box.
    ({ person, menu } = await openAttachMenu(kit));
    if (await menu.getByRole("menuitem", { name: "Box" }).count()) throw new Error("Box still shows in the attach menu after hiding.");
    kit.use(person);
    await shot("cn-user-attach-hidden");
    await person.close();

    // 11. Show it again.
    kit.use(page);
    await boxBlock.getByRole("button", { name: "Show Box in the attach menu" }).click();
    await toast(page, "Box is back in the attach menu for people in this workspace.");
    await boxBlock.getByText("Hidden", { exact: true }).waitFor({ state: "detached" });
    await scrollTo(page, boxBlock, "center");
    await shot("cn-box-shown");
    await dismissToast(page);

    // 12. Setup: the service team turns Google Drive off for every workspace
    //     (the platform ceiling, set through the platform API). The admin's row
    //     shows it and the switch is locked. Restored afterwards.
    await kit.api("owner", "PATCH", "/api/platform/connectors/google-drive", { platform_enabled: false });
    try {
      await page.reload();
      await page.getByRole("tablist", { name: "Admin sections" }).waitFor();
      await openTab(page, "Connections");
      const locked = await connectorBlock(page, await connectorsPanel(page), "Google Drive");
      await locked.getByText("Off for all workspaces", { exact: true }).waitFor();
      const lockedSwitch = locked.getByRole("switch", { name: "Enable Google Drive" });
      if (!(await lockedSwitch.isDisabled()) || (await lockedSwitch.getAttribute("aria-checked")) !== "false") {
        throw new Error("Google Drive's switch is not off and locked under the closed ceiling.");
      }
      await scrollTo(page, locked, "center");
      await shot("cn-off-for-all");
      // Recorded for the report, not captured: does the paperclip still list it?
      const check = await openAttachMenu(kit);
      console.log(`  attach menu lists Google Drive while off for all: ${Boolean(await check.menu.getByRole("menuitem", { name: "Google Drive" }).count())}`);
      await check.person.close();
    } finally {
      await kit.api("owner", "PATCH", "/api/platform/connectors/google-drive", { platform_enabled: true, tenant_enabled: true });
    }
  },
};

module.exports = { "admin-connectors": adminConnectors };
