import { describe, expect, it } from "vitest";
import { stepFontSize } from "./SheetToolbar";

describe("stepFontSize", () => {
  it("moves to the next size on the toolbar's list, as Excel's Increase and Decrease Font Size do", () => {
    expect(stepFontSize(10, "up")).toBe(11);
    expect(stepFontSize(10, "down")).toBe(9);
    expect(stepFontSize(13, "up")).toBe(14);
    expect(stepFontSize(13, "down")).toBe(12);
  });

  it("stops at the ends of the list", () => {
    expect(stepFontSize(36, "up")).toBe(36);
    expect(stepFontSize(8, "down")).toBe(8);
    expect(stepFontSize(72, "up")).toBe(36);
    expect(stepFontSize(6, "down")).toBe(8);
  });
});
