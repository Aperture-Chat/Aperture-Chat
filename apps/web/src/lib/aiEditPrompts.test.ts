import { expect, test } from "vitest";
import {
  AI_TRANSLATE_CHIPS,
  DOCUMENT_SELECTION_ACTIONS,
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
