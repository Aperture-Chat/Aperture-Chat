import { expect, test, vi } from "vitest";
import { markdownToDocumentHtml } from "./markdown";
import { hasUnrenderedDocumentDiagram, hydrateDocumentDiagramFigures } from "./documentDiagrams";

vi.mock("./mermaidRender", () => ({
  diagramTypeLabel: () => "timeline",
  renderMermaidPngDataUrl: vi.fn().mockResolvedValue("data:image/png;base64,AAA"),
}));

vi.mock("./stewardDiagram", () => ({
  renderStewardDiagramPngDataUrl: vi.fn().mockResolvedValue(null),
}));

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
