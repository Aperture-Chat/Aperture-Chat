import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolbarMenu } from "./SheetToolbar";

function rect(left: number, width: number): DOMRect {
  return { left, right: left + width, width, top: 40, bottom: 240, height: 200, x: left, y: 40, toJSON: () => ({}) } as DOMRect;
}

/** Opens a menu whose box (before any shift) sits at `left`; `clip` puts it in
 * a pane that hides overflow, like the Drafts editor pane. */
function openMenuAt(left: number, width = 260, clip?: { left: number; right: number }) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    // Like a browser, the box reports where the menu's current shift put it.
    const moved = Number(/translateX\((-?[\d.]+)px\)/.exec(this.style.transform)?.[1] ?? 0);
    if (this.classList.contains("sheet-menu")) return rect(left + moved, width);
    if (clip && this.dataset.pane === "clip") return rect(clip.left, clip.right - clip.left);
    return rect(0, 30);
  });
  const menu = <ToolbarMenu label="More formatting" icon={<span>More</span>} tooltip="More">{() => <button type="button">Item</button>}</ToolbarMenu>;
  render(clip ? <div data-pane="clip" style={{ overflowX: "hidden" }}>{menu}</div> : menu);
  fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
  return screen.getByRole("menu", { name: "More formatting" });
}

describe("toolbar menus stay on screen", () => {
  afterEach(() => vi.restoreAllMocks());

  // A transform moves the menu whichever side it is anchored to; a margin
  // does nothing to a menu anchored by its right edge (More is).
  it("slides a menu that would run off the left edge back into view", () => {
    const menu = openMenuAt(-120);
    expect(menu.style.transform).toBe("translateX(128px)");
    expect(menu.style.marginLeft).toBe("");
  });

  it("slides a menu that would run off the right edge back into view", () => {
    expect(openMenuAt(window.innerWidth - 100).style.transform).toBe("translateX(-168px)");
  });

  it("leaves a menu that fits where it is", () => {
    expect(openMenuAt(200).style.transform).toBe("");
  });

  it("keeps the left edge of a menu wider than the window in view", () => {
    expect(openMenuAt(8, window.innerWidth + 200).style.transform).toBe("");
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    expect(openMenuAt(40, window.innerWidth + 200).style.transform).toBe("translateX(-32px)");
  });

  it("stays inside a pane that hides what sticks out of it, not just the window", () => {
    expect(openMenuAt(250, 260, { left: 300, right: 900 }).style.transform).toBe("translateX(58px)");
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    expect(openMenuAt(700, 260, { left: 300, right: 900 }).style.transform).toBe("translateX(-68px)");
  });

  it("measures a reopened menu where it falls, not where the last opening slid it", () => {
    openMenuAt(-120);
    const button = screen.getByRole("button", { name: "More formatting" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole("menu", { name: "More formatting" }).style.transform).toBe("translateX(128px)");
  });

  it("measures each opening afresh", () => {
    openMenuAt(-120);
    const button = screen.getByRole("button", { name: "More formatting" });
    fireEvent.click(button);
    vi.restoreAllMocks();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("sheet-menu") ? rect(300, 260) : rect(0, 30);
    });
    fireEvent.click(button);
    expect(screen.getByRole("menu", { name: "More formatting" }).style.transform).toBe("");
  });
});

describe("toolbar menus close like menus elsewhere", () => {
  afterEach(() => vi.restoreAllMocks());

  it("closes on a press anywhere outside, and stays open for a press inside", () => {
    const menu = openMenuAt(200);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Item" }));
    expect(screen.getByRole("menu", { name: "More formatting" })).toBe(menu);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "More formatting" })).toBeNull();
  });
});
