import { describe, expect, test } from "vitest";
import { followOnMount, followOnScroll, isAppend, shouldPin } from "./codeFollow";

// A 200px view over 1000px of code; the bottom is at scrollTop 800.
const at = (scrollTop: number) => ({ scrollHeight: 1000, clientHeight: 200, scrollTop });

describe("followOnMount", () => {
  test("follows a block that does not overflow yet, or already sits at its bottom", () => {
    expect(followOnMount({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 })).toEqual({ paused: false, anchor: 0 });
    expect(followOnMount(at(760)).paused).toBe(false);
  });

  test("leaves a long block opened at its top alone", () => {
    expect(followOnMount(at(0))).toEqual({ paused: true, anchor: 0 });
    expect(followOnMount(at(752)).paused).toBe(true);
  });
});

describe("followOnScroll", () => {
  const following = { paused: false, anchor: 800 };

  test("a small nudge up near the bottom keeps following", () => {
    expect(followOnScroll(following, at(770))).toEqual({ paused: false, anchor: 770 });
  });

  test("scrolling up past the bottom band pauses", () => {
    expect(followOnScroll({ paused: false, anchor: 740 }, at(735)).paused).toBe(true);
  });

  test("a move of four pixels or less outside the band is not intent", () => {
    expect(followOnScroll({ paused: false, anchor: 740 }, at(736))).toEqual({ paused: false, anchor: 740 });
  });

  test("a paused reader stays paused while above the bottom, then resumes there", () => {
    expect(followOnScroll({ paused: true, anchor: 0 }, at(600))).toEqual({ paused: true, anchor: 600 });
    expect(followOnScroll({ paused: true, anchor: 600 }, at(790))).toEqual({ paused: false, anchor: 790 });
    expect(followOnScroll({ paused: true, anchor: 600 }, at(752)).paused).toBe(true);
  });
});

describe("isAppend", () => {
  test("only text added after the previous text counts", () => {
    expect(isAppend("a\nb", "a\nbc\nd")).toBe(true);
    expect(isAppend("a\nb", "a\nb")).toBe(false);
    expect(isAppend("a\nb", "x\nb\nc")).toBe(false);
  });
});

describe("shouldPin", () => {
  test("pins appended growth that left a gap while following", () => {
    expect(shouldPin(false, true, at(700))).toBe(true);
  });

  test("never pins when paused, not appended, or already at the bottom", () => {
    expect(shouldPin(true, true, at(700))).toBe(false);
    expect(shouldPin(false, false, at(700))).toBe(false);
    expect(shouldPin(false, true, at(799))).toBe(false);
  });
});
