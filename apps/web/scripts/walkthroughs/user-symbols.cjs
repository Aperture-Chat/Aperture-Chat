/* The five composer symbols, performed for real as the synthetic standard user.
 *
 * user-symbols opens each symbol menu (/ @ # $ >), inserts one item from each,
 * and records what the message box holds afterwards (inserted prompt text, the
 * Agent chip, the Knowledge chip, the skill-file chip, the queued automation).
 * It then sends one real message that combines a knowledge base (#) and a
 * skill file ($), and records the cited reply.
 */
const { helpers } = require("./user-common.cjs");
const { composer, waitForReply, scrollTo } = helpers;

async function openSymbol(page, symbol, filter = "") {
  const box = composer(page);
  await box.fill("");
  await box.click();
  await box.pressSequentially(symbol + filter, { delay: 60 });
  const menu = page.locator(".composer-command-menu[role='listbox']");
  await menu.waitFor();
  await page.waitForTimeout(500);
  return menu;
}

async function choose(page, menu, label) {
  await menu.locator(".composer-command-item").filter({ hasText: label }).first().click();
  await page.waitForTimeout(600);
}

const userSymbols = {
  role: "user",
  description: "Open each symbol menu, insert an item from it, and send a cited reply using # and $.",
  externalOrigins: () => [],
  frames: [
    "user/symbols-slash", "user/symbols-slash-inserted", "user/symbols-at", "user/symbols-at-inserted",
    "user/symbols-hash", "user/symbols-hash-inserted", "user/symbols-dollar", "user/symbols-dollar-inserted",
    "user/symbols-gt", "user/symbols-gt-queued", "user/symbols-reply",
  ],
  async run(kit) {
    const { shot } = kit;
    // An existing chat keeps the message box at the bottom, so menus open in full.
    const page = await kit.app("user", "/chat");
    await page.locator(".chat-row").filter({ hasText: "Synthetic training — vendor review checklist" }).first().click();
    await page.locator("article.assistant-message").first().waitFor();
    await composer(page).waitFor();
    const clearTools = async () => {
      const clear = page.locator(".composer-tools-clear");
      if (await clear.count()) await clear.click();
      await page.waitForTimeout(300);
    };
    await clearTools();

    // / prompts and MCP connections.
    let menu = await openSymbol(page, "/");
    await shot("symbols-slash", { keepFocus: true });
    await choose(page, menu, "Matter Summary");
    if (!(await composer(page).inputValue()).includes("Summarize")) throw new Error("The prompt text was not inserted.");
    await shot("symbols-slash-inserted", { keepFocus: true });

    // @ agents.
    menu = await openSymbol(page, "@");
    await shot("symbols-at", { keepFocus: true });
    await choose(page, menu, "Client Update Agent");
    await page.locator(".composer-tools-status").waitFor();
    await shot("symbols-at-inserted", { keepFocus: true });
    await clearTools();

    // # knowledge bases and files.
    menu = await openSymbol(page, "#");
    await shot("symbols-hash", { keepFocus: true });
    await choose(page, menu, "Litigation Playbook");
    await page.locator(".composer-tools-status").waitFor();
    await shot("symbols-hash-inserted", { keepFocus: true });
    await clearTools();

    // $ skill files.
    menu = await openSymbol(page, "$");
    await shot("symbols-dollar", { keepFocus: true });
    await choose(page, menu, "Citation Discipline");
    await page.locator(".attach-chip").filter({ hasText: "Citation-Discipline" }).waitFor();
    await shot("symbols-dollar-inserted", { keepFocus: true });

    // > automations (queued, not run here).
    menu = await openSymbol(page, ">");
    await shot("symbols-gt", { keepFocus: true });
    await choose(page, menu, "Client update checklist");
    await page.waitForTimeout(400);
    await shot("symbols-gt-queued", { keepFocus: true });
    await clearTools();

    // A real message with # and the $ skill file still attached.
    if (!(await page.locator(".attach-chip").filter({ hasText: "Citation-Discipline" }).count())) {
      menu = await openSymbol(page, "$");
      await choose(page, menu, "Citation Discipline");
    }
    menu = await openSymbol(page, "#");
    await choose(page, menu, "Litigation Playbook");
    const box = composer(page);
    await box.press("End");
    await box.pressSequentially("What should a responsive pleading preserve? Two sentences.", { delay: 15 });
    const before = await page.locator("article.assistant-message").count();
    await page.locator("form.composer .send-button").click();
    const reply = await waitForReply(page, before);
    if (!(await reply.locator(".message-citation-action").count())) throw new Error("The reply has no citations.");
    await scrollTo(page, reply, "start");
    await shot("symbols-reply");
  },
};

module.exports = { "user-symbols": userSymbols };
