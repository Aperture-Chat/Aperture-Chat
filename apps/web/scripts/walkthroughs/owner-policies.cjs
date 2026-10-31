/* Organization policy, the workspace budget, the connector ceiling, and the
 * search index, performed for real on the synthetic instance. Run each module
 * from a freshly reset instance.
 *
 * owner-policies turns Downstream API access on and shows the API access row
 * that appears in an administrator's Account drawer; sets a tiny daily token ceiling, records
 * the real refusal a user then receives, and sets the ceiling back to
 * unlimited.
 *
 * owner-connectors opens Admin console › Connections as the platform owner,
 * turns one source off for every workspace through the browser's
 * confirmation, shows the tenant administrator's locked row, and allows the
 * source again. Per-source setup, testing, and Hide are taught in the
 * administrator documentation.
 *
 * owner-search-index reads the index status and runs a real rebuild.
 */
async function scrollTo(page, locator, block = "center") {
  await locator.evaluate((element, where) => element.scrollIntoView({ block: where }), block);
  await page.waitForTimeout(350);
}

/* Web search defaults on for a new chat. DuckDuckGo refuses automated
 * searches from the recording network (a real reply would read "Web search
 * (duckduckgo) is unavailable: … Turn off Web for this reply to continue
 * without it."), so the person turns Web off in Send options first. */
async function webOff(page) {
  const menu = page.locator(".send-options-menu");
  if (!(await menu.isVisible())) await page.locator("form.composer .send-options-button").click();
  await menu.waitFor();
  const web = menu.locator(".send-option").filter({ has: page.locator("strong:text-is('Web')") });
  if ((await web.getAttribute("aria-checked")) === "true") await web.click();
  await page.waitForTimeout(300);
  if ((await web.getAttribute("aria-checked")) !== "false") throw new Error("Web did not turn off.");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" }).catch(() => {});
  await page.waitForTimeout(300);
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
    // Setup (not captured): a real chat today, so the workspace has
    // provider-reported usage in the current UTC day before a ceiling is set.
    const warmup = await kit.app("user", "/");
    await webOff(warmup);
    await warmup.getByRole("textbox", { name: "Message" }).fill("List five short tips for writing a clear meeting agenda.");
    await warmup.getByRole("button", { name: "Send message" }).click();
    await warmup.getByRole("button", { name: "Send positive feedback" }).last().waitFor({ timeout: 1200000 });
    await warmup.close();

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

    // The effect: an administrator now has API access in the Account drawer.
    const admin = kit.use(await kit.app("admin", "/"));
    await admin.getByRole("button", { name: /^Account:/ }).click();
    const card = admin.locator("details.account-disclosure");
    await card.waitFor();
    await card.locator("summary").click();
    await card.getByRole("button", { name: "Create key" }).waitFor();
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
    const usage = Number(((await budget.locator(".budget-usage-card").innerText()).match(/([\d,]+) tokens/) ?? [])[1]?.replaceAll(",", "") ?? 0);
    if (usage < 1000) throw new Error(`Today's usage (${usage} tokens) is below the ceiling; the refusal would not happen.`);
    console.log(`  today's usage: ${usage} tokens`);
    await shot("pc-budget-saved");

    // A person's next message is refused with the real budget message.
    const user = kit.use(await kit.app("user", "/"));
    await webOff(user);
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

async function connectorRow(page, name) {
  const block = page.locator(".connector-config-block").filter({ has: page.locator(".connector-row-name", { hasText: new RegExp(`^${name}$`) }) });
  await block.waitFor();
  return block;
}

async function connectionsTab(kit, audience) {
  const page = await kit.app(audience, "/admin/tools");
  await page.locator(panelSelector("Connectors")).waitFor();
  await page.waitForTimeout(800);
  return page;
}

function panelSelector(title) {
  return `.panel:has(> .panel-header h2:text-is(${JSON.stringify(title)}))`;
}

const SOURCE = "Box";

const connectors = {
  role: "owner",
  description: "Turn a connector off for every workspace from Admin console › Connections, see what an administrator sees, and allow it again.",
  frames: ["owner/pc-connections", "owner/pc-ceiling-off", "owner/pc-ceiling-admin", "owner/pc-ceiling-allowed"],
  async run(kit) {
    const { shot } = kit;
    // Connectors are configured per workspace in the Admin console; the owner
    // sees the same panel with the deployment-wide ceiling on every row.
    const page = await connectionsTab(kit, "owner");
    if ((await page.locator(".connector-ceiling-button").count()) < 3) throw new Error("The owner's Off for all buttons are missing.");
    let row = await connectorRow(page, SOURCE);
    if (await row.getByText("Off for all workspaces").count()) throw new Error(`Start with ${SOURCE} allowed in every workspace.`);
    await shot("pc-connections");

    // Off for all: the browser asks for confirmation first.
    page.once("dialog", (prompt) => {
      if (!/^Turn Box off for every workspace\? Workspace admins can't turn it back on until you allow it again\.$/.test(prompt.message())) {
        throw new Error(`Unexpected confirmation: ${prompt.message()}`);
      }
      return prompt.accept();
    });
    await row.getByRole("button", { name: `Turn ${SOURCE} off for every workspace` }).click();
    await page.getByText(`${SOURCE} is off for every workspace.`).waitFor();
    await row.getByText("Off for all workspaces").waitFor();
    await row.getByRole("button", { name: `Allow ${SOURCE} in every workspace` }).waitFor();
    await page.waitForTimeout(800);
    await shot("pc-ceiling-off");

    // A tenant administrator: the pill, and a switch they cannot turn on.
    const admin = kit.use(await connectionsTab(kit, "admin"));
    const adminRow = await connectorRow(admin, SOURCE);
    await adminRow.getByText("Off for all workspaces").waitFor();
    if (await admin.locator(".connector-ceiling-button").count()) throw new Error("An administrator was offered the owner ceiling.");
    if (!(await adminRow.getByRole("switch").isDisabled())) throw new Error("The administrator can still switch the connector on.");
    await shot("pc-ceiling-admin");

    // Allow all reopens the ceiling; each workspace's own switch decides again.
    kit.use(page);
    await page.reload();
    await page.locator(panelSelector("Connectors")).waitFor();
    row = await connectorRow(page, SOURCE);
    await row.getByRole("button", { name: `Allow ${SOURCE} in every workspace` }).click();
    await page.getByText(`${SOURCE} is allowed in every workspace again. Each workspace's own switch decides whether it is on.`).waitFor();
    await row.getByRole("button", { name: `Turn ${SOURCE} off for every workspace` }).waitFor();
    await page.waitForTimeout(800);
    await shot("pc-ceiling-allowed");
    const state = (await kit.api("owner", "GET", "/api/bootstrap").catch(() => null))?.connectors?.find((connector) => connector.name === SOURCE);
    if (state) console.log(`  ${SOURCE} after Allow all: deployment_enabled=${state.deployment_enabled} tenant_enabled=${state.tenant_enabled}`);
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
