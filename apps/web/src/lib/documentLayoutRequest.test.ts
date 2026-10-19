import { expect, test } from "vitest";
import { pageChromeHtml } from "./documentPageSetup";
import { documentFormatById, pageSetupForFormat } from "./documentFormats";
import {
  applyLayoutChanges,
  isLayoutOnlyRequest,
  parseLayoutRequest,
  stripLayoutPhrases,
} from "./documentLayoutRequest";

test("a plain-English layout request is read into exact page settings", () => {
  const request =
    "Use Times New Roman 12 pt, double spaced, justified, with 1-inch margins, legal-size paper, and page numbers at the bottom right as Page X of Y.";
  const layout = parseLayoutRequest(request);
  expect(layout?.changes).toEqual({
    fontName: "Times New Roman",
    fontSizePt: 12,
    lineSpacing: 2,
    margins: { top: 72, right: 72, bottom: 72, left: 72 },
    paper: { widthPt: 612, heightPt: 1008, label: "legal-size paper" },
    bodyAlign: "justify",
    pageNumbers: { zone: "footer", align: "right", style: "page-of" },
  });
  expect(isLayoutOnlyRequest(request, layout!)).toBe(true);
});

test("side margins, headers, legends, and heading styles are understood", () => {
  expect(parseLayoutRequest("Set the left margin to 1.5 inches and the top margin to 2 inches")?.changes.margins).toEqual({
    left: 108,
    top: 144,
  });
  expect(parseLayoutRequest('Put "PRIVILEGED & CONFIDENTIAL" in the header')?.changes.headerText).toBe(
    "PRIVILEGED & CONFIDENTIAL",
  );
  expect(parseLayoutRequest("Mark it confidential in the footer")?.changes.footerText).toBe("CONFIDENTIAL");
  expect(parseLayoutRequest("Make the headings bold, centered, and in all caps")?.changes).toMatchObject({
    headingAlign: "center",
    headingCaps: true,
    headingBold: true,
  });
  expect(parseLayoutRequest("Format this as a memo")?.changes.formatId).toBe("legal-memo");
  expect(parseLayoutRequest("Indent the first line of each paragraph by 0.25 inch")?.changes.indentFirstPt).toBe(18);
});

test("words that only look like layout are left to the drafting model", () => {
  // Typefaces count only as typefaces, never as places or delivery methods.
  expect(parseLayoutRequest("Draft an NDA governed by Georgia law with notices by courier")).toBeNull();
  // Editing a heading's text is not a footer change.
  expect(parseLayoutRequest("Remove the page number from the heading.")).toBeNull();
  // A content edit that also mentions layout still goes to the model.
  const mixed = "Add a cure period to the termination clause and use Arial";
  expect(isLayoutOnlyRequest(mixed, parseLayoutRequest(mixed)!)).toBe(false);
  expect(parseLayoutRequest("Write an essay in MLA format")).toBeNull();
  for (const content of [
    "Change the governing law to Georgia",
    "Draft a services agreement with a landscape contractor",
    "The NDA covers information marked confidential or disclosed orally",
    "Change the section header of 'Term' to 'Duration'",
    "Explain the justification for the fee",
    "Each milestone is worth 10 points",
    // Aimed at one part of the document; the page setup is document-wide.
    "Double space the signature block",
  ]) {
    expect(parseLayoutRequest(content), content).toBeNull();
  }
  expect(parseLayoutRequest("Use Georgia font")?.changes.fontName).toBe("Georgia");
  expect(parseLayoutRequest("Make it landscape")?.changes.orientation).toBe("landscape");
});

test("layout wording is not taken for the subject of a draft", () => {
  expect(
    stripLayoutPhrases(
      'Draft a master services agreement in Garamond 12 pt on legal-size paper, with a header that says "DRAFT" and page numbers bottom center.',
    ),
  ).toBe("Draft a master services agreement.");
});

test("changes keep the format's spacing multiple and rebuild headers and footers", () => {
  const base = pageSetupForFormat(documentFormatById("legal-agreement")!);
  const arial = applyLayoutChanges(base, { fontName: "Arial", fontSizePt: 11 });
  expect(arial.fontFamily.startsWith("Arial")).toBe(true);
  expect(arial.fontSizePx).toBe(16.21);
  expect(arial.lineHeight).toBe(1.15);

  const doubled = applyLayoutChanges(base, { lineSpacing: 2 });
  expect(doubled.lineHeight).toBe(2.3);
  // A double-spaced page marks paragraphs by indent, not extra space.
  expect(doubled.paragraphAfterPx).toBe(0);
  expect(doubled.blockStyles?.p).toContain("text-indent: 53.06px");

  const numbered = applyLayoutChanges(base, {
    pageNumbers: { zone: "footer", align: "right", style: "number" },
    headerText: "CONFIDENTIAL",
    skipFirstPageNumber: true,
  });
  expect(numbered.footerHtml).toContain("text-align: right");
  expect(numbered.footerHtml).not.toContain("Page");
  expect(numbered.headerHtml).toContain("CONFIDENTIAL");
  expect(pageChromeHtml(numbered, 0).footer).toBe("");
  expect(pageChromeHtml(numbered, 1).footer).toContain("document-field-page");

  const none = applyLayoutChanges(base, { pageNumbers: "none" });
  expect(none.footerHtml).toBe("");
});
