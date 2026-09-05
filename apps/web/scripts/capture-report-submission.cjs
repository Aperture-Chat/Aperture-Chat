/* Capture one explicitly authorized synthetic local issue submission.
 * Set CAPTURE_OWNER_SESSION_FILE, CAPTURE_SUBMISSION_RECEIPT (under tmp/),
 * CAPTURE_REVIEWED_SCREENSHOT, and CAPTURE_SUBMIT_SYNTHETIC_ISSUE=ONE_AUTHORIZED_LOCAL_REPORT.
 * CAPTURE_ISSUE_SUBJECT can identify this distinct capture run. Repeated runs
 * with the same receipt or existing subject fail instead of duplicating a report.
 * Existing signed sessions stay private; unrelated writes fail closed.
 * The screenshot attachment has been visually reviewed before this run.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { captureCredentials } = require("./training-capture-run.cjs");
const { openReadOnlyContext, stagedCapture, screenshotWithBounds, API, APP } = require("./capture-user-support-frames.cjs");

const subject = process.env.CAPTURE_ISSUE_SUBJECT || "Synthetic training example — mobile installation guidance";
const body = "Synthetic training example only. This report demonstrates Help submission and administrator review using the mobile installation guide. Observed: the guide lists Share, Add to Home Screen, then Add. Expected: an administrator can review this report and its attached screenshot. No customer data or provider response is included.";
const workRoot = path.resolve(__dirname, "../../../tmp");
const receiptPath = path.resolve(process.env.CAPTURE_SUBMISSION_RECEIPT || path.join(workRoot, "training-captures/synthetic-support-submission.json"));
// This local Vite instance proxies same-origin /api requests to the local API.
const issueUrl = new URL("/api/issue-reports", APP).href;

(async () => {
  if (process.env.CAPTURE_SUBMIT_SYNTHETIC_ISSUE !== "ONE_AUTHORIZED_LOCAL_REPORT") throw new Error("Explicit one-report authorization is required.");
  if (!receiptPath.startsWith(workRoot + path.sep)) throw new Error("Keep the report receipt under the ignored tmp directory.");
  if (!subject.startsWith("Synthetic training example")) throw new Error("The report subject must identify the synthetic training example.");
  if (fs.existsSync(receiptPath)) throw new Error("A prior submission receipt exists; do not create a duplicate.");
  const screenshotPath = process.env.CAPTURE_REVIEWED_SCREENSHOT;
  if (!screenshotPath || !fs.existsSync(screenshotPath)) throw new Error("The reviewed synthetic screenshot is required.");
  const ownerFile = process.env.CAPTURE_OWNER_SESSION_FILE;
  if (!ownerFile) throw new Error("CAPTURE_OWNER_SESSION_FILE is required for notification safety checks.");
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  const auth = captureCredentials();
  const browser = await chromium.launch();
  try {
    const { context, page, attemptedWrites } = await openReadOnlyContext(browser, auth, "USER");
    const ownerHeaders = { "X-Aperture-Session": owner.session.token };
    const sessionResponse = await context.request.get(`${API}/api/auth/session`, { headers: ownerHeaders });
    if (!sessionResponse.ok()) throw new Error("Owner notification-safety check session is unavailable.");
    const ownerSession = await sessionResponse.json();
    if (ownerSession.user.role !== "PLATFORM_OWNER" || !/^[^@]+@example\.test$/i.test(ownerSession.user.email || "")) throw new Error("Notification safety preflight requires the synthetic local owner.");
    const rulesResponse = await context.request.get(`${API}/api/platform/alert-rules`, { headers: ownerHeaders });
    if (!rulesResponse.ok()) throw new Error("Cannot verify local alert recipients; submission stopped.");
    const rules = await rulesResponse.json();
    if (rules.some((rule) => rule.enabled && rule.recipients?.length)) throw new Error("An enabled alert has outbound recipients; submission stopped.");
    const issuesResponse = await context.request.get(`${API}/api/admin/issue-reports`, { headers: ownerHeaders });
    if (!issuesResponse.ok()) throw new Error("Cannot check for an existing report; submission stopped.");
    const issues = await issuesResponse.json();
    if (issues.some((report) => report.subject === subject)) throw new Error("The synthetic report already exists; do not submit another.");
    console.log(`Notification preflight passed: ${rules.length} rules, no enabled outbound recipients.`);

    const capture = stagedCapture(__filename, "issue-submission");
    const metadata = { role: "user", capturedAt: new Date().toISOString(), readOnly: false, frames: {}, mutationScope: "One explicitly authorized synthetic local issue report; no outbound recipients.", pending: [] };
    const shot = (name, regions, extra) => screenshotWithBounds(page, capture.outputDirectory, name, regions, metadata, extra);
    let submissions = 0;
    await context.route(issueUrl, async (route) => {
      const request = route.request();
      if (request.method() === "POST" && submissions === 0 && request.postData()?.includes(subject) && request.postData()?.includes(body)) {
        submissions += 1;
        await route.continue();
      } else {
        attemptedWrites.push({ method: request.method(), path: "/api/issue-reports" });
        await route.abort("blockedbyclient");
      }
    });
    await page.getByRole("button", { name: "Help", exact: true }).click();
    await page.getByRole("dialog", { name: "Help", exact: true }).getByRole("button", { name: /Report a problem/ }).click();
    const report = page.getByRole("dialog", { name: "Report a problem", exact: true });
    await report.getByLabel("Subject", { exact: true }).fill(subject);
    await report.getByLabel("Message", { exact: true }).fill(body);
    await report.locator("input[type=file]").setInputFiles(screenshotPath);
    await shot("help-report-form", { helpReportForm: page.locator(".issue-report-form") }, { submissionState: "prepared synthetic report with reviewed screenshot" });
    const responsePromise = page.waitForResponse((response) => response.url() === issueUrl && response.request().method() === "POST");
    await report.getByRole("button", { name: "Send report", exact: true }).click();
    const response = await responsePromise;
    if (response.status() !== 201) throw new Error(`Issue submission returned HTTP ${response.status()}; no retry.`);
    const record = await response.json();
    fs.writeFileSync(receiptPath, JSON.stringify({ id: record.id, subject: record.subject, screenshotFilename: record.screenshot_filename, screenshotSizeBytes: record.screenshot_size_bytes, createdAt: record.created_at }, null, 2), { mode: 0o600 });
    await report.getByRole("status").filter({ hasText: "Report sent" }).waitFor();
    await shot("help-report-received", { helpReportReceived: page.locator(".issue-report-success") }, { submissionState: "actual HTTP 201 and rendered Report sent", issueId: record.id });
    if (attemptedWrites.length || submissions !== 1) throw new Error("Unexpected mutation count; staged capture is incomplete.");
    capture.complete();
    console.log(`Created ${record.id}; two frames staged. Public assets unchanged.`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error.message); process.exit(1); });
