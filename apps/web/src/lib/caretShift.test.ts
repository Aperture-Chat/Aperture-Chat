import { expect, it } from "vitest";
import { shiftedCaretOffset } from "./caretShift";

it("moves the caret by text someone else added before it, and not by text after it", () => {
  expect(shiftedCaretOffset(10, "Hello world, friend", "Hi! Hello world, friend")).toBe(14);
  expect(shiftedCaretOffset(3, "Hello world", "Hello world, friend")).toBe(3);
  expect(shiftedCaretOffset(8, "Hello world", "Hello")).toBe(5);
});

it("puts a caret inside text that was rewritten at the end of the new text", () => {
  expect(shiftedCaretOffset(9, "Due in thirty days.", "Due in sixty days.")).toBe(10); // after "six", replacing "thir"
});

it("keeps the caret before text someone added right at it, and after text added before it", () => {
  expect(shiftedCaretOffset(3, "abc", "abcd")).toBe(3);
  expect(shiftedCaretOffset(1, "ab", "xab")).toBe(2);
  expect(shiftedCaretOffset(0, "", "new")).toBe(0);
  expect(shiftedCaretOffset(2, "ab", "ab")).toBe(2);
});
