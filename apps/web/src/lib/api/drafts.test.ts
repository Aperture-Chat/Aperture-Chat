import { expect, test } from "vitest";
import { draftTitleForAccount, MAX_DRAFT_TITLE_CHARS } from "./drafts";

test("titles within the server limit pass through with whitespace collapsed", () => {
  expect(draftTitleForAccount("  Napoleon \n Draft  ")).toBe("Napoleon Draft");
  expect(draftTitleForAccount("   ")).toBe("");
  const exact = "a".repeat(MAX_DRAFT_TITLE_CHARS);
  expect(draftTitleForAccount(exact)).toBe(exact);
});

test("long titles are shortened at a word boundary to fit the server limit", () => {
  const title = draftTitleForAccount(`Napoleon and Make Sure ${"to Include Pictures, ".repeat(20)}`);
  expect(Array.from(title).length).toBeLessThanOrEqual(MAX_DRAFT_TITLE_CHARS);
  expect(title).toMatch(/^Napoleon and Make Sure to Include Pictures.*\b(?:to|Include|Pictures)…$/);
});

test("the limit counts characters as the server does and never splits an emoji", () => {
  const title = draftTitleForAccount("🦅".repeat(300));
  expect(Array.from(title)).toHaveLength(MAX_DRAFT_TITLE_CHARS);
  expect(title.endsWith("🦅…")).toBe(true);
});
