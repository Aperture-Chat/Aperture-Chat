import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, test, vi } from "vitest";
import mermaid from "mermaid";
import type { ChatCitation } from "../lib/types";
import { CitationMarkerContext } from "./CitationMarker";
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

  expect(screen.queryByRole("dialog", { name: "Artifact canvas" })).not.toBeInTheDocument();
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
  const canvas = screen.getByRole("dialog", { name: "Artifact canvas" });
  const frame = within(canvas).getByTitle("new-title.html preview");
  expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  expect(frame.getAttribute("srcdoc")).toContain("<h1>New title</h1>");
  expect(within(canvas).getByText("new-title.html")).toBeInTheDocument();
  expect(within(canvas).getByText(/HTML/)).toBeInTheDocument();
});

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function captureDownloads() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      blobs.push(blob);
      return `blob:download-${blobs.length}`;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
  });
  return {
    blobs,
    names,
    restore() {
      click.mockRestore();
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
    },
  };
}

test("Download saves the current code under a name drawn from the code itself", async () => {
  const downloads = captureDownloads();
  try {
    render(<Markdown content={"## Board setup\n\n```python\nclass SnakeGame:\n    pass\n```"} />);
    const download = screen.getByRole("button", { name: "Download" });
    expect(download).toHaveAttribute("data-tooltip", "Download as snake_game.py");
    fireEvent.click(download);
    expect(downloads.names).toEqual(["snake_game.py"]);
    expect(downloads.blobs[0]!.type).toBe("text/plain;charset=utf-8");
    expect(await blobText(downloads.blobs[0]!)).toBe("class SnakeGame:\n    pass");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Editable python code" }), {
      target: { value: "WIDTH = 20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    // No symbol left: the heading above the block names the edited copy.
    expect(downloads.names[1]).toBe("board-setup.py");
    expect(await blobText(downloads.blobs[1]!)).toBe("WIDTH = 20");
  } finally {
    downloads.restore();
  }
});

test("a fence that names its file keeps that name and shows its language", () => {
  const downloads = captureDownloads();
  try {
    render(<Markdown content={"```js:server.js\nconsole.log(1)\n```"} />);
    expect(screen.getByText("js")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(downloads.names).toEqual(["server.js"]);
    expect(downloads.blobs[0]!.type).toBe("text/javascript;charset=utf-8");
  } finally {
    downloads.restore();
  }
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
  expect(container.querySelectorAll('path[marker-end="url(#aperture-sd-arrow-primary)"]').length).toBeGreaterThan(0);

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

test("the artifact canvas focuses the running preview, traps Tab, and Escape restores its opener", async () => {
  render(<Markdown content={'```html\n<title>Pong</title>\n<h1>Preview</h1>\n```'} />);
  const opener = screen.getByRole("button", { name: "Preview" });
  opener.focus();
  fireEvent.click(opener);
  const canvas = screen.getByRole("dialog", { name: "Artifact canvas" });
  const frame = within(canvas).getByTitle("pong.html preview");
  // Keyboard games respond immediately: the running preview takes focus.
  await waitFor(() => expect(frame).toHaveFocus());
  fireEvent.keyDown(frame, { key: "Tab" });
  expect(within(canvas).getByRole("radio", { name: "Preview" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(frame).toHaveFocus();
  fireEvent.keyDown(frame, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Artifact canvas" })).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

/** Highlighting splits a line into colored spans, so compare whole lines. */
function canvasLines(canvas: HTMLElement) {
  return [...canvas.querySelectorAll(".md-code-line-text")].map((line) => line.textContent);
}

test("the canvas flips between the running preview and numbered code, and expands", () => {
  render(<Markdown content={'```html\n<title>Pong</title>\n<canvas></canvas>\n```'} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  const canvas = screen.getByRole("dialog", { name: "Artifact canvas" });
  fireEvent.click(within(canvas).getByRole("radio", { name: "Code" }));
  expect(within(canvas).queryByTitle("pong.html preview")).not.toBeInTheDocument();
  expect(canvasLines(canvas)).toContain("<canvas></canvas>");
  expect(within(canvas).queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();

  const expand = within(canvas).getByRole("button", { name: "Expand the canvas to the full window" });
  fireEvent.click(expand);
  expect(document.querySelector(".artifact-canvas-layer")).toHaveClass("is-expanded");
  expect(within(canvas).getByRole("button", { name: "Restore the canvas beside the chat" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(within(canvas).getByRole("button", { name: "Close the artifact canvas" }));
  expect(screen.queryByRole("dialog", { name: "Artifact canvas" })).not.toBeInTheDocument();
});

test("code with no live preview opens straight to its source", () => {
  render(<Markdown content={"```python\nprint('hi')\n```"} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  const canvas = screen.getByRole("dialog", { name: "Artifact canvas" });
  expect(within(canvas).queryByRole("radiogroup", { name: "Artifact view" })).not.toBeInTheDocument();
  expect(within(canvas).queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
  expect(canvasLines(canvas)).toContain("print('hi')");
  expect(within(canvas).getByText(/Source/)).toBeInTheDocument();
});

test("switching response versions replaces code and closes the previous version's preview", async () => {
  const view = render(<Markdown content={'```html\n<h1>First version</h1>\n```'} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Editable html code" }), { target: { value: "<h1>Local edit</h1>" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(screen.getByRole("dialog", { name: "Artifact canvas" })).toBeInTheDocument();
  view.rerender(<Markdown content={'```html\n<h1>Second version</h1>\n```'} />);
  expect(screen.queryByRole("dialog", { name: "Artifact canvas" })).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Editable html code" })).not.toBeInTheDocument();
  // Highlighting splits a line into colored spans, so compare whole lines.
  expect(document.querySelector(".md-code-line-text")).toHaveTextContent("<h1>Second version</h1>");
  expect(document.querySelector(".md-code-panel")).not.toHaveTextContent("<h1>Local edit</h1>");
});

test("a diagram drawn as text renders as a figure with its notes, and Code shows what was written", async () => {
  const drawing = "Reactor core → Reactor vessel → Heat exchanger → Environment\n\nNo powered pump is required.";
  render(<Markdown content={`\`\`\`text\n${drawing}\n\`\`\``} />);
  expect(document.querySelector(".md-code-panel")).toBeNull();
  expect(document.querySelector('.md-diagram-panel[data-diagram-type="flowchart"]')).toBeInTheDocument();
  expect(screen.getByText("No powered pump is required.")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Code" }));
  expect(screen.getByText("Reactor core → Reactor vessel → Heat exchanger → Environment")).toBeInTheDocument();
});

test("a metadata JSON block in a prose answer renders as a summary visual", () => {
  const body = JSON.stringify(
    {
      literature_search_date: "2026-09-29",
      review_type: "focused narrative review",
      evidence_categories: ["peer-reviewed research", "clinical-trial records", "preprints"],
    },
    null,
    2,
  );
  render(<Markdown content={`Findings follow.\n\n\`\`\`json\n${body}\n\`\`\``} />);
  expect(document.querySelector('[data-diagram-type="structured-summary"]')).toBeInTheDocument();
  expect(document.querySelector(".md-code-panel")).toBeNull();
});

describe("citation markers in a reply", () => {
  const handbook: ChatCitation = {
    id: "cite-1",
    source_name: "Handbook.pdf",
    source_type: "upload",
    source_uri: "upload://handbook",
    snippet: "",
    k_index: 1,
    chunk_id: "chunk-1",
    document_id: "doc-1",
    knowledge_config_id: "kb-1",
    locator: "Page 40",
  };
  const article: ChatCitation = {
    id: "cite-2",
    source_name: "News article",
    source_type: "web",
    source_uri: "https://example.com/story",
    snippet: "",
    w_index: 1,
    cited: true,
  };

  function renderReply(content: string, citations: ChatCitation[]) {
    const onOpen = vi.fn();
    render(
      <CitationMarkerContext.Provider value={{ citations, onOpen }}>
        <Markdown content={content} />
      </CitationMarkerContext.Provider>,
    );
    return onOpen;
  }

  const viewerRequest = { kind: "document", configId: "kb-1", documentId: "doc-1", chunkId: "chunk-1" };

  it("opens the document from a knowledge marker", () => {
    const onOpen = renderReply("Files stay seven years [K1].", [handbook]);
    fireEvent.click(screen.getByRole("button", { name: "Open source K1: Handbook.pdf, Page 40" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining(viewerRequest));
  });

  it("takes focus on click, so closing the viewer can return to the marker", () => {
    renderReply("Files stay seven years [K1].", [handbook]);
    const marker = screen.getByRole("button", { name: /Open source K1/ });
    fireEvent.click(marker);
    expect(marker).toHaveFocus();
  });

  it("opens an old citation through its chunk", () => {
    const onOpen = renderReply("Old reply [K1].", [
      { ...handbook, document_id: undefined, knowledge_config_id: undefined, locator: null },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Open source K1: Handbook.pdf" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: "chunk", chunkId: "chunk-1" }));
  });

  it("opens a web marker as a link in a new tab", () => {
    const onOpen = renderReply("Reported today [W1].", [article]);
    const link = screen.getByRole("link", { name: "Open source W1: News article" });
    expect(link).toHaveAttribute("href", "https://example.com/story");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("links a fetched URL's marker too", () => {
    renderReply("From the page [U1].", [{ ...article, w_index: null, u_index: 1 }]);
    expect(screen.getByRole("link", { name: "Open source U1: News article" })).toBeInTheDocument();
  });

  it("never renders a stored unsafe address as a marker link", () => {
    renderReply("Reported [W1].", [{ ...article, source_uri: "javascript:alert(1)" }]);
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.querySelector('[data-cite-index="W1"]')).toHaveTextContent("W1");
  });

  // Review finding 2 and ruling R1: the renderer never edits a reply.
  describe("a bracket the reply's citations do not explain", () => {
    it.each([
      ["employees should attach [W2] to the return."],
      ["attach [W2, W4] and the [K1] to the return."],
      ["partners receive a Schedule [K1] each March."],
      ["the court in Smith [K1] at 45 held otherwise"],
      ["[K1-K3] and [K1–3] and [K 1] and 【K1】 and ［K1］"],
    ])("stays as written with no citations: %s", (content) => {
      renderReply(content, []);
      expect(document.body).toHaveTextContent(content);
      expect(document.querySelector(".md-cite-marker")).toBeNull();
    });

    it("stays as written in a table cell", () => {
      renderReply("| A |\n| --- |\n| [K1] and [W2] |", []);
      expect(document.body).toHaveTextContent("[K1] and [W2]");
    });

    it("stays as written when only the other letter is in use", () => {
      renderReply("The form [W2] was filed [K1].", [handbook]);
      expect(document.body).toHaveTextContent("The form [W2] was filed");
      expect(screen.getByRole("button", { name: /Open source K1/ })).toBeInTheDocument();
    });

    it("keeps an old web reply's markers, whose citations carry no number", () => {
      renderReply("Reported [W1].", [{ ...article, w_index: undefined }]);
      expect(document.body).toHaveTextContent("Reported [W1].");
    });

    it("keeps the unknown half of a mixed bracket", () => {
      renderReply("Both [K1, W2].", [handbook]);
      expect(screen.getByRole("button", { name: /Open source K1/ })).toBeInTheDocument();
      expect(document.body).toHaveTextContent("[W2]");
    });

    it("keeps a page note with a bracket it leaves alone", () => {
      renderReply("See [K1, p. 50].", []);
      expect(document.body).toHaveTextContent("See [K1, p. 50].");
    });
  });

  describe("a number the reply invented", () => {
    it("is dropped when that letter is in use", () => {
      renderReply("Unsupported claim [K7] and [W3].", [handbook, article]);
      expect(document.querySelector(".md-cite-marker")).toBeNull();
      expect(document.body).not.toHaveTextContent("K7");
      expect(document.body).not.toHaveTextContent("W3");
    });

    it("takes its space with it, so no hole is left", () => {
      renderReply("Nothing here [K7]. Missing web [W3].", [handbook, article]);
      expect(document.body).toHaveTextContent("Nothing here. Missing web.");
    });

    it("takes one space only", () => {
      renderReply("Two  [K7] gaps", [handbook]);
      expect(document.querySelector(".md-paragraph")?.textContent).toBe("Two  gaps");
    });

    it("drops only the unmatched number in a list", () => {
      renderReply("Both [K1, K2].", [handbook]);
      expect(screen.getAllByRole("button")).toHaveLength(1);
      expect(document.body).not.toHaveTextContent("K2");
    });
  });

  it.each(["[K1, K2]", "[K1; K2]", "[K1][K2]", "[K1-K2]", "[K1–K2]", "[K1/K2]", "[K1，K2]", "[K1、K2]", "[K1 K2]"])(
    "reads %s as two markers",
    (markers) => {
      renderReply(`Claim ${markers}.`, [handbook, { ...handbook, id: "cite-3", chunk_id: "chunk-2", k_index: 2 }]);
      expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["K1", "K2"]);
      expect(document.body).not.toHaveTextContent("[");
    },
  );

  it.each(["[K1, p. 50]", "[K1 page 50]", "[K1, pp. 50-51]", "[K1, slide 3]", "[K1; sheet Q3]"])(
    "turns %s into a key with no raw bracket left",
    (marker) => {
      renderReply(`Claim ${marker}.`, [handbook]);
      expect(screen.getByRole("button", { name: /Open source K1/ })).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent("[");
    },
  );

  it.each([
    "[Source: K1]",
    "[Sources: K1]",
    "[Ref K1]",
    "[K1.]",
    "[K1,]",
    "[^K1]",
    "\\[K1\\]",
    "[К1]",
    "[Ｋ1]",
    "[K1 (p. 40)]",
    "[K1: p. 40]",
    "[K1, Harlow survey.pdf, p. 40]",
  ])("turns %s into a key too", (marker) => {
    renderReply(`Claim ${marker}.`, [handbook]);
    expect(screen.getByRole("button", { name: /Open source K1/ })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("[");
  });

  it.each(["[k1]", "[see K1]", "[K1, see the appendix]", "[K1 statement]"])("leaves the prose %s alone", (text) => {
    renderReply(`Claim ${text}.`, [handbook]);
    expect(document.body).toHaveTextContent(`Claim ${text}.`);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reads a list longer than the old bracket limit", () => {
    const citations = Array.from({ length: 23 }, (_, index) => ({ ...handbook, id: `c${index}`, k_index: index + 1 }));
    renderReply(`Claim [${citations.map((_, index) => `K${index + 1}`).join(", ")}].`, citations);
    expect(screen.getAllByRole("button")).toHaveLength(23);
  });

  it("reads the full-width brackets some models write", () => {
    renderReply("Claim ［K1］ and 【K1】.", [handbook]);
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("leaves prose in brackets alone, however it starts", () => {
    renderReply("See the [W2 form instructions] and the [K1 tax schedule], with **bold [K9 text]**.", [handbook]);
    expect(document.body).toHaveTextContent("See the [W2 form instructions] and the [K1 tax schedule], with bold [K9 text].");
    expect(document.querySelector(".md-cite-marker")).toBeNull();
  });

  it("still reads formatting inside a bracket that is not a marker", () => {
    renderReply("A [K1 **loud** note] here.", [handbook]);
    expect(screen.getByText("loud").tagName).toBe("STRONG");
  });

  it("keeps a marker readable when its citation has nowhere to go", () => {
    renderReply("Claim [K1].", [{ ...handbook, chunk_id: null, document_id: null, knowledge_config_id: null }]);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector('[data-cite-index="K1"]')).toHaveTextContent("K1");
  });

  it("stays inert in a hover preview", () => {
    render(
      <CitationMarkerContext.Provider value={{ citations: [handbook], onOpen: vi.fn() }}>
        <Markdown content="Claim [K1]." preview />
      </CitationMarkerContext.Provider>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector('[data-cite-index="K1"]')).toHaveTextContent("K1");
  });

  it("shows inert pending markers while streaming, for every form", () => {
    render(<Markdown content="Claim [K1], [W2], and [K3, K4]." streaming />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(Array.from(document.querySelectorAll(".md-cite-marker")).map((node) => node.textContent)).toEqual([
      "K1",
      "W2",
      "K3",
      "K4",
    ]);
  });

  it("resolves a pending marker on done, into a key or the words as written", () => {
    const { rerender } = render(<Markdown content="Claim [K1] and [W2]." streaming />);
    rerender(
      <CitationMarkerContext.Provider value={{ citations: [handbook], onOpen: vi.fn() }}>
        <Markdown content="Claim [K1] and [W2]." />
      </CitationMarkerContext.Provider>,
    );
    expect(screen.getByRole("button", { name: /Open source K1/ })).toBeInTheDocument();
    expect(document.body).toHaveTextContent("and [W2].");
  });

  // Surfaces with no citations to offer behave as they did before markers were keys.
  it("keeps [W2] and lists literal where no citations apply", () => {
    render(<Markdown content="Attach [W2] and [K3, K4] to it, per [K1]." />);
    expect(document.body).toHaveTextContent("Attach [W2] and [K3, K4] to it, per");
    expect(document.querySelector('[data-cite-index="K1"]')).toHaveTextContent("K1");
    expect(document.querySelectorAll(".md-cite-marker")).toHaveLength(1);
  });

  // The server counts these as citations and strips them with their URL. A
  // model's URL behind a K1 label is not where the citation points.
  describe("a marker with a link target", () => {
    it("is the marker when the reply cited that number", () => {
      const onOpen = renderReply("See [K1](https://made-up.example/k) here.", [handbook]);
      expect(screen.queryByRole("link")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Open source K1/ }));
      expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ chunkId: "chunk-1" }));
    });

    it("opens the citation's own address for a web marker, not the model's", () => {
      renderReply("See [W1](https://made-up.example/w).", [article]);
      expect(screen.getByRole("link", { name: /Open source W1/ })).toHaveAttribute("href", "https://example.com/story");
    });

    it("is dropped, URL and all, when the number does not exist", () => {
      renderReply("Claim [K7](https://made-up.example/k).", [handbook]);
      expect(screen.queryByRole("link")).toBeNull();
      expect(document.querySelector(".md-paragraph")?.textContent).toBe("Claim.");
    });

    it("stays a real link when this reply has no citations of that letter", () => {
      renderReply("Fill in [W2](https://irs.example/w2).", [handbook]);
      expect(screen.getByRole("link", { name: "W2" })).toHaveAttribute("href", "https://irs.example/w2");
    });

    it("stays a real link where no citations apply", () => {
      render(<Markdown content="See [K1](https://example.com/k)." />);
      expect(screen.getByRole("link", { name: "K1" })).toHaveAttribute("href", "https://example.com/k");
    });

    it("stays a plain label in a hover preview", () => {
      render(
        <CitationMarkerContext.Provider value={{ citations: [handbook], onOpen: vi.fn() }}>
          <Markdown content="See [K1](https://example.com/k)." preview />
        </CitationMarkerContext.Provider>,
      );
      expect(screen.queryByRole("button")).toBeNull();
      expect(document.querySelector(".md-link")).toHaveTextContent("K1");
    });

    it("shows a pending marker while streaming", () => {
      render(<Markdown content="See [K1](https://example.com/k)." streaming />);
      expect(screen.queryByRole("link")).toBeNull();
      expect(document.querySelector('[data-cite-index="K1"]')).toHaveTextContent("K1");
    });

    it("leaves an ordinary link alone", () => {
      renderReply("Read [the policy](https://example.com/p).", [handbook]);
      expect(screen.getByRole("link", { name: "the policy" })).toBeInTheDocument();
    });
  });

  describe("a marker inside emphasis", () => {
    it.each([
      ["**Bold claim with a marker [K1].**", "STRONG"],
      ["*Italic claim [K1]*", "EM"],
      ["_Underscore claim [K1]_", "EM"],
    ])("is a key inside %s", (content, tag) => {
      renderReply(content, [handbook]);
      const key = screen.getByRole("button", { name: /Open source K1/ });
      expect(key.closest(tag.toLowerCase())).not.toBeNull();
      expect(document.body).not.toHaveTextContent("[K1]");
    });

    it("keeps the words around it", () => {
      renderReply("**Before [K1] after.**", [handbook]);
      expect(document.querySelector("strong")).toHaveTextContent("Before");
      expect(document.querySelector("strong")).toHaveTextContent("after.");
    });

    it("reads every form", () => {
      renderReply("**Claim [K1, p. 40] and [Sources: K1].**", [handbook]);
      expect(screen.getAllByRole("button")).toHaveLength(2);
      expect(document.body).not.toHaveTextContent("[");
    });

    it("drops an invented number and its space", () => {
      renderReply("**Claim [K7].**", [handbook]);
      expect(document.querySelector("strong")?.textContent).toBe("Claim.");
    });

    it("leaves a bracket this reply did not cite as written", () => {
      renderReply("**Attach [W2] today.**", [handbook]);
      expect(document.querySelector("strong")?.textContent).toBe("Attach [W2] today.");
    });

    it("treats a linked marker the same way", () => {
      renderReply("**Claim [K1](https://made-up.example/k).**", [handbook]);
      expect(screen.getByRole("button", { name: /Open source K1/ })).toBeInTheDocument();
      expect(screen.queryByRole("link")).toBeNull();
    });

    it("does not start parsing other formatting inside emphasis", () => {
      renderReply("**call snake_case_name [K1] now**", [handbook]);
      expect(document.querySelector("strong")).toHaveTextContent("call snake_case_name");
      expect(document.querySelector("strong em")).toBeNull();
    });

    it("leaves emphasis with no markers exactly as before", () => {
      render(<Markdown content="**plain bold** and *plain italic*" />);
      expect(document.querySelector("strong")?.textContent).toBe("plain bold");
      expect(document.querySelector("em")?.textContent).toBe("plain italic");
    });
  });

  it("shows one key for a number written twice", () => {
    renderReply("Claim [K1, K1] and [K1, K1-K2].", [handbook, { ...handbook, id: "cite-3", chunk_id: "chunk-2", k_index: 2 }]);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["K1", "K1", "K2"]);
  });

  it("marks citations inside tables and lists too", () => {
    renderReply("- Item [K1]\n\n| A |\n| --- |\n| Cell [K1] |", [handbook]);
    expect(screen.getAllByRole("button", { name: "Open source K1: Handbook.pdf, Page 40" })).toHaveLength(2);
  });
});
