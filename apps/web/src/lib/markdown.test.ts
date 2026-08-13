import { expect, test } from "vitest";
import {
  isMermaidBlock,
  isVisualDiagramBlock,
  markdownToDocumentHtml,
  markdownToPlainText,
  mermaidDiagramSource,
  parseMarkdownBlocks,
  replaceDiagramFence,
  unwrapFullDocumentFence,
} from "./markdown";

test("a reply wrapped entirely in a code fence renders as a document, not a code block", () => {
  const reply = "```markdown\n# Memo\n\n**To:** All Staff\n\nBody paragraph.\n```";
  const html = markdownToDocumentHtml(reply);
  expect(html).toContain("<h1>Memo</h1>");
  expect(html).toContain("<strong>To:</strong>");
  expect(html).not.toContain("document-code-block");
});

test("inner code fences are preserved when the reply is not fully fenced", () => {
  const reply = "# Notes\n\n```python\nprint('hi')\n```\n\nAfter.";
  const html = markdownToDocumentHtml(reply);
  expect(html).toContain("document-code-block");
  expect(html).toContain("print('hi')");
});

test("pipe tables render as editable document tables", () => {
  const reply = "| Phase | Owner |\n|---|---|\n| Intake | Taylor |\n| Review | Legal |";
  const html = markdownToDocumentHtml(reply);
  expect(html).toContain('<table class="document-data-table">');
  expect(html).toContain("<th>Phase</th>");
  expect(html).toContain("<td>Taylor</td>");
  expect(html).not.toContain("|---|---|");
});

test("unwrapFullDocumentFence leaves replies containing nested fences alone", () => {
  const reply = "```\nouter\n```python\ninner\n```\n```";
  expect(unwrapFullDocumentFence(reply)).toBe(reply);
});

test("unwrapFullDocumentFence does not unwrap a reply that is only a diagram fence", () => {
  const mermaid = "```mermaid\ntimeline\n    1989 : Cold fusion announced\n```";
  expect(unwrapFullDocumentFence(mermaid)).toBe(mermaid);
  const tagged = "```timeline\n1989 : Cold fusion announced\n```";
  expect(unwrapFullDocumentFence(tagged)).toBe(tagged);
});

test("preserves underscores and query strings inside document hyperlinks", () => {
  const url = "https://example.com/crew_portrait_file?source=draft_view";
  const html = markdownToDocumentHtml(`[Crew source](${url})`);

  expect(html).toContain(`href="${url.replace("&", "&amp;")}"`);
  expect(html).not.toContain("<em>portrait");
  expect(markdownToPlainText(`[Crew source](${url})`)).toContain(url);
});

test("renders protected root-relative document links", () => {
  const html = markdownToDocumentHtml(
    "[Preserved citation](/api/drafts/preserved-assets/link-1)",
  );

  expect(html).toContain('href="/api/drafts/preserved-assets/link-1"');
});

test("inline markdown images render inside document tables", () => {
  const reply =
    "| France | Argentina |\n|---|---|\n| ![Kylian Mbappé](https://example.com/mbappe.jpg) | ![Lionel Messi](https://example.com/messi.jpg) |";
  const html = markdownToDocumentHtml(reply);
  expect(html).toContain(
    '<img class="document-inline-image" src="https://example.com/mbappe.jpg" alt="Kylian Mbappé">',
  );
  expect(html).not.toContain("![Kylian");
});

test("plain text export describes inline images instead of dropping them", () => {
  const text = markdownToPlainText(
    "Star: ![Lionel Messi](https://example.com/messi.jpg) decides finals",
  );
  expect(text).toContain("[Image: Lionel Messi] https://example.com/messi.jpg");
});

test("double-dollar and bracket display blocks parse as math with source preserved", () => {
  const blocks = parseMarkdownBlocks("$$E = mc^2$$\n\n\\[\n\\frac{a}{b}\n\\]");
  expect(blocks).toEqual([
    { kind: "math", source: "$$E = mc^2$$", math: "E = mc^2" },
    { kind: "math", source: "\\[\n\\frac{a}{b}\n\\]", math: "\\frac{a}{b}" },
  ]);
});

test("multi-line double-dollar blocks close on a bare $$ line", () => {
  const blocks = parseMarkdownBlocks("$$\nx^2 + y^2 = z^2\n$$");
  expect(blocks).toEqual([
    { kind: "math", source: "$$\nx^2 + y^2 = z^2\n$$", math: "x^2 + y^2 = z^2" },
  ]);
});

test("display math containing pipes never becomes a table", () => {
  const blocks = parseMarkdownBlocks("$$|a| + |b| = c$$");
  expect(blocks).toEqual([{ kind: "math", source: "$$|a| + |b| = c$$", math: "|a| + |b| = c" }]);
});

test("single-dollar amounts and unterminated openers stay prose", () => {
  const blocks = parseMarkdownBlocks("The deal is $5M or $6M.\n\n$$x + 1\nnever closed");
  expect(blocks).toEqual([
    { kind: "paragraph", lines: ["The deal is $5M or $6M."] },
    { kind: "paragraph", lines: ["$$x + 1", "never closed"] },
  ]);
});

test("document HTML and plain text keep display math as honest source", () => {
  expect(markdownToDocumentHtml("$$E = mc^2$$")).toBe("<p>$$E = mc^2$$</p>");
  expect(markdownToPlainText("$$E = mc^2$$")).toBe("$$E = mc^2$$");
});

test("mermaid fences become document diagram figures without mermaid source text", () => {
  const html = markdownToDocumentHtml("# Bracket\n\n```mermaid\nflowchart LR\n  A --> B\n```");
  expect(html).toContain('class="document-media-block document-diagram-figure"');
  expect(html).toContain(`data-diagram-source="${encodeURIComponent("flowchart LR\n  A --> B")}"`);
  expect(html).toContain("document-diagram-pending");
  expect(html).not.toContain("document-diagram-source");
  expect(html).not.toContain(">flowchart LR");
  expect(markdownToDocumentHtml("```python\nprint('hi')\n```")).not.toContain(
    "document-diagram-figure",
  );
});

test("timeline language tags and plantuml fences are diagram figures, not code", () => {
  expect(isMermaidBlock("timeline", "1989 : Cold fusion announced")).toBe(true);
  expect(mermaidDiagramSource("1989 : Cold fusion announced", "timeline")).toBe(
    "timeline\n1989 : Cold fusion announced",
  );
  expect(isVisualDiagramBlock("plantuml", "@startuml\nA --> B\n@enduml")).toBe(true);
  const html = markdownToDocumentHtml("```timeline\n1989 : Cold fusion announced\n```");
  expect(html).toContain("document-diagram-figure");
  expect(html).toContain("document-diagram-pending");
  expect(html).not.toContain("1989 : Cold fusion announced");
});

test("replaceDiagramFence swaps only the matching diagram block", () => {
  const content = [
    "Intro prose.",
    "",
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
    "",
    "```python",
    "print('hi')",
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    "  C --> D",
    "```",
  ].join("\n");
  const next = replaceDiagramFence(content, "flowchart LR\n  C --> D", "flowchart LR\n  C --> E");
  expect(next).toContain("  C --> E");
  expect(next).toContain("  A --> B");
  expect(next).toContain("print('hi')");
  expect(next).not.toContain("C --> D");
});

test("replaceDiagramFence matches untagged mermaid fences and stripped language lines", () => {
  const untagged = "```\nflowchart TD\n  A --> B\n```";
  expect(replaceDiagramFence(untagged, "flowchart TD\n  A --> B", "flowchart TD\n  A --> C")).toContain("A --> C");
  const repeated = "```mermaid\nmermaid\nflowchart TD\n  A --> B\n```";
  expect(replaceDiagramFence(repeated, "flowchart TD\n  A --> B", "flowchart TD\n  A --> C")).toContain("A --> C");
});

test("replaceDiagramFence returns null when nothing matches", () => {
  expect(replaceDiagramFence("no diagrams here", "flowchart LR\n  A --> B", "x")).toBeNull();
  expect(replaceDiagramFence("```mermaid\nflowchart LR\n  A --> B\n```", "flowchart LR\n  Z --> Q", "x")).toBeNull();
});

test("steward-diagram fences become structure diagram figures in documents", () => {
  const body = '{"rows": [[{"id": "a", "title": "Box A"}]], "edges": []}';
  const html = markdownToDocumentHtml(`# Plan\n\n\`\`\`steward-diagram\n${body}\n\`\`\``);
  expect(html).toContain('class="document-media-block document-diagram-figure"');
  expect(html).toContain('data-diagram-kind="structure"');
  expect(html).toContain(`data-diagram-source="${encodeURIComponent(body)}"`);
  expect(html).toContain("document-diagram-pending");
  expect(html).not.toContain("document-diagram-source");
  expect(markdownToDocumentHtml("```json\n{}\n```")).not.toContain("data-diagram-kind");
});
