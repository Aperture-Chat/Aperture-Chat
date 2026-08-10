import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import { SelectControl } from "./SelectControl";

function Harness({ onChangeValue }: { onChangeValue?: (value: string) => void }) {
  const [value, setValue] = useState("weekly");
  return (
    <SelectControl
      aria-label="Trigger"
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
        onChangeValue?.(event.target.value);
      }}
    >
      <option value="weekly">Weekly</option>
      <option value="once">Once</option>
      <option value="cron">Cron expression</option>
    </SelectControl>
  );
}

test("keeps a real select working for forms and fireEvent.change", () => {
  const seen: string[] = [];
  render(<Harness onChangeValue={(value) => seen.push(value)} />);

  const select = screen.getByRole("combobox", { name: "Trigger" });
  fireEvent.change(select, { target: { value: "cron" } });
  expect(seen).toEqual(["cron"]);
  expect((select as HTMLSelectElement).value).toBe("cron");
  expect(document.querySelector(".apx-select-menu")).toBeNull();
});

test("mousedown suppresses the native popup and opens the branded menu", () => {
  const seen: string[] = [];
  render(<Harness onChangeValue={(value) => seen.push(value)} />);
  const select = screen.getByRole("combobox", { name: "Trigger" });

  const mousedown = fireEvent.mouseDown(select);
  expect(mousedown).toBe(false); // defaultPrevented — the OS popup never opens

  const menu = document.querySelector(".apx-select-menu");
  expect(menu).not.toBeNull();
  const options = [...document.querySelectorAll(".apx-select-option")];
  expect(options.map((option) => option.textContent)).toEqual(["Weekly", "Once", "Cron expression"]);
  expect(options[0].className).toContain("is-selected");

  fireEvent.click(options[1]);
  expect(seen).toEqual(["once"]);
  expect((select as HTMLSelectElement).value).toBe("once");
  expect(document.querySelector(".apx-select-menu")).toBeNull();
});

test("keyboard opens the menu, moves the active row, and commits with Enter", () => {
  const seen: string[] = [];
  render(<Harness onChangeValue={(value) => seen.push(value)} />);
  const select = screen.getByRole("combobox", { name: "Trigger" });

  fireEvent.keyDown(select, { key: "ArrowDown" });
  expect(document.querySelector(".apx-select-menu")).not.toBeNull();

  fireEvent.keyDown(select, { key: "ArrowDown" });
  fireEvent.keyDown(select, { key: "Enter" });
  expect(seen).toEqual(["once"]);
  expect(document.querySelector(".apx-select-menu")).toBeNull();
});

test("Escape closes the menu without changing the value", () => {
  const seen: string[] = [];
  render(<Harness onChangeValue={(value) => seen.push(value)} />);
  const select = screen.getByRole("combobox", { name: "Trigger" });

  fireEvent.mouseDown(select);
  fireEvent.keyDown(select, { key: "Escape" });
  expect(document.querySelector(".apx-select-menu")).toBeNull();
  expect(seen).toEqual([]);
  expect((select as HTMLSelectElement).value).toBe("weekly");
});
