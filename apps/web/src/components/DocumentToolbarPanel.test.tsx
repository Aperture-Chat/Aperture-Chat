import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import { DocumentToolbarPanel } from "./DocumentToolbarPanel";
import { SelectControl } from "./SelectControl";

function Fixture() {
  const [open, setOpen] = useState(false);
  const [font, setFont] = useState("serif");
  return <><DocumentToolbarPanel label="Text" title="Text formatting" open={open}
    onToggle={() => setOpen(value => !value)} onClose={() => setOpen(false)}>
    <SelectControl aria-label="Font" value={font} onChange={event => setFont(event.target.value)}>
      <option value="serif">Serif</option><option value="sans">Sans</option>
    </SelectControl>
  </DocumentToolbarPanel><button>Editor surface</button></>;
}

test("secondary controls are hidden until opened, and Escape restores trigger focus", async () => {
  render(<Fixture />);
  expect(screen.queryByRole("combobox", { name: "Font" })).not.toBeInTheDocument();
  const trigger = screen.getByRole("button", { name: "Text options" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Font" })).toHaveFocus());
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Font" }), { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("portalled font options remain interactive and an outside click dismisses the panel", () => {
  render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "Text options" }));
  const select = screen.getByRole("combobox", { name: "Font" });
  fireEvent.mouseDown(select);
  const option = document.querySelectorAll<HTMLButtonElement>(".apx-select-option")[1];
  fireEvent.pointerDown(option);
  fireEvent.mouseDown(option);
  fireEvent.click(option);
  expect(select).toHaveValue("sans");
  expect(screen.getByRole("region", { name: "Text formatting" })).toBeVisible();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Editor surface" }));
  expect(screen.queryByRole("region", { name: "Text formatting" })).not.toBeInTheDocument();
});
