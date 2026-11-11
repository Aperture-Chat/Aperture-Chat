import { expect, test } from "vitest";
import {
  AI_EDIT_GROUP_LABELS,
  AI_TRANSLATE_CHIPS,
  DOCUMENT_SELECTION_ACTIONS,
  DOCUMENT_WRITE_ACTIONS,
  SHEET_ACTIONS,
  SLIDE_ACTIONS,
  aiActionMatches,
  aiEditIntent,
  aiEditKeepsFormatting,
  aiEditScopeLines,
  aiRefineMessage,
  aiWriteAtCursorPrompt,
  textAroundRange,
} from "./aiEditPrompts";

test("action filtering matches labels, keywords, and group names", () => {
  const grammar = DOCUMENT_SELECTION_ACTIONS.find((action) => action.id === "grammar")!;
  expect(aiActionMatches(grammar, "typo")).toBe(true);
  expect(aiActionMatches(grammar, "fix spell")).toBe(true);
  expect(aiActionMatches(grammar, "translate")).toBe(false);
  expect(aiActionMatches({ label: "Spanish" }, "translate", "Translate")).toBe(true);
});

test("text around a range keeps paragraph breaks and trims to word boundaries", () => {
  const root = document.createElement("div");
  root.innerHTML = "<p>Alpha beta gamma.</p><p>Target words here.</p><p>After text follows.</p>";
  const target = root.querySelectorAll("p")[1].firstChild as Text;
  const range = document.createRange();
  range.setStart(target, 0);
  range.setEnd(target, 6);
  const around = textAroundRange(root, range, { before: 100, after: 12 });
  expect(around.before).toBe("Alpha beta gamma.");
  expect(around.after).toBe("words here.…");
});

test("write-at-cursor and refine prompts carry the instruction and context", () => {
  const prompt = aiWriteAtCursorPrompt({
    documentTitle: "Plan",
    instruction: "Continue writing",
    before: "Intro text.",
    after: "",
    structureHint: "The cursor is at the end of a paragraph.",
    formatRules: "Formatting rules: none",
  });
  expect(prompt).toContain('draft titled "Plan"');
  expect(prompt).toContain("Intro text.");
  expect(prompt).toContain("(the cursor is at the end of the document)");
  expect(aiRefineMessage("shorter")).toContain("shorter");
});

test("content instructions keep formatting without being told to", () => {
  // Both ways a writer asked to fill a form: neither asks for a new look.
  const fill = aiEditIntent("add fake data and fill out the blank lines");
  expect(fill).toMatchObject({ fillBlanks: true, sampleData: true });
  expect(aiEditKeepsFormatting(fill)).toBe(true);
  expect(aiEditKeepsFormatting(aiEditIntent("fill it out with fake data but don't change the formatting"))).toBe(true);
  // Presets that only mention formatting to protect it still keep it.
  const keeps = (id: string) =>
    aiEditKeepsFormatting(aiEditIntent(DOCUMENT_SELECTION_ACTIONS.find((action) => action.id === id)!.instruction));
  expect(keeps("improve")).toBe(true);
  expect(keeps("grammar")).toBe(true);
  expect(keeps("shorter")).toBe(true);
  expect(aiEditKeepsFormatting(aiEditIntent(AI_TRANSLATE_CHIPS[1].instruction))).toBe(true);
  expect(aiEditKeepsFormatting(aiEditIntent("Rewrite the highlighted text in a formal style"))).toBe(true);
});

test("look and shape instructions are recognized", () => {
  expect(aiEditIntent("Make the party names bold").restyle).toBe(true);
  expect(aiEditIntent("Underline the defined terms").restyle).toBe(true);
  expect(aiEditIntent("Center it").restyle).toBe(true);
  const keeps = (id: string) =>
    aiEditKeepsFormatting(aiEditIntent(DOCUMENT_SELECTION_ACTIONS.find((action) => action.id === id)!.instruction));
  expect(keeps("bullets")).toBe(false);
  expect(keeps("table")).toBe(false);
  expect(aiEditIntent("Split this into two paragraphs").restructure).toBe(true);
  expect(aiEditIntent("Fill in the blanks in this section").restructure).toBe(false);
});

test("scope rules carry the formatting contract and the blank-filling rules", () => {
  const lines = aiEditScopeLines({
    instruction: "add fake data and fill out the blank lines",
    selectedText: "known as ________ consisting",
    selectedHtml: 'known as <span class="document-blank">________</span> consisting',
  }).join("\n");
  expect(lines).toContain("formatting must come back exactly as it is");
  expect(lines).toContain("Return that same markup");
  expect(lines).toContain("Fill each blank or placeholder");
  expect(lines).toContain("clearly fictional");
  const restyle = aiEditScopeLines({ instruction: "Make it bold", selectedText: "Rent is due." }).join("\n");
  expect(restyle).not.toContain("formatting must come back exactly as it is");
  expect(restyle).not.toContain("Fill each blank");
});

test.each([
  [DOCUMENT_SELECTION_ACTIONS, "clause-tighten", "Tighten this clause", "legal contract drafting"],
  [DOCUMENT_SELECTION_ACTIONS, "clause-subclauses", "Break into numbered sub-clauses", "legal"],
  [DOCUMENT_SELECTION_ACTIONS, "conclusion-first", "Lead with the conclusion", "executive"],
  [DOCUMENT_SELECTION_ACTIONS, "figures-consistent", "Make figures consistent", "finance"],
  [DOCUMENT_WRITE_ACTIONS, "defined-terms", "List the defined terms", "definitions"],
  [DOCUMENT_WRITE_ACTIONS, "open-items", "List blanks and open points", "placeholder"],
  [DOCUMENT_WRITE_ACTIONS, "key-terms", "Summarize the key terms", "term sheet"],
  [DOCUMENT_WRITE_ACTIONS, "deadlines", "List dates and deadlines", "calendar"],
  [SLIDE_ACTIONS, "slide-action-title", "Write a takeaway title", "consulting"],
  [SHEET_ACTIONS, "sheet-variance", "Add variance columns", "budget actual"],
  [SHEET_ACTIONS, "sheet-tie-out", "Check that the totals add up", "reconcile"],
])("%# a professional can find the %s action by the words of their trade", (actions, id, label, search) => {
  const action = actions.find((item) => item.id === id);

  expect(action?.label).toBe(label);
  expect(aiActionMatches(action!, search, AI_EDIT_GROUP_LABELS[action!.group])).toBe(true);
});

test("the professional actions for highlighted text sit together under their own heading", () => {
  const professional = DOCUMENT_SELECTION_ACTIONS.filter((action) => action.group === "professional");

  expect(AI_EDIT_GROUP_LABELS.professional).toBe("Legal & business");
  expect(professional.map((action) => action.id)).toEqual([
    "clause-tighten",
    "clause-subclauses",
    "conclusion-first",
    "figures-consistent",
  ]);
});

test("every action has its own id and an instruction to send", () => {
  for (const actions of [DOCUMENT_SELECTION_ACTIONS, DOCUMENT_WRITE_ACTIONS, SLIDE_ACTIONS, SHEET_ACTIONS]) {
    expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length);
    expect(actions.every((action) => action.instruction.trim().length > 20)).toBe(true);
  }
});

test.each([
  ["sheet-tie-out", /Do not change any cells/],
  ["sheet-variance", /formulas/],
])("the %s action tells the assistant how far it may go", (id, rule) => {
  expect(SHEET_ACTIONS.find((action) => action.id === id)?.instruction).toMatch(rule);
});

test.each([
  ["clause-tighten", /legal effect/],
  ["figures-consistent", /Do not change any value/],
])("the %s action keeps what must not change", (id, rule) => {
  expect(DOCUMENT_SELECTION_ACTIONS.find((action) => action.id === id)?.instruction).toMatch(rule);
});

test.each([
  ["clause-tighten", true],
  ["conclusion-first", true],
  ["figures-consistent", true],
  ["clause-subclauses", false],
])("the %s action keeps the highlight's formatting: %s", (id, keeps) => {
  const action = DOCUMENT_SELECTION_ACTIONS.find((item) => item.id === id)!;

  expect(aiEditKeepsFormatting(aiEditIntent(action.instruction))).toBe(keeps);
});
