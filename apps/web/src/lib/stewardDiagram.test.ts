import { expect, test } from "vitest";
import { isStewardDiagramBlock, replaceDiagramFence } from "./markdown";
import {
  moveStewardCard,
  parseStewardDiagram,
  parseStewardDiagramTruncated,
  parseStructuredSummaryDiagram,
  removeStewardCard,
  renderStewardDiagramSvg,
  serializeStewardDiagram,
  stewardFieldValue,
  withStewardFieldValue,
} from "./stewardDiagram";

const SAMPLE = {
  title: "Harlan Estate Plan",
  subtitle: "Missouri residents · $80M estimated net worth",
  tag: "Confidential — attorney work product",
  rows: [
    [
      { id: "bryan", title: "ALDEN L. HARLAN", subtitle: "Settlor · Grantor", variant: "banner" },
      { id: "deb", title: "DANA L. HARLAN", subtitle: "Settlor · Grantor", variant: "banner" },
    ],
    [
      {
        id: "brt",
        title: "ALDEN L. HARLAN REVOCABLE TRUST",
        subtitle: "2017 · Kansas law",
        bullets: ["Settlor & Trustee: Alden", "At death: residue to Dana outright"],
        footer: { text: "SUBJECT TO ESTATE TAX", tone: "neutral" },
      },
      {
        id: "slat",
        title: "2021 SLAT FBO DANA",
        subtitle: "Jan. 21, 2021 · Missouri law",
        bullets: ["Grantor: Alden · Trustee: Dana"],
        footer: { text: "NOT SUBJECT TO ESTATE TAX · GST EXEMPT", tone: "positive" },
        note: "⚠ Reciprocal trust doctrine — watch item",
      },
    ],
    [[{ id: "kids", title: "FOUR CHILDREN", subtitle: "Quinn · Riley · Jordan · Casey" }]].flat(),
  ],
  edges: [
    { from: "bryan", to: "brt", kind: "primary" },
    { from: "bryan", to: "slat", kind: "primary", label: "funds" },
    { from: "brt", to: "kids", kind: "contingent", label: "if disclaimed" },
    { from: "deb", to: "missing", kind: "primary" },
  ],
  legend: [
    { kind: "primary", label: "Completed transfer / funded" },
    { kind: "contingent", label: "Contingent / at-death transfer" },
  ],
  footnote: "2026 exemption: $15M per person / $30M per couple.",
};

test("parseStewardDiagram validates cards and drops edges to unknown ids", () => {
  const model = parseStewardDiagram(JSON.stringify(SAMPLE));
  expect(model).not.toBeNull();
  expect(model!.rows.length).toBe(3);
  expect(model!.rows[0].map((card) => card.id)).toEqual(["bryan", "deb"]);
  expect(model!.edges.length).toBe(3);
  expect(model!.edges.some((edge) => edge.to === "missing")).toBe(false);
  expect(model!.legend?.length).toBe(2);
});

test("parseStewardDiagram accepts real YAML diagram source", () => {
  const yaml = `title: YAML Deal Structure
rows:
  - cards:
      - id: buyer
        title: Buyer LLC
        bullets:
          - Signs the purchase agreement
        connects:
          - to: target
            kind: primary
  - cards:
      - id: target
        title: Target Inc.
        footer:
          text: Closing required
          tone: warning
legend:
  - kind: primary
    label: Transaction path`;

  expect(isStewardDiagramBlock("yaml", yaml)).toBe(true);
  const model = parseStewardDiagram(yaml);
  expect(model?.title).toBe("YAML Deal Structure");
  expect(model?.rows.flat().map((card) => card.id)).toEqual(["buyer", "target"]);
  expect(model?.edges).toEqual([
    { from: "buyer", to: "target", kind: "primary", label: undefined },
  ]);
  expect(model?.rows[1][0].footer).toEqual({ text: "Closing required", tone: "warning" });
  expect(renderStewardDiagramSvg(model!, false)).toContain("YAML Deal Structure");
});

test("parseStewardDiagram rejects invalid or incomplete structured input", () => {
  expect(parseStewardDiagram('{"title": "half a str')).toBeNull();
  expect(parseStewardDiagram('{"rows": []}')).toBeNull();
  expect(parseStewardDiagram('"just a string"')).toBeNull();
  expect(parseStewardDiagram("service: steward\nreplicas: 2")).toBeNull();
});

test("categorized research JSON converts to a complete card-summary visual", () => {
  const model = parseStructuredSummaryDiagram(
    JSON.stringify({
      search_completed: "2026-08-29",
      literal_complete_human_organ_cloning: "not achieved",
      established_research: ["organoids", "disease models", "small tissues"],
      human_clinical_evaluation: ["islets", "retinal sheets", "cardiac muscle"],
    }),
  );

  expect(model?.title).toBe("Research status summary");
  expect(model?.tag).toBe("Visual summary");
  expect(model?.rows.flat().map((card) => card.title)).toEqual([
    "Search completed",
    "Literal complete human organ cloning",
    "Established research",
    "Human clinical evaluation",
  ]);
  expect(model?.rows[0][1].footer).toEqual({ text: "not achieved", tone: "warning" });
  expect(renderStewardDiagramSvg(model!, false)).toContain("organoids");
});

test("renderStewardDiagramSvg draws cards, bands, notes, legend, and edges", () => {
  const model = parseStewardDiagram(JSON.stringify(SAMPLE))!;
  const svg = renderStewardDiagramSvg(model, false);
  expect(svg).toContain("<svg");
  expect(svg).toContain("Harlan Estate Plan");
  expect(svg).toContain("ALDEN L. HARLAN REVOCABLE TRUST");
  expect(svg).toContain('fill="#1b2a4a"'); // navy header bands + banner cards
  expect(svg).toContain('fill="#e6f1ea"'); // positive status band
  expect(svg).toContain('fill="#fbf1dd"'); // warning note inset
  expect(svg).toContain("Confidential — attorney work product");
  expect(svg).toContain("stroke-dasharray"); // contingent edge + legend sample
  expect(svg).toContain("if disclaimed");
  expect(svg).toContain("Completed transfer / funded");
  expect(svg).toContain("2026 exemption");
  // Round-trip: serialized model re-parses identically.
  expect(parseStewardDiagram(serializeStewardDiagram(model))).toEqual(model);
});

test("steward-diagram fences are recognized and replaceable in message content", () => {
  expect(isStewardDiagramBlock("steward-diagram")).toBe(true);
  expect(isStewardDiagramBlock("json")).toBe(false);
  const body = '{"rows": [[{"id": "a", "title": "Box A"}]], "edges": []}';
  const content = `Intro.\n\n\`\`\`steward-diagram\n${body}\n\`\`\`\n\nOutro.`;
  const next = '{"rows": [[{"id": "a", "title": "Box A edited"}]], "edges": []}';
  const replaced = replaceDiagramFence(content, body, next);
  expect(replaced).toContain("Box A edited");
  expect(replaced).toContain("Intro.");
  expect(replaced).toContain("```steward-diagram");
});

test("parseStewardDiagramTruncated salvages a reply cut off mid-card", () => {
  const full = serializeStewardDiagram(parseStewardDiagram(JSON.stringify(SAMPLE))!);
  // Cut in the nastiest spots: mid-string, mid-key, right after a comma.
  for (const cut of [full.indexOf("At death") + 4, full.indexOf('"footer"'), full.lastIndexOf(",") + 1]) {
    const truncated = full.slice(0, cut);
    expect(parseStewardDiagram(truncated)).toBeNull();
    const recovered = parseStewardDiagramTruncated(truncated);
    expect(recovered).not.toBeNull();
    expect(recovered!.rows[0][0].title).toBe("ALDEN L. HARLAN");
  }
  expect(parseStewardDiagramTruncated("plain prose, not a diagram")).toBeNull();
});

test("parseStewardDiagramTruncated recovers the real truncated production reply", async () => {
  const { default: raw } = await import("./__fixtures__/truncated-steward-diagram.txt?raw");
  expect(parseStewardDiagram(raw)).toBeNull();
  const recovered = parseStewardDiagramTruncated(raw);
  expect(recovered).not.toBeNull();
  expect(recovered!.rows.length).toBeGreaterThanOrEqual(2);
  expect(recovered!.rows.flat().length).toBeGreaterThanOrEqual(5);
  expect(renderStewardDiagramSvg(recovered!, false)).toContain("<svg");
});

test("saving an edit closes a fence the truncated reply never closed", () => {
  const content = 'Intro.\n\n```steward-diagram\n{"rows": [[{"id": "a", "title": "Box';
  const body = '{"rows": [[{"id": "a", "title": "Box';
  const next = '{"rows": [[{"id": "a", "title": "Box A"}]], "edges": []}';
  const replaced = replaceDiagramFence(content, body, next);
  expect(replaced).not.toBeNull();
  expect(replaced!.endsWith("```")).toBe(true);
  expect(replaced).toContain('"title": "Box A"');
});

test("arrows attached to cards as connects survive and merge with top-level edges", () => {
  const body = JSON.stringify({
    rows: [
      [{ id: "a", title: "A", connects: [{ to: "b", kind: "primary" }, { to: "c", kind: "contingent", label: "if x" }] }],
      [{ id: "b", title: "B" }, { id: "c", title: "C" }],
    ],
    edges: [{ from: "a", to: "b", kind: "primary" }, { from: "b", to: "c", kind: "inactive" }],
  });
  const model = parseStewardDiagram(body)!;
  // connects + edges, deduped: a→b appears in both and lands once.
  expect(model.edges).toEqual([
    { from: "a", to: "b", kind: "primary", label: undefined },
    { from: "a", to: "c", kind: "contingent", label: "if x" },
    { from: "b", to: "c", kind: "inactive", label: undefined },
  ]);
});

test("connects survive a truncated reply that never reached later rows", () => {
  const full = JSON.stringify({
    rows: [
      [{ id: "a", title: "A", connects: [{ to: "b" }] }],
      [{ id: "b", title: "B", connects: [{ to: "c" }] }, { id: "c", title: "C" }],
    ],
  });
  const truncated = full.slice(0, full.indexOf('"c"') - 20);
  const model = parseStewardDiagramTruncated(truncated)!;
  expect(model.edges.some((edge) => edge.from === "a" && edge.to === "b")).toBe(true);
});

test("inline edit helpers: field get/set, move, and remove", () => {
  const model = parseStewardDiagram(JSON.stringify(SAMPLE))!;
  const titleRef = { scope: "card", cardId: "brt", field: "title" } as const;
  expect(stewardFieldValue(model, titleRef)).toBe("ALDEN L. HARLAN REVOCABLE TRUST");
  const renamed = withStewardFieldValue(model, titleRef, "Alden RLT");
  expect(stewardFieldValue(renamed, titleRef)).toBe("Alden RLT");
  // Emptying a bullet removes the line; emptying a footer removes the band.
  const bulletRef = { scope: "bullet", cardId: "brt", index: 0 } as const;
  const dropped = withStewardFieldValue(model, bulletRef, "");
  expect(dropped.rows[1][0].bullets).toEqual(["At death: residue to Dana outright"]);
  const noFooter = withStewardFieldValue(model, { scope: "card", cardId: "brt", field: "footer" }, "");
  expect(noFooter.rows[1][0].footer).toBeUndefined();
  // Moves: swap within a row, hop between rows, and split out of an edge row.
  const swapped = moveStewardCard(model, "brt", "right")!;
  expect(swapped.rows[1].map((card) => card.id)).toEqual(["slat", "brt"]);
  expect(moveStewardCard(model, "brt", "left")).toBeNull();
  const hopped = moveStewardCard(model, "brt", "up")!;
  expect(hopped.rows[0].map((card) => card.id)).toEqual(["bryan", "deb", "brt"]);
  const split = moveStewardCard(model, "bryan", "up")!;
  expect(split.rows[0].map((card) => card.id)).toEqual(["bryan"]);
  expect(split.rows[1].map((card) => card.id)).toEqual(["deb"]);
  // Removal drops the card, its arrows, and empty rows.
  const removed = removeStewardCard(model, "kids");
  expect(removed.rows.length).toBe(2);
  expect(removed.edges.some((edge) => edge.to === "kids")).toBe(false);
});
