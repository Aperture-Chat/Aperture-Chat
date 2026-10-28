import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
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
