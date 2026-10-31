/* Wall off documents and read file properties, performed for real in the
 * Library as the synthetic administrator against the local training model.
 *
 * Setup through the API, never captured as if the UI produced it: a knowledge
 * base shared with Litigation and Corporate holding a three-page PDF deal memo
 * and a Word checklist, and one new person in Corporate.
 *
 * Jane (Litigation) first asks about the deal and gets a cited answer. Alex
 * reads the file's properties and limits it to Corporate. Jane's same question
 * then finds nothing, the document leaves her list, and her saved citation no
 * longer opens (the saved reply keeps its text, which the lesson says plainly). Alex (not in Corporate) cannot find or open it either, which is
 * the point: walls screen administrators too. The Corporate member still gets
 * the cited answer. The Audit Trail shows the change and the refused attempts,
 * and User Prompt Activity shows that a wall covers the document, not chats:
 * Alex can read the figure in the member's reply there.
 *
 * Alex then uploads Word files whose own custom properties name a wall: one
 * naming a real group, one naming a group that does not exist (Hidden), and one
 * using a custom field that More wall fields turns into a wall. Finally Open
 * lifts a metadata wall, which only administrators can do.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { helpers } = require("./admin-shared.cjs");
const { helpers: people } = require("./user-common.cjs");
const { helpers: fixtures } = require("./knowledge-fixtures.cjs");
const { scrollTo, openTab, expandPanel, removeUsers } = helpers;
const { createPerson, signInWithPassword, scrollBelowHeader } = people;
const { wordFile, printPdf, uploadDocuments, askWithHash, sendAndWait, recreateKnowledgeBase, openKnowledgeBase, dismissNotice } = fixtures;

const KB = "Transaction files (synthetic)";
const MEMO = "project-bluebird-deal-memo.pdf";
const CHECKLIST = "integration-checklist.docx";
const OSPREY = "project-osprey-board-note.docx";
const HERON = "project-heron-summary.docx";
const TERN = "project-tern-note.docx";
const PERSON = { email: "priya.nair@example.test", name: "Priya Nair" };
const QUESTION = "What is the proposed purchase price for Harbor Analytics?";

const DEAL_MEMO = {
  title: "Project Bluebird deal memo",
  header: "Project Bluebird · synthetic",
  sections: [
    { heading: "Project Bluebird summary", paragraphs: [
      "Project Bluebird is the proposed purchase of Harbor Analytics by Example Corporation. This memo records the commercial terms the deal team has discussed so far.",
      "Everything in this memo is confidential. Only the deal team may read it until the transaction is announced.",
    ] },
    { heading: "Commercial terms", paragraphs: [
      "The proposed purchase price for Harbor Analytics is 42 million US dollars in cash, paid at closing.",
      "Ten percent of the price is held back for twelve months against any warranty claim.",
    ] },
    { heading: "Timetable", paragraphs: [
      "Due diligence runs through the end of November 2026, and signing is targeted for January 2027.",
      "Closing follows regulatory approval, which the deal team expects within ninety days of signing.",
    ] },
  ],
};

const INTEGRATION = {
  properties: { title: "Integration checklist", author: "Alex Morgan", subject: "Steps after any acquisition", company: "Example Corporation" },
  sections: [
    { heading: "Integration checklist", paragraphs: [
      "Use this checklist after any acquisition closes. Name an integration lead, confirm payroll for the new team, and move email within thirty days.",
      "Review vendor contracts and security access in the first ninety days.",
    ] },
  ],
};

const wallNote = (title, custom) => ({
  properties: { title, author: "Alex Morgan", company: "Example Corporation" },
  custom,
  sections: [
    { heading: title, paragraphs: ["This synthetic note stands in for a document that a matter-management system stamped with a property before it reached the knowledge base."] },
  ],
});

/** Show a file's properties and access, and return its expanded row. */
async function showDetails(page, name) {
  const row = page.locator(".knowledge-document-row-item").filter({ has: page.getByRole("button", { name: `Open ${name}` }) });
  await row.getByRole("button", { name: `Show details for ${name}` }).click();
  await row.locator(".knowledge-document-details").waitFor();
  await page.waitForTimeout(500);
  return row;
}

/** The reply has no figure from the walled memo, and the memo is not among its
 * sources. Other files in the base may still be cited. Fold the trace and show
 * whatever sources the reply has. */
async function proveScreened(page, reply) {
  if (/42 million|\$42/.test(await reply.innerText())) throw new Error("A person outside the wall received the walled figure.");
  await reply.locator(".work-trace-toggle").click();
  await reply.locator(".work-trace.is-expanded").waitFor({ state: "detached" });
  const action = reply.locator(".message-citation-action");
  if (!(await action.count())) return;
  await action.click();
  const sources = page.locator("aside.session-panel .session-sources");
  await sources.waitFor();
  if ((await sources.innerText()).includes(MEMO)) throw new Error("A walled document was listed as a source.");
  await page.waitForTimeout(800);
}

const adminWalls = {
  role: "admin",
  description: "Wall off a document, prove people outside the group and administrators cannot find or open it, read the audit entries, and honor walls named in file metadata.",
  externalOrigins: () => [],
  frames: [
    "admin/walls-before", "admin/walls-details", "admin/walls-limit", "admin/walls-saved", "admin/walls-user-list",
    "admin/walls-user-chat", "admin/walls-user-old", "admin/walls-user-denied", "admin/walls-admin-chat", "admin/walls-admin-denied",
    "admin/walls-member", "admin/walls-audit", "admin/walls-audit-denied", "admin/walls-audit-reply", "admin/walls-metadata", "admin/walls-hidden",
    "admin/walls-fields", "admin/walls-fields-applied", "admin/walls-lift",
  ],
  async run(kit) {
    const { shot } = kit;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-walls-"));
    const saved = path.join(dir, "memo.pdf");
    try {
      await printPdf(kit, saved, DEAL_MEMO);
      const memo = path.join(dir, MEMO);
      fs.renameSync(saved, memo);
      const checklist = path.join(dir, CHECKLIST);
      fs.writeFileSync(checklist, wordFile(INTEGRATION));
      const metadataFiles = [
        [OSPREY, wallNote("Project Osprey board note", { "Ethical wall": "Corporate", Classification: "Highly confidential" })],
        [HERON, wallNote("Project Heron summary", { "Information barrier": "Heron deal team" })],
        [TERN, wallNote("Project Tern note", { "Matter team": "Corporate" })],
      ].map(([name, file]) => {
        const target = path.join(dir, name);
        fs.writeFileSync(target, wordFile(file));
        return target;
      });
      await removeUsers(kit, [PERSON.email]);
      const person = await createPerson(kit, { ...PERSON, groups: ["group-corporate", "group-default-users"] });
      const config = await recreateKnowledgeBase(kit, KB, ["group-litigation", "group-corporate"]);
      await uploadDocuments(kit, "admin", config.id, [memo, checklist]);

      // 1. Before the wall: Jane, in Litigation, gets a cited answer.
      const jane = kit.use(await kit.app("user", "/chat"));
      await askWithHash(jane, KB, "Transaction", QUESTION);
      const before = await sendAndWait(jane);
      if (!/42 million|\$42/.test(await before.innerText())) throw new Error("Jane's reply did not use the deal memo.");
      if (!(await before.locator(".message-citation-action").count())) throw new Error("Jane's reply has no sources.");
      await before.locator(".work-trace-toggle").click();
      await before.locator(".work-trace.is-expanded").waitFor({ state: "detached" });
      await before.locator(".message-citation-action").click();
      await jane.locator("aside.session-panel").waitFor();
      await jane.waitForTimeout(800);
      await shot("walls-before", { page: jane });
      const janeChat = jane.url();
      if (!janeChat.includes("/chat/")) throw new Error("Jane's chat has no address to reopen.");

      // 2. The file's properties and who can find it.
      const page = kit.use(await kit.app("admin", "/library/knowledge"));
      await openKnowledgeBase(page, KB);
      const row = await showDetails(page, MEMO);
      await scrollTo(page, row, "start");
      await shot("walls-details");

      // 3. Limit it to Corporate. Alex is not in Corporate.
      const access = row.locator(".knowledge-access-editor");
      await access.getByRole("radio", { name: "Limit" }).click();
      await access.getByLabel("Corporate").check();
      await scrollBelowHeader(page, row, 70);
      await shot("walls-limit");
      await access.getByRole("button", { name: "Save access" }).click();
      await page.locator(".ws-notice").filter({ hasText: `Only members of Corporate can now find ${MEMO}.` }).waitFor();
      await row.locator(".knowledge-wall-badge").waitFor();
      await row.getByText("Limited to Corporate by an administrator. Nobody else can find it, administrators included.").waitFor();
      await scrollBelowHeader(page, row, 70);
      await page.waitForTimeout(600);
      await shot("walls-saved");

      // 4. Jane: gone from her list, gone from chat, and her citation is closed.
      await jane.goto(`${kit.APP}/library/knowledge`);
      await openKnowledgeBase(jane, KB);
      await jane.getByRole("button", { name: `Open ${CHECKLIST}` }).waitFor();
      await jane.waitForTimeout(800);
      if (await jane.getByRole("button", { name: `Open ${MEMO}` }).count()) throw new Error("The walled memo is still listed for Jane.");
      await shot("walls-user-list", { page: jane });
      await jane.goto(`${kit.APP}/chat`);
      await jane.locator('form.composer textarea[aria-label="Message"]').waitFor();
      await askWithHash(jane, KB, "Transaction", QUESTION);
      const outside = await sendAndWait(jane);
      await proveScreened(jane, outside);
      await shot("walls-user-chat", { page: jane });
      await jane.goto(janeChat);
      const oldReply = jane.locator("article.assistant-message").first();
      await oldReply.locator(".message-citation-action").waitFor();
      // A wall stops finding and opening. It does not rewrite saved replies.
      if (!/42 million|\$42/.test(await oldReply.innerText())) throw new Error("The saved reply changed; the lesson says it keeps its text.");
      await jane.waitForTimeout(800);
      await shot("walls-user-old", { page: jane });
      await oldReply.locator(".message-citation-action").click();
      const panel = jane.locator("aside.session-panel");
      await panel.waitFor();
      await panel.locator(".session-source-open").first().click();
      await jane.locator(".dv-state").getByText("This document is no longer available").waitFor();
      await jane.waitForTimeout(600);
      await shot("walls-user-denied", { page: jane });
      await jane.context().close();

      // 5. Alex, an administrator, is screened the same way.
      await dismissNotice(page);
      const adminChat = kit.use(await kit.app("admin", "/chat"));
      await askWithHash(adminChat, KB, "Transaction", QUESTION);
      const screened = await sendAndWait(adminChat);
      await proveScreened(adminChat, screened);
      await shot("walls-admin-chat", { page: adminChat });
      await adminChat.context().close();
      kit.use(page);
      await page.getByRole("button", { name: `Preview ${MEMO}` }).click();
      await page.locator(".dv-state").getByText("This document is no longer available").waitFor();
      await page.waitForTimeout(600);
      await shot("walls-admin-denied");
      await page.getByRole("button", { name: "Close document" }).click();
      await page.locator(".dv-panel").waitFor({ state: "detached" });

      // 6. A member of Corporate still gets the cited answer.
      const member = await signInWithPassword(kit, person.email, person.password);
      await member.goto(`${kit.APP}/chat`);
      await member.locator('form.composer textarea[aria-label="Message"]').waitFor();
      await askWithHash(member, KB, "Transaction", QUESTION);
      const inside = await sendAndWait(member);
      if (!/42 million|\$42/.test(await inside.innerText())) throw new Error("The Corporate member did not receive the answer.");
      if (!(await inside.locator(".message-citation-action").count())) throw new Error("The Corporate member's reply has no sources.");
      await inside.locator(".work-trace-toggle").click();
      await inside.locator(".work-trace.is-expanded").waitFor({ state: "detached" });
      await shot("walls-member", { page: member });
      await member.context().close();

      // 7. The Audit Trail records the change and the refused attempts.
      const consolePage = kit.use(await kit.app("admin", "/admin/users"));
      await openTab(consolePage, "Audit");
      const trail = await expandPanel(consolePage, "Audit Trail");
      await trail.locator(".panel-header").getByRole("button", { name: "Refresh" }).click();
      await trail.getByLabel("Search audit events").fill("document_wall");
      await trail.locator(".audit-row").filter({ hasText: "DOCUMENT_WALL_CHANGED" }).first().waitFor();
      await scrollTo(consolePage, trail.locator(".audit-filter-toolbar"), "start");
      await shot("walls-audit");
      await trail.getByLabel("Search audit events").fill("view_denied");
      await trail.locator(".audit-row").filter({ hasText: "DOCUMENT_VIEW_DENIED" }).first().waitFor();
      await consolePage.waitForTimeout(500);
      await shot("walls-audit-denied");

      // A wall covers the document, not chats: Alex cannot open the memo, yet
      // Audit shows him the reply Priya got, with the figure in it.
      const activity = await expandPanel(consolePage, "User Prompt Activity");
      await activity.getByRole("button", { name: "Refresh monitor" }).click();
      const priya = activity.locator(".prompt-activity-row").filter({ hasText: PERSON.name }).first();
      await priya.waitFor();
      await priya.locator(".prompt-activity-trigger").click();
      const preview = consolePage.locator(".prompt-output-modal");
      await preview.waitFor();
      if (!/42 million|\$42/.test(await preview.innerText())) throw new Error("Audit did not show the member's reply; the lesson says it does.");
      await consolePage.waitForTimeout(600);
      await shot("walls-audit-reply");
      await consolePage.context().close();

      // 8. Walls named in a file's own metadata.
      kit.use(page);
      await page.goto(`${kit.APP}/library/knowledge`);
      await openKnowledgeBase(page, KB);
      await page.locator("input[aria-label='Choose files to add']").setInputFiles(metadataFiles);
      await page.getByText("5 indexed files", { exact: false }).first().waitFor({ timeout: 180000 });
      await page.locator("text=Reading and indexing").waitFor({ state: "detached", timeout: 180000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await dismissNotice(page);
      await page.getByRole("button", { name: "Clear finished" }).click();
      const osprey = await showDetails(page, OSPREY);
      await osprey.getByText(/Ethical wall from the file's "Ethical wall" property: only Corporate can find it/).waitFor();
      await scrollTo(page, osprey, "start");
      await shot("walls-metadata");
      await osprey.getByRole("button", { name: `Hide details for ${OSPREY}` }).click();
      const heron = await showDetails(page, HERON);
      await heron.getByText(/It names no group in this workspace, so nobody can find it until the group exists\./).waitFor();
      await scrollTo(page, heron, "start");
      await shot("walls-hidden");
      await heron.getByRole("button", { name: `Hide details for ${HERON}` }).click();

      // 9. A base can read its own wall field.
      await page.getByRole("tab", { name: /Settings/ }).click();
      const field = page.getByLabel("More wall fields");
      await field.fill("Matter team");
      await scrollTo(page, field, "center");
      await shot("walls-fields", { keepFocus: true });
      await page.getByRole("button", { name: "Save changes" }).click();
      await page.locator(".ws-notice").filter({ hasText: "settings saved" }).waitFor();
      // The server rechecks every file at once; the open list shows it on reload.
      await page.goto(`${kit.APP}/library/knowledge`);
      await openKnowledgeBase(page, KB);
      const tern = await showDetails(page, TERN);
      await tern.getByText(/Ethical wall from the file's "Matter team" property: only Corporate can find it/).waitFor();
      await scrollTo(page, tern, "start");
      await shot("walls-fields-applied");
      await tern.getByRole("button", { name: `Hide details for ${TERN}` }).click();

      // 10. Only administrators can lift a wall.
      const lift = await showDetails(page, OSPREY);
      await lift.getByRole("radio", { name: "Open" }).click();
      await lift.getByRole("button", { name: "Save access" }).click();
      await page.locator(".ws-notice").filter({ hasText: `Everyone who can use this knowledge base can now find ${OSPREY}.` }).waitFor();
      await lift.getByText("An administrator lifted this file's wall. Everyone who can use this knowledge base can find it.").waitFor();
      await scrollTo(page, lift, "start");
      await shot("walls-lift");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

module.exports = { "admin-walls": adminWalls };
