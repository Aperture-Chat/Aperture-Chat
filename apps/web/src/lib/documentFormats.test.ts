import { expect, test } from "vitest";
import { pageSetupMarkerHtml, splitPageSetup } from "./documentPageSetup";
import {
  describePageSetup,
  documentFormatById,
  formatDocumentBody,
  inferBlockStyles,
  pageSetupForFormat,
} from "./documentFormats";
import { markdownToDocumentHtml } from "./markdown";

const agreement = () => pageSetupForFormat(documentFormatById("legal-agreement")!);

function render(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

/** Markdown as AI drafts arrive, with fill-in rules drawn as the editor does. */
function draftHtml(markdown: string) {
  return markdownToDocumentHtml(markdown).replace(
    /_{4,}/g,
    '<span class="document-signature-line">    </span>',
  );
}

test("a format's page, samples, and rules travel in the page-setup marker", () => {
  const setup = agreement();
  const { setup: parsed } = splitPageSetup(`${pageSetupMarkerHtml(setup)}<p>Body</p>`);

  expect(parsed?.fontFamily).toContain("Times New Roman");
  expect(parsed?.features).toEqual(["clauses", "signatures", "exhibits"]);
  expect(parsed?.blockStyles?.h1).toContain("text-transform: uppercase");
  expect(parsed?.blockStyles?.h1).toContain("text-align: center");
  expect(parsed?.blockStyles?.p).toBe("text-align: justify; text-indent: 0px");
  expect(parsed?.footerHtml).toContain("document-field-pages");
  expect(describePageSetup(setup)).toBe("Times New Roman 12 pt, single spacing, Letter, 1-inch margins");
});

test("contract clauses hang on half-inch indents with real tab stops", () => {
  const root = render(
    formatDocumentBody(
      draftHtml(
        [
          "# SERVICES AGREEMENT",
          "## ARTICLE 1. SERVICES",
          "### 1.1 Personnel",
          "Vendor shall:\n(a) assign qualified personnel;\n(b) comply with policies, including:\n(i) background checks; and\n(ii) acceptable use; and\n(c) report monthly.",
          "1.2 Records. Vendor shall keep complete records of the Services.",
        ].join("\n\n"),
      ),
      agreement(),
    ),
  );
  const clauses = Array.from(root.querySelectorAll<HTMLElement>("p.document-clause"));
  expect(clauses.map((clause) => clause.querySelector(".document-list-marker")?.textContent)).toEqual([
    "(a)",
    "(b)",
    "(i)",
    "(ii)",
    "(c)",
    "1.2",
  ]);
  // (a) sits at 0.5", its text at 1"; (i) one level deeper; 1.2 hangs from the margin.
  expect(clauses[0].style.marginLeft).toBe("106.13px");
  expect(clauses[0].style.textIndent).toBe("-53.06px");
  expect(clauses[2].style.marginLeft).toBe("159.19px");
  expect(clauses[5].style.marginLeft).toBe("53.06px");
  expect(clauses[0].querySelector(".document-tab")?.className).toContain("document-tab-at-1440");
  expect(clauses[2].querySelector(".document-tab")?.className).toContain("document-tab-at-2160");
  // The words are untouched.
  expect(clauses[0].textContent?.replace(/\s+/g, " ")).toBe("(a) assign qualified personnel;");
  expect(root.querySelector("h1")?.getAttribute("style")).toContain("font-size: 20.64px");
  expect(root.querySelector("h3")?.getAttribute("style")).toContain("text-align: left");
});

test("clauses written as bullets lose the bullet and keep their letters", () => {
  const root = render(formatDocumentBody(draftHtml("Including:\n\n- (a) pricing;\n- (b) customer lists."), agreement()));
  expect(root.querySelector("ul")).toBeNull();
  expect(root.querySelectorAll("p.document-clause")).toHaveLength(2);
});

test("recitals indent, bracketed notes center, and exhibits start a new page", () => {
  const root = render(
    formatDocumentBody(
      draftHtml(
        [
          "# AGREEMENT",
          "WHEREAS, the parties wish to agree; and",
          "NOW, THEREFORE, the parties agree as follows:",
          "Body text of the agreement that runs long enough to be prose.",
          "[Signature page follows.]",
          "## EXHIBIT A",
          "## STATEMENT OF WORK",
        ].join("\n\n"),
      ),
      agreement(),
    ),
  );
  const recitals = root.querySelectorAll<HTMLElement>("p.document-recital");
  expect(recitals).toHaveLength(2);
  expect(recitals[0].style.textIndent).toBe("53.06px");
  expect(root.querySelector<HTMLElement>("p.document-note")?.style.textAlign).toBe("center");
  const exhibit = Array.from(root.querySelectorAll("h2")).find((heading) => heading.textContent === "EXHIBIT A");
  expect(exhibit?.previousElementSibling?.matches("hr.document-page-break")).toBe(true);
  // The exhibit's own title stays with it rather than taking a second break.
  expect(root.querySelectorAll("hr.document-page-break")).toHaveLength(1);
});

test("signature blocks become a borderless two-column table that stays together", () => {
  const root = render(
    formatDocumentBody(
      draftHtml(
        [
          "IN WITNESS WHEREOF, the parties have executed this Agreement.",
          "**ACME CORP.**",
          "By: ______________\nName: ______________\nTitle: ______________",
          "**BETA LLC**",
          "By: ______________\nName: ______________\nTitle: ______________",
        ].join("\n\n"),
      ),
      agreement(),
    ),
  );
  expect(root.querySelector("p")?.classList.contains("document-keep-next")).toBe(true);
  const table = root.querySelector<HTMLTableElement>("table.document-signature-table");
  expect(table).not.toBeNull();
  expect(table?.style.width).toBe("100%");
  const cells = table!.rows[0].cells;
  expect(cells).toHaveLength(2);
  expect(cells[0].textContent).toContain("ACME CORP.");
  expect(cells[1].textContent).toContain("BETA LLC");
  // Every rule is a right tab to the cell edge with an underscore leader.
  const rules = Array.from(cells[0].querySelectorAll<HTMLElement>(".document-signature-rule"));
  expect(rules).toHaveLength(3);
  expect(rules.every((rule) => /document-tab-right document-tab-at-4500/.test(rule.className))).toBe(true);
  expect(rules[0].style.borderBottom).toContain("solid");
});

test("a signature table the model built keeps its cells but drops the grid", () => {
  const root = render(
    formatDocumentBody(
      draftHtml(
        "IN WITNESS WHEREOF, the parties agree.\n\n| ACME | BETA |\n|---|---|\n| By: ________ | By: ________ |\n| Name: [Name] | Name: [Name] |",
      ),
      agreement(),
    ),
  );
  const table = root.querySelector<HTMLTableElement>("table.document-signature-table");
  expect(table).not.toBeNull();
  expect(table?.classList.contains("document-data-table")).toBe(false);
  expect(table?.querySelectorAll(".document-signature-rule")).toHaveLength(2);
  expect(table?.querySelector("td")?.getAttribute("style")).toContain("border: 0");
});

test("a narrower text column re-aims signature rules at the cell edge", () => {
  const body = formatDocumentBody(
    draftHtml("IN WITNESS WHEREOF, agreed.\n\n**ACME**\n\nBy: ________\nName: ________"),
    agreement(),
  );
  const narrow = { ...agreement(), marginLeftPt: 90, marginRightPt: 90 };
  const root = render(formatDocumentBody(body, narrow, { structure: false }));
  const rule = root.querySelector(".document-signature-rule");
  // 6" column / 2 columns = 216pt, less the 9pt gutter = 207pt = 4140 twips.
  expect(rule?.className).toContain("document-tab-at-4140");
});

test("data tables take the format's grid and header shading", () => {
  const root = render(formatDocumentBody(draftHtml("| Item | Fee |\n|---|---:|\n| Design | $1.00 |"), agreement()));
  const [, header] = Array.from(root.querySelectorAll("th"));
  expect(root.querySelector<HTMLElement>("table")?.style.width).toBe("100%");
  expect(header?.getAttribute("style")).toContain("background-color: #F2F2F2");
  // The model's column alignment survives the format.
  expect(header?.getAttribute("style")).toContain("text-align: right");
  expect(root.querySelectorAll("th")[0].getAttribute("style")).toContain("border: 0.74px solid #000000");
});

test("a memo's TO / FROM block sits on a tab stop over a full-width rule", () => {
  const setup = pageSetupForFormat(documentFormatById("legal-memo")!);
  const root = render(formatDocumentBody(draftHtml("To: Partner\nFrom: Associate\nRe: Approval\n\nBody of the memo."), setup));
  const fields = root.querySelectorAll<HTMLElement>("p.document-memo-field");
  expect(fields).toHaveLength(3);
  // The author's label text is kept; capitals are a style.
  expect(fields[0].querySelector("strong")?.textContent).toBe("To:");
  expect(fields[0].querySelector("strong")?.getAttribute("style")).toBe("text-transform: uppercase");
  expect(fields[0].querySelector(".document-tab")?.className).toContain("document-tab-at-1440");
  expect(fields[2].nextElementSibling?.matches("hr.document-memo-rule")).toBe(true);
});

test("screenplay lines take their element indents", () => {
  const setup = pageSetupForFormat(documentFormatById("screenplay")!);
  const root = render(
    formatDocumentBody(
      draftHtml("INT. OFFICE - DAY\n\nLucas paces.\n\nLUCAS: The characters outlive the film.\n\nCUT TO:"),
      setup,
    ),
  );
  const kinds = Array.from(root.querySelectorAll("p.document-screenplay")).map((node) =>
    /document-screenplay-(\w+)/.exec(node.className)?.[1],
  );
  expect(kinds).toEqual(["scene", "action", "character", "dialogue", "transition"]);
  expect(root.querySelector<HTMLElement>(".document-screenplay-dialogue")?.style.marginLeft).toBe("106.13px");
  expect(root.querySelector<HTMLElement>(".document-screenplay-transition")?.style.textAlign).toBe("right");
});

test("a paper centers its title block and hangs its references", () => {
  const setup = pageSetupForFormat(documentFormatById("academic-paper")!);
  const root = render(
    formatDocumentBody(
      draftHtml("# The Title\n\nAuthor Name\nInstitution\n\n## Introduction\n\nThe opening paragraph of the paper sets out the thesis.\n\n## References\n\nAuthor, A. (2020). Title.\nAuthor, B. (2021). Title."),
      setup,
    ),
  );
  expect(root.querySelector<HTMLElement>(".document-title-block")?.style.textAlign).toBe("center");
  expect(root.querySelectorAll(".document-reference")).toHaveLength(2);
  expect(root.querySelector<HTMLElement>(".document-reference")?.style.textIndent).toBe("-53.06px");
  const prose = Array.from(root.querySelectorAll<HTMLElement>("p")).find((node) => node.textContent?.startsWith("The opening"));
  expect(prose?.style.textIndent).toBe("53.06px");
});

test("only prose takes a first-line indent", () => {
  const setup = pageSetupForFormat(documentFormatById("academic-paper")!);
  const root = render(
    formatDocumentBody(
      '<p>[Month Day, Year]</p><p>Acme Corp.<br>100 Main Street</p><p><strong>Re: Engagement of counsel for the supply dispute matter</strong></p><p>This sentence is long enough to be a paragraph of real prose.</p>',
      setup,
    ),
  );
  const indents = Array.from(root.querySelectorAll<HTMLElement>("p")).map((node) => node.style.textIndent || "");
  expect(indents).toEqual(["", "", "", "53.06px"]);
});

test("an opened document's own most common styles stand in as samples", () => {
  const styles = inferBlockStyles(
    [
      '<p style="text-align: justify; font-size: 17.69px; margin-bottom: 12px">One.</p>',
      '<p style="text-align: justify; font-size: 17.69px; margin-bottom: 12px">Two.</p>',
      '<p style="text-align: center">Title line</p>',
      '<h2 style="font-size: 22px; color: #1F3864">Heading</h2>',
      '<table><tr><td style="background-color: #1F3864; padding: 2px"><p><span style="color: #FFFFFF">Head</span></p></td></tr>',
      '<tr><td style="border: 1px solid #000000"><p>Cell</p></td></tr></table>',
    ].join(""),
  );
  expect(styles.p).toBe("text-align: justify; font-size: 17.69px");
  expect(styles.h2).toBe("font-size: 22px; color: #1F3864");
  expect(styles.th).toBe("background-color: #1F3864; padding: 2px; color: #FFFFFF");
  expect(styles.td).toBe("border: 1px solid #000000");
});

test("restyling applies a format over a document's own typography", () => {
  const body =
    '<h2 style="font-size: 30px; color: #FF0000; text-align: right">Heading</h2><p style="font-family: Arial; font-size: 14px; text-align: justify">Body <span style="font-family: Arial">run</span> text that is long enough.</p><p style="text-align: center">Centered line</p>';
  const root = render(formatDocumentBody(body, agreement(), { restyle: "all" }));
  const heading = root.querySelector("h2")!;
  expect(heading.style.color).toBe("");
  expect(heading.style.textAlign).toBe("center");
  expect(heading.style.fontSize).toBe("17.69px");
  const [prose, centered] = Array.from(root.querySelectorAll<HTMLElement>("p"));
  expect(prose.style.fontFamily).toBe("");
  expect(prose.querySelector("span")?.style.fontFamily).toBe("");
  expect(prose.style.textAlign).toBe("justify");
  expect(centered.style.textAlign).toBe("center");
});

test("review fixes: blanks, mixed cells, clause periods, sentences, notices, pictures", () => {
  // A raw underscore blank in a signature line never hangs the formatter.
  const blank = render(
    formatDocumentBody(
      'IN WITNESS WHEREOF, agreed.<p><strong>ACME</strong></p><p>By: <span class="document-blank">__________</span><br>Name: __________</p>'.replace(
        /^IN WITNESS WHEREOF, agreed\./,
        "<p>IN WITNESS WHEREOF, agreed.</p>",
      ),
      agreement(),
    ),
  );
  expect(blank.querySelectorAll(".document-signature-rule")).toHaveLength(2);

  // A signature cell with mixed content keeps every line.
  const mixed = render(
    formatDocumentBody(
      '<p>IN WITNESS WHEREOF, agreed.</p><table><tbody><tr><td>ACME CORP.<p>By: ________</p></td><td><p>BETA LLC</p><ul><li>By: ________</li><li>Name: ________</li></ul></td></tr></tbody></table>',
      agreement(),
    ),
  );
  const cells = mixed.querySelectorAll("table.document-signature-table td");
  expect(cells[0].textContent).toContain("ACME CORP.");
  expect(cells[1].textContent).toContain("Name:");

  // "1.2." keeps its period with the number.
  const clause = render(formatDocumentBody("<p>1.2. Records. Vendor shall keep complete records.</p>", agreement()));
  expect(clause.querySelector(".document-list-marker")?.textContent).toBe("1.2.");
  expect(clause.querySelector("p")?.textContent?.replace(/\s+/g, " ")).toBe("1.2. Records. Vendor shall keep complete records.");

  // A sentence about an exhibit is not an exhibit title.
  const sentence = render(formatDocumentBody("<h1>A</h1><p>Body.</p><p>Exhibit A lists the fees.</p>", agreement()));
  expect(sentence.querySelector("hr.document-page-break")).toBeNull();

  // A notices block is not a signatory; no table is better than a wrong one.
  const notices = render(
    formatDocumentBody(
      "<p>IN WITNESS WHEREOF, agreed.</p><p><strong>ACME</strong></p><p>By: ________<br>Name: ________</p><p>Notices:</p><p>Address: [Address]<br>Email: [Email]</p>",
      agreement(),
    ),
  );
  expect(notices.querySelector("table.document-signature-table")).toBeNull();
  expect(notices.textContent).toContain("Email: [Email]");

  // A seal or scanned signature in a signature block is kept.
  const picture = render(
    formatDocumentBody(
      '<p>IN WITNESS WHEREOF, agreed.</p><p><strong>ACME</strong></p><p><img src="data:image/png;base64,AAAA" alt="Seal"></p><p>By: ________<br>Name: ________</p>',
      agreement(),
    ),
  );
  expect(picture.querySelector("table.document-signature-table img")).not.toBeNull();
});
