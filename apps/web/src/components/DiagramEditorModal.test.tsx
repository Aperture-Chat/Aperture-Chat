import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderMermaidSvg } from "../lib/mermaidRender";
import { DiagramEditorModal } from "./DiagramEditorModal";

vi.mock("../lib/mermaidRender", () => ({ renderMermaidSvg: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(renderMermaidSvg).mockReset();
});
afterEach(() => vi.useRealTimers());

test("diagram edits cannot be saved until the exact current source passes preview validation", async () => {
  vi.mocked(renderMermaidSvg).mockResolvedValue("<svg></svg>");
  const onSave = vi.fn().mockResolvedValue(true);
  render(<DiagramEditorModal source="flowchart LR\nA[Start] --> B[End]" onSave={onSave} onClose={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  fireEvent.click(screen.getByRole("button", { name: "Source" }));

  // A previous successful preview is not evidence that a new edit parses.
  fireEvent.change(screen.getByLabelText("Diagram source"), { target: { value: "broken diagram" } });
  const save = screen.getByRole("button", { name: "Save diagram" });
  expect(save).toBeDisabled();
  fireEvent.click(save);
  expect(onSave).not.toHaveBeenCalled();
  vi.mocked(renderMermaidSvg).mockResolvedValue(null);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(save).toBeDisabled();
  expect(screen.getByText(/no longer renders/)).toBeInTheDocument();

  vi.mocked(renderMermaidSvg).mockResolvedValue("<svg></svg>");
  fireEvent.change(screen.getByLabelText("Diagram source"), { target: { value: "flowchart LR\nA --> C" } });
  expect(save).toBeDisabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  expect(onSave).toHaveBeenCalledWith("flowchart LR\nA --> C");
});

test("a stale diagram preview cannot validate a newer edit", async () => {
  let resolveFirst!: (svg: string | null) => void;
  vi.mocked(renderMermaidSvg).mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
  render(<DiagramEditorModal source="flowchart LR\nA --> B" onSave={vi.fn()} onClose={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  fireEvent.change(screen.getByLabelText("Diagram source"), { target: { value: "broken diagram" } });
  await act(async () => resolveFirst("<svg></svg>"));
  expect(screen.getByRole("button", { name: "Save diagram" })).toBeDisabled();
});


test("diagram editor keeps keyboard focus inside and restores the entry button", () => {
  function EditorHarness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open diagram</button>{open && <DiagramEditorModal source="flowchart LR\nA --> B" onSave={vi.fn()} onClose={() => setOpen(false)} />}</>;
  }
  render(<EditorHarness />);
  const opener = screen.getByRole("button", { name: "Open diagram" });
  opener.focus();
  fireEvent.click(opener);
  const close = screen.getByRole("button", { name: "Close diagram editor" });
  expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Edit diagram" })).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});
