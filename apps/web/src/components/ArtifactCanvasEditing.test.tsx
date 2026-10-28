import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCodeHighlighter } from "../lib/codeHighlight";
import type { ChatMessage } from "../lib/types";
import { ArtifactCanvasProvider } from "./ArtifactCanvas";
import { CodeEditAssistProvider, type CodeEditAssist } from "./CodeAiEdit";
import { Markdown } from "./Markdown";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), parse: vi.fn().mockResolvedValue(true), render: vi.fn() },
}));

beforeAll(async () => {
  await loadCodeHighlighter();
});

const CODE = "<title>Snake</title>\n<canvas></canvas>";
const SNAKE = `Here it is:\n\n\`\`\`html\n${CODE}\n\`\`\``;

function message(id: string, role: ChatMessage["role"], content: string, status: ChatMessage["status"] = "ok"): ChatMessage {
  return { id, role, content, createdAt: "now", status };
}

type Save = (messageId: string, previous: string, next: string, occurrence: number) => boolean;

function Chat({ messages, onUpdateCode, assist = null }: { messages: ChatMessage[]; onUpdateCode?: Save; assist?: CodeEditAssist | null }) {
  return (
    <CodeEditAssistProvider value={assist}>
      <ArtifactCanvasProvider messages={messages} onUpdateCode={onUpdateCode} resetKey="thread-1">
        {messages.map((item) => (
          <Markdown content={item.content} key={item.id} />
        ))}
      </ArtifactCanvasProvider>
    </CodeEditAssistProvider>
  );
}

function openCodeView() {
  fireEvent.click(screen.getByRole("button", { name: /Open the artifact canvas/ }));
  const canvas = screen.getByRole("dialog", { name: "Artifact canvas" });
  fireEvent.click(within(canvas).getByRole("radio", { name: /Code/ }));
  return canvas;
}

function selectCanvasLine(canvas: HTMLElement, index: number) {
  const cell = canvas.querySelectorAll(".md-code-line-text")[index]!;
  const range = document.createRange();
  range.selectNodeContents(cell);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

test("the Code view offers Edit; Done saves into the reply and the canvas shows the saved code", () => {
  const onUpdateCode = vi.fn<Save>().mockReturnValue(true);
  const messages = [message("u1", "user", "Make a game"), message("a1", "assistant", SNAKE)];
  const view = render(<Chat messages={messages} onUpdateCode={onUpdateCode} />);
  fireEvent.click(screen.getByRole("button", { name: /Open the artifact canvas/ }));
  const canvas = screen.getByRole("dialog", { name: "Artifact canvas" });
  expect(within(canvas).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();

  fireEvent.click(within(canvas).getByRole("radio", { name: /Code/ }));
  fireEvent.click(within(canvas).getByRole("button", { name: "Edit" }));
  const editor = within(canvas).getByRole("textbox", { name: "Editable html code" });
  fireEvent.change(editor, { target: { value: CODE.replace("Snake", "Snake II") } });
  fireEvent.click(within(canvas).getByRole("button", { name: "Done" }));

  expect(onUpdateCode).toHaveBeenCalledWith("a1", CODE, CODE.replace("Snake", "Snake II"), 0);
  expect(within(canvas).getByRole("status")).toHaveTextContent("Saved");

  view.rerender(<Chat messages={[messages[0]!, message("a1", "assistant", SNAKE.replace("Snake", "Snake II"))]} onUpdateCode={onUpdateCode} />);
  expect(canvas.querySelector(".md-code-lines")).toHaveTextContent("<title>Snake II</title>");
  expect(within(canvas).getByRole("button", { name: "Undo" })).toBeInTheDocument();
});

test("Esc in the canvas editor finishes editing and keeps the canvas open", () => {
  render(<Chat messages={[message("a1", "assistant", SNAKE)]} onUpdateCode={() => true} />);
  const canvas = openCodeView();
  fireEvent.click(within(canvas).getByRole("button", { name: "Edit" }));
  fireEvent.keyDown(within(canvas).getByRole("textbox", { name: "Editable html code" }), { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "Artifact canvas" })).toBeInTheDocument();
  expect(within(canvas).getByRole("button", { name: "Edit" })).toBeInTheDocument();
});

test("switching to Preview while editing saves first, so the preview runs the saved code", () => {
  const onUpdateCode = vi.fn<Save>().mockReturnValue(true);
  render(<Chat messages={[message("a1", "assistant", SNAKE)]} onUpdateCode={onUpdateCode} />);
  const canvas = openCodeView();
  fireEvent.click(within(canvas).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(canvas).getByRole("textbox", { name: "Editable html code" }), { target: { value: "<p>New</p>" } });
  fireEvent.click(within(canvas).getByRole("radio", { name: /Preview/ }));
  expect(onUpdateCode).toHaveBeenCalledWith("a1", CODE, "<p>New</p>", 0);
  expect(within(canvas).getByTitle(/preview$/).getAttribute("srcdoc")).toContain("<p>New</p>");
  expect(within(canvas).getByTitle(/preview$/)).toHaveAttribute("sandbox", "allow-scripts");
});

test("a reply that is still being written offers no Edit in the canvas", () => {
  render(<Chat messages={[message("a1", "assistant", SNAKE, "pending")]} onUpdateCode={() => true} />);
  const canvas = openCodeView();
  expect(within(canvas).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
});

test("a canvas without a reply to save into offers no Edit", () => {
  render(<Markdown content={SNAKE} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  const canvas = screen.getByRole("dialog", { name: "Artifact canvas" });
  fireEvent.click(within(canvas).getByRole("radio", { name: /Code/ }));
  expect(within(canvas).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
});

test("canvas code is colored by language", () => {
  render(<Chat messages={[message("a1", "assistant", SNAKE)]} />);
  const canvas = openCodeView();
  expect(within(canvas).getAllByText("title")[0]).toHaveClass("hljs-name");
});

test("selected canvas code can be rewritten with AI in a composer docked inside the canvas", async () => {
  const onUpdateCode = vi.fn<Save>().mockReturnValue(true);
  const request = vi.fn<CodeEditAssist["request"]>().mockResolvedValue("<title>Snake Deluxe</title>");
  render(
    <Chat
      assist={{ agentName: "Test model", unavailableReason: null, request }}
      messages={[message("a1", "assistant", SNAKE)]}
      onUpdateCode={onUpdateCode}
    />,
  );
  const canvas = openCodeView();
  selectCanvasLine(canvas, 0);
  fireEvent.click(screen.getByRole("button", { name: "Ask AI to edit the selected code" }));

  const instruction = within(canvas).getByRole("combobox", { name: "AI instruction" });
  expect(canvas.querySelector(".md-code-line.is-marked")).toHaveTextContent("<title>Snake</title>");
  fireEvent.change(instruction, { target: { value: "Call it Snake Deluxe" } });
  fireEvent.click(within(canvas).getByRole("button", { name: "Run AI instruction" }));
  fireEvent.click(await within(canvas).findByRole("button", { name: "Accept AI suggestion" }));

  expect(onUpdateCode).toHaveBeenCalledWith("a1", CODE, CODE.replace("Snake", "Snake Deluxe"), 0);
  expect(screen.getByRole("dialog", { name: "Artifact canvas" })).toBeInTheDocument();
});

test("stepping to another artifact shows that artifact at once, never the previous one's preview", () => {
  const script = "```python\nprint('hi')\n```";
  render(<Chat messages={[message("a1", "assistant", script), message("a2", "assistant", SNAKE)]} onUpdateCode={() => true} />);
  fireEvent.click(screen.getByRole("button", { name: /Open the artifact canvas/ }));
  const canvas = screen.getByRole("dialog", { name: "Artifact canvas" });
  expect(within(canvas).getByTitle(/preview$/)).toBeInTheDocument();

  fireEvent.click(within(canvas).getByRole("button", { name: "Previous artifact" }));
  expect(within(canvas).queryByTitle(/preview$/)).not.toBeInTheDocument();
  expect(canvas.querySelector(".md-code-lines")).toHaveTextContent("print('hi')");
  expect(within(canvas).getByRole("button", { name: "Edit" })).toBeInTheDocument();
});

test("Reload starts the preview again from the beginning", () => {
  render(<Chat messages={[message("a1", "assistant", SNAKE)]} onUpdateCode={() => true} />);
  fireEvent.click(screen.getByRole("button", { name: /Open the artifact canvas/ }));
  const canvas = screen.getByRole("dialog", { name: "Artifact canvas" });
  const before = within(canvas).getByTitle(/preview$/);
  fireEvent.click(within(canvas).getByRole("button", { name: "Reload" }));
  const after = within(canvas).getByTitle(/preview$/);
  expect(after).not.toBe(before);
  fireEvent.click(within(canvas).getByRole("button", { name: "Reload" }));
  expect(within(canvas).getByTitle(/preview$/)).not.toBe(after);
});
