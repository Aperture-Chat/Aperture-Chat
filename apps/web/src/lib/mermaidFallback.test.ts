import { expect, test } from "vitest";
import { renderMermaidFallbackSvg } from "./mermaidFallback";

test("flowchart fallback draws node labels when mermaid.js cannot", () => {
  const svg = renderMermaidFallbackSvg("flowchart LR\n  A[Start] -->|go| B[End]", false);
  expect(svg).toContain("<svg");
  expect(svg).toContain("Start");
  expect(svg).toContain("End");
  expect(svg).toContain("go");
  expect(svg).not.toContain("foreignObject");
});

test("sequence fallback draws participants and messages", () => {
  const svg = renderMermaidFallbackSvg(
    "sequenceDiagram\n    participant A\n    participant B\n    A->>B: hello",
    false,
  );
  expect(svg).toContain("hello");
  expect(svg).toContain("A");
  expect(svg).toContain("B");
});

test("pie fallback draws labeled values", () => {
  const svg = renderMermaidFallbackSvg('pie title Share\n    "Alpha": 60\n    "Beta": 40', false);
  expect(svg).toContain("Share");
  expect(svg).toContain("Alpha");
  expect(svg).toContain("60");
});

test("unknown mermaid types still get a visual card diagram, not a listing", () => {
  const svg = renderMermaidFallbackSvg("mindmap\n  root((Topic))\n    Branch one\n    Branch two", false);
  expect(svg).toContain("<svg");
  expect(svg).toContain("mindmap diagram");
  expect(svg).toContain("Branch one");
  expect(svg).not.toContain("<pre");
});

test("empty source has no fallback svg", () => {
  expect(renderMermaidFallbackSvg("   ", false)).toBeNull();
});
