import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useKnowledgeDocumentViewer } from "./KnowledgeDocumentViewerHost";

/** Holds the viewer's code back, the way a slow connection does. */
const viewerCode = vi.hoisted(() => {
  let arrive = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return { arrived, arrive: () => arrive() };
});

vi.mock("./KnowledgeDocumentViewer", async () => {
  await viewerCode.arrived;
  return {
    default: ({ userId, request, onClose }: { userId: string; request: { chunkId: string }; onClose: () => void }) => (
      <div role="dialog" aria-label="Loaded viewer">
        <span>{`${userId} opened ${request.chunkId}`}</span>
        <button type="button" onClick={onClose}>Done</button>
      </div>
    ),
  };
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

describe("useKnowledgeDocumentViewer", () => {
  it("shows nothing until a document is opened", () => {
    render(<Page />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("holds the blade open while the code arrives, and lets the person leave", async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Opening document");

    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    viewerCode.arrive();
    await import("./KnowledgeDocumentViewer");
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(await screen.findByRole("dialog", { name: "Loaded viewer" })).toHaveTextContent("user-1 opened chunk-9");
  });

  it("removes the layer on close, and can open again", async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(await screen.findByRole("dialog", { name: "Loaded viewer" })).toBeInTheDocument();
  });
});
