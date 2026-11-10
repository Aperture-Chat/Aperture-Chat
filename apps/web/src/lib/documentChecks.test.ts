import { describe, expect, test } from "vitest";
import { checkDocument, checkableBlocks, FINDING_GROUP_LABELS, type CheckBlock, type DocumentFinding } from "./documentChecks";

const body = (...texts: string[]): CheckBlock[] => texts.map((text) => ({ text, heading: false }));
const heading = (text: string): CheckBlock => ({ text, heading: true });

function found(blocks: CheckBlock[], group: DocumentFinding["group"]) {
  return checkDocument(blocks)
    .filter((finding) => finding.group === group)
    .map(({ block, title, detail }) => [block, title, detail]);
}

describe("blanks to fill in", () => {
  test("a line left blank is found, with the words around it", () => {
    expect(found(body("This Agreement is made on ________ between the parties.", "No blanks here."), "blanks")).toEqual([
      [0, "…is made on ____ between the parties.", "1 blank to fill in"],
    ]);
  });

  test("several blanks in one paragraph are counted together", () => {
    expect(found(body("Name: ______ Date: ______ Title: ______"), "blanks")).toEqual([
      [0, "Name: ____ Date: ____ Title:…", "3 blanks to fill in"],
    ]);
  });

  test("underscores inside a word are not a blank", () => {
    expect(found(body("Set snake_case and __init__ in the file."), "blanks")).toEqual([]);
  });

  test("a long paragraph is shortened to the words around its first blank", () => {
    const text = "one two three four five six seven eight ________ nine ten eleven twelve thirteen fourteen fifteen sixteen ________ end";

    expect(found(body(text), "blanks")).toEqual([
      [0, "…six seven eight ____ nine ten eleven…", "2 blanks to fill in"],
    ]);
  });

  test("an excerpt is marked as cut only on the side where words were left out", () => {
    const excerpt = (text: string) => found(body(text), "blanks")[0][1];

    expect(excerpt("one two ________ a b c d e")).toBe("one two ____ a b c…");
    expect(excerpt("a b c d e f ________ one two")).toBe("…d e f ____ one two");
    expect(excerpt("a b c ________ x")).toBe("a b c ____ x");
    expect(excerpt("________ a b c")).toBe("____ a b c");
    expect(excerpt("________ a b c d")).toBe("____ a b c…");
  });

  test.each([
    ["The buyer is [Company Name].", "[Company Name]"],
    ["Governed by the laws of [insert governing law].", "[insert governing law]"],
    ["The price is [●] per share.", "[●]"],
    ["Closing occurs on [TBD].", "[TBD]"],
    ["Pay [$____] within ten days.", "[$____]"],
    ["Deliver to [DATE].", "[DATE]"],
    ["Notify [your client] promptly.", "[your client]"],
  ])("a bracketed placeholder in %j is found", (text, title) => {
    expect(found(body(text), "blanks")).toEqual([[0, title, "Placeholder still in the text"]]);
  });

  test.each([
    "As the court held [K1], the claim fails [W2][U1].",
    "See note [1] and note [12].",
    "The witness said he “dident [sic] know.”",
    "“[T]he parties agree” [emphasis added].",
    "The quote ends there [citation omitted].",
    "It was a [reasonable] step in the lower-case sense.",
    "[Signature page follows]",
    "[Remainder of page intentionally left blank]",
  ])("the brackets in %j are not placeholders", (text) => {
    expect(found(body(text), "blanks")).toEqual([]);
  });

  test.each([
    ["The fee is TBD.", "TBD"],
    ["Counsel: TBC", "TBC"],
    ["Insert XXX here later.", "XXX"],
    ["Lorem ipsum dolor sit amet.", "Lorem ipsum"],
    ["Amount to be determined at closing.", "to be determined"],
  ])("the unfinished note in %j is found", (text, title) => {
    expect(found(body(text), "blanks")).toEqual([[0, title, "Placeholder still in the text"]]);
  });

  test("the same placeholder twice in a paragraph is listed once", () => {
    expect(found(body("[Client] agrees that [Client] will pay."), "blanks")).toEqual([
      [0, "[Client]", "Placeholder still in the text"],
    ]);
  });
});

describe("defined terms", () => {
  const contract = body(
    "This Agreement (the “Agreement”) is made by Acme Inc. (the “Company”) and Jane Roe (the “Consultant”).",
    "“Effective Date” means the date first written above.",
    "“Services” shall mean the work described in Exhibit A.",
    "The Consultant will perform the Services for the Company under this Agreement.",
    "The Company will pay the Consultant within thirty days.",
  );

  test("a term that is defined and then never used is found where it is defined", () => {
    expect(found(contract, "terms")).toEqual([[1, "“Effective Date”", "Defined here, but not used anywhere else"]]);
  });

  test("a term used only in the sentence that defines it still counts as used", () => {
    expect(found(body("Acme Inc. (the “Company”) agrees that the Company will pay."), "terms")).toEqual([]);
  });

  test("terms are listed in page order whatever is wrong with them", () => {
    const blocks = body(
      "Acme Inc. (the “Company”) and Jane Roe (the “Consultant”) agree.",
      "The Consultant will deliver the Work Product to the Company.",
      "The Company owns the Work Product on payment.",
      "“Fee” means the amount payable.",
    );

    expect(found(blocks, "terms").map(([block, title]) => [block, title])).toEqual([
      [1, "“Work Product”"],
      [3, "“Fee”"],
    ]);
  });

  test("straight quotes define terms the same way as curly ones", () => {
    const blocks = body(
      'Acme Inc. (the "Company") hires Jane Roe (the "Consultant").',
      '"Fee" means the amount in Schedule 1.',
      "The Company pays the Consultant.",
    );

    expect(found(blocks, "terms")).toEqual([[1, "“Fee”", "Defined here, but not used anywhere else"]]);
  });

  test("one parenthesis can define several terms", () => {
    const blocks = body(
      "Acme Inc. and Beta LLC (each, a “Party” and together, the “Parties”) agree as follows.",
      "Each Party will keep the terms confidential.",
    );

    expect(found(blocks, "terms")).toEqual([[0, "“Parties”", "Defined here, but not used anywhere else"]]);
  });

  test("a term defined twice is found at its second definition", () => {
    const blocks = body(
      "Acme Inc. (the “Company”) agrees.",
      "Beta LLC (the “Company”) also agrees.",
      "The Company will pay.",
    );

    expect(found(blocks, "terms")).toEqual([[1, "“Company”", "Defined more than once"]]);
  });

  test("a capitalized term used like a defined term, with no definition, is found at its first use", () => {
    const blocks = body(
      "Acme Inc. (the “Company”) and Jane Roe (the “Consultant”) agree.",
      "The Consultant will deliver the Work Product to the Company.",
      "The Company owns the Work Product on payment.",
    );

    expect(found(blocks, "terms")).toEqual([
      [1, "“Work Product”", "Used like a defined term, but no definition was found"],
    ]);
  });

  test("a capitalized phrase used once is left alone", () => {
    const blocks = body(
      "Acme Inc. (the “Company”) and Jane Roe (the “Consultant”) agree.",
      "The Consultant will deliver the Final Report to the Company.",
    );

    expect(found(blocks, "terms")).toEqual([]);
  });

  test("a document with no definitions is not checked for undefined terms", () => {
    const blocks = body("We met the Board on Monday.", "We thanked the Board for its time.");

    expect(found(blocks, "terms")).toEqual([]);
  });

  test("places, courts, and references to sections are not treated as terms", () => {
    const blocks = body(
      "Acme Inc. (the “Company”) and Jane Roe (the “Consultant”) agree.",
      "Under the United States Code and the Section 4 rules, the Company pays.",
      "The Consultant accepts the United States Code and the Section 4 rules. The Company agrees.",
    );

    expect(found(blocks, "terms")).toEqual([]);
  });

  test("a heading in title case is not read as a use of a term", () => {
    const blocks: CheckBlock[] = [
      ...body("Acme Inc. (the “Company”) and Jane Roe (the “Consultant”) agree."),
      heading("Duties of the Lead Advisor"),
      heading("Removal of the Lead Advisor"),
      ...body("The Company pays the Consultant."),
    ];

    expect(found(blocks, "terms")).toEqual([]);
  });

  test("a possessive counts as a use", () => {
    const blocks = body("Acme Inc. (the “Company”) agrees.", "This is the Company’s only duty.");

    expect(found(blocks, "terms")).toEqual([]);
  });
});

describe("cross-references", () => {
  const numbered = body(
    "1. Services. The Consultant will perform the services.",
    "2. Fees. Fees are payable under Section 1.",
    "3. Term. This agreement ends as set out in Section 7.",
  );

  test("a reference to a section number that does not exist is found", () => {
    expect(found(numbered, "references")).toEqual([
      [2, "Section 7", "Referred to here, but no section with that number was found"],
    ]);
  });

  test("a sub-clause reference is checked against its section", () => {
    const blocks = body(
      "1. Services.",
      "2. Fees. See Section 1(a) and Clause 2(b)(ii).",
      "3. Term. See Paragraph 9(c).",
    );

    expect(found(blocks, "references")).toEqual([
      [2, "Paragraph 9", "Referred to here, but no section with that number was found"],
    ]);
  });

  test("sections labelled with the word Section or Article are recognised", () => {
    const blocks: CheckBlock[] = [
      heading("Article I Definitions"),
      heading("Article II Services"),
      heading("Article III Fees"),
      ...body("Fees are set under Article II and adjusted under Article V."),
    ];

    expect(found(blocks, "references")).toEqual([
      [3, "Article V", "Referred to here, but no section with that number was found"],
    ]);
  });

  test("a deeper reference is checked only when the document numbers that deep", () => {
    const flat = body("1. Services.", "2. Fees. See Section 2.4.", "3. Term.");
    const deep = body("1. Services.", "1.1 Scope.", "1.2 Standards.", "2. Fees. See Section 1.2 and Section 1.5.");

    expect(found(flat, "references")).toEqual([]);
    expect(found(deep, "references")).toEqual([
      [3, "Section 1.5", "Referred to here, but no section with that number was found"],
    ]);
  });

  test("a reference into another document or statute is left alone", () => {
    const blocks = body(
      "1. Services.",
      "2. Fees. See Section 365 of the Bankruptcy Code and Section 9 of the Lease.",
      "3. Term. See Section 8 of this Agreement.",
    );

    expect(found(blocks, "references")).toEqual([
      [2, "Section 8", "Referred to here, but no section with that number was found"],
    ]);
  });

  test("a document without numbered sections is not checked for section references", () => {
    expect(found(body("As Section 4 of the policy explains, notice is required.", "See Section 9."), "references")).toEqual([]);
  });

  test("a missing exhibit is found once the document has exhibits of its own", () => {
    const blocks: CheckBlock[] = [
      ...body("The services are described in Exhibit A and priced in Exhibit C."),
      heading("Exhibit A"),
      ...body("Scope of services."),
      heading("Exhibit B"),
    ];

    expect(found(blocks, "references")).toEqual([
      [0, "Exhibit C", "Referred to here, but no exhibit with that label was found"],
    ]);
  });

  test.each([
    ["EXHIBIT A", false],
    ["Exhibit A: Scope of Services", false],
    ["Schedule 1 - Fees", false],
    ["Exhibit A Scope of Services", true],
  ])("the line %j names an attachment the document holds", (label, isHeading) => {
    const blocks: CheckBlock[] = [
      ...body("See Exhibit A, Schedule 1, Exhibit B, and Schedule 2."),
      { text: label, heading: isHeading },
    ];
    const kind = /exhibit/i.test(label) ? "Exhibit B" : "Schedule 2";

    expect(found(blocks, "references").map(([, title]) => title)).toEqual([kind]);
  });

  test("a sentence that merely begins with an exhibit's name is not that exhibit", () => {
    const blocks = body("Exhibit A describes the services and Exhibit B the fees.", "Exhibit A is attached.");

    expect(found(blocks, "references")).toEqual([]);
  });

  test("plural and upper-case references are read as the same kind", () => {
    const blocks: CheckBlock[] = [
      ...body("See Exhibits C and D, and the Appendices 4 list."),
      heading("Exhibit A"),
      heading("Appendix 1"),
    ];

    expect(found(blocks, "references").map(([, title, detail]) => [title, detail])).toEqual([
      ["Exhibit C", "Referred to here, but no exhibit with that label was found"],
      ["Appendix 4", "Referred to here, but no appendix with that label was found"],
    ]);
  });

  test("exhibits kept in other documents are not flagged", () => {
    expect(found(body("The services are described in Exhibit A and Schedule 2."), "references")).toEqual([]);
  });

  test("the same missing reference is listed once per paragraph", () => {
    const blocks = body("1. One.", "2. Two.", "3. See Section 6, and again Section 6.");

    expect(found(blocks, "references")).toHaveLength(1);
  });
});

describe("numbering", () => {
  test("a skipped number is found where the count jumps", () => {
    expect(found(body("1. Services.", "2. Fees.", "4. Term.", "5. Notices."), "numbering")).toEqual([
      [2, "4.", "Numbering jumps from 2 to 4"],
    ]);
  });

  test("a repeated number is found at the repeat", () => {
    expect(found(body("1. Services.", "2. Fees.", "2. Term.", "3. Notices."), "numbering")).toEqual([
      [2, "2.", "Number 2 is used twice in a row"],
    ]);
  });

  test("a list that starts again at one is a new list", () => {
    expect(found(body("1. First.", "2. Second.", "3. Third.", "1. First again.", "2. Second again."), "numbering")).toEqual([]);
  });

  test("two numbered lines are too few to judge", () => {
    expect(found(body("1. Services.", "3. Term."), "numbering")).toEqual([]);
  });
});

describe("the report as a whole", () => {
  test("findings come grouped in a fixed order, and in document order within a group", () => {
    const blocks = body(
      "Acme Inc. (the “Company”) hires [Name] (the “Consultant”).",
      "1. Services. See Section 9.",
      "2. Fees are TBD.",
      "4. Term.",
    );

    expect(checkDocument(blocks).map((finding) => [finding.group, finding.block])).toEqual([
      ["blanks", 0],
      ["blanks", 2],
      ["terms", 0],
      ["terms", 0],
      ["references", 1],
      ["numbering", 3],
    ]);
  });

  test("a clean document has nothing to report", () => {
    expect(checkDocument(body("The parties met on Monday.", "They agreed to meet again."))).toEqual([]);
    expect(checkDocument([])).toEqual([]);
  });

  test("every group has a plain-word heading", () => {
    expect(FINDING_GROUP_LABELS).toEqual({
      blanks: "Blanks to fill in",
      terms: "Defined terms",
      references: "Cross-references",
      numbering: "Numbering",
    });
  });
});

describe("reading the page", () => {
  function page(html: string) {
    const root = document.createElement("div");
    root.innerHTML = html;
    return root;
  }

  test("each paragraph, heading, list item, and table cell is one block, in order", () => {
    const blocks = checkableBlocks(
      page("<h1>Services  Agreement</h1><p>First <strong>bold</strong> line.</p><ul><li>Item one</li></ul><table><tr><td>Cell</td></tr></table>"),
    );

    expect(blocks.map(({ text, heading: isHeading }) => [text, isHeading])).toEqual([
      ["Services Agreement", true],
      ["First bold line.", false],
      ["Item one", false],
      ["Cell", false],
    ]);
  });

  test("a list item that holds paragraphs is read through them, not twice", () => {
    const blocks = checkableBlocks(page("<ol><li><p>One</p><p>Two</p></li></ol>"));

    expect(blocks.map((block) => block.text)).toEqual(["One", "Two"]);
  });

  test("a blank drawn as a ruled line is read as a blank to fill in", () => {
    const blocks = checkableBlocks(
      page('<p>Paid on <span class="document-signature-line">&nbsp;&nbsp;&nbsp;&nbsp;</span> by the Company.</p>'),
    );

    expect(blocks.map((block) => block.text)).toEqual(["Paid on ____ by the Company."]);
    expect(checkDocument(blocks).map((finding) => finding.detail)).toEqual(["1 blank to fill in"]);
  });

  test("the running header and footer of an imported page are not read", () => {
    const blocks = checkableBlocks(
      page('<div class="document-page-chrome"><p>Draft [DATE] header</p></div><p>Body text.</p>'),
    );

    expect(blocks.map((block) => block.text)).toEqual(["Body text."]);
  });

  test("empty paragraphs are skipped, and each block keeps its element for jumping to", () => {
    const root = page("<p></p><p>   </p><p>Real</p>");

    const blocks = checkableBlocks(root);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].element).toBe(root.querySelectorAll("p")[2]);
  });
});
