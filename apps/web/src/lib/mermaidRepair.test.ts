import { expect, test } from "vitest";
import { normalizeMermaidSource, repairMermaidSyntax } from "./mermaidRepair";

test("theme overrides are removed so every diagram uses the shared palette", () => {
  const normalized = normalizeMermaidSource(
    "%%{init: {'theme':'forest'}}%%\n---\ntitle: Release flow\nconfig:\n  theme: dark\n---\nflowchart LR\n  A --> B",
  );
  expect(normalized).not.toContain("init");
  expect(normalized).not.toContain("theme");
  expect(normalized).toContain("title: Release flow");
  expect(normalized).toContain("flowchart LR");
});

test("model-chosen colors snap to palette roles with readable text", () => {
  const light = normalizeMermaidSource(
    "flowchart LR\n  classDef principal fill:#123a5c,stroke:#0b2b45,color:#fff\n  classDef ok fill:#e7f2ea,stroke:#9fc3aa,stroke-width:2px\n  style A fill:#f9f",
  );
  expect(light).toContain("classDef principal fill:#12384a,stroke:#0b2a38,color:#ffffff");
  expect(light).toContain("classDef ok fill:#e8f5ec,stroke:#a8d5b8,color:#15502e,stroke-width:2px");
  expect(light).toContain("style A fill:#f1eefb");
  const dark = normalizeMermaidSource("flowchart LR\n  classDef ok fill:#e7f2ea", true);
  expect(dark).toContain("fill:#12301f");
});

test("valid sources keep their meaning after normalization", () => {
  const source = 'flowchart TD\n  A["Start"] --> B{"Valid?"}\n  B -->|Yes| C';
  expect(normalizeMermaidSource(source)).toBe(source);
});

test("repairs the flowchart slips models make most", () => {
  const repaired = repairMermaidSyntax(
    [
      "graph TD",
      "    // inputs",
      "    A[Start (init)] --> B[Load config (YAML)]",
      "    B -> C",
      "    C → D",
      "    User Login --> Dashboard",
      "    process --> end",
      '    X["The "core" team"] --> Y',
      "    subgraph Engineered/Chimeric",
      "    E1 --> E2",
    ].join("\n"),
  );
  expect(repaired).toContain("%% inputs");
  expect(repaired).toContain('A["Start (init)"] --> B["Load config (YAML)"]');
  expect(repaired).toContain("B --> C");
  expect(repaired).toContain("C --> D");
  expect(repaired).toContain('User_Login["User Login"] --> Dashboard');
  expect(repaired).toContain("process --> end_node");
  expect(repaired).toContain('X["The “core” team"]');
  expect(repaired).toMatch(/subgraph Engineered_Chimeric\["Engineered\/Chimeric"\]/);
  // The unclosed subgraph is closed.
  expect(repaired.trim().endsWith("end")).toBe(true);
});

test("labels with arrows inside quotes are not split into edges", () => {
  const repaired = repairMermaidSyntax('flowchart LR\n  A["input -> output"] --> B');
  expect(repaired).toContain('A["input -> output"] --> B');
});

test("pie and xychart values with units and unquoted labels are cleaned", () => {
  expect(repairMermaidSyntax('pie title Mix\n  "Data" : 45%\n  Other: 1,250')).toContain('"Other" : 1250');
  const chart = repairMermaidSyntax('xychart\n  x-axis [Q1 2025, Q2 2025]\n  bar [$12, $15]');
  expect(chart).toContain("xychart-beta");
  expect(chart).toContain('x-axis ["Q1 2025", "Q2 2025"]');
  expect(chart).toContain("bar [12, 15]");
});

test("edges with no header get a flowchart header", () => {
  expect(repairMermaidSyntax("A --> B\nB --> C").startsWith("flowchart TD")).toBe(true);
});
