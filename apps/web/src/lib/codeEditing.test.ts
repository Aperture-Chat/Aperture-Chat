import { describe, expect, test } from "vitest";
import { codeIndentUnit, indentEdit, lineBreakEdit, outdentEdit } from "./codeEditing";

describe("codeIndentUnit", () => {
  test("follows the indentation the code already uses", () => {
    expect(codeIndentUnit("if x:\n    y()\n", "python")).toBe("    ");
    expect(codeIndentUnit("function a() {\n  b();\n}", "js")).toBe("  ");
    expect(codeIndentUnit("func a() {\n\tb()\n}", "go")).toBe("\t");
  });

  test("accepts space indents from two to eight wide", () => {
    expect(codeIndentUnit("if x:\n  y()", "python")).toBe("  ");
    expect(codeIndentUnit("a\n        b", "js")).toBe("        ");
    expect(codeIndentUnit("a\n b", "js")).toBe("  ");
    expect(codeIndentUnit("a\n         b", "python")).toBe("    ");
  });

  test("measures spaces only when most lines use them", () => {
    expect(codeIndentUnit("a\n\tb\n    c\n    d", "js")).toBe("    ");
  });

  test("defaults to four spaces for Python and two elsewhere", () => {
    expect(codeIndentUnit("x = 1", "python")).toBe("    ");
    expect(codeIndentUnit("x = 1", "javascript")).toBe("  ");
  });
});

describe("indentEdit", () => {
  test("inserts one indent at a caret", () => {
    expect(indentEdit("ab", 1, 1, "  ")).toEqual({ start: 1, end: 1, text: "  ", selectStart: 3, selectEnd: 3 });
  });

  test("leaves the next line alone when the selection ends on a line break", () => {
    expect(indentEdit("a\nbc\nd", 0, 2, "  ")).toEqual({ start: 0, end: 1, text: "  a", selectStart: 0, selectEnd: 3 });
  });

  test("indents every line a selection touches and keeps them selected", () => {
    const value = "a\nb\nc";
    expect(indentEdit(value, 0, 3, "  ")).toEqual({ start: 0, end: 3, text: "  a\n  b", selectStart: 0, selectEnd: 7 });
  });
});

describe("outdentEdit", () => {
  test("removes up to one indent from each touched line", () => {
    expect(outdentEdit("    a\n  b\nc", 0, 9, "    ")).toEqual({
      start: 0,
      end: 9,
      text: "a\nb",
      selectStart: 0,
      selectEnd: 3,
    });
  });

  test("outdents the caret's line, even at its very start", () => {
    expect(outdentEdit("  a\n  b", 4, 4, "  ")).toEqual({ start: 4, end: 7, text: "b", selectStart: 4, selectEnd: 4 });
    expect(outdentEdit("    abc", 6, 6, "  ")).toEqual({ start: 0, end: 7, text: "  abc", selectStart: 4, selectEnd: 4 });
  });

  test("removes a tab, or four spaces when the code indents with tabs", () => {
    expect(outdentEdit("\tx", 0, 2, "\t")?.text).toBe("x");
    expect(outdentEdit("      x", 0, 7, "\t")?.text).toBe("  x");
  });

  test("returns null when nothing is indented", () => {
    expect(outdentEdit("a\nb", 0, 3, "  ")).toBeNull();
  });
});

describe("lineBreakEdit", () => {
  test("keeps the current line's indentation", () => {
    expect(lineBreakEdit("    x = 1", 9, 9, "    ")).toEqual({ start: 9, end: 9, text: "\n    ", selectStart: 14, selectEnd: 14 });
  });

  test("indents one level after an opening bracket or colon", () => {
    expect(lineBreakEdit("if x:", 5, 5, "    ").text).toBe("\n    ");
    expect(lineBreakEdit("  call(", 7, 7, "  ").text).toBe("\n    ");
  });

  test("splits a bracket pair onto its own lines with the caret between", () => {
    expect(lineBreakEdit("f() {}", 5, 5, "  ")).toEqual({ start: 5, end: 5, text: "\n  \n", selectStart: 8, selectEnd: 8 });
  });

  test("reads the indentation of the caret's own line, not the next one", () => {
    expect(lineBreakEdit("    x = 1\ny = 2", 9, 9, "    ").text).toBe("\n    ");
  });

  test("replaces a selection with the line break", () => {
    expect(lineBreakEdit("ab cd", 2, 3, "  ")).toEqual({ start: 2, end: 3, text: "\n", selectStart: 3, selectEnd: 3 });
  });
});
