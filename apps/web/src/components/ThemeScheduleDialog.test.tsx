import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ThemeScheduleDialog } from "./ThemeScheduleDialog";

it("prevents equal times and keeps cancellation from saving edits", () => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const view = render(<ThemeScheduleDialog schedule={{ enabled: false, light: "07:00", dark: "19:00" }} onSave={onSave} onClose={onClose} />);
  fireEvent.change(screen.getByLabelText("Dark mode at"), { target: { value: "07:00" } });
  expect(screen.getByRole("button", { name: "Save schedule" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Choose two different times");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSave).not.toHaveBeenCalled();
  view.unmount();
});

it("saves the enabled schedule with the selected times", () => {
  const onSave = vi.fn();
  const view = render(<ThemeScheduleDialog schedule={{ enabled: false, light: "07:00", dark: "19:00" }} onSave={onSave} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("switch"));
  fireEvent.change(screen.getByLabelText("Light mode at"), { target: { value: "08:30" } });
  fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
  expect(onSave).toHaveBeenCalledWith({ enabled: true, light: "08:30", dark: "19:00" });
  view.unmount();
});
