/* Privacy and training data in the Admin console, performed for real.
 *
 * admin-personal-data: turn on Personal Data Protection, read the categories,
 * preview concealment on the panel's synthetic sample, then have a person send
 * a real message with a synthetic SSN and email to the local model and follow
 * it into Audit (User Prompt Activity and the trail). Then let the model read
 * values, so a reply that writes out a synthetic phone number and email is
 * concealed on the way out, and finally turn protection off and reopen the first chat, which
 * stays concealed because the values were never stored.
 *
 * admin-training-datasets: synthetic people first do ordinary work with the
 * local model through the real UI while capture is off: they rate replies
 * and correct the assistant. (Regenerate is not used: it fails against the
 * self-hosted model this capture runs on.) On camera the admin turns
 * capture on, excludes a group, and scans those existing chats; a person then
 * corrects the assistant and rates the revision live. The admin reviews the
 * captured signals, creates a suggested dataset, reviews and approves its
 * examples, downloads the ZIP (checked here: JSONL lines, no raw name or
 * phone number), and
 * finds the audit records. Setup through the API (policies, synthetic people)
 * is never captured as if the UI produced it.
 */
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { helpers } = require("./admin-shared.cjs");
const { helpers: people } = require("./user-common.cjs");

const { scrollTo, openTab, expandPanel, removeUsers } = helpers;
const MODEL = /Qwen3\.5 9B/;
const ALL_CATEGORIES = ["identity", "contact", "financial", "health", "credentials", "network"];
const NOTE_PROMPT =
  "Draft a two-sentence note to the benefits team: update the payroll record for employee SSN 123-45-6789 and confirm by email to jordan.lee@example.com.";
const SIGNATURE_PROMPT = "Write a one-line email signature for Jordan Lee with the phone number (415) 555-0134 and the email jordan.lee@example.com.";

/** Open a new chat on the local model. */
async function newChat(page) {
  await page.getByRole("button", { name: "New chat" }).first().click().catch(() => {});
  await page.getByRole("button", { name: "Select model" }).click();
  await page.getByRole("option", { name: MODEL }).click();
  await page.locator(".composer textarea").waitFor();
}

/** Send one message and wait for the finished, saved reply. */
async function ask(page, text) {
  const before = await page.locator("article.assistant-message").count();
  await page.locator(".composer textarea").fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  const reply = page.locator("article.assistant-message").nth(before);
  await reply.getByRole("button", { name: "Send positive feedback" }).waitFor({ timeout: 300000 });
  // The chat saves after the reply finishes; the saved copy is what capture,
  // concealment, and Audit read.
  await page.waitForTimeout(2500);
  return reply;
}

/** Rate a reply; a note is optional. */
async function rate(page, reply, rating, note) {
  await reply.getByRole("button", { name: rating === "positive" ? "Send positive feedback" : "Send negative feedback" }).click();
  const composer = page.getByRole("group", { name: "Feedback note" });
  await composer.waitFor();
  if (note) {
    await composer.getByLabel("Feedback note (optional)").fill(note);
    await composer.getByRole("button", { name: "Send note" }).click();
  } else {
    await composer.getByRole("button", { name: "Close feedback note" }).click();
  }
  await composer.waitFor({ state: "detached" }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function privacyPanel(page) {
  await openTab(page, "Policies");
  const panel = await expandPanel(page, "Personal Data Protection");
  await panel.locator(".privacy-toggle-stack").waitFor();
  return panel;
}

const adminPersonalData = {
  role: "admin",
  description: "Turn on concealment, preview it, see it in a real chat and in Audit, let the model read values, and turn it off.",
  frames: [
    "admin/pdp-collapsed", "admin/pdp-on", "admin/pdp-categories", "admin/pdp-preview", "admin/pdp-coverage",
    "admin/pdp-chat", "admin/pdp-activity", "admin/pdp-audit", "admin/pdp-model-off", "admin/pdp-output",
    "admin/pdp-off", "admin/pdp-after-off",
  ],
  async run(kit) {
    const { shot } = kit;
    // Setup: start from the shipped default, protection off. Only an
    // instance left in another state is changed, so the trail stays clean.
    const start = await kit.api("admin", "GET", "/api/admin/privacy/policy");
    if (start.enabled || !start.conceal_from_model || start.categories.length !== ALL_CATEGORIES.length) {
      await kit.api("admin", "PATCH", "/api/admin/privacy/policy", { enabled: false, conceal_from_model: true, categories: ALL_CATEGORIES });
    }

    // 1. Find the panel on Policies.
    const page = kit.use(await kit.app("admin", "/admin/users"));
    await openTab(page, "Policies");
    const panel = page.locator(".privacy-panel");
    await panel.locator(".panel-header").getByText("Off", { exact: true }).waitFor();
    await shot("pdp-collapsed");

    // 2. Turn it on. Hide values from the model too is on by default.
    await expandPanel(page, "Personal Data Protection");
    await panel.getByRole("switch", { name: "Conceal personal data" }).click();
    await panel.locator(".panel-header").getByText("On", { exact: true }).waitFor();
    if ((await panel.getByRole("switch", { name: "Hide values from the model too" }).getAttribute("aria-checked")) !== "true") {
      throw new Error("Hide values from the model too should default to on.");
    }
    await scrollTo(page, panel, "start");
    await shot("pdp-on");

    // 3. What to conceal.
    await scrollTo(page, panel.locator(".privacy-section[aria-label='What to conceal']"), "center");
    await shot("pdp-categories");

    // 4. Preview the panel's own synthetic sample. Nothing is stored.
    await panel.getByRole("button", { name: "Preview concealment" }).click();
    await panel.locator(".privacy-preview-count").filter({ hasText: /values? concealed/ }).waitFor();
    await scrollTo(page, panel.locator(".privacy-preview"), "center");
    await shot("pdp-preview");

    // 5. Where it applies, and its limits.
    await scrollTo(page, panel.locator(".privacy-section[aria-label='Where it applies']"), "center");
    await shot("pdp-coverage");

    // 6. A person sends a message with a synthetic SSN and email.
    const person = kit.use(await kit.app("user", "/"));
    await newChat(person);
    await ask(person, NOTE_PROMPT);
    await person.locator(".user-message .concealed-token").first().waitFor();
    if (await person.locator(".user-message").filter({ hasText: "123-45-6789" }).count()) throw new Error("The sent SSN is still shown.");
    await person.locator(".disclaimer-privacy").waitFor();
    const firstChat = person.url();
    if (!firstChat.includes("/chat/")) throw new Error("The new chat has no address to reopen.");
    await shot("pdp-chat");

    // 7. The same prompt in Audit › User Prompt Activity, then the trail.
    kit.use(page);
    await openTab(page, "Audit");
    const activity = await expandPanel(page, "User Prompt Activity");
    await activity.getByRole("button", { name: "Refresh monitor" }).click();
    const row = activity.locator(".prompt-activity-row").filter({ has: page.locator(".concealed-token") }).first();
    await row.waitFor();
    await scrollTo(page, row, "center");
    await shot("pdp-activity");
    const trail = await expandPanel(page, "Audit Trail");
    await trail.locator(".panel-header").getByRole("button", { name: "Refresh" }).click();
    await trail.getByLabel("Search audit events").fill("privacy.");
    await trail.locator(".audit-row").filter({ hasText: "PROMPT_CONCEALED" }).first().waitFor();
    await trail.locator(".audit-row").filter({ hasText: "POLICY_UPDATED" }).first().waitFor();
    await scrollTo(page, trail.locator(".audit-filter-toolbar"), "start");
    await shot("pdp-audit");

    // 8. Let the model read the values.
    const settings = await privacyPanel(page);
    await settings.getByRole("switch", { name: "Hide values from the model too" }).click();
    await settings.locator(".policy-toggle-row").filter({ hasText: "The model reads the original value for that turn." }).waitFor();
    await scrollTo(page, settings, "start");
    await shot("pdp-model-off");

    // 9. The model reads a synthetic phone and email and writes them out; the reply is
    // concealed before it reaches the browser and before it is stored.
    kit.use(person);
    await newChat(person);
    const echoed = await ask(person, SIGNATURE_PROMPT);
    await echoed.locator(".concealed-token").first().waitFor();
    if (await echoed.filter({ hasText: /555-0134|jordan\.lee@/ }).count()) throw new Error("A value the model wrote is still shown.");
    await shot("pdp-output");

    // 10. Restore the default, then turn protection off.
    kit.use(page);
    await settings.getByRole("switch", { name: "Hide values from the model too" }).click();
    await settings.locator(".policy-toggle-row").filter({ hasText: "so the model only sees the placeholder" }).waitFor();
    await settings.getByRole("switch", { name: "Conceal personal data" }).click();
    await settings.locator(".panel-header").getByText("Off", { exact: true }).waitFor();
    await scrollTo(page, settings, "start");
    await shot("pdp-off");

    // 11. The first chat stays concealed: the value was never stored.
    kit.use(person);
    await person.goto(firstChat);
    await person.getByRole("navigation", { name: "Primary" }).waitFor();
    await person.locator(".user-message .concealed-token").first().waitFor();
    if (await person.locator(".disclaimer-privacy").count()) throw new Error("The footer still says personal data is concealed.");
    await shot("pdp-after-off");
  },
};

/* Synthetic people and the ordinary work they did before capture was on.
 * Each entry is a real chat with the local model through the real UI. */
const PRIYA = { email: "priya.shah@example.test", name: "Priya Shah", groups: ["group-finance", "group-default-users"] };
const MARCUS = { email: "marcus.lee@example.test", name: "Marcus Lee", groups: ["group-corporate", "group-default-users"] };

async function priorWork(kit) {
  const jane = kit.use(await kit.app("user", "/"));
  await newChat(jane);
  await rate(jane, await ask(jane, "Draft a litigation hold notice asking the operations team to preserve emails and shipping records about the Harbor Logistics dispute."), "positive");
  await newChat(jane);
  await ask(jane, "Summarize the deadlines a defendant faces after being served with a federal complaint.");
  await ask(jane, "Not quite: you left out the 60-day deadline when the defendant waives service. Rewrite it as a short list.");
  await newChat(jane);
  await ask(jane, "Explain what a motion to compel discovery is.");
  await ask(jane, "That's too long, and you missed when it can be filed. Please revise it in two sentences.");

  const priya = await createAndSignIn(kit, PRIYA);
  await newChat(priya);
  await rate(priya, await ask(priya, "Explain the 2026 estimated tax payment deadlines for individuals."), "negative", "It should list the January 15, 2027 payment for the fourth quarter.");
  await newChat(priya);
  await rate(priya, await ask(priya, "Draft a short letter to the IRS asking for a 120-day extension to pay a tax balance for our client Northwind Industries. Ask them to call Jane Smith at (415) 555-0134 with questions."), "positive");
  await newChat(priya);
  await ask(priya, "Which tax form does a self-employed freelancer use to send quarterly estimated tax payments?");
  await ask(priya, "That's incorrect: quarterly estimates are paid with Form 1040-ES vouchers. Please revise your answer.");

  const marcus = await createAndSignIn(kit, MARCUS);
  await newChat(marcus);
  await rate(marcus, await ask(marcus, "Review this indemnification clause and flag any risks: Supplier shall indemnify Customer against all claims arising from Supplier's negligence."), "positive");
  await newChat(marcus);
  await rate(marcus, await ask(marcus, "Draft a mutual confidentiality clause for a vendor agreement."), "positive");
}

async function createAndSignIn(kit, person) {
  const created = await people.createPerson(kit, person);
  return people.signInWithPassword(kit, person.email, created.password);
}

const adminTrainingDatasets = {
  role: "admin",
  description: "Capture ratings and corrections, scan existing chats, create a suggested dataset, review, approve, download, and audit.",
  frames: [
    "admin/ds-off", "admin/ds-on", "admin/ds-safeguards", "admin/ds-scanned", "admin/ds-user-correction",
    "admin/ds-user-note", "admin/ds-overview", "admin/ds-mix", "admin/ds-suggestions", "admin/ds-editor",
    "admin/ds-editor-rules", "admin/ds-created", "admin/ds-review", "admin/ds-concealed", "admin/ds-approved",
    "admin/ds-download", "admin/ds-audit",
  ],
  async run(kit) {
    const { shot } = kit;
    // Setup: capture off with its shipped defaults, chat-time protection off
    // (capture conceals identifiers on its own), no datasets, no earlier people.
    if ((await kit.api("admin", "GET", "/api/admin/privacy/policy")).enabled) {
      await kit.api("admin", "PATCH", "/api/admin/privacy/policy", { enabled: false });
    }
    const defaults = {
      enabled: false, capture_positive: true, capture_negative: true, capture_corrections: true,
      require_review: true, exclude_sensitive_chats: true, conceal_names: true, excluded_group_ids: [],
    };
    const current = await kit.api("admin", "GET", "/api/admin/training/policy");
    if (Object.entries(defaults).some(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value))) {
      await kit.api("admin", "PATCH", "/api/admin/training/policy", defaults);
    }
    const before = await kit.api("admin", "GET", "/api/admin/training/overview");
    for (const dataset of before.datasets) await kit.api("admin", "DELETE", `/api/admin/training/datasets/${dataset.id}`);
    if (before.total > 0) throw new Error("Reset the instance first: examples were already captured.");
    await removeUsers(kit, [PRIYA.email, MARCUS.email]);
    await priorWork(kit);

    // 1. Datasets, with capture off.
    const page = kit.use(await kit.app("admin", "/admin/users"));
    await openTab(page, "Datasets");
    const capture = page.locator(".datasets-capture-panel");
    await capture.locator(".panel-header").getByText("Off", { exact: true }).waitFor();
    await page.getByText("No examples captured yet").waitFor();
    await shot("ds-off");

    // 2. Turn capture on; the three signals stay selected.
    await capture.getByRole("switch", { name: "Capture training signals" }).click();
    await capture.locator(".panel-header").getByText("Capturing", { exact: true }).waitFor();
    await shot("ds-on");

    // 3. Safeguards, and one group that is never captured.
    await capture.getByRole("group", { name: "Groups never captured" }).getByRole("button", { name: "HR" }).click();
    await capture.getByRole("group", { name: "Groups never captured" }).getByRole("button", { name: "HR", pressed: true }).waitFor();
    await scrollTo(page, capture.locator(".datasets-policy-stack > .policy-toggle-row").nth(1), "start");
    await shot("ds-safeguards");

    // 4. Scan the chats saved before capture was on.
    await capture.getByRole("button", { name: "Scan existing chats" }).click();
    const status = page.locator(".datasets-status").filter({ hasText: /Scanned \d+ chats? and captured \d+ new examples?\./ });
    await status.waitFor({ timeout: 120000 });
    await scrollTo(page, status, "start");
    await shot("ds-scanned");

    // 5. Capture is automatic from here: a person corrects the assistant and
    // rates the revision.
    const jane = kit.use(await kit.app("user", "/"));
    await newChat(jane);
    await ask(jane, "What is the deadline to file a notice of appeal in a federal civil case?");
    const revised = await ask(jane, "That's wrong when the United States is a party: the deadline is 60 days. Please revise.");
    await people.scrollBelowHeader(jane, jane.locator(".user-message").filter({ hasText: "Please revise" }), 90);
    await shot("ds-user-correction");
    await revised.getByRole("button", { name: "Send positive feedback" }).click();
    const note = jane.getByRole("group", { name: "Feedback note" });
    await note.locator(".feedback-note-disclosure").waitFor();
    await note.getByLabel("Feedback note (optional)").fill("Correct now, and the exception is explained clearly.");
    await scrollTo(jane, note, "center");
    await shot("ds-user-note");
    await note.getByRole("button", { name: "Send note" }).click();
    await note.waitFor({ state: "detached" }).catch(() => {});
    await jane.waitForTimeout(2500);

    // 6. What has been captured, and what it suggests.
    kit.use(page);
    const overview = page.locator(".datasets-overview-panel");
    await overview.getByRole("button", { name: "Refresh" }).click();
    await overview.locator(".datasets-mix-grid").waitFor();
    await page.waitForTimeout(800);
    await scrollTo(page, overview, "start");
    await shot("ds-overview");
    await scrollTo(page, overview.locator(".datasets-mix-grid"), "center");
    await shot("ds-mix");
    const suggestions = overview.locator(".datasets-suggestions");
    await suggestions.waitFor();
    await scrollTo(page, suggestions, "center");
    await shot("ds-suggestions");

    // 7. Create the suggested litigation dataset.
    const suggestion = suggestions.locator(".datasets-suggestion").filter({ hasText: "Litigation —" }).first();
    const name = (await suggestion.locator("strong").innerText()).trim();
    await suggestion.getByRole("button", { name: "Create" }).click();
    const editor = page.locator(".datasets-editor-modal");
    await editor.waitFor();
    await shot("ds-editor");
    await scrollTo(page, editor.locator(".datasets-chip-field").first(), "start");
    await shot("ds-editor-rules");
    await editor.getByRole("button", { name: "Create dataset" }).click();
    await page.locator(".datasets-status").filter({ hasText: `${name} created.` }).waitFor();
    const card = page.locator(".datasets-card").filter({ hasText: name });
    await scrollTo(page, card, "center");
    await shot("ds-created");

    // 8. Review its examples, exactly as they would be exported.
    await card.getByRole("button", { name: "Review" }).click();
    const review = page.locator(".datasets-review-panel");
    await review.locator(".datasets-example").first().waitFor();
    await page.waitForTimeout(900);
    await scrollTo(page, review.locator(".datasets-example").first(), "start");
    await shot("ds-review");

    // 9. Names and identifiers are concealed in every example, whatever the
    // chat policy is.
    await review.getByLabel("Filter examples by dataset").selectOption("all");
    await review.getByLabel("Filter examples by practice area").selectOption({ label: "Financial · Tax" });
    await review.locator(".datasets-example").filter({ has: page.locator(".concealed-token") }).first().waitFor();
    const concealed = review.locator(".datasets-example").filter({ has: page.locator(".concealed-token") }).first();
    await scrollTo(page, concealed, "start");
    await shot("ds-concealed");

    // 10. Approve the dataset's examples.
    await review.getByLabel("Filter examples by practice area").selectOption("all");
    await review.getByLabel("Filter examples by dataset").selectOption({ label: name });
    await review.getByRole("button", { name: "Waiting for review" }).click();
    await page.waitForTimeout(900);
    const approveAll = review.getByRole("button", { name: "Approve all shown" });
    if (await approveAll.count()) await approveAll.click();
    else await review.locator(".datasets-example").first().getByRole("button", { name: "Approve" }).click();
    await page.locator(".datasets-status").filter({ hasText: /examples? approved\./ }).waitFor();
    await card.locator(".datasets-card-counts").filter({ hasText: /0\s*waiting/ }).waitFor();
    await scrollTo(page, card, "center");
    await shot("ds-approved");

    // 11. Download it, and check what the file really contains.
    await card.getByRole("button", { name: "Download" }).click();
    const dialog = page.locator(".datasets-download-modal");
    await dialog.waitFor();
    await shot("ds-download");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByRole("button", { name: /^Download \d+ examples?$/ }).click(),
    ]);
    const zip = path.join(kit.OUT, "ds-export.zip");
    await download.saveAs(zip);
    const listing = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n");
    const trainPath = listing.find((entry) => entry.split("/").pop() === "train.jsonl");
    for (const file of ["metadata.jsonl", "README.md"]) {
      if (!listing.some((entry) => entry.split("/").pop() === file)) throw new Error(`The download has no ${file}.`);
    }
    if (!trainPath) throw new Error("The download has no train.jsonl.");
    const train = execFileSync("unzip", ["-p", zip, trainPath], { encoding: "utf8" });
    const records = train.trim().split("\n").map((line) => JSON.parse(line));
    if (!records.length || !records.every((record) => record.prompt && record.chosen && record.rejected)) {
      throw new Error("The download is not a preference dataset.");
    }
    const bundle = execFileSync("unzip", ["-p", zip], { encoding: "utf8" });
    for (const raw of ["555-0134", "Northwind Industries", "Jane Smith", "Priya Shah", "Marcus Lee"]) if (bundle.includes(raw)) throw new Error(`The download contains ${raw}.`);
    console.log(`  download: ${records.length} preference pairs in train.jsonl`);
    await page.locator(".datasets-status").filter({ hasText: `Downloaded ${name}` }).waitFor();

    // 12. Every step is in the Audit Trail.
    await openTab(page, "Audit");
    const trail = await expandPanel(page, "Audit Trail");
    await trail.locator(".panel-header").getByRole("button", { name: "Refresh" }).click();
    await trail.getByLabel("Filter audit events by category").selectOption("training");
    await trail.locator(".audit-row").filter({ hasText: "DATASET_EXPORTED" }).first().waitFor();
    await scrollTo(page, trail.locator(".audit-filter-toolbar"), "start");
    await shot("ds-audit");
  },
};

module.exports = { "admin-personal-data": adminPersonalData, "admin-training-datasets": adminTrainingDatasets };
