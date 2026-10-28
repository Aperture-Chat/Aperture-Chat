import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/types";
import { ArtifactCanvasProvider } from "./ArtifactCanvas";
import { Markdown } from "./Markdown";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn().mockResolvedValue(true),
    render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 120 60"></svg>' }),
  },
}));

function message(id: string, role: ChatMessage["role"], content: string, status: ChatMessage["status"] = "ok"): ChatMessage {
  return { id, role, content, createdAt: "now", status };
}

const SNAKE = "Here it is:\n\n```html\n<title>Snake</title>\n<canvas></canvas>\n```";
const STYLES = "### Styles\n\n```css\ncanvas { border: 0 }\n```";

function Chat({ messages }: { messages: ChatMessage[] }) {
  return (
    <ArtifactCanvasProvider messages={messages} resetKey="thread-1">
      {messages.map((item) => (
        <Markdown content={item.content} key={item.id} />
      ))}
    </ArtifactCanvasProvider>
  );
}

test("the pull tab appears only when the chat's replies hold code", () => {
  const view = render(
    <Chat
      messages={[
        message("u1", "user", "```html\n<p>user paste</p>\n```"),
        message("a1", "assistant", "```mermaid\nflowchart LR\n  A --> B\n```\n\nJust a diagram."),
      ]}
    />,
  );
  expect(screen.queryByRole("button", { name: /Open the artifact canvas/ })).not.toBeInTheDocument();

  view.rerender(<Chat messages={[message("u1", "user", "Make a game"), message("a1", "assistant", SNAKE)]} />);
  expect(screen.getByRole("button", { name: "Open the artifact canvas (1 artifact)" })).toBeInTheDocument();
});

test("the tab opens the newest artifact, steps through the others, and tucks away while open", async () => {
  render(
    <Chat
      messages={[
        message("u1", "user", "Make a game"),
        message("a1", "assistant", SNAKE),
        message("u2", "user", "Style it"),
        message("a2", "assistant", STYLES),
      ]}
    />,
  );
  const tab = screen.getByRole("button", { name: "Open the artifact canvas (2 artifacts)" });
  expect(within(tab).getByText("2")).toBeInTheDocument();
  tab.focus();
  fireEvent.click(tab);

  const canvas = screen.getByRole("dialog", { name: "Artifact canvas" });
  expect(within(canvas).getByText("styles.css")).toBeInTheDocument();
  expect(within(canvas).getByText("2 / 2")).toBeInTheDocument();
  expect(document.querySelector(".artifact-canvas-edge")).toHaveClass("is-covered");
  expect(document.querySelector(".artifact-canvas-edge")).toHaveAttribute("inert");

  fireEvent.click(within(canvas).getByRole("button", { name: "Previous artifact" }));
  expect(within(canvas).getByText("snake.html")).toBeInTheDocument();
  expect(within(canvas).getByText("1 / 2")).toBeInTheDocument();
  expect(within(canvas).getByRole("button", { name: "Previous artifact" })).toBeDisabled();
  await waitFor(() => expect(within(canvas).getByTitle("snake.html preview")).toHaveFocus());

  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Artifact canvas" })).not.toBeInTheDocument();
  expect(tab).toHaveFocus();
});

test("Preview inside the chat opens the one shared canvas the tab controls", () => {
  render(<Chat messages={[message("u1", "user", "Make a game"), message("a1", "assistant", SNAKE)]} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(screen.getAllByRole("dialog", { name: "Artifact canvas" })).toHaveLength(1);
  expect(document.querySelector(".artifact-canvas-edge")).toHaveClass("is-covered");
});

test("an open artifact follows the reply as it streams and when the response version changes", async () => {
  const first = message("a1", "assistant", SNAKE);
  const view = render(<Chat messages={[message("u1", "user", "Make a game"), first]} />);
  fireEvent.click(screen.getByRole("button", { name: /Open the artifact canvas/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Code" }));
  const next = message("a1", "assistant", "```html\n<title>Snake</title>\n<canvas id=\"board\"></canvas>\n```");
  view.rerender(<Chat messages={[message("u1", "user", "Make a game"), next]} />);
  const canvas = screen.getByRole("dialog", { name: "Artifact canvas" });
  // Highlighting splits a line into colored spans, so compare whole lines.
  const lines = [...canvas.querySelectorAll(".md-code-line-text")].map((line) => line.textContent);
  expect(lines).toContain('<canvas id="board"></canvas>');
});

test("the tab breathes while a reply is still writing a code block", () => {
  const view = render(
    <Chat
      messages={[
        message("u1", "user", "Make a game"),
        message("a1", "assistant", "```html\n<title>Snake</title>\n<canvas>", "pending"),
      ]}
    />,
  );
  expect(document.querySelector(".artifact-canvas-edge")).toHaveClass("is-working");
  expect(screen.getByRole("button", { name: "Open the artifact canvas (1 artifact, writing)" })).toBeInTheDocument();

  view.rerender(<Chat messages={[message("u1", "user", "Make a game"), message("a1", "assistant", SNAKE)]} />);
  expect(document.querySelector(".artifact-canvas-edge")).not.toHaveClass("is-working");
});

test("switching to another chat closes the canvas", () => {
  const messages = [message("u1", "user", "Make a game"), message("a1", "assistant", SNAKE)];
  const view = render(
    <ArtifactCanvasProvider messages={messages} resetKey="thread-1">
      <span />
    </ArtifactCanvasProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Open the artifact canvas/ }));
  expect(screen.getByRole("dialog", { name: "Artifact canvas" })).toBeInTheDocument();
  view.rerender(
    <ArtifactCanvasProvider messages={[message("u9", "user", "Hi"), message("a9", "assistant", SNAKE.replace("a1", "a9"))]} resetKey="thread-2">
      <span />
    </ArtifactCanvasProvider>,
  );
  expect(screen.queryByRole("dialog", { name: "Artifact canvas" })).not.toBeInTheDocument();
});

test("the blade and tab align to the chat column and follow it on resize", () => {
  const messages = [message("u1", "user", "Make a game"), message("a1", "assistant", SNAKE)];
  const width = Object.getOwnPropertyDescriptor(document.documentElement, "clientWidth");
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1440 });
  let left = 240;
  try {
    render(
      <ArtifactCanvasProvider anchorSelector=".chat-main" messages={messages} resetKey="thread-1">
        <section
          className="chat-main"
          ref={(node) => {
            if (node) node.getBoundingClientRect = () => ({ left, right: 1100 }) as DOMRect;
          }}
        />
      </ArtifactCanvasProvider>,
    );
    const edge = document.querySelector<HTMLElement>(".artifact-canvas-edge")!;
    expect(edge.style.getPropertyValue("--artifact-canvas-edge-right")).toBe("340px");
    fireEvent.click(screen.getByRole("button", { name: /Open the artifact canvas/ }));
    const layer = () => document.querySelector<HTMLElement>(".artifact-canvas-layer")!;
    expect(layer().style.getPropertyValue("--artifact-canvas-left")).toBe("240px");
    left = 72;
    fireEvent(window, new Event("resize"));
    expect(layer().style.getPropertyValue("--artifact-canvas-left")).toBe("72px");
  } finally {
    if (width) Object.defineProperty(document.documentElement, "clientWidth", width);
    else delete (document.documentElement as { clientWidth?: number }).clientWidth;
  }
});

test("Copy in the canvas copies the artifact and reports a failure honestly", async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<Chat messages={[message("u1", "user", "Make a game"), message("a1", "assistant", SNAKE)]} />);
  fireEvent.click(screen.getByRole("button", { name: /Open the artifact canvas/ }));
  const canvas = screen.getByRole("dialog", { name: "Artifact canvas" });
  fireEvent.click(within(canvas).getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(within(canvas).getByRole("button", { name: "Copied" })).toBeInTheDocument());
  expect(writeText).toHaveBeenCalledWith("<title>Snake</title>\n<canvas></canvas>");
  fireEvent.click(within(canvas).getByRole("button", { name: "Copied" }));
  await waitFor(() => expect(within(canvas).getByRole("button", { name: "Failed" })).toBeInTheDocument());
});
