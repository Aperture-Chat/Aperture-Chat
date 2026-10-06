/* Model access in the Admin console, performed for real.
 *
 * admin-model-access: sync the catalog, open a model's groups, clear and
 * restore one group's grant while the model access trace for an affected
 * person shows Blocked and then Usable, hide a model with the User Access
 * switch (and record the real refusal when a tenant admin turns it back on),
 * and filter the catalog by provider.
 * admin-model-requests: a person asks for a model from "Why isn't a model
 * listed?", the admin approves it into a group that does not carry the model
 * yet (the widening hint), declines an older request, and the person's own
 * dialog and the trace confirm both decisions. Only one local model is
 * connected in the capture instance, so approved models that use other
 * providers truthfully report "provider offline".
 */
const { helpers } = require("./admin-shared.cjs");

const { tidyFixture, scrollTo, toast, dismissToast, openTab } = helpers;
const QWEN = "Qwen3.5 9B";
const GROUP = "Contracts Review";

async function modelAccessTab(kit) {
  const page = await kit.app("admin", "/admin/users");
  // A narrower window clips the catalog's Groups column; collapse the sidebar.
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await openTab(page, "Model Access");
  await page.locator(".model-access-panel").waitFor();
  return page;
}

/** The trace dialog for one person, scrolled to one model's gates. */
async function openTrace(page, person, model) {
  await openTab(page, "Users");
  const row = page.locator("tr").filter({ hasText: person.email });
  await scrollTo(page, row, "center");
  await row.getByRole("button", { name: `Model access for ${person.name}` }).click();
  const trace = page.getByRole("dialog", { name: `Model access trace for ${person.name}` });
  await trace.waitFor();
  const card = trace.locator("details.drawer-card").filter({ has: page.locator("summary", { hasText: model }) });
  await card.waitFor();
  if (!(await card.evaluate((element) => element.open))) await card.locator("summary").click();
  await scrollTo(page, card, "center");
  return { trace, card };
}

async function closeTrace(page, trace) {
  await page.keyboard.press("Escape");
  await trace.waitFor({ state: "detached" });
}

/** Contracts Review comes from admin-groups; recreate it when run alone. */
async function ensureGroup(kit) {
  const groups = await kit.api("admin", "GET", "/api/admin/groups");
  let group = groups.find((item) => item.name === GROUP);
  if (!group) {
    const tenant = groups[0].tenant_id;
    group = await kit.api("admin", "POST", "/api/admin/groups", { tenant_id: tenant, name: GROUP, permissions: groups[0].permissions });
    for (const id of ["user-jane", "user-casey", "user-maya"]) {
      const user = (await kit.api("admin", "GET", "/api/admin/users")).find((item) => item.id === id);
      await kit.api("admin", "PATCH", `/api/admin/users/${id}`, { group_ids: [...user.group_ids, group.id] });
    }
  }
  return group;
}

const adminModelAccess = {
  role: "admin",
  description: "Sync, grant through groups with a before/after trace, hide a model, and filter.",
  frames: [
    "admin/ma-catalog", "admin/ma-groups-editor", "admin/ma-trace-blocked", "admin/ma-group-granted",
    "admin/ma-trace-usable", "admin/ma-hidden", "admin/ma-reenable-refused", "admin/ma-filter",
  ],
  async run(kit) {
    const { shot } = kit;
    await tidyFixture(kit);
    const maya = { name: "Maya Patel", email: "user-maya@example.test" };
    const models = await kit.api("admin", "GET", "/api/admin/model-access");
    const qwen = models.find((model) => model.name === QWEN);
    // gpt-4o is hidden and restored below; undo an interrupted earlier run.
    const gptGroups = ["group-litigation", "group-corporate", "group-default-users"];
    if (!models.find((model) => model.id === "gpt-4o")?.group_ids.length) {
      await kit.api("owner", "PATCH", "/api/admin/model-access/gpt-4o", { group_ids: gptGroups });
    }
    const defaults = (await kit.api("admin", "GET", "/api/admin/groups")).find((group) => group.default_group || group.name === "Default Users");
    if (!qwen?.group_ids.includes(defaults.id)) throw new Error(`${QWEN} must start granted to Default Users.`);
    const maya_ = (await kit.api("admin", "GET", "/api/admin/users")).find((user) => user.email === maya.email);
    if (maya_.group_ids.some((id) => id !== defaults.id && qwen.group_ids.includes(id))) throw new Error("Maya must reach the model only through Default Users.");

    // 1. The catalog: counters, Sync models, search, status filter.
    const page = kit.use(await modelAccessTab(kit));
    const panel = page.locator(".model-access-panel");
    await panel.getByRole("button", { name: "Sync models" }).click();
    await toast(page, /Synced \d+ models? into Model Access\./);
    await scrollTo(page, panel, "start");
    await shot("ma-catalog");
    await dismissToast(page);

    // 2. Choose groups for the local model.
    const row = panel.locator(".model-access-table tbody tr").filter({ hasText: QWEN }).first();
    await row.getByRole("button", { name: `Edit groups for ${QWEN}` }).click();
    const editor = panel.locator(".model-group-editor");
    await editor.waitFor();
    await scrollTo(page, row, "start");
    await shot("ma-groups-editor");

    // 3. Clear Default Users: Maya's trace now stops at group_grant.
    await editor.getByLabel(`Allow ${QWEN} for Default Users`).uncheck();
    await toast(page, `${QWEN} group access synced with the admin API.`);
    let { trace, card } = await openTrace(page, maya, QWEN);
    if (!/Blocked/.test(await card.innerText())) throw new Error("Expected the model to be blocked for Maya.");
    await shot("ma-trace-blocked");
    await closeTrace(page, trace);

    // 4. Grant it back to Default Users.
    await openTab(page, "Model Access");
    const again = panel.locator(".model-access-table tbody tr").filter({ hasText: QWEN }).first();
    if ((await again.getByRole("button", { name: `Edit groups for ${QWEN}` }).getAttribute("aria-expanded")) !== "true") {
      await again.getByRole("button", { name: `Edit groups for ${QWEN}` }).click();
    }
    await editor.getByLabel(`Allow ${QWEN} for Default Users`).check();
    await toast(page, `${QWEN} group access synced with the admin API.`);
    await scrollTo(page, again, "start");
    await shot("ma-group-granted");
    ({ trace, card } = await openTrace(page, maya, QWEN));
    if (!/Usable/.test(await card.innerText())) throw new Error("Expected the model to be usable for Maya again.");
    await shot("ma-trace-usable");
    await closeTrace(page, trace);

    // 5. The User Access switch hides a model from everyone. Turning it back
    //    on is refused for a tenant admin today (reported product issue), so
    //    the frame records the real refusal and the owner restores the grant.
    await openTab(page, "Model Access");
    const gpt = panel.locator(".model-access-table tbody tr").filter({ has: page.locator("strong", { hasText: /^gpt-4o$/ }) }).first();
    await gpt.getByRole("switch", { name: "Enable gpt-4o for users" }).click();
    await toast(page, "gpt-4o user access synced with the admin API.");
    await gpt.getByText("Hidden from users").waitFor();
    await scrollTo(page, gpt, "center");
    await shot("ma-hidden");
    await gpt.getByRole("switch", { name: "Enable gpt-4o for users" }).click();
    await toast(page, "gpt-4o user access could not sync. This model is not available to this organization. Nothing was changed.");
    await gpt.getByText("Hidden from users").waitFor();
    await shot("ma-reenable-refused");
    await kit.api("owner", "PATCH", "/api/admin/model-access/gpt-4o", { group_ids: gptGroups });
    await dismissToast(page);

    // 6. Column filters narrow a long catalog.
    await scrollTo(page, panel.locator(".model-access-table thead"), "start");
    await panel.getByRole("button", { name: "Filter by provider" }).click();
    const popover = page.getByRole("group", { name: "Provider filter" });
    await popover.waitFor();
    await popover.locator(".column-filter-option").filter({ hasText: "OpenRouter" }).locator("input").check();
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "detached" }).catch(() => {});
    await panel.locator(".table-scroll").first().evaluate((element) => { element.scrollLeft = 0; }).catch(() => {});
    await scrollTo(page, panel, "start");
    await shot("ma-filter");
  },
};

const adminModelRequests = {
  role: "admin",
  description: "A person requests a model; approve it into a group, decline another, and confirm both.",
  frames: [
    "admin/mr-user-dialog", "admin/mr-user-requested", "admin/mr-queue", "admin/mr-group-choice",
    "admin/mr-approved", "admin/mr-declined", "admin/mr-user-after", "admin/mr-trace",
  ],
  async run(kit) {
    const { shot } = kit;
    await tidyFixture(kit);
    await ensureGroup(kit);
    const jane = { name: "Jane Smith", email: "user-jane@example.test" };
    const wanted = "OpenRouter: openai/gpt-4o-mini";
    // Start state: Jane's earlier request for GPT-5.5 is pending (it ships in
    // the fixture) and the model she will ask for is not yet hers.
    const pending = await kit.api("admin", "GET", "/api/admin/model-access-requests");
    if (!pending.some((view) => view.model_name === "OpenAI: GPT-5.5" && view.requester_email === jane.email)) {
      await kit.api("user", "POST", "/api/me/model-access-requests", { model_id: "openrouter-openai-gpt-5-5" });
    }
    const wantedModel = (await kit.api("admin", "GET", "/api/admin/model-access")).find((model) => model.name === wanted);
    const contracts = (await kit.api("admin", "GET", "/api/admin/groups")).find((group) => group.name === GROUP);
    if (wantedModel.group_ids.includes(contracts.id)) {
      await kit.api("admin", "PATCH", `/api/admin/model-access/${wantedModel.id}`, { group_ids: wantedModel.group_ids.filter((id) => id !== contracts.id) });
    }

    // 1. The person: "Why isn't a model listed?" explains and lets them ask.
    const user = kit.use(await kit.app("user", "/"));
    await user.getByRole("button", { name: "Select model" }).click();
    await user.getByRole("button", { name: "Why isn't a model listed?" }).click();
    const dialog = user.getByRole("dialog", { name: "Models in your organization" });
    await dialog.waitFor();
    const lockedRow = dialog.locator("[data-model-id]").filter({ hasText: wanted });
    await lockedRow.waitFor();
    await scrollTo(user, lockedRow, "center");
    await shot("mr-user-dialog");
    await lockedRow.getByRole("button", { name: "Request access" }).click();
    await dialog.getByText(`Request sent for ${wanted}. An administrator will review it.`).waitFor();
    await shot("mr-user-requested");

    // 2. The admin queue on Model Access.
    const page = kit.use(await kit.app("admin", "/admin/users"));
    await openTab(page, "Model Access");
    const panel = page.locator(".model-access-requests-panel");
    const request = panel.locator(".model-access-request-row").filter({ hasText: wanted });
    await request.waitFor();
    await scrollTo(page, panel, "start");
    await shot("mr-queue");

    // 3. A group that does not carry the model yet: the widening hint.
    await request.getByLabel(`Group for ${jane.name}`).selectOption({ label: `${GROUP} (also grant model to group)` });
    await request.getByText("This group does not carry the model yet; approving grants it to everyone in the group.").waitFor();
    await shot("mr-group-choice");
    await request.getByRole("button", { name: "Approve" }).click();
    const notice = panel.locator("p[role=status]");
    await notice.waitFor();
    const approved = await notice.innerText();
    if (!/can now use|Approved, but the server still reports/.test(approved)) throw new Error(`Unexpected approval result: ${approved}`);
    await shot("mr-approved");

    // 4. Decline the older request.
    const older = panel.locator(".model-access-request-row").filter({ hasText: "OpenAI: GPT-5.5" });
    await older.getByRole("button", { name: "Decline" }).click();
    await panel.getByText(`Declined the request from ${jane.name}.`).waitFor();
    await shot("mr-declined");

    // 5. The person sees both decisions in the same dialog.
    const after = kit.use(await kit.app("user", "/"));
    await after.getByRole("button", { name: "Select model" }).click();
    await after.getByRole("button", { name: "Why isn't a model listed?" }).click();
    const refreshed = after.getByRole("dialog", { name: "Models in your organization" });
    const grantedRow = refreshed.locator("[data-model-id]").filter({ hasText: wanted });
    await grantedRow.waitFor();
    // Allowed now; the only remaining gate is the provider connection.
    await grantedRow.getByText("Provider offline").waitFor();
    await scrollTo(after, grantedRow, "center");
    await shot("mr-user-after");

    // 6. The trace explains why: the group now grants it; the provider is offline.
    kit.use(page);
    await page.reload();
    await page.getByRole("tablist", { name: "Admin sections" }).waitFor();
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    const { trace, card } = await openTrace(page, jane, wanted);
    if (!/One of your groups grants this model/.test(await card.innerText())) throw new Error("The trace does not show the new group grant.");
    await shot("mr-trace");
    await closeTrace(page, trace);
  },
};

module.exports = { "admin-model-access": adminModelAccess, "admin-model-requests": adminModelRequests };
