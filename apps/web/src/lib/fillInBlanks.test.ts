import { expect, test } from "vitest";
import { splitFillInBlanks } from "./fillInBlanks";

test("a run of three or more underscores is a fill-in blank, kept with every character around it", () => {
  expect(splitFillInBlanks("known as ____ consisting")).toEqual([
    { text: "known as ", blank: false },
    { text: "____", blank: true },
    { text: " consisting", blank: false },
  ]);
});

test("a blank written flush against a word splits from that word", () => {
  expect(splitFillInBlanks("____________SMA”),")).toEqual([
    { text: "____________", blank: true },
    { text: "SMA”),", blank: false },
  ]);
});

test("one or two underscores and plain text are not blanks", () => {
  expect(splitFillInBlanks("snake_case __init__")).toEqual([{ text: "snake_case __init__", blank: false }]);
  expect(splitFillInBlanks("")).toEqual([]);
});
