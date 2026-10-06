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
  const svg = renderMermaidFallbackSvg("requirementDiagram\n  requirement uptime {\n    id: 1\n  }", false);
  expect(svg).toContain("<svg");
  expect(svg).toContain("requirement diagram");
  expect(svg).toContain("requirement uptime");
  expect(svg).not.toContain("<pre");
});

test("mind maps draw as a tree that keeps words before parentheses", () => {
  const svg = renderMermaidFallbackSvg(
    "mindmap\n  root((Ottoman Society))\n    Urban Institutions\n      Guilds (Esnaf)\n      Bathhouses",
    false,
  );
  expect(svg).toContain("Ottoman Society");
  expect(svg).toContain("Guilds (Esnaf)");
  expect(svg).toContain("Bathhouses");
  expect(svg).not.toContain("foreignObject");
});

test("flowchart fallback honors direction and spaced node names", () => {
  const svg = renderMermaidFallbackSvg("flowchart TD\n  User Login --> Dashboard", false)!;
  expect(svg).toContain("User Login");
  expect(svg).toContain("Dashboard");
});

test("empty source has no fallback svg", () => {
  expect(renderMermaidFallbackSvg("   ", false)).toBeNull();
});
