/* Analytics and audit, read for real from the synthetic instance's recorded
 * activity. Run each module from a freshly reset instance.
 *
 * owner-analytics scopes Runtime Clock Metadata to one person and a date
 * preset, exports its CSV (the downloaded file is checked), opens a feedback
 * record's conversation, and reads Model Activity and User Usage, focusing
 * usage on one person.
 *
 * owner-audit reads the attention banner and signal groups, opens a signal's
 * records, changes the Audit Insights range and drills into a chart bar,
 * acknowledges a security alert, filters the Audit Trail, and exports it (the
 * downloaded file is checked).
 */
const fs = require("node:fs");

async function scrollTo(page, locator, block = "center") {
  await locator.evaluate((element, where) => element.scrollIntoView({ block: where }), block);
  await page.waitForTimeout(350);
}

function panel(page, title) {
  return page.locator(".panel").filter({ has: page.locator(".panel-header h2", { hasText: title }) }).first();
}

async function expand(page, title) {
  const target = panel(page, title);
  await target.waitFor();
  const toggle = target.locator(".panel-collapse-button").first();
  if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.waitForTimeout(600);
  return target;
}

async function csvLines(download) {
  const file = await download.path();
  const text = fs.readFileSync(file, "utf8").trim();
  return { name: download.suggestedFilename(), lines: text.split(/\r?\n/) };
}

const analytics = {
  role: "owner",
  description: "Scope runtime analytics, export CSV, open a feedback record, and read activity and usage charts.",
  frames: [
    "owner/an-overview", "owner/an-runtime", "owner/an-runtime-scoped", "owner/an-runtime-csv",
    "owner/an-feedback", "owner/an-feedback-record", "owner/an-activity", "owner/an-usage", "owner/an-usage-user",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("owner", "/platform/analytics");
    await panel(page, "Runtime Clock Metadata").waitFor();
    await page.waitForTimeout(800);
    await shot("an-overview");

    // Runtime Clock Metadata: its own filter, scorecards, and event rows.
    const runtime = await expand(page, "Runtime Clock Metadata");
    await scrollTo(page, runtime, "start");
    await shot("an-runtime");
    const filter = runtime.locator("[aria-label='Runtime events filter']");
    await filter.getByLabel("Runtime events filter user").selectOption({ label: "Jane Smith" });
    await filter.getByRole("button", { name: "30 days" }).click();
    await page.waitForTimeout(800);
    await scrollTo(page, runtime, "start");
    await shot("an-runtime-scoped");

    // CSV export: its own date range, then a real download.
    await runtime.getByRole("button", { name: "Export runtime analytics CSV" }).click();
    const popover = page.getByRole("dialog", { name: "runtime analytics CSV date range" });
    await popover.waitFor();
    await page.waitForTimeout(400);
    await shot("an-runtime-csv", { keepFocus: true });
    const [download] = await Promise.all([page.waitForEvent("download"), popover.getByRole("button", { name: /Download/ }).click()]);
    const runtimeCsv = await csvLines(download);
    if (runtimeCsv.lines.length < 2) throw new Error("The runtime CSV has no rows.");
    console.log(`  ${runtimeCsv.name}: ${runtimeCsv.lines.length - 1} rows; columns ${runtimeCsv.lines[0].slice(0, 120)}`);
    await page.keyboard.press("Escape");

    // Chat Feedback: ratings and notes, each opening its conversation.
    const feedback = await expand(page, "Chat Feedback");
    await scrollTo(page, feedback, "start");
    await shot("an-feedback");
    await feedback.getByRole("button", { name: /^Preview feedback and conversation:/ }).first().click();
    const modal = page.locator(".prompt-output-modal, [role='dialog']").filter({ hasText: /feedback|Feedback|conversation/ }).last();
    await modal.waitFor();
    await page.waitForTimeout(800);
    await shot("an-feedback-record");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // Model Activity charts.
    const activity = await expand(page, "Model Activity");
    await scrollTo(page, activity.locator(".model-activity-chart-grid"), "start");
    await page.evaluate(() => window.scrollBy(0, -140));
    await shot("an-activity");

    // User Usage: durable usage, then focused on one person.
    const usage = await expand(page, "User Usage");
    await scrollTo(page, usage, "start");
    await shot("an-usage");
    const picker = usage.getByLabel("Focus usage on one user");
    const options = await picker.locator("option").allInnerTexts();
    const person = options.find((text) => /Jane Smith/.test(text)) ?? options[1];
    await picker.selectOption({ label: person });
    await page.waitForTimeout(800);
    await scrollTo(page, usage.locator("[aria-label='Usage by user']"), "center");
    await shot("an-usage-user");
  },
};

const audit = {
  role: "owner",
  description: "Triage signals, drill into records, read Audit Insights, acknowledge an alert, and export the trail.",
  frames: [
    "owner/au-summary", "owner/au-signal-records", "owner/au-insights", "owner/au-insights-people", "owner/au-chart-records",
    "owner/au-alerts", "owner/au-alert-acknowledged", "owner/au-trail-filtered", "owner/au-trail-export",
  ],
  async run(kit) {
    const { shot } = kit;
    const page = await kit.app("owner", "/platform/audit");
    await page.locator(".audit-summary-board").waitFor();
    await page.waitForTimeout(1000);
    await shot("au-summary");

    // Every signal row opens the records behind it.
    const signal = page.locator(".audit-summary-board").getByRole("button").filter({ hasText: /Critical|critical/ }).first();
    await signal.click();
    const investigation = page.locator(".audit-investigation-modal");
    await investigation.waitFor();
    await page.waitForTimeout(800);
    await shot("au-signal-records");
    await page.keyboard.press("Escape");
    await investigation.waitFor({ state: "detached" });

    // Audit Insights: range, trends, people, areas, hours.
    const range = page.getByRole("radiogroup", { name: "Audit insights range" });
    await scrollTo(page, range, "start");
    await range.getByRole("radio", { name: /30/ }).click();
    await page.waitForTimeout(900);
    await page.evaluate(() => window.scrollBy(0, -60));
    await shot("au-insights");
    const people = page.locator(".audit-chart-card[aria-label='Most active people']");
    await scrollTo(page, people, "start");
    await page.evaluate(() => window.scrollBy(0, -20));
    await shot("au-insights-people");

    // A chart bar opens its records too.
    const bar = page.locator(".audit-chart-card[aria-label='Audit events by day']").locator("[aria-label$='Inspect records.']").last();
    await scrollTo(page, bar, "center");
    await bar.click();
    await investigation.waitFor();
    await page.waitForTimeout(800);
    await shot("au-chart-records");
    await page.keyboard.press("Escape");
    await investigation.waitFor({ state: "detached" });

    // Security alerts: redacted snippets; acknowledge one after review.
    const alerts = await expand(page, "Security Alerts");
    await scrollTo(page, alerts, "start");
    await shot("au-alerts");
    const acknowledge = alerts.getByRole("button", { name: /^Acknowledge/ }).first();
    await acknowledge.click();
    await page.waitForTimeout(1200);
    await scrollTo(page, alerts, "start");
    await shot("au-alert-acknowledged");

    // Audit Trail: severity, category, and text filters, then the CSV.
    const trail = await expand(page, "Audit Trail");
    await trail.getByLabel("Filter audit events by severity").selectOption("warning");
    await page.waitForTimeout(800);
    await scrollTo(page, trail, "start");
    await shot("au-trail-filtered");
    const exportButton = trail.getByRole("button", { name: "Export audit trail CSV" });
    await scrollTo(page, exportButton, "center");
    await exportButton.click();
    const csvPopover = page.getByRole("dialog", { name: "audit trail CSV date range" });
    await csvPopover.waitFor();
    await page.waitForTimeout(400);
    await shot("au-trail-export", { keepFocus: true });
    const [download] = await Promise.all([page.waitForEvent("download"), csvPopover.getByRole("button", { name: /Download/ }).click()]);
    const trailCsv = await csvLines(download);
    if (trailCsv.lines.length < 2) throw new Error("The audit CSV has no rows.");
    console.log(`  ${trailCsv.name}: ${trailCsv.lines.length - 1} rows; columns ${trailCsv.lines[0].slice(0, 120)}`);
  },
};

module.exports = { "owner-analytics": analytics, "owner-audit": audit };
