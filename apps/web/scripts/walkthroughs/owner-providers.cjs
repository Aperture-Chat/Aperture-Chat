/* Providers, keys, and models, performed for real on the synthetic instance.
 *
 * Input: CAPTURE_LOCAL_MODEL_URL, a local OpenAI-compatible model server the
 * API can reach (for example http://localhost:8096/v1). Run each module from a
 * freshly reset instance.
 *
 * owner-providers adds the local server and shows it connect end to end; adds
 * a wrong local address and an Ollama server with no pulled model to record
 * the real failures; types each cloud vendor's connection into the form
 * (OpenAI, Anthropic, Azure OpenAI, OpenRouter, Google Gemini) without a key;
 * saves OpenAI with a deliberately invalid key so the real vendor rejection is
 * shown; saves Azure OpenAI and Amazon Bedrock to record the real limitation
 * messages; and deletes a provider through its confirmation dialog. Invalid
 * keys are random placeholders, never real credentials, and every key field is
 * empty in every frame.
 *
 * owner-key-vault adds, reveals, replaces, and deletes keys on the local
 * provider (whose server ignores keys, so a placeholder is honest) and adds a
 * key whose Expires date has already passed to show the expired state.
 *
 * owner-models enables and disables models, filters the catalog, and opens a
 * model's details.
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

async function providersPage(kit) {
  const page = await kit.app("owner", "/platform/providers");
  await page.locator(".provider-connections-panel").waitFor();
  await page.waitForTimeout(800);
  return page;
}

/* Open a fresh Add Provider form (reloading clears the previous draft). */
async function freshForm(page) {
  await page.reload();
  await page.locator(".provider-connections-panel").waitFor();
  await page.getByRole("button", { name: "Add Provider" }).click();
  const form = page.locator("#provider-builder-form");
  await form.waitFor();
  return form;
}

async function fill(form, values) {
  if (values.kind) await selectIn(form, "Kind").selectOption(values.kind);
  for (const [label, value] of Object.entries(values)) {
    if (label === "kind" || label === "Auth type" || label === "Catalog scope") continue;
    await form.getByLabel(label, { exact: true }).fill(value);
  }
  if (values["Auth type"]) await selectIn(form, "Auth type").selectOption(values["Auth type"]);
  if (values["Catalog scope"]) await selectIn(form, "Catalog scope").selectOption(values["Catalog scope"]);
}

async function saveWithKey(page, form, name, key) {
  if (key) await form.getByLabel("API key or secret", { exact: true }).fill(key);
  await form.getByRole("button", { name: "Save Provider" }).click();
  const card = page.locator(".provider-card").filter({ has: page.locator("h2", { hasText: new RegExp(`^${name}$`) }) });
  await card.waitFor();
  // Saving with a key syncs and tests; the form stays disabled until both finish.
  await page.waitForFunction(() => {
    const form = document.querySelector("#provider-builder-form");
    return !form || !form.disabled;
  }, null, { timeout: 240000 });
  await page.locator(".secure-notice[role='status']").waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  return card;
}

const providers = {
  role: "owner",
  description: "Connect a local server end to end, record real failures, and fill in each cloud vendor's connection.",
  frames: [
    "owner/pv-overview", "owner/pv-kind-menu", "owner/pv-local-form", "owner/pv-local-connected",
    "owner/pv-local-unreachable", "owner/pv-ollama-empty", "owner/pv-openai-form", "owner/pv-openai-rejected",
    "owner/pv-anthropic-form", "owner/pv-azure-form", "owner/pv-azure-saved", "owner/pv-openrouter-form",
    "owner/pv-gemini-form", "owner/pv-bedrock-saved", "owner/pv-edit-connection", "owner/pv-delete-dialog",
  ],
  async run(kit) {
    const { shot } = kit;
    const modelUrl = kit.env("CAPTURE_LOCAL_MODEL_URL");
    const page = await providersPage(kit);

    // Where providers live, and the kinds the form offers.
    await shot("pv-overview");
    let form = await freshForm(page);
    await scrollTo(page, form, "start");
    await selectIn(form, "Kind").click();
    await page.locator(".apx-select-menu").waitFor();
    // Show the top of the list, where the major vendors are.
    await page.keyboard.press("Home");
    await page.locator(".apx-select-menu").evaluate((menu) => { menu.scrollTop = 0; });
    await page.waitForTimeout(300);
    await shot("pv-kind-menu", { keepFocus: true });
    await page.keyboard.press("Escape");

    // Path 1: a local OpenAI-compatible server, connected for real.
    form = await freshForm(page);
    await fill(form, { kind: "openai-compatible", Name: "Team model server", Region: "On premises", "Base URL": modelUrl, "Key name": "Local server key" });
    await scrollTo(page, form, "start");
    await shot("pv-local-form");
    const local = await saveWithKey(page, form, "Team model server", placeholder("local"));
    await local.locator(".pill", { hasText: "Connected" }).waitFor({ timeout: 240000 });
    if (!/Runtime test passed/.test(await local.innerText())) throw new Error("The local server did not pass the runtime test.");
    await page.waitForTimeout(600);
    await scrollTo(page, local, "center");
    await shot("pv-local-connected");

    // The real failure for an address nothing is listening on.
    form = await freshForm(page);
    const unreachableUrl = new URL(modelUrl);
    unreachableUrl.port = "8199";
    await fill(form, { kind: "openai-compatible", Name: "Wrong port example", Region: "On premises", "Base URL": unreachableUrl.toString().replace(/\/$/, ""), "Key name": "Local server key" });
    const unreachable = await saveWithKey(page, form, "Wrong port example", placeholder("local"));
    await unreachable.getByText(/ConnectError|failed/).first().waitFor({ timeout: 60000 });
    await scrollTo(page, unreachable, "center");
    await shot("pv-local-unreachable");

    // Ollama is running here but has no model pulled: record what that shows.
    form = await freshForm(page);
    await fill(form, { kind: "ollama", Name: "Ollama", Region: "On premises", "Key name": "Ollama placeholder" });
    if ((await form.getByLabel("Base URL", { exact: true }).inputValue()) !== "http://localhost:11434/v1") throw new Error("Unexpected Ollama default base URL.");
    const ollama = await saveWithKey(page, form, "Ollama", placeholder("ollama"));
    await page.waitForTimeout(2000);
    await scrollTo(page, ollama, "center");
    await shot("pv-ollama-empty");

    // Path 2: OpenAI. Defaults fill the address and auth; the key comes from the vendor.
    form = await freshForm(page);
    await fill(form, { kind: "openai", Name: "OpenAI production", Region: "Global", "Key name": "Production primary", Expires: "Sep 30, 2027" });
    await scrollTo(page, form, "start");
    await shot("pv-openai-form");
    // A random, invalid key: OpenAI genuinely rejects it.
    const openai = await saveWithKey(page, form, "OpenAI production", placeholder("sk-invalid"));
    await openai.getByText(/401/).first().waitFor({ timeout: 60000 });
    await scrollTo(page, openai, "center");
    await shot("pv-openai-rejected");

    // Path 3: Anthropic (typed, not saved).
    form = await freshForm(page);
    await fill(form, { kind: "anthropic", Name: "Anthropic", Region: "Global", "Key name": "Production primary" });
    await scrollTo(page, form, "start");
    await shot("pv-anthropic-form");

    // Path 4: Azure OpenAI. Saved with a placeholder to record the real result.
    form = await freshForm(page);
    await fill(form, {
      kind: "azure-openai", Name: "Azure OpenAI East", Region: "East US",
      "Base URL": "https://your-resource.openai.azure.com/openai", "API version": "2024-10-21", Deployment: "gpt-4o-mini", "Key name": "KEY 1",
    });
    await scrollTo(page, form, "start");
    await shot("pv-azure-form");
    const azure = await saveWithKey(page, form, "Azure OpenAI East", placeholder("azure"));
    await azure.getByText(/discovery API/).first().waitFor({ timeout: 60000 });
    await scrollTo(page, azure, "center");
    await shot("pv-azure-saved");

    // Path 5: OpenRouter, with its catalog scope (typed, not saved).
    form = await freshForm(page);
    await fill(form, { kind: "openrouter", Name: "OpenRouter", Region: "Global", "Catalog scope": "zdr", "Key name": "Production primary" });
    await scrollTo(page, form, "start");
    await shot("pv-openrouter-form");

    // Path 6: Google Gemini through its OpenAI-compatible endpoint (typed, not saved).
    form = await freshForm(page);
    await fill(form, { kind: "gcp", Name: "Google Gemini", Region: "Global", "Key name": "AI Studio key" });
    await scrollTo(page, form, "start");
    await shot("pv-gemini-form");

    // Amazon Bedrock: the connection can be stored, but chat cannot route to it.
    form = await freshForm(page);
    await fill(form, { kind: "amazon-bedrock", Name: "Amazon Bedrock", Region: "us-east-1", "Key name": "Placeholder" });
    const bedrock = await saveWithKey(page, form, "Amazon Bedrock", placeholder("bedrock"));
    await bedrock.getByText(/discovery API|adapter/i).first().waitFor({ timeout: 60000 });
    await scrollTo(page, bedrock, "center");
    await shot("pv-bedrock-saved");

    // Card actions: Edit Connection opens the same fields in place.
    await page.reload();
    await page.locator(".provider-connections-panel").waitFor();
    const team = page.locator(".provider-card").filter({ has: page.locator("h2", { hasText: /^Team model server$/ }) });
    await team.getByRole("button", { name: "Edit Connection" }).click();
    await team.locator(".provider-connection-editor").waitFor();
    await scrollTo(page, team, "start");
    await shot("pv-edit-connection");
    await team.getByRole("button", { name: "Cancel" }).click();

    // Delete the rejected example through its confirmation dialog.
    const rejected = page.locator(".provider-card").filter({ has: page.locator("h2", { hasText: /^Wrong port example$/ }) });
    await rejected.getByRole("button", { name: "Delete provider Wrong port example" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete provider Wrong port example" });
    await dialog.waitFor();
    await dialog.getByLabel("Confirm provider name").fill("Wrong port example");
    await shot("pv-delete-dialog");
    await dialog.getByRole("button", { name: "Confirm delete provider Wrong port example" }).click();
    await dialog.waitFor({ state: "detached" });
    if (await page.locator(".provider-card h2", { hasText: /^Wrong port example$/ }).count()) throw new Error("The provider was not deleted.");
  },
};

async function localCard(page) {
  const card = page.locator(".provider-card").filter({ has: page.locator("h2", { hasText: /^Local training runtime$/ }) });
  await card.waitFor();
  return card;
}

async function keyRow(card, name) {
  const row = card.locator(".key-table tbody tr").filter({ has: card.page().locator("td[data-label='Key Name']", { hasText: name }) });
  await row.first().waitFor();
  return row.first();
}

async function addKey(page, card, { name, expires, secret }) {
  await card.getByRole("button", { name: "Add Key" }).click();
  const form = card.locator(".key-builder-form");
  await form.waitFor();
  if (name !== undefined) await form.getByLabel("Key name", { exact: true }).fill(name);
  if (expires !== undefined) await form.getByLabel("Expires", { exact: true }).fill(expires);
  return form;
}

async function saveKey(page, form, secret) {
  await form.getByLabel("API key or secret", { exact: true }).fill(secret);
  await form.getByRole("button", { name: "Save Key" }).click();
  await form.waitFor({ state: "detached", timeout: 240000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector(".key-builder-form"), null, { timeout: 240000 }).catch(() => {});
  await page.locator(".secure-notice[role='status']").waitFor({ timeout: 240000 });
  await page.waitForTimeout(1200);
}

const keyVault = {
  role: "owner",
  description: "Add, reveal, replace, and delete vaulted keys on the local provider, and show an expired key.",
  frames: [
    "owner/kv-vault-open", "owner/kv-add-form", "owner/kv-key-added", "owner/kv-reveal",
    "owner/kv-replace-form", "owner/kv-old-deleted", "owner/kv-expired",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await providersPage(kit);
    let card = await localCard(page);
    await card.getByRole("button", { name: "API keys for Local training runtime" }).click();
    await card.locator(".provider-keys").waitFor();
    const original = (await card.locator(".key-table tbody tr td[data-label='Key Name']").first().innerText()).split(/\s+/)[0];
    await scrollTo(page, card.locator(".provider-keys"), "center");
    await shot("kv-vault-open");

    // Add a second key. The local server ignores keys, so the value is a placeholder.
    let form = await addKey(page, card, { name: "Server key 2027", expires: "Dec 31, 2027" });
    await scrollTo(page, card.locator(".provider-keys"), "center");
    await shot("kv-add-form");
    const revealed = `example-placeholder-${crypto.randomBytes(4).toString("hex")}`;
    await saveKey(page, form, revealed);
    const added = await keyRow(card, "Server key 2027");
    await scrollTo(page, card.locator(".provider-keys"), "center");
    await shot("kv-key-added");

    // Reveal shows the full stored value in a dialog, and records an audit event.
    await added.getByRole("button", { name: "Reveal Server key 2027" }).click();
    const dialog = page.getByRole("dialog", { name: "Server key 2027 revealed key" });
    await dialog.waitFor();
    if ((await dialog.locator(".key-reveal-value").innerText()).trim() !== revealed) throw new Error("Reveal did not return the stored value.");
    await shot("kv-reveal");
    await dialog.getByRole("button", { name: "Done" }).click();

    // Replace the original key: paste a successor, then delete the old one.
    const old = await keyRow(card, original);
    await old.getByRole("button", { name: /^Add replacement key for/ }).click();
    form = card.locator(".key-builder-form");
    await form.waitFor();
    await scrollTo(page, card.locator(".provider-keys"), "center");
    await shot("kv-replace-form");
    await saveKey(page, form, `example-placeholder-${crypto.randomBytes(4).toString("hex")}`);
    const oldAgain = await keyRow(card, original);
    await oldAgain.getByRole("button", { name: /^Delete / }).click();
    await page.getByText(/key deleted from the platform vault/).waitFor();
    await page.waitForTimeout(800);
    await scrollTo(page, card.locator(".provider-keys"), "center");
    await shot("kv-old-deleted");

    // A key past its Expires date shows Expired and can no longer be revealed.
    form = await addKey(page, card, { name: "Retired key", expires: "Sep 30, 2026" });
    await saveKey(page, form, `example-placeholder-${crypto.randomBytes(4).toString("hex")}`);
    const expired = await keyRow(card, "Retired key");
    await expired.getByText("Expired").waitFor();
    if (!(await expired.getByRole("button", { name: "Reveal Retired key" }).isDisabled())) throw new Error("An expired key can still be revealed.");
    await scrollTo(page, card.locator(".provider-keys"), "center");
    await shot("kv-expired");
  },
};

async function modelRow(page, name) {
  const row = page.locator(".model-list-item").filter({ has: page.locator(".model-name-cell strong", { hasText: new RegExp(`^${name}$`) }) });
  await row.first().waitFor();
  return row.first();
}

async function openCatalog(page) {
  await page.getByRole("button", { name: "Select model" }).first().click();
  await page.getByRole("button", { name: "Why isn't a model listed?" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Models in your organization" });
  await dialog.waitFor();
  await page.getByText("Checking model access…").waitFor({ state: "detached" }).catch(() => {});
  await page.waitForTimeout(800);
  return dialog;
}

const models = {
  role: "owner",
  description: "Search and filter the catalog, rename and enable or disable models, and check what users see under each browsing policy.",
  frames: [
    "owner/md-overview", "owner/md-filter", "owner/md-details", "owner/md-disabled",
    "owner/md-user-menu", "owner/md-user-catalog", "owner/md-browse-policy", "owner/md-user-catalog-off",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("owner", "/platform/models");
    await page.locator(".model-list-row").first().waitFor();
    await page.waitForTimeout(600);
    await shot("md-overview");

    // Column filters: the funnel beside Provider.
    await page.getByRole("button", { name: "Filter by provider" }).click();
    const filter = page.locator(".column-filter-popover");
    await filter.waitFor();
    await filter.locator(".column-filter-option").filter({ has: page.locator("span", { hasText: /^OpenRouter$/ }) }).click();
    await page.waitForTimeout(600);
    await shot("md-filter", { keepFocus: true });
    await page.keyboard.press("Escape");
    await page.reload();
    await page.locator(".model-list-row").first().waitFor();

    // Edit details: give the local model a friendly name and a note.
    let row = await modelRow(page, "Qwen3.5 9B");
    await row.getByRole("button", { name: /Edit details/ }).click();
    const editor = row.locator(".model-detail-editor");
    await editor.waitFor();
    await editor.getByLabel("Display name", { exact: true }).fill("Team assistant (on premises)");
    await editor.locator("label").filter({ hasText: /^\s*Notes/ }).locator("textarea").fill("Runs on the on-premises server. Prompts never leave the building.");
    await scrollTo(page, row, "start");
    await shot("md-details");
    await editor.getByRole("button", { name: "Save details" }).click();
    await page.getByText(/saved/i).first().waitFor();

    // Disable a model for the whole organization.
    await page.reload();
    await page.locator(".model-list-row").first().waitFor();
    row = await modelRow(page, "gpt-4.1");
    const toggle = row.locator(".model-status-cell [role='switch']");
    if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
    await row.locator(".model-status-cell").getByText("Disabled").waitFor();
    await page.waitForTimeout(800);
    await shot("md-disabled");

    // What a user sees: the Model menu and the catalog explanation.
    const user = kit.use(await kit.app("user", "/"));
    await user.getByRole("button", { name: "Select model" }).first().click();
    await user.locator(".model-menu").waitFor();
    await user.waitForTimeout(500);
    await shot("md-user-menu", { keepFocus: true });
    await user.keyboard.press("Escape");
    let catalog = await openCatalog(user);
    await shot("md-user-catalog");

    // Turn catalog browsing off in Policy Controls.
    const owner = kit.use(await kit.app("owner", "/platform/org-settings"));
    const policy = owner.locator(".panel").filter({ has: owner.locator(".panel-header h2", { hasText: "Policy Controls" }) });
    const policyToggle = policy.locator(".panel-collapse-button").first();
    if ((await policyToggle.getAttribute("aria-expanded")) !== "true") await policyToggle.click();
    const browse = policy.getByRole("switch", { name: "Users can browse the model catalog" });
    await browse.waitFor();
    if ((await browse.getAttribute("aria-checked")) === "true") await browse.click();
    await owner.waitForFunction(() => document.querySelector("[role='switch'][aria-label='Users can browse the model catalog']")?.getAttribute("aria-checked") === "false");
    await owner.waitForTimeout(800);
    await scrollTo(owner, browse, "center");
    await shot("md-browse-policy");

    // The same person now sees only what they can use.
    kit.use(user);
    await user.reload();
    await user.getByRole("navigation", { name: "Primary" }).waitFor();
    catalog = await openCatalog(user);
    await catalog.getByText("Your organization shows only the models you can already use").waitFor();
    await shot("md-user-catalog-off");
  },
};

module.exports = { "owner-providers": providers, "owner-key-vault": keyVault, "owner-models": models };
