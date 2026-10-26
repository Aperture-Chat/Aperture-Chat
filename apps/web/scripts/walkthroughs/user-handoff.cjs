/* Chat → Drafts handoff, performed for real as the synthetic standard user
 * against the local training model.
 *
 * user-chat-to-drafts asks chat for a document. The chat holds the request
 * and offers "Write this in Drafts?"; Edit request returns it to the
 * composer, Continue in chat sends it to the model here, and Write in Drafts
 * opens Drafts, which writes and saves the document from the chat request.
 * A slide-deck request offers "Build this as a slide deck?", and Build in deck
 * editor builds real slides in the deck editor. Every reply, document, and
 * deck is the local model's real output.
 */
const { helpers } = require("./user-common.cjs");
const { composer, scrollTo } = helpers;

const MEMO = "Draft a one-page memo to the operations team about the synthetic vendor review schedule for November, with a short purpose, three dated milestones, and owners.";
const LETTER = "Write a short letter to a synthetic vendor, Northwind Example Supplies, confirming the kickoff meeting on 4 November.";
const DECK = "Create a slide deck about the synthetic vendor review timeline for the operations team, with four slides.";

const card = (page) => page.locator("article.assistant-message.draft-handoff");

/** Type a request into a new chat and send it; the chat holds it and offers the card. */
async function askInNewChat(kit, text, heading) {
  const page = await kit.app("user", "/chat");
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await page.locator("form.composer .send-button").click();
  await card(page).getByRole("heading", { name: heading }).waitFor();
  await page.waitForTimeout(900);
  return page;
}

/** Wait for Drafts to finish the handed-off request and save it. */
async function waitForDraftsResult(page, busyText) {
  const busy = page.locator(".draft-assistant-title small.is-working");
  await busy.filter({ hasText: busyText }).waitFor({ state: "detached", timeout: 1800000 });
  const failed = page.locator(".draft-event").filter({ hasText: /could not complete|request failed/ });
  if (await failed.count()) throw new Error(await failed.last().innerText());
  // A busy model can hold the account save for a while; a failed save offers Retry.
  const saved = page.locator(".document-server-save-state").filter({ hasText: "Saved" });
  const retry = page.locator(".document-server-save-action").filter({ hasText: "Retry" });
  await saved.or(retry).first().waitFor({ timeout: 180000 });
  if (await retry.isVisible().catch(() => false)) await retry.click();
  await saved.waitFor({ timeout: 180000 });
  await page.waitForTimeout(1500);
}

const userChatToDrafts = {
  role: "user",
  description: "Ask chat for a document or deck, then write it in Drafts, continue in chat, or edit the request.",
  externalOrigins: () => [],
  frames: [
    "user/handoff-card", "user/handoff-edit-request", "user/handoff-continued", "user/handoff-writing",
    "user/handoff-written", "user/handoff-deck-card", "user/handoff-deck-built",
  ],
  async run(kit) {
    const { shot } = kit;

    // 1. A document request is held, and the card offers Drafts or chat.
    let page = await askInNewChat(kit, MEMO, "Write this in Drafts?");
    if (!(await page.locator("form.composer .send-button").isDisabled())) throw new Error("Send should wait for the choice.");
    await shot("handoff-card");

    // 2. Edit request returns the request to the composer, unchanged.
    await card(page).getByRole("button", { name: "Edit request" }).click();
    await card(page).waitFor({ state: "detached" });
    if ((await composer(page).inputValue()).trim() !== MEMO) throw new Error("Edit request did not return the request to the composer.");
    await page.waitForTimeout(600);
    await shot("handoff-edit-request");
    await page.context().close();

    // 3. A deck request offers the deck editor, which builds the slides.
    page = await askInNewChat(kit, DECK, "Build this as a slide deck?");
    await shot("handoff-deck-card");
    await card(page).getByRole("button", { name: "Build in deck editor" }).click();
    await page.getByText("Building the slide deck you asked for in chat.").first().waitFor({ timeout: 30000 });
    await page.locator(".draft-event").filter({ hasText: /Drafted \d+ slides? with|Deck request failed/ }).last().waitFor({ timeout: 1800000 });
    await waitForDraftsResult(page, "Building slides…");
    const slides = await page.locator(".deck-filmstrip").getByRole("button", { name: /^Slide \d+: / }).count();
    if (slides < 3) throw new Error(`The deck editor built only ${slides} slides.`);
    await shot("handoff-deck-built");
    await page.context().close();

    // 4. Continue in chat: the same kind of request, answered here.
    page = await askInNewChat(kit, LETTER, "Write this in Drafts?");
    await card(page).getByRole("button", { name: "Continue in chat" }).click();
    await card(page).waitFor({ state: "detached", timeout: 60000 });
    const reply = page.locator("article.assistant-message:not(.draft-handoff)").last();
    await reply.locator(".message-quick-actions").waitFor({ timeout: 600000 });
    if (!/Northwind/i.test(await reply.innerText())) throw new Error("The chat reply does not answer the letter request.");
    await page.waitForTimeout(800);
    await scrollTo(page, page.locator("article.user-message").last(), "start");
    await shot("handoff-continued");
    await page.context().close();

    // 5. Write in Drafts: Drafts opens and writes the document from the request.
    page = await askInNewChat(kit, MEMO, "Write this in Drafts?");
    await card(page).getByRole("button", { name: "Write in Drafts" }).click();
    await page.getByText("Writing the document you asked for in chat.").first().waitFor({ timeout: 30000 });
    await page.locator(".draft-assistant-title small.is-working").filter({ hasText: "Writing…" }).waitFor();
    await shot("handoff-writing", { keepFocus: true });
    await waitForDraftsResult(page, "Writing…");
    const body = page.getByRole("textbox", { name: "Document body", exact: true });
    const words = (await body.innerText()).split(/\s+/).filter(Boolean).length;
    if (words < 60) throw new Error(`Drafts wrote only ${words} words.`);
    await page.evaluate(() => document.querySelector("[aria-label='Document body']")?.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(600);
    await shot("handoff-written");
  },
};

module.exports = { "user-chat-to-drafts": userChatToDrafts };
