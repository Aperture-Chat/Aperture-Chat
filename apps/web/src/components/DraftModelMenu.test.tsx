import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { DraftModelMenu } from "./DraftModelMenu";

const agents = ["Alpha", "Beta", "Gamma", "Gemini"].map((name) => ({
  id: name.toLowerCase(), name, providerName: "Example provider",
}));

function renderPicker() {
  const onSelect = vi.fn();
  const onSetDefault = vi.fn();
  const props = { agents, selectedAgent: agents[1], defaultAgentId: "alpha", onSelect, onSetDefault };
  const view = render(<><DraftModelMenu {...props} /><button>After picker</button></>);
  return { ...view, props, onSelect, onSetDefault, trigger: screen.getByRole("button", { name: "Document drafting model" }) };
}

test("opening focuses the selected drafting model; arrows and Home/End preview without selecting", () => {
  const { trigger, onSelect } = renderPicker();
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const listbox = screen.getByRole("listbox", { name: "Select drafting model" });
  expect(trigger).toHaveAttribute("aria-controls", listbox.id);
  expect(screen.getByRole("option", { name: /Beta/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: /Gamma/ })).toHaveFocus();
  expect(screen.getByRole("option", { name: /Beta/ })).toHaveAttribute("aria-selected", "true");
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(screen.getByRole("option", { name: /Gemini/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: /Alpha/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(screen.getByRole("option", { name: /Gemini/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(screen.getByRole("option", { name: /Alpha/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("alpha");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test("typeahead cycles matching drafting models and Space commits the focused choice", () => {
  const { trigger, onSelect } = renderPicker();
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: "g" });
  expect(screen.getByRole("option", { name: /Gamma/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "g" });
  expect(screen.getByRole("option", { name: /Gemini/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "e" });
  expect(screen.getByRole("option", { name: /Gemini/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: " " });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("gemini");
  expect(trigger).toHaveFocus();
});

test("the separate default action uses the focused model without selecting it", () => {
  const { trigger, onSelect, onSetDefault } = renderPicker();
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  const listbox = screen.getByRole("listbox");
  const action = screen.getByRole("button", { name: "Set Gemini as default drafting model" });
  expect(within(listbox).queryByRole("button")).not.toBeInTheDocument();
  expect(action).toHaveAttribute("aria-pressed", "false");
  act(() => action.focus());
  expect(action).toHaveFocus();
  expect(screen.getByRole("option", { name: /Gemini/ })).toHaveAttribute("tabindex", "0");
  fireEvent.click(action);
  expect(onSetDefault).toHaveBeenCalledExactlyOnceWith("gemini");
  expect(onSelect).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
});

test("Escape restores focus and stops propagation to enclosing modal handlers", () => {
  const onOuterKeyDown = vi.fn();
  render(<div onKeyDown={onOuterKeyDown}><DraftModelMenu agents={agents} selectedAgent={agents[1]} defaultAgentId={null} onSelect={vi.fn()} onSetDefault={vi.fn()} /></div>);
  const trigger = screen.getByRole("button", { name: "Document drafting model" });
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: "Escape", isComposing: true });
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  onOuterKeyDown.mockClear();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(onOuterKeyDown).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("tabbing away or clicking outside closes without selecting or reclaiming focus", () => {
  const { trigger, onSelect } = renderPicker();
  fireEvent.click(trigger);
  const after = screen.getByRole("button", { name: "After picker" });
  act(() => after.focus());
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(after).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.pointerDown(after);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
});

test("an unavailable saved model is not represented as a selected available model", () => {
  const onSelect = vi.fn();
  render(<DraftModelMenu agents={agents} selectedAgent={{ id: "removed", name: "Removed", providerName: "Example provider" }} defaultAgentId="removed" onSelect={onSelect} onSetDefault={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Document drafting model" });
  expect(trigger).toHaveTextContent("Choose a model");
  fireEvent.click(trigger);
  expect(screen.getAllByRole("option").every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);
  expect(screen.getByRole("option", { name: /Alpha/ })).toHaveFocus();
  expect(onSelect).not.toHaveBeenCalled();
});

test("empty drafting models disable the picker and expose role-specific guidance", () => {
  const onSelect = vi.fn();
  const onSetDefault = vi.fn();
  render(<DraftModelMenu agents={[]} selectedAgent={undefined} defaultAgentId="saved-model" unavailableReason="Connect a provider in Models & Providers." onSelect={onSelect} onSetDefault={onSetDefault} />);
  const trigger = screen.getByRole("button", { name: "Document drafting model" });
  expect(trigger).toBeDisabled();
  expect(trigger).toHaveTextContent("No models connected");
  expect(trigger).toHaveAccessibleDescription("Connect a provider in Models & Providers.");
  fireEvent.click(trigger);
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
  expect(onSetDefault).not.toHaveBeenCalled();
});

test("removing connected models closes an open picker without persisting a phantom choice", () => {
  const { trigger, rerender, props, onSelect, onSetDefault } = renderPicker();
  fireEvent.click(trigger);
  rerender(<DraftModelMenu {...props} agents={[]} selectedAgent={undefined} />);
  expect(screen.getByRole("button", { name: "Document drafting model" })).toBeDisabled();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
  expect(onSetDefault).not.toHaveBeenCalled();
});
