import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import mermaid from "mermaid";
import { Markdown } from "./Markdown";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn().mockResolvedValue(true),
    render: vi
      .fn()
      .mockResolvedValue({ svg: '<svg viewBox="0 0 120 60" data-testid="mermaid-svg"></svg>' }),
  },
}));

function restoreMermaidMock() {
  vi.mocked(mermaid.parse).mockResolvedValue(true);
  vi.mocked(mermaid.render).mockResolvedValue({
    svg: '<svg viewBox="0 0 120 60" data-testid="mermaid-svg"></svg>',
  });
}

test("code blocks expose copy, preview, line numbers, and inline editing", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });

  render(
    <Markdown
      content={`Here is the artifact:\n\n\`\`\`html\n<h1>Old title</h1>\n<button>Run</button>\n\`\`\``}
    />,
  );

  expect(screen.queryByRole("dialog", { name: "Artifact preview" })).not.toBeInTheDocument();
  expect(screen.getByText("html")).toBeInTheDocument();
  expect(screen.getByText("2 lines")).toBeInTheDocument();
  expect(screen.getByText("1")).toBeInTheDocument();
  expect(screen.getByText("2")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "Editable html code" });
  fireEvent.change(editor, { target: { value: "<h1>New title</h1>\n<button>Run</button>" } });

  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("<h1>New title</h1>\n<button>Run</button>"));

  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  const dialog = screen.getByRole("dialog", { name: "Artifact preview" });
  expect(within(dialog).getByTitle("html artifact preview")).toBeInTheDocument();
  expect(within(dialog).getByText(/HTML/)).toBeInTheDocument();
});

test("mermaid code fences render as diagrams with copy and export actions", async () => {
  render(<Markdown content={"```mermaid\nflowchart LR\n  A --> B\n```"} />);

  expect(document.querySelector(".md-diagram-panel")).toBeInTheDocument();
  expect(document.querySelector(".md-diagram-canvas")).toBeInTheDocument();
  expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "PNG" })).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "SVG" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
  expect(document.querySelector(".md-code-panel")).toBeNull();
  expect(screen.getByText("flowchart")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Code" }));
  expect(screen.getByText("flowchart LR")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Diagram" }));
  await waitFor(() => expect(screen.queryByText("flowchart LR")).not.toBeInTheDocument());
});

test("mermaid timeline fences auto-preview as diagrams, not code panels", async () => {
  render(
    <Markdown
      content={
        "```mermaid\ntimeline\n    title Figure 6. Selected international and Chinese LENR milestones\n    1989 : Fleischmann and Pons announce cold fusion\n```"
      }
    />,
  );

  await waitFor(() => expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument());
  expect(screen.getByText("timeline")).toBeInTheDocument();
  expect(document.querySelector(".md-diagram-panel")).toBeInTheDocument();
  expect(document.querySelector(".md-diagram-canvas")).toBeInTheDocument();
  expect(document.querySelector(".md-code-panel")).toBeNull();
  expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
});

test("a mermaid render failure stays a diagram panel with a visual, not a code panel", async () => {
  vi.mocked(mermaid.render).mockRejectedValue(new Error("Parse error on line 2"));
  try {
    render(<Markdown content={"```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```"} />);
    expect(document.querySelector(".md-diagram-panel")).toBeInTheDocument();
    expect(document.querySelector(".md-diagram-canvas svg")).toBeInTheDocument();
    expect(screen.getByText("Start")).toBeInTheDocument();
    expect(screen.getByText("End")).toBeInTheDocument();
    expect(document.querySelector(".md-code-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument();
  } finally {
    restoreMermaidMock();
  }
});

test("a mermaid timeline still shows a visual when mermaid.js cannot draw it", async () => {
  vi.mocked(mermaid.render).mockRejectedValue(new Error("CSSStyleSheet is not defined"));
  try {
    render(
      <Markdown
        content={"```mermaid\ntimeline\n    title Selected LENR milestones\n    1989 : Cold fusion announced\n```"}
      />,
    );
    expect(document.querySelector(".md-diagram-canvas svg")).toBeInTheDocument();
    expect(screen.getByText("Selected LENR milestones")).toBeInTheDocument();
    expect(document.querySelector(".md-code-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
  } finally {
    restoreMermaidMock();
  }
});

const LENR_TIMELINE_FENCE = `\`\`\`mermaid
timeline
title Figure 6. Selected international and Chinese LENR milestones
1989 : Fleischmann and Pons announce cold fusion
: Worldwide replication campaign begins
: First US DOE review is negative
1990 : Tsinghua team reports precursor studies
1991 : Miles reports helium measurements in US Navy work
1990s : Japanese New Hydrogen Energy programme
: Continued US, Italian, Russian and Indian studies
2002 : ICCF-9 held at Tsinghua University in Beijing
: Chinese resonant-tunnelling papers presented
2004 : Second US DOE review remains inconclusive
2008 : Jiang team reports very-low-rate charged particles
2009 : CR-39 triple-track paper published internationally
2014 : China Institute team reports neutron bursts
2015 : Chinese Ni-H translated heat reports circulate
2019 : Google-supported Nature review reports no effect
2020 : NASA reports accelerator-assisted lattice fusion
: EU CleanHME project begins
2023 : US ARPA-E funds eight LENR test projects
2025 : CleanHME project ends
: Nature reports electrochemically enhanced beam fusion
2026 : Chinese LENR authors continue specialist-journal theory
\`\`\``;

test("the reported LENR timeline fence is a visual figure, never a mermaid code panel", () => {
  vi.mocked(mermaid.render).mockRejectedValue(new Error("Parse error on line 3"));
  try {
    render(<Markdown content={LENR_TIMELINE_FENCE} />);
    const panel = document.querySelector("figure.md-diagram-panel");
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("data-diagram-type", "timeline");
    expect(document.querySelector(".md-diagram-canvas svg")).toBeInTheDocument();
    expect(screen.getByText("Figure 6. Selected international and Chinese LENR milestones")).toBeInTheDocument();
    expect(screen.getByText("Fleischmann and Pons announce cold fusion")).toBeInTheDocument();
    const canvas = document.querySelector(".md-diagram-canvas")?.innerHTML ?? "";
    expect(canvas).toContain("specialist-journal");
    expect(canvas).toContain("2026");
    expect(document.querySelector("figure.md-code-panel")).toBeNull();
    expect(screen.queryByText("23 lines")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument();
  } finally {
    restoreMermaidMock();
  }
});

test("mermaid renders as a diagram for every fence variant models emit", async () => {
  const variants = [
    // Alias language tag.
    "```mmd\nsequenceDiagram\n  A->>B: hi\n```",
    // Info string after the language.
    '```mermaid {init: {"theme":"base"}}\nflowchart TD\n  A --> B\n```',
    // Untagged fence whose content opens with Mermaid grammar.
    "```\nflowchart LR\n  A --> B\n```",
    // Language tag repeated as the first line inside the block.
    "```text\nmermaid\npie\n  \"A\": 60\n  \"B\": 40\n```",
  ];
  for (const content of variants) {
    const { unmount } = render(<Markdown content={content} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "PNG" })).toBeInTheDocument());
    unmount();
  }
});

test("preview mode renders only a first-page budget of complete rich blocks", () => {
  render(
    <Markdown
      preview
      content={
        "## Overview\n" +
        "A compact introduction.\n\n" +
        "```mermaid\nflowchart LR\n  A --> B\n```\n\n" +
        "```mermaid\nflowchart LR\n  C --> D\n```\n\n" +
        "```mermaid\nflowchart LR\n  E --> F\n```\n\n" +
        "```mermaid\nflowchart LR\n  G --> H\n```"
      }
    />,
  );

  expect(document.querySelectorAll(".md-diagram-panel")).toHaveLength(2);
});

test("conversation preview mode can render every complete rich block", () => {
  render(
    <Markdown
      preview
      previewPageLimit={false}
      content={
        "```mermaid\nflowchart LR\n  A --> B\n```\n\n" +
        "```mermaid\nflowchart LR\n  C --> D\n```\n\n" +
        "```mermaid\nflowchart LR\n  E --> F\n```\n\n" +
        "```mermaid\nflowchart LR\n  G --> H\n```"
      }
    />,
  );

  expect(document.querySelectorAll(".md-diagram-panel")).toHaveLength(4);
});

test("explicitly tagged non-mermaid code keeps the plain code panel", () => {
  render(<Markdown content={'```python\ngraph = "TD not a diagram"\n```'} />);
  expect(screen.getByText("python")).toBeInTheDocument();
  expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();
});

test("display math blocks render through KaTeX for $$ and \\[ delimiters", () => {
  render(<Markdown content={"Einstein wrote:\n\n$$E = mc^2$$\n\n\\[\na^2 + b^2 = c^2\n\\]"} />);

  expect(document.querySelectorAll(".md-katex-block .katex")).toHaveLength(2);
  // The delimited source never shows alongside a successful render.
  expect(screen.queryByText("$$E = mc^2$$")).not.toBeInTheDocument();
  expect(screen.getByText("Einstein wrote:")).toBeInTheDocument();
});

test("inline \\(...\\) math renders through KaTeX inside prose", () => {
  render(<Markdown content={"The area is \\(\\pi r^2\\) exactly."} />);

  expect(document.querySelector(".md-katex-inline .katex")).not.toBeNull();
  expect(screen.getByText(/exactly\./)).toBeInTheDocument();
  expect(screen.queryByText(/\\\(/)).not.toBeInTheDocument();
});

test("single-dollar finance text is never treated as math", () => {
  render(<Markdown content={"The deal is $5M with an option for $2M more."} />);

  expect(screen.getByText("The deal is $5M with an option for $2M more.")).toBeInTheDocument();
  expect(document.querySelector(".md-katex")).toBeNull();
});

test("unparseable math preserves the original source text instead of crashing", () => {
  render(<Markdown content={"$$\\notacommand{x$$\n\nAnd inline \\(\\alsobroken{\\) too."} />);

  expect(screen.getByText("$$\\notacommand{x$$")).toBeInTheDocument();
  expect(screen.getByText(/And inline \\\(\\alsobroken\{\\\) too\./)).toBeInTheDocument();
  expect(document.querySelector(".md-katex")).toBeNull();
});

test("citation tokens render as superscript chips without renumbering", () => {
  render(<Markdown content={"Revenue grew 40% [K2] while churn fell [U1]."} />);

  const knowledge = screen.getByTitle("Source K2");
  expect(knowledge.tagName).toBe("SUP");
  expect(knowledge).toHaveClass("md-cite-marker");
  expect(knowledge).toHaveAttribute("data-cite-index", "K2");
  expect(knowledge).toHaveTextContent("K2");

  const upload = screen.getByTitle("Source U1");
  expect(upload).toHaveClass("md-cite-marker");
  expect(upload).toHaveAttribute("data-cite-index", "U1");
});

test("plain bracket text that is not a citation token renders unchanged", () => {
  render(<Markdown content={"See [Note] plus [K0] and [K100] for context."} />);

  expect(screen.getByText(/See \[Note\] plus \[K0\] and \[K100\] for context\./)).toBeInTheDocument();
  expect(document.querySelector(".md-cite-marker")).toBeNull();
});

test("markdown images inside table cells render inline and broken images disappear", () => {
  render(
    <Markdown
      content={"| France | Argentina |\n|---|---|\n| ![Kylian Mbappé](https://example.com/mbappe.jpg) | ![Lionel Messi](https://example.com/messi.jpg) |"}
    />,
  );

  const image = screen.getByAltText("Lionel Messi");
  expect(image).toHaveAttribute("src", "https://example.com/messi.jpg");
  expect(screen.getByAltText("Kylian Mbappé")).toBeInTheDocument();

  fireEvent.error(image);
  expect(screen.queryByAltText("Lionel Messi")).not.toBeInTheDocument();
  expect(screen.getByAltText("Kylian Mbappé")).toBeInTheDocument();
});

test("generated image download links keep existing query tokens intact", () => {
  render(
    <Markdown
      content={
        "![Signed chart](/api/chat/generated-images/img-signed.png?token=abc123)\n\n![Plain chart](/api/chat/generated-images/img-plain.png)"
      }
    />,
  );

  expect(screen.getByRole("link", { name: "Download Signed chart" })).toHaveAttribute(
    "href",
    "/api/chat/generated-images/img-signed.png?token=abc123&download=1",
  );
  expect(screen.getByRole("link", { name: "Download Plain chart" })).toHaveAttribute(
    "href",
    "/api/chat/generated-images/img-plain.png?download=1",
  );
});

test("diagrams offer a box-level editor that saves the rewritten source", async () => {
  const onUpdateDiagram = vi.fn().mockResolvedValue(true);
  render(
    <Markdown
      content={'```mermaid\nflowchart LR\n  A["Credit Shelter Trust"]\n  B["Four children"]\n  A --> B\n```'}
      onUpdateDiagram={onUpdateDiagram}
    />,
  );

  await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));

  const dialog = screen.getByRole("dialog", { name: "Edit diagram" });
  const title = within(dialog).getByRole("textbox", { name: "Title for box A" });
  expect(title).toHaveValue("Credit Shelter Trust");
  fireEvent.change(title, { target: { value: "Shelter Trust" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete box Four children" }));

  const save = within(dialog).getByRole("button", { name: "Save diagram" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);

  await waitFor(() => expect(onUpdateDiagram).toHaveBeenCalledTimes(1));
  const [previousSource, nextSource] = onUpdateDiagram.mock.calls[0];
  expect(previousSource).toContain('A["Credit Shelter Trust"]');
  expect(nextSource).toContain('A["Shelter Trust"]');
  expect(nextSource).not.toContain("Four children");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Edit diagram" })).not.toBeInTheDocument(),
  );
});

test("diagrams without an update callback show no Edit action", async () => {
  render(<Markdown content={"```mermaid\nflowchart LR\n  A --> B\n```"} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "PNG" })).toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
});

test("steward-diagram fences render the structure chart with a card editor", async () => {
  const onUpdateDiagram = vi.fn().mockResolvedValue(true);
  const body = JSON.stringify({
    title: "Estate Plan",
    rows: [
      [{ id: "bryan", title: "ALDEN HARLAN", variant: "banner" }],
      [{ id: "brt", title: "Revocable Trust", bullets: ["Settlor: Alden"], footer: { text: "SUBJECT TO ESTATE TAX", tone: "neutral" } }],
    ],
    edges: [{ from: "bryan", to: "brt", kind: "primary" }],
  });
  render(<Markdown content={`\`\`\`steward-diagram\n${body}\n\`\`\``} onUpdateDiagram={onUpdateDiagram} />);

  expect(screen.getByText("structure")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Estate Plan" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit diagram" });
  const title = within(dialog).getByRole("textbox", { name: "Title for box brt" });
  fireEvent.change(title, { target: { value: "Alden Revocable Trust (2017)" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save diagram" }));

  await waitFor(() => expect(onUpdateDiagram).toHaveBeenCalledTimes(1));
  const [previousSource, nextSource] = onUpdateDiagram.mock.calls[0];
  expect(previousSource).toBe(body);
  expect(JSON.parse(nextSource).rows[1][0].title).toBe("Alden Revocable Trust (2017)");
});

test("JSON or real YAML diagram data renders as a diagram under generic fences", async () => {
  const body = JSON.stringify({
    title: "Deal Structure",
    rows: [[{ id: "holdco", title: "HoldCo", bullets: ["Delaware"] }]],
  });
  for (const tag of ["yaml", "yml", "json"]) {
    const { unmount } = render(<Markdown content={`\`\`\`${tag}\n${body}\n\`\`\``} />);
    expect(screen.getByRole("img", { name: "Deal Structure" })).toBeInTheDocument();
    unmount();
  }

  const yaml = `title: YAML Deal Structure
rows:
  - cards:
      - id: holdco
        title: HoldCo
        bullets:
          - Delaware`;
  const { unmount } = render(<Markdown content={`\`\`\`yaml\n${yaml}\n\`\`\``} />);
  expect(screen.getByRole("img", { name: "YAML Deal Structure" })).toBeInTheDocument();
  expect(document.querySelector(".md-code-panel")).toBeNull();
  unmount();

  // Same for a Mermaid diagram under a yaml fence.
  render(<Markdown content={"```yaml\nflowchart LR\n  A --> B\n```"} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "PNG" })).toBeInTheDocument());
});

test("research-status JSON is always rendered as a visual summary, never a code panel", () => {
  const body = JSON.stringify(
    {
      search_completed: "2026-08-29",
      literal_complete_human_organ_cloning: "not achieved",
      routine_complete_bioprinted_organ_transplantation: "not achieved",
      established_research: [
        "organoids",
        "patient-derived disease models",
        "stem-cell differentiation",
        "small engineered tissues",
        "preclinical bioprinting",
      ],
      human_clinical_evaluation: [
        "stem-cell-derived islets",
        "retinal sheets",
        "engineered cardiac muscle",
        "intestinal epithelial grafts",
      ],
      remaining_gap: ["whole-organ vascularization", "long-term transplant survival"],
    },
    null,
    2,
  );

  render(<Markdown content={`\`\`\`json\n${body}\n\`\`\``} />);

  expect(document.querySelector('[data-diagram-type="structured-summary"]')).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Research status summary" })).toBeInTheDocument();
  expect(screen.getByText("Human clinical evaluation")).toBeInTheDocument();
  expect(screen.getByText("stem-cell-derived islets")).toBeInTheDocument();
  expect(document.querySelector(".md-code-panel")).toBeNull();
  expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument();
});

test("ordinary yaml and json stay code blocks", () => {
  render(
    <Markdown
      content={'```yaml\nservice: steward\nreplicas: 2\n```\n\n```json\n{"replicas": 2}\n```'}
    />,
  );
  expect(screen.getByText("yaml")).toBeInTheDocument();
  expect(screen.getByText("json")).toBeInTheDocument();
  expect(screen.queryByText("structure")).not.toBeInTheDocument();
});

test("an invalid dedicated diagram fence stays a visual repair card, never a code panel", async () => {
  render(<Markdown content={'```steward-diagram\n{"rows": "broken"\n```'} />);
  expect(screen.getByText("Rendering diagram…")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("img", { name: "Diagram source needs repair" })).toBeInTheDocument(), {
    timeout: 4000,
  });
  expect(document.querySelector(".md-code-panel")).toBeNull();
  expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
});

test("structure charts support PowerPoint-style inline text editing on the canvas", async () => {
  const onUpdateDiagram = vi.fn().mockReturnValue(true);
  const body = JSON.stringify({
    rows: [
      [{ id: "bryan", title: "ALDEN HARLAN", variant: "banner", connects: [{ to: "brt" }] }],
      [{ id: "brt", title: "Revocable Trust", bullets: ["Settlor: Alden"] }],
    ],
  });
  const { container } = render(
    <Markdown content={`\`\`\`steward-diagram\n${body}\n\`\`\``} onUpdateDiagram={onUpdateDiagram} />,
  );

  // Arrows from connects render as marker-tipped paths.
  expect(container.querySelectorAll('path[marker-end="url(#arrow-primary)"]').length).toBeGreaterThan(0);

  // Click the bullet text right on the canvas, rewrite it, commit with Enter.
  const bullet = [...container.querySelectorAll("text.sdc-text")].find((el) =>
    el.textContent?.includes("Settlor: Alden"),
  );
  expect(bullet).toBeTruthy();
  fireEvent.click(bullet!);
  const inline = screen.getByRole("textbox", { name: "Edit diagram text" });
  expect(inline).toHaveValue("Settlor: Alden");
  fireEvent.change(inline, { target: { value: "Settlor & Trustee: Alden" } });
  fireEvent.keyDown(inline, { key: "Enter" });

  await waitFor(() => expect(onUpdateDiagram).toHaveBeenCalledTimes(1));
  const [, nextSource] = onUpdateDiagram.mock.calls[0];
  expect(JSON.parse(nextSource).rows[1][0].bullets).toEqual(["Settlor & Trustee: Alden"]);
});

test("hovering a box surfaces move and delete controls that commit instantly", async () => {
  const onUpdateDiagram = vi.fn().mockReturnValue(true);
  const body = JSON.stringify({
    rows: [[{ id: "a", title: "Box A" }, { id: "b", title: "Box B" }]],
  });
  const { container } = render(
    <Markdown content={`\`\`\`steward-diagram\n${body}\n\`\`\``} onUpdateDiagram={onUpdateDiagram} />,
  );

  const titleA = [...container.querySelectorAll("text.sdc-text")].find((el) => el.textContent?.includes("Box A"));
  fireEvent.mouseEnter(titleA!);
  fireEvent.click(screen.getByRole("button", { name: "Move box right" }));
  await waitFor(() => expect(onUpdateDiagram).toHaveBeenCalledTimes(1));
  expect(JSON.parse(onUpdateDiagram.mock.calls[0][1]).rows[0].map((card) => card.id)).toEqual(["b", "a"]);
});
