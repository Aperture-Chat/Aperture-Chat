import { expect, test } from "vitest";
import {
  DOCUMENT_SELECTION_ACTIONS,
  aiActionMatches,
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
