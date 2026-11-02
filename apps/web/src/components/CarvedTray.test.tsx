import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CarvedTray, sendScrollKeysToTray } from "./CarvedTray";

function Panel() {
  const tray = useRef<HTMLDivElement>(null);
  return (
    <aside onKeyDown={(event) => sendScrollKeysToTray(event, tray.current)}>
      <header>
        <button type="button">Close</button>
      </header>
      <CarvedTray ref={tray}>
        <button type="button">First row</button>
        <textarea aria-label="Note" />
      </CarvedTray>
    </aside>
  );
}

const tray = () => document.querySelector<HTMLElement>(".carved-tray-scroll")!;

describe("CarvedTray", () => {
  it("hands page keys pressed on the panel's header to the tray, which is what scrolls now", () => {
    render(<Panel />);
    const close = screen.getByRole("button", { name: "Close" });

    for (const key of ["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End"]) {
      close.focus();
      fireEvent.keyDown(close, { key });
      expect(document.activeElement, key).toBe(tray());
    }
  });

  it("leaves the keys that press or leave the focused button alone", () => {
    render(<Panel />);
    const close = screen.getByRole("button", { name: "Close" });

    for (const key of [" ", "Enter", "Tab", "Escape", "a"]) {
      close.focus();
      fireEvent.keyDown(close, { key });
      expect(document.activeElement, JSON.stringify(key)).toBe(close);
    }
  });

  it("does not pull focus out of a field or row inside the tray", () => {
    render(<Panel />);
    const note = screen.getByRole("textbox", { name: "Note" });
    note.focus();

    fireEvent.keyDown(note, { key: "ArrowDown" });

    expect(document.activeElement).toBe(note);
  });

  it("stays off the Tab order, so a keyboard user lands on rows and not the tray", () => {
    render(<Panel />);

    expect(tray().tabIndex).toBe(-1);
  });
});
