import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CodeEditAssistProvider, offerPlacement, rowsAnchor, type CodeEditAssist } from "./CodeAiEdit";
import { CodeLines } from "./CodeLines";
import { Markdown } from "./Markdown";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), parse: vi.fn().mockResolvedValue(true), render: vi.fn() },
}));

const REPLY = "```js\nconst total = 1;\nconsole.log(total);\n```";

afterEach(() => {
  vi.restoreAllMocks();
});

const ready = (request: CodeEditAssist["request"]): CodeEditAssist => ({ agentName: "AI", unavailableReason: null, request });

function selectFirstLine() {
  const cell = document.querySelector(".md-code-line-text")!;
  const range = document.createRange();
  range.selectNodeContents(cell);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function renderWith(assist: CodeEditAssist, content = REPLY) {
  return render(
    <CodeEditAssistProvider value={assist}>
      <Markdown content={content} onUpdateCode={() => true} />
    </CodeEditAssistProvider>,
  );
}

function figure() {
  return document.querySelector(".md-code-panel")!;
}

function composerOpen() {
  return screen.queryByRole("combobox", { name: "AI instruction" }) !== null;
}

async function reviewWith(reply: string, content = REPLY) {
  renderWith(ready(vi.fn<CodeEditAssist["request"]>().mockResolvedValue(reply)), content);
  selectFirstLine();
  runInstruction("Change it");
  await screen.findByRole("button", { name: "Accept AI suggestion" });
  return screen.getByLabelText("AI suggestion");
}

function runInstruction(text: string) {
  fireEvent.click(screen.getByRole("button", { name: "Ask AI to edit the selected code" }));
  fireEvent.change(screen.getByRole("combobox", { name: "AI instruction" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Run AI instruction" }));
}

test("rowsAnchor spans the targeted rows and is null for rows that do not exist", () => {
  const { container } = render(<CodeLines lines={["a", "b", "c"]} />);
  expect(rowsAnchor(container, { first: 0, last: 2 })).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  expect(rowsAnchor(container, { first: 0, last: 3 })).toBeNull();
  expect(rowsAnchor(null, { first: 0, last: 0 })).toBeNull();
});

test("offerPlacement centers above the anchor, drops below near the top, and stays on screen", () => {
  const size = { width: 100, height: 30 };
  expect(offerPlacement({ top: 300, bottom: 320, left: 100, right: 500 }, size, 1200)).toEqual({ top: 262, left: 250 });
  expect(offerPlacement({ top: 80, bottom: 100, left: 100, right: 500 }, size, 1200)).toEqual({ top: 108, left: 250 });
  expect(offerPlacement({ top: 102, bottom: 120, left: 100, right: 500 }, size, 1200).top).toBe(64);
  expect(offerPlacement({ top: 300, bottom: 320, left: -400, right: -300 }, size, 1200).left).toBe(8);
  expect(offerPlacement({ top: 300, bottom: 320, left: 1150, right: 1400 }, size, 1200).left).toBe(1092);
});

test("without a chosen model the offer explains why it cannot run", () => {
  renderWith({ agentName: "AI", unavailableReason: "Choose a model in the composer to edit code with AI.", request: vi.fn() });
  selectFirstLine();
  const ask = screen.getByRole("button", { name: "Ask AI to edit the selected code" });
  expect(ask).toBeDisabled();
  expect(ask).toHaveAttribute("data-tooltip", "Choose a model in the composer to edit code with AI.");
});

test("Stop keeps the code and offers a retry that sends the same request", async () => {
  const request = vi.fn<CodeEditAssist["request"]>(
    (_messages, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  );
  renderWith({ agentName: "AI", unavailableReason: null, request });
  selectFirstLine();
  runInstruction("Rename total");
  fireEvent.click(await screen.findByRole("button", { name: /Stop/ }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Stopped before the suggestion finished. The code is unchanged.");
  expect(document.querySelector(".md-code-lines")).toHaveTextContent("const total = 1;");

  request.mockResolvedValueOnce("const sum = 1;");
  fireEvent.click(screen.getByRole("button", { name: /Try again|Retry/ }));
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]![0]).toEqual(request.mock.calls[0]![0]);
  expect(await screen.findByRole("button", { name: "Accept AI suggestion" })).toBeInTheDocument();
});

test("a model error is shown as it was reported", async () => {
  const request = vi.fn<CodeEditAssist["request"]>().mockRejectedValue(new Error("The model is over its usage budget."));
  renderWith({ agentName: "AI", unavailableReason: null, request });
  selectFirstLine();
  runInstruction("Rename total");
  expect(await screen.findByRole("alert")).toHaveTextContent("The model is over its usage budget.");
});

test("a refinement sends the previous suggestion back with the new instruction", async () => {
  const request = vi.fn<CodeEditAssist["request"]>().mockResolvedValueOnce("const sum = 1;").mockResolvedValueOnce("const amount = 1;");
  renderWith({ agentName: "AI", unavailableReason: null, request });
  selectFirstLine();
  runInstruction("Rename total");
  await screen.findByRole("button", { name: "Accept AI suggestion" });

  const refine = screen.getAllByRole("textbox").find((box) => box.closest(".ai-composer"))!;
  fireEvent.change(refine, { target: { value: "Call it amount" } });
  fireEvent.keyDown(refine, { key: "Enter" });

  await screen.findByText(/Refine: Call it amount/);
  const [messages] = request.mock.calls[1]!;
  expect(messages.at(-2)).toEqual({ role: "assistant", content: "const sum = 1;" });
  expect(messages.at(-1)?.content).toContain("Call it amount");
});

test("⌘J or Ctrl+J opens the edit on the selection; other keys do not", () => {
  renderWith(ready(vi.fn()));
  selectFirstLine();
  fireEvent.keyDown(figure(), { key: "j" });
  fireEvent.keyDown(figure(), { key: "k", metaKey: true });
  expect(composerOpen()).toBe(false);
  fireEvent.keyDown(figure(), { key: "J", ctrlKey: true });
  expect(composerOpen()).toBe(true);
});

test("the shortcut does nothing while AI edits are unavailable", () => {
  renderWith({ agentName: "AI", unavailableReason: "Choose a model.", request: vi.fn() });
  selectFirstLine();
  fireEvent.keyDown(figure(), { key: "j", metaKey: true });
  expect(composerOpen()).toBe(false);
});

test("the offer names the shortcut", () => {
  renderWith(ready(vi.fn()));
  selectFirstLine();
  expect(screen.getByRole("button", { name: "Ask AI to edit the selected code" }).getAttribute("data-tooltip")).toMatch(
    /with AI \((⌘J|Ctrl\+J)\)$/,
  );
});

test("a caret with nothing selected in the editor offers no AI edit", () => {
  renderWith(ready(vi.fn()));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "Editable js code" }) as HTMLTextAreaElement;
  editor.setSelectionRange(3, 3);
  fireEvent.select(editor);
  expect(screen.queryByRole("button", { name: "Ask AI to edit the selected code" })).not.toBeInTheDocument();
  editor.setSelectionRange(0, 5);
  fireEvent.select(editor);
  expect(screen.getByRole("button", { name: "Ask AI to edit the selected code" })).toBeInTheDocument();
});

test("the review counts added and removed lines and colors both sides", async () => {
  const preview = await reviewWith("let a = 1;\nlet b = 2;");
  expect(preview.querySelector(".code-ai-diff-stat")).toHaveTextContent("+2 −1 lines");
  expect(preview.querySelector(".code-ai-diff-note")).toBeNull();
  expect(preview.querySelector(".code-ai-diff-row.is-remove .hljs-keyword")).toHaveTextContent("const");
  expect(preview.querySelector(".code-ai-diff-row.is-add .hljs-keyword")).toHaveTextContent("let");
});

test("the review flags placeholders where personal data was hidden from the model", async () => {
  const preview = await reviewWith("const email = '⟦EMAIL⟧';");
  expect(preview.querySelector(".code-ai-diff-note")).toHaveTextContent("Personal data was hidden from the model");
});

test("placeholders already in the selected code are not flagged", async () => {
  const preview = await reviewWith("const owner = '⟦NAME⟧ Jr';", "```js\nconst owner = '⟦NAME⟧';\n```");
  expect(preview.querySelector(".code-ai-diff-note")).toBeNull();
});

test("plain-text blocks review without colors", async () => {
  const preview = await reviewWith("hello there", "```text\nhello world\n```");
  expect(preview.querySelector(".code-ai-diff-row.is-add")).toHaveTextContent("hello there");
});

test("the reply streams into the composer while the model writes", async () => {
  let finish!: (text: string) => void;
  renderWith(
    ready(async (_messages, { onDelta }) => {
      onDelta("const partial");
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    }),
  );
  selectFirstLine();
  runInstruction("Rename total");
  expect(await screen.findByText("const partial")).toBeInTheDocument();
  await act(async () => finish("const sum = 1;"));
  expect(await screen.findByRole("button", { name: "Accept AI suggestion" })).toBeInTheDocument();
});

test("closing before running leaves the code as it was", () => {
  renderWith(ready(vi.fn()));
  selectFirstLine();
  fireEvent.click(screen.getByRole("button", { name: "Ask AI to edit the selected code" }));
  fireEvent.click(screen.getByRole("button", { name: "Close Edit code with AI" }));
  expect(composerOpen()).toBe(false);
  expect(document.querySelector(".md-code-lines")).toHaveTextContent("const total = 1;");
});

test("a late reply from a closed edit never lands in the next one", async () => {
  let answerFirst!: (text: string) => void;
  // A provider that ignores the abort and answers anyway.
  const request = vi.fn<CodeEditAssist["request"]>().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answerFirst = resolve;
      }),
  );
  renderWith(ready(request));
  selectFirstLine();
  runInstruction("First");
  fireEvent.click(screen.getByRole("button", { name: "Close Edit code with AI" }));
  selectFirstLine();
  fireEvent.click(screen.getByRole("button", { name: "Ask AI to edit the selected code" }));
  await act(async () => answerFirst("const stale = 1;"));
  expect(screen.queryByRole("button", { name: "Accept AI suggestion" })).not.toBeInTheDocument();
  expect(composerOpen()).toBe(true);
});

test("the Ask AI button follows its code when the chat scroller scrolls or the window resizes", () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
  let top = 300;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ top, bottom: top + 20, left: 100, right: 500 }) as DOMRect,
  );
  renderWith(ready(vi.fn()));
  selectFirstLine();
  const offer = screen.getByRole("toolbar", { name: "Selected code" });
  // Unmeasured in jsdom, the button counts as 96 × 36.
  expect([offer.style.top, offer.style.left]).toEqual(["256px", "252px"]);

  top = 500;
  const scroller = document.body.appendChild(document.createElement("div"));
  scroller.dispatchEvent(new Event("scroll"));
  scroller.dispatchEvent(new Event("scroll"));
  expect(frames).toHaveLength(1);
  act(() => frames.shift()!(0));
  expect(offer.style.top).toBe("456px");

  top = 600;
  window.dispatchEvent(new Event("resize"));
  act(() => frames.shift()!(0));
  expect(offer.style.top).toBe("556px");
});

test("after a failed refinement, a new instruction starts a fresh edit", async () => {
  const request = vi
    .fn<CodeEditAssist["request"]>()
    .mockResolvedValueOnce("const sum = 1;")
    .mockRejectedValueOnce(new Error("The model is busy."))
    .mockResolvedValueOnce("const fresh = 1;");
  renderWith(ready(request));
  selectFirstLine();
  runInstruction("Rename total");
  await screen.findByRole("button", { name: "Accept AI suggestion" });
  const refine = screen.getAllByRole("textbox").find((box) => box.closest(".ai-composer"))!;
  fireEvent.change(refine, { target: { value: "Shorter" } });
  fireEvent.keyDown(refine, { key: "Enter" });
  await screen.findByRole("alert");

  fireEvent.change(screen.getByRole("combobox", { name: "AI instruction" }), { target: { value: "Fresh start" } });
  fireEvent.click(screen.getByRole("button", { name: "Run AI instruction" }));
  const [messages] = request.mock.calls[2]!;
  expect(messages).toHaveLength(2);
  expect(messages[1]?.content).toContain("User instruction:\nFresh start");
});
