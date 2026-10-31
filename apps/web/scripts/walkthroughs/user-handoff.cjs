/* Chat → Drafts handoff, performed for real as the synthetic standard user
 * against the local training model.
 *
 * user-chat-to-drafts asks chat for a document. The chat holds the request
 * and offers "Write this in Drafts?"; Edit request returns it to the
 * composer, Continue in chat sends it to the model here, and Write in Drafts
 * opens Drafts, which writes and saves the document from the chat request.
 * A slide-deck request offers "Build this as a slide deck?", and Build in deck
 * editor builds real slides in the deck editor. A spreadsheet request offers
 * "Build this as a spreadsheet?", and Build in spreadsheet editor builds a real
 * workbook. Every reply, document, deck, and workbook is the local model's real
 * output.
 */
const { helpers } = require("./user-common.cjs");
const { composer, scrollTo } = helpers;

const MEMO = "Draft a one-page memo to the operations team about the synthetic vendor review schedule for November, with a short purpose, three dated milestones, and owners.";
const LETTER = "Write a short letter to a synthetic vendor, Northwind Example Supplies, confirming the kickoff meeting on 4 November.";
// The last sentence keeps a small local model's reply in the deck format.
const DECK = "Create a slide deck about the synthetic vendor review timeline for the operations team, with exactly four slides: title, goals, timeline, and next steps. Each slide's layout value is just the layout's name, with its fields beside it.";
const SHEET = "Create a spreadsheet to track four synthetic vendor reviews, with columns for vendor, owner, due date, and status. Put Example in every vendor name, and use job titles as owners.";

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
  await busy.filter({ hasText: busyText }).waitFor({ state: "detached", timeout: 3600000 });
  const failed = page.locator(".draft-event").filter({ hasText: /could not complete|request failed/ });
  if (await failed.count()) throw new Error(await failed.last().innerText());
  // A busy model can hold the account save for a while; a failed save offers Retry.
  const status = page.locator(".document-save-state");
  const saved = status.filter({ hasText: "Saved" });
  const retry = page.locator(".document-save-action").filter({ hasText: "Retry" });
  const editing = status.filter({ hasText: "Editing" });
  await saved.or(retry).or(editing).first().waitFor({ timeout: 600000 });
  await page.waitForTimeout(3000);
  if (await retry.isVisible().catch(() => false)) await retry.click();
  // A title the assistant chose counts as an edit: Editing stays until Save version.
  if (await editing.isVisible().catch(() => false)) await page.getByRole("button", { name: "Save version", exact: true }).click();
  await saved.waitFor({ timeout: 180000 });
  await page.waitForTimeout(1500);
}

/** The assistant can add sheets and land on the last one; a person opens the
 * tabs to find the data they asked for. */
async function showSheetWith(page, wanted) {
  const grid = page.getByRole("grid").first();
  const tabs = page.getByRole("tab");
  for (let index = 0; index < await tabs.count(); index += 1) {
    await tabs.nth(index).click();
    await page.waitForTimeout(600);
    if (wanted.test(await grid.innerText())) return;
  }
  throw new Error(`No sheet shows ${wanted}: ${(await page.locator(".draft-event").last().innerText()).slice(0, 200)}`);
}

const DECK_ATTEMPTS = 6;

/** Hand a deck request to Drafts. This model can answer in a shape the deck
 * rejects, which ends in a thin fallback deck (taught in troubleshooting). A
 * person would ask again, so the module does, in a new chat each time. */
async function buildDeckFromChat(kit) {
  const { shot } = kit;
  for (let attempt = 1; attempt <= DECK_ATTEMPTS; attempt += 1) {
    const page = await askInNewChat(kit, DECK, "Build this as a slide deck?");
    await shot("handoff-deck-card");
    await card(page).getByRole("button", { name: "Build in deck editor" }).click();
    await page.getByText("Building the slide deck you asked for in chat.").first().waitFor({ timeout: 30000 });
    const drafted = page.locator(".draft-event").filter({ hasText: /Drafted \d+ slides? with|Deck request failed/ }).last();
    await drafted.waitFor({ timeout: 3600000 });
    const slides = await page.locator(".deck-filmstrip").getByRole("button", { name: /^Slide \d+: / }).count();
    if (slides >= 3) {
      await waitForDraftsResult(page, "Building slides…");
      return page;
    }
    console.log(`  attempt ${attempt}: ${(await drafted.innerText()).split("\n")[0]}`);
    await page.context().close();
  }
  throw new Error(`The deck editor did not build a full deck in ${DECK_ATTEMPTS} attempts.`);
}

const userChatToDrafts = {
  role: "user",
  description: "Ask chat for a document, deck, or spreadsheet, then build it in Drafts, continue in chat, or edit the request.",
  externalOrigins: () => [],
  frames: [
    "user/handoff-card", "user/handoff-edit-request", "user/handoff-continued", "user/handoff-writing",
    "user/handoff-written", "user/handoff-deck-card", "user/handoff-deck-built", "user/handoff-sheet-card", "user/handoff-sheet-built",
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

    // 3. A spreadsheet request offers the spreadsheet editor, which builds a workbook.
    page = await askInNewChat(kit, SHEET, "Build this as a spreadsheet?");
    await shot("handoff-sheet-card");
    await card(page).getByRole("button", { name: "Build in spreadsheet editor" }).click();
    await page.getByText("Building the spreadsheet you asked for in chat.").first().waitFor({ timeout: 30000 });
    await waitForDraftsResult(page, "Building the workbook…");
    await showSheetWith(page, /owner/i);
    await shot("handoff-sheet-built");
    await page.context().close();

    // 4. A deck request offers the deck editor, which builds the slides.
    page = await buildDeckFromChat(kit);
    await shot("handoff-deck-built");
    await page.context().close();

    // 5. Continue in chat: the same kind of request, answered here.
    page = await askInNewChat(kit, LETTER, "Write this in Drafts?");
    await card(page).getByRole("button", { name: "Continue in chat" }).click();
    await card(page).waitFor({ state: "detached", timeout: 60000 });
    const reply = page.locator("article.assistant-message:not(.draft-handoff)").last();
    await reply.locator(".message-quick-actions").waitFor({ timeout: 3600000 });
    if (!/Northwind/i.test(await reply.innerText())) throw new Error("The chat reply does not answer the letter request.");
    await page.waitForTimeout(800);
    await scrollTo(page, page.locator("article.user-message").last(), "start");
    await shot("handoff-continued");
    await page.context().close();

    // 6. Write in Drafts: Drafts opens and writes the document from the request.
    page = await askInNewChat(kit, MEMO, "Write this in Drafts?");
    await card(page).getByRole("button", { name: "Write in Drafts" }).click();
    await page.getByText("Writing the document you asked for in chat.").first().waitFor({ timeout: 30000 });
    await page.locator(".draft-assistant-title small.is-working").filter({ hasText: "Writing…" }).waitFor();
    await page.locator(".work-trace.is-running .work-trace-step:not(.is-next)").nth(1).waitFor({ timeout: 120000 });
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
