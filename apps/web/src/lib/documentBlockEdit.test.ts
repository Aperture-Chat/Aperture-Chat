import { describe, expect, it } from "vitest";
import {
  DOCUMENT_PATCH_PREFIX,
  DocumentPatchError,
  applyDocumentPatch,
  documentBlocks,
  documentPatchPrompt,
  parseDocumentPatch,
} from "./documentBlockEdit";

function page(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

function mark(content: DocumentFragment) {
  const span = document.createElement("span");
  span.className = "document-ai-suggestion";
  span.appendChild(content);
  return span;
}

describe("documentBlocks", () => {
  it("numbers the document's text blocks in reading order", () => {
    const root = page('<section class="document-page"><h1>Title</h1><p>First.</p><ul><li>Item</li></ul></section>');

    expect(documentBlocks(root).map(({ id, text }) => [id, text])).toEqual([
      [1, "Title"],
      [2, "First."],
      [3, "Item"],
    ]);
  });

  it("leaves running headers and footers alone", () => {
    const root = page(
      '<div class="document-page-setup"><div class="document-page-header"><p>Header</p></div></div><section class="document-page"><p>Body.</p></section>',
    );

    expect(documentBlocks(root).map(({ text }) => text)).toEqual(["Body."]);
  });

  it("counts a block inside a block once", () => {
    const root = page("<ul><li><p>Nested.</p></li></ul><blockquote><p>Quoted.</p></blockquote>");

    expect(documentBlocks(root).map(({ text }) => text)).toEqual(["Nested.", "Quoted."]);
  });

  it("skips an empty paragraph, which is only spacing", () => {
    expect(documentBlocks(page("<p></p><p>Words.</p><p>   </p>")).map(({ text }) => text)).toEqual(["Words."]);
  });

  it("keeps an empty table cell, which can be a gap to fill", () => {
    const root = page("<table><tr><td>Owner</td><td></td></tr></table>");

    expect(documentBlocks(root).map(({ text }) => text)).toEqual(["Owner", ""]);
  });

  it("reads a line break as a space, so words do not run together", () => {
    expect(documentBlocks(page("<p>One<br>two</p>"))[0].text).toBe("One two");
  });
});

describe("blanks", () => {
  const RULED = '<p>Between <span class="document-signature-line">\u00a0\u00a0\u00a0\u00a0</span> and the Manager.</p>';

  it("shows the model a blank drawn as a rule, which holds only spaces", () => {
    expect(documentBlocks(page(RULED))[0].text).toBe("Between ____ and the Manager.");
  });

  it("does not hide a blank someone has already written on", () => {
    const root = page('<p>Signed <span class="document-signature-line">Dana Reyes</span></p>');

    expect(documentBlocks(root)[0].text).toBe("Signed Dana Reyes");
  });

  it("writes the value onto the rule", () => {
    const root = page(RULED);

    applyDocumentPatch(documentBlocks(root), parseDocumentPatch("@@ 1\nBetween Willow Harbor and the Manager.\n@@ end"), mark);

    expect(root.querySelector("p")?.innerHTML).toBe(
      'Between <span class="document-ai-suggestion">Willow Harbor</span> and the Manager.',
    );
  });

  it("leaves a blank the reply did not fill", () => {
    const root = page(RULED);

    const result = applyDocumentPatch(documentBlocks(root), parseDocumentPatch("@@ 1\nBetween ____ and the Manager.\n@@ end"), mark);

    expect(result.changed).toBe(0);
    expect(root.querySelector(".document-signature-line")).not.toBeNull();
  });
});

describe("documentPatchPrompt", () => {
  const blocks = documentBlocks(page("<p>Effective ____ 2026.</p><table><tr><td></td></tr></table>"));
  const prompt = documentPatchPrompt({ documentTitle: "HOA PMA", instruction: "Fill in the gaps with fake data.", blocks });

  it("opens the way the server recognizes", () => {
    expect(prompt.startsWith(DOCUMENT_PATCH_PREFIX)).toBe(true);
  });

  it("shows every block under its number, and the instruction", () => {
    expect(prompt).toContain("[1] Effective ____ 2026.");
    expect(prompt).toContain("[2] (empty table cell)");
    expect(prompt).toContain("User instruction:\nFill in the gaps with fake data.");
    expect(prompt).toContain('titled "HOA PMA"');
  });

  it("carries the rules for filling blanks and inventing data", () => {
    expect(prompt).toContain("Invent realistic but clearly fictional values");
    expect(prompt).toContain("Fill each blank or placeholder");
  });
});

describe("parseDocumentPatch", () => {
  it("reads changes, insertions, and removals", () => {
    expect(
      parseDocumentPatch("@@ 2\nNew text.\n\n@@ after 2\nAn added paragraph.\n\n@@ delete 4\n\n@@ end"),
    ).toEqual([
      { kind: "replace", id: 2, text: "New text." },
      { kind: "after", id: 2, paragraphs: ["An added paragraph."] },
      { kind: "delete", id: 4 },
    ]);
  });

  it("ignores what a model says around the changes", () => {
    expect(parseDocumentPatch("Sure, here you go:\n\n```\n@@ 1\nNew.\n@@ end\n```\nLet me know!")).toEqual([
      { kind: "replace", id: 1, text: "New." },
    ]);
  });

  it("joins a change split over lines, and splits new paragraphs", () => {
    expect(parseDocumentPatch("@@ 1\nOne\ntwo\n@@ after 1\nFirst.\n\nSecond.\n@@ end")).toEqual([
      { kind: "replace", id: 1, text: "One two" },
      { kind: "after", id: 1, paragraphs: ["First.", "Second."] },
    ]);
  });

  it("reads a reply with nothing to change", () => {
    expect(parseDocumentPatch("@@ end")).toEqual([]);
  });

  it("refuses a reply cut off before its end, rather than half an edit", () => {
    expect(() => parseDocumentPatch("@@ 1\nNew text.\n@@ 2\nMore")).toThrow(DocumentPatchError);
  });

  it("refuses a reply that is not in the format", () => {
    expect(() => parseDocumentPatch("I changed the date for you.")).toThrow(DocumentPatchError);
  });

  it("drops the bold a model adds, which the runs do not need", () => {
    expect(parseDocumentPatch("@@ 1\nThe **fee** is ____.\n@@ end")).toEqual([
      { kind: "replace", id: 1, text: "The fee is ____." },
    ]);
  });
});

describe("applyDocumentPatch", () => {
  const apply = (root: HTMLElement, reply: string) => applyDocumentPatch(documentBlocks(root), parseDocumentPatch(reply), mark);

  it("changes only the changed words, so every run keeps its formatting", () => {
    const root = page('<p style="margin-left: 36pt"><strong>Fee:</strong> <em>ten</em> percent of revenue.</p>');

    const result = apply(root, "@@ 1\nFee: twelve percent of revenue.\n@@ end");

    expect(result.changed).toBe(1);
    const paragraph = root.querySelector("p") as HTMLElement;
    expect(paragraph.getAttribute("style")).toBe("margin-left: 36pt");
    expect(paragraph.querySelector("strong")?.textContent).toBe("Fee:");
    expect(paragraph.textContent).toBe("Fee: twelve percent of revenue.");
    expect(paragraph.querySelector(".document-ai-suggestion")?.textContent).toContain("twelve");
  });

  it("fills a blank inside the blank's own element", () => {
    const root = page('<p>Between <span class="document-blank">__________</span> and the Manager.</p>');

    apply(root, "@@ 1\nBetween Willow Harbor Owners Association and the Manager.\n@@ end");

    expect(root.querySelector(".document-blank")?.textContent).toContain("Willow Harbor");
    expect(root.textContent).toBe("Between Willow Harbor Owners Association and the Manager.");
  });

  it("leaves blocks the reply does not name exactly as they were", () => {
    const original = '<p style="text-align: center"><u>Heading</u></p>';
    const root = page(`${original}<p>Change me.</p>`);

    apply(root, "@@ 2\nChanged.\n@@ end");

    expect(root.querySelector("p")?.outerHTML).toBe(original);
  });

  it("rewrites a block that shares no shape with the reply, and keeps the block", () => {
    const root = page('<h2 class="document-title" style="color: red">A short heading</h2>');

    apply(root, "@@ 1\nSomething else entirely that is much longer than what was there before it, by a long way indeed.\n@@ end");

    const heading = root.querySelector("h2") as HTMLElement;
    expect(heading.className).toBe("document-title");
    expect(heading.getAttribute("style")).toBe("color: red");
    expect(heading.textContent).toContain("Something else entirely");
    expect(root.querySelector(".document-ai-suggestion")).not.toBeNull();
  });

  it("counts a rewrite as a change", () => {
    const root = page("<h2>A short heading</h2>");

    const result = apply(root, "@@ 1\nSomething else entirely that is much longer than what was there before it, by a long way indeed.\n@@ end");

    expect(result.changed).toBe(1);
  });

  it("does not count a difference only in quotation marks", () => {
    const root = page("<p>\u201cOwner\u201d means the Association.</p>");

    const result = apply(root, '@@ 1\n"Owner" means the Association.\n@@ end');

    expect(result.changed).toBe(0);
  });

  it("fills an empty table cell", () => {
    const root = page("<table><tr><td>Owner</td><td></td></tr></table>");

    apply(root, "@@ 2\nWillow Harbor\n@@ end");

    expect(root.querySelectorAll("td")[1].textContent).toBe("Willow Harbor");
  });

  it("adds a paragraph after a block, set like that block", () => {
    const root = page('<p style="margin-left: 18pt">Section one.</p><p>Section two.</p>');

    const result = apply(root, "@@ after 1\nA new clause.\n\nAnother clause.\n@@ end");

    expect(result.changed).toBe(1);
    const paragraphs = [...root.querySelectorAll("p")];
    expect(paragraphs.map((paragraph) => paragraph.textContent)).toEqual([
      "Section one.",
      "A new clause.",
      "Another clause.",
      "Section two.",
    ]);
    expect(paragraphs[1].getAttribute("style")).toBe("margin-left: 18pt");
    expect(paragraphs[1].querySelector(".document-ai-suggestion")).not.toBeNull();
  });

  it("adds to the cell, not beside it, when the block is a table cell", () => {
    const root = page("<table><tr><td>Fee</td></tr></table>");

    apply(root, "@@ after 1\nnet of tax\n@@ end");

    expect(root.querySelectorAll("td")).toHaveLength(1);
    expect(root.querySelector("td")?.textContent).toBe("Fee net of tax");
  });

  it("removes a block, and a list that empties with it", () => {
    const root = page("<p>Keep.</p><ul><li>Gone.</li></ul>");

    const result = apply(root, "@@ delete 2\n@@ end");

    expect(result.changed).toBe(1);
    expect(root.innerHTML).toBe("<p>Keep.</p>");
  });

  it("keeps a list that still has items", () => {
    const root = page("<ul><li>Gone.</li><li>Stays.</li></ul>");

    apply(root, "@@ delete 1\n@@ end");

    expect(root.innerHTML).toBe("<ul><li>Stays.</li></ul>");
  });

  it("clears a cell rather than break its table", () => {
    const root = page("<table><tr><td>One</td><td>Two</td></tr></table>");

    apply(root, "@@ delete 1\n@@ end");

    expect(root.querySelectorAll("td")).toHaveLength(2);
    expect(root.querySelectorAll("td")[0].textContent).toBe("");
  });

  it("tells each change apart, however many runs it touched", () => {
    const root = page("<p><b>One</b> two.</p><p>Three.</p>");
    const seen: number[] = [];

    applyDocumentPatch(documentBlocks(root), parseDocumentPatch("@@ 1\nUno dos.\n@@ 2\nTres.\n@@ end"), (content, order) => {
      seen.push(order);
      return mark(content);
    });

    expect(new Set(seen)).toEqual(new Set([0, 1]));
  });

  it("counts nothing when the reply matches the document", () => {
    const root = page("<p>Same words.</p>");

    expect(apply(root, "@@ 1\nSame words.\n@@ end").changed).toBe(0);
  });

  it("skips a block number the document does not have, and says so", () => {
    const root = page("<p>Only block.</p>");

    const result = apply(root, "@@ 9\nInvented.\n@@ end");

    expect(result).toEqual({ changed: 0, skipped: 1 });
    expect(root.textContent).toBe("Only block.");
  });

  it("applies every change to the block it named, whatever order they come in", () => {
    const root = page("<p>One.</p><p>Two.</p><p>Three.</p>");

    apply(root, "@@ delete 1\n@@ 3\nThree changed.\n@@ after 2\nInserted.\n@@ end");

    expect([...root.querySelectorAll("p")].map((paragraph) => paragraph.textContent)).toEqual([
      "Two.",
      "Inserted.",
      "Three changed.",
    ]);
  });
});
