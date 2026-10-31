/* Agents, knowledge bases, and the Library's tools, performed for real as the
 * synthetic standard user.
 *
 * Standard users build agents and knowledge bases only when an administrator
 * grants it. Each module first records the screen as the workspace ships it
 * (building not available), then performs the administrator's part through
 * the owner and admin APIs (the owner's "Users can build their own agents"
 * ceiling and the Litigation group's Can build agents / knowledge bases /
 * tools permissions; the admin lessons teach those screens), reloads, and
 * performs the person's whole task in the UI.
 *
 * user-agents builds a private agent (instructions, model, knowledge, a skill
 * file), uses it in chat with @, and checks that the real reply follows its
 * instructions. user-knowledge creates a knowledge base, uploads a synthetic
 * PDF, Word, and Markdown file, watches them index, reads the Word file's
 * properties, crawls a small synthetic website served by this module (three
 * pages read up front, the rest left for question time), reads the page-reading
 * setting, shows the API form, asks a cited question about the PDF, and then
 * asks one only a page the crawl skipped can answer, which the question-time
 * lookup really fetches. There is no image-capable model or Tesseract here, so
 * the AI reading setting is shown as it stands, with no OCR result. user-tools
 * walks the Library's Connections, Prompts, and Skills and the form for adding
 * a private connection (not saved; there is no MCP server to connect to).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { helpers } = require("./user-common.cjs");
const { helpers: fixtures } = require("./knowledge-fixtures.cjs");
const { scrollTo, scrollBelowHeader, composer } = helpers;
const { wordFile, startSite, askWithHash, sendAndWait, dismissNotice } = fixtures;

const AGENT = {
  name: "Pleading Review Assistant",
  instructions: "You help a litigation team review pleadings. Answer in exactly three short bullet points and base them on the litigation playbook.",
};

/** A run leaves its trace open; fold it so the reply fits the frame. */
async function foldTrace(reply) {
  await reply.locator(".work-trace-toggle").click();
  await reply.locator(".work-trace.is-expanded").waitFor({ state: "detached" });
}

async function grantAuthoring(kit, permissions) {
  await kit.api("owner", "PATCH", "/api/platform/settings", { users_can_create_models: true });
  await kit.api("admin", "PATCH", "/api/admin/groups/group-litigation", { permissions });
}

async function editorTab(page, name) {
  await page.locator("[aria-label='Agent profile editor sections']").getByRole("tab", { name: new RegExp(`^${name}`) }).click();
  await page.waitForTimeout(500);
}

async function tick(page, label) {
  const box = page.locator(".agent-choice-grid label").filter({ hasText: label }).first().locator("input[type=checkbox]");
  if (!(await box.isChecked())) await box.check();
}

const userAgents = {
  role: "user",
  description: "Build a private agent with instructions, a model, knowledge, and a skill file, then use it in chat.",
  externalOrigins: () => [],
  frames: [
    "user/agents-blocked", "user/agents-page", "user/agent-profile", "user/agent-knowledge", "user/agent-skills",
    "user/agent-access", "user/agent-created", "user/agent-mention", "user/agent-trace", "user/agent-reply",
  ],
  async run(kit) {
    const { shot } = kit;
    // 1. As the workspace ships: building is not available yet.
    let page = await kit.app("user", "/agents");
    await page.getByText("Building agents is not available to you.").waitFor();
    await page.waitForTimeout(800);
    await shot("agents-blocked");
    await page.context().close();

    // 2. The administrator's grant, then the person's whole task.
    await grantAuthoring(kit, { agent_authoring: true });
    page = await kit.app("user", "/agents");
    const create = page.getByRole("button", { name: /New Agent/i }).first();
    await create.waitFor();
    await page.waitForTimeout(800);
    await shot("agents-page");
    await create.click();
    await page.getByLabel("Agent name").fill(AGENT.name);
    await page.getByLabel("AI model").selectOption({ index: 0 }).catch(() => {});
    await page.getByRole("textbox", { name: "System prompt" }).fill(AGENT.instructions);
    await page.waitForTimeout(400);
    await shot("agent-profile");
    await editorTab(page, "Knowledge");
    await tick(page, "Litigation Playbook");
    await shot("agent-knowledge");
    await editorTab(page, "Prompts & Skills");
    await tick(page, "Citation Discipline");
    await scrollTo(page, page.locator(".agent-choice-grid label").filter({ hasText: "Citation Discipline" }), "center");
    await shot("agent-skills");
    await editorTab(page, "Access");
    await page.getByText("Private — only you can use this agent.").waitFor();
    await shot("agent-access");
    await page.getByRole("button", { name: "Create agent" }).click();
    await page.getByText(`${AGENT.name} created. It is ready to use in chat.`).first().waitFor();
    await page.waitForTimeout(1200);
    await shot("agent-created");

    // 3. Use it in chat with @ and check the reply follows its instructions.
    await page.context().close();
    page = await kit.app("user", "/chat");
    const box = composer(page);
    await box.click();
    await box.pressSequentially("@Pleading", { delay: 60 });
    const menu = page.locator(".composer-command-menu[role='listbox']");
    await menu.waitFor();
    await menu.locator(".composer-command-item").filter({ hasText: AGENT.name }).first().click();
    await page.locator(".composer-tools-status").waitFor();
    // Let the inserted mention settle before typing, or the caret can jump.
    await page.waitForTimeout(600);
    await box.press("End");
    await page.waitForTimeout(200);
    await box.pressSequentially("What should our responsive pleadings preserve?", { delay: 15 });
    if (!/Assistant What should our responsive pleadings preserve\?$/.test((await box.inputValue()).trim())) {
      throw new Error(`The question was not typed after the mention: ${await box.inputValue()}`);
    }
    await page.waitForTimeout(300);
    await shot("agent-mention", { keepFocus: true });
    const reply = await sendAndWait(page);
    // A run leaves its trace open.
    await reply.locator(".work-trace.is-expanded").waitFor();
    const text = await reply.innerText();
    // Evidence the agent answered: its trace, its knowledge base, its format.
    if (!/Agent worked for/.test(text) || !text.includes(`Working as ${AGENT.name}`) || !/in workspace knowledge/.test(text)) {
      throw new Error(`The trace does not show the agent and its knowledge search: ${text.slice(0, 400)}`);
    }
    const bullets = await reply.locator(".message-rendered-response .md-list").first().locator("> li").count();
    if (bullets !== 3) throw new Error(`The reply has ${bullets} bullet points, not the three the agent asks for.`);
    if (!(await reply.locator(".message-citation-action").count())) throw new Error("The agent's reply has no citations.");
    await scrollBelowHeader(page, reply, 70);
    await shot("agent-trace");
    // Folded, the trace is one line and the reply fits below it.
    await foldTrace(reply);
    await scrollBelowHeader(page, reply, 70);
    await shot("agent-reply");
  },
};

const PDF_TEXT = "Synthetic vendor checklist. Renewal date: 30 November 2026. Security contact: security@vendor.example.";

/** A minimal one-page PDF whose text layer holds `text` (synthetic data only). */
function syntheticPdf(text) {
  const content = Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`);
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  let out = Buffer.from("%PDF-1.4\n");
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out = Buffer.concat([out, Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
  });
  const xref = out.length;
  const table = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.concat([out, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)]);
}

const KB = "Vendor onboarding (synthetic)";
const WORD = "synthetic-vendor-standards.docx";
const SITE_PORT = 5268;

const STANDARDS = {
  properties: {
    title: "Vendor standards",
    author: "Alex Morgan",
    subject: "What every new vendor must provide",
    keywords: "vendor, onboarding, standards",
    company: "Example Corporation",
  },
  custom: { "Matter number": "EX-2026-0147", Department: "Vendor management" },
  sections: [
    { heading: "Vendor standards", paragraphs: [
      "Every new vendor provides a signed contract, a completed security questionnaire, and a certificate of insurance before work starts.",
    ] },
  ],
};

/** A small public-style site. Only the first pages are read up front; the
 * rest stays in the crawler's list of links for question-time lookups. */
const SITE_PAGES = {
  "/": { title: "Supplier handbook", body: `<p>Everything a supplier needs to work with Example Corporation.</p><ul>
    <li><a href="/onboarding">Onboarding</a></li>
    <li><a href="/invoicing">Invoicing</a></li>
    <li><a href="/code-of-conduct">Code of conduct</a></li>
    <li><a href="/returns">Returns and damaged goods</a></li>
  </ul>` },
  "/onboarding": { title: "Onboarding", body: "<p>New suppliers register on the portal, complete the security questionnaire, and sign the supplier agreement before their first order.</p>" },
  "/invoicing": { title: "Invoicing", body: "<p>Send invoices to the accounts payable team with the purchase order number. Invoices are paid within forty-five days of receipt.</p>" },
  "/code-of-conduct": { title: "Code of conduct", body: "<p>Suppliers treat their workers fairly, follow local law, and report any conflict of interest to their buyer.</p>" },
  "/returns": { title: "Returns and damaged goods", body: "<p>Suppliers must collect damaged goods within 10 business days of a return notice. After that, Example Corporation may dispose of the goods at the supplier's cost.</p>" },
};
const LIVE_QUESTION = "How many business days do suppliers have to collect damaged goods?";

const userKnowledge = {
  role: "user",
  description: "Create a knowledge base, upload files, read their properties, crawl a site, set page reading, and ask cited questions, including one answered by a question-time lookup.",
  externalOrigins: () => [],
  frames: [
    "user/knowledge-blocked", "user/knowledge-page", "user/knowledge-create", "user/knowledge-files", "user/knowledge-properties",
    "user/knowledge-web", "user/knowledge-web-added", "user/knowledge-web-row", "user/knowledge-reading", "user/knowledge-api-locked", "user/knowledge-api",
    "user/knowledge-question", "user/knowledge-reply", "user/knowledge-sources", "user/knowledge-live-reply", "user/knowledge-live-source",
  ],
  async run(kit) {
    const { shot } = kit;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-knowledge-"));
    const site = await startSite({ host: "suppliers.localhost", port: SITE_PORT, routes: SITE_PAGES });
    try {
      const pdf = path.join(dir, "synthetic-vendor-checklist.pdf");
      fs.writeFileSync(pdf, syntheticPdf(PDF_TEXT));
      const md = path.join(dir, "synthetic-vendor-policy.md");
      fs.writeFileSync(md, "# Synthetic vendor policy\n\nEvery new vendor completes a security questionnaire before its first engagement, and a follow-up review is scheduled after ninety days.\n");
      const word = path.join(dir, WORD);
      fs.writeFileSync(word, wordFile(STANDARDS));

      // 1. As shipped, then the administrator's grant.
      let page = await kit.app("user", "/library/knowledge");
      await page.getByText(/You can use the knowledge bases shared with you in chat/).waitFor();
      await page.waitForTimeout(800);
      await shot("knowledge-blocked");
      await page.context().close();
      await grantAuthoring(kit, { knowledge_authoring: true });
      page = await kit.app("user", "/library/knowledge");
      const create = page.getByRole("button", { name: /New knowledge base/i }).first();
      await create.waitFor();
      await page.waitForTimeout(800);
      await shot("knowledge-page");

      // 2. Create it, starting with files.
      await create.click();
      const dialog = page.locator(".knowledge-create-modal");
      await dialog.waitFor();
      await dialog.getByLabel("Name").fill(KB);
      await dialog.getByRole("button", { name: "Upload files" }).click().catch(() => {});
      await page.waitForTimeout(300);
      await shot("knowledge-create", { keepFocus: true });
      await dialog.getByRole("button", { name: "Create" }).click();
      await page.getByText(/Drag files here/).waitFor();
      await page.locator("input[aria-label='Choose files to add']").setInputFiles([pdf, md, word]);
      await page.getByText("3 indexed files", { exact: false }).first().waitFor({ timeout: 180000 });
      await page.locator("text=Reading and indexing").waitFor({ state: "detached", timeout: 180000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await dismissNotice(page);
      await shot("knowledge-files");

      // 3. What the Word file says about itself.
      await page.getByRole("button", { name: "Clear finished" }).click();
      await page.getByRole("button", { name: `Show details for ${WORD}` }).click();
      const details = page.locator(".knowledge-document-details");
      await details.getByText("EX-2026-0147").waitFor();
      await scrollTo(page, details, "center");
      await shot("knowledge-properties");
      await page.getByRole("button", { name: `Hide details for ${WORD}` }).click();

      // 4. A site: read three pages now, leave the rest for question time.
      await page.getByRole("tab", { name: /Web pages/ }).click();
      const webForm = page.getByRole("form", { name: "Add a web page" });
      await webForm.getByLabel("Page address").fill(`${site.origin}/`);
      await webForm.getByRole("radio", { name: "Linked pages" }).click();
      await webForm.getByLabel("Most pages to read").fill("3");
      await page.waitForTimeout(300);
      await shot("knowledge-web", { keepFocus: true });
      await page.getByRole("button", { name: "Fetch and add pages" }).click();
      const siteRow = page.locator(".knowledge-document-row-item").filter({ hasText: "Looks for fresh pages when answering" });
      await siteRow.getByText(/3 pages/).waitFor({ timeout: 60000 });
      if (site.requests.includes("/returns")) throw new Error("The crawl read a page past its limit.");
      await page.waitForTimeout(2500);
      await shot("knowledge-web-added");
      await scrollTo(page, siteRow, "center");
      await shot("knowledge-web-row");

      // 5. How scanned pages and pictures are read. No image-capable model or
      // Tesseract exists here, so the setting is shown with no OCR result.
      await dismissNotice(page);
      await page.getByRole("tab", { name: /Settings/ }).click();
      const reading = page.locator("fieldset").filter({ hasText: "Handwriting and images" });
      await reading.getByRole("radio", { name: "AI reading on" }).waitFor();
      await reading.getByText("No image-capable model is set up for this workspace").waitFor();
      await scrollTo(page, reading, "center");
      await shot("knowledge-reading");

      // 6. API sources need their own grant: without Can add API sources the
      // API tab explains the lock. Then the administrator's grant, and the
      // form (not fetched: there is no synthetic API to reach).
      await page.getByRole("tab", { name: /^API/ }).click();
      await page.getByText(/Connecting APIs needs approval\./).first().waitFor();
      await page.waitForTimeout(500);
      await shot("knowledge-api-locked");
      await page.context().close();
      await grantAuthoring(kit, { knowledge_authoring: true, api_source_authoring: true });
      page = await kit.app("user", "/library/knowledge");
      await page.locator(`article[aria-label="${KB}"] .knowledge-card-title-button`).click();
      await page.getByRole("tab", { name: /^API/ }).click();
      await page.getByLabel("API address").waitFor();
      await page.waitForTimeout(500);
      await shot("knowledge-api");

      // 7. Ask a cited question in chat with #.
      await page.context().close();
      page = await kit.app("user", "/chat");
      await askWithHash(page, KB, "Vendor onb", "When is the renewal date in the vendor checklist, and who is the security contact?");
      await shot("knowledge-question", { keepFocus: true });
      const reply = await sendAndWait(page);
      if (!/30 November 2026|November 30, 2026/.test(await reply.innerText())) throw new Error("The reply did not use the indexed PDF.");
      if (!(await reply.locator(".message-citation-action").count())) throw new Error("The knowledge reply has no citations.");
      await foldTrace(reply);
      await scrollBelowHeader(page, reply, 70);
      await shot("knowledge-reply");
      await reply.locator(".message-citation-action").click();
      const panel = page.locator("aside.session-panel");
      await panel.waitFor();
      await page.waitForTimeout(800);
      await scrollTo(page, panel.locator(".session-sources"), "start");
      await shot("knowledge-sources");

      // 8. A question only an unread page can answer: the lookup really fetches it.
      await page.context().close();
      page = await kit.app("user", "/chat");
      await askWithHash(page, KB, "Vendor onb", LIVE_QUESTION);
      const live = await sendAndWait(page);
      if (!site.requests.some((request) => request.startsWith("/returns"))) throw new Error("The question-time lookup did not fetch the returns page.");
      if (!/\b10\b|\bten\b/i.test(await live.innerText())) throw new Error("The reply did not use the page fetched at question time.");
      const citation = live.locator(".message-citation-action");
      if (!(await citation.count())) throw new Error("The looked-up page was not cited.");
      await foldTrace(live);
      await scrollBelowHeader(page, live, 70);
      await shot("knowledge-live-reply");
      await citation.click();
      const livePanel = page.locator("aside.session-panel");
      await livePanel.waitFor();
      await page.waitForTimeout(800);
      await scrollTo(page, livePanel.locator(".session-sources"), "start");
      await shot("knowledge-live-source");
    } finally {
      await site.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

const userTools = {
  role: "user",
  description: "Walk the Library's Connections, Prompts, and Skills, and the private-connection form.",
  externalOrigins: () => [],
  frames: ["user/tools-connections", "user/tools-prompts", "user/tools-prompt-view", "user/tools-skills", "user/tools-add-connection"],
  async run(kit) {
    const { shot } = kit;
    let page = await kit.app("user", "/library/tools");
    const sections = page.locator("[aria-label='Tool workspace sections']");
    await sections.waitFor();
    await page.waitForTimeout(800);
    await shot("tools-connections");
    await sections.getByRole("tab", { name: /Prompts/ }).click();
    await page.waitForTimeout(800);
    await shot("tools-prompts");
    await page.getByRole("button", { name: "Open Matter Summary" }).click();
    await page.waitForTimeout(800);
    await shot("tools-prompt-view");
    await page.goto(kit.APP + "/library/tools");
    await sections.waitFor();
    await sections.getByRole("tab", { name: /Skills/ }).click();
    await page.waitForTimeout(800);
    await shot("tools-skills");
    await page.context().close();

    // With Can build tools granted, the person can add a private connection.
    await grantAuthoring(kit, { tool_authoring: true });
    page = await kit.app("user", "/library/tools");
    await page.getByRole("button", { name: /Add connection/ }).first().click();
    await page.getByText("Add a connection").first().waitFor();
    await page.getByLabel("Name").first().fill("Vendor directory (synthetic)");
    await page.getByLabel("Server URL").fill("https://mcp.example.com/vendors");
    await page.waitForTimeout(400);
    await shot("tools-add-connection", { keepFocus: true });
  },
};

module.exports = { "user-agents": userAgents, "user-knowledge": userKnowledge, "user-tools": userTools };
