import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import { ModelSelect } from "./ModelSelect";

function renderPicker() {
  const models = ["Alpha", "Beta", "Gamma", "Gemini"].map((name) => ({
    ...sampleData.models[0], id: name.toLowerCase(), name, provider_name: "Example provider",
  }));
  const setModel = vi.fn();
  const setDefaultModel = vi.fn();
  const view = render(<><ModelSelect chat={{ enabledModels: models, model: "beta", defaultModelId: "alpha", setModel, setDefaultModel }} /><button>After picker</button></>);
  return { ...view, setModel, setDefaultModel, trigger: screen.getByRole("button", { name: "Select model" }) };
}

test("model list opens at selection and arrow/Home/End navigation does not select until Enter", () => {
  const { trigger, setModel } = renderPicker();
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: /Beta/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: /Gamma/ })).toHaveFocus();
  expect(screen.getByRole("option", { name: /Beta/ })).toHaveAttribute("aria-selected", "true");
  expect(setModel).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(screen.getByRole("option", { name: /Alpha/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(screen.getByRole("option", { name: /Gemini/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: /Alpha/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(setModel).toHaveBeenCalledExactlyOnceWith("alpha");
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

test("typeahead matches model names and repeated letters cycle matching choices", () => {
  const { trigger, setModel } = renderPicker();
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: "g" });
  expect(screen.getByRole("option", { name: /Gamma/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "g" });
  expect(screen.getByRole("option", { name: /Gemini/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: " " });
  expect(setModel).toHaveBeenCalledExactlyOnceWith("gemini");
});

test("the default-model action is outside listbox options and applies the highlighted model", () => {
  const { trigger, setModel, setDefaultModel } = renderPicker();
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  const action = screen.getByRole("button", { name: "Set Gemini as default model" });
  expect(within(screen.getByRole("listbox")).queryByRole("button")).not.toBeInTheDocument();
  action.focus();
  fireEvent.click(action);
  expect(setDefaultModel).toHaveBeenCalledExactlyOnceWith("gemini");
  expect(setModel).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
});

test("Escape restores the trigger and tabbing out closes without changing the model", () => {
  const { trigger, setModel } = renderPicker();
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  act(() => screen.getByRole("button", { name: "After picker" }).focus());
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(setModel).not.toHaveBeenCalled();
});

test("no models leaves an honestly disabled picker", () => {
  render(<ModelSelect chat={{ enabledModels: [], model: "", defaultModelId: "", setModel: vi.fn(), setDefaultModel: vi.fn() }} />);
  expect(screen.getByRole("button", { name: "No connected models" })).toBeDisabled();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
