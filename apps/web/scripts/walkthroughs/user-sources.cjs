/* Check a source: open the cited document, performed for real as the synthetic
 * standard user against the local training model.
 *
 * An administrator's knowledge base (setup through the API; the admin lessons
 * teach that screen) holds a twelve-page PDF printed by Chromium, a four-page
 * Word file, and a Markdown FAQ. Jane asks a question whose answers sit on page
 * 7 of the PDF and page 3 of the Word file, opens the sources, lands on the cited
 * page with the passage marked, moves away with the page and zoom controls, jumps
 * back, downloads the original (the bytes are checked), and closes. She then
 * opens an inline [K1], previews a file from the Library, asks something the
 * documents do not answer, and opens a citation from a document indexed before
 * originals were kept, which opens as text with the product's real notice.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { helpers } = require("./user-common.cjs");
const { helpers: fixtures } = require("./knowledge-fixtures.cjs");
const { scrollTo, scrollBelowHeader } = helpers;
const { wordFile, printPdf, uploadDocuments, recreateKnowledgeBase, openKnowledgeBase, askWithHash, sendAndWait } = fixtures;

const KB = "Vendor management (synthetic)";
const PDF_NAME = "vendor-security-handbook.pdf";
const WORD_NAME = "vendor-contract-standards.docx";
const FAQ_NAME = "vendor-onboarding-faq.md";

const HANDBOOK = {
  title: "Vendor Security Handbook",
  header: "Vendor security handbook · synthetic",
  sections: [
    { heading: "1. Purpose of this handbook", paragraphs: [
      "This handbook sets out the security expectations Example Corporation places on every vendor. It explains what a vendor must do before it receives company information, while the engagement runs, and when the engagement ends.",
      "The vendor manager keeps a copy of this handbook in each vendor file and walks the vendor through it at the kickoff meeting. Nothing here replaces the signed contract, which governs if the two differ.",
      "Read the handbook from the start the first time. After that, use the headings to find the section you need, because each page covers a single subject.",
    ] },
    { heading: "2. Who this handbook applies to", paragraphs: [
      "The handbook applies to every vendor that stores, processes, or can view company information, and to any individual contractor who works through that vendor.",
      "It also applies to vendors that only reach company systems for support, even when they hold no data of their own. A support login is still access, and it is reviewed in the same way.",
      "Vendors that deliver goods with no system access, such as office furniture suppliers, are out of scope. The vendor manager records that decision in the vendor file.",
    ] },
    { heading: "3. Classifying company data", paragraphs: [
      "Company data falls into three classes: Public, Internal, and Restricted. The class decides which controls in this handbook apply to a vendor.",
      "Public data has been approved for release. Internal data is routine business information. Restricted data includes personal information, financial records, and client matters.",
      "When a vendor handles more than one class, the strictest class applies to the whole engagement.",
    ] },
    { heading: "4. Access control", paragraphs: [
      "Every person who works on the engagement needs a named account. Shared accounts are not allowed, and multi-factor authentication is required on every login.",
      "A vendor grants the least access that lets a person do the job, and removes that access within one business day of the person leaving the engagement.",
      "The vendor sends the vendor manager a list of people with access every quarter, and the vendor manager checks it against the engagement team.",
    ] },
    { heading: "5. Encryption", paragraphs: [
      "Restricted data is encrypted at rest and in transit. Transport encryption uses TLS 1.2 or newer, and storage encryption uses AES-256 or an equivalent approved by the security team.",
      "Encryption keys are stored apart from the data they protect and are rotated at least once a year.",
      "Backups carry the same encryption as the systems they copy.",
    ] },
    { heading: "6. Logging and monitoring", paragraphs: [
      "Vendors keep logs of sign-ins, administrator actions, and access to Restricted data. Logs are protected from change and kept for at least twelve months.",
      "The vendor reviews alerts every business day. A named person owns the review, and a backup is assigned for time away.",
      "Logs are made available to the security team on request during an investigation.",
    ] },
    { heading: "7. Incident reporting", paragraphs: [
      "A vendor must report a confirmed security incident to the Example Corporation security team within 24 hours of discovery.",
      "The first report names the systems affected, the data involved, and the people leading the response. It goes to the security team's reporting address, and the vendor manager is copied.",
      "The vendor then sends a written update every day until the incident is closed, and a final root-cause report within ten business days of closing it.",
      "A suspected incident that cannot be ruled out within 24 hours is treated as confirmed.",
    ] },
    { heading: "8. Business continuity", paragraphs: [
      "Vendors keep a continuity plan that names how they will restore the service after an outage. The plan is tested at least once a year, and the results are shared with the vendor manager.",
      "For services the company relies on every day, the recovery time objective is four hours and the recovery point objective is one hour.",
      "A vendor tells the vendor manager before it moves the service to a new data center or hosting provider.",
    ] },
    { heading: "9. Subprocessors", paragraphs: [
      "A vendor lists every subprocessor that can reach company data. The list is part of the vendor file and is reviewed each year.",
      "A vendor gives thirty days' notice before adding a subprocessor, and the company may object during that time.",
      "The vendor remains responsible for the work of its subprocessors, and passes down every obligation in this handbook.",
    ] },
    { heading: "10. Annual review", paragraphs: [
      "Each vendor completes the security questionnaire once a year. The security team reads the answers, the latest independent audit report, and any findings still open from the last review.",
      "Findings rated high are fixed within thirty days. Findings rated medium are fixed within ninety days.",
      "The vendor manager records the outcome and the date of the next review in the vendor file.",
    ] },
    { heading: "11. Exceptions", paragraphs: [
      "An exception to this handbook needs written approval from the security team. The request names the control, the reason, the compensating control, and an end date.",
      "Exceptions expire after six months. A vendor that still needs one asks again, and the security team reviews it as a new request.",
      "The vendor manager keeps every approved exception in the vendor file.",
    ] },
    { heading: "12. Ending an engagement", paragraphs: [
      "When an engagement ends, the vendor returns or destroys company data within thirty days and confirms this in writing.",
      "All accounts are removed on the last day of the engagement. The vendor manager closes the vendor file and keeps it for seven years.",
      "Questions about this handbook go to the vendor manager, who brings in the security team when needed.",
    ] },
  ],
};

const CONTRACT = {
  properties: {
    title: "Vendor Contract Standards",
    author: "Alex Morgan",
    subject: "Standard contract positions for new vendors",
    keywords: "vendor, contract, insurance",
    company: "Example Corporation",
  },
  custom: { "Matter number": "EX-2026-0147" },
  sections: [
    { heading: "Overview", paragraphs: [
      "These standards set the positions Example Corporation takes in every new vendor contract. Use them together with the contract template, and mark any change you need so that the legal team can review it before anything is sent to the vendor.",
      "A contract that follows every position here can be signed by the vendor manager. A contract that departs from one of them needs legal approval first, and the approval is kept in the vendor file with the signed copy.",
      "The standards apply to new contracts and to renewals. When a contract comes up for renewal, compare it with this document, because older contracts often carry terms the company no longer accepts. The vendor manager records any gap and agrees a plan to close it before the renewal is signed.",
      "Each section below gives the standard position, the reason for it, and what to do when a vendor pushes back. If a vendor asks for something this document does not cover, stop and ask the legal team rather than agreeing to it in an email, because emails can change what a contract means.",
      "Keep the language of the template wherever you can. Small edits to defined terms have caused most of the disputes the company has had with vendors, and a clean template is the quickest contract to review.",
    ] },
    { heading: "Payment terms", paragraphs: [
      "Invoices are paid within forty-five days of receipt. Every invoice names the purchase order, the service period, and the person who ordered the work, because accounts payable returns any invoice that does not.",
      "A vendor may not charge late fees during the first ninety days of a contract. After that, a late fee can be no more than one percent a month on the amount overdue, and it never applies to an amount the company has disputed in good faith.",
      "Fees are fixed for the first twelve months, and any later increase is capped at three percent a year. An increase needs sixty days of written notice, and the vendor manager checks it against the contract before the next invoice is paid.",
      "Expenses are paid only when the company approved them in writing beforehand. Travel follows the company's travel policy, and receipts come with the invoice. A vendor that wants a deposit or a payment in advance needs approval from finance, and any advance is limited to one month of fees.",
      "If the company disputes an invoice, it pays the part that is not in dispute and tells the vendor why within ten business days. The vendor keeps working during the dispute, and both sides try to settle it within thirty days before anything is escalated.",
    ] },
    { heading: "Insurance requirements", paragraphs: [
      "The vendor must carry cyber liability insurance of at least 5 million US dollars per claim. This cover has to stay in force for the whole contract and for two years after it ends, because claims often arrive long after the work has finished.",
      "The vendor must also carry general liability insurance of at least 2 million US dollars per occurrence, and it names Example Corporation as an additional insured. For work on company premises, the vendor carries workers' compensation insurance as local law requires.",
      "The vendor sends a certificate of insurance before work starts and again at each renewal. The vendor manager reads the certificate rather than filing it unopened, and checks the limits, the dates, the named insured, and the additional insured wording.",
      "Insurers must be rated A minus or better by a recognised rating agency. A vendor tells the vendor manager within ten business days if a policy is cancelled, is not renewed, or has its limits reduced. A lower limit needs written approval from the legal team and the security team.",
      "A vendor with a large deductible explains how it would pay that amount. Small vendors sometimes ask to rely on a parent company's policy, and that is allowed only when the parent also signs the contract.",
    ] },
    { heading: "Termination", paragraphs: [
      "Either party may end the contract with sixty days' written notice. The company may end it at once for a material breach or a confirmed security failure, and it owes only the fees for work delivered up to that date.",
      "On termination the vendor returns company data, gives the company a final copy of any work in progress, and sends a final invoice within thirty days. The vendor then confirms in writing that it has deleted what it did not return.",
      "A vendor helps move the service to a new provider for up to ninety days after the contract ends, at the rates in the contract. This matters most for services the company depends on every day, so plan the handover before notice is given.",
      "Confidentiality, data protection, and audit rights continue after the contract ends. Limits on liability never cover a breach of confidentiality, or harm caused deliberately. If a vendor is bought by a competitor, the company may end the contract with thirty days' notice.",
      "Keep the signed contract, its amendments, and the record of how it ended in the vendor file for seven years. The vendor manager closes the file only when the final invoice is paid and the deletion is confirmed.",
    ] },
  ],
};

const FAQ = `# Vendor onboarding FAQ

## How long does onboarding take?

Most vendors finish onboarding in about three weeks. The vendor manager starts the clock when the security questionnaire arrives.

## Who fills in the security questionnaire?

The vendor does. The vendor manager reviews it for completeness before sending it to the security team.

## Where do people ask questions about an incident or insurance certificate?

Ask the vendor manager first. They know which team owns the question.
`;

const QUESTION = "In two short sentences: how many hours does a vendor have to tell us about a security incident, and how much cyber liability insurance must a vendor carry?";

const NO_SOURCE_QUESTIONS = [
  "Answer in one short sentence: what is the capital of Australia?",
  "Answer in one short sentence: what is twelve times twelve?",
  "Answer in one short sentence: which planet is closest to the sun?",
];

const viewer = (page) => page.locator(".dv-panel");

/** The viewer has opened a PDF rendition: its text layer holds the mark. */
async function waitForMark(page) {
  await viewer(page).locator(".dv-pages mark").first().waitFor({ timeout: 120000 });
  await page.waitForTimeout(1500);
}

async function pageShown(page) {
  return viewer(page).getByLabel("Go to page").inputValue();
}

const userSources = {
  role: "user",
  description: "Ask a knowledge question, open the cited document on the cited page, and check the passage.",
  externalOrigins: () => [],
  frames: [
    "user/sources-question", "user/sources-reply", "user/sources-trace", "user/sources-panel", "user/sources-pdf",
    "user/sources-moved", "user/sources-back", "user/sources-word", "user/sources-inline", "user/sources-inline-open",
    "user/sources-library", "user/sources-preview", "user/sources-none", "user/sources-old-text",
  ],
  async run(kit) {
    const { shot } = kit;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-sources-"));
    try {
      const pdf = path.join(dir, PDF_NAME);
      await printPdf(kit, pdf, HANDBOOK);
      const word = path.join(dir, WORD_NAME);
      fs.writeFileSync(word, wordFile(CONTRACT));
      const faq = path.join(dir, FAQ_NAME);
      fs.writeFileSync(faq, FAQ);
      const config = await recreateKnowledgeBase(kit, KB, ["group-litigation"]);
      await uploadDocuments(kit, "admin", config.id, [pdf, word, faq]);

      // 1. The question.
      let page = kit.use(await kit.app("user", "/chat"));
      await askWithHash(page, KB, "Vendor man", QUESTION);
      await shot("sources-question", { keepFocus: true });
      const reply = await sendAndWait(page);
      const text = await reply.innerText();
      console.log(`  reply: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
      if (!/24 hours/.test(text) || !/5 million|\$5/.test(text)) throw new Error("The reply did not use the handbook and the contract standards.");
      const action = reply.locator(".message-citation-action");
      if (!(await action.count())) throw new Error("The reply has no sources button.");
      console.log(`  sources button: ${await action.innerText()}`);
      // The trace stays open after a run: it counts what was searched, while
      // the button under the reply counts what was used.
      await reply.locator(".work-trace.is-expanded").waitFor();
      await scrollBelowHeader(page, reply, 70);
      console.log(`  trace: ${(await reply.locator(".work-trace").innerText()).replace(/\s+/g, " ")}`);
      await shot("sources-trace");
      await reply.locator(".work-trace-toggle").click();
      await reply.locator(".work-trace.is-expanded").waitFor({ state: "detached" });
      await scrollBelowHeader(page, reply, 70);
      await shot("sources-reply");

      // 2. The sources: only what the reply used.
      await action.click();
      const panel = page.locator("aside.session-panel");
      await panel.waitFor();
      await page.waitForTimeout(800);
      await scrollTo(page, panel.locator(".session-sources"), "start");
      console.log(`  panel: ${(await panel.locator(".session-sources").innerText()).replace(/\s+/g, " ")}`);
      await shot("sources-panel");

      // 3. Open the PDF source: the cited page, with the passage marked.
      await panel.locator(".session-source-open").filter({ hasText: PDF_NAME }).click();
      await viewer(page).waitFor();
      await waitForMark(page);
      if ((await pageShown(page)) !== "7") throw new Error(`The viewer opened on page ${await pageShown(page)}, not page 7.`);
      console.log(`  callout: ${(await viewer(page).locator(".dv-callout").innerText()).replace(/\s+/g, " ")}`);
      await shot("sources-pdf");

      // 4. Page and zoom controls, then back to the passage.
      await viewer(page).getByRole("button", { name: "Next page" }).click();
      await page.waitForTimeout(600);
      await viewer(page).getByRole("button", { name: "Zoom in" }).click();
      await page.waitForTimeout(1200);
      await viewer(page).getByLabel("Go to page").fill("10");
      await viewer(page).getByLabel("Go to page").press("Enter");
      await page.waitForTimeout(1800);
      await shot("sources-moved");
      await viewer(page).getByRole("button", { name: "Zoom out" }).click();
      await viewer(page).getByRole("button", { name: "Go to the cited passage" }).click();
      await page.waitForTimeout(1800);
      if ((await pageShown(page)) !== "7") throw new Error("Go to the cited passage did not return to page 7.");
      await shot("sources-back");

      // 5. Download original: the very bytes that were uploaded.
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        viewer(page).getByRole("button", { name: "Download original" }).click(),
      ]);
      const saved = path.join(dir, "downloaded.pdf");
      await download.saveAs(saved);
      if (!fs.readFileSync(saved).equals(fs.readFileSync(pdf))) throw new Error("Download original did not return the uploaded file.");
      console.log(`  downloaded ${download.suggestedFilename()} (${fs.statSync(saved).size} bytes, identical to the upload)`);
      await viewer(page).getByRole("button", { name: "Close document" }).click();
      await viewer(page).waitFor({ state: "detached" });

      // 6. The Word source, converted for viewing on its first open.
      await panel.locator(".session-source-open").filter({ hasText: WORD_NAME }).click();
      await viewer(page).waitFor();
      await waitForMark(page);
      console.log(`  word: page ${await pageShown(page)}: ${(await viewer(page).locator(".dv-callout").innerText()).replace(/\s+/g, " ")}`);
      await shot("sources-word");
      await page.keyboard.press("Escape");
      await viewer(page).waitFor({ state: "detached" });

      // 7. An inline marker opens the same place.
      await page.getByRole("button", { name: /session details/i }).first().click().catch(() => {});
      await page.waitForTimeout(600);
      const marker = reply.locator(".md-cite-open").first();
      await scrollTo(page, marker, "center");
      await shot("sources-inline");
      await marker.click();
      await viewer(page).waitFor();
      await waitForMark(page);
      await shot("sources-inline-open");
      await viewer(page).getByRole("button", { name: "Close document" }).click();
      await viewer(page).waitFor({ state: "detached" });
      await page.context().close();

      // 8. Library Preview: the same viewer, with nothing cited.
      page = kit.use(await kit.app("user", "/library/knowledge"));
      await openKnowledgeBase(page, KB);
      await shot("sources-library");
      await page.getByRole("button", { name: `Preview ${PDF_NAME}` }).click();
      await viewer(page).waitFor();
      await viewer(page).locator(".dv-pages canvas").first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(1500);
      if (await viewer(page).locator(".dv-callout").count()) throw new Error("A Library preview should show no cited passage.");
      await shot("sources-preview");
      await page.context().close();

      // 9. A question the documents do not answer. A small model sometimes
      // names the passages to say they did not help, and those count as cited,
      // so ask again in a new chat until a reply really wrote no marker.
      let plain = null;
      for (const question of NO_SOURCE_QUESTIONS) {
        page = kit.use(await kit.app("user", "/chat"));
        await askWithHash(page, KB, "Vendor man", question);
        const reply = await sendAndWait(page);
        console.log(`  plain reply: ${(await reply.innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
        if (!(await reply.locator(".message-citation-action").count())) {
          plain = reply;
          break;
        }
        await page.context().close();
      }
      if (!plain) throw new Error("Every reply wrote a marker, so the lesson's no-source frame cannot be shown.");
      await plain.locator(".work-trace-toggle").click();
      await plain.locator(".work-trace.is-expanded").waitFor({ state: "detached" });
      await scrollBelowHeader(page, plain, 70);
      await shot("sources-none");
      await page.context().close();

      // 10. A document indexed before originals were kept opens as text.
      page = kit.use(await kit.app("user", "/chat"));
      await askWithHash(page, "Litigation Playbook", "Litigation", "What should our responsive pleadings preserve?");
      const older = await sendAndWait(page);
      console.log(`  older reply: ${(await older.innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
      await older.locator(".message-citation-action").click();
      const olderPanel = page.locator("aside.session-panel");
      await olderPanel.waitFor();
      await olderPanel.locator(".session-source-open").first().click();
      await viewer(page).waitFor();
      await viewer(page).locator(".dv-paper").first().waitFor();
      await page.waitForTimeout(1200);
      console.log(`  notice: ${await viewer(page).locator(".dv-notice").allInnerTexts()}`);
      await shot("sources-old-text");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

module.exports = { "user-sources": userSources };
