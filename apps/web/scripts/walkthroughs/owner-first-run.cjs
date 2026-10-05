/* The first workspace, performed end to end on an EMPTY instance.
 *
 * Run this module with CAPTURE_APP_URL and CAPTURE_API_URL pointed at an
 * isolated API started with APERTURE_SEED_PLATFORM_OWNER_ENABLED=false and
 * APERTURE_SEED_DEMO_DATA_ENABLED=false (no owner, no organization data), and
 * CAPTURE_LOCAL_MODEL_URL at a local OpenAI-compatible model server reachable
 * from that API (for example http://localhost:8096/v1 for an MLX or LM Studio
 * server). The module creates the first platform owner, connects the local
 * server, enables its model, creates a person with a temporary password, and
 * signs that person in until the model answers a first message for real.
 * Passwords are random per run, typed only after each frame is taken, and
 * never written to disk.
 */
const crypto = require("node:crypto");

const OWNER = { email: "owner@example.test", name: "Avery Quinn" };
const PERSON = { email: "jordan.lee@example.test", name: "Jordan Lee" };
const secret = () => `Synthetic-${crypto.randomBytes(12).toString("base64url")}`;

async function scrollTo(page, locator, block = "center") {
  await locator.evaluate((element, where) => element.scrollIntoView({ block: where }), block);
  await page.waitForTimeout(350);
}

/* SelectControl keeps a real <select> inside each <label>; choose by label text. */
function selectIn(scope, label) {
  return scope.locator("label").filter({ hasText: new RegExp(`^\\s*${label}`) }).locator("select").first();
}

async function openTab(page, name) {
  await page.getByRole("tab", { name, exact: true }).click();
  await page.waitForTimeout(700);
}

async function dismissStatus(page) {
  for (const close of await page.locator(".action-status button[aria-label^='Dismiss'], .toast button[aria-label^='Dismiss']").all()) {
    await close.click().catch(() => {});
  }
}

const firstWorkspace = {
  role: "owner",
  description: "Create the first owner on an empty instance, connect a local model, grant access, and get a first reply.",
  frames: [
    "owner/fw-setup", "owner/fw-welcome", "owner/fw-providers-empty", "owner/fw-provider-form",
    "owner/fw-provider-connected", "owner/fw-model-enabled", "owner/fw-account-created",
    "owner/fw-password-dialog", "owner/fw-model-access", "owner/fw-person-signin", "owner/fw-person-new-password", "owner/fw-first-reply",
  ],
  async run(kit) {
    const { shot } = kit;
    const modelUrl = kit.env("CAPTURE_LOCAL_MODEL_URL");
    const options = await (await fetch(`${kit.API}/api/auth/options`)).json();
    if (!options.bootstrap_required) throw new Error("Start from an EMPTY instance (bootstrap_required must be true).");
    const ownerPassword = secret();
    const temporaryPassword = secret();
    const personPassword = secret();

    // 1. The very first visit offers to create the platform owner.
    const page = await kit.anonymous();
    await page.getByRole("heading", { name: "Create the first platform owner" }).waitFor();
    await page.getByLabel("Email", { exact: true }).fill(OWNER.email);
    await page.getByLabel("Display name", { exact: true }).fill(OWNER.name);
    await shot("fw-setup");
    await page.getByLabel("Create password", { exact: true }).fill(ownerPassword);
    await page.getByLabel("Confirm password", { exact: true }).fill(ownerPassword);
    await page.getByRole("button", { name: "Create platform owner", exact: true }).click();
    await page.locator(".first-run-welcome").waitFor();
    await page.waitForTimeout(800);
    await shot("fw-welcome");

    // 2. Set up models opens Providers with the empty-state checklist.
    await page.getByRole("button", { name: "Set up models" }).click();
    await page.getByRole("heading", { name: "Connect your first model provider" }).waitFor();
    await shot("fw-providers-empty");

    // 3. Register the local OpenAI-compatible server.
    await page.getByRole("button", { name: "Add Provider" }).click();
    const form = page.locator("#provider-builder-form");
    await form.waitFor();
    await form.getByLabel("Name", { exact: true }).fill("Local model server");
    await selectIn(form, "Kind").selectOption("openai-compatible");
    await form.getByLabel("Region", { exact: true }).fill("On premises");
    await form.getByLabel("Base URL", { exact: true }).fill(modelUrl);
    await form.getByLabel("Key name", { exact: true }).fill("Local server key");
    await scrollTo(page, form, "start");
    await shot("fw-provider-form");
    // The local server ignores keys, but Sync Models needs an active key on file.
    await form.getByLabel("API key or secret", { exact: true }).fill(`local-${crypto.randomBytes(6).toString("hex")}`);
    await form.getByRole("button", { name: "Save Provider" }).click();
    const card = page.locator(".provider-card").filter({ hasText: "Local model server" });
    await card.waitFor();
    await card.locator(".pill", { hasText: "Connected" }).waitFor({ timeout: 240000 });
    await page.waitForTimeout(800);
    await scrollTo(page, card, "center");
    await shot("fw-provider-connected");

    // 4. Synced models arrive disabled: enable the model for the organization.
    await openTab(page, "Models");
    const row = page.locator(".model-list-row").first();
    await row.waitFor();
    const toggle = row.locator(".model-status-cell [role='switch']");
    if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
    await row.locator(".model-status-cell").getByText("Enabled").waitFor();
    await page.waitForTimeout(600);
    await shot("fw-model-enabled");

    // 5. Create the first person and give them a temporary password.
    await openTab(page, "Org Settings");
    const roles = page.locator(".owner-control-panel");
    const toggleRoles = roles.locator(".panel-collapse-button").first();
    if ((await toggleRoles.getAttribute("aria-expanded")) !== "true") await toggleRoles.click();
    const create = roles.locator(".owner-management-form");
    await create.getByLabel("Display name", { exact: true }).fill(PERSON.name);
    await create.getByLabel("Email", { exact: true }).fill(PERSON.email);
    await selectIn(create, "Role").selectOption("USER");
    await create.getByRole("button", { name: "Create account" }).click();
    const personRow = roles.locator(".owner-user-list > *").filter({ hasText: PERSON.email });
    await personRow.waitFor();
    await scrollTo(page, personRow, "center");
    await shot("fw-account-created");
    await personRow.getByRole("button", { name: /^Set a password/ }).click();
    const dialog = page.getByRole("dialog", { name: `Set a password for ${PERSON.name}` });
    await dialog.waitFor();
    await shot("fw-password-dialog");
    await dialog.getByLabel("New password").fill(temporaryPassword);
    await dialog.getByRole("button", { name: "Set password" }).click();
    await dialog.getByText(`Password set for ${PERSON.name}.`).waitFor();
    await dialog.getByRole("button", { name: "Done" }).click();

    // 6. Access: the enabled model carries the Default Users group, and new
    // people join that group, so nothing else has to be assigned by hand.
    await page.goto(`${kit.APP}/admin/model-access`);
    const access = page.locator(".model-access-panel");
    await access.waitFor();
    await page.waitForTimeout(900);
    await access.getByRole("button", { name: /^Edit groups for/ }).first().click();
    const editor = access.locator(".model-group-editor");
    await editor.waitFor();
    if (!(await editor.getByRole("checkbox", { name: /Default Users/ }).isChecked())) throw new Error("Default Users does not carry the enabled model.");
    // Opening the editor scrolls the wide table sideways; scroll it back.
    await access.evaluate((panel) => panel.querySelectorAll("*").forEach((node) => { if (node.scrollLeft) node.scrollLeft = 0; }));
    await scrollTo(page, access, "start");
    await shot("fw-model-access");

    // 7. The person signs in from their own browser and replaces the password.
    const person = kit.use(await kit.anonymous());
    await person.getByRole("heading", { name: "Sign in to continue" }).waitFor();
    const emailTab = person.getByRole("button", { name: /Email & password/ });
    if (await emailTab.count()) await emailTab.click();
    await person.getByLabel("Email", { exact: true }).fill(PERSON.email);
    await shot("fw-person-signin");
    await person.getByLabel("Password", { exact: true }).fill(temporaryPassword);
    await person.getByRole("button", { name: "Sign in", exact: true }).click();
    await person.getByRole("heading", { name: "Set a new password" }).waitFor();
    await shot("fw-person-new-password");
    const fields = person.locator(".auth-form input[type='password']");
    await fields.nth(0).fill(personPassword);
    await fields.nth(1).fill(personPassword);
    await person.locator(".auth-form button[type='submit']").click();
    await person.getByRole("navigation", { name: "Primary" }).waitFor({ timeout: 30000 });
    await person.waitForTimeout(1200);
    const welcomeClose = person.locator(".first-run-welcome button[aria-label^='Dismiss'], .first-run-welcome button[aria-label^='Close']");
    if (await welcomeClose.count()) await welcomeClose.first().click();

    // 8. A first message, answered by the model the owner just connected.
    const composer = person.getByRole("textbox", { name: "Message" });
    await composer.fill("In one sentence, what can you help our team with?");
    await person.getByRole("button", { name: "Send message" }).click();
    const reply = person.locator(".assistant-message .message-rendered-response").last();
    await reply.waitFor({ timeout: 300000 });
    // The reply is finished when its feedback actions appear.
    await person.getByRole("button", { name: "Send positive feedback" }).last().waitFor({ timeout: 300000 });
    await person.getByText("Streaming reply").waitFor({ state: "detached", timeout: 60000 }).catch(() => {});
    await person.waitForTimeout(2500);
    if (!(await reply.innerText()).trim()) throw new Error("The model returned no text.");
    await shot("fw-first-reply");
  },
};

module.exports = { "owner-first-workspace": firstWorkspace };
