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
test("heading markers inside a flattened excerpt do not show", () => {
  // The index joins a chat's messages into one line, so a reply's heading
  // lands mid-snippet: "question ## Heading answer".
  const { container } = render(<SearchSnippet text={"Summarize the open matters for me ## Engagement summary Here is ### Next steps"} />);
  expect(container.textContent).toBe("Summarize the open matters for me Engagement summary Here is Next steps");
});
test("a lone # that is not a heading marker stays", () => {
  const { container } = render(<SearchSnippet text={"Fix the C# parser for issue #42"} />);
  expect(container.textContent).toBe("Fix the C# parser for issue #42");
});
