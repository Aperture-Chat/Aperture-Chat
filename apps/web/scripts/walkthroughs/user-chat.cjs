/* A first conversation and everything you can do with a reply, performed for
 * real as the synthetic standard user against the local training model.
 *
 * user-chat fills a starter, sends a message, stops the reply while it runs,
 * edits and resends the prompt, folds the running work trace, copies the reply,
 * rates it with a note, expands the finished trace, branches the reply into a
 * new chat, and transfers it to Drafts through the format chooser, as a Word
 * document and then as a slide deck. Every reply is the model's real output.
 */
const { helpers } = require("./user-common.cjs");
const { scrollTo, composer, sendChat, waitForReply } = helpers;

const PROMPT = "List five agenda items for a 30-minute kickoff meeting for a synthetic vendor review.";
const EDITED = "List three agenda items for a 20-minute kickoff meeting for a synthetic vendor review.";

const userChat = {
  role: "user",
  description: "Send, stop, edit and resend, read the trace, copy, rate, branch, and transfer a real reply.",
  externalOrigins: () => [],
  frames: [
    "user/chat-starter", "user/chat-typed", "user/chat-running", "user/chat-stopped",
    "user/chat-edit", "user/trace-running-folded", "user/chat-edited", "user/chat-copied", "user/chat-feedback", "user/chat-feedback-sent",
    "user/trace-expanded", "user/chat-branched", "user/transfer-menu", "user/chat-transferred", "user/chat-transferred-deck",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("user", "/chat");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: kit.APP });
    await composer(page).waitFor();
    // A first chat starts with no send options on (user-send-options
    // disconnects the web search it connects, which would otherwise default on).
    if (await page.locator(".composer-tools-status").count()) throw new Error("Send options are on in a new chat; reset or rerun user-send-options teardown.");

    // 1. A starter fills the box without sending; then the real question.
    await page.locator(".chat-starters").getByRole("button", { name: /Explore an idea/ }).click();
    await page.waitForTimeout(400);
    await shot("chat-starter", { keepFocus: true });
    await composer(page).fill(PROMPT);
    await shot("chat-typed", { keepFocus: true });

    // 2. Send, and stop while the reply is running.
    let before = await sendChat(page, PROMPT);
    const running = page.locator("article.assistant-message").nth(before);
    await running.locator(".work-trace-stop").waitFor();
    // Steps land one at a time, so wait for them before the frame.
    await running.locator(".work-trace-step.is-next").waitFor();
    await page.waitForTimeout(1800);
    await shot("chat-running");
    await running.locator(".work-trace-stop").click();
    await running.getByText(/You stopped this response before it finished/).waitFor();
    await page.waitForTimeout(600);
    await shot("chat-stopped");

    // 3. A stopped reply has no actions; resend by editing your message.
    const mine = page.locator("article.user-message").first();
    await mine.hover();
    await mine.getByRole("button", { name: "Edit message" }).click();
    const editor = page.locator("article.user-message textarea[aria-label='Edit message']");
    await editor.fill(EDITED);
    await shot("chat-edit", { keepFocus: true });
    await page.getByRole("button", { name: "Send edited message" }).click();
    const edited = page.locator("article.assistant-message").first();

    // 4. The running trace folds to one line; the choice carries over when the reply lands.
    await edited.locator(".work-trace-stop").waitFor();
    await page.waitForTimeout(2200);
    await edited.locator(".work-trace-toggle").click();
    await edited.locator(".work-trace-next").waitFor();
    await shot("trace-running-folded");
    await edited.locator(".message-quick-actions").waitFor({ timeout: 2400000 });
    await page.waitForTimeout(1000);
    await shot("chat-edited");

    // 5. Copy, then rate with a note.
    await edited.getByRole("button", { name: "Copy response text" }).click();
    await edited.locator(".message-action-status").filter({ hasText: "Copied" }).waitFor();
    await shot("chat-copied");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    if (!copied.trim()) throw new Error("Copy did not place the reply on the clipboard.");
    await page.waitForTimeout(2500);
    await edited.getByRole("button", { name: "Send positive feedback" }).click();
    const note = edited.locator(".feedback-note-composer textarea");
    await note.waitFor();
    await note.fill("Short and easy to reuse for the meeting invite.");
    await shot("chat-feedback", { keepFocus: true });
    await edited.getByRole("button", { name: "Send note" }).click();
    await edited.locator(".message-action-status").filter({ hasText: "Note sent" }).waitFor();
    await shot("chat-feedback-sent");

    // 6. The work trace behind the reply.
    await page.waitForTimeout(2500);
    await edited.locator(".work-trace-toggle").click();
    await edited.locator(".work-trace.is-expanded").waitFor();
    await scrollTo(page, edited.locator(".work-trace"), "center");
    await shot("trace-expanded");
    await edited.locator(".work-trace-toggle").click();

    // 7. Branch the reply into a new chat.
    const origin = page.url();
    await edited.hover();
    await edited.locator(".branch-response-action").click();
    await page.waitForURL((url) => url.href !== origin);
    await page.locator("article.assistant-message").first().waitFor();
    await page.waitForTimeout(1500);
    await shot("chat-branched");

    // 8. Transfer to Drafts: the chooser, then a Word document.
    const branched = page.url();
    const reply = page.locator("article.assistant-message").first();
    await reply.locator(".transfer-draft-button").click();
    await page.locator(".transfer-draft-menu").waitFor();
    await scrollTo(page, page.locator(".transfer-draft-menu"), "center");
    await shot("transfer-menu");
    await page.locator(".transfer-draft-option").filter({ hasText: "Word document" }).click();
    await page.waitForURL(/\/drafts/);
    await page.locator("[aria-label='Document body']").waitFor();
    await page.getByText("Transferred from chat into Drafts.").first().waitFor().catch(() => {});
    await page.waitForTimeout(2000);
    await shot("chat-transferred");

    // 9. The same reply again, as a slide deck.
    await page.goto(branched);
    const again = page.locator("article.assistant-message").first();
    await again.locator(".transfer-draft-button").click();
    await page.locator(".transfer-draft-option").filter({ hasText: "Slide deck" }).click();
    await page.waitForURL(/\/drafts/);
    await page.locator(".deck-filmstrip").waitFor();
    await page.waitForTimeout(2500);
    await shot("chat-transferred-deck");
  },
};

module.exports = { "user-chat": userChat };
