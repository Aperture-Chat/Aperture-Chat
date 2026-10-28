import { expect, test, vi } from "vitest";

const rasterize = vi.fn(async (svg: string, background: string) => `data:image/png;base64,${svg.length}:${background}`);
vi.mock("./mermaidRender", () => ({ rasterizeSvgToPngDataUrl: rasterize }));

const { renderStewardDiagramPngDataUrl } = await import("./stewardDiagram");

test("Drafts rasterize the chart as styled, on the theme's light canvas", async () => {
  const source = JSON.stringify({ theme: "forest", rows: [[{ id: "a", title: "Alpha", position: { x: 300, y: 300 } }]] });
  expect(await renderStewardDiagramPngDataUrl(source)).toMatch(/^data:image\/png/);
  const [svg, background] = rasterize.mock.calls[0]!;
  expect(background).toBe("#ffffff");
  expect(svg).toContain("#1f4a38");
  expect(await renderStewardDiagramPngDataUrl("not a diagram")).toBeNull();
});
