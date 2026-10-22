/* Word and PDF files, templates, and page layout in Drafts, performed for real
 * as the synthetic standard user against the local training model.
 *
 * user-draft-word-pdf builds a synthetic services agreement as a real Word
 * package (header, footer with PAGE/NUMPAGES fields, tab stops, a table, and
 * bracketed blanks), opens it with Drafts › Attach file › Open in editor,
 * fills the blanks with Ask AI (the review notes the original formatting was
 * kept), saves a version, and exports a Word file that is checked for its
 * header, footer, table, and tab stops. It then opens a synthetic PDF made by
 * Chromium's print engine (running header and page-numbered footer) and
 * uploads the Word file as a reusable template.
 *
 * user-document-templates places the Mutual NDA template, has the model draft
 * it from a request, applies a plain-English layout request (no model call),
 * saves a version, applies a template's layout to existing text, and applies
 * the MLA layout from Assistant settings.
 *
 * Every file is synthetic and generated at run time in a temporary directory.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

// ---------------------------------------------------------------- packages

/** A ZIP archive (deflate) of { name: string | Buffer } parts. */
function zip(parts) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nameBytes = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(0x00210000, 10); // 1980-01-01 00:00
    header.writeUInt32LE(crc >>> 0, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(0x00210000, 12);
    entry.writeUInt32LE(crc >>> 0, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** The parts of a ZIP archive (stored or deflate), for checking exports. */
function unzip(buffer) {
  let end = -1;
  for (let at = buffer.length - 22; at >= 0; at -= 1) if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw new Error("Not a ZIP package.");
  const parts = {};
  let cursor = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < buffer.readUInt16LE(end + 10); index += 1) {
    const method = buffer.readUInt16LE(cursor + 10);
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const skip = buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + skip;
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const data = buffer.subarray(start, start + size);
    parts[name] = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
  }
  return parts;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const esc = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (text, { bold = false, size, color } = {}) =>
  `<w:r><w:rPr>${bold ? "<w:b/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}${size ? `<w:sz w:val="${size}"/>` : ""}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const tab = "<w:r><w:tab/></w:r>";
const para = (runs, { align, before = 0, after = 160, tabs = "", style = "" } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${tabs}<w:spacing w:before="${before}" w:after="${after}"/>${align ? `<w:jc w:val="${align}"/>` : ""}</w:pPr>${runs}</w:p>`;
const heading = (text) => para(run(text, { bold: true, size: 26, color: "1F4E5F" }), { before: 240, after: 120 });
const cell = (text, { width, shade, bold = false } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ""}</w:tcPr>${para(run(text, { bold }), { after: 60 })}</w:tc>`;

/** A synthetic services agreement as a Word package with a running header,
 * a page-numbered footer, tab stops, a bordered table, and bracketed blanks. */
function syntheticAgreementDocx() {
  const widths = [4320, 2160, 2880];
  const row = (cells, options = {}) => `<w:tr>${cells.map((text, index) => cell(text, { width: widths[index], ...options })).join("")}</w:tr>`;
  const border = (side) => `<w:${side} w:val="single" w:sz="6" w:space="0" w:color="7F9AA3"/>`;
  const table = `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`
    + row(["Service", "Frequency", "Fee (USD)"], { shade: "DCEBEF", bold: true })
    + row(["Security questionnaire review", "Monthly", "1,200"])
    + row(["Summary report", "Monthly", "400"])
    + row(["Annual audit support", "Yearly", "2,500"])
    + "</w:tbl>";
  const signatureTabs = '<w:tabs><w:tab w:val="left" w:pos="5040"/></w:tabs>';
  const body = [
    para(run("Services Agreement", { bold: true, size: 36, color: "1F4E5F" }), { align: "center", after: 240 }),
    para(run("This Services Agreement is made on ") + run("[Effective date]", { bold: true }) + run(" between Example Corporation (the Client) and ") + run("[Vendor name]", { bold: true }) + run(" (the Vendor), located at ") + run("[Vendor address]", { bold: true }) + run(".")),
    heading("1. Services"),
    para(run("The Vendor reviews supplier security questionnaires and sends the Client a summary report every month.")),
    heading("2. Fees"),
    table,
    para("", { after: 120 }),
    heading("3. Term"),
    para(run("This agreement starts on the effective date and continues for twelve months unless either party ends it with thirty days' written notice.")),
    heading("4. Signatures"),
    para(run("Example Corporation", { bold: true }) + tab + run("[Vendor name]", { bold: true }), { tabs: signatureTabs, before: 240 }),
    para(run("Signature: ________________") + tab + run("Signature: ________________"), { tabs: signatureTabs }),
    para(run("Date: [Date]") + tab + run("Date: [Date]"), { tabs: signatureTabs }),
  ].join("");
  const sect = '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
  const rPr = '<w:rPr><w:sz w:val="18"/><w:color w:val="5C6B7A"/></w:rPr>';
  return zip({
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>',
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:sz w:val="22"/><w:color w:val="1D2B36"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}${sect}</w:body></w:document>`,
    "word/header1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W}><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs></w:pPr><w:r>${rPr}<w:t>Example Corporation</w:t></w:r><w:r>${rPr}<w:tab/></w:r><w:r>${rPr}<w:t xml:space="preserve">Confidential · synthetic sample</w:t></w:r></w:p></w:hdr>`,
    "word/footer1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W}><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>${rPr}<w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r>${rPr}<w:t>1</w:t></w:r></w:fldSimple><w:r>${rPr}<w:t xml:space="preserve"> of </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "><w:r>${rPr}<w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`,
  });
}

/** A two-page synthetic policy PDF printed by Chromium with a running header
 * and a "Page N of M" footer. */
async function syntheticPolicyPdf(kit, file) {
  const page = await kit.anonymous("/");
  const sections = [
    ["Purpose", "This synthetic policy explains how Example Corporation reviews a new vendor before its first engagement."],
    ["Scope", "It applies to every vendor that receives customer data, system access, or confidential documents."],
    ["Review steps", "Confirm the security questionnaire is complete. Record the data the vendor will receive and who approved it. Schedule a follow-up review after ninety days."],
    ["Owners", "The vendor manager owns the review. The security team approves access. The legal team signs the agreement."],
    ["Exceptions", "Exceptions need written approval from the security team and expire after six months."],
    ["Records", "Keep the questionnaire, approvals, and signed agreement in the vendor file for seven years."],
  ];
  const html = `<!doctype html><html><head><style>
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12pt; color: #1d2b36; line-height: 1.5; }
    h1 { font-size: 22pt; color: #1f4e5f; text-align: center; margin: 0 0 18pt; }
    h2 { font-size: 14pt; color: #1f4e5f; margin: 22pt 0 6pt; }
    p { margin: 0 0 10pt; }
    .break { break-before: page; }
  </style></head><body>
    <h1>Vendor Security Policy</h1>
    ${sections.map(([title, text], index) => `<h2${index === 3 ? ' class="break"' : ""}>${index + 1}. ${title}</h2><p>${text}</p><p>${text}</p>`).join("")}
  </body></html>`;
  await page.setContent(html);
  const label = "font-family: Arial, Helvetica, sans-serif; font-size: 9pt; color: #5c6b7a; width: 100%; padding: 0 0.9in;";
  await page.pdf({
    path: file,
    format: "Letter",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: `<div style="${label} display: flex; justify-content: space-between;"><span>Example Corporation</span><span>Vendor security policy · synthetic</span></div>`,
    footerTemplate: `<div style="${label} text-align: center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
    margin: { top: "1in", bottom: "1in", left: "1in", right: "1in" },
  });
  await page.context().close();
}

// ------------------------------------------------------------------ Drafts

const body = (page) => page.getByRole("textbox", { name: "Document body", exact: true });

/** Scroll the editor's page column back to the top of the first page. */
async function scrollToPageTop(page) {
  await body(page).evaluate((root) => {
    for (let node = root.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
        node.scrollTop = 0;
        return;
      }
    }
  });
  await page.waitForTimeout(500);
}

async function openDrafts(kit) {
  const page = await kit.app("user", "/drafts");
  await body(page).waitFor();
  await page.waitForTimeout(1500);
  if ((await body(page).innerText()).trim()) throw new Error("Drafts should open on a blank document.");
  return page;
}

async function saveVersion(page) {
  const save = page.getByRole("button", { name: "Save version", exact: true });
  if (await save.isEnabled()) await save.click();
  await page.locator(".document-server-save-state").filter({ hasText: "Saved" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1200);
  if (await save.isEnabled()) {
    await save.click();
    await page.locator(".document-server-save-state").filter({ hasText: "Saved" }).waitFor({ timeout: 60000 });
    await page.waitForTimeout(700);
  }
}

/** Open a local file with Attach file › From this device › Open in editor. */
async function openInEditor(page, file) {
  await page.getByRole("button", { name: "Attach file", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Add draft attachment" });
  await menu.waitFor();
  const chooser = page.waitForEvent("filechooser");
  await menu.getByRole("menuitem", { name: /Open in editor/ }).click();
  await (await chooser).setFiles(file);
  const keep = page.getByRole("button", { name: "Save copy and continue" });
  if (await keep.isVisible().catch(() => false)) await keep.click();
  const name = path.basename(file);
  await page.locator(".draft-event").filter({ hasText: `Opened ${name} in the editor.` }).waitFor({ timeout: 120000 });
  await page.waitForTimeout(1500);
}

/** Select the whole paragraph that contains `text`, as a person would drag across it. */
async function selectParagraph(page, text) {
  await body(page).evaluate((root, wanted) => {
    const block = [...root.querySelectorAll("p, li, td")].find((node) => node.textContent.includes(wanted));
    if (!block) throw new Error(`No paragraph contains ${wanted}.`);
    block.scrollIntoView({ block: "center" });
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.trim()) nodes.push(node);
    const range = document.createRange();
    range.setStart(nodes[0], 0);
    const last = nodes[nodes.length - 1];
    range.setEnd(last, last.textContent.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, text);
  await page.waitForTimeout(700);
}

async function exportWord(page, dir) {
  const panel = page.locator("#document-export-panel");
  const destination = panel.getByLabel("Export destination");
  if (await destination.count()) await destination.selectOption({ label: "Browser downloads" });
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: /Word document/ }).click();
  const file = await download;
  if (!/\.docx$/.test(file.suggestedFilename())) throw new Error(`Unexpected export ${file.suggestedFilename()}`);
  const saved = path.join(dir, `export-${file.suggestedFilename()}`);
  await file.saveAs(saved);
  await panel.getByText(/Sent to your browser downloads|Saved to your selected location/).waitFor();
  return saved;
}

const AGREEMENT = "synthetic-services-agreement.docx";
const POLICY = "synthetic-vendor-security-policy.pdf";
const FILL = "Fill in the blanks with synthetic values: 1 November 2026, Northwind Example Supplies, and 100 Example Way, Springfield.";

const userDraftWordPdf = {
  role: "user",
  description: "Open a Word file with its formatting, fill blanks with Ask AI, save, export Word, open a PDF, and upload a Word template.",
  externalOrigins: () => [],
  frames: [
    "user/word-opened", "user/word-opened-end", "user/word-ask-ai", "user/word-ai-review", "user/word-ai-applied",
    "user/word-saved", "user/word-exported", "user/pdf-opened", "user/word-template-uploaded",
  ],
  async run(kit) {
    const { shot } = kit;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-word-"));
    try {
      const docx = path.join(dir, AGREEMENT);
      fs.writeFileSync(docx, syntheticAgreementDocx());
      const pdf = path.join(dir, POLICY);
      await syntheticPolicyPdf(kit, pdf);

      // 1. A PDF opens with its running header and page numbers.
      let page = await openDrafts(kit);
      await openInEditor(page, pdf);
      if (!(await page.locator(".document-page-chrome-box.is-footer").first().innerText()).match(/Page\s+1\s+of\s+2/)) {
        throw new Error("The PDF footer did not come through with page numbers.");
      }
      await scrollToPageTop(page);
      await shot("pdf-opened");
      await page.context().close();

      // 2. Upload the Word file as a reusable template.
      page = await openDrafts(kit);
      await page.getByRole("button", { name: "Choose template" }).click();
      await page.locator(".draft-template-panel.is-document").waitFor();
      const upload = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload Word template" }).click();
      await (await upload).setFiles(docx);
      await page.locator(".draft-event").filter({ hasText: `Saved and added ${AGREEMENT} as a Word template on the blank canvas.` }).waitFor({ timeout: 60000 });
      await page.waitForTimeout(1200);
      await shot("word-template-uploaded");
      await page.context().close();

      // 3. Open the Word file in the editor; its page setup and parts come along.
      page = await openDrafts(kit);
      await openInEditor(page, docx);
      if (!(await page.locator(".document-page-chrome-box.is-header").first().innerText()).includes("Example Corporation")) {
        throw new Error("The Word header did not come through.");
      }
      if (!(await body(page).locator("table").count())) throw new Error("The Word table did not come through.");
      await scrollToPageTop(page);
      await shot("word-opened");
      // The end of the page: signature lines on tab stops, and the footer's live page numbers.
      await page.locator(".document-page-chrome-box.is-footer").first().evaluate((node) => node.scrollIntoView({ block: "end" }));
      await page.waitForTimeout(600);
      await shot("word-opened-end");

      // 4. Fill the blanks with Ask AI; the review keeps the original formatting.
      await selectParagraph(page, "[Effective date]");
      await page.locator(".document-selection-toolbar").getByRole("button", { name: /^Ask AI/ }).click();
      const composer = page.locator(".ai-composer");
      await composer.waitFor();
      await composer.getByRole("combobox", { name: "AI instruction" }).or(composer.getByLabel("AI instruction")).first().fill(FILL);
      await page.waitForTimeout(400);
      await shot("word-ask-ai", { keepFocus: true });
      let kept = false;
      for (let attempt = 0; attempt < 3 && !kept; attempt += 1) {
        if (attempt === 0) await composer.getByRole("button", { name: "Run AI instruction" }).click();
        else await composer.getByRole("button", { name: "Try again" }).click();
        await page.locator(".ai-composer.is-review").waitFor({ timeout: 600000 });
        await page.waitForTimeout(800);
        kept = await composer.locator(".ai-composer-kept").isVisible();
      }
      if (!kept) throw new Error("The fill-in review did not keep the original formatting.");
      await shot("word-ai-review");
      await page.getByRole("button", { name: "Accept AI suggestion" }).click();
      await page.locator(".ai-composer").waitFor({ state: "detached" });
      await body(page).getByText("Northwind Example Supplies").first().waitFor();
      const filled = await body(page).innerText();
      if (/\[Effective date\]|\[Vendor address\]/.test(filled.split("1. Services")[0])) throw new Error("The blanks were not filled.");
      await selectParagraph(page, "This Services Agreement");
      await page.evaluate(() => window.getSelection().removeAllRanges());
      await page.waitForTimeout(500);
      await shot("word-ai-applied");

      // 5. Save a version, then export Word and check the package.
      await saveVersion(page);
      await page.evaluate(() => document.querySelector("[aria-label='Document body']")?.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(400);
      await shot("word-saved");
      await page.locator(".document-export-button").click();
      await page.locator("#document-export-panel").waitFor();
      const exported = unzip(fs.readFileSync(await exportWord(page, dir)));
      const xml = (exported["word/document.xml"] || "").toString();
      const parts = Object.keys(exported);
      if (!parts.some((name) => /^word\/header\d*\.xml$/.test(name)) || !parts.some((name) => /^word\/footer\d*\.xml$/.test(name))) {
        throw new Error(`The exported Word file has no header or footer (${parts.join(", ")}).`);
      }
      if (!xml.includes("<w:tbl>") || !xml.includes("<w:tabs>") || !xml.includes("Northwind Example Supplies")) {
        throw new Error("The exported Word file lost its table, tab stops, or filled blanks.");
      }
      await shot("word-exported", { keepFocus: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

const NDA_REQUEST = "Fill this in for Example Corporation and Northwind Example Supplies, effective 1 November 2026, for a joint vendor security review.";
const LAYOUT_REQUEST = "Use 1.5 line spacing and 1.25-inch margins";

const userDocumentTemplates = {
  role: "user",
  description: "Start from a template, have the model draft it, apply a plain-English layout, save, reuse a template's layout, and apply MLA.",
  externalOrigins: () => [],
  frames: [
    "user/templates-panel", "user/template-placed", "user/template-request", "user/template-drafted",
    "user/layout-request", "user/layout-applied", "user/template-existing", "user/draft-settings", "user/mla-applied",
  ],
  async run(kit) {
    const { shot } = kit;
    // 5. A template's layout on existing text: the words stay as written.
    let page = await openDrafts(kit);
    await page.getByRole("textbox", { name: "Document title", exact: true }).fill("Vendor agreement changes");
    await body(page).click();
    for (const line of [
      "Vendor agreement changes",
      "The renewal date moves to 1 December 2026.",
      "The monthly report now includes open security findings.",
      "All other terms stay the same.",
    ]) {
      await page.keyboard.type(line, { delay: 15 });
      await page.keyboard.press("Enter");
    }
    await page.getByRole("button", { name: "Choose template" }).click();
    const drawer = page.locator(".draft-template-panel.is-document");
    await drawer.waitFor();
    await drawer.locator("[aria-label='Template categories']").getByText("Legal", { exact: true }).click();
    await drawer.locator(".draft-template-card").filter({ hasText: "Contract Amendment" }).first().click();
    await page.locator(".draft-event").filter({ hasText: /Contract Amendment/ }).first().waitFor({ timeout: 30000 });
    if (!/The renewal date moves to 1 December 2026\./.test(await body(page).innerText())) throw new Error("Applying the template changed the text.");
    await page.waitForTimeout(1200);
    await shot("template-existing");
    await page.getByRole("button", { name: "Choose template" }).click();
    await page.waitForTimeout(400);

    // 6. MLA layout from Assistant settings.
    await page.getByRole("button", { name: "Assistant settings", exact: true }).click();
    await page.locator(".draft-settings-panel").waitFor();
    await page.waitForTimeout(500);
    await shot("draft-settings");
    await page.locator(".draft-settings-panel").getByRole("button", { name: /Apply MLA layout/ }).click();
    await page.waitForTimeout(1500);
    await shot("mla-applied");
    await page.context().close();

    // 1. Templates in the assistant rail, Legal category.
    page = await openDrafts(kit);
    await page.getByRole("button", { name: "Choose template" }).click();
    const panel = page.locator(".draft-template-panel.is-document");
    await panel.waitFor();
    await panel.locator("[aria-label='Template categories']").getByText("Legal", { exact: true }).click();
    await page.waitForTimeout(600);
    await shot("templates-panel");

    // 2. Mutual NDA on the blank page: the scaffold with bracketed fields.
    await panel.locator(".draft-template-card").filter({ hasText: "Mutual NDA" }).first().click();
    await body(page).getByText("MUTUAL NONDISCLOSURE AGREEMENT", { exact: false }).first().waitFor();
    await page.waitForTimeout(1200);
    await shot("template-placed");

    // 3. The model drafts it from the template and a request.
    await page.locator("#draft-assistant-command").fill(NDA_REQUEST);
    await page.waitForTimeout(300);
    await shot("template-request", { keepFocus: true });
    await panel.getByRole("button", { name: "Create Mutual NDA draft" }).click();
    const busy = page.locator(".draft-assistant-title small.is-working");
    await busy.waitFor({ timeout: 30000 });
    await busy.waitFor({ state: "detached", timeout: 900000 });
    await page.locator(".document-server-save-state").filter({ hasText: "Saved" }).waitFor({ timeout: 60000 });
    await page.waitForTimeout(1500);
    if (!/Northwind Example Supplies/.test(await body(page).innerText())) throw new Error("The NDA draft does not name the parties.");
    if ((await page.getByRole("button", { name: "Choose template" }).getAttribute("aria-expanded")) === "true") {
      await page.getByRole("button", { name: "Choose template" }).click();
    }
    await page.evaluate(() => document.querySelector("[aria-label='Document body']")?.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(600);
    await shot("template-drafted");

    // 4. A plain-English layout request is applied without a model call.
    await page.locator("#draft-assistant-command").fill(LAYOUT_REQUEST);
    await page.waitForTimeout(300);
    await shot("layout-request", { keepFocus: true });
    await page.locator("#draft-assistant-command").press("Enter");
    await page.locator(".draft-event").filter({ hasText: "no model call was needed" }).waitFor({ timeout: 30000 });
    await saveVersion(page);
    await page.evaluate(() => document.querySelector("[aria-label='Document body']")?.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(800);
    await shot("layout-applied");
  },
};

module.exports = { "user-draft-word-pdf": userDraftWordPdf, "user-document-templates": userDocumentTemplates };
