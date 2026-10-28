import { beforeAll, describe, expect, test } from "vitest";
import {
  highlightCodeLines,
  loadCodeHighlighter,
  readyCodeHighlighter,
  type CodeHighlighter,
  type HighlightedLine,
} from "./codeHighlight";

let engine: CodeHighlighter;

beforeAll(async () => {
  engine = await loadCodeHighlighter();
});

function lineText(line: HighlightedLine) {
  return line.map((token) => token.text).join("");
}

function scopeOf(lines: HighlightedLine[] | null, text: string) {
  return lines?.flat().find((token) => token.text === text)?.scope ?? null;
}

describe("highlightCodeLines", () => {
  test("colors keywords, strings, and comments with highlight.js scopes", () => {
    const lines = highlightCodeLines(engine, 'const greeting = "hi"; // say hi', "javascript");
    expect(scopeOf(lines, "const")).toBe("hljs-keyword");
    expect(scopeOf(lines, '"hi"')).toBe("hljs-string");
    expect(scopeOf(lines, "// say hi")).toBe("hljs-comment");
  });

  test("keeps one token line per source line, even inside multi-line comments", () => {
    const code = "/* first\n   second */\nlet x = 1;\n";
    const lines = highlightCodeLines(engine, code, "ts");
    expect(lines?.map(lineText)).toEqual(code.split("\n"));
    expect(lines?.[1]?.[0]).toEqual({ text: "   second */", scope: "hljs-comment" });
    expect(lines?.[2]?.[1]).toEqual({ text: " x = " });
  });

  test("returns the literal characters highlight.js escapes as entities", () => {
    const code = `if (a < b && c > d) { s = '"q"'; }`;
    expect(highlightCodeLines(engine, code, "js")?.map(lineText)).toEqual([code]);
  });

  test("resolves common fence aliases", () => {
    expect(scopeOf(highlightCodeLines(engine, "def run():\n    pass", "py"), "def")).toBe("hljs-keyword");
    expect(scopeOf(highlightCodeLines(engine, "echo hi", "sh"), "echo")).toBe("hljs-built_in");
    expect(scopeOf(highlightCodeLines(engine, "key: value", "yml"), "key:")).toBe("hljs-attr");
    expect(scopeOf(highlightCodeLines(engine, "<div>hi</div>", "vue"), "div")).toBe("hljs-name");
    expect(scopeOf(highlightCodeLines(engine, "FROM node:24", "Dockerfile"), "FROM")).toBe("hljs-keyword");
  });

  test("still colors code with a slip the grammar calls illegal", () => {
    expect(scopeOf(highlightCodeLines(engine, '{"a": 1, b: 2}', "json"), '"a"')).toBe("hljs-attr");
  });

  test("leaves plain-text, output, and unknown fences uncolored", () => {
    expect(highlightCodeLines(engine, "const x = 1;", "text")).toBeNull();
    expect(highlightCodeLines(engine, "const x = 1;", "output")).toBeNull();
    expect(highlightCodeLines(engine, "const x = 1;", "not-a-language")).toBeNull();
  });

  test("detects the language of an untagged fence only when the evidence is strong", () => {
    const python = "import os\n\ndef main():\n    for name in os.listdir('.'):\n        print(name)\n";
    expect(scopeOf(highlightCodeLines(engine, python, ""), "def")).toBe("hljs-keyword");
    expect(highlightCodeLines(engine, "Remember to water the plants on Tuesday.", "")).toBeNull();
  });

  test("detects untagged code up to 20,000 characters", () => {
    const python = "def main():\n    return 1\n";
    const padded = (length: number) => python + "#".repeat(length - python.length);
    expect(highlightCodeLines(engine, padded(20_000), "")).not.toBeNull();
    expect(highlightCodeLines(engine, padded(20_001), "")).toBeNull();
  });

  test("skips sources too large to color without stalling the page", () => {
    expect(highlightCodeLines(engine, "x".repeat(200_000), "python")).not.toBeNull();
    expect(highlightCodeLines(engine, "x".repeat(200_001), "python")).toBeNull();
  });
});

test("the loaded highlighter is available synchronously afterwards", () => {
  expect(readyCodeHighlighter()).toBe(engine);
});
