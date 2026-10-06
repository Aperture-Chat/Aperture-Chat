import { beforeEach, expect, test, vi } from "vitest";
import mermaid from "mermaid";
import { diagramPalette } from "./diagramTheme";
import { polishMermaidSvg, renderMermaidSvgResult } from "./mermaidRender";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn().mockResolvedValue(true),
    render: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(mermaid.render).mockReset();
});

test("a rejected source is repaired and rendered by Mermaid before any fallback", async () => {
  vi.mocked(mermaid.render).mockImplementation(async (_id: string, source: string) => {
    if (source.includes("(init)]")) throw new Error("Parse error on line 2");
    return { svg: '<svg viewBox="0 0 10 10" aria-roledescription="flowchart-v2"><g></g></svg>' } as never;
  });
  const result = await renderMermaidSvgResult("graph TD\n  A[Start (init)] --> B", false);
  expect(result.fallback).toBeFalsy();
  expect(result.svg).toContain("flowchart-v2");
  const sources = vi.mocked(mermaid.render).mock.calls.map((call) => call[1]);
  expect(sources[1]).toContain('A["Start (init)"]');
});

test("when repair cannot help, the figure falls back to Aperture's drawing", async () => {
  vi.mocked(mermaid.render).mockRejectedValue(new Error("boom"));
  const result = await renderMermaidSvgResult("flowchart LR\n  A[Start] --> B[Finish]", false);
  expect(result.fallback).toBe(true);
  expect(result.svg).toContain("Start");
  expect(result.svg).toContain("Finish");
});

test("timelines and mind maps use Aperture's renderers without Mermaid", async () => {
  const timeline = await renderMermaidSvgResult("timeline\n  title Launch\n  2025 : Beta\n  2026 : GA", false);
  expect(timeline.svg).toContain("Launch");
  const mindmap = await renderMermaidSvgResult("mindmap\n  root((Plan))\n    Guilds (Esnaf)", false);
  expect(mindmap.svg).toContain("Guilds (Esnaf)");
  expect(mermaid.render).not.toHaveBeenCalled();
});

test("bar charts get slim rounded bars anchored on zero, gridlines, and line markers", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" aria-roledescription="xychart">
    <g class="main"><g class="plot">
      <g class="bar-plot-0"><rect x="100" y="60" width="40" height="190" fill="#0b8fa0"/><rect x="200" y="200" width="40" height="50" fill="#0b8fa0"/></g>
      <g class="line-plot-1"><path d="M 120,120 L 220,140" stroke="#eb6834" fill="none"/></g>
    </g>
    <g class="bottom-axis"><g class="axis-line"><path d="M 60,250 L 380,250" stroke="#b9c7cd"/></g></g>
    <g class="left-axis"><g class="axisl-line"><path d="M 60,20 L 60,250" stroke="#b9c7cd"/></g>
      <g class="label"><text transform="translate(55, 60)">40</text><text transform="translate(55, 150)">0</text><text transform="translate(55, 250)">-20</text></g>
      <g class="ticks"><path d="M 55,60 L 60,60"/></g></g>
    </g></svg>`;
  const polished = polishMermaidSvg(svg, diagramPalette(false));
  expect(polished).not.toMatch(/<rect x="100"/);
  // Positive bar rises from the zero line (y=150) to its value (y=60)…
  expect(polished).toMatch(/d="M106\.4,150V64Q/);
  // …and the negative bar (top at y=200, below zero) hangs from zero.
  expect(polished).toMatch(/d="M206\.4,150H233\.6V196Q/);
  expect(polished).toContain("aperture-gridlines");
  expect(polished).toContain("aperture-zero-line");
  expect(polished.match(/<circle/g)).toHaveLength(2);
});

test("HTML labels are replaced with SVG text so rasterization never taints", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g><foreignObject x="10" y="10" width="120" height="30"><div xmlns="http://www.w3.org/1999/xhtml">Create account</div></foreignObject></g></svg>`;
  const polished = polishMermaidSvg(svg, diagramPalette(false));
  expect(polished).not.toContain("foreignObject");
  expect(polished).toContain("Create account");
});
