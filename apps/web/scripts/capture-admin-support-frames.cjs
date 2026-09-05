/* Read-only feedback/issue review capture using an existing synthetic admin.
 *
 * CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=I_HAVE_REVIEWED_SYNTHETIC_DATA \
 * CAPTURE_SESSION_FILE=tmp/training-captures/training-admin-session.json \
 *   node apps/web/scripts/capture-admin-support-frames.cjs
 *
 * Existing records are captured only when explicitly labeled synthetic.
 * Missing submitted records stay pending; no issue, rating, or success state
 * is created. Frames remain in ignored review directories.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { captureCredentials } = require("./training-capture-run.cjs");
const { openReadOnlyContext, stagedCapture, screenshotWithBounds, API } = require("./capture-user-support-frames.cjs");

(async () => {
  const auth = captureCredentials();
  const capture = stagedCapture(__filename, "admin");
  const metadata = { role: "admin", capturedAt: new Date().toISOString(), readOnly: true, frames: {}, pending: [] };
  const browser = await chromium.launch();
  try {
    const { context, page, attemptedWrites } = await openReadOnlyContext(browser, auth, "TENANT_ADMIN");
    const headers = { "X-Aperture-Session": auth.token };
    const issueResponse = await context.request.get(`${API}/api/admin/issue-reports`, { headers });
    const feedbackResponse = await context.request.get(`${API}/api/admin/chat-feedback`, { headers });
    if (!issueResponse.ok() || !feedbackResponse.ok()) throw new Error("Could not read current feedback/issue inventory.");
    const issues = await issueResponse.json();
    const feedback = await feedbackResponse.json();
    if ([...issues, ...feedback].some((row) => !/synthetic|training|imported example/i.test(`${row.subject || ""} ${row.body || ""} ${row.thread_title || ""} ${row.comment || ""}`))) {
      throw new Error("Review inventory contains records not explicitly labeled synthetic; inspect privately before capturing.");
    }
    const shot = (name, regions, extra) => screenshotWithBounds(page, capture.outputDirectory, name, regions, metadata, extra);
    await page.getByRole("button", { name: /^Account:/ }).click();
    const account = page.getByRole("dialog", { name: "Account", exact: true });
    await account.locator("summary.account-collapsible-summary").first().click();
    await account.getByRole("button", { name: /Admin console/i }).click();
    await page.getByRole("tab", { name: "Analytics", exact: true }).click();
    const panel = page.locator(".chat-feedback-panel").filter({
      has: page.getByRole("heading", { name: "Chat Feedback", exact: true }),
    });
    if (await panel.evaluate((element) => element.classList.contains("is-panel-collapsed"))) {
      await panel.locator(".panel-header").click();
    }
    await panel.getByText("Issue reports", { exact: true }).waitFor();
    await panel.scrollIntoViewIfNeeded();
    await shot("support-issue-review", { feedbackOverview: panel }, { issueCount: issues.length, feedbackCount: feedback.length });

    // Detail frames require real submitted records. Persist available evidence
    // and missing states, but only complete the review batch when all exist.
    if (feedback.length) {
      const entries = page.locator("[aria-label='Admin chat feedback events']");
      await entries.scrollIntoViewIfNeeded();
      await shot("feedback-entries", { feedbackEntries: entries });
      await page.getByRole("button", { name: /^Preview feedback and conversation:/ }).first().click();
      const preview = page.getByRole("dialog", { name: "Feedback and conversation", exact: true });
      await preview.waitFor();
      await preview.locator(".prompt-output-message").first().waitFor();
      await shot("feedback-response-preview", { feedbackConversation: preview });
      await preview.getByRole("button", { name: /Close/ }).click();
    } else {
      metadata.pending.push({ frames: ["feedback-entries", "feedback-response-preview"], reason: "No existing feedback records; submitting feedback is outside this read-only capture." });
    }
    if (issues.length) {
      const requestedIssue = process.env.CAPTURE_ISSUE_ID
        ? issues.find((issue) => issue.id === process.env.CAPTURE_ISSUE_ID)
        : issues[0];
      if (!requestedIssue) throw new Error("The requested synthetic issue report does not exist.");
      await page.getByRole("button", { name: `Preview issue report: ${requestedIssue.subject}`, exact: true }).click();
      const preview = page.getByRole("dialog", { name: "Platform issue report", exact: true });
      await preview.waitFor();
      const screenshot = preview.locator(".issue-report-screenshot");
      if (await screenshot.count()) {
        await screenshot.locator("img, p").first().waitFor();
        await page.waitForFunction(() => !document.querySelector(".issue-report-screenshot")?.textContent?.includes("Loading screenshot"));
      }
      await shot("support-issue-detail", { feedbackIssueReport: preview }, { issueId: requestedIssue.id });
    } else {
      metadata.pending.push({ frame: "support-issue-detail", reason: "No existing synthetic issue report; no report submission or detail state was fabricated." });
    }
    fs.writeFileSync(path.join(capture.outputDirectory, "support-capture-metadata.json"), JSON.stringify(metadata, null, 2));
    if (attemptedWrites.length) throw new Error(`Capture attempted ${attemptedWrites.length} mutation requests.`);
    await browser.close();
    if (!metadata.pending.length) capture.complete();
    console.log(`Staged ${Object.keys(metadata.frames).length} actual frames; ${metadata.pending.length} unavailable states remain pending. Public assets unchanged.`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error.message); process.exit(1); });
