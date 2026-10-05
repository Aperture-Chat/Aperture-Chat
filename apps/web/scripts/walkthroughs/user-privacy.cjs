/* Personal data in a person's own chats, performed for real.
 *
 * user-personal-data: with the organization's Personal Data Protection and
 * training capture switched on (administrator setup through the API, never
 * captured as the person's own doing), the person sees the footer note, sends
 * a message with a synthetic SSN and email to the local model, reads the
 * concealed prompt and the reply the model wrote from placeholders, and opens
 * a rating note that explains the de-identified copy. Then, with the model
 * allowed to read values, a reply that writes out a synthetic phone number and
 * email arrives concealed. The organization's settings are restored afterwards.
 */
const { helpers } = require("./user-common.cjs");

const { scrollTo } = helpers;
const MODEL = /Qwen3\.5 9B/;
const ALL_CATEGORIES = ["identity", "contact", "financial", "health", "credentials", "network"];

async function newChat(page) {
  await page.getByRole("button", { name: "New chat" }).first().click().catch(() => {});
  await page.getByRole("button", { name: "Select model" }).click();
  await page.getByRole("option", { name: MODEL }).click();
  await page.locator(".composer textarea").waitFor();
}

async function ask(page, text) {
  const before = await page.locator("article.assistant-message").count();
  await page.locator(".composer textarea").fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  const reply = page.locator("article.assistant-message").nth(before);
  await reply.getByRole("button", { name: "Send positive feedback" }).waitFor({ timeout: 300000 });
  await page.waitForTimeout(2500);
  return reply;
}

const userPersonalData = {
  role: "user",
  description: "The footer note, a concealed prompt and reply, the rating-note disclosure, and values the model wrote, concealed.",
  frames: ["user/privacy-footer", "user/privacy-sent", "user/privacy-rating-note", "user/privacy-output"],
  async run(kit) {
    const { shot } = kit;
    // Setup: the organization protects personal data and captures training signals.
    await kit.api("admin", "PATCH", "/api/admin/privacy/policy", { enabled: true, conceal_from_model: true, categories: ALL_CATEGORIES });
    await kit.api("admin", "PATCH", "/api/admin/training/policy", { enabled: true });
    try {
      // 1. The footer says personal data is concealed.
      const page = kit.use(await kit.app("user", "/"));
      await newChat(page);
      await page.locator(".disclaimer-privacy").waitFor();
      await shot("privacy-footer");

      // 2. Send a message with a synthetic SSN and email.
      const reply = await ask(page, "Draft a two-sentence note to the benefits team: update the payroll record for employee SSN 123-45-6789 and confirm by email to jordan.lee@example.com.");
      await page.locator(".user-message .concealed-token").first().waitFor();
      if (await page.locator(".user-message").filter({ hasText: "123-45-6789" }).count()) throw new Error("The sent SSN is still shown.");
      await shot("privacy-sent");

      // 3. Rate the reply: the note explains the de-identified copy.
      await reply.getByRole("button", { name: "Send positive feedback" }).click();
      const note = page.getByRole("group", { name: "Feedback note" });
      await note.locator(".feedback-note-disclosure").waitFor();
      await scrollTo(page, note, "center");
      await shot("privacy-rating-note");
      await note.getByRole("button", { name: "Close feedback note" }).click();

      // 4. When the organization lets the model read values, values the
      // model writes are still concealed in its reply.
      await kit.api("admin", "PATCH", "/api/admin/privacy/policy", { conceal_from_model: false });
      await page.reload();
      await page.getByRole("navigation", { name: "Primary" }).waitFor();
      await newChat(page);
      const echoed = await ask(page, "Write a one-line email signature for Jordan Lee with the phone number (415) 555-0134 and the email jordan.lee@example.com.");
      await echoed.locator(".concealed-token").first().waitFor();
      if (await echoed.filter({ hasText: /555-0134|jordan\.lee@/ }).count()) throw new Error("A value the model wrote is still shown.");
      await shot("privacy-output");
    } finally {
      await kit.api("admin", "PATCH", "/api/admin/privacy/policy", { enabled: false, conceal_from_model: true });
      await kit.api("admin", "PATCH", "/api/admin/training/policy", { enabled: false });
    }
  },
};

module.exports = { "user-personal-data": userPersonalData };
