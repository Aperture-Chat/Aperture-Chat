import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { DocumentFinding } from "../lib/documentChecks";
import { DocumentCheckPanel } from "./DocumentCheckPanel";

const findings: DocumentFinding[] = [
  { group: "blanks", block: 2, title: "[Name]", detail: "Placeholder still in the text" },
  { group: "blanks", block: 5, title: "Paid on ____.", detail: "1 blank to fill in" },
  { group: "terms", block: 1, title: "“Consultant”", detail: "Defined here, but not used anywhere else" },
];

test("findings are listed under plain headings with how many each holds", () => {
  render(<DocumentCheckPanel findings={findings} onJump={vi.fn()} onClose={vi.fn()} />);

  const panel = screen.getByRole("complementary", { name: "Document check" });
  expect(within(panel).getByRole("status")).toHaveTextContent("3 things to look at");
  const blanks = within(panel).getByRole("region", { name: "Blanks to fill in" });
  expect(within(blanks).getByRole("heading")).toHaveTextContent("Blanks to fill in 2");
  expect(within(blanks).getAllByRole("button").map((button) => button.textContent)).toEqual([
    "[Name]Placeholder still in the text",
    "Paid on ____.1 blank to fill in",
  ]);
  expect(within(panel).getByRole("region", { name: "Defined terms" })).toBeInTheDocument();
  expect(within(panel).queryByRole("region", { name: "Cross-references" })).not.toBeInTheDocument();
  expect(within(panel).queryByRole("region", { name: "Numbering" })).not.toBeInTheDocument();
});

test("choosing a finding goes to it, and the panel can be closed", () => {
  const onJump = vi.fn();
  const onClose = vi.fn();
  render(<DocumentCheckPanel findings={findings} onJump={onJump} onClose={onClose} />);

  fireEvent.click(screen.getByRole("button", { name: /Consultant/ }));
  fireEvent.click(screen.getByRole("button", { name: "Close check" }));

  expect(onJump).toHaveBeenCalledWith(findings[2]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("one finding is counted in the singular", () => {
  render(<DocumentCheckPanel findings={findings.slice(0, 1)} onJump={vi.fn()} onClose={vi.fn()} />);

  expect(screen.getByRole("status")).toHaveTextContent("1 thing to look at");
});

test("a clean document says so in words, and what was looked for", () => {
  render(<DocumentCheckPanel findings={[]} onJump={vi.fn()} onClose={vi.fn()} />);

  expect(screen.getByRole("status")).toHaveTextContent("Nothing to fix.");
  expect(screen.getByText(/No blanks or placeholders, no unused or undefined terms/)).toBeInTheDocument();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

test("the panel always says the checks do not replace a read", () => {
  render(<DocumentCheckPanel findings={[]} onJump={vi.fn()} onClose={vi.fn()} />);

  expect(screen.getByText(/They do not replace your own read/)).toBeInTheDocument();
});
