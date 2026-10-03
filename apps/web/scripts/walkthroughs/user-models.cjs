/* Choosing a model and asking for access, performed for real.
 *
 * Setup (owner and admin APIs, never shown as the user's own UI): a second
 * catalog entry on the local training provider, granted only to the Finance
 * Team group, so a standard user genuinely sees it as Locked and, once an
 * administrator approves the request, can genuinely use it. The person is a
 * new synthetic account, because approval ends the requester's sessions and
 * the shared capture session must survive this module.
 *
 * user-models opens the model selector, stars a default, opens "Why isn't a
 * model listed?", requests access, withdraws, requests again, has the request
 * approved through the admin API (the admin lessons teach that screen), records
 * what the person's open workspace shows next, signs back in, and sends a real
 * message to the newly granted model.
 */
const { helpers } = require("./user-common.cjs");
const { scrollTo, signInWithPassword, createPerson, sendChat, waitForReply } = helpers;

const MODEL_NAME = "Qwen3.5 9B Finance";
const PERSON = { email: "riley.park@example.test", name: "Riley Park" };

async function explainer(page) {
  const dialog = page.locator("[role='dialog'][aria-label='Models in your organization']");
  if (!(await dialog.count())) {
    if (!(await page.locator(".workspace-header .model-menu").isVisible())) await page.getByRole("button", { name: "Select model" }).click();
    await page.locator(".workspace-header .model-menu-footer").click();
  }
  await dialog.waitFor();
  await page.waitForTimeout(1200);
  return dialog;
}

const userModels = {
  role: "user",
  description: "Pick and star a model, read why others are unavailable, request, withdraw, and use an approved model.",
  externalOrigins: () => [],
  frames: [
    "user/models-menu", "user/models-starred", "user/models-explainer", "user/models-requested",
    "user/models-withdrawn", "user/models-signed-out", "user/models-approved", "user/models-reply",
  ],
  async run(kit) {
    const { shot } = kit;
    // Setup: a working model that only the Finance Team group may use.
    const owner = await kit.api("owner", "GET", "/api/bootstrap");
    const base = owner.models.find((model) => model.provider_id === "training-local");
    if (!base) throw new Error("The local training model is missing.");
    if (owner.models.some((model) => model.name === MODEL_NAME)) throw new Error("Reset the instance first: the finance model exists.");
    const model = await kit.api("owner", "POST", "/api/platform/models", {
      provider_id: base.provider_id, name: MODEL_NAME, upstream_model_id: base.upstream_model_id,
      platform_enabled: true, context_window: base.context_window,
    });
    await kit.api("owner", "PATCH", `/api/admin/model-access/${model.id}`, { group_ids: ["group-finance"] });
    const person = await createPerson(kit, { ...PERSON, groups: ["group-litigation"] });

    // 1. The model selector, then star a default.
    let page = await signInWithPassword(kit, person.email, person.password);
    await page.getByRole("button", { name: "Select model" }).click();
    const menu = page.locator(".workspace-header .model-menu");
    await menu.waitFor();
    await shot("models-menu", { keepFocus: true });
    await menu.getByRole("button", { name: `Set ${base.name} as default model` }).click();
    await page.waitForTimeout(600);
    if (!(await menu.isVisible())) await page.getByRole("button", { name: "Select model" }).click();
    await shot("models-starred", { keepFocus: true });

    // 2. Why isn't a model listed? and Request access.
    let dialog = await explainer(page);
    const row = () => dialog.locator("[data-model-id]").filter({ hasText: MODEL_NAME });
    await scrollTo(page, dialog.locator("section[aria-label='Usable models']"), "start");
    await shot("models-explainer");
    await row().getByRole("button", { name: "Request access" }).click();
    await row().getByRole("button", { name: "Withdraw request" }).waitFor();
    await scrollTo(page, row(), "center");
    await shot("models-requested");

    // 3. Withdraw, then ask again.
    await row().getByRole("button", { name: "Withdraw request" }).click();
    const withdrawn = dialog.getByText(`Withdrew the request for ${MODEL_NAME}.`);
    await withdrawn.waitFor();
    await scrollTo(page, withdrawn, "start");
    await shot("models-withdrawn");
    await row().getByRole("button", { name: "Request access" }).click();
    await row().getByRole("button", { name: "Withdraw request" }).waitFor();

    // 4. The administrator approves through a group (Admin console › Model Access).
    const pending = await kit.api("admin", "GET", "/api/admin/model-access-requests?status=pending");
    const request = pending.map((item) => item.request).find((item) => item.model_id === model.id && item.user_id === person.id);
    if (!request) throw new Error("The request did not reach the administrator.");
    await kit.api("admin", "POST", `/api/admin/model-access-requests/${request.id}/approve`, { group_id: "group-finance" });

    // 5. What the open workspace shows next: approval ends the person's sessions.
    await dialog.getByRole("button", { name: "Refresh model access" }).click();
    const expired = dialog.getByText("Session is invalid or expired. Sign in again.");
    await expired.waitFor();
    await scrollTo(page, expired, "start");
    await shot("models-signed-out");
    await page.context().close();

    // 6. Sign in again: the model is usable now; choose it and get a real reply.
    page = await signInWithPassword(kit, person.email, person.password);
    dialog = await explainer(page);
    const usable = dialog.locator("section[aria-label='Usable models']");
    await usable.getByText(MODEL_NAME).waitFor();
    await scrollTo(page, usable, "start");
    await shot("models-approved");
    await dialog.getByRole("button", { name: "Close model access dialog" }).click();
    await page.getByRole("button", { name: "Select model" }).click();
    await page.locator(".workspace-header .model-menu").getByRole("option", { name: new RegExp(MODEL_NAME) }).click();
    const before = await sendChat(page, "In one sentence, what should a finance team check before approving a vendor invoice?");
    await waitForReply(page, before);
    await shot("models-reply");
  },
};

module.exports = { "user-models": userModels };
