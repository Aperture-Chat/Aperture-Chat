/* Support reports and sharing with the Aperture Chat maintainers, performed for
 * real on the synthetic instance. Run from a freshly reset instance whose
 * support settings are the defaults (Review each report, no assistant model,
 * community hub off) and whose scheduler is running.
 *
 * Inputs: none beyond the role sessions. The connected local model answers
 * Rewrite with AI and the hub's AI triage.
 *
 * owner-reports reads the owner's Reports tab and its sharing settings, picks
 * the local model as the support assistant, and turns on "Accept reports from
 * other deployments", so this deployment is its own community hub: a shared
 * report then completes for real into this instance's Community hub queue
 * instead of reaching the maintainers. Never point a capture at the project's
 * real hub, and never publish to GitHub: no GitHub token is set, so nothing
 * leaves for GitHub (the hub's duplicate search is a read-only public query).
 *
 * The synthetic reporter (Jane Smith) files each report through the real Help
 * › Report a problem form in an uncaptured browser. The owner then opens the
 * idea, reviews the redacted draft, rewrites it with AI, previews the GitHub
 * issue, and sends it; the module shows the status card, the report waiting in
 * the Community hub, and the reporter's My reports view. Then: Share
 * automatically shares a new question without review; Off blocks sharing; and a
 * security report can only be reported privately.
 */
const REPORTS = {
  idea: {
    kind: "Idea",
    subject: "Let each chat folder remember a default model",
    body:
      "Our litigation team switches models by hand every time we open a chat in the Matters folder. " +
      "Could each chat folder keep a default model, so new chats there start on it? " +
      "Casey Doe asked me to send this for Example Corporation. " +
      "If you need more detail, reach me at jane.smith@example.test or (312) 555-0142.",
  },
  question: {
    kind: "Question",
    subject: "Can a draft be shared with a whole group?",
    body:
      "I can share a draft with one person at a time. Is there a way to share it with everyone in the Finance Team group at once? " +
      "Maya Patel would like the same for her drafts.",
  },
  security: {
    kind: "Security",
    subject: "I pasted a password into a chat by mistake",
    body:
      "This morning I pasted my VPN password into a chat while copying setup notes. " +
      "Can someone remove it from the chat history, and should I change the password?",
  },
};

async function scrollTo(page, locator, block = "center") {
  await locator.evaluate((element, where) => element.scrollIntoView({ block: where }), block);
  await page.waitForTimeout(350);
}

/* The reporter files a report from Help › Report a problem. Not captured. */
async function fileReport(kit, report) {
  const user = await kit.app("user", "/");
  await user.getByRole("button", { name: "Help", exact: true }).click();
  await user.getByRole("button", { name: /^Report a problem/ }).click();
  const form = user.locator(".issue-report-form");
  await form.waitFor();
  await form.getByRole("radiogroup", { name: "Report type" }).getByRole("radio", { name: report.kind, exact: true }).click();
  await form.getByLabel("Subject", { exact: true }).fill(report.subject);
  await form.getByLabel("Message", { exact: true }).fill(report.body);
  await form.getByRole("button", { name: "Send report" }).click();
  const sent = user.getByText(/^Report #\d+ sent$/);
  await sent.waitFor({ timeout: 30000 });
  const number = Number((await sent.innerText()).match(/#(\d+)/)[1]);
  await user.close();
  return number;
}

async function reportsTab(kit) {
  const page = await kit.app("owner", "/platform/reports");
  await page.locator(".support-console").waitFor();
  await page.waitForTimeout(800);
  return page;
}

async function ownerView(page, name) {
  await page.getByRole("radiogroup", { name: "Reports views" }).getByRole("radio", { name: new RegExp(`^${name}`) }).click();
  await page.waitForTimeout(800);
}

async function setMode(page, title, notice) {
  await ownerView(page, "Settings");
  await page.getByRole("radiogroup", { name: "Sharing mode" }).getByRole("radio", { name: new RegExp(`^${title}`) }).click();
  await page.locator(".support-settings .support-saved").getByText(notice).waitFor();
  await page.waitForTimeout(500);
}

async function openTicket(page, number) {
  await ownerView(page, "Tickets");
  // The queue loads when the view opens; Refresh picks up reports sent since.
  await page.locator(".support-toolbar").getByRole("button", { name: /^Refresh/ }).click();
  await page.locator(".support-toolbar").getByRole("button", { name: "Refresh" }).waitFor();
  await page.getByRole("radiogroup", { name: "Filter reports" }).getByRole("radio", { name: /^All/ }).click();
  await page.getByRole("button", { name: new RegExp(`^#${number} `) }).click();
  const detail = page.locator(".support-detail");
  await detail.locator(".support-detail-header").waitFor();
  await page.waitForTimeout(800);
  return detail;
}

async function waitFor(check, { timeout, every = 3000, what }) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, every));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function ticketByNumber(kit, number) {
  const items = await kit.api("owner", "GET", "/api/admin/issue-reports");
  return items.find((item) => item.number === number);
}

const reports = {
  role: "owner",
  description: "Share a reviewed, redacted report with the maintainers' hub for real, and show automatic, off, and security paths.",
  frames: [
    "owner/rp-tickets", "owner/rp-settings", "owner/rp-assistant", "owner/rp-hub-on", "owner/rp-ticket-open",
    "owner/rp-share-draft", "owner/rp-share-ai", "owner/rp-share-preview", "owner/rp-shared", "owner/rp-hub-queue",
    "owner/rp-reporter-shared", "owner/rp-auto-mode", "owner/rp-auto-shared", "owner/rp-off-blocked", "owner/rp-security-private",
  ],
  async run(kit) {
    const { shot } = kit;
    const settings = await kit.api("owner", "GET", "/api/platform/support/settings");
    if (settings.upstream_mode !== "review" || settings.hub_enabled || settings.ai_model_id) {
      throw new Error("Start from the default support settings (Review each report, no assistant, hub off).");
    }
    if (settings.hub_token_set) throw new Error("A GitHub token is set; remove it so nothing can be published.");

    // A person sends an idea from Help › Report a problem (not captured).
    const idea = await fileReport(kit, REPORTS.idea);

    // 1. The owner's Reports tab: every organization's tickets.
    const page = await reportsTab(kit);
    await page.getByRole("button", { name: new RegExp(`^#${idea} `) }).waitFor();
    await shot("rp-tickets");

    // 2. Sharing settings, as every deployment starts.
    await ownerView(page, "Settings");
    await page.locator(".support-mode-options").waitFor();
    await page.getByText("Community hub: https://chat.aperturechat.com").waitFor();
    await shot("rp-settings");

    // 3. Support assistant: the connected local model; reporter emails stay on.
    const assistant = page.getByLabel("Support assistant model");
    await assistant.selectOption({ label: "Qwen3.5 9B" });
    await page.locator(".support-settings .support-saved").getByText("Support assistant updated.").waitFor();
    if ((await page.getByRole("switch", { name: "Email reporters about updates" }).getAttribute("aria-checked")) !== "true") {
      throw new Error("Email reporters about updates should be on by default.");
    }
    const assistantPanel = page.locator(".panel").filter({ has: page.locator(".panel-header h2", { hasText: "Support assistant" }) });
    await scrollTo(page, assistantPanel, "start");
    await page.evaluate(() => window.scrollBy(0, -70));
    await shot("rp-assistant");

    // 4. This recording's own hub: the shared report lands here, not with the maintainers.
    await page.getByRole("switch", { name: "Accept community reports" }).click();
    await page.locator(".support-settings .support-saved").getByText("Community hub turned on.").waitFor();
    await page.getByText("Community hub: This deployment").waitFor();
    const hubPanel = page.locator(".panel").filter({ has: page.locator(".panel-header h2", { hasText: "Community hub" }) });
    await scrollTo(page, hubPanel, "center");
    await shot("rp-hub-on");
    const after = await kit.api("owner", "GET", "/api/platform/support/settings");
    if (!after.hub_enabled || after.hub_token_set) throw new Error("The hub must be this deployment, without a GitHub token.");

    // 5. Open the idea: status, priority, assignee, type, and the maintainers card.
    let detail = await openTicket(page, idea);
    await detail.getByRole("button", { name: "Share with maintainers" }).waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await scrollTo(page, detail.locator(".ticket-upstream-card"), "center");
    await shot("rp-ticket-open");

    // 6. The redacted draft.
    await detail.getByRole("button", { name: "Share with maintainers" }).click();
    const dialog = page.getByRole("dialog", { name: "Share with the Aperture Chat maintainers" });
    await dialog.getByLabel("Issue title").waitFor();
    await dialog.getByText(/replaced with placeholders\.|Nothing needed redacting\./).waitFor();
    const draftBody = await dialog.getByLabel("Description").inputValue();
    if (/jane\.smith@example\.test|555-0142|Casey Doe/.test(draftBody)) throw new Error(`The draft was not redacted: ${draftBody}`);
    await page.waitForTimeout(500);
    await shot("rp-share-draft");

    // 7. Rewrite with AI: the support assistant drafts the issue from redacted text.
    await dialog.getByRole("button", { name: "Rewrite with AI" }).click();
    await dialog.getByRole("button", { name: "Rewriting…" }).waitFor({ timeout: 10000 }).catch(() => {});
    // The shared local model answers one request at a time; allow for a queue.
    await dialog.getByRole("button", { name: "Rewrite with AI" }).waitFor({ timeout: 900000 });
    const notes = (await dialog.locator(".support-share-body .support-muted").allInnerTexts()).join(" ");
    if (!notes.includes("Rewritten by the support assistant; review it before sending.")) {
      throw new Error(`Rewrite with AI did not finish: ${await dialog.locator(".support-share-body").innerText()}`);
    }
    if (/jane\.smith@example\.test|555-0142|Casey Doe/.test(await dialog.getByLabel("Description").inputValue())) throw new Error("The AI draft is not redacted.");
    console.log(`  AI title: ${await dialog.getByLabel("Issue title").inputValue()}`);
    await page.waitForTimeout(500);
    await shot("rp-share-ai");

    // 8. Preview the GitHub issue exactly as it would be filed.
    await dialog.locator(".support-share-preview summary").click();
    await dialog.locator(".support-share-preview pre").waitFor();
    await scrollTo(page, dialog.locator(".support-share-preview"), "center");
    await page.waitForTimeout(400);
    await shot("rp-share-preview");

    // 9. Send to maintainers: the status card and the timeline entry.
    await dialog.getByRole("button", { name: "Send to maintainers" }).click();
    await dialog.waitFor({ state: "detached", timeout: 60000 });
    await detail.locator(".ticket-upstream-card").getByText("With the maintainers").waitFor({ timeout: 60000 });
    await detail.getByText("Shared with the Aperture Chat maintainers. You'll see their progress here.").first().waitFor();
    await page.waitForTimeout(800);
    await scrollTo(page, detail.locator(".ticket-upstream-card"), "start");
    await page.evaluate(() => window.scrollBy(0, -140));
    await shot("rp-shared");

    // 10. Where it landed: this deployment's Community hub queue, after triage.
    const hubReport = await waitFor(async () => {
      const queue = await kit.api("owner", "GET", "/api/platform/support-hub/reports");
      return queue.items.find((item) => item.status === "pending" && item.triage);
    }, { timeout: 600000, what: "hub triage" });
    console.log(`  hub report ${hubReport.id}: ${hubReport.title}; triage keys ${Object.keys(hubReport.triage).join(", ")}`);
    await ownerView(page, "Tickets");
    await ownerView(page, "Community hub");
    await page.getByRole("button", { name: hubReport.title }).first().click();
    const triage = page.locator(".support-queue-detail .support-triage");
    await triage.locator(".support-triage-facts, .support-candidates").first().waitFor();
    await page.waitForTimeout(1000);
    await scrollTo(page, triage, "center");
    await shot("rp-hub-queue");

    // 11. The reporter's view in Help › My reports.
    const reporter = kit.use(await kit.app("user", "/"));
    await reporter.getByRole("button", { name: "Help", exact: true }).click();
    await reporter.getByRole("button", { name: /^My reports/ }).click();
    await reporter.getByRole("button", { name: new RegExp(`^#${idea} `) }).click();
    await reporter.locator(".my-report-detail .ticket-upstream-card").getByText("Shared with the Aperture Chat maintainers").waitFor();
    await reporter.waitForTimeout(800);
    await shot("rp-reporter-shared");

    // Path: Share automatically. A new question is shared without review.
    kit.use(page);
    await setMode(page, "Share automatically", "Sharing set to share automatically.");
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot("rp-auto-mode");
    const question = await fileReport(kit, REPORTS.question);
    kit.use(page);
    await waitFor(async () => (await ticketByNumber(kit, question))?.upstream?.state === "sent", { timeout: 600000, what: "the automatic share" });
    detail = await openTicket(page, question);
    await detail.locator(".ticket-upstream-card").getByText(/by Automatic sharing/).waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await scrollTo(page, detail.locator(".ticket-upstream-card"), "center");
    await shot("rp-auto-shared");

    // Path: Off. Sharing is blocked; the prefilled GitHub link still works.
    await setMode(page, "Off", "Sharing set to off.");
    detail = await openTicket(page, 1);
    await detail.getByRole("button", { name: "Share with maintainers" }).click();
    let blocked = page.getByRole("dialog", { name: "Share with the Aperture Chat maintainers" });
    await blocked.getByText("Sharing with the maintainers is turned off in Reports settings.").waitFor();
    await page.waitForTimeout(500);
    await shot("rp-off-blocked");
    await blocked.getByRole("button", { name: "Cancel" }).click();

    // Path: a security concern can only be reported privately.
    const security = await fileReport(kit, REPORTS.security);
    kit.use(page);
    detail = await openTicket(page, security);
    await detail.getByText("Security concerns are reported privately, never as public issues.").waitFor();
    await detail.getByRole("button", { name: "Report privately" }).click();
    blocked = page.getByRole("dialog", { name: "Share with the Aperture Chat maintainers" });
    await blocked.getByText(/^Security concerns are never posted publicly\./).waitFor();
    await blocked.getByRole("link", { name: /Open a private security advisory/ }).waitFor();
    await page.waitForTimeout(500);
    await shot("rp-security-private");
    await blocked.getByRole("button", { name: "Cancel" }).click();

    // Nothing was published: the hub has no GitHub token and no issue numbers.
    const queue = await kit.api("owner", "GET", "/api/platform/support-hub/reports");
    if (queue.items.some((item) => item.issue_number)) throw new Error("A hub report has a GitHub issue number; nothing may be published.");
    console.log(`  hub queue: ${queue.items.map((item) => `${item.status}:${item.title}`).join(" | ")}`);
  },
};

module.exports = { "owner-reports": reports };
