import { expect, test } from "vitest";
import { addDiagramNode, parseDiagramModel, removeDiagramNode, updateDiagramNodeText } from "./diagramEdit";

const SAMPLE = `flowchart TB
  ALDEN["\`**ALDEN L. HARLAN**
  Settlor · Grantor\`"]:::principal
  RLT["\`**Alden Revocable Trust**
  2017 · Kansas law\`"]:::taxable
  CST["Credit Shelter Trust"]
  KIDS["Four children<br/>Quinn · Riley"]

  ALDEN ==> RLT
  RLT -. "if disclaimed" .-> CST
  CST --> KIDS

  classDef principal fill:#123a5c,stroke:#0b2b45,color:#ffffff
  classDef taxable fill:#eef4fa,stroke:#b9cbdc,color:#0c1a26
  style CST stroke-dasharray: 4
  class CST,KIDS taxable
`;

test("parseDiagramModel reads markdown-string, plain, and <br/> labels", () => {
  const model = parseDiagramModel(SAMPLE);
  expect(model.editable).toBe(true);
  expect(model.nodes.map((node) => node.id)).toEqual(["ALDEN", "RLT", "CST", "KIDS"]);
  expect(model.nodes[0]).toMatchObject({ title: "ALDEN L. HARLAN", detail: "Settlor · Grantor" });
  expect(model.nodes[2]).toMatchObject({ title: "Credit Shelter Trust", detail: "" });
  expect(model.nodes[3]).toMatchObject({ title: "Four children", detail: "Quinn · Riley" });
});

test("non-flowchart sources are not box-editable", () => {
  expect(parseDiagramModel("pie\n  \"A\": 10\n  \"B\": 20").editable).toBe(false);
  expect(parseDiagramModel("sequenceDiagram\n  A->>B: hi").editable).toBe(false);
});

test("updateDiagramNodeText rewrites one label and keeps class suffixes", () => {
  const next = updateDiagramNodeText(SAMPLE, "RLT", "Revocable Trust", "Amended 2026\nMissouri law");
  expect(next).toContain('RLT["`**Revocable Trust**\nAmended 2026\nMissouri law`"]:::taxable');
  expect(next).toContain("ALDEN L. HARLAN");
  expect(next).toContain("classDef principal");
  // A plain single-line edit stays a plain quoted label.
  const plain = updateDiagramNodeText(SAMPLE, "CST", "Shelter Trust", "");
  expect(plain).toContain('CST["Shelter Trust"]');
  expect(updateDiagramNodeText(SAMPLE, "NOPE", "x", "")).toBeNull();
});

test("updateDiagramNodeText sanitizes characters that would break the label", () => {
  const next = updateDiagramNodeText(SAMPLE, "CST", 'Say "hi" `now`', "");
  expect(next).toContain("CST[\"Say 'hi' 'now'\"]");
});

test("removeDiagramNode drops the node, its edges, styles, and class entries", () => {
  const next = removeDiagramNode(SAMPLE, "CST");
  expect(next).not.toContain("Credit Shelter Trust");
  expect(next).not.toContain("if disclaimed");
  expect(next).not.toContain("CST --> KIDS");
  expect(next).not.toContain("style CST");
  expect(next).toContain("class KIDS taxable");
  expect(next).toContain("ALDEN ==> RLT");
  const model = parseDiagramModel(next);
  expect(model.nodes.map((node) => node.id)).toEqual(["ALDEN", "RLT", "KIDS"]);
});

test("removeDiagramNode drops a class statement once it has no members left", () => {
  const next = removeDiagramNode(removeDiagramNode(SAMPLE, "CST"), "KIDS");
  expect(next).not.toContain("class KIDS");
  expect(next).not.toContain("class  taxable");
  expect(next).toContain("classDef taxable");
});

test("removeDiagramNode never matches ids inside label text", () => {
  const source = 'flowchart LR\n  A["CST is mentioned here"]\n  CST["Real box"]\n  A --> CST\n';
  const next = removeDiagramNode(source, "CST");
  expect(next).toContain('A["CST is mentioned here"]');
  expect(next).not.toContain("Real box");
  expect(next).not.toContain("A --> CST");
});

test("addDiagramNode appends a connected box with a fresh id", () => {
  const added = addDiagramNode(SAMPLE, "Trust Protector", "Marcus T. Field", "RLT");
  expect(added.id).toBe("BOX1");
  expect(added.source).toContain('BOX1["`**Trust Protector**\nMarcus T. Field`"]');
  expect(added.source).toContain("RLT --> BOX1");
  const again = addDiagramNode(added.source, "Second", "", undefined);
  expect(again.id).toBe("BOX2");
  expect(again.source).toContain('BOX2["Second"]');
  expect(parseDiagramModel(again.source).nodes.map((node) => node.id)).toContain("BOX2");
});
