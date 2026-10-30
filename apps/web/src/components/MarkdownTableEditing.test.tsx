import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { replaceMarkdownTable, type MarkdownTable } from "../lib/markdown";
import { Markdown } from "./Markdown";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), parse: vi.fn().mockResolvedValue(true), render: vi.fn() },
}));

const REPLY = [
  "Which of these should the matrix cover?",
  "",
  "| Focus | What the matrix would include |",
  "| --- | --- |",
  "| **State taxes** | Filing requirements |",
  "| Internal P&L | Margins by state |",
  "",
  "Tell me about the entity.",
].join("\n");

/** Saves edits into the reply the way the chat does, and shows what it saved. */
function Reply({ initial = REPLY, streaming = false }: { initial?: string; streaming?: boolean }) {
  const [content, setContent] = useState(initial);
  const save = (previous: MarkdownTable, next: MarkdownTable, occurrence: number) => {
    const updated = replaceMarkdownTable(content, previous, next, occurrence);
    if (updated === null) return false;
    setContent(updated);
    return true;
  };
  return (
    <>
      <Markdown content={content} onUpdateTable={save} streaming={streaming} />
      <pre data-testid="saved">{content}</pre>
    </>
  );
}

function saved() {
  return screen.getByTestId("saved").textContent ?? "";
}

function cell(text: string) {
  return within(screen.getByRole("table")).getByText(text).closest("td, th")!;
}

function type(editor: HTMLElement, html: string) {
  editor.innerHTML = html;
  fireEvent.input(editor);
}

test("clicking a cell edits it in place, and leaving it saves the change into the reply", () => {
  render(<Reply />);

  fireEvent.click(cell("Margins by state"));
  const editor = screen.getByRole("textbox", { name: "Edit What the matrix would include, row 2" });
  expect(editor).toHaveTextContent("Margins by state");
  expect(editor).toHaveFocus();
  type(editor, "Margins and <b>cost allocation</b> by state");
  act(() => editor.blur());

  expect(saved()).toContain("| Internal P&L | Margins and **cost allocation** by state |");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(within(screen.getByRole("table")).getByText("cost allocation").tagName).toBe("STRONG");
});

test("headers edit too, bold text shows as bold while editing, and Escape cancels", () => {
  render(<Reply />);

  fireEvent.click(cell("State taxes"));
  const bold = screen.getByRole("textbox", { name: "Edit Focus, row 1" });
  expect(bold.querySelector("strong")).toHaveTextContent("State taxes");
  type(bold, "Something else");
  fireEvent.keyDown(bold, { key: "Escape" });
  expect(saved()).toBe(REPLY);

  fireEvent.click(cell("Focus"));
  const header = screen.getByRole("textbox", { name: "Edit Focus, header" });
  type(header, "Area");
  fireEvent.keyDown(header, { key: "Enter" });
  expect(saved()).toContain("| Area | What the matrix would include |");
  // Enter moves down like a spreadsheet: the first row's cell is now open.
  expect(screen.getByRole("textbox", { name: "Edit Area, row 1" })).toHaveFocus();
});

test("Tab saves and walks to the next cell, and an untouched cell saves nothing", () => {
  const onUpdateTable = vi.fn().mockReturnValue(true);
  render(<Markdown content={REPLY} onUpdateTable={onUpdateTable} />);

  fireEvent.click(cell("State taxes"));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit Focus, row 1" }), { key: "Tab" });
  expect(onUpdateTable).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Edit What the matrix would include, row 1" })).toHaveFocus();
  // Moving in from the keyboard selects the cell's text, so typing replaces it.
  expect(window.getSelection()?.toString()).toBe("Filing requirements");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit What the matrix would include, row 1" }), {
    key: "Tab",
    shiftKey: true,
  });
  expect(screen.getByRole("textbox", { name: "Edit Focus, row 1" })).toHaveFocus();
  expect(window.getSelection()?.toString()).toBe("State taxes");
});

test("rows and columns are added and removed from the table tools, and Undo steps back", () => {
  render(<Reply />);

  fireEvent.click(cell("State taxes"));
  const tools = screen.getByRole("toolbar", { name: "Table tools" });
  expect(within(tools).getByRole("button", { name: "Delete column" })).toBeDisabled();

  fireEvent.click(within(tools).getByRole("button", { name: "Add row below" }));
  expect(saved()).toContain("| **State taxes** | Filing requirements |\n|  |  |\n| Internal P&L |");

  fireEvent.click(within(tools).getByRole("button", { name: "Add column to the right" }));
  expect(saved()).toContain("| Focus | New column | What the matrix would include |");
  expect(within(tools).getByRole("button", { name: "Delete column" })).toBeEnabled();

  fireEvent.click(within(tools).getByRole("button", { name: "Undo table edit" }));
  expect(saved()).not.toContain("New column");
  fireEvent.click(within(tools).getByRole("button", { name: "Undo table edit" }));
  expect(saved()).toBe(REPLY);
  expect(within(tools).getByRole("button", { name: "Undo table edit" })).toBeDisabled();
});

test("a pending cell edit and a toolbar action save together", () => {
  render(<Reply />);

  fireEvent.click(cell("Filing requirements"));
  const editor = screen.getByRole("textbox", { name: "Edit What the matrix would include, row 1" });
  type(editor, "Filing and nexus");
  const remove = screen.getByRole("button", { name: "Delete row" });
  // Pressing a tool keeps focus in the cell, so the tool commits the edit itself.
  expect(fireEvent.mouseDown(remove)).toBe(false);
  fireEvent.click(remove);

  expect(saved()).not.toContain("State taxes");
  expect(saved()).toContain("| Internal P&L | Margins by state |");
  fireEvent.click(screen.getByRole("button", { name: "Undo table edit" }));
  expect(saved()).toContain("| **State taxes** | Filing and nexus |");
});

test("the keyboard way in: Edit table opens the first cell; Done closes the tools", () => {
  render(<Reply />);

  fireEvent.click(screen.getByRole("button", { name: "Edit table" }));
  expect(screen.getByRole("textbox", { name: "Edit Focus, header" })).toHaveFocus();
  expect(window.getSelection()?.toString()).toBe("Focus");
  fireEvent.click(screen.getByRole("button", { name: "Done editing table" }));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit table" })).toBeInTheDocument();
});

test("pasting into a cell keeps only the text", () => {
  render(<Reply />);
  fireEvent.click(cell("Filing requirements"));
  const editor = screen.getByRole("textbox", { name: "Edit What the matrix would include, row 1" });
  const insertText = vi.fn();
  Object.defineProperty(document, "execCommand", { configurable: true, value: insertText });
  const paste = fireEvent.paste(editor, {
    clipboardData: { getData: (type: string) => (type === "text/plain" ? "Plain\nlines" : "<b>rich</b>") },
  });
  expect(paste).toBe(false);
  expect(insertText).toHaveBeenCalledWith("insertText", false, "Plain lines");
});

test("tables stay read-only while the reply streams, without a save handler, and links still open", () => {
  const { unmount } = render(<Reply streaming />);
  fireEvent.click(cell("Margins by state"));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit table" })).not.toBeInTheDocument();
  unmount();

  const plain = render(<Markdown content={REPLY} />);
  fireEvent.click(cell("Margins by state"));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  plain.unmount();

  const linked = "| Source | Note |\n| --- | --- |\n| [IRS](https://irs.gov) | Federal |";
  render(<Reply initial={linked} />);
  fireEvent.click(screen.getByRole("link", { name: "IRS" }));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

function caretOffsetIn(editor: HTMLElement) {
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.setEnd(selection.anchorNode!, selection.anchorOffset);
  return range.toString().length;
}

test("the caret lands where the cell was clicked, through either browser caret API", () => {
  render(<Reply />);
  // The cell's text node is new each time the cell closes and re-renders.
  const text = () => cell("Margins by state").firstChild!;
  const doc = document as Document & { caretPositionFromPoint?: unknown; caretRangeFromPoint?: unknown };

  doc.caretPositionFromPoint = () => ({ offsetNode: text(), offset: 7 });
  fireEvent.click(cell("Margins by state"));
  expect(caretOffsetIn(screen.getByRole("textbox"))).toBe(7);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  delete doc.caretPositionFromPoint;

  doc.caretRangeFromPoint = () => {
    const range = document.createRange();
    range.setStart(text(), 3);
    return range;
  };
  fireEvent.click(cell("Margins by state"));
  expect(caretOffsetIn(screen.getByRole("textbox"))).toBe(3);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });

  // A point that resolves outside the cell puts the caret at the end.
  doc.caretRangeFromPoint = () => {
    const range = document.createRange();
    range.setStart(cell("Filing requirements").firstChild!, 2);
    return range;
  };
  fireEvent.click(cell("Margins by state"));
  expect(caretOffsetIn(screen.getByRole("textbox"))).toBe("Margins by state".length);
  delete doc.caretRangeFromPoint;
});

test("clicking inside the open cell keeps the typing, and a press outside the table puts the tools away", () => {
  render(
    <>
      <Reply />
      <button type="button">Elsewhere</button>
    </>,
  );
  fireEvent.click(cell("Margins by state"));
  const editor = screen.getByRole("textbox");
  type(editor, "Margins, typed");
  fireEvent.click(editor.closest("td")!);
  expect(screen.getByRole("textbox")).toHaveTextContent("Margins, typed");

  act(() => editor.blur());
  // With no cell open, a press inside the table keeps its tools out.
  fireEvent.pointerDown(cell("Filing requirements"));
  expect(screen.getByRole("button", { name: "Done editing table" })).toBeInTheDocument();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
  expect(screen.getByRole("button", { name: "Edit table" })).toBeInTheDocument();
  expect(saved()).toContain("| Internal P&L | Margins, typed |");
});

test("Escape hands focus to the first tool that can run, and Enter mid-composition does not move", () => {
  render(<Reply />);
  fireEvent.click(cell("Margins by state"));
  const editor = screen.getByRole("textbox");
  fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
  expect(editor).toHaveFocus();
  fireEvent.keyDown(editor, { key: "a" });
  expect(editor).toHaveFocus();
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Add row below" })).toHaveFocus();
});

test("the cell in use follows the tools: a new row or column, and the nearest one after a delete", () => {
  render(<Reply />);
  const selectedText = () => document.querySelector(".md-table .is-selected")?.textContent ?? null;

  fireEvent.click(cell("Margins by state"));
  fireEvent.click(screen.getByRole("button", { name: "Delete row" }));
  // The last row went, so the row above it is in use.
  expect(selectedText()).toBe("Filing requirements");
  fireEvent.click(screen.getByRole("button", { name: "Add row below" }));
  expect(selectedText()).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Add column to the right" }));
  expect(document.querySelector(".md-table .is-selected")?.cellIndex).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "Delete column" }));
  expect(document.querySelector(".md-table .is-selected")?.cellIndex).toBe(1);
  expect(saved()).toContain("| **State taxes** | Filing requirements |\n|  |  |");
});

test("a save the reply refuses shows a notice and keeps the table as it was; Undo stops at twenty steps", () => {
  const onUpdateTable = vi.fn().mockReturnValue(false);
  const { unmount } = render(<Markdown content={REPLY} onUpdateTable={onUpdateTable} />);
  fireEvent.click(cell("Margins by state"));
  type(screen.getByRole("textbox"), "Changed");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(screen.getByRole("status")).toHaveTextContent("could not be saved");
  expect(screen.getByRole("button", { name: "Undo table edit" })).toBeDisabled();
  unmount();

  render(<Reply />);
  fireEvent.click(cell("Focus"));
  for (let step = 0; step < 21; step += 1) fireEvent.click(screen.getByRole("button", { name: "Add column to the right" }));
  const undo = screen.getByRole("button", { name: "Undo table edit" });
  for (let step = 0; step < 20; step += 1) fireEvent.click(undo);
  expect(undo).toBeDisabled();
  // One column more than the reply started with: the oldest step fell off.
  expect(screen.getAllByRole("columnheader")).toHaveLength(3);
});

test("an Undo the reply refuses says so", () => {
  let accept = true;
  render(<Markdown content={REPLY} onUpdateTable={() => accept} />);
  fireEvent.click(cell("Focus"));
  fireEvent.click(screen.getByRole("button", { name: "Add row below" }));
  accept = false;
  fireEvent.click(screen.getByRole("button", { name: "Undo table edit" }));
  expect(screen.getByRole("status")).toHaveTextContent("could not be saved");
  expect(screen.getByRole("button", { name: "Undo table edit" })).toBeEnabled();
});

test("of two identical tables, the edited one is the one saved", () => {
  const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  render(<Reply initial={`${table}\n\nAgain:\n\n${table}`} />);
  const second = screen.getAllByRole("table")[1]!;
  fireEvent.click(within(second).getByText("2"));
  type(screen.getByRole("textbox"), "3");
  act(() => screen.getByRole("textbox").blur());
  expect(saved()).toBe(`${table}\n\nAgain:\n\n| A | B |\n| --- | --- |\n| 1 | 3 |`);
});

test("cell names read the header without its formatting, and Done saves typing still open", () => {
  render(<Reply initial={"| **Area** | `Code` |\n| --- | --- |\n| a | b |"} />);
  fireEvent.click(cell("a"));
  expect(screen.getByRole("textbox", { name: "Edit Area, row 1" })).toBeInTheDocument();
  type(screen.getByRole("textbox"), "alpha");
  fireEvent.click(screen.getByRole("button", { name: "Done editing table" }));
  expect(saved()).toContain("| alpha | b |");
  expect(screen.getByRole("button", { name: "Edit table" })).toBeInTheDocument();
});

test("opening and leaving a cell without typing never rewrites its formatting", () => {
  const onUpdateTable = vi.fn().mockReturnValue(true);
  render(<Markdown content={"| A | B |\n| --- | --- |\n| _Taxes_ | x |"} onUpdateTable={onUpdateTable} />);
  fireEvent.click(cell("Taxes"));
  act(() => screen.getByRole("textbox").blur());
  fireEvent.click(cell("Taxes"));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab" });
  expect(onUpdateTable).not.toHaveBeenCalled();
});

test("the table tools say plainly what they add and remove", () => {
  render(<Reply />);
  fireEvent.click(cell("Focus"));
  expect(
    within(screen.getByRole("toolbar", { name: "Table tools" }))
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Add row", "Add column", "Delete row", "Delete column", "Undo", "Done"]);
});
