import { describe, expect, test } from "vitest";
import { importDocxDocument } from "./docxImport";
import { buildZip } from "./ooxmlZip";
import { splitPageSetup } from "./documentPageSetup";

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const run = (text: string, props = "") =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (content: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${content}</w:p>`;
const field = (instr: string, cached: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> ${instr} </w:instrText></w:r>` +
  `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${cached}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;

function cell(content: string, width: number, tcPr = "") {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${tcPr}</w:tcPr>${content}</w:tc>`;
}

function docx(options: { bodyXml: string; sectPr?: string; extraParts?: Record<string, string>; extraRels?: string }) {
  const encoder = new TextEncoder();
  const styles = `<?xml version="1.0"?><w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;
  const numbering = `<?xml version="1.0"?><w:numbering ${W}>
<w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="720"/></w:pPr></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%2)"/><w:pPr><w:ind w:left="1440" w:hanging="720"/></w:pPr></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;
  const theme = `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="t"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme><a:fontScheme name="t"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
  const settings = `<?xml version="1.0"?><w:settings ${W}><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const sectPr =
    options.sectPr ??
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
  const document = `<?xml version="1.0"?><w:document ${W}><w:body>${options.bodyXml}${sectPr}</w:body></w:document>`;
  const parts: Record<string, string> = {
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": document,
    "word/_rels/document.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rS" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rN" Type="${R}/numbering" Target="numbering.xml"/><Relationship Id="rT" Type="${R}/theme" Target="theme/theme1.xml"/><Relationship Id="rSe" Type="${R}/settings" Target="settings.xml"/>${options.extraRels ?? ""}</Relationships>`,
    "word/styles.xml": styles,
    "word/numbering.xml": numbering,
    "word/theme/theme1.xml": theme,
    "word/settings.xml": settings,
    ...(options.extraParts ?? {}),
  };
  return buildZip(Object.entries(parts).map(([name, xml]) => ({ name, bytes: encoder.encode(xml) })));
}

async function convert(options: Parameters<typeof docx>[0]) {
  const result = await importDocxDocument(docx(options));
  const { setup, bodyHtml } = splitPageSetup(result.html);
  const holder = document.createElement("div");
  holder.innerHTML = bodyHtml;
  return { result, setup, bodyHtml, holder };
}

describe("Word import keeps the source formatting", () => {
  test("page setup, Normal text, and run formatting come from the package", async () => {
    const { setup, holder } = await convert({
      bodyXml:
        para(
          run("Plain ") +
            run("bold", "<w:b/>") +
            run(" highlighted", '<w:highlight w:val="yellow"/>') +
            run(" Smallcaps", "<w:smallCaps/>") +
            run(" red", '<w:color w:val="C00000"/><w:sz w:val="28"/>') +
            run(" Arial", '<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>'),
          '<w:jc w:val="both"/><w:ind w:firstLine="720"/>',
        ),
      sectPr:
        '<w:sectPr><w:pgSz w:w="12240" w:h="20160"/><w:pgMar w:top="1080" w:right="1800" w:bottom="1440" w:left="1800" w:header="540" w:footer="600" w:gutter="0"/></w:sectPr>',
    });

    expect(setup).toMatchObject({
      widthPt: 612,
      heightPt: 1008,
      marginTopPt: 54,
      marginLeftPt: 90,
      marginRightPt: 90,
      headerDistancePt: 27,
      footerDistancePt: 30,
      fontSizePx: 17.69,
    });
    expect(setup?.fontFamily.replace(/"/g, "'")).toBe("'Times New Roman', 'Liberation Serif', Tinos, Times, serif");
    // Word "auto" 1.08 spacing of a 1.15-line font, and 8pt after.
    expect(setup?.lineHeight).toBe(1.241);
    expect(setup?.paragraphAfterPx).toBe(11.79);

    const paragraph = holder.querySelector("p") as HTMLElement;
    expect(paragraph.style.textAlign).toBe("justify");
    expect(paragraph.style.textIndent).toBe("53.06px");
    expect(paragraph.style.marginBottom).toBe("11.79px");
    expect(paragraph.querySelector("strong")?.textContent).toBe("bold");
    expect(holder.innerHTML).toContain("background-color: #FFFF00");
    expect(holder.innerHTML).toContain("font-variant: small-caps");
    expect(holder.innerHTML).toMatch(/color: #C00000; ?|color: #C00000"/);
    expect(holder.innerHTML).toContain("font-size: 20.64px");
    expect(holder.innerHTML).toContain("font-family: Arial, 'Liberation Sans', Arimo, Helvetica, sans-serif");
  });

  test("numbering draws Word's own markers and bullets map out of Symbol", async () => {
    const item = (text: string, level: number, numId = 1) =>
      para(run(text), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`);
    const { holder } = await convert({
      bodyXml: [item("First", 0), item("Sub a", 1), item("Sub b", 1), item("Second", 0), item("Sub again", 1), item("Bullet", 0, 2)].join(""),
    });

    const markers = Array.from(holder.querySelectorAll(".document-list-marker")).map((node) => node.textContent);
    expect(markers).toEqual(["1.", "(a)", "(b)", "2.", "(a)", "•"]);
    const first = holder.querySelector("p") as HTMLElement;
    expect(first.style.marginLeft).toBe("53.06px");
    expect(first.style.textIndent).toBe("-53.06px");
    // The marker's tab reaches the hanging indent and records that stop.
    expect(first.innerHTML).toContain("document-tab document-tab-left document-tab-at-720");
    // List Paragraph contextual spacing: no space between same-style items.
    expect(first.style.marginBottom).toBe("0px");
  });

  test("tab stops keep alignment and leaders, and headings stay headings", async () => {
    const { holder } = await convert({
      bodyXml:
        para(run("Definitions"), '<w:pStyle w:val="Heading1"/>') +
        para(
          run("Section one") + "<w:r><w:tab/></w:r>" + run("12"),
          '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9360"/></w:tabs>',
        ),
    });

    const heading = holder.querySelector("h1") as HTMLElement;
    expect(heading.textContent).toBe("Definitions");
    expect(heading.style.fontWeight).toBe("normal");
    expect(heading.style.fontSize).toBe("17.69px");
    expect(heading.querySelector("strong")).not.toBeNull();
    const tab = holder.querySelector(".document-tab") as HTMLElement;
    expect(tab.className).toBe("document-tab document-tab-right document-tab-at-9360");
    expect(tab.style.borderBottom).toContain("dotted");
  });

  test("tables keep the grid, merges, borders, and shading", async () => {
    const rows = [
      `<w:tr>${cell(para(run("Matter")), 4000, '<w:shd w:val="clear" w:fill="1F3864"/>')}${cell(para(run("Notes")), 3000)}</w:tr>`,
      `<w:tr>${cell(para(run("Corporate")), 4000)}${cell(para(run("Merged")), 3000, '<w:vMerge w:val="restart"/>')}</w:tr>`,
      `<w:tr>${cell(para(run("Litigation")), 4000)}${cell(para(""), 3000, "<w:vMerge/>")}</w:tr>`,
      `<w:tr>${cell(para(run("Total")), 7000, '<w:gridSpan w:val="2"/>')}</w:tr>`,
    ];
    const { holder } = await convert({
      bodyXml: `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="3000"/></w:tblGrid>${rows.join("")}</w:tbl>`,
    });

    const table = holder.querySelector("table") as HTMLTableElement;
    expect(table.style.width).toBe("515.89px");
    const widths = Array.from(table.querySelectorAll("col")).map((col) => Number.parseFloat((col as HTMLElement).style.width));
    expect(widths[0]).toBeCloseTo(294.8, 1);
    expect(widths[1]).toBeCloseTo(221.09, 1);
    expect(table.querySelector('td[rowspan="2"]')?.textContent).toBe("Merged");
    expect(table.querySelector('td[colspan="2"]')?.textContent).toBe("Total");
    expect(table.rows[2].cells).toHaveLength(1);
    const shaded = table.rows[0].cells[0];
    expect(shaded.style.backgroundColor).toBe("rgb(31, 56, 100)");
    expect(shaded.style.borderTop).toContain("solid");
    // Paragraphs inside cells keep their own formatting.
    expect(shaded.querySelector("p")).not.toBeNull();
  });

  test("headers and footers carry page fields; footnotes and breaks are kept", async () => {
    const footer = `<?xml version="1.0"?><w:ftr ${W}>${para(run("Page ") + field("PAGE", "3") + run(" of ") + field("NUMPAGES", "9"), '<w:pStyle w:val="Footer"/>')}</w:ftr>`;
    const firstHeader = `<?xml version="1.0"?><w:hdr ${W}>${para(run("LETTERHEAD"))}</w:hdr>`;
    const footnotes = `<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote><w:footnote w:id="1">${para(
      '<w:r><w:footnoteRef/></w:r>' + run(" Note text."),
    )}</w:footnote></w:footnotes>`;
    const { result, setup, bodyHtml } = await convert({
      bodyXml:
        para(run("Clause") + "<w:r><w:footnoteReference w:id=\"1\"/></w:r>") +
        para('<w:r><w:br w:type="page"/></w:r>') +
        para(run("Signature page")),
      sectPr:
        '<w:sectPr><w:footerReference w:type="default" r:id="rF"/><w:headerReference w:type="first" r:id="rH"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:titlePg/></w:sectPr>',
      extraParts: { "word/footer1.xml": footer, "word/header1.xml": firstHeader, "word/footnotes.xml": footnotes },
      extraRels: `<Relationship Id="rF" Type="${R}/footer" Target="footer1.xml"/><Relationship Id="rH" Type="${R}/header" Target="header1.xml"/><Relationship Id="rFn" Type="${R}/footnotes" Target="footnotes.xml"/>`,
    });

    expect(setup?.footerHtml).toContain('<span class="document-field-page">3</span>');
    expect(setup?.footerHtml).toContain('<span class="document-field-pages">9</span>');
    expect(setup?.firstHeaderHtml).toContain("LETTERHEAD");
    // The first page has its own (empty) footer only when Word defines one.
    expect(setup?.firstFooterHtml).toBe("");
    expect(bodyHtml).toContain("Clause<sup>1</sup>");
    expect(bodyHtml).toMatch(/<hr class="document-page-break"><p[^>]*>Signature page<\/p>/);
    expect(bodyHtml).toContain("Note text.");
    expect(result.warnings).toContain("Footnotes are shown at the end of the document.");
  });
});
