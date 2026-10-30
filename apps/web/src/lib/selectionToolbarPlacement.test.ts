import { describe, expect, it } from "vitest";
import { placeSelectionToolbar } from "./selectionToolbarPlacement";

const TOOLBAR = { width: 240, height: 40 };
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const line = (top: number, left = 100, right = 220) => ({ top, bottom: top + 22, left, right });

describe("placeSelectionToolbar", () => {
  it("floats above the highlight with a mouse, like Word's mini toolbar", () => {
    expect(placeSelectionToolbar(line(400), TOOLBAR, DESKTOP, false)).toEqual({ top: 350, left: 40, below: false });
  });

  it("drops below the highlight with a mouse when the top of the screen is too close", () => {
    expect(placeSelectionToolbar(line(80), TOOLBAR, DESKTOP, false)).toMatchObject({ top: 112, below: true });
  });

  it("goes below the highlight on touch screens, clear of the phone's own copy menu and handles", () => {
    expect(placeSelectionToolbar(line(400), TOOLBAR, PHONE, true)).toMatchObject({ top: 450, below: true });
  });

  it("flips above on touch screens when there is no room below", () => {
    expect(placeSelectionToolbar(line(790), TOOLBAR, PHONE, true)).toMatchObject({ top: 722, below: false });
  });

  it("keeps the toolbar inside the screen edges", () => {
    expect(placeSelectionToolbar(line(400, 0, 20), TOOLBAR, PHONE, true).left).toBe(8);
    expect(placeSelectionToolbar(line(400, 360, 388), TOOLBAR, PHONE, true).left).toBe(PHONE.width - TOOLBAR.width - 8);
  });

  it("uses the preferred side when the toolbar fits it exactly, and flips when it is a pixel short", () => {
    // Touch: below fits when its bottom lands on the 8px screen margin.
    expect(placeSelectionToolbar(line(746), TOOLBAR, PHONE, true)).toMatchObject({ top: 796, below: true });
    expect(placeSelectionToolbar(line(750), TOOLBAR, PHONE, true)).toMatchObject({ top: 682, below: false });
    // Touch with no room below: above is used even when it lands right on the header clearance.
    expect(placeSelectionToolbar(line(132), TOOLBAR, { width: 390, height: 200 }, true)).toMatchObject({ top: 64, below: false });
    // Mouse: above is used when it lands right on the header clearance.
    expect(placeSelectionToolbar(line(114), TOOLBAR, DESKTOP, false)).toMatchObject({ top: 64, below: false });
  });
});
