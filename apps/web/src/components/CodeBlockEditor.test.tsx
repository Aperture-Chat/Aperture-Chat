import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCodeHighlighter } from "../lib/codeHighlight";
import { CodeBlockEditor } from "./CodeBlockEditor";

beforeAll(async () => {
  await loadCodeHighlighter();
});

function Harness({ initial, onDone = () => undefined }: { initial: string; onDone?: () => void }) {
  const [value, setValue] = useState(initial);
  return <CodeBlockEditor language="python" value={value} onChange={setValue} onDone={onDone} />;
}

function editor() {
  return screen.getByRole("textbox", { name: "Editable python code" }) as HTMLTextAreaElement;
}

test("focuses the code and types like a textarea", () => {
  render(<Harness initial="x = 1" />);
  expect(editor()).toHaveFocus();
  fireEvent.change(editor(), { target: { value: "x = 2" } });
  expect(editor()).toHaveValue("x = 2");
});

test("Tab and Shift+Tab indent and outdent the selected lines", () => {
  render(<Harness initial={"if x:\n    a()\nb()"} />);
  const input = editor();
  input.setSelectionRange(14, 17);
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("if x:\n    a()\n    b()");
  expect([input.selectionStart, input.selectionEnd]).toEqual([14, 21]);

  fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
  expect(input).toHaveValue("if x:\n    a()\nb()");
});

test("Enter keeps the indentation and adds a level after a colon", () => {
  render(<Harness initial={"def f():"} />);
  const input = editor();
  input.setSelectionRange(8, 8);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue("def f():\n    ");
  expect(input.selectionStart).toBe(13);
});

test("leaves other keys to the browser, and Tab never leaves the editor", () => {
  render(<Harness initial={"x"} />);
  const input = editor();
  input.setSelectionRange(1, 1);
  expect(fireEvent.keyDown(input, { key: "x" })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "Enter", metaKey: true })).toBe(true);
  fireEvent.keyDown(input, { key: "Tab", ctrlKey: true });
  fireEvent.keyDown(input, { key: "Tab", altKey: true });
  expect(input).toHaveValue("x");
  // Nothing to outdent, yet focus stays put.
  expect(fireEvent.keyDown(input, { key: "Tab", shiftKey: true })).toBe(false);
  expect(input).toHaveValue("x");
});

test("Escape and Cmd+S finish editing; a plain S is just typing", () => {
  const onDone = vi.fn();
  render(<Harness initial="x" onDone={onDone} />);
  fireEvent.keyDown(editor(), { key: "s" });
  expect(onDone).not.toHaveBeenCalled();
  fireEvent.keyDown(editor(), { key: "Escape" });
  fireEvent.keyDown(editor(), { key: "s", metaKey: true });
  fireEvent.keyDown(editor(), { key: "S", ctrlKey: true });
  expect(onDone).toHaveBeenCalledTimes(3);
});

test("numbers every line and turns off spellcheck", () => {
  const { container } = render(<Harness initial={"a\nb\nc"} />);
  expect([...container.querySelectorAll(".md-code-editor-gutter span")].map((cell) => cell.textContent)).toEqual(["1", "2", "3"]);
  expect(editor()).toHaveAttribute("spellcheck", "false");
});

test("plain-text code is editable without colors", () => {
  const { container } = render(<CodeBlockEditor language="text" value={"a\nb"} onChange={() => undefined} onDone={() => undefined} />);
  expect([...container.querySelectorAll(".code-edit-line")].map((row) => row.innerHTML)).toEqual(["a", "b"]);
});

test("draws the same code, colored, under the textarea", async () => {
  const { container } = render(<Harness initial={"def f():\n    return 1"} />);
  expect(await screen.findByText("def")).toHaveClass("hljs-keyword");
  const rows = container.querySelectorAll(".code-edit-line");
  expect([...rows].map((row) => row.textContent)).toEqual(["def f():", "    return 1"]);
});
