import { expect, test } from "vitest";
import { LETTER_PAGE_SETUP, pageSetupMarkerHtml } from "./documentPageSetup";
import { buildSourceLayoutDocx } from "./docxSourceExport";
import { readZip } from "./ooxmlZipRead";

const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const MARKER = pageSetupMarkerHtml({
  ...LETTER_PAGE_SETUP,
  widthPt: 612,
  heightPt: 1008,
  marginLeftPt: 90,
  marginRightPt: 90,
  headerHtml: "<p>Agreement</p>",
  footerHtml:
    '<p style="text-align: center">Page <span class="document-field-page">2</span> of <span class="document-field-pages">5</span></p>',
  firstHeaderHtml: `<p style="text-align: center"><img src="${PNG_1X1}" alt="Logo" style="width: 200px; height: 50px"></p>`,
  firstFooterHtml: "",
});

const BODY = [
  '<section class="document-page" data-page-number="1">',
  '<h1 style="margin-top: 0px; margin-bottom: 17.69px; text-align: center; font-size: 23.58px; font-weight: normal; color: #1F3864"><strong>MASTER AGREEMENT</strong></h1>',
  '<p style="margin-top: 0px; margin-bottom: 4.42px">Definitions<span class="document-tab document-tab-right document-tab-at-9350" style="display: inline-block; width: 580px; border-bottom: 1.5px dotted currentcolor">\t</span>1</p>',
  '<p style="margin-top: 0px; margin-bottom: 0px; margin-left: 106.13px; text-indent: -53.06px; line-height: 1.241"><span class="document-list-marker">1.1</span><span class="document-tab document-tab-left document-tab-at-1440" style="display: inline-block; width: 26.53px">\t</span>Services means the <span style="font-variant: small-caps; background-color: #ffff00">legal services</span>.</p>',
  "</section>",
  '<section class="document-page" data-page-number="2">',
  '<table style="width: 515.89px; border-collapse: collapse; table-layout: fixed"><colgroup><col style="width: 294.8px"><col style="width: 221.09px"></colgroup><tbody>',
  '<tr><td style="border-top: 0.75px solid #000000; background-color: #1F3864; padding: 0px 7.96px 0px 7.96px"><p style="margin-top: 0px; margin-bottom: 0px; color: #FFFFFF">Matter</p></td><td rowspan="2" style="vertical-align: middle"><p>Merged</p></td></tr>',
  '<tr><td><p>Corporate</p></td></tr>',
  '<tr><td colspan="2"><p>Total</p></td></tr>',
  "</tbody></table>",
  "</section>",
  '<section class="document-page" data-page-number="3" data-page-break-before="manual">',
  '<p style="margin-top: 0px; margin-bottom: 35.38px; text-align: center"><strong><u>SIGNATURE PAGE</u></strong></p>',
  "</section>",
].join("");

async function exported() {
  const { bytes, warnings } = await buildSourceLayoutDocx(`${MARKER}${BODY}`);
  const parts = await readZip(bytes);
  const text = (name: string) => new TextDecoder().decode(parts.get(name) ?? new Uint8Array());
  return { parts, text, warnings };
}

test("the Word file gets the source page, margins, headers, and live page fields", async () => {
  const { parts, text } = await exported();
  const document = text("word/document.xml");

  expect(document).toContain('<w:pgSz w:w="12240" w:h="20160"/>');
  expect(document).toContain('w:left="1800"');
  expect(document).toContain('<w:headerReference w:type="default"');
  expect(document).toContain('<w:headerReference w:type="first"');
  expect(document).toContain('<w:footerReference w:type="first"');
  expect(document).toContain("<w:titlePg/>");
  const footerName = Array.from(parts.keys()).find((name) => /word\/footer\d\.xml/.test(name) && text(name).includes("Page"));
  expect(footerName).toBeTruthy();
  const footer = text(footerName as string);
  expect(footer).toContain("<w:instrText xml:space=\"preserve\"> PAGE </w:instrText>");
  expect(footer).toContain("<w:instrText xml:space=\"preserve\"> NUMPAGES </w:instrText>");
  // The letterhead picture travels inside the first-page header part.
  expect(Array.from(parts.keys()).some((name) => /^word\/media\/source-image\d+\.png$/.test(name))).toBe(true);
  expect(text("[Content_Types].xml")).toContain('Extension="png"');
});

test("paragraphs keep spacing, indents, tab stops, and run formatting", async () => {
  const { text } = await exported();
  const document = text("word/document.xml");

  // No title heading is invented for an imported document.
  expect(document.match(/MASTER AGREEMENT/g)).toHaveLength(1);
  expect(document).toContain('<w:pStyle w:val="Heading1"/>');
  expect(document).toContain('<w:tab w:val="right" w:leader="dot" w:pos="9350"/>');
  expect(document).toContain('<w:tab w:val="left" w:pos="1440"/>');
  expect(document).toContain('<w:ind w:left="1440" w:hanging="720"/>');
  expect(document).toMatch(/<w:spacing w:before="0" w:after="480" w:line="\d+" w:lineRule="auto"\/>/);
  expect(document).toContain("<w:smallCaps/>");
  expect(document).toContain('<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/>');
  expect(document).toContain('<w:color w:val="1F3864"/>');
});

test("tables keep the grid, merges, shading, and only authored page breaks", async () => {
  const { text } = await exported();
  const document = text("word/document.xml");

  expect(document).toContain('<w:gridCol w:w="4000"/>');
  expect(document).toContain('<w:gridCol w:w="3000"/>');
  expect(document).toContain('<w:vMerge w:val="restart"/>');
  expect(document).toContain("<w:vMerge/>");
  expect(document).toContain('<w:gridSpan w:val="2"/>');
  expect(document).toContain('<w:shd w:val="clear" w:color="auto" w:fill="1F3864"/>');
  expect(document).toContain('<w:vAlign w:val="center"/>');
  // Sheet 2 began by automatic layout (no break); sheet 3 by the author.
  expect(document.match(/<w:pageBreakBefore\/>/g)).toHaveLength(1);
  expect(document.indexOf("<w:pageBreakBefore/>")).toBeGreaterThan(document.indexOf("Total"));
});

test("characters XML forbids never reach the Word file", async () => {
  const { bytes } = await buildSourceLayoutDocx(`${MARKER}<p>Clause\u0003 text\u001f here</p>`);
  const parts = await readZip(bytes);
  const document = new TextDecoder().decode(parts.get("word/document.xml"));
  expect(document).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  expect(document).toContain("Clause text here");
});

test("signature lines, kept-together blocks, and Word compatibility settings", async () => {
  const body = [
    '<p class="document-keep-next">IN WITNESS WHEREOF, the Parties agree.</p>',
    '<table class="document-signature-table" style="width: 100%"><colgroup><col style="width: 50%"><col style="width: 50%"></colgroup><tbody><tr>',
    '<td style="padding: 0px"><p>By:&nbsp;<span class="document-tab document-tab-right document-tab-at-4500 document-signature-rule" style="display: inline-block; width: 300px; border-bottom: 0.75px solid currentcolor">\t</span></p></td>',
    "<td></td></tr></tbody></table>",
  ].join("");
  const letter = '<p>Very truly yours,</p><p>Name: <span class="document-signature-line">\u00a0\u00a0\u00a0\u00a0</span></p>';
  const { bytes } = await buildSourceLayoutDocx(`${MARKER}${letter}${body}`);
  const parts = await readZip(bytes);
  const text = (name: string) => new TextDecoder().decode(parts.get(name));
  const document = text("word/document.xml");

  expect(document).toMatch(/<w:keepNext\/>.*IN WITNESS WHEREOF/);
  expect(document).toContain("<w:cantSplit/>");
  expect(document).toContain('<w:tab w:val="right" w:leader="underscore" w:pos="4500"/>');
  // A fill-in rule is an underlined tab, one unbroken line in Word.
  expect(document).toMatch(/<w:u w:val="single"\/>[^]*?<w:tab\/>/);
  // A closing table is followed by a one-point paragraph, never a blank page.
  expect(document).toMatch(/<\/w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"\/>/);
  expect(text("word/settings.xml")).toContain("<w:doNotExpandShiftReturn/><w:doNotUseHTMLParagraphAutoSpacing/>");
});
