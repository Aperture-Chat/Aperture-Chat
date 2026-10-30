import { describe, expect, it } from "vitest";
import { ERR, type Scalar } from "../values";
import { hasWildcards, makeCriterion, wildcardToRegExp } from "./criteria";

const SAMPLE: Scalar[] = [null, "", 0, 5, 10, "5", "10", "apple", "Apple pie", "b", true, false, ERR.na, "3/1/2027", 46447];

/** Which of the sample values a criterion accepts. */
const accepts = (criteria: Scalar) => SAMPLE.filter((value) => makeCriterion(criteria)(value));

describe("makeCriterion", () => {
  it("typed numbers, booleans, blanks, and errors", () => {
    expect(accepts(5)).toEqual([5, "5"]);
    expect(accepts(true)).toEqual([true]);
    expect(accepts(null)).toEqual([null, ""]);
    expect(accepts(ERR.na)).toEqual([]);
  });

  it("empty operands match blank and non-blank cells", () => {
    expect(accepts("")).toEqual([null, ""]);
    expect(accepts("=")).toEqual([null, ""]);
    expect(accepts("<>")).toEqual(SAMPLE.slice(2));
  });

  it("numeric operands compare numbers; = and <> also read numeric text", () => {
    expect(accepts(">5")).toEqual([10, 46447]);
    expect(accepts(">=5")).toEqual([5, 10, 46447]);
    expect(accepts("<5")).toEqual([0]);
    expect(accepts("<=5")).toEqual([0, 5]);
    expect(accepts("=10")).toEqual([10, "10"]);
    expect(accepts("=0")).toEqual([0]);
    expect(accepts("<>10")).toEqual(SAMPLE.filter((value) => value !== 10 && value !== "10"));
    expect(accepts(">=3/1/2027")).toEqual([46447]);
  });

  it("TRUE and FALSE operands match booleans", () => {
    expect(accepts("TRUE")).toEqual([true]);
    expect(accepts("<>false")).toEqual(SAMPLE.filter((value) => value !== false));
  });

  it("text operands use wildcards for = and <>, and text order otherwise", () => {
    expect(accepts("apple*")).toEqual(["apple", "Apple pie"]);
    expect(accepts("=?")).toEqual(["5", "b"]);
    expect(accepts("<>apple")).toEqual(SAMPLE.filter((value) => value !== "apple"));
    expect(accepts(">apple")).toEqual(["Apple pie", "b"]);
    expect(accepts("<b")).toEqual(["", "5", "10", "apple", "Apple pie", "3/1/2027"]);
    expect(accepts("<=b")).toEqual(["", "5", "10", "apple", "Apple pie", "b", "3/1/2027"]);
    expect(accepts(">=b")).toEqual(["b"]);
  });

  it("~ escapes wildcard characters", () => {
    expect(wildcardToRegExp("a~*").test("a*")).toBe(true);
    expect(wildcardToRegExp("a~*").test("ab")).toBe(false);
    expect(wildcardToRegExp("a~*").test("a*b")).toBe(false);
    expect(wildcardToRegExp("a~").test("a~")).toBe(true);
    expect([hasWildcards("a*"), hasWildcards("a~*"), hasWildcards("plain")]).toEqual([true, false, false]);
  });
});
