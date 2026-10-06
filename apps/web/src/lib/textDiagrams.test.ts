import { expect, test } from "vitest";
import {
  convertDotToMermaid,
  convertPlantUmlToMermaid,
  convertTextDiagram,
  looksLikeBoxArt,
} from "./textDiagrams";

test("arrow-chain notes become a flowchart and keep their prose as notes", () => {
  const converted = convertTextDiagram(
    [
      "Simplified passive decay-heat removal idea:",
      "",
      " Reactor core → Reactor vessel → Heat exchanger/wall → Air or water tank → Environment",
      "",
      "No powered pump is required in the most basic passive cooling mode.",
    ].join("\n"),
  );
  expect(converted?.source).toContain("title: Simplified passive decay-heat removal idea");
  expect(converted?.source).toMatch(/^---[\s\S]*flowchart LR/);
  expect(converted?.source).toContain('"Reactor core"');
  expect(converted?.source).toContain('"Environment"');
  expect(converted?.notes).toEqual(["No powered pump is required in the most basic passive cooling mode."]);
});

test("headed chains become stacked groups, and a loop closes on its first step", () => {
  const converted = convertTextDiagram(
    [
      "Traditional loop-type PWR:",
      "Reactor vessel → Large pipe → Steam generator → Large pipe → Pump → Reactor vessel",
      "",
      "Integral SMR:",
      "[Core + steam generators + pressurizer + internal circulation] inside one vessel",
    ].join("\n"),
  )!;
  expect(converted.source).toContain("flowchart TD");
  expect(converted.source).toContain('subgraph s1["Traditional loop-type PWR"]');
  expect(converted.source).toContain('subgraph s2["Integral SMR"]');
  expect(converted.source).toContain("s1 ~~~ s2");
  // "Large pipe" twice is two pipes; "Reactor vessel" at both ends is one node.
  const vessel = /(n\d+)\["Reactor vessel"\]/.exec(converted.source)?.[1];
  expect(converted.source).toContain(`--> ${vessel}["Reactor vessel"]`);
  const pipes = new Set([...converted.source.matchAll(/(n\d+)\["Large pipe"\]/g)].map((match) => match[1]));
  expect(pipes.size).toBe(2);
});

test("numbered layer lists stack as blocks and step lists flow", () => {
  const layers = convertTextDiagram("Layer 3: Vessel\nLayer 2: Cladding\nLayer 1: Fuel kernel")!;
  expect(layers.source).toContain("block-beta");
  expect(layers.source).toContain('"Layer 3 — Vessel"');
  expect(layers.source).toContain("style l3 fill:#12384a");
  const steps = convertTextDiagram("Step 1: Collect\nStep 2: Verify\nStep 3: Approve")!;
  expect(steps.source).toContain("flowchart LR");
  expect(steps.source).toContain("s2 --> s3");
});

test("box-drawing art becomes nodes joined by the drawn arrows", () => {
  const art = [
    "┌──────────┐      ┌──────────┐",
    "│  Client  │ ───▶ │   API    │",
    "└──────────┘      └──────────┘",
  ].join("\n");
  expect(looksLikeBoxArt(art)).toBe(true);
  const converted = convertTextDiagram(art)!;
  expect(converted.source).toContain('b1["Client"]');
  expect(converted.source).toContain('b2["API"]');
  expect(converted.source).toContain("b1 --> b2");

  const plus = [
    "+--------+     +---------+",
    "| Intake | --> | Triage  |",
    "+--------+     +---------+",
    "                    |",
    "                    v",
    "               +---------+",
    "               | Resolve |",
    "               +---------+",
  ].join("\n");
  const flow = convertTextDiagram(plus)!;
  expect(flow.source).toContain("b1 --> b2");
  expect(flow.source).toContain("b2 --> b3");
});

test("code, logs, and plain prose are never converted", () => {
  expect(convertTextDiagram("fn main() {\n    let x = obj->value;\n}")).toBeNull();
  expect(
    convertTextDiagram(
      "2026-10-05 12:01:22 INFO request -> /api/chat (200)\n2026-10-05 12:01:23 INFO request -> /api/drafts (201)",
    ),
  ).toBeNull();
  expect(convertTextDiagram("Outer layer\nMiddle layer\nInner core")).toBeNull();
  expect(convertTextDiagram("Revenue grew → fast")).toBeNull();
});

test("Graphviz DOT converts to a Mermaid flowchart with labels, styles, and direction", () => {
  const converted = convertDotToMermaid(
    'digraph G {\n  rankdir=LR;\n  intake [label="Intake"];\n  review [label="Legal review", shape=diamond];\n  intake -> review [label="submit"];\n  review -> reject [style=dashed];\n}',
  )!;
  expect(converted.source).toContain("flowchart LR");
  expect(converted.source).toContain('n1["Intake"]');
  expect(converted.source).toContain('n2{"Legal review"}');
  expect(converted.source).toContain('n1 -->|"submit"| n2');
  expect(converted.source).toContain("n2 -.-> n3");
});

test("PlantUML sequences convert to Mermaid sequence diagrams", () => {
  const converted = convertPlantUmlToMermaid(
    "@startuml\nactor User\nUser -> API: login\nAPI --> User: token\n@enduml",
  )!;
  expect(converted.source).toContain("sequenceDiagram");
  expect(converted.source).toContain("actor User");
  expect(converted.source).toContain("User->>API: login");
  expect(converted.source).toContain("API-->>User: token");
});
