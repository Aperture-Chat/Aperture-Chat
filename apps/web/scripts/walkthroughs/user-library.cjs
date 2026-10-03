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
 * PDF and Markdown file, watches them index, adds a web page by address,
 * shows the API form, and asks a cited question about the PDF. user-tools
 * walks the Library's Connections, Prompts, and Skills and the form for adding
 * a private connection (not saved; there is no MCP server to connect to).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { helpers } = require("./user-common.cjs");
const { scrollTo, scrollBelowHeader, composer, waitForReply } = helpers;

const AGENT = {
  name: "Pleading Review Assistant",
  instructions: "You help a litigation team review pleadings. Answer in exactly three short bullet points and base them on the litigation playbook.",
};

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
    "user/agent-access", "user/agent-created", "user/agent-mention", "user/agent-reply",
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
    await box.press("End");
    await box.pressSequentially("What should our responsive pleadings preserve?", { delay: 15 });
    await page.waitForTimeout(300);
    await shot("agent-mention", { keepFocus: true });
    const before = await page.locator("article.assistant-message").count();
    await page.locator("form.composer .send-button").click();
    const reply = await waitForReply(page, before);
    await reply.locator(".pending-trace-toggle").click();
    await reply.locator(".pending-trace.is-expanded").waitFor();
    const text = await reply.innerText();
    // Evidence the agent answered: its trace, its knowledge base, its format.
    if (!/Agent work trace/.test(text) || !/Preparing agent tools/.test(text) || !/Retrieving workspace knowledge/.test(text)) {
      throw new Error("The trace does not show the agent, its tools step, and its knowledge search.");
    }
    const bullets = await reply.locator(".message-rendered-response .md-list").first().locator("> li").count();
    if (bullets !== 3) throw new Error(`The reply has ${bullets} bullet points, not the three the agent asks for.`);
    if (!(await reply.locator(".message-citation-action").count())) throw new Error("The agent's reply has no citations.");
    // Collapsed, the trace still reads "Agent work trace"; the reply fits below it.
    await reply.locator(".pending-trace-toggle").click();
    await reply.locator(".pending-trace.is-collapsed").waitFor();
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

const userKnowledge = {
  role: "user",
  description: "Create a knowledge base, upload files and a web page, watch them index, and ask a cited question.",
  externalOrigins: () => [],
  frames: [
    "user/knowledge-blocked", "user/knowledge-page", "user/knowledge-create", "user/knowledge-files",
    "user/knowledge-web", "user/knowledge-web-added", "user/knowledge-api", "user/knowledge-question", "user/knowledge-reply", "user/knowledge-sources",
  ],
  async run(kit) {
    const { shot } = kit;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-knowledge-"));
    try {
      const pdf = path.join(dir, "synthetic-vendor-checklist.pdf");
      fs.writeFileSync(pdf, syntheticPdf(PDF_TEXT));
      const md = path.join(dir, "synthetic-vendor-policy.md");
      fs.writeFileSync(md, "# Synthetic vendor policy\n\nEvery new vendor completes a security questionnaire before its first engagement, and a follow-up review is scheduled after ninety days.\n");

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
      await page.locator("input[aria-label='Choose files to add']").setInputFiles([pdf, md]);
      await page.getByText("2 indexed files", { exact: false }).first().waitFor({ timeout: 180000 });
      await page.locator("text=Reading and indexing").waitFor({ state: "detached", timeout: 180000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await shot("knowledge-files");

      // 3. A web page by address.
      await page.getByRole("tab", { name: /Web pages/ }).click();
      await page.getByLabel("Page address").fill("https://example.com");
      await shot("knowledge-web", { keepFocus: true });
      await page.getByRole("button", { name: "Fetch and add page" }).click();
      await page.getByText("example.com").first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(2500);
      await shot("knowledge-web-added");

      // 4. The API source form (not fetched: there is no synthetic API to reach).
      await page.getByRole("tab", { name: /^API/ }).click();
      await page.getByLabel("API address").waitFor();
      await page.waitForTimeout(500);
      await shot("knowledge-api");

      // 5. Ask a cited question in chat with #.
      await page.context().close();
      page = await kit.app("user", "/chat");
      const box = composer(page);
      await box.click();
      await box.pressSequentially("#Vendor onb", { delay: 60 });
      const menu = page.locator(".composer-command-menu[role='listbox']");
      await menu.waitFor();
      await menu.locator(".composer-command-item").filter({ hasText: KB }).first().click();
      await box.press("End");
      await box.pressSequentially("When is the renewal date in the vendor checklist, and who is the security contact?", { delay: 15 });
      await shot("knowledge-question", { keepFocus: true });
      const before = await page.locator("article.assistant-message").count();
      await page.locator("form.composer .send-button").click();
      const reply = await waitForReply(page, before);
      if (!/30 November 2026|November 30, 2026/.test(await reply.innerText())) throw new Error("The reply did not use the indexed PDF.");
      if (!(await reply.locator(".message-citation-action").count())) throw new Error("The knowledge reply has no citations.");
      await scrollTo(page, reply, "start");
      await shot("knowledge-reply");
      await reply.locator(".message-citation-action").click();
      const panel = page.locator("aside.session-panel");
      await panel.waitFor();
      await page.waitForTimeout(800);
      await scrollTo(page, panel.locator(".session-sources"), "start");
      await shot("knowledge-sources");
    } finally {
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
