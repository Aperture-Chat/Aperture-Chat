import { describe, expect, it } from "vitest";
import { arity, numberArg } from "./helpers";

describe("arity", () => {
  it("reads argument counts from an Excel signature", () => {
    expect(arity("")).toEqual({ min: 0, max: 0 });
    expect(arity("number, num_digits")).toEqual({ min: 2, max: 2 });
    expect(arity("text, [num_chars]")).toEqual({ min: 1, max: 2 });
    expect(arity("number1, [number2], ...")).toEqual({ min: 1, max: 255 });
    expect(arity("sum_range, criteria_range1, criteria1, [criteria_range2, criteria2], ...")).toEqual({ min: 3, max: 255 });
    expect(arity("[rows], columns")).toEqual({ min: 1, max: 2 });
  });
});

describe("numberArg", () => {
  it("coerces a scalar or the top-left item of an array", () => {
    expect([numberArg("5"), numberArg(true), numberArg([["2", 9]]), numberArg(null)]).toEqual([5, 1, 2, 0]);
  });
});
