/* Synthetic documents and a synthetic website for the knowledge walkthroughs.
 *
 * Nothing here is a mock: wordFile() writes a real Word package (with core,
 * app, and custom properties, which the product reads into Properties and
 * ethical walls), printPdf() prints a real multi-page PDF with Chromium, and
 * startSite() serves a small real website that the instance's crawler and
 * question-time lookup fetch over HTTP while the capture runs.
 *
 * index.cjs registers enumerable exports as capture modules, so this file
 * exposes its helpers on a hidden `helpers` property, as user-common.cjs does.
 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const zlib = require("node:zlib");
const { helpers: common } = require("./user-common.cjs");

const { composer, waitForReply } = common;

const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A ZIP archive (deflate) of { name: string | Buffer } parts. */
function zip(parts) {
  const records = [];
  const directory = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const packed = zlib.deflateRawSync(data);
    // Version needed through extra length: the same bytes in both headers.
    const fields = Buffer.alloc(26);
    fields.writeUInt16LE(20, 0);
    fields.writeUInt16LE(0x0800, 2); // UTF-8 names
    fields.writeUInt16LE(8, 4); // deflate
    fields.writeUInt32LE(0x00210000, 6); // 1980-01-01 00:00
    fields.writeUInt32LE(zlib.crc32(data), 10);
    fields.writeUInt32LE(packed.length, 14);
    fields.writeUInt32LE(data.length, 18);
    fields.writeUInt16LE(nameBytes.length, 22);
    const localSignature = Buffer.alloc(4);
    localSignature.writeUInt32LE(0x04034b50);
    records.push(localSignature, fields, nameBytes, packed);
    const centralStart = Buffer.alloc(6);
    centralStart.writeUInt32LE(0x02014b50);
    centralStart.writeUInt16LE(20, 4);
    const centralEnd = Buffer.alloc(14);
    centralEnd.writeUInt32LE(offset, 10);
    directory.push(centralStart, fields, centralEnd, nameBytes);
    offset += localSignature.length + fields.length + nameBytes.length + packed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, central, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const paragraph = (text) => `<w:p><w:pPr><w:spacing w:after="180" w:line="300" w:lineRule="auto"/></w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const headingParagraph = (text, pageBreak) =>
  `<w:p><w:pPr><w:keepNext/>${pageBreak ? "<w:pageBreakBefore/>" : ""}<w:spacing w:before="120" w:after="200"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="1F4E5F"/><w:sz w:val="32"/></w:rPr><w:t>${esc(text)}</w:t></w:r></w:p>`;

function coreProperties({ title, author, subject, keywords, description }) {
  const part = (tag, value) => (value ? `<${tag}>${esc(value)}</${tag}>` : "");
  return `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${part("dc:title", title)}${part("dc:subject", subject)}${part("dc:creator", author)}${part("cp:keywords", keywords)}${part("dc:description", description)}<dcterms:created xsi:type="dcterms:W3CDTF">2026-09-14T09:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-02T15:30:00Z</dcterms:modified></cp:coreProperties>`;
}

function customProperties(custom) {
  const items = Object.entries(custom).map(
    ([name, value], index) =>
      `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${index + 2}" name="${esc(name)}"><vt:lpwstr>${esc(value)}</vt:lpwstr></property>`,
  );
  return `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${items.join("")}</Properties>`;
}

/** A real Word package. `sections` are { heading, paragraphs }; each after the
 * first starts a new page. `properties` holds title, author, subject, keywords,
 * description, and company; `custom` holds custom properties by name. */
function wordFile({ properties = {}, custom = {}, sections }) {
  const body = sections.flatMap(({ heading, paragraphs }, index) => [
    headingParagraph(heading, index > 0),
    ...paragraphs.map(paragraph),
  ]);
  const hasCustom = Object.keys(custom).length > 0;
  return zip({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${hasCustom ? '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>' : ""}</Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>${hasCustom ? `<Relationship Id="rId4" Type="${REL}/custom-properties" Target="docProps/custom.xml"/>` : ""}</Relationships>`,
    "docProps/core.xml": coreProperties(properties),
    "docProps/app.xml": `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office Word</Application>${properties.company ? `<Company>${esc(properties.company)}</Company>` : ""}</Properties>`,
    ...(hasCustom ? { "docProps/custom.xml": customProperties(custom) } : {}),
    "word/_rels/document.xml.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    "word/styles.xml": `${XML}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:sz w:val="23"/><w:color w:val="1D2B36"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
    "word/document.xml": `${XML}<w:document ${W}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  });
}

/** A real multi-page PDF printed by Chromium: one page per section, with a
 * running header and a "Page N of M" footer. */
async function printPdf(kit, file, { title, header, sections }) {
  const page = await kit.anonymous("/");
  const html = `<!doctype html><html><head><title>${esc(title)}</title><style>
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 12.5pt; color: #1d2b36; line-height: 1.55; }
    h1 { font-family: Arial, Helvetica, sans-serif; font-size: 20pt; color: #1f4e5f; margin: 0 0 14pt; }
    p { margin: 0 0 12pt; }
    section { break-after: page; }
    section:last-child { break-after: auto; }
  </style></head><body>
    ${sections.map(({ heading, paragraphs }) => `<section><h1>${esc(heading)}</h1>${paragraphs.map((text) => `<p>${esc(text)}</p>`).join("")}</section>`).join("")}
  </body></html>`;
  // A blank page, so the file's Title comes from this document, not the app.
  await page.goto("about:blank");
  await page.setContent(html);
  const label = "font-family: Arial, Helvetica, sans-serif; font-size: 9pt; color: #5c6b7a; width: 100%; padding: 0 0.9in;";
  await page.pdf({
    path: file,
    format: "Letter",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: `<div style="${label} display: flex; justify-content: space-between;"><span>Example Corporation</span><span>${esc(header)}</span></div>`,
    footerTemplate: `<div style="${label} text-align: center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
    margin: { top: "1in", bottom: "1in", left: "1in", right: "1in" },
  });
  await page.context().close();
  return fs.statSync(file).size;
}

/** Serves `routes` ({ "/path": { title, body } }) with a search form at /search
 * and robots.txt, on `port`. Listens on every local address, because a
 * *.localhost name can resolve to ::1. Returns { close, origin, requests }. */
async function startSite({ host, port, routes, unlisted = {} }) {
  const origin = `http://${host}:${port}`;
  const all = { ...routes, ...unlisted };
  const requests = [];
  const page = (title, body) => `<!doctype html><html><head><title>${esc(title)} | Northwind Supplier Portal</title></head><body><nav><a href="/">Home</a></nav><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  const send = (response, status, type, text) => {
    response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(text) });
    response.end(text);
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, origin);
    const path = url.pathname.replace(/\/$/, "") || "/";
    requests.push(path + url.search);
    if (path === "/robots.txt") return send(response, 200, "text/plain", `User-agent: *\nAllow: /\n`);
    if (path === "/search") {
      const words = (url.searchParams.get("q") || "").toLowerCase().split(/\W+/).filter((word) => word.length > 3);
      const hits = Object.entries(all).filter(([, item]) => words.some((word) => `${item.title} ${item.body}`.toLowerCase().includes(word)));
      const list = hits.map(([href, item]) => `<li><a href="${href}">${esc(item.title)}</a></li>`).join("");
      return send(response, 200, "text/html; charset=utf-8", page("Search results", `<ul>${list}</ul>`));
    }
    const item = all[path];
    if (!item) return send(response, 404, "text/html; charset=utf-8", page("Not found", "<p>No such page.</p>"));
    const search = path === "/" ? '<form action="/search" method="get"><input name="q"><button>Search</button></form>' : "";
    return send(response, 200, "text/html; charset=utf-8", page(item.title, item.body + search));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  return { origin, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Setup only: add files to a knowledge base through its real upload endpoint. */
async function uploadDocuments(kit, audience, configId, files) {
  const { token } = await kit.session(audience);
  const form = new FormData();
  for (const file of files) form.append("files", new Blob([fs.readFileSync(file)]), path.basename(file));
  const response = await fetch(`${kit.API}/api/knowledge/${configId}/documents`, {
    method: "POST",
    headers: { "x-aperture-session": token },
    body: form,
  });
  if (!response.ok) throw new Error(`Upload to ${configId} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

/** Setup only: a fresh, shared knowledge base, replacing one from an earlier run. */
async function recreateKnowledgeBase(kit, name, groupIds) {
  const earlier = await kit.api("admin", "GET", "/api/admin/knowledge-configs");
  for (const item of earlier.filter((base) => base.name === name)) {
    await kit.api("admin", "DELETE", `/api/admin/knowledge-configs/${item.id}`);
  }
  return kit.api("admin", "POST", "/api/admin/knowledge-configs", { name, source_type: "upload", acl_group_ids: groupIds });
}

/** Open a knowledge base from Library › Knowledge. */
async function openKnowledgeBase(page, name) {
  await page.locator(`article[aria-label="${name}"] .knowledge-card-title-button`).click();
  await page.getByRole("tab", { name: /^Files/ }).waitFor();
  await page.waitForTimeout(800);
}

/** Choose a knowledge base with #, then type the question after it. */
async function askWithHash(page, knowledgeBase, search, question) {
  const box = composer(page);
  await box.click();
  await box.pressSequentially(`#${search}`, { delay: 60 });
  const menu = page.locator(".composer-command-menu[role='listbox']");
  await menu.waitFor();
  await menu.locator(".composer-command-item").filter({ hasText: knowledgeBase }).first().click();
  // Let the inserted knowledge base settle before typing, or the caret can jump.
  await page.waitForTimeout(600);
  await box.press("End");
  await page.waitForTimeout(200);
  await box.pressSequentially(question, { delay: 8 });
  const typed = (await box.inputValue()).trim();
  if (!typed.endsWith(question)) throw new Error(`The question was not typed after the knowledge base: ${typed}`);
}

/** Send what is in the composer and wait for the finished reply. The local
 * model is shared, so a reply can wait in its queue for minutes. */
async function sendAndWait(page) {
  const before = await page.locator("article.assistant-message").count();
  await page.locator("form.composer .send-button").click();
  return waitForReply(page, before, { timeout: 1800000 });
}

/** Clear the Library's status notice so it never crowds a frame. */
async function dismissNotice(page) {
  await page.getByRole("button", { name: "Dismiss notification" }).click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(250);
}

const helpers = { wordFile, printPdf, startSite, uploadDocuments, recreateKnowledgeBase, openKnowledgeBase, askWithHash, sendAndWait, dismissNotice };
Object.defineProperty(module.exports, "helpers", { value: helpers, enumerable: false });
