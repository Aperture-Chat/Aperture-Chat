import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CustomToolBuilder, type CustomToolBuilderApi } from "./CustomToolBuilder";

const api: CustomToolBuilderApi = {
  createTool: vi.fn(),
  updateTool: vi.fn(),
  previewScript: vi.fn(),
};

test("response action builder explains the script contract under the tenant brand name", () => {
  render(
    <CustomToolBuilder
      tool={null}
      groups={[]}
      api={api}
      onClose={() => {}}
      onSaved={() => {}}
      brandName="Example AI"
    />,
  );

  const summary = screen.getByText("How to write scripts for Example AI");
  const guide = summary.closest("details");
  expect(guide).not.toHaveAttribute("open");

  fireEvent.click(summary);
  expect(guide).toHaveAttribute("open");
  expect(screen.getAllByText(/sys\.stdin\.read/).length).toBeGreaterThanOrEqual(2);
  expect(screen.getAllByText(/APERTURE_ARTIFACT_DIR/).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText(/Remove Open WebUI imports/)).toBeInTheDocument();
  expect(screen.getByText(/50 MB limit per file/)).toBeInTheDocument();
});


test("response action builder traps keyboard focus and keeps its draft open while saving", async () => {
  let rejectSave: (error: Error) => void = () => undefined;
  const createTool = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectSave = reject; }));
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<CustomToolBuilder tool={null} groups={[]} api={{ ...api, createTool }} onClose={onClose} onSaved={onSaved} />);
  const close = screen.getByRole("button", { name: "Close response action builder" });
  expect(close).toHaveFocus();
  fireEvent.change(screen.getByLabelText("Action name"), { target: { value: "Keep this action" } });
  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  expect(screen.getByRole("button", { name: "Create action" })).toHaveFocus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(close).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Create action" }));
  expect(screen.getByLabelText("Action name")).toBeDisabled();
  expect(screen.getByLabelText("Python script")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(screen.getByRole("dialog").parentElement!);
  expect(onClose).not.toHaveBeenCalled();
  rejectSave(new Error("The service is unavailable"));
  expect(await screen.findByRole("alert")).toHaveTextContent("The service is unavailable");
  await waitFor(() => expect(screen.getByLabelText("Action name")).toBeEnabled());
  expect(screen.getByLabelText("Action name")).toHaveValue("Keep this action");
  expect(onSaved).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});
