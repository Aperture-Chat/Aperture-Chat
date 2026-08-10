import { expect, test } from "vitest";
import { repairMermaidLabelQuotes } from "./mermaidRender";

test("interior double quotes inside markdown-string labels become apostrophes", () => {
  const source = 'flowchart TD\n  WATCH["`⚠ **RISK**\nIRS "uncrossing" doctrine\n(U.S. v. Grace)`"]\n  A --> WATCH';
  const repaired = repairMermaidLabelQuotes(source);
  expect(repaired).toContain("IRS 'uncrossing' doctrine");
  // The enclosing "` … `" delimiters sit outside the backtick span and survive.
  expect(repaired).toContain('WATCH["`⚠ **RISK**');
  expect(repaired).toContain('`"]');
});

test("sources without markdown strings pass through byte-identical", () => {
  const source = 'flowchart LR\n  A["plain label"] -->|go| B\n  C -. "edge label" .-> B';
  expect(repairMermaidLabelQuotes(source)).toBe(source);
});
