import { expect, test } from "vitest";
import { formatPreservingPreviewHtml, planFormatPreservingEdit } from "./inlineAiPatch";

const TAB = (stop: number, width: number) =>
  `<span class="document-tab document-tab-left document-tab-at-${stop}" style="display: inline-block; width: ${width}px">\t</span>`;

/** The shape of a numbered clause opened from Word: tab stops around the
 * number, an underlined caption, and underscore blanks to fill in. */
const CLAUSE_HTML =
  `<p style="text-align: justify; font-size: 13px">${TAB(720, 48)}4.1${TAB(1440, 36)}<u>SITE DESCRIPTION:</u> &nbsp;` +
  `The site leased under this Lease is known as <span class="document-blank">______________________</span> ` +
  `and holds <span class="document-blank">_____</span> units, managed by ` +
  `<span class="document-blank">______________</span>Holdings LLC.</p>`;

function editorWith(html: string) {
  const editor = document.createElement("div");
  editor.innerHTML = html;
  document.body.appendChild(editor);
  return editor;
}

function wholeRange(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range;
}

function markWith(className = "document-ai-suggestion") {
  return (content: DocumentFragment) => {
    const mark = document.createElement("span");
    mark.className = className;
    mark.appendChild(content);
    return mark;
  };
}

test("filling blanks from a plain-text reply keeps every tab stop, underline, and style", () => {
  const editor = editorWith(CLAUSE_HTML);
  const paragraph = editor.querySelector("p")!;
  // What a model returns when it ignores the markup: the clause as plain text.
  const reply =
    "4.1 SITE DESCRIPTION: The site leased under this Lease is known as Juniper Point Commons and holds 96 units, managed by Juniper Point Holdings LLC.";
  const plan = planFormatPreservingEdit(editor, wholeRange(paragraph), reply);
  expect(plan?.changes).toBe(3);
  const marks = plan!.apply(markWith());

  expect(marks.map((mark) => mark.textContent)).toEqual(["Juniper Point Commons", "96", "Juniper Point"]);
  expect(paragraph.getAttribute("style")).toBe("text-align: justify; font-size: 13px");
  expect(paragraph.querySelectorAll(".document-tab")).toHaveLength(2);
  expect(paragraph.querySelector("u")?.textContent).toBe("SITE DESCRIPTION:");
  // Each value lands inside its own blank, so the filled field keeps the
  // blank's styling, and the space the model put after the last value sits
  // outside the blank.
  expect(Array.from(paragraph.querySelectorAll(".document-blank")).map((blank) => blank.textContent)).toEqual([
    "Juniper Point Commons",
    "96",
    "Juniper Point",
  ]);
  expect(paragraph.textContent).toBe(
    "\t4.1\tSITE DESCRIPTION:  The site leased under this Lease is known as Juniper Point Commons and holds 96 units, managed by Juniper Point Holdings LLC.",
  );
  expect(paragraph.innerHTML).not.toContain("_");
});

test("a reply that mirrors the markup lands the same way", () => {
  const editor = editorWith(CLAUSE_HTML);
  const paragraph = editor.querySelector("p")!;
  const reply =
    '<p style="text-align: justify"><span class="document-tab">\t</span>4.1<span class="document-tab">\t</span><u>SITE DESCRIPTION:</u> The site leased under this Lease is known as <span class="document-blank">Juniper Point Commons</span> and holds <span class="document-blank">96</span> units, managed by <span class="document-blank">Juniper Point </span>Holdings LLC.</p>';
  const plan = planFormatPreservingEdit(editor, wholeRange(paragraph), reply);
  plan!.apply(markWith());
  expect(paragraph.querySelectorAll(".document-tab")).toHaveLength(2);
  expect(paragraph.querySelectorAll(".document-blank .document-blank")).toHaveLength(0);
  expect(paragraph.textContent).toContain("managed by Juniper Point Holdings LLC.");
  expect(paragraph.querySelector("u")?.textContent).toBe("SITE DESCRIPTION:");
});

test("a filled ruled line becomes the value, and removed words leave no double space", () => {
  const editor = editorWith(
    '<p>Signed by <strong>the Tenant</strong>: <span class="document-signature-line">    </span> on the very first day.</p>',
  );
  const paragraph = editor.querySelector("p")!;
  const plan = planFormatPreservingEdit(editor, wholeRange(paragraph), "Signed by the Tenant: Dana Reyes on the first day.");
  plan!.apply(markWith());
  expect(paragraph.querySelector(".document-signature-line")).toBeNull();
  expect(paragraph.querySelector("strong")?.textContent).toBe("the Tenant");
  expect(paragraph.textContent).toBe("Signed by the Tenant: Dana Reyes on the first day.");
});

test("new words keep emphasis the model gave them, untouched words keep theirs", () => {
  const editor = editorWith("<p>The <em>ship</em> crossed the stars.</p>");
  const paragraph = editor.querySelector("p")!;
  const plan = planFormatPreservingEdit(
    editor,
    wholeRange(paragraph),
    "<p>The <strong>ship</strong> crossed <strong>deep space</strong> safely.</p>",
  );
  plan!.apply(markWith());
  // "ship" was not changed, so it stays italic and does not turn bold.
  expect(paragraph.querySelector("em")?.textContent).toBe("ship");
  expect(paragraph.querySelector("em strong")).toBeNull();
  expect(paragraph.querySelector(".document-ai-suggestion strong")?.textContent).toBe("deep space");
  expect(paragraph.textContent).toBe("The ship crossed deep space safely.");
});

test("a rewrite across runs gives each run its share, mirrored or in proportion", () => {
  const editor = editorWith("<p><u>Project scope:</u> the work covers three buildings.</p>");
  const paragraph = editor.querySelector("p")!;
  const plan = planFormatPreservingEdit(
    editor,
    wholeRange(paragraph),
    "Alcance del proyecto: el trabajo cubre tres edificios.",
  );
  plan!.apply(markWith());
  expect(paragraph.querySelector("u")?.textContent).toBe("Alcance del proyecto:");
  expect(paragraph.textContent).toBe("Alcance del proyecto: el trabajo cubre tres edificios.");
});

test("structural and summary replies are left to the structural path", () => {
  const editor = editorWith(
    "<p>One long paragraph about the lease terms, the rent schedule, the deposit, and the renewal option for the tenant.</p>",
  );
  const paragraph = editor.querySelector("p")!;
  expect(planFormatPreservingEdit(editor, wholeRange(paragraph), "<p>Lease terms.</p><p>Rent schedule.</p>")).toBeNull();
  expect(planFormatPreservingEdit(editor, wholeRange(paragraph), "A summary of renewal.")).toBeNull();
});

test("an unchanged reply plans no changes, quotes included", () => {
  const editor = editorWith("<p>The “Project” stays as written.</p>");
  const paragraph = editor.querySelector("p")!;
  const plan = planFormatPreservingEdit(editor, wholeRange(paragraph), 'The "Project" stays as written.');
  expect(plan?.changes).toBe(0);
});

test("a partial highlight only edits its own words", () => {
  const editor = editorWith("<p>Keep this. Rent is <b>due</b> monthly. Keep that.</p>");
  const paragraph = editor.querySelector("p")!;
  const text = paragraph.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, text.data.indexOf("Rent"));
  range.setEnd(paragraph.lastChild as Text, " monthly.".length);
  const plan = planFormatPreservingEdit(editor, range, "Rent is due weekly.");
  plan!.apply(markWith());
  expect(paragraph.textContent).toBe("Keep this. Rent is due weekly. Keep that.");
  expect(paragraph.querySelector("b")?.textContent).toBe("due");
});

test("the review preview shows the result with the original formatting", () => {
  const editor = editorWith(CLAUSE_HTML);
  const paragraph = editor.querySelector("p")!;
  const html = formatPreservingPreviewHtml(
    wholeRange(paragraph),
    "4.1 SITE DESCRIPTION: The site leased under this Lease is known as Juniper Point Commons and holds 96 units, managed by Juniper Point Holdings LLC.",
  );
  const preview = document.createElement("div");
  preview.innerHTML = html ?? "";
  expect(preview.querySelector("u")?.textContent).toBe("SITE DESCRIPTION:");
  expect(preview.querySelectorAll(".ai-composer-new")).toHaveLength(3);
  // The page itself is untouched until the writer accepts.
  expect(paragraph.innerHTML).toContain("______________________");
});

test("filled blanks around kept words leave those words alone", () => {
  const editor = editorWith(
    '<p>dated as of <span class="document-blank">__________</span> (the “Original <span class="document-blank">______</span>Agreement”), by and among <span class="document-blank">________</span>Holdings LLC.</p>',
  );
  const paragraph = editor.querySelector("p")!;
  const plan = planFormatPreservingEdit(
    editor,
    wholeRange(paragraph),
    "dated as of March 1, 2026 (the “Original Juniper Point Agreement”), by and among Juniper Point Holdings LLC.",
  );
  const marks = plan!.apply(markWith());
  expect(marks.map((mark) => mark.textContent)).toEqual(["March 1, 2026", "Juniper Point", "Juniper Point"]);
  expect(paragraph.textContent).toBe(
    "dated as of March 1, 2026 (the “Original Juniper Point Agreement”), by and among Juniper Point Holdings LLC.",
  );
});

test("a reply that lost a tab stop does not pull the clause number into the caption", () => {
  const editor = editorWith(CLAUSE_HTML);
  const paragraph = editor.querySelector("p")!;
  const plan = planFormatPreservingEdit(
    editor,
    wholeRange(paragraph),
    "4.1SITE DESCRIPTION: The site leased under this Lease is known as Juniper Point Commons and holds 96 units, managed by Juniper Point Holdings LLC.",
  );
  plan!.apply(markWith());
  expect(paragraph.querySelector("u")?.textContent).toBe("SITE DESCRIPTION:");
  expect(paragraph.querySelectorAll(".document-tab")).toHaveLength(2);
  expect(paragraph.textContent?.startsWith("\t4.1\tSITE DESCRIPTION:")).toBe(true);
});
