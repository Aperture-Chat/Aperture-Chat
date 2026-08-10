import { expect, test } from "vitest";
import { buildDocxExportDocument } from "./docxExport";

const SMALL_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCvRRRX0x+Tn//Z";

function storedZipEntry(zip: Uint8Array, entryName: string) {
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= zip.length) {
    const view = new DataView(zip.buffer, zip.byteOffset + offset);
    const signature = view.getUint32(0, true);
    if (signature !== 0x04034b50) break;
    const compression = view.getUint16(8, true);
    const size = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(zip.slice(nameStart, nameStart + nameLength));
    if (name === entryName) {
      expect(compression).toBe(0);
      return decoder.decode(zip.slice(dataStart, dataStart + size));
    }
    offset = dataStart + size;
  }
  throw new Error(`Missing DOCX ZIP entry: ${entryName}`);
}

function expectWellFormedXml(xml: string) {
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  expect(parsed.querySelector("parsererror")).toBeNull();
}

test("builds a well-formed Word package with rich inline formatting and hard breaks", async () => {
  const bytes = await buildDocxExportDocument(
    "Fidelity Draft",
    `<section class="document-page" data-page-number="1">
      <h1>Fidelity Draft</h1>
      <p><strong>Bold</strong> <u>underlined</u>
        <span style="color: rgb(15, 118, 110)">teal</span>
        <code>const result = true</code>
        <sup class="document-citation">[1]</sup>
        <a href="https://example.com/research?mission=artemis&amp;year=2026">source link</a>
        <a href="javascript:alert(1)">unsafe link text</a>
      </p>
      <img src="data:image/jpeg;base64,${SMALL_JPEG}" alt="Embedded mission diagram">
      <hr class="document-page-break">
      <p>Second page text.</p>
      <table><thead><tr><th><em>Metric</em></th><th>Value</th></tr></thead>
        <tbody><tr><td>Range</td><td><strong>Far</strong></td></tr></tbody></table>
    </section>`,
  );

  expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
  const documentXml = storedZipEntry(bytes, "word/document.xml");
  const relationshipsXml = storedZipEntry(bytes, "word/_rels/document.xml.rels");
  const stylesXml = storedZipEntry(bytes, "word/styles.xml");

  expectWellFormedXml(documentXml);
  expectWellFormedXml(relationshipsXml);
  expectWellFormedXml(stylesXml);
  expect(documentXml).toContain('<w:u w:val="single"/>');
  expect(documentXml).toContain('<w:color w:val="0F766E"/>');
  expect(documentXml).toContain('w:ascii="Consolas"');
  expect(documentXml).toContain('<w:vertAlign w:val="superscript"/>');
  expect(documentXml).toContain("unsafe link text");
  expect(documentXml.match(/<w:pageBreakBefore\/>/g)).toHaveLength(1);
  expect(documentXml).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
  expect(relationshipsXml).toContain("relationships/hyperlink");
  expect(relationshipsXml).toContain('Target="media/image1.jpeg"');
  expect(relationshipsXml).not.toContain('Target="data:image');
  expect(relationshipsXml).toContain(
    'Target="https://example.com/research?mission=artemis&amp;year=2026"',
  );
  expect(relationshipsXml).not.toContain("javascript:");
  expect(documentXml).toContain('r:embed="rIdImg1"');
  expect(() => storedZipEntry(bytes, "word/media/image1.jpeg")).not.toThrow();
});

test("exports toolbar formatting: strike, subscript, highlight, size, and alignment", async () => {
  const bytes = await buildDocxExportDocument(
    "Formatting Draft",
    `<section class="document-page" data-page-number="1">
      <h1>Formatting Draft</h1>
      <p style="text-align: center">Centered summary</p>
      <p style="text-align: justify">Justified body copy for the layout.</p>
      <p><s>withdrawn</s> H<sub>2</sub>O
        <span style="background-color: #fde68a">key point</span>
        <span style="font-size: 24px">huge text</span>
        <span style="font-size: 12px">small text</span>
      </p>
      <blockquote style="text-align: right">Right-aligned quote</blockquote>
    </section>`,
  );

  const documentXml = storedZipEntry(bytes, "word/document.xml");
  expectWellFormedXml(documentXml);
  expect(documentXml).toContain("<w:strike/>");
  expect(documentXml).toContain('<w:vertAlign w:val="subscript"/>');
  expect(documentXml).toContain('<w:shd w:val="clear" w:color="auto" w:fill="FDE68A"/>');
  expect(documentXml).toContain('<w:jc w:val="center"/>');
  expect(documentXml).toContain('<w:jc w:val="both"/>');
  expect(documentXml).toContain('<w:jc w:val="right"/>');
  // 24px and 12px through the shared preview px→pt mapping (493.9pt / 728px).
  const hugeHalfPt = Math.round(24 * (493.9 / 728) * 2);
  const smallHalfPt = Math.round(12 * (493.9 / 728) * 2);
  expect(documentXml).toContain(`<w:sz w:val="${hugeHalfPt}"/>`);
  expect(documentXml).toContain(`<w:sz w:val="${smallHalfPt}"/>`);
});

test("diagram figures embed their rasterized image instead of dropping to a caption", async () => {
  const bytes = await buildDocxExportDocument(
    "Diagram Draft",
    `<section class="document-page" data-page-number="1">
      <h1>Diagram Draft</h1>
      <figure class="document-media-block document-diagram-figure" contenteditable="false" data-diagram-source="flowchart" data-diagram-rendered="true">
        <img class="document-diagram-image" src="data:image/jpeg;base64,${SMALL_JPEG}" alt="flowchart diagram">
        <figcaption>Flowchart diagram</figcaption>
      </figure>
    </section>`,
  );
  const documentXml = storedZipEntry(bytes, "word/document.xml");
  const relationshipsXml = storedZipEntry(bytes, "word/_rels/document.xml.rels");
  expect(relationshipsXml).toContain('Target="media/image1.jpeg"');
  expect(documentXml).toContain('r:embed="rIdImg1"');
  expect(documentXml).toContain("Flowchart diagram");
  expect(() => storedZipEntry(bytes, "word/media/image1.jpeg")).not.toThrow();
});

test("document figures preserve the complete image aspect ratio", async () => {
  const bytes = await buildDocxExportDocument(
    "Uncropped Figure",
    `<section class="document-page" data-page-number="1">
      <figure class="document-image-figure">
        <img src="data:image/jpeg;base64,${SMALL_JPEG}" alt="Complete image">
        <figcaption>Complete image</figcaption>
      </figure>
    </section>`,
  );

  const documentXml = storedZipEntry(bytes, "word/document.xml");
  const extent = documentXml.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/);
  expect(extent).not.toBeNull();
  const width = Number(extent?.[1]);
  const height = Number(extent?.[2]);
  expect(width / height).toBeCloseTo(4 / 3, 2);
});

test("re-joins paginator-split paragraphs so Word gets one flowing paragraph", async () => {
  const bytes = await buildDocxExportDocument(
    "Split Draft",
    `<section class="document-page" data-page-number="1">
      <h1>Split Draft</h1>
      <p style="text-align: justify;">The term of this Agreement shall commence on the date that</p>
    </section><section class="document-page" data-page-number="2">
      <p style="text-align: justify;" data-split-continuation="true"> the Owner executes this Agreement and shall terminate one year thereafter.</p>
      <p>Next clause.</p>
    </section>`,
  );
  const decoder = new TextDecoder();
  const documentXml = decoder.decode(bytes).match(/<w:document[\s\S]*<\/w:document>/)?.[0] ?? "";
  const seamStart = documentXml.indexOf("shall commence on the date that");
  const seamEnd = documentXml.indexOf("the Owner executes this Agreement");
  expect(seamStart).toBeGreaterThan(-1);
  expect(seamEnd).toBeGreaterThan(seamStart);
  // One paragraph across the old sheet boundary: no paragraph close between
  // the two halves, and the page break moves to the following clause.
  expect(documentXml.slice(seamStart, seamEnd)).not.toContain("</w:p>");
  expect(documentXml).not.toContain("data-split-continuation");
  expect(documentXml.match(/<w:pageBreakBefore\/>/g)).toHaveLength(1);
});
