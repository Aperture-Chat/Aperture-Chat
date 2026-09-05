import { Suspense, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LazyChunkBoundary, lazyWithReload } from "./lazyChunk";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("a failed optional panel preserves unfinished work and retries without navigation", async () => {
  // React reports caught render/import errors to the console in development.
  vi.spyOn(console, "error").mockImplementation(() => {});
  const importer = vi.fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
    .mockResolvedValueOnce({ default: ({ title }: { title: string }) => <p>{title}</p> });
  const Panel = lazyWithReload("test-panel", importer);
  function Workspace() {
    const [draft, setDraft] = useState("Unsent review notes");
    const [attachment, setAttachment] = useState<File | null>(null);
    return <>
      <textarea aria-label="Unsent draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <input type="file" aria-label="Staged attachment" onChange={(event) => setAttachment(event.target.files?.[0] ?? null)} />
      {attachment && <span>{attachment.name}</span>}
      <LazyChunkBoundary label="Help">
        <Suspense fallback={<p>Loading help…</p>}><Panel title="Help loaded" /></Suspense>
      </LazyChunkBoundary>
    </>;
  }
  render(<Workspace />);
  const fileInput = screen.getByLabelText("Staged attachment");
  const file = new File(["Unsent file contents"], "review-notes.txt", { type: "text/plain" });
  fireEvent.change(fileInput, { target: { files: [file] } });
  expect(await screen.findByRole("alert")).toHaveTextContent("Help could not load");
  const draft = screen.getByRole("textbox", { name: "Unsent draft" });
  expect(draft).toHaveValue("Unsent review notes");
  fireEvent.change(draft, { target: { value: "Notes kept while help was unavailable" } });
  expect(screen.getByRole("alert")).toHaveTextContent("Save or copy unfinished work before reloading");
  expect(screen.getByRole("button", { name: "Reload page" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Help loaded")).toBeInTheDocument();
  expect(importer).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("textbox", { name: "Unsent draft" })).toBe(draft);
  expect(draft).toHaveValue("Notes kept while help was unavailable");
  expect(screen.getByLabelText("Staged attachment")).toBe(fileInput);
  expect(screen.getByText("review-notes.txt")).toBeInTheDocument();
});

test("successful panel imports do not depend on session storage being available", async () => {
  const blockedStorage = {
    getItem: vi.fn(() => { throw new DOMException("Storage blocked", "SecurityError"); }),
    setItem: vi.fn(() => { throw new DOMException("Storage blocked", "SecurityError"); }),
    removeItem: vi.fn(() => { throw new DOMException("Storage blocked", "SecurityError"); }),
  };
  vi.stubGlobal("sessionStorage", blockedStorage);
  const Panel = lazyWithReload("storage-independent-panel", async () => ({ default: () => <p>Panel ready</p> }));
  render(<LazyChunkBoundary label="Panel"><Suspense fallback={<p>Loading…</p>}><Panel /></Suspense></LazyChunkBoundary>);
  expect(await screen.findByText("Panel ready")).toBeInTheDocument();
  expect(blockedStorage.removeItem).not.toHaveBeenCalled();
});

test("a repeated import failure stays recoverable instead of getting stuck in Suspense", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const importer = vi.fn().mockRejectedValue(new Error("Offline"));
  const Panel = lazyWithReload("offline-panel", importer);
  render(<LazyChunkBoundary label="Panel"><Suspense fallback={<p>Loading…</p>}><Panel /></Suspense></LazyChunkBoundary>);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(importer).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("alert")).toHaveTextContent("Panel could not load");
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
});
