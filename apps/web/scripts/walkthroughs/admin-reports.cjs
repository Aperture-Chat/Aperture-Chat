/* Support tickets in the Admin console › Reports, performed for real.
 *
 * admin-reports: a person files a problem report from Help › Report a problem
 * (and sees the Security option's privacy notice); the admin finds it under
 * Needs reply, searches the queue, opens the ticket, sets Status, Priority,
 * and Assignee, adds an internal note, and replies to the person; the person
 * reads the reply in Help › My reports and answers; the ticket returns to
 * Needs reply; the admin replies and resolves it, the person sees Resolved
 * with Reopen report, and the Audit Trail lists every support event.
 * Every step uses the real UI on both sides; nothing is created through the
 * API.
 */
const { helpers } = require("./admin-shared.cjs");

const { scrollTo, openTab, expandPanel } = helpers;
const SUBJECT = "Synthetic training: Contracts folder link opens an empty page";
const MESSAGE =
  "Synthetic training report: the Contracts folder link in a saved chat opens an empty page. Steps: open the chat from Monday and choose the folder link.";
const NOTE = "Checked with the records team: the Contracts folder moved last week. Waiting on the new link.";
const REPLY = "Thanks, Jane. The Contracts folder moved last week. Which chat was the link in?";
const ANSWER = "It was in the Weekly vendor review chat from Monday.";
const RESOLVE = "The link in that chat now opens the new Contracts folder. Marking this resolved; reopen it if it still fails.";

async function openHelp(person) {
  await person.getByRole("button", { name: "Help", exact: true }).click();
  const help = person.getByRole("dialog", { name: "Help", exact: true });
  await help.waitFor();
  return help;
}

/** The person's own report in Help › My reports. */
async function openMyReport(kit, number) {
  const person = await kit.app("user", "/");
  const help = await openHelp(person);
  await help.getByRole("button", { name: /My reports/ }).click();
  const drawer = person.getByRole("dialog", { name: "My reports", exact: true });
  await drawer.getByRole("radio", { name: /^All/ }).click();
  const row = drawer.getByRole("button", { name: new RegExp(`^#${number} `) });
  await row.waitFor();
  return { person, drawer, row };
}

async function reportsTab(page) {
  await openTab(page, "Reports");
  await page.locator(".support-queue").waitFor();
  await page.waitForTimeout(600);
}

const adminReports = {
  role: "admin",
  description: "A person reports a problem; triage, note, reply, the person answers, resolve, and the audit trail.",
  frames: [
    "admin/rp-user-help", "admin/rp-user-form", "admin/rp-user-security", "admin/rp-user-sent", "admin/rp-queue",
    "admin/rp-search", "admin/rp-ticket", "admin/rp-triage", "admin/rp-internal", "admin/rp-reply",
    "admin/rp-user-reply", "admin/rp-needs-reply", "admin/rp-resolved", "admin/rp-user-resolved", "admin/rp-audit",
  ],
  async run(kit) {
    const { shot } = kit;

    // 1. The person opens Help: Report a problem and My reports.
    const person = kit.use(await kit.app("user", "/"));
    const help = await openHelp(person);
    await shot("rp-user-help");
    await help.getByRole("button", { name: /Report a problem/ }).click();
    const drawer = person.getByRole("dialog", { name: "Report a problem", exact: true });
    await drawer.waitFor();

    // The Security type explains that it stays private (shown, not sent).
    await drawer.getByRole("radio", { name: "Security" }).click();
    await drawer.getByText("Security concerns go only to your administrators and are never posted publicly.").waitFor();
    await shot("rp-user-security");

    // 2. A problem report: type, impact, subject, and message.
    await drawer.getByRole("radio", { name: "Problem" }).click();
    // Impact sets the starting priority: Slows me down is Normal; Blocking me starts High.
    await drawer.getByRole("radiogroup", { name: "Impact" }).getByRole("radio", { name: "Slows me down" }).click();
    await drawer.getByLabel("Subject", { exact: true }).fill(SUBJECT);
    await drawer.getByLabel("Message", { exact: true }).fill(MESSAGE);
    await scrollTo(person, drawer.getByLabel("Subject", { exact: true }), "center");
    await shot("rp-user-form");
    await drawer.getByRole("button", { name: "Send report", exact: true }).click();
    const sent = drawer.locator(".issue-report-success");
    await sent.getByText(/^Report #\d+ sent$/).waitFor();
    const number = Number((await sent.locator("strong").innerText()).match(/#(\d+)/)[1]);
    await shot("rp-user-sent");

    // 3. The admin's queue: the new report needs a reply.
    const page = kit.use(await kit.app("admin", "/admin/users"));
    await reportsTab(page);
    await page.getByRole("radiogroup", { name: "Filter reports" }).getByRole("radio", { name: /^Needs reply/ }).click();
    const row = page.getByRole("button", { name: `#${number} ${SUBJECT}` });
    await row.waitFor();
    await shot("rp-queue");

    // 4. Search finds it by subject, person, or number.
    await page.getByRole("radiogroup", { name: "Filter reports" }).getByRole("radio", { name: /^Open/ }).click();
    await page.getByLabel("Search reports").fill("Contracts folder");
    await row.waitFor();
    await page.waitForTimeout(400);
    await shot("rp-search");

    // 5. Open the ticket.
    await row.click();
    const detail = page.locator(".support-detail");
    await detail.getByRole("heading", { name: SUBJECT }).waitFor();
    await detail.locator(".support-detail-controls").waitFor();
    await page.waitForTimeout(600);
    await shot("rp-ticket");

    // 6. Triage: Status, Priority, Assignee. Each saves at once.
    const controls = detail.locator(".support-detail-controls");
    await controls.getByLabel("Status", { exact: true }).selectOption({ label: "In review" });
    await detail.getByText("Status changed to In review", { exact: false }).first().waitFor();
    await controls.getByLabel("Priority", { exact: true }).selectOption({ label: "High" });
    await detail.getByText("Priority changed to High", { exact: false }).first().waitFor();
    await controls.getByLabel("Assignee", { exact: true }).selectOption({ label: "Alex Morgan" });
    await detail.getByText("Assigned to", { exact: false }).first().waitFor();
    await page.waitForTimeout(500);
    await scrollTo(page, controls, "start");
    await page.evaluate(() => window.scrollBy(0, -90));
    await shot("rp-triage");

    // 7. An internal note: only administrators see it.
    const composer = detail.locator(".support-composer");
    await composer.getByRole("radio", { name: "Internal note" }).click();
    await composer.getByLabel("Internal note", { exact: true }).fill(NOTE);
    await composer.getByRole("button", { name: "Add note" }).click();
    const internal = detail.locator(".support-timeline .ticket-message.is-internal").filter({ hasText: NOTE });
    await internal.waitFor();
    await scrollTo(page, internal, "center");
    await shot("rp-internal");

    // 8. Reply to the person.
    await composer.getByRole("radio", { name: "Reply to Jane" }).click();
    await composer.getByLabel("Reply", { exact: true }).fill(REPLY);
    await scrollTo(page, composer, "center");
    await shot("rp-reply");
    await composer.getByRole("button", { name: "Send reply" }).click();
    await detail.locator(".support-timeline .ticket-message.is-support").filter({ hasText: REPLY }).waitFor();

    // 9. The person reads the reply in My reports and answers. The internal note is not there.
    const mine = await openMyReport(kit, number);
    kit.use(mine.person);
    await mine.row.click();
    const thread = mine.drawer.locator(".my-report-detail");
    await thread.getByText(REPLY).waitFor();
    if (await thread.getByText(NOTE).count()) throw new Error("The person can see the internal note.");
    await thread.getByLabel("Add a reply").fill(ANSWER);
    await scrollTo(mine.person, thread.locator(".ticket-composer"), "end");
    await shot("rp-user-reply");
    await thread.getByRole("button", { name: "Send reply" }).click();
    await thread.locator(".ticket-message.is-reporter").filter({ hasText: ANSWER }).waitFor();

    // 10. The ticket is back in Needs reply.
    kit.use(page);
    await page.getByRole("button", { name: /Refresh/ }).first().click();
    await page.getByRole("radiogroup", { name: "Filter reports" }).getByRole("radio", { name: /^Needs reply/ }).click();
    await page.getByLabel("Search reports").fill("");
    const waiting = page.locator(".support-ticket-row.needs-reply").filter({ hasText: SUBJECT });
    await waiting.waitFor();
    await page.waitForTimeout(500);
    await scrollTo(page, page.locator(".support-toolbar"), "start");
    await page.evaluate(() => window.scrollBy(0, -90));
    await shot("rp-needs-reply");

    // 11. Reply and resolve in one step. Refresh updates the list but not the
    //     report already open (reported), so reload before reopening it.
    await page.reload();
    await page.getByRole("tablist", { name: "Admin sections" }).waitFor();
    await reportsTab(page);
    await page.getByRole("radiogroup", { name: "Filter reports" }).getByRole("radio", { name: /^Needs reply/ }).click();
    await page.locator(".support-ticket-row.needs-reply").filter({ hasText: SUBJECT }).click();
    await detail.getByText(ANSWER).waitFor();
    await composer.getByRole("radio", { name: "Reply to Jane" }).click();
    await composer.getByLabel("Reply", { exact: true }).fill(RESOLVE);
    await composer.getByRole("button", { name: "Reply and resolve" }).click();
    await detail.getByText("Status changed to Resolved", { exact: false }).first().waitFor();
    if ((await controls.getByLabel("Status", { exact: true }).inputValue()) !== "resolved") throw new Error("The ticket is not Resolved.");
    await page.waitForTimeout(500);
    await scrollTo(page, page.locator(".support-toolbar"), "start");
    await page.evaluate(() => window.scrollBy(0, -90));
    await shot("rp-resolved");

    // 12. The person sees Resolved, with Reopen report.
    const closed = await openMyReport(kit, number);
    kit.use(closed.person);
    await closed.row.click();
    const resolved = closed.drawer.locator(".my-report-detail");
    await resolved.getByText(RESOLVE).waitFor();
    await resolved.getByRole("button", { name: "Reopen report" }).waitFor();
    await scrollTo(closed.person, resolved.locator(".ticket-composer"), "end");
    await shot("rp-user-resolved");

    // 13. Every step is in the Audit Trail.
    kit.use(page);
    await openTab(page, "Audit");
    const trail = await expandPanel(page, "Audit Trail");
    await trail.locator(".panel-header").getByRole("button", { name: "Refresh" }).click();
    await trail.getByLabel("Filter audit events by category").selectOption("support");
    await trail.locator(".audit-row").filter({ hasText: "ISSUE_REPORTER_REPLIED" }).first().waitFor();
    await scrollTo(page, trail.locator(".audit-filter-toolbar"), "start");
    await shot("rp-audit");
  },
};

module.exports = { "admin-reports": adminReports };
