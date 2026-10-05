/* A first conversation and everything you can do with a reply, performed for
 * real as the synthetic standard user against the local training model.
 *
 * user-chat fills a starter, sends a message, stops the reply while it runs,
 * edits and resends the prompt, copies the reply, rates it
 * with a note, expands the work trace, branches the reply into a new chat,
 * and transfers it to Drafts. Every reply is the model's real output.
 */
const { helpers } = require("./user-common.cjs");
const { scrollTo, composer, sendChat, waitForReply } = helpers;

const PROMPT = "List five agenda items for a 30-minute kickoff meeting for a synthetic vendor review.";
const EDITED = "List three agenda items for a 20-minute kickoff meeting for a synthetic vendor review.";

const userChat = {
  role: "user",
  description: "Send, stop, edit and resend, copy, rate, branch, and transfer a real reply.",
  externalOrigins: () => [],
  frames: [
    "user/chat-starter", "user/chat-typed", "user/chat-running", "user/chat-stopped",
    "user/chat-edit", "user/chat-edited", "user/chat-copied", "user/chat-feedback", "user/chat-feedback-sent",
    "user/trace-expanded", "user/chat-branched", "user/chat-transferred",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("user", "/chat");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: kit.APP });
    await composer(page).waitFor();

    // 1. A starter fills the box without sending; then the real question.
    await page.locator(".chat-starters").getByRole("button", { name: /Explore an idea/ }).click();
    await page.waitForTimeout(400);
    await shot("chat-starter", { keepFocus: true });
    await composer(page).fill(PROMPT);
    await shot("chat-typed", { keepFocus: true });

    // 2. Send, and stop while the reply is running.
    let before = await sendChat(page, PROMPT);
    const running = page.locator("article.assistant-message").nth(before);
    await running.locator(".pending-trace-stop").waitFor();
    await page.waitForTimeout(900);
    await shot("chat-running");
    await running.locator(".pending-trace-stop").click();
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
    await page.waitForTimeout(1500);
    await edited.locator(".message-quick-actions").waitFor({ timeout: 240000 });
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
    await edited.locator(".pending-trace-toggle").click();
    await edited.locator(".pending-trace.is-expanded").waitFor();
    await scrollTo(page, edited.locator(".pending-trace"), "center");
    await shot("trace-expanded");
    await edited.locator(".pending-trace-toggle").click();

    // 7. Branch the reply into a new chat.
    const origin = page.url();
    await edited.hover();
    await edited.locator(".branch-response-action").click();
    await page.waitForURL((url) => url.href !== origin);
    await page.locator("article.assistant-message").first().waitFor();
    await page.waitForTimeout(1500);
    await shot("chat-branched");

    // 8. Transfer the reply to Drafts.
    const reply = page.locator("article.assistant-message").first();
    await reply.locator(".transfer-draft-button").click();
    await page.waitForURL(/\/drafts/);
    await page.locator("[aria-label='Document body']").waitFor();
    await page.getByText("Transferred from chat into Drafts.").first().waitFor().catch(() => {});
    await page.waitForTimeout(2000);
    await shot("chat-transferred");
  },
};

module.exports = { "user-chat": userChat };
