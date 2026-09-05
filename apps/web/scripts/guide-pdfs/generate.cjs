/* Generates identical downloadable role guides in public/docs/ and repo docs/.
 *
 *   node scripts/guide-pdfs/generate.cjs
 *
 * Needs playwright-core resolvable (NODE_PATH works) and a Playwright Chromium
 * in the local ms-playwright cache. Table-of-contents page numbers need a
 * python with pypdf — set GUIDE_PDF_PYTHON to point at one, or plain
 * `python3` is tried. Missing PDF extraction or TOC markers aborts publication.
 *
 * Two passes per guide: pass one locates each section's page via invisible
 * text markers, pass two re-renders with the numbers filled in (the markers
 * stay in both passes so pagination cannot shift between them).
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { renderGuideHtml, GUIDES } = require("./render.cjs");

const OUT_DIR = path.join(__dirname, "..", "..", "public", "docs");
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REPO_DOCS = path.join(REPO_ROOT, "docs");

const EXTRACT_MARKERS_PY = `
import re, sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
seen = set()
for number, page in enumerate(reader.pages, 1):
    text = re.sub(r"\\s+", "", page.extract_text() or "")
    for marker in re.findall(r"\\[\\[s:([a-z0-9-]+)\\]\\]", text):
        if marker not in seen:
            seen.add(marker)
            print(marker, number)
`;

function findCachedChromium() {
  const cache = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const candidates = [];
  for (const entry of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const shell = path.join(cache, entry, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
    const full = path.join(cache, entry, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium");
    if (entry.startsWith("chromium_headless_shell-") && fs.existsSync(shell)) candidates.push({ entry, bin: shell });
    if (entry.startsWith("chromium-") && fs.existsSync(full)) candidates.push({ entry, bin: full });
  }
  candidates.sort((a, b) => b.entry.localeCompare(a.entry, undefined, { numeric: true }));
  return candidates[0]?.bin ?? null;
}

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (error) {
    const cached = findCachedChromium();
    if (!cached) throw error;
    console.log(`playwright-core's pinned build is absent; using cached ${cached}`);
    return chromium.launch({ executablePath: cached });
  }
}

function resolvePython() {
  for (const candidate of [process.env.GUIDE_PDF_PYTHON, "python3"].filter(Boolean)) {
    try {
      execFileSync(candidate, ["-c", "import pypdf"], { stdio: "ignore" });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

function extractPageMap(python, pdfPath) {
  const stdout = execFileSync(python, ["-c", EXTRACT_MARKERS_PY, pdfPath], { encoding: "utf8" });
  const map = {};
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const [id, page] = line.split(" ");
    map[id] = Number(page);
  }
  return map;
}

async function printPdf(page, html, guide, outPath) {
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const options = {
    path: outPath,
    format: "Letter",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: `<div style="width:100%; font-size:7.5px; font-family: Helvetica, Arial, sans-serif; color:#8593a2; padding:0 0.6in; display:flex; justify-content:space-between;"><span>Aperture Chat · ${guide.docTitle}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    margin: { top: "0.55in", bottom: "0.72in", left: "0.62in", right: "0.62in" },
  };
  try {
    await page.pdf({ ...options, tagged: true, outline: true });
  } catch {
    await page.pdf(options); // older Chromium builds without tagged/outline support
  }
}

(async () => {
  const python = resolvePython();
  if (!python) throw new Error("Guide generation requires pypdf; set GUIDE_PDF_PYTHON to a Python that provides it.");
  const workRoot = path.join(REPO_ROOT, "tmp", "guide-pdfs");
  fs.mkdirSync(workRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(workRoot, "render-"));

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const { sectionsForRole } = require("./content.cjs");
    for (const role of ["user", "admin", "owner"]) {
      const guide = GUIDES[role];
      const outPath = path.join(staging, `${guide.file}.pdf`);
      await printPdf(page, renderGuideHtml(role), guide, outPath);
      const pageMap = extractPageMap(python, outPath);
      const missing = sectionsForRole(role).filter((section) => !pageMap[section.id]);
      if (missing.length) throw new Error(`Missing ${role} PDF sections: ${missing.map((section) => section.id).join(", ")}`);
      await printPdf(page, renderGuideHtml(role, pageMap), guide, outPath);
      const finalMap = extractPageMap(python, outPath);
      if (JSON.stringify(pageMap) !== JSON.stringify(finalMap)) throw new Error(`Table-of-contents pagination shifted for ${role}; public guides unchanged.`);
    }
  } finally {
    await browser.close();
  }

  // Publish only after all three roles render with a complete, stable TOC.
  for (const output of [OUT_DIR, REPO_DOCS]) fs.mkdirSync(output, { recursive: true });
  for (const guide of Object.values(GUIDES)) {
    const filename = `${guide.file}.pdf`;
    for (const output of [OUT_DIR, REPO_DOCS]) fs.copyFileSync(path.join(staging, filename), path.join(output, filename));
    console.log(`wrote matching public/docs/${filename} and docs/${filename}`);
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
