import { expect, test, vi } from "vitest";
import { markdownToDocumentHtml } from "./markdown";
import { hasUnrenderedDocumentDiagram, hydrateDocumentDiagramFigures, pngDimensions } from "./documentDiagrams";
import { renderMermaidPngDataUrl } from "./mermaidRender";
import { renderStewardDiagramPngDataUrl } from "./stewardDiagram";

vi.mock("./mermaidRender", () => ({
  diagramTypeLabel: () => "timeline",
  renderMermaidPngDataUrl: vi.fn().mockResolvedValue("data:image/png;base64,AAA"),
}));

vi.mock("./stewardDiagram", () => ({
  renderStewardDiagramPngDataUrl: vi.fn().mockResolvedValue("data:image/png;base64,BBB"),
}));

test("pending-diagram detection is independent of attribute order", () => {
  expect(hasUnrenderedDocumentDiagram('<figure data-diagram-source="x"></figure>')).toBe(true);
  expect(
    hasUnrenderedDocumentDiagram(
      '<figure data-diagram-rendered="true" data-diagram-source="x"></figure>',
    ),
  ).toBe(false);
  expect(
    hasUnrenderedDocumentDiagram(
      '<figure data-diagram-source="x" data-diagram-rendered="failed"></figure>',
    ),
  ).toBe(false);
});

test("hydrateDocumentDiagramFigures replaces mermaid source with a rendered image", async () => {
  const html = markdownToDocumentHtml(
    "# Report\n\n```mermaid\ntimeline\n    title Milestones\n    1989 : Cold fusion announced\n```\n\nCaption prose.",
  );
  expect(hasUnrenderedDocumentDiagram(html)).toBe(true);
  expect(html).toContain("document-diagram-pending");
  expect(html).not.toContain("1989 : Cold fusion announced");

  const hydration = await hydrateDocumentDiagramFigures(html);
  expect(hydration?.rendered).toBe(1);
  expect(hydration?.html).toContain('class="document-diagram-image"');
  expect(hydration?.html).toContain("data:image/png;base64,AAA");
  expect(hydration?.html).toContain('data-diagram-rendered="true"');
  expect(hydration?.html).not.toContain("document-diagram-pending");
  expect(hydration?.html).not.toContain("1989 : Cold fusion announced");
  expect(hasUnrenderedDocumentDiagram(hydration?.html ?? "")).toBe(false);
});

test("hydrates every Mermaid, JSON, and YAML diagram in one transferred document", async () => {
  const json = JSON.stringify({
    title: "JSON Structure",
    rows: [[{ id: "json", title: "JSON card" }]],
  });
  const yaml = `title: YAML Structure
rows:
  - cards:
      - id: yaml
        title: YAML card`;
  const html = markdownToDocumentHtml(
    [
      "# Mixed diagrams",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "```json",
      json,
      "```",
      "",
      "```yaml",
      yaml,
      "```",
    ].join("\n"),
  );

  expect(html.match(/document-diagram-pending/g)).toHaveLength(3);
  expect(html).not.toContain("document-code-block");
  const hydration = await hydrateDocumentDiagramFigures(html);

  expect(hydration?.rendered).toBe(3);
  expect(hydration?.html.match(/class="document-diagram-image"/g)).toHaveLength(3);
  expect(hydration?.html).not.toContain("document-diagram-pending");
  expect(vi.mocked(renderStewardDiagramPngDataUrl)).toHaveBeenCalledWith(json);
  expect(vi.mocked(renderStewardDiagramPngDataUrl)).toHaveBeenCalledWith(yaml);
});

test("one broken diagram does not prevent later diagrams from rendering", async () => {
  const renderer = vi.mocked(renderStewardDiagramPngDataUrl);
  renderer.mockReset();
  renderer
    .mockRejectedValueOnce(new Error("Rasterization failed"))
    .mockResolvedValueOnce("data:image/png;base64,BBB");
  try {
    const first = JSON.stringify({ rows: [[{ id: "first", title: "First" }]] });
    const second = JSON.stringify({ rows: [[{ id: "second", title: "Second" }]] });
    const html = markdownToDocumentHtml(
      `\`\`\`json\n${first}\n\`\`\`\n\n\`\`\`json\n${second}\n\`\`\``,
    );

    const hydration = await hydrateDocumentDiagramFigures(html);
    expect(hydration?.rendered).toBe(1);
    expect(hydration?.html).toContain('data-diagram-rendered="failed"');
    expect(hydration?.html).toContain("This diagram could not be rendered.");
    expect(hydration?.html).toContain('class="document-diagram-image"');
    expect(renderer).toHaveBeenCalledTimes(2);
  } finally {
    renderer.mockReset().mockResolvedValue("data:image/png;base64,BBB");
  }
});

// 4×2 PNG header (IHDR) — enough for pngDimensions.
const PNG_4X2 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEUlEQVR42mP8z8DwnwEJMAIAKAYB/2bsWJMAAAAASUVORK5CYII=";

test("pngDimensions reads the raster size from the PNG header", () => {
  expect(pngDimensions(PNG_4X2)).toEqual({ width: 4, height: 2 });
  expect(pngDimensions("data:image/jpeg;base64,AAAA")).toBeNull();
});

test("server-written figures resolve like chat: drawings render, code goes back to code", async () => {
  const mermaidRenderer = vi.mocked(renderMermaidPngDataUrl);
  mermaidRenderer.mockResolvedValueOnce(PNG_4X2);
  const drawing = encodeURIComponent("Core → Vessel → Pump\n\nHeat moves by convection.");
  const notDiagram = encodeURIComponent("just some notes");
  const html =
    `<figure class="document-media-block document-diagram-figure" data-diagram-language="text" data-diagram-source="${drawing}"><div class="document-diagram-pending">Diagram will render on this page.</div></figure>` +
    `<figure class="document-media-block document-diagram-figure" data-diagram-language="text" data-diagram-source="${notDiagram}"><div class="document-diagram-pending">Diagram will render on this page.</div></figure>`;

  const hydration = await hydrateDocumentDiagramFigures(html);
  expect(hydration?.rendered).toBe(1);
  const call = mermaidRenderer.mock.calls.at(-1)?.[0] ?? "";
  expect(call).toContain("flowchart LR");
  expect(call).toContain('"Vessel"');
  // Rasters are shown at their design size (half the 2× pixel size).
  expect(hydration?.html).toContain('width="2"');
  expect(hydration?.html).toContain('height="1"');
  expect(hydration?.html).toContain("<figcaption>Heat moves by convection.</figcaption>");
  expect(hydration?.html).not.toContain("data-diagram-language");
  expect(hydration?.html).toContain('<pre class="document-code-block"><code>just some notes</code></pre>');
});
