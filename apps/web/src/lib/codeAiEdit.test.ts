import { describe, expect, test } from "vitest";
import {
  CODE_INLINE_EDIT_PREFIX,
  applyCodeReplacement,
  codeEditMessages,
  codeEditRefineMessages,
  codeLineDiff,
  codeReplacementFromReply,
  codeSelectionLabel,
  codeSelectionLines,
} from "./codeAiEdit";

const CODE = ["def total(items):", "    result = 0", "    for item in items:", "        result += item", "    return result", ""].join("\n");

function selectionOf(code: string, text: string) {
  const start = code.indexOf(text);
  return { start, end: start + text.length };
}

describe("codeEditMessages", () => {
  test("asks for a replacement of exactly the selection, with the code around it", () => {
    const selection = selectionOf(CODE, "    for item in items:\n        result += item\n");
    const [system, user] = codeEditMessages({ code: CODE, language: "python", selection, instruction: "Use sum()" });

    expect(system?.role).toBe("system");
    expect(system?.content).toMatch(/only the replacement code/i);
    expect(user?.role).toBe("user");
    expect(user?.content.startsWith(CODE_INLINE_EDIT_PREFIX)).toBe(true);
    expect(user?.content).toContain("Language: python");
    expect(user?.content).toContain("User instruction:\nUse sum()");
    expect(user?.content).toContain("Code before the selection:\n<<<\ndef total(items):\n    result = 0\n>>>");
    expect(user?.content).toContain("Selected code (replace exactly this):\n<<<\n    for item in items:\n        result += item\n>>>");
    expect(user?.content).toContain("Code after the selection:\n<<<\n    return result\n>>>");
  });

  test("keeps only the nearest context around a selection in a very long file", () => {
    const long = `${"a = 1\n".repeat(5_000)}TARGET\n${"b = 2\n".repeat(5_000)}`;
    const [, user] = codeEditMessages({ code: long, language: "python", selection: selectionOf(long, "TARGET"), instruction: "x" });
    expect(user!.content.length).toBeLessThan(30_000);
    expect(user!.content).toContain("a = 1\n>>>");
    expect(user!.content).toContain("<<<\n\nb = 2");
  });

  test("names an untagged block's language as unknown", () => {
    const [, user] = codeEditMessages({ code: "x", language: " ", selection: { start: 0, end: 1 }, instruction: "y" });
    expect(user!.content).toContain("Language: unknown");
  });

  test("refinement continues the same conversation with the previous reply", () => {
    const first = codeEditMessages({ code: CODE, language: "python", selection: selectionOf(CODE, "result"), instruction: "rename" });
    const refined = codeEditRefineMessages(first, "total_sum", "Use snake_case plural");
    expect(refined.slice(0, 2)).toEqual(first);
    expect(refined[2]).toEqual({ role: "assistant", content: "total_sum" });
    expect(refined[3]?.role).toBe("user");
    expect(refined[3]?.content).toContain("Use snake_case plural");
  });
});

describe("codeReplacementFromReply", () => {
  test("unwraps a fenced reply, with or without a lead-in sentence", () => {
    expect(codeReplacementFromReply("```python\nreturn sum(items)\n```", "return result")).toBe("return sum(items)");
    expect(codeReplacementFromReply("Here is the change:\n\n```\nx = 2\n```\nDone.", "x = 1")).toBe("x = 2");
  });

  test("restores the selection's indentation when the model drops it", () => {
    const selected = "    for item in items:\n        result += item";
    expect(codeReplacementFromReply("result = sum(items)", selected)).toBe("    result = sum(items)");
    expect(codeReplacementFromReply("if x:\n    y()", selected)).toBe("    if x:\n        y()");
  });

  test("restores the shallowest indentation the selection had", () => {
    expect(codeReplacementFromReply("x()", "        deep()\n    shallow()\n        deep()")).toBe("    x()");
  });

  test("keeps the model's indentation when it already matches", () => {
    expect(codeReplacementFromReply("    a = 1\n    b = 2", "    a = 0")).toBe("    a = 1\n    b = 2");
  });

  test("keeps a trailing line break only when the selection had one", () => {
    expect(codeReplacementFromReply("x = 2\n\n", "x = 1\n")).toBe("x = 2\n");
    expect(codeReplacementFromReply("x = 2\n", "x = 1")).toBe("x = 2");
    expect(codeReplacementFromReply("\n\nx = 2", "x = 1")).toBe("x = 2");
  });

  test("rejects an empty reply", () => {
    expect(codeReplacementFromReply("  \n```\n```\n", "x = 1")).toBeNull();
  });
});

test("applyCodeReplacement swaps only the selected range", () => {
  const selection = selectionOf(CODE, "result = 0");
  expect(applyCodeReplacement(CODE, selection, "result = 1")).toBe(CODE.replace("result = 0", "result = 1"));
});

describe("selection descriptions", () => {
  test("names a short in-line selection by its text and a longer one by its lines", () => {
    expect(codeSelectionLabel(CODE, selectionOf(CODE, "items"))).toBe("“items”");
    expect(codeSelectionLabel(CODE, selectionOf(CODE, "result = 0\n    for"))).toBe("Lines 2–3");
    expect(codeSelectionLabel(CODE, selectionOf(CODE, "    return result\n"))).toBe("Line 5");
  });

  test("shortens a long in-line selection to sixty characters", () => {
    const sixty = "x".repeat(60);
    expect(codeSelectionLabel(sixty, { start: 0, end: 60 })).toBe(`“${sixty}”`);
    expect(codeSelectionLabel(`${sixty}yz`, { start: 0, end: 62 })).toBe(`“${sixty}…”`);
  });

  test("codeSelectionLines finds the last line when the code has no final line break", () => {
    expect(codeSelectionLines("a\nb\nc", { start: 4, end: 5 })).toEqual({ first: 2, last: 2 });
    expect(codeSelectionLines("a\nb\nc", { start: 0, end: 5 })).toEqual({ first: 0, last: 2 });
  });

  test("codeSelectionLines counts a blank first line", () => {
    expect(codeSelectionLines("\nb", { start: 1, end: 2 })).toEqual({ first: 1, last: 1 });
  });

  test("codeSelectionLines ignores the line a trailing line break ends on", () => {
    expect(codeSelectionLines(CODE, selectionOf(CODE, "    result = 0\n"))).toEqual({ first: 1, last: 1 });
    expect(codeSelectionLines(CODE, selectionOf(CODE, "total"))).toEqual({ first: 0, last: 0 });
  });
});

describe("codeLineDiff", () => {
  test("marks removed, added, and unchanged lines with their numbers", () => {
    expect(codeLineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a", before: 0, after: 0 },
      { kind: "remove", text: "b", before: 1 },
      { kind: "add", text: "B", after: 1 },
      { kind: "same", text: "c", before: 2, after: 2 },
      { kind: "add", text: "d", after: 3 },
    ]);
  });

  test("keeps the longest run of unchanged lines when lines move", () => {
    expect(codeLineDiff("x\na\nb", "a\nb")).toEqual([
      { kind: "remove", text: "x", before: 0 },
      { kind: "same", text: "a", before: 1, after: 0 },
      { kind: "same", text: "b", before: 2, after: 1 },
    ]);
    expect(codeLineDiff("a", "b\na")).toEqual([
      { kind: "add", text: "b", after: 0 },
      { kind: "same", text: "a", before: 0, after: 1 },
    ]);
    expect(codeLineDiff("b\na", "a")).toEqual([
      { kind: "remove", text: "b", before: 0 },
      { kind: "same", text: "a", before: 1, after: 0 },
    ]);
    expect(codeLineDiff("a\nx\nb\ny\nc", "a\nb\nc\nz")).toEqual([
      { kind: "same", text: "a", before: 0, after: 0 },
      { kind: "remove", text: "x", before: 1 },
      { kind: "same", text: "b", before: 2, after: 1 },
      { kind: "remove", text: "y", before: 3 },
      { kind: "same", text: "c", before: 4, after: 2 },
      { kind: "add", text: "z", after: 3 },
    ]);
  });

  test("pairs repeated lines with their nearest match", () => {
    const rows = (before: string, after: string) =>
      codeLineDiff(before, after).map((row) => `${{ same: "=", add: "+", remove: "-" }[row.kind]}${row.text}`);
    expect(rows("a\na", "b\na\na")).toEqual(["+b", "=a", "=a"]);
    expect(rows("a\na", "b\na")).toEqual(["-a", "+b", "=a"]);
  });

  test("numbers trailing removals and additions after the last match", () => {
    expect(codeLineDiff("a\nb\nc", "a")).toEqual([
      { kind: "same", text: "a", before: 0, after: 0 },
      { kind: "remove", text: "b", before: 1 },
      { kind: "remove", text: "c", before: 2 },
    ]);
    expect(codeLineDiff("a", "a\nb\nc")).toEqual([
      { kind: "same", text: "a", before: 0, after: 0 },
      { kind: "add", text: "b", after: 1 },
      { kind: "add", text: "c", after: 2 },
    ]);
  });

  test("compares line by line up to 250,000 line pairs", () => {
    const lines = (prefix: string, count: number) => ["shared", ...Array.from({ length: count - 1 }, (_, index) => `${prefix} ${index}`)].join("\n");
    expect(codeLineDiff(lines("old", 500), lines("new", 500))[0]).toEqual({ kind: "same", text: "shared", before: 0, after: 0 });
    expect(codeLineDiff(lines("old", 501), lines("new", 500))[0]).toEqual({ kind: "remove", text: "shared", before: 0 });
  });

  test("falls back to a plain before/after listing for huge selections", () => {
    const before = Array.from({ length: 700 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 700 }, (_, index) => `new ${index}`).join("\n");
    const rows = codeLineDiff(before, after);
    expect(rows).toHaveLength(1_400);
    expect(rows[0]).toEqual({ kind: "remove", text: "old 0", before: 0 });
    expect(rows[700]).toEqual({ kind: "add", text: "new 0", after: 0 });
  });
});
