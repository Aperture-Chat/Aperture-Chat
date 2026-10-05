/* Organization policy, the workspace budget, shared connectors, and the
 * search index, performed for real on the synthetic instance. Run each module
 * from a freshly reset instance.
 *
 * owner-policies turns Downstream API access on and shows the API access card
 * that appears for an administrator; sets a tiny daily token ceiling, records
 * the real refusal a user then receives, and sets the ceiling back to
 * unlimited.
 *
 * owner-connectors configures Web Search (DuckDuckGo, tested live) and a keyed
 * engine without a key; and saves and tests Google Drive, OneDrive /
 * SharePoint, Box, and iManage with synthetic identifiers, recording the real
 * result each test returns. Vendor consent screens are taught with
 * instruction cards. Secret fields hold random placeholders typed only after
 * each frame, so every frame shows them empty.
 *
 * owner-search-index reads the index status and runs a real rebuild.
 */
const crypto = require("node:crypto");

const placeholder = (prefix) => `${prefix}-${crypto.randomBytes(9).toString("hex")}`;

function selectIn(scope, label) {
  return scope.locator("label").filter({ hasText: new RegExp(`^\\s*${label}`) }).locator("select").first();
}

async function scrollTo(page, locator, block = "center") {
  await locator.evaluate((element, where) => element.scrollIntoView({ block: where }), block);
  await page.waitForTimeout(350);
}

async function expand(page, title) {
  const panel = page.locator(".panel").filter({ has: page.locator(".panel-header h2", { hasText: title }) }).first();
  await panel.waitFor();
  const toggle = panel.locator(".panel-collapse-button").first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.waitForTimeout(500);
  return panel;
}

const policies = {
  role: "owner",
  description: "Change a policy and see its effect, then set a workspace budget and record the real refusal.",
  frames: [
    "owner/pc-overview", "owner/pc-policy-toggles", "owner/pc-policy-saved", "owner/pc-api-access",
    "owner/pc-budget-panel", "owner/pc-budget-usd", "owner/pc-budget-saved", "owner/pc-budget-blocked", "owner/pc-budget-unlimited",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("owner", "/platform/org-settings");
    await page.locator(".search-index-card").waitFor();
    await page.waitForTimeout(600);
    // Every Org Settings panel, collapsed.
    await scrollTo(page, page.locator(".owner-control-panel"), "start");
    await shot("pc-overview");

    // Policy Controls: the ceiling for the whole organization.
    const policy = await expand(page, "Policy Controls");
    await scrollTo(page, policy, "start");
    await shot("pc-policy-toggles");
    const api = policy.getByRole("switch", { name: "Downstream API access" });
    if ((await api.getAttribute("aria-checked")) === "true") throw new Error("Start with Downstream API access off.");
    await api.click();
    await page.getByText("Downstream API access is enabled for owners and admins. Standard users still require an administrator grant.").waitFor();
    await page.waitForTimeout(600);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await shot("pc-policy-saved");

    // The effect: an administrator now has API access in their account panel.
    const admin = kit.use(await kit.app("admin", "/"));
    await admin.getByRole("button", { name: /^Account:/ }).click();
    const card = admin.locator(".account-api-card");
    await card.waitFor();
    await card.locator("summary").click();
    await admin.waitForTimeout(600);
    await scrollTo(admin, card, "center");
    await shot("pc-api-access");

    // Workspace Usage Budget.
    kit.use(page);
    const budget = await expand(page, "Workspace Usage Budget");
    await scrollTo(page, budget, "start");
    await shot("pc-budget-panel");
    await budget.getByLabel("Budget measure").selectOption("usd");
    await budget.getByLabel("Dollar budget limit").waitFor();
    await page.waitForTimeout(400);
    await shot("pc-budget-usd");
    await budget.getByLabel("Budget measure").selectOption("tokens");
    await budget.getByLabel("Budget reset period").selectOption("day");
    await budget.getByLabel("Token budget limit").fill("1000");
    await budget.getByRole("button", { name: "Save budget policy" }).click();
    await budget.getByText(/Workspace ceiling saved at 1,000 tokens/).waitFor();
    await page.waitForTimeout(600);
    await shot("pc-budget-saved");

    // A person's next message is refused with the real budget message.
    const user = kit.use(await kit.app("user", "/"));
    await user.getByRole("textbox", { name: "Message" }).fill("Summarize this week's open action items.");
    await user.getByRole("button", { name: "Send message" }).click();
    // The client currently retries a 429 for several minutes before it shows
    // the refusal (reported as a product issue); wait for the real message.
    await user.getByText(/The workspace daily token budget has been reached/).first().waitFor({ timeout: 480000 });
    await user.waitForTimeout(1200);
    await shot("pc-budget-blocked");

    // Back to unlimited.
    kit.use(page);
    await page.reload();
    await page.getByRole("navigation", { name: "Primary" }).waitFor();
    const again = await expand(page, "Workspace Usage Budget");
    await again.getByLabel("Token budget limit").fill("0");
    await again.getByRole("button", { name: "Save budget policy" }).click();
    await again.getByText("Workspace ceiling saved as unlimited. Admin user and group allocations still apply.").waitFor();
    await page.waitForTimeout(600);
    await scrollTo(page, again, "start");
    await shot("pc-budget-unlimited");
  },
};

async function connectorBlock(page, panel, name) {
  const block = panel.locator(".connector-config-block").filter({ has: page.locator(".connector-row-name", { hasText: new RegExp(`^${name}$`) }) });
  await block.waitFor();
  return block;
}

async function configure(page, panel, name) {
  const block = await connectorBlock(page, panel, name);
  if ((await block.getByRole("button", { name: "Configure" }).getAttribute("aria-expanded")) !== "true") {
    await block.getByRole("button", { name: "Configure" }).click();
  }
  const form = block.locator(".connector-config-form");
  await form.waitFor();
  return { block, form };
}

async function fillFields(form, values) {
  for (const [label, value] of Object.entries(values)) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await form.locator("label").filter({ has: form.page().locator(".connector-field-label", { hasText: new RegExp(`^${escaped}\\s*\\*?$`) }) }).locator("input").first().fill(value);
  }
}

async function secretField(form) {
  return form.locator("input[type='password']").first();
}

async function saveAndTest(page, form) {
  await form.getByRole("button", { name: "Save configuration" }).click();
  const test = form.getByRole("button", { name: "Test connection" });
  // Test connection unlocks once the saved configuration exists.
  for (let i = 0; i < 80; i += 1) {
    if (!(await test.isDisabled())) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(600);
  await test.click();
  await form.locator(".sso-test-result").waitFor({ timeout: 60000 });
  for (let i = 0; i < 120 && /Testing/.test(await test.innerText()); i += 1) await page.waitForTimeout(250);
  await page.waitForTimeout(800);
  return (await form.locator(".sso-test-result").innerText()).trim();
}

async function closeConfigure(block) {
  const button = block.getByRole("button", { name: "Configure" });
  if ((await button.getAttribute("aria-expanded")) === "true") await button.click();
}

const connectors = {
  role: "owner",
  description: "Configure and test Web Search, Google Drive, OneDrive / SharePoint, Box, and iManage.",
  frames: [
    "owner/cn-panel", "owner/cn-web-tested", "owner/cn-web-keyed", "owner/cn-gdrive-form", "owner/cn-gdrive-tested",
    "owner/cn-graph-form", "owner/cn-graph-tested", "owner/cn-box-tested", "owner/cn-imanage-tested",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("owner", "/platform/org-settings");
    const panel = await expand(page, "Connectors");
    await scrollTo(page, panel, "start");
    await shot("cn-panel");

    // Web Search: DuckDuckGo needs no key; the test runs a real query.
    let { block, form } = await configure(page, panel, "Web Search");
    await selectIn(form, "Search engine").selectOption("duckduckgo");
    let web = await saveAndTest(page, form);
    // DuckDuckGo rate-limits automated queries; a real retry is what a person would do.
    for (let attempt = 0; attempt < 4 && /failed/i.test(web); attempt += 1) {
      await page.waitForTimeout(20000);
      await form.getByRole("button", { name: "Test connection" }).click();
      await page.waitForTimeout(1500);
      for (let i = 0; i < 120 && /Testing/.test(await form.getByRole("button", { name: /Test connection|Testing/ }).innerText()); i += 1) await page.waitForTimeout(250);
      await page.waitForTimeout(800);
      web = (await form.locator(".sso-test-result").innerText()).trim();
    }
    console.log(`  web search test: ${web.split("\n")[0].slice(0, 160)}`);
    await scrollTo(page, block, "start");
    await shot("cn-web-tested");
    // A keyed engine reuses a provider key; this workspace has no OpenAI key.
    await selectIn(form, "Search engine").selectOption("openai");
    await saveAndTest(page, form);
    await scrollTo(page, block, "start");
    await shot("cn-web-keyed");
    await selectIn(form, "Search engine").selectOption("duckduckgo");
    await form.getByRole("button", { name: "Save configuration" }).click();
    await page.waitForTimeout(1200);
    await closeConfigure(block);

    // Google Drive: OAuth client fields, saved and tested.
    ({ block, form } = await configure(page, panel, "Google Drive"));
    await selectIn(form, "Authentication method").selectOption("oauth-client");
    await fillFields(form, {
      "OAuth client ID": "000000000000-examplecorp.apps.googleusercontent.com",
      "Drive folder ID": "1ExampleFolderIdForPolicyLibrary",
      "Source label": "Policy Library",
    });
    await scrollTo(page, block, "start");
    await shot("cn-gdrive-form");
    await (await secretField(form)).fill(placeholder("synthetic-secret"));
    await saveAndTest(page, form);
    await scrollTo(page, form.locator(".connector-config-actions"), "start");
    await page.evaluate(() => window.scrollBy(0, -220));
    await page.waitForTimeout(300);
    await shot("cn-gdrive-tested");
    await closeConfigure(block);

    // OneDrive / SharePoint through Microsoft Graph, app-only.
    ({ block, form } = await configure(page, panel, "OneDrive / SharePoint / Outlook"));
    await selectIn(form, "Authentication method").selectOption("client-credentials");
    await fillFields(form, {
      "Directory (tenant) ID": "11111111-2222-3333-4444-555555555555",
      "Application (client) ID": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    await scrollTo(page, block, "start");
    await shot("cn-graph-form");
    await (await secretField(form)).fill(placeholder("synthetic-secret"));
    await saveAndTest(page, form);
    await scrollTo(page, form.locator(".connector-config-actions"), "start");
    await page.evaluate(() => window.scrollBy(0, -220));
    await page.waitForTimeout(300);
    await shot("cn-graph-tested");
    await closeConfigure(block);

    // Box: Client Credentials Grant.
    ({ block, form } = await configure(page, panel, "Box"));
    await selectIn(form, "Authentication method").selectOption("client-credentials");
    await fillFields(form, { "Client ID": "examplecorpboxclient000000000000", "Enterprise ID": "123456", "Folder ID": "12345" });
    await (await secretField(form)).fill(placeholder("synthetic-secret"));
    await saveAndTest(page, form);
    await scrollTo(page, block, "start");
    await shot("cn-box-tested");
    await closeConfigure(block);

    // iManage: each person signs in; the test explains how verification finishes.
    ({ block, form } = await configure(page, panel, "iManage"));
    await selectIn(form, "Authentication method").selectOption("oauth-client");
    await fillFields(form, { "Instance URL": "https://imanage.example.com", "API key (client ID)": "examplecorp-aperture", "Customer ID": "100", "Library ID": "ACTIVE" });
    await (await secretField(form)).fill(placeholder("synthetic-secret"));
    await saveAndTest(page, form);
    await scrollTo(page, form.locator(".connector-config-actions"), "start");
    await page.evaluate(() => window.scrollBy(0, -260));
    await page.waitForTimeout(300);
    await shot("cn-imanage-tested");
  },
};

async function searchAs(page, term) {
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search past work" });
  await palette.waitFor();
  await palette.getByLabel("Search chat titles, messages, agents, drafts, and documents").fill(term);
  await page.waitForTimeout(2000);
  return palette;
}

const searchIndex = {
  role: "owner",
  description: "Read the search index status, run a real rebuild, and check search results as a person.",
  frames: ["owner/si-status", "owner/si-rebuilt", "owner/si-user-results", "owner/si-user-private"],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("owner", "/platform/org-settings");
    const card = page.locator(".search-index-card");
    await card.locator(".search-index-tenants").waitFor();
    await page.waitForTimeout(800);
    await shot("si-status");
    await card.getByRole("button", { name: "Rebuild index" }).click();
    await card.getByText(/^Rebuilt \d+ index entr(y|ies) from live records\.$/).waitFor({ timeout: 120000 });
    await page.waitForTimeout(800);
    await shot("si-rebuilt");

    // A person searches: results come only from records they may open.
    const user = kit.use(await kit.app("user", "/"));
    let palette = await searchAs(user, "vendor");
    await palette.locator("[role='option']").first().waitFor();
    await shot("si-user-results", { keepFocus: true });
    await user.keyboard.press("Escape");
    // The owner's private chat is indexed too, but this person cannot see it.
    palette = await searchAs(user, "Northwind");
    await user.waitForTimeout(800);
    if (await palette.locator("[role='option']").filter({ hasText: "Northwind" }).count()) throw new Error("Search showed another person's private chat.");
    await shot("si-user-private", { keepFocus: true });
  },
};

module.exports = { "owner-policies": policies, "owner-connectors": connectors, "owner-search-index": searchIndex };
