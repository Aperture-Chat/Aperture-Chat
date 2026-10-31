import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useKnowledgeDocumentViewer } from "./KnowledgeDocumentViewerHost";

vi.mock("./KnowledgeDocumentViewer", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

function Page() {
  const { openDocument, documentViewerLayer } = useKnowledgeDocumentViewer("user-1");
  return (
    <>
      <button type="button" onClick={() => openDocument({ kind: "chunk", chunkId: "chunk-9" })}>
        Open source
      </button>
      {documentViewerLayer}
    </>
  );
}

it("shows a failed viewer where the document would have opened, and lets the person leave", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<Page />);
  fireEvent.click(screen.getByRole("button", { name: "Open source" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("The document viewer could not load");
  const blade = screen.getByRole("dialog", { name: "Document" });
  expect(blade).toContainElement(alert);
  // A browser keeps a failed import, so only a reload can recover.
  expect(within(blade).queryByRole("button", { name: "Try again" })).toBeNull();
  expect(within(blade).getByRole("button", { name: "Reload page" })).toBeInTheDocument();

  fireEvent.click(within(blade).getByRole("button", { name: "Close document" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
