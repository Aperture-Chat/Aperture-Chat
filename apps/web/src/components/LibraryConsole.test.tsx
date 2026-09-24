import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import { LibraryConsole } from "./LibraryConsole";

afterEach(() => vi.unstubAllGlobals());

// Tool create/retry, enable, save, and sign-in flows are covered in
// ToolsLibrary.test.tsx; this only checks the shell routes to that view
// without making any request on its own.
test("the tools view renders the Tools library without calling the API", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<LibraryConsole data={sampleData} view="tools" onDataChange={() => undefined} />);
  expect(screen.getByRole("tab", { name: "Connections" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: "Add connection" })).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});
