/* Reporting a problem and following it up, performed for real as the
 * synthetic standard user (Jane Smith) with an administrator on the other side.
 *
 * user-reports opens Help › Report a problem, sends a Problem report with an
 * impact level, a screenshot, and technical details, and follows it in
 * My reports. The administrator's part (Alex Morgan) is done through the real
 * Admin console › Reports screen in a second browser that is never captured:
 * moving the report to In review with a reply, and later Reply and resolve.
 * The person sees the Help dot, reads the reply, answers with Send reply,
 * finds the resolved report under Closed, and reopens it. Finally the Idea and
 * Security forms are shown and sent, and My reports › All lists all three.
 * Nothing is sent through the API on anyone's behalf; the API is read only to
 * check that the instance starts clean and that the administrator's changes
 * arrived. Reset the instance before re-running.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { helpers } = require("./user-common.cjs");
const { scrollTo } = helpers;

const PROBLEM = {
  subject: "Export panel closes when I press Escape",
  body: "Steps: open a draft, choose Export, then press Escape while picking a format. Expected: the panel stays open until I choose Close. Actual: it closes and my choices are lost. (Synthetic training report.)",
};
const IDEA = {
  subject: "Remember my usual export format",
  body: "I export most drafts to Word. Starting the Export panel on my last format would save a step every time. (Synthetic training report.)",
};
const SECURITY = {
  subject: "Email asked me to confirm my password through a link",
  body: "An email that mentioned our workspace asked me to confirm my password through a link. I did not open it. (Synthetic training report.)",
};
const ADMIN_REPLY = "Thanks, Jane. I can reproduce this on the Export panel and have passed it on. Which browser are you using?";
const USER_REPLY = "Chrome on a Mac. It happens in every draft I try.";
const ADMIN_RESOLVE = "Fixed in today's update: Escape no longer closes the Export panel. Let us know if you still see it.";
const USER_REOPEN = "It still closes when I press Escape on the Word option.";

async function openHelp(page) {
  await page.getByRole("button", { name: "Help", exact: true }).click();
  const help = page.getByRole("dialog", { name: "Help" });
  await help.waitFor();
  await help.locator(".my-reports-entry").waitFor();
  await page.waitForTimeout(600);
  return help;
}

async function chooseKind(page, label) {
  await page.getByRole("radiogroup", { name: "Report type" }).getByRole("radio", { name: label, exact: true }).click();
  await page.waitForTimeout(300);
}

/** The administrator's part, in the Admin console › Reports screen. */
async function adminConsole(kit) {
  const admin = await kit.app("admin", "/admin/reports");
  await admin.locator(".support-queue-list").waitFor();
  return admin;
}

async function adminOpenReport(admin, number, subject) {
  // All lists open and closed reports alike.
  await admin.getByRole("radiogroup").first().getByRole("radio", { name: /^All/ }).click().catch(() => {});
  const row = admin.getByRole("button", { name: `#${number} ${subject}` });
  await row.waitFor();
  await row.click();
  await admin.locator(".support-detail .support-detail-controls").waitFor();
  await admin.waitForTimeout(500);
}

async function myReports(kit) {
  return kit.api("user", "GET", "/api/issue-reports/mine");
}

const userReports = {
  role: "user",
  description: "Send a Problem report with a screenshot, follow its status and replies in My reports, reply, see it resolved, and reopen it; Idea and Security forms.",
  externalOrigins: () => [],
  frames: [
    "user/report-help", "user/report-kind", "user/report-filled", "user/report-screenshot", "user/report-sent",
    "user/report-status", "user/report-dot", "user/report-unread", "user/report-reply", "user/report-replied",
    "user/report-closed", "user/report-reopen", "user/report-reopened", "user/report-idea", "user/report-security",
    "user/report-all",
  ],
  async run(kit) {
    const { shot } = kit;
    const subjects = [PROBLEM.subject, IDEA.subject, SECURITY.subject];
    if ((await myReports(kit)).some((item) => subjects.includes(item.subject))) throw new Error("Reset the instance first: these reports were already sent.");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-report-"));
    try {
      // The screenshot to attach: the Drafts Export panel, captured at run time.
      let page = kit.use(await kit.app("user", "/drafts"));
      await page.getByRole("button", { name: /^Export/ }).first().click();
      await page.locator("#document-export-panel").waitFor();
      await page.mouse.move(1, 1);
      await page.waitForTimeout(600);
      const screenshot = path.join(dir, "export-panel.png");
      await page.screenshot({ path: screenshot, clip: { x: 456, y: 0, width: 729, height: 560 } });
      await page.goto(kit.APP + "/chat");
      await page.getByRole("navigation", { name: "Primary" }).waitFor();
      await page.waitForTimeout(800);

      // 1. Help › Report a problem and My reports.
      let help = await openHelp(page);
      await shot("report-help");

      // 2. What would you like to send? Problem, and how much it affects you.
      await help.locator(".report-problem-entry").click();
      const form = page.locator(".issue-report-form");
      await form.waitFor();
      await chooseKind(page, "Problem");
      await page.getByRole("radiogroup", { name: "Impact" }).getByRole("radio", { name: "Slows me down", exact: true }).click();
      await page.waitForTimeout(300);
      await shot("report-kind");

      // 3. Subject and Message.
      await form.getByLabel("Subject").fill(PROBLEM.subject);
      await form.getByLabel("Message").fill(PROBLEM.body);
      await shot("report-filled");

      // 4. A screenshot (Choose image) and the technical details.
      const chooser = page.waitForEvent("filechooser");
      await form.getByRole("button", { name: "Choose image" }).click();
      await (await chooser).setFiles(screenshot);
      await form.locator(".issue-report-thumb").waitFor();
      if (!(await form.getByLabel("Include technical details").isChecked())) throw new Error("Technical details should be included by default.");
      await form.getByRole("button", { name: /What's included/ }).click();
      await form.locator(".issue-report-details-list").waitFor();
      await scrollTo(page, form.locator(".issue-report-details"), "end");
      await shot("report-screenshot");

      // 5. Send report.
      await form.getByRole("button", { name: "Send report" }).click();
      const success = page.locator(".issue-report-success");
      await success.waitFor();
      const sent = (await myReports(kit)).find((item) => item.subject === PROBLEM.subject);
      if (!sent?.number) throw new Error("The report was not recorded.");
      await success.getByText(`Report #${sent.number} sent`).waitFor();
      await shot("report-sent");

      // 6. View status: My reports, Received.
      await success.getByRole("button", { name: "View status" }).click();
      await page.locator(".my-report-detail .ticket-tracker").waitFor();
      await page.waitForTimeout(600);
      await shot("report-status");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);

      // The administrator moves it to In review and replies (not captured).
      let admin = await adminConsole(kit);
      await adminOpenReport(admin, sent.number, PROBLEM.subject);
      await admin.getByLabel("Status", { exact: true }).selectOption({ label: "In review" });
      await admin.locator(".support-detail").getByText("Status changed to In review").waitFor();
      await admin.getByRole("textbox", { name: "Reply", exact: true }).fill(ADMIN_REPLY);
      await admin.getByRole("button", { name: "Send reply", exact: true }).click();
      await admin.locator(".support-timeline").getByText(ADMIN_REPLY).waitFor();
      await admin.context().close();

      // 7. The Help dot: the workspace checks for news when it loads.
      page = kit.use(page);
      await page.reload();
      await page.getByRole("navigation", { name: "Primary" }).waitFor();
      await page.locator(".help-unread-dot").waitFor();
      await page.waitForTimeout(800);
      await shot("report-dot");

      // 8. Help shows the number of reports with news on My reports.
      help = await openHelp(page);
      await help.locator(".my-reports-entry .count-badge").waitFor();
      await shot("report-unread");

      // 9. Read the reply and answer it.
      await help.locator(".my-reports-entry").click();
      const list = page.locator(".my-reports-list");
      await list.waitFor();
      await list.getByRole("button", { name: new RegExp(`^#${sent.number} `) }).click();
      const detail = page.locator(".my-report-detail");
      await detail.locator(".ticket-message.is-support").filter({ hasText: ADMIN_REPLY }).waitFor();
      await detail.getByRole("textbox").fill(USER_REPLY);
      await scrollTo(page, detail.locator(".ticket-composer"), "end");
      await shot("report-reply");
      await detail.getByRole("button", { name: "Send reply", exact: true }).click();
      await detail.locator(".ticket-message.is-reporter").filter({ hasText: USER_REPLY }).waitFor();
      await scrollTo(page, detail.locator(".ticket-composer"), "end");
      await shot("report-replied");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);

      // The administrator answers and resolves it in one step (not captured).
      admin = await adminConsole(kit);
      await adminOpenReport(admin, sent.number, PROBLEM.subject);
      await admin.locator(".support-timeline").getByText(USER_REPLY).waitFor();
      await admin.getByRole("textbox", { name: "Reply", exact: true }).fill(ADMIN_RESOLVE);
      await admin.getByRole("button", { name: "Reply and resolve", exact: true }).click();
      await admin.locator(".support-timeline").getByText(ADMIN_RESOLVE).waitFor();
      await admin.context().close();
      const resolved = (await myReports(kit)).find((item) => item.id === sent.id);
      if (resolved?.status !== "resolved") throw new Error(`The report was not resolved (${resolved?.status}).`);

      // 10. Closed lists resolved reports.
      page = kit.use(page);
      await page.reload();
      await page.getByRole("navigation", { name: "Primary" }).waitFor();
      help = await openHelp(page);
      await help.locator(".my-reports-entry").click();
      await page.locator(".my-reports").waitFor();
      await page.getByRole("radiogroup", { name: "Show reports" }).getByRole("radio", { name: /^Closed/ }).click();
      await page.locator(".my-reports-list").getByText(PROBLEM.subject).waitFor();
      await page.waitForTimeout(500);
      await shot("report-closed");

      // 11. Still having this problem? Reopen report.
      await page.locator(".my-reports-list").getByRole("button", { name: new RegExp(`^#${sent.number} `) }).click();
      const reopen = page.locator(".my-report-detail");
      await reopen.getByText("Still having this problem?").waitFor();
      await reopen.getByRole("textbox").fill(USER_REOPEN);
      await scrollTo(page, reopen.locator(".ticket-composer"), "end");
      await shot("report-reopen");
      await reopen.getByRole("button", { name: "Reopen report", exact: true }).click();
      await reopen.getByRole("button", { name: "Send reply", exact: true }).waitFor();
      await scrollTo(page, reopen.locator(".ticket-timeline > li").last(), "end");
      await page.waitForTimeout(400);
      await shot("report-reopened");
      if ((await myReports(kit)).find((item) => item.id === sent.id)?.status !== "new") throw new Error("The report did not reopen.");

      // 12. Other kinds: an Idea (no impact question) and a Security concern.
      await reopen.getByRole("button", { name: "My reports" }).click();
      await page.getByRole("button", { name: "New report" }).click();
      const next = page.locator(".issue-report-form");
      await next.waitFor();
      await chooseKind(page, "Idea");
      await next.getByLabel("Subject").fill(IDEA.subject);
      await next.getByLabel("Message").fill(IDEA.body);
      await scrollTo(page, next, "start");
      await shot("report-idea");
      await next.getByRole("button", { name: "Send report" }).click();
      await page.locator(".issue-report-success").waitFor();
      await page.getByRole("button", { name: "Report another issue" }).click();
      await next.waitFor();
      await chooseKind(page, "Security");
      await next.locator(".issue-report-notice").waitFor();
      await next.getByLabel("Subject").fill(SECURITY.subject);
      await next.getByLabel("Message").fill(SECURITY.body);
      await scrollTo(page, next, "start");
      await shot("report-security");
      await next.getByRole("button", { name: "Send report" }).click();
      await page.locator(".issue-report-success").waitFor();

      // 13. Verify: My reports › All lists every report with its status.
      await page.getByRole("button", { name: "View status" }).click();
      await page.locator(".my-report-detail").waitFor();
      await page.locator(".my-report-detail").getByRole("button", { name: "My reports" }).click();
      await page.getByRole("radiogroup", { name: "Show reports" }).getByRole("radio", { name: /^All/ }).click();
      await page.locator(".my-reports-list li").nth(2).waitFor();
      await page.waitForTimeout(500);
      await shot("report-all");
      const mine = (await myReports(kit)).filter((item) => subjects.includes(item.subject));
      if (mine.length !== 3 || !mine.some((item) => item.kind === "security") || !mine.some((item) => item.kind === "feature")) throw new Error("My reports does not list all three reports.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

module.exports = { "user-reports": userReports };
