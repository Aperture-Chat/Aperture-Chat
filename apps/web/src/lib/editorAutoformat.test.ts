import { expect, test } from "vitest";
import { isDividerMarker, matchBlockAutoformat, matchInlineAutoformat } from "./editorAutoformat";

test("block markers followed by the typed space map to real block formats", () => {
  expect(matchBlockAutoformat("# ")).toMatchObject({ command: "formatBlock", value: "h1" });
  expect(matchBlockAutoformat("## ")).toMatchObject({ command: "formatBlock", value: "h2" });
  expect(matchBlockAutoformat("### ")).toMatchObject({ value: "h3" });
  expect(matchBlockAutoformat("- ")).toMatchObject({ command: "insertUnorderedList" });
  expect(matchBlockAutoformat("* ")).toMatchObject({ command: "insertUnorderedList" });
  expect(matchBlockAutoformat("1. ")).toMatchObject({ command: "insertOrderedList" });
  expect(matchBlockAutoformat("> ")).toMatchObject({ value: "blockquote" });
});

test("ordinary text never autoformats", () => {
  expect(matchBlockAutoformat("#")).toBeNull();
  expect(matchBlockAutoformat("#hashtag ")).toBeNull();
  expect(matchBlockAutoformat("Budget - ")).toBeNull();
  expect(matchBlockAutoformat("2. ")).toBeNull();
  expect(matchBlockAutoformat("#### ")).toBeNull();
});

test("closed inline markers become emphasis, unclosed or spaced ones do not", () => {
  expect(matchInlineAutoformat("Revenue grew **twelve percent**")).toEqual({
    start: 13,
    content: "twelve percent",
    kind: "bold",
  });
  expect(matchInlineAutoformat("a *quiet* word".slice(0, 9))).toMatchObject({ kind: "italic", content: "quiet" });
  expect(matchInlineAutoformat("use `npm test`")).toMatchObject({ kind: "code", content: "npm test" });
  expect(matchInlineAutoformat("~~old~~")).toMatchObject({ kind: "strike", content: "old" });
  // Typing the first closing star of a bold run must not produce italics.
  expect(matchInlineAutoformat("**bold*")).toBeNull();
  expect(matchInlineAutoformat("2 * 3 *")).toBeNull();
  expect(matchInlineAutoformat("snake_case_name")).toBeNull();
});

test("a line of dashes, stars or underscores is a divider", () => {
  expect(isDividerMarker("---")).toBe(true);
  expect(isDividerMarker("*****")).toBe(true);
  expect(isDividerMarker(" ___ ")).toBe(true);
  expect(isDividerMarker("--")).toBe(false);
  expect(isDividerMarker("-- notes")).toBe(false);
});
