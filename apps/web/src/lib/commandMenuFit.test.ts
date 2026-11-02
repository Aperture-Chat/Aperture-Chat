import { describe, expect, it } from "vitest";
import { commandMenuFit, scrollTopShowingCaret } from "./commandMenuFit";

describe("commandMenuFit", () => {
  it("keeps the full height when there is room above the composer", () => {
    expect(commandMenuFit(700, 66)).toEqual({ folded: false, room: 340 });
  });

  it("shrinks to exactly the room there is, with a gap below the header", () => {
    expect(commandMenuFit(322, 66)).toEqual({ folded: false, room: 240 });
  });

  it("reaches the full height exactly when the room allows it", () => {
    expect(commandMenuFit(422, 66)).toEqual({ folded: false, room: 340 });
    expect(commandMenuFit(421, 66)).toEqual({ folded: false, room: 339 });
  });

  it("stays above down to a heading and two rows", () => {
    expect(commandMenuFit(230, 66)).toEqual({ folded: false, room: 148 });
  });

  it("folds into the composer when even that will not fit", () => {
    expect(commandMenuFit(229, 66)).toEqual({ folded: true });
  });

  it("folds when the composer starts above the header, as the expanded editor does", () => {
    expect(commandMenuFit(48, 66)).toEqual({ folded: true });
  });
});

describe("scrollTopShowingCaret", () => {
  it("brings the end of a draft back into a shrunken editor", () => {
    expect(scrollTopShowingCaret(700, 200, 1000, 1)).toBe(800);
  });

  it("leaves the text alone while the caret is already in view", () => {
    expect(scrollTopShowingCaret(300, 200, 1000, 0.4)).toBe(300);
  });

  it("treats the exact bottom of the view as in view", () => {
    expect(scrollTopShowingCaret(300, 200, 1000, 0.5)).toBe(300);
  });

  it("treats the exact top of the view as in view", () => {
    expect(scrollTopShowingCaret(300, 200, 1000, 0.3)).toBe(300);
  });

  it("scrolls up to a caret above the view", () => {
    expect(scrollTopShowingCaret(600, 200, 1000, 0.2)).toBe(200);
  });
});
