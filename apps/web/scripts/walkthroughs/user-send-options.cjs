/* Send options and session details, performed for real as the synthetic
 * standard user against the local training model.
 *
 * user-send-options opens Send options, grounds a question in a knowledge base
 * (real retrieval and citations from the seeded synthetic playbook), opens the
 * citations in Session details, shows the Web toggle as the workspace ships it
 * (off for this model), then, as the administrator's setup through the admin
 * API, connects the workspace's web search to the model and shows Web on. It
 * does not send a web question (see the note at step 5). It also shows the Agent profile picker,
 * the reasoning and streaming settings, the Resources browser, and the tools
 * chip, and records Session details after the knowledge reply.
 */
const { helpers } = require("./user-common.cjs");
const { scrollTo, composer, sendChat, waitForReply } = helpers;

async function openMenu(page) {
  const menu = page.locator(".send-options-menu");
  if (!(await menu.isVisible())) await page.locator("form.composer .send-options-button").click();
  await menu.waitFor();
  await page.waitForTimeout(400);
  return menu;
}

const option = (menu, name) => menu.locator(".send-option").filter({ has: menu.page().locator(`strong:text-is('${name}')`) });

/** Turn a reply setting on or off; the workspace remembers some of them. */
async function setOption(menu, name, on) {
  const item = option(menu, name);
  if (((await item.getAttribute("aria-checked")) === "true") !== on) await item.click();
  await menu.page().waitForTimeout(300);
  if (((await item.getAttribute("aria-checked")) === "true") !== on) throw new Error(`${name} did not turn ${on ? "on" : "off"}.`);
}

const userSendOptions = {
  role: "user",
  description: "Knowledge, Web, Agent, reasoning, streaming, Resources, and Session details with real replies.",
  externalOrigins: () => [],
  frames: [
    "user/send-menu", "user/send-knowledge", "user/send-tools-chip", "user/send-knowledge-reply",
    "user/session-summary", "user/session-sources", "user/session-context", "user/session-shortcuts",
    "user/send-web-on", "user/send-agent", "user/send-resources", "user/send-resource-inserted",
  ],
  async run(kit) {
    const { shot } = kit;
    let page = await kit.app("user", "/chat");
    await composer(page).waitFor();

    // 1. The menu as the workspace ships it.
    let menu = await openMenu(page);
    await shot("send-menu", { keepFocus: true });

    // 2. Knowledge: choose a source and ask.
    await setOption(menu, "Knowledge", true);
    const picker = menu.locator(".knowledge-source-picker");
    await picker.waitFor();
    await picker.locator(".knowledge-source-option").filter({ hasText: "Litigation Playbook" }).click();
    await page.waitForTimeout(400);
    await shot("send-knowledge", { keepFocus: true });
    await menu.getByRole("button", { name: "Close send options" }).click();
    await composer(page).fill("According to our litigation playbook, what should a responsive pleading preserve? Answer in two sentences.");
    await shot("send-tools-chip", { keepFocus: true });
    let before = await sendChat(page, await composer(page).inputValue());
    let reply = await waitForReply(page, before);
    if (!(await reply.locator(".message-citation-action").count())) throw new Error("The knowledge reply has no citations.");
    await scrollTo(page, reply.locator(".message-actions"), "end");
    await shot("send-knowledge-reply");

    // 3. Session details: summary, sources, context, symbol shortcuts.
    await reply.locator(".message-citation-action").click();
    const panel = page.locator("aside.session-panel");
    await panel.waitFor();
    await page.waitForTimeout(800);
    await scrollTo(page, panel.locator(".session-sources"), "start");
    await shot("session-sources");
    await scrollTo(page, panel.locator(".audit-list").first(), "start");
    await shot("session-summary");
    await scrollTo(page, panel.locator(".context-window-detail"), "start");
    await shot("session-context");
    await scrollTo(page, panel.locator(".session-shortcuts"), "end");
    await shot("session-shortcuts");
    await panel.getByRole("button", { name: "Close session details" }).click();

    // 4. Setup (administrator): connect the workspace web search to this model.
    const boot = await kit.api("admin", "GET", "/api/bootstrap");
    const model = boot.models.find((item) => item.provider_id === "training-local");
    const tool = boot.toolConfigs.find((item) => item.id === "tool-web-search");
    const connected = [...new Set([...(tool.settings.connected_model_ids || []), model.id])];
    await kit.api("admin", "PATCH", `/api/admin/tool-configs/${tool.id}`, { settings: { ...tool.settings, connected_model_ids: connected } });

    // 5. Web, now available for this model. A web reply is not captured: with
    //    the local OpenAI-compatible model the request is rejected ("System
    //    message must be at the beginning.") and the chat keeps showing
    //    "working"; that product bug is reported, not staged around.
    await page.context().close();
    page = await kit.app("user", "/chat");
    await composer(page).waitFor();
    menu = await openMenu(page);
    await setOption(menu, "Knowledge", false);
    await setOption(menu, "Web", true);
    await shot("send-web-on", { keepFocus: true });

    // 6. Agent profile picker, then off again.
    await setOption(menu, "Web", false);
    await setOption(menu, "Agent", true);
    await menu.locator(".agent-profile-picker").waitFor();
    await page.waitForTimeout(400);
    await shot("send-agent", { keepFocus: true });
    await setOption(menu, "Agent", false);

    // 7. Resources: search and insert a saved prompt.
    await menu.locator(".composer-options-tabs").getByRole("button", { name: "Resources" }).click();
    await menu.locator(".composer-resource-results").waitFor();
    await page.waitForTimeout(400);
    await shot("send-resources", { keepFocus: true });
    await menu.getByPlaceholder("Search resources by name…").fill("Matter Summary");
    await page.waitForTimeout(400);
    await menu.locator(".composer-resource-results").getByText("Matter Summary", { exact: true }).first().click();
    await page.waitForTimeout(600);
    if (await menu.isVisible()) await menu.getByRole("button", { name: "Close send options" }).click();
    if (!(await composer(page).inputValue()).trim()) throw new Error("The prompt was not inserted.");
    await shot("send-resource-inserted", { keepFocus: true });
  },
};

module.exports = { "user-send-options": userSendOptions };
