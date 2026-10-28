import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCodeHighlighter } from "../lib/codeHighlight";
import { CODE_INLINE_EDIT_PREFIX } from "../lib/codeAiEdit";
import { CodeEditAssistProvider, type CodeEditAssist } from "./CodeAiEdit";
import { Markdown } from "./Markdown";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), parse: vi.fn().mockResolvedValue(true), render: vi.fn() },
}));

beforeAll(async () => {
  await loadCodeHighlighter();
});

const REPLY = "Run this:\n\n```python\ndef greet(name):\n    return 'Hi ' + name\n```\n";
const CODE = "def greet(name):\n    return 'Hi ' + name";

function codeView() {
  return document.querySelector(".md-code-panel")!;
}

function selectInCode(text: string) {
  const cell = [...document.querySelectorAll(".md-code-line-text")].find((node) => node.textContent?.includes(text))!;
  const range = document.createRange();
  range.selectNodeContents(cell);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

test("finished code blocks are colored by language", async () => {
  render(<Markdown content={REPLY} />);
  expect(await screen.findByText("def")).toHaveClass("hljs-keyword");
  expect(within(codeView() as HTMLElement).getByText("greet")).toHaveClass("hljs-title");
});

test("Done saves the edited code into the reply, and Undo puts the old code back", () => {
  const onUpdateCode = vi.fn().mockReturnValue(true);
  const view = render(<Markdown content={REPLY} onUpdateCode={onUpdateCode} />);

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "Editable python code" });
  fireEvent.change(editor, { target: { value: CODE.replace("Hi ", "Hello ") } });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));

  expect(onUpdateCode).toHaveBeenCalledWith(CODE, CODE.replace("Hi ", "Hello "), 0);
  expect(screen.getByRole("status")).toHaveTextContent("Saved");

  // The chat saves the new code into the message, which re-renders the block.
  view.rerender(<Markdown content={REPLY.replace("Hi ", "Hello ")} onUpdateCode={onUpdateCode} />);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(onUpdateCode).toHaveBeenLastCalledWith(CODE.replace("Hi ", "Hello "), CODE, 0);
});

test("the Saved notice clears after a moment", () => {
  vi.useFakeTimers();
  try {
    render(<Markdown content={REPLY} onUpdateCode={() => true} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Editable python code" }), { target: { value: "pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test("a repeated snippet saves against its own copy", () => {
  const onUpdateCode = vi.fn().mockReturnValue(true);
  render(<Markdown content={`${REPLY}\nAgain:\n\n${REPLY}`} onUpdateCode={onUpdateCode} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]!);
  fireEvent.change(screen.getByRole("textbox", { name: "Editable python code" }), { target: { value: "pass" } });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onUpdateCode).toHaveBeenCalledWith(CODE, "pass", 1);
});

test("surfaces that cannot save keep the edit on screen and say so", () => {
  render(<Markdown content={REPLY} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Editable python code" }), { target: { value: "pass" } });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByRole("status")).toHaveTextContent("Edited here only");
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Editable python code" })).not.toBeInTheDocument();
  expect(codeView()).toHaveTextContent("pass");
});

test("code is read-only while the reply is still streaming", () => {
  const assist: CodeEditAssist = { agentName: "Model", unavailableReason: null, request: vi.fn() };
  render(
    <CodeEditAssistProvider value={assist}>
      <Markdown content={REPLY} streaming />
    </CodeEditAssistProvider>,
  );
  expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  selectInCode("return");
  expect(screen.queryByRole("button", { name: "Ask AI to edit the selected code" })).not.toBeInTheDocument();
});

test("selected code can be rewritten with AI after reviewing the line diff", async () => {
  const request = vi.fn<CodeEditAssist["request"]>(async (_messages, { onDelta }) => {
    onDelta("```python\n    return f'Hi {name}'\n```");
    return "```python\n    return f'Hi {name}'\n```";
  });
  const onUpdateCode = vi.fn().mockReturnValue(true);
  render(
    <CodeEditAssistProvider value={{ agentName: "Test model", unavailableReason: null, request }}>
      <Markdown content={REPLY} onUpdateCode={onUpdateCode} />
    </CodeEditAssistProvider>,
  );

  selectInCode("return");
  fireEvent.click(await screen.findByRole("button", { name: "Ask AI to edit the selected code" }));
  expect(screen.getByText("“return 'Hi ' + name” · python")).toBeInTheDocument();
  expect(document.querySelector(".md-code-line.is-marked")).toHaveTextContent("return 'Hi ' + name");

  fireEvent.change(screen.getByRole("combobox", { name: "AI instruction" }), { target: { value: "Use an f-string" } });
  fireEvent.click(screen.getByRole("button", { name: "Run AI instruction" }));

  const [messages] = request.mock.calls[0]!;
  expect(messages[1]?.content.startsWith(CODE_INLINE_EDIT_PREFIX)).toBe(true);
  expect(messages[1]?.content).toContain("Selected code (replace exactly this):\n<<<\n    return 'Hi ' + name\n>>>");

  const preview = await screen.findByLabelText("AI suggestion");
  expect(within(preview).getByText("+1")).toBeInTheDocument();
  expect(preview.querySelector(".code-ai-diff-row.is-remove")).toHaveTextContent("return 'Hi ' + name");
  expect(preview.querySelector(".code-ai-diff-row.is-add")).toHaveTextContent("return f'Hi {name}'");

  fireEvent.click(screen.getByRole("button", { name: "Accept AI suggestion" }));
  await waitFor(() =>
    expect(onUpdateCode).toHaveBeenCalledWith(CODE, "def greet(name):\n    return f'Hi {name}'", 0),
  );
  expect(screen.queryByLabelText("AI suggestion")).not.toBeInTheDocument();
});

test("while editing, an accepted AI suggestion lands in the editor as the new selection", async () => {
  const request = vi.fn<CodeEditAssist["request"]>(async () => "greeting");
  render(
    <CodeEditAssistProvider value={{ agentName: "Test model", unavailableReason: null, request }}>
      <Markdown content={REPLY} onUpdateCode={() => true} />
    </CodeEditAssistProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "Editable python code" }) as HTMLTextAreaElement;
  editor.setSelectionRange(4, 9);
  fireEvent.select(editor);
  fireEvent.keyDown(codeView(), { key: "j", metaKey: true });

  fireEvent.change(screen.getByRole("combobox", { name: "AI instruction" }), { target: { value: "Rename" } });
  fireEvent.click(screen.getByRole("button", { name: "Run AI instruction" }));
  fireEvent.click(await screen.findByRole("button", { name: "Accept AI suggestion" }));

  expect(editor).toHaveValue(CODE.replace("greet", "greeting"));
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([4, 12]);
});
