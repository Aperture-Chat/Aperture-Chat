import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useModalFocus } from "./useModalFocus";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function frame() {
  const pending = Array.from(frames.values());
  frames.clear();
  act(() => pending.forEach((callback) => callback(performance.now())));
}

function Drawer() {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement | null>(null);
  useModalFocus(panel, open, () => setOpen(false));
  return <>
    <button onClick={() => setOpen(true)}>Open drawer</button>
    <button>Another control</button>
    {open && <section ref={panel} role="dialog" aria-modal="true" aria-label="Drawer" tabIndex={-1} style={{ visibility: "hidden" }}>
      <button>First action</button>
      <button>Last action</button>
    </section>}
  </>;
}

function openDrawer() {
  const view = render(<Drawer />);
  const trigger = screen.getByRole("button", { name: "Open drawer" });
  trigger.focus();
  fireEvent.click(trigger);
  return { ...view, trigger, panel: view.container.querySelector<HTMLElement>('[role="dialog"]')! };
}

test("focus enters a drawer whose visibility stays hidden through its first opening frame", () => {
  const { panel, trigger } = openDrawer();
  expect(trigger).toHaveFocus();
  frame();
  expect(trigger).toHaveFocus();
  panel.style.visibility = "visible";
  frame();
  const first = screen.getByRole("button", { name: "First action" });
  expect(first).toHaveFocus();
  expect(frames.size).toBe(0);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(screen.getByRole("button", { name: "Last action" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(panel).not.toBeInTheDocument();
});

test("opening retries stop when focus deliberately moves to another control", () => {
  const { panel } = openDrawer();
  const other = screen.getByRole("button", { name: "Another control" });
  other.focus();
  panel.style.visibility = "visible";
  frame();
  expect(other).toHaveFocus();
  expect(frames.size).toBe(0);
});

test("a drawer that remains hidden cannot keep scheduling focus retries", () => {
  const { trigger } = openDrawer();
  for (let index = 0; index < 12; index += 1) frame();
  expect(trigger).toHaveFocus();
  expect(frames.size).toBe(0);
});

test("closing the drawer cancels a pending opening retry", () => {
  const { trigger } = openDrawer();
  expect(frames.size).toBe(1);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(frames.size).toBe(0);
  expect(trigger).toHaveFocus();
});

test("a later modal owns focus before a hidden drawer finishes opening", () => {
  const { panel } = openDrawer();
  const laterDialog = document.createElement("section");
  laterDialog.setAttribute("role", "dialog");
  laterDialog.setAttribute("aria-modal", "true");
  document.body.append(laterDialog);
  try {
    panel.style.visibility = "visible";
    frame();
    expect(panel.contains(document.activeElement)).toBe(false);
    expect(frames.size).toBe(0);
  } finally {
    laterDialog.remove();
  }
});
