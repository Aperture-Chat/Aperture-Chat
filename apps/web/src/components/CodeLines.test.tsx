import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { loadCodeHighlighter } from "../lib/codeHighlight";
import { CodeLines } from "./CodeLines";

test("colors each numbered line once the highlighter is loaded", async () => {
  const lines = ["def greet(name):", '    return f"Hi {name}"'];
  const { container } = render(<CodeLines language="python" lines={lines} />);

  // The first colored block loads highlight.js on demand.
  expect(await screen.findByText("def", undefined, { timeout: 8000 })).toHaveClass("hljs-keyword");
  const rows = container.querySelectorAll(".md-code-line-text");
  expect([...rows].map((row) => row.textContent)).toEqual(lines);
});

test("numbers lines, marks the AI target rows, and is keyboard-scrollable", () => {
  const { container } = render(<CodeLines lines={["a", "b", "c", "d"]} marked={{ first: 1, last: 2 }} />);
  const rows = [...container.querySelectorAll(".md-code-line")];
  expect(rows.map((row) => row.querySelector(".md-code-line-number")?.textContent)).toEqual(["1", "2", "3", "4"]);
  expect(rows.map((row) => row.classList.contains("is-marked"))).toEqual([false, true, true, false]);
  expect(container.querySelector("pre")).toHaveAttribute("tabindex", "0");
});

test("previews are not a tab stop", () => {
  const { container } = render(<CodeLines lines={["a"]} preview />);
  expect(container.querySelector("pre")).not.toHaveAttribute("tabindex");
});

test("stays plain text without a language", async () => {
  await loadCodeHighlighter();
  const { container } = render(<CodeLines lines={["const x = 1;"]} />);
  expect(container.querySelector(".md-code-line-text")?.innerHTML).toBe("const x = 1;");
});

// jsdom has no layout. Each rendered row is 20px tall and the block shows at
// most 200px, scrolling inside itself like `.md-code-block` does.
const ROW = 20;
const VIEW = 200;
function fakeBlockLayout(pre: HTMLElement) {
  let top = 0;
  let left = 0;
  const scrollHeight = () => pre.querySelectorAll(".md-code-line").length * ROW;
  const clientHeight = () => Math.min(scrollHeight(), VIEW);
  Object.defineProperty(pre, "scrollHeight", { configurable: true, get: scrollHeight });
  Object.defineProperty(pre, "clientHeight", { configurable: true, get: clientHeight });
  Object.defineProperty(pre, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, scrollHeight() - clientHeight()));
    },
  });
  Object.defineProperty(pre, "scrollLeft", { configurable: true, get: () => left, set: (value: number) => (left = value) });
}

// Layout must exist before the first commit measures it, so it is installed
// on the element the moment React creates it.
function renderMeasured(lines: string[]) {
  const create = document.createElement.bind(document);
  const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string, options?: ElementCreationOptions) => {
    const element = create(tag, options);
    if (tag === "pre") fakeBlockLayout(element);
    return element;
  });
  const view = render(<CodeLines lines={lines} />);
  spy.mockRestore();
  const pre = view.container.querySelector("pre")!;
  const show = (next: string[]) => view.rerender(<CodeLines lines={next} />);
  const readerScrollsTo = (top: number) => {
    pre.scrollTop = top;
    fireEvent.scroll(pre);
  };
  return { pre, show, readerScrollsTo };
}

const numbered = (count: number, from = 0) => Array.from({ length: count }, (_, index) => `line ${index + from}`);

test("a streaming block keeps its newest line in view without touching the sideways scroll", () => {
  const { pre, show } = renderMeasured(numbered(3));
  pre.scrollLeft = 40;
  show(numbered(30));
  expect(pre.scrollTop).toBe(30 * ROW - VIEW);
  show(numbered(45));
  expect(pre.scrollTop).toBe(45 * ROW - VIEW);
  expect(pre.scrollLeft).toBe(40);
});

test("scrolling up inside a streaming block pauses following until the reader returns to the bottom", () => {
  const { pre, show, readerScrollsTo } = renderMeasured(numbered(3));
  show(numbered(30));
  readerScrollsTo(100);
  show(numbered(40));
  expect(pre.scrollTop).toBe(100);

  readerScrollsTo(40 * ROW - VIEW - 20);
  show(numbered(50));
  expect(pre.scrollTop).toBe(50 * ROW - VIEW);
});

test("a long finished block opens at its top and stays there", () => {
  const { pre, show } = renderMeasured(numbered(50));
  expect(pre.scrollTop).toBe(0);
  show(numbered(60));
  expect(pre.scrollTop).toBe(0);
});

test("a view whose code is swapped for a new stream follows the new stream", () => {
  // The code canvas keeps one view while it moves from a long finished file
  // (opened at its top) to a reply that is still being written.
  const { pre, show } = renderMeasured(numbered(50));
  expect(pre.scrollTop).toBe(0);
  show(["fresh"]);
  show(["fresh", ...numbered(40)]);
  expect(pre.scrollTop).toBe(41 * ROW - VIEW);
});

test("a change that is not new lines at the end leaves the reader where they are", () => {
  const { pre, show } = renderMeasured(numbered(3));
  show(numbered(30));
  show(["edited", ...numbered(39, 1)]);
  expect(pre.scrollTop).toBe(30 * ROW - VIEW);
});
