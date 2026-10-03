/* Attaching files and sources to a chat message, performed for real as the
 * synthetic standard user.
 *
 * user-attachments opens the paperclip menu, uploads a synthetic Markdown file
 * created at run time and asks about a fact only that file contains, attaches
 * a reserved documentation page (https://example.com) by link and asks about
 * it, and opens a cloud source to record the real state when the connector is
 * not set up. The model's replies are real; the checks below confirm each one
 * used the attached content.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { helpers } = require("./user-common.cjs");
const { composer, sendChat, waitForReply, scrollTo } = helpers;

const CHECKLIST = [
  "# Synthetic vendor checklist",
  "",
  "- Vendor: Example Logistics (synthetic)",
  "- Renewal date: 30 November 2026",
  "- Security contact: security@vendor.example",
  "- Status: questionnaire received; data-processing terms pending",
  "",
].join("\n");

async function openAttachMenu(page) {
  const menu = page.locator(".attach-menu");
  if (!(await menu.isVisible())) await page.locator("form.composer .attach-trigger").click();
  await menu.waitFor();
  await page.waitForTimeout(400);
  return menu;
}

const userAttachments = {
  role: "user",
  description: "Upload a file, attach a web page by link, and open a cloud source, with real replies.",
  externalOrigins: () => [],
  frames: [
    "user/attach-menu", "user/attach-file-ready", "user/attach-file-reply",
    "user/attach-link-field", "user/attach-link-chip", "user/attach-link-reply", "user/attach-connector",
  ],
  async run(kit) {
    const { shot } = kit;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-attach-"));
    const file = path.join(dir, "synthetic-vendor-checklist.md");
    fs.writeFileSync(file, CHECKLIST);
    try {
      const page = await kit.app("user", "/chat");
      await composer(page).waitFor();
      const clear = page.locator(".composer-tools-clear");
      if (await clear.count()) await clear.click();

      // 1. The paperclip menu.
      await openAttachMenu(page);
      await shot("attach-menu", { keepFocus: true });

      // 2. Upload from computer, then ask about a fact only the file holds.
      const chooser = page.waitForEvent("filechooser");
      await page.locator(".attach-option").filter({ hasText: "Upload from computer" }).click();
      await (await chooser).setFiles(file);
      const chip = page.locator(".attach-chip").filter({ hasText: "synthetic-vendor-checklist.md" });
      await chip.waitFor();
      await page.locator(".attach-chip.is-ready").filter({ hasText: "synthetic-vendor-checklist.md" }).waitFor({ timeout: 60000 });
      await composer(page).fill("From the attached checklist: when is the renewal date, and who is the security contact?");
      await shot("attach-file-ready", { keepFocus: true });
      let before = await sendChat(page, await composer(page).inputValue());
      let reply = await waitForReply(page, before);
      const text = await reply.innerText();
      if (!/30 November 2026|November 30, 2026/.test(text)) throw new Error(`The reply did not use the attached file: ${text.slice(0, 200)}`);
      await scrollTo(page, reply, "start");
      await shot("attach-file-reply");

      // 3. Web page by link.
      await openAttachMenu(page);
      await page.locator(".attach-option").filter({ hasText: "Web page by link" }).click();
      const address = page.getByLabel("Web page address");
      await address.fill("https://example.com");
      await shot("attach-link-field", { keepFocus: true });
      await page.getByRole("button", { name: "Add link" }).click();
      await page.locator(".composer-mcp-chip").filter({ hasText: "example.com" }).waitFor();
      await composer(page).fill("In one sentence, what does the attached web page say it is for?");
      await shot("attach-link-chip", { keepFocus: true });
      before = await sendChat(page, await composer(page).inputValue());
      reply = await waitForReply(page, before);
      if (!/example|documentation|illustrative/i.test(await reply.innerText())) throw new Error("The reply did not use the attached page.");
      await scrollTo(page, reply, "start");
      await shot("attach-link-reply");

      // 4. A cloud source that has not been set up for this workspace.
      await openAttachMenu(page);
      await page.locator(".attach-option").filter({ hasText: "Google Drive" }).click();
      await page.locator(".cloud-picker-modal").waitFor();
      await page.waitForTimeout(1500);
      await shot("attach-connector");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

module.exports = { "user-attachments": userAttachments };
