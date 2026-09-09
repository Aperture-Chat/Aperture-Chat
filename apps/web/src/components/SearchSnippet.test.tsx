import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { SearchSnippet } from "./SearchSnippet";

test("search previews format Markdown without interactive links or raw HTML", () => {
  const { container } = render(<SearchSnippet text={'# **Mission** with *emphasis* and [reference](https://example.com) <script>alert(1)</script>'} />);
  expect(screen.getByText("Mission").tagName).toBe("STRONG");
  expect(screen.getByText("emphasis").tagName).toBe("EM");
  expect(container.querySelector("a, script, img")).toBeNull();
});
test("a clipped closing delimiter does not consume the following bold label", () => {
  const { container } = render(<SearchSnippet text={'...Return to the Moon** **Student Name:** **Course:**'} />);
  expect(screen.getByText("Student Name:").tagName).toBe("STRONG");
  expect(container.textContent).not.toContain("**");
});
