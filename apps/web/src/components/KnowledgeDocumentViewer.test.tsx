import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRequest } from "../lib/citationTargets";
import { loadPdfEngine, type PdfDocumentHandle, type PdfEngine } from "../lib/pdfEngine";
import type { KnowledgeDocumentView } from "../lib/types";
import KnowledgeDocumentViewer from "./KnowledgeDocumentViewer";

vi.mock("../lib/pdfEngine", () => ({ loadPdfEngine: vi.fn() }));

const PASSAGE = "Client files are kept for seven years after the matter closes.";

const REQUEST: DocumentRequest = { kind: "document", configId: "kb-1", documentId: "doc-1", chunkId: "chunk-1" };

function pdfView(fields: Partial<KnowledgeDocumentView> = {}): KnowledgeDocumentView {
  return {
    document_id: "doc-1",
    knowledge_config_id: "kb-1",
    name: "Handbook.pdf",
    content_type: "application/pdf",
    mode: "pdf",
    file_url: "/api/knowledge/kb-1/documents/doc-1/view/file",
    original_available: true,
    page_count: 60,
    target: { page: 40, page_end: 40, locator: "Page 40", excerpt: PASSAGE, chunk_id: "chunk-1", exact: true },
    segments: [],
    notice: null,
    ...fields,
  };
}

function textView(fields: Partial<KnowledgeDocumentView> = {}): KnowledgeDocumentView {
  return pdfView({
    mode: "text",
    file_url: null,
    original_available: false,
    page_count: null,
    notice: "original_missing",
    target: { page: 2, page_end: 2, locator: "Page 2", excerpt: PASSAGE, chunk_id: "chunk-2", exact: true },
    segments: [
      { id: "chunk-1", page: 1, locator: "Page 1", text: "Opening words of the policy." },
      { id: "chunk-2", page: 2, locator: "Page 2", text: `Retention. ${PASSAGE} Other terms follow.` },
    ],
    ...fields,
  });
}

type Route = { status?: number; body?: unknown; blob?: Blob; headers?: Record<string, string> };

function routeResponse(route: Route) {
  if (route.blob) return new Response(route.blob, { status: route.status ?? 200, headers: route.headers });
  return new Response(JSON.stringify(route.body ?? {}), {
    status: route.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The server: answers by route, and records what was asked for. */
function serveApi(routes: {
  view?: Route | (() => Route | Promise<never>);
  file?: Route | (() => Route);
  original?: Route;
  location?: Route;
}) {
  const requested: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/location")) return routeResponse(routes.location ?? { status: 404 });
    if (url.includes("/original")) return routeResponse(routes.original ?? { status: 404 });
    if (url.includes("/view/file")) {
      const file = typeof routes.file === "function" ? routes.file() : routes.file;
      return routeResponse(file ?? { blob: new Blob(["%PDF"]) });
    }
    const view = typeof routes.view === "function" ? await routes.view() : routes.view;
    return routeResponse(view ?? { status: 500 });
  }) as typeof fetch;
  return requested;
}

type FakePdfOptions = {
  pageCount?: number;
  text?: Record<number, string[]>;
  box?: { width: number; height: number };
  openError?: Error;
  pageError?: Error;
  /** Holds one page back, the way a slow page decode does. */
  holdPage?: { number: number; until: Promise<void> };
  labels?: string[] | null;
};

function fakePdf({
  pageCount = 60,
  text = {},
  box = { width: 600, height: 800 },
  openError,
  pageError,
  holdPage,
  labels = null,
}: FakePdfOptions = {}) {
  const fetchedPages: number[] = [];
  const paints: Array<{ page: number; scale: number }> = [];
  const destroy = vi.fn();
  const released: number[] = [];
  const document_: PdfDocumentHandle = {
    pageCount,
    labels,
    page: async (number) => {
      if (pageError) throw pageError;
      if (holdPage?.number === number) await holdPage.until;
      fetchedPages.push(number);
      return {
        box,
        paint: (_canvas, scale) => {
          paints.push({ page: number, scale });
          return { promise: Promise.resolve(), cancel: vi.fn() };
        },
        writeText: (container) => {
          const spans = (text[number] ?? []).map((value) => {
            const span = document.createElement("span");
            span.textContent = value;
            container.append(span);
            return span;
          });
          return { promise: Promise.resolve(spans), cancel: vi.fn() };
        },
        release: () => released.push(number),
      };
    },
  };
  const engine: PdfEngine = {
    open: () => ({
      promise: openError ? Promise.reject(openError) : Promise.resolve(document_),
      cancel: destroy,
      destroy,
    }),
  };
  vi.mocked(loadPdfEngine).mockResolvedValue(engine);
  return { fetchedPages, paints, destroy, released };
}

function openViewer(request: DocumentRequest = REQUEST, onClose = vi.fn()) {
  const view = render(<KnowledgeDocumentViewer userId="user-1" request={request} onClose={onClose} />);
  return { ...view, onClose };
}

const dialog = () => screen.getByRole("dialog");

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:viewer");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true, writable: true });
});

const pageField = () => screen.getByRole("textbox", { name: "Go to page" });

describe("a PDF citation", () => {
  it("opens on the cited page without loading the pages before it", async () => {
    const pdf = fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();

    expect(await screen.findByText("Page 40 of 60")).toBeInTheDocument();
    expect(document.querySelector('[data-page="40"]')).toBeInTheDocument();
    await waitFor(() => expect(pdf.fetchedPages).toContain(40));
    expect(Math.min(...pdf.fetchedPages)).toBeGreaterThanOrEqual(38);
    expect(pdf.fetchedPages.length).toBeLessThan(6);
  });

  it("never reaches for earlier pages when the first measurement rescales them", async () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1020);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(700);
    const pdf = fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();

    await screen.findByText("Page 40 of 60");
    await waitFor(() => expect(document.querySelector("mark")).not.toBeNull());
    expect(Math.min(...pdf.fetchedPages)).toBeGreaterThanOrEqual(38);
  });

  it("marks the cited words on the page, across text spans", async () => {
    fakePdf({ text: { 40: ["Before. Client files are kept for", " seven years after the matter closes. After."] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();

    await waitFor(() => expect(document.querySelectorAll("mark")).toHaveLength(2));
    const marks = Array.from(document.querySelectorAll("mark")).map((mark) => mark.textContent);
    expect(marks).toEqual(["Client files are kept for", " seven years after the matter closes"]);
    expect(document.querySelector('[data-page="40"]')).toContainElement(document.querySelector("mark"));
  });

  it("keeps the surrounding text of a span that is only partly cited", async () => {
    fakePdf({ text: { 40: [`Before. ${PASSAGE} After.`] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();

    const mark = await waitFor(() => {
      const found = document.querySelector("mark");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(mark.parentElement).toHaveTextContent(`Before. ${PASSAGE} After.`);
  });

  it("scrolls the marked passage into view", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rect(this: HTMLElement) {
      const top = this.tagName === "MARK" ? 900 : this.classList.contains("dv-page") ? 100 : 0;
      return { top } as DOMRect;
    });
    openViewer();

    const scroller = await screen.findByRole("region", { name: "Document pages" });
    await waitFor(() => expect(document.querySelector("mark")).not.toBeNull());
    // Nothing above says the page moved, so the offset comes from the mark.
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThanOrEqual(900));
  });

  it("marks the next page too when the passage crosses onto it", async () => {
    const first = "The first half of this cited passage sits at the very end of the earlier page of the handbook";
    const second = "and the second half of that same passage carries over onto the top of the page right after it";
    fakePdf({ text: { 40: [first], 41: [second] } });
    serveApi({
      view: {
        body: pdfView({
          target: { page: 40, page_end: 41, locator: "Page 40", excerpt: `${first} ${second}`, chunk_id: "chunk-1", exact: true },
        }),
      },
    });
    openViewer();

    await screen.findByText("Page 40 of 60");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(document.querySelectorAll("mark")).toHaveLength(2));
  });

  it("keeps the excerpt on screen and says why when a scan has no text to mark", async () => {
    fakePdf({ text: {} });
    serveApi({ view: { body: pdfView() } });
    openViewer();

    const callout = await screen.findByRole("note", { name: "Cited passage" });
    expect(callout).toHaveTextContent(PASSAGE);
    await waitFor(() => expect(callout).toHaveTextContent("could not be marked on this page"));
    expect(document.querySelector("mark")).toBeNull();
  });

  it("does not claim a mark failed while the page is still being read", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    const callout = await screen.findByRole("note", { name: "Cited passage" });
    await waitFor(() => expect(document.querySelector("mark")).not.toBeNull());
    expect(callout).not.toHaveTextContent("could not be marked");
  });

  it("says so when the page is a best guess", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({
      view: { body: pdfView({ target: { ...pdfView().target!, exact: false } }) },
    });
    openViewer();
    expect(await screen.findByRole("note", { name: "Cited passage" })).toHaveTextContent("best match");
  });

  it("names the place in the callout", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    expect(await screen.findByRole("note", { name: "Cited passage" })).toHaveTextContent("Page 40");
  });

  it("opens at the top and says the passage moved when the chunk is gone", async () => {
    fakePdf();
    serveApi({ view: { body: pdfView({ target: null }) } });
    openViewer();

    expect(await screen.findByText("Page 1 of 60")).toBeInTheDocument();
    expect(screen.getByText(/passage has moved/i)).toBeInTheDocument();
    expect(screen.queryByRole("note", { name: "Cited passage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Go to the cited passage" })).toBeNull();
  });

  it("opens a document from the library at the top with no citation talk", async () => {
    fakePdf();
    serveApi({ view: { body: pdfView({ target: null }) } });
    openViewer({ ...REQUEST, chunkId: null } as DocumentRequest);

    expect(await screen.findByText("Page 1 of 60")).toBeInTheDocument();
    expect(screen.queryByText(/passage/i)).toBeNull();
  });

  it("calls a deck's pages slides", async () => {
    fakePdf({ pageCount: 12 });
    serveApi({
      view: {
        body: pdfView({
          content_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          page_count: 12,
          target: { page: 7, page_end: 7, locator: "Slide 7", excerpt: PASSAGE, chunk_id: "chunk-1", exact: true },
        }),
      },
    });
    openViewer();
    expect(await screen.findByText("Slide 7 of 12")).toBeInTheDocument();
  });

  it("stays inside the document when a stored page is past its end", async () => {
    fakePdf({ pageCount: 10 });
    serveApi({ view: { body: pdfView({ page_count: 10 }) } });
    openViewer();
    expect(await screen.findByText("Page 10 of 10")).toBeInTheDocument();
  });
});

describe("moving through a PDF", () => {
  async function openAtPage40() {
    const pdf = fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    const view = openViewer();
    await screen.findByText("Page 40 of 60");
    return { ...view, pdf };
  }

  it("pages with the toolbar", async () => {
    await openAtPage40();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Page 41 of 60")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText("Page 40 of 60")).toBeInTheDocument();
  });

  it("pages with the arrow keys", async () => {
    await openAtPage40();
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(await screen.findByText("Page 41 of 60")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(await screen.findByText("Page 40 of 60")).toBeInTheDocument();
  });

  it("leaves browser shortcuts alone", async () => {
    await openAtPage40();
    fireEvent.keyDown(document, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(document, { key: "ArrowRight", metaKey: true });
    fireEvent.keyDown(document, { key: "ArrowRight", ctrlKey: true });
    expect(screen.getByText("Page 40 of 60")).toBeInTheDocument();
  });

  it("stops at the first and last pages", async () => {
    fakePdf({ pageCount: 2 });
    serveApi({ view: { body: pdfView({ target: null, page_count: 2 }) } });
    openViewer();
    await screen.findByText("Page 1 of 2");
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Page 2 of 2");
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("jumps back to the cited passage", async () => {
    await openAtPage40();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Page 41 of 60");
    fireEvent.click(screen.getByRole("button", { name: "Go to the cited passage" }));
    expect(await screen.findByText("Page 40 of 60")).toBeInTheDocument();
  });

  it("redraws larger on zoom in and smaller on zoom out", async () => {
    const { pdf } = await openAtPage40();
    await waitFor(() => expect(pdf.paints.length).toBeGreaterThan(0));
    const startScale = pdf.paints[pdf.paints.length - 1].scale;

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await screen.findByText("125%");
    await waitFor(() => expect(pdf.paints[pdf.paints.length - 1].scale).toBeCloseTo(startScale * 1.25));

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    await screen.findByText("100%");
    await waitFor(() => expect(pdf.paints[pdf.paints.length - 1].scale).toBeCloseTo(startScale));
  });

  it("stops zooming at both ends", async () => {
    await openAtPage40();
    for (let press = 0; press < 3; press += 1) fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
    for (let press = 0; press < 6; press += 1) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(await screen.findByText("300%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
  });

  it("releases pages it scrolls away from", async () => {
    const { pdf } = await openAtPage40();
    await waitFor(() => expect(pdf.fetchedPages).toContain(40));
    for (let press = 0; press < 5; press += 1) fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Page 45 of 60");
    await waitFor(() => expect(pdf.released.length).toBeGreaterThan(0));
    expect(document.querySelector('[data-page="40"]')).toBeNull();
  });
});

describe("closing", () => {
  it("closes on Escape and returns focus to what opened it", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    function Harness() {
      return <KnowledgeDocumentViewer userId="user-1" request={REQUEST} onClose={onClose} />;
    }
    const onClose = vi.fn();
    const view = render(<Harness />);
    await screen.findByText("Page 40 of 60");
    expect(dialog()).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("closes from the toolbar and from the backdrop", async () => {
    fakePdf();
    serveApi({ view: { body: pdfView() } });
    const { onClose } = openViewer();
    await screen.findByText("Page 40 of 60");
    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    fireEvent.click(screen.getByRole("button", { name: "Close the document" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps Tab inside the dialog", async () => {
    fakePdf();
    serveApi({ view: { body: pdfView() } });
    openViewer();
    await screen.findByText("Page 40 of 60");
    const close = screen.getByRole("button", { name: "Close document" });
    const controls = within(dialog()).getAllByRole("button");
    const scroller = screen.getByRole("region", { name: "Document pages" });
    scroller.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog()).toContainElement(document.activeElement as HTMLElement);
    expect(controls).toContain(close);
  });

  it("destroys the PDF when it closes", async () => {
    const pdf = fakePdf();
    serveApi({ view: { body: pdfView() } });
    const { unmount } = openViewer();
    await screen.findByText("Page 40 of 60");
    unmount();
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });

  it("releases a page that arrives after the viewer has moved on", async () => {
    let arrive = () => {};
    const until = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const pdf = fakePdf({ holdPage: { number: 39, until } });
    serveApi({ view: { body: pdfView() } });
    const { unmount } = openViewer();
    await screen.findByText("Page 40 of 60");
    unmount();
    await act(async () => arrive());
    expect(pdf.released).toContain(39);
  });

  it("does not open a PDF that was closed while its bytes were loading", async () => {
    const pdf = fakePdf();
    let finishFile = (_response: Response) => {};
    serveApi({ view: { body: pdfView() } });
    const serve = globalThis.fetch;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/view/file")
        ? new Promise<Response>((resolve) => { finishFile = resolve; })
        : serve(input, init),
    ) as typeof fetch;
    const { unmount } = openViewer();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    unmount();
    await act(async () => finishFile(new Response(new Blob(["%PDF"]))));
    expect(pdf.fetchedPages).toEqual([]);
  });
});

describe("waiting and failing", () => {
  it("shows it is opening, then that a first conversion is under way", async () => {
    vi.useFakeTimers();
    serveApi({ view: () => new Promise<never>(() => {}) });
    openViewer();
    expect(screen.getByRole("status")).toHaveTextContent("Opening document");
    act(() => {
      vi.advanceTimersByTime(899);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Opening document");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Preparing document");
  });

  it("offers the original when the view fails", async () => {
    serveApi({ view: { status: 500 }, original: { blob: new Blob(["bytes"]) } });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    openViewer();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be opened");
    fireEvent.click(screen.getByRole("button", { name: "Download original" }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("offers the original when pdf.js cannot read the file", async () => {
    fakePdf({ openError: new Error("bad pdf") });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be shown");
    expect(screen.getByRole("button", { name: "Download original" })).toBeInTheDocument();
  });

  it("does not offer an original the server does not have", async () => {
    fakePdf({ openError: new Error("bad pdf") });
    serveApi({ view: { body: pdfView({ original_available: false }) } });
    openViewer();
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Download original" })).toBeNull();
  });

  it("fails calmly when the file route refuses", async () => {
    fakePdf();
    serveApi({ view: { body: pdfView() }, file: { status: 500 } });
    openViewer();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be shown");
  });

  it("fails calmly when a view has no file to render", async () => {
    fakePdf();
    serveApi({ view: { body: pdfView({ file_url: null }) } });
    openViewer();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be shown");
  });

  it("notes a page that fails on its own without losing the document", async () => {
    fakePdf({ pageError: new Error("bad page") });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be shown");
  });

  it("is calm about a document that no longer exists", async () => {
    serveApi({ view: { status: 404 } });
    openViewer();
    expect(await screen.findByText("This document is no longer available")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download original" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close document" })).toBeInTheDocument();
  });
});

describe("page labels", () => {
  const LABELS = [...Array.from({ length: 10 }, (_, index) => `f${index + 1}`), ...Array.from({ length: 50 }, (_, index) => `${index + 1}`)];

  it("shows the printed page and keeps the file's position", async () => {
    fakePdf({ text: { 50: [PASSAGE] }, labels: LABELS });
    serveApi({
      view: { body: pdfView({ target: { ...pdfView().target!, page: 50, page_end: 50, locator: "Page 50" } }) },
    });
    openViewer();
    expect(await screen.findByText("Page 40 (PDF page 50 of 60)")).toBeInTheDocument();
    expect(pageField()).toHaveValue("40");
    expect(screen.getByRole("note", { name: "Cited passage" })).toHaveTextContent("Page 40 (PDF page 50)");
  });

  it("goes to a printed page when one is typed", async () => {
    fakePdf({ labels: LABELS });
    serveApi({ view: { body: pdfView({ target: null }) } });
    openViewer({ ...REQUEST, chunkId: null } as DocumentRequest);
    await screen.findByText(/^Page f1/);
    fireEvent.change(pageField(), { target: { value: "12" } });
    fireEvent.keyDown(pageField(), { key: "Enter" });
    expect(await screen.findByText("Page 12 (PDF page 22 of 60)")).toBeInTheDocument();
  });
});

describe("going to a page", () => {
  async function openAtPage40() {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    await screen.findByText("Page 40 of 60");
    return pageField();
  }

  it("jumps on Enter", async () => {
    const field = await openAtPage40();
    fireEvent.change(field, { target: { value: "12" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await screen.findByText("Page 12 of 60")).toBeInTheDocument();
    expect(field).toHaveValue("12");
  });

  it.each([
    ["0", "Page 1 of 60"],
    ["9999", "Page 60 of 60"],
  ])("clamps %s", async (typed, expected) => {
    const field = await openAtPage40();
    fireEvent.change(field, { target: { value: typed } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it.each(["", "abc", "1.5"])("restores the page after %j", async (typed) => {
    const field = await openAtPage40();
    fireEvent.change(field, { target: { value: typed } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toHaveValue("40");
    expect(screen.getByText("Page 40 of 60")).toBeInTheDocument();
  });

  it("drops an unfinished page when the field loses focus", async () => {
    const field = await openAtPage40();
    fireEvent.change(field, { target: { value: "12" } });
    fireEvent.blur(field);
    expect(field).toHaveValue("40");
    expect(screen.getByText("Page 40 of 60")).toBeInTheDocument();
  });

  it("cancels the edit on Escape and keeps the document open", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    const { onClose } = openViewer();
    await screen.findByText("Page 40 of 60");
    const field = pageField();
    fireEvent.change(field, { target: { value: "12" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field).toHaveValue("40");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape when nothing is being edited", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    const { onClose } = openViewer();
    await screen.findByText("Page 40 of 60");
    fireEvent.keyDown(pageField(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the arrow keys inside the field", async () => {
    const field = await openAtPage40();
    fireEvent.keyDown(field, { key: "ArrowRight" });
    expect(screen.getByText("Page 40 of 60")).toBeInTheDocument();
  });
});

describe("a page zoomed past the view", () => {
  async function openZoomed(realMax: number) {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    await screen.findByText("Page 40 of 60");
    const scroller = screen.getByRole("region", { name: "Document pages" });
    // Chromium reports more room than it will scroll: the scrollbar gutter.
    Object.defineProperty(scroller, "scrollWidth", { value: 1114, configurable: true });
    Object.defineProperty(scroller, "clientWidth", { value: 900, configurable: true });
    let left = 0;
    Object.defineProperty(scroller, "scrollLeft", {
      get: () => left,
      set: (value: number) => {
        left = Math.min(Math.max(value, 0), realMax);
      },
      configurable: true,
    });
    return scroller;
  }

  it("turns the page once the arrow can pan no further, wherever the browser stops", async () => {
    const scroller = await openZoomed(203);
    for (let press = 0; press < 3; press += 1) fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(scroller.scrollLeft).toBe(203);
    expect(screen.getByText("Page 40 of 60")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(await screen.findByText("Page 41 of 60")).toBeInTheDocument();
  });

  it("does not turn the page while there is still somewhere to pan", async () => {
    await openZoomed(203);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getByText("Page 40 of 60")).toBeInTheDocument();
  });

  it("pans back left before turning back", async () => {
    const scroller = await openZoomed(203);
    scroller.scrollLeft = 203;
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(scroller.scrollLeft).toBeLessThan(203);
    expect(screen.getByText("Page 40 of 60")).toBeInTheDocument();
  });
});

describe("a wide page", () => {
  it("pans with the arrow keys before turning the page", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    await screen.findByText("Page 40 of 60");
    const scroller = screen.getByRole("region", { name: "Document pages" });
    Object.defineProperty(scroller, "scrollWidth", { value: 1400, configurable: true });
    Object.defineProperty(scroller, "clientWidth", { value: 900, configurable: true });
    scroller.scrollLeft = 0;

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(scroller.scrollLeft).toBeGreaterThan(0);
    expect(screen.getByText("Page 40 of 60")).toBeInTheDocument();

    scroller.scrollLeft = 500;
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(await screen.findByText("Page 41 of 60")).toBeInTheDocument();
  });
});

describe("the cited sentence", () => {
  const SENTENCE = "Client files are kept for seven years";
  const CHUNK = `Opening terms of the section apply here. ${SENTENCE} after the matter closes. Other terms follow.`;
  const withChunk = () =>
    pdfView({ target: { page: 40, page_end: 40, locator: "Page 40", excerpt: CHUNK, chunk_id: "chunk-1", exact: true } });

  it("marks the sentence strongly and only tints the rest of the chunk", async () => {
    fakePdf({ text: { 40: [CHUNK] } });
    serveApi({ view: { body: withChunk() } });
    openViewer({ ...REQUEST, passage: SENTENCE } as DocumentRequest);
    await waitFor(() => expect(document.querySelector("mark:not(.is-tint)")).toHaveTextContent(SENTENCE));
    const tinted = Array.from(document.querySelectorAll("mark.is-tint")).map((mark) => mark.textContent);
    expect(tinted.join("|")).toContain("Opening terms");
    expect(tinted.join("|")).not.toContain("seven years");
  });

  it("leads the callout with the sentence and shows the rest on request", async () => {
    fakePdf({ text: { 40: [CHUNK] } });
    serveApi({ view: { body: withChunk() } });
    openViewer({ ...REQUEST, passage: SENTENCE } as DocumentRequest);
    const callout = await screen.findByRole("note", { name: "Cited passage" });
    expect(callout).toHaveTextContent(SENTENCE);
    expect(callout).not.toHaveTextContent("Opening terms");
    fireEvent.click(within(callout).getByRole("button", { name: "Show more" }));
    expect(callout).toHaveTextContent("Opening terms");
    fireEvent.click(within(callout).getByRole("button", { name: "Show less" }));
    expect(callout).not.toHaveTextContent("Opening terms");
  });

  it("collapses whitespace in the sentence for display only", async () => {
    fakePdf({ text: { 40: [CHUNK] } });
    serveApi({ view: { body: withChunk() } });
    openViewer({ ...REQUEST, passage: SENTENCE.replace(" are ", "\n  are ") } as DocumentRequest);
    expect(await screen.findByRole("note", { name: "Cited passage" })).toHaveTextContent(SENTENCE);
  });

  it("refuses a stored sentence the server's excerpt does not hold", async () => {
    fakePdf({ text: { 40: [CHUNK] } });
    serveApi({ view: { body: withChunk() } });
    openViewer({ ...REQUEST, passage: "Forged words nobody wrote." } as DocumentRequest);
    const callout = await screen.findByRole("note", { name: "Cited passage" });
    expect(callout).not.toHaveTextContent("Forged");
    expect(callout).toHaveTextContent("Opening terms");
    await waitFor(() => expect(document.querySelector("mark.is-tint")).toHaveTextContent("Opening terms"));
    expect(document.querySelector("mark:not(.is-tint)")).toBeNull();
  });

  it("never sends the sentence to the server", async () => {
    fakePdf({ text: { 40: [CHUNK] } });
    const requested = serveApi({ view: { body: withChunk() } });
    openViewer({ ...REQUEST, passage: SENTENCE } as DocumentRequest);
    await screen.findByText("Page 40 of 60");
    expect(requested.join(" ")).not.toContain("seven");
  });

  it("scrolls to the sentence, not to the top of the chunk", async () => {
    fakePdf({ text: { 40: [CHUNK] } });
    serveApi({ view: { body: withChunk() } });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rect(this: HTMLElement) {
      if (this.tagName === "MARK") return { top: this.classList.contains("is-tint") ? 200 : 1500 } as DOMRect;
      return { top: this.classList.contains("dv-page") ? 100 : 0 } as DOMRect;
    });
    openViewer({ ...REQUEST, passage: SENTENCE } as DocumentRequest);
    const scroller = await screen.findByRole("region", { name: "Document pages" });
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThanOrEqual(1500));
  });

  it("shades the chunk, with no strong mark, when the sentence cannot be found", async () => {
    fakePdf({ text: { 40: ["Opening terms of the section apply here. Other terms follow and more words follow."] } });
    serveApi({
      view: {
        body: pdfView({
          target: {
            page: 40,
            page_end: 40,
            locator: "Page 40",
            excerpt: `Opening terms of the section apply here. Other terms follow and more words follow. ${SENTENCE}`,
            chunk_id: "chunk-1",
            exact: true,
          },
        }),
      },
    });
    openViewer({ ...REQUEST, passage: SENTENCE } as DocumentRequest);
    await waitFor(() => expect(document.querySelector("mark.is-tint")).toHaveTextContent("Opening terms"));
    expect(document.querySelector("mark:not(.is-tint)")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("note", { name: "Cited passage" })).toHaveTextContent("could not be picked out"),
    );
  });

  it("marks both parts of a sentence that crosses onto the next page", async () => {
    const first = "The chunk opens here with plenty of words for evidence, and then the cited sentence begins on this page";
    const second = "and ends on the next page, where the chunk goes on with enough words to count as evidence too.";
    fakePdf({ text: { 40: [first], 41: [second] } });
    serveApi({
      view: {
        body: pdfView({
          target: { page: 40, page_end: 41, locator: "Page 40", excerpt: `${first} ${second}`, chunk_id: "chunk-1", exact: true },
        }),
      },
    });
    openViewer({ ...REQUEST, passage: "the cited sentence begins on this page and ends on the next page" } as DocumentRequest);
    await screen.findByText("Page 40 of 60");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(document.querySelectorAll("mark:not(.is-tint)")).toHaveLength(2));
    const solid = Array.from(document.querySelectorAll("mark:not(.is-tint)")).map((mark) => mark.textContent);
    expect(solid).toEqual(["the cited sentence begins on this page", "and ends on the next page"]);
  });

  it("leads the callout with the page's own words, not the extractor's", async () => {
    const page = "Opening terms of the section apply here. The Stafford office confirmed the transfer in writing. Other terms.";
    const extracted = "Opening terms of the section apply here. The Sta ff ord o ffi ce confirmed the transfer in writing. Other terms.";
    fakePdf({ text: { 40: [page] } });
    serveApi({ view: { body: pdfView({ target: { ...pdfView().target!, excerpt: extracted } }) } });
    openViewer({ ...REQUEST, passage: "The Sta ff ord o ffi ce confirmed the transfer in writing." } as DocumentRequest);
    const callout = await screen.findByRole("note", { name: "Cited passage" });
    await waitFor(() => expect(callout).toHaveTextContent("The Stafford office confirmed the transfer in writing"));
  });

  it("marks the sentence in text mode", async () => {
    serveApi({
      view: {
        body: textView({
          target: { page: 1, page_end: 1, locator: "Page 1", excerpt: CHUNK, chunk_id: "chunk-1", exact: true },
          segments: [{ id: "chunk-1", page: 1, locator: "Page 1", text: CHUNK }],
        }),
      },
    });
    openViewer({ ...REQUEST, passage: SENTENCE } as DocumentRequest);
    await screen.findByRole("heading", { name: "Page 1" });
    expect(document.querySelector("mark:not(.is-tint)")).toHaveTextContent(SENTENCE);
    expect(document.querySelector("mark.is-tint")).toHaveTextContent("Opening terms");
  });
});

describe("a citation with no sentence singled out", () => {
  it("shades the chunk with no strong mark and says why", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    await waitFor(() => expect(document.querySelector("mark.is-tint")).not.toBeNull());
    expect(document.querySelector("mark:not(.is-tint)")).toBeNull();
    const callout = screen.getByRole("note", { name: "Cited passage" });
    await waitFor(() => expect(callout).toHaveTextContent("whole passage is shaded"));
  });

  it("still lands on the shaded passage", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rect(this: HTMLElement) {
      return { top: this.tagName === "MARK" ? 900 : this.classList.contains("dv-page") ? 100 : 0 } as DOMRect;
    });
    openViewer();
    const scroller = await screen.findByRole("region", { name: "Document pages" });
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThanOrEqual(900));
  });

  it("does the same in text mode", async () => {
    serveApi({ view: { body: textView() } });
    openViewer();
    await screen.findByRole("heading", { name: "Page 2" });
    expect(document.querySelector("mark.is-tint")).toHaveTextContent(PASSAGE.slice(0, -1));
    expect(document.querySelector("mark:not(.is-tint)")).toBeNull();
    expect(screen.getByRole("note", { name: "Cited passage" })).toHaveTextContent("whole passage is shaded");
  });

  it("says nothing of shading on a scan, where nothing could be marked", async () => {
    fakePdf({ text: {} });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    const callout = await screen.findByRole("note", { name: "Cited passage" });
    await waitFor(() => expect(callout).toHaveTextContent("could not be marked on this page"));
    expect(callout).not.toHaveTextContent("shaded");
  });
});

describe("the callout", () => {
  it("keeps the excerpt readable", async () => {
    fakePdf({ text: {} });
    serveApi({
      view: {
        body: pdfView({
          target: { page: 40, page_end: 41, locator: "Page 40", excerpt: "rior county | Tamsin | 811.", chunk_id: "chunk-1", exact: true },
        }),
      },
    });
    openViewer();
    const callout = await screen.findByRole("note", { name: "Cited passage" });
    expect(callout).toHaveTextContent("… county · Tamsin · 811.");
    expect(callout).toHaveTextContent("Pages 40–41");
  });

  it("offers Show more only when there is more", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    const callout = await screen.findByRole("note", { name: "Cited passage" });
    expect(within(callout).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("offers Show more for a long excerpt", async () => {
    fakePdf({ text: {} });
    serveApi({ view: { body: pdfView({ target: { ...pdfView().target!, excerpt: `${PASSAGE} `.repeat(8) } }) } });
    openViewer();
    const callout = await screen.findByRole("note", { name: "Cited passage" });
    expect(within(callout).getByRole("button", { name: "Show more" })).toBeInTheDocument();
  });

  it("starts collapsed on a short screen, keeping the page, and opens on request", async () => {
    Object.defineProperty(window, "innerHeight", { value: 375, configurable: true, writable: true });
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    const callout = await screen.findByRole("note", { name: "Cited passage" });
    expect(callout).not.toHaveTextContent(PASSAGE);
    const toggle = within(callout).getByRole("button", { name: "Show the passage" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(callout).toHaveTextContent(PASSAGE);
    expect(within(callout).getByRole("button", { name: "Hide the passage" })).toHaveAttribute("aria-expanded", "true");
  });

  it("starts open on an ordinary screen", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    expect(await screen.findByRole("note", { name: "Cited passage" })).toHaveTextContent(PASSAGE);
  });
});

describe("a removed passage", () => {
  it("opens at the page the citation named, and says it is a best guess", async () => {
    fakePdf();
    serveApi({ view: { body: pdfView({ target: null }) } });
    openViewer({ ...REQUEST, pageHint: 5 } as DocumentRequest);
    expect(await screen.findByText("Page 5 of 60")).toBeInTheDocument();
    expect(screen.getByText(/passage has moved/i)).toHaveTextContent("page it was cited from");
  });

  it("ignores a hint when the server found the passage", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    serveApi({ view: { body: pdfView() } });
    openViewer({ ...REQUEST, pageHint: 5 } as DocumentRequest);
    expect(await screen.findByText("Page 40 of 60")).toBeInTheDocument();
  });

  it("stays inside the document for a stale hint", async () => {
    fakePdf({ pageCount: 3 });
    serveApi({ view: { body: pdfView({ target: null, page_count: 3 }) } });
    openViewer({ ...REQUEST, pageHint: 50 } as DocumentRequest);
    expect(await screen.findByText("Page 3 of 3")).toBeInTheDocument();
  });
});

describe("the app behind the viewer", () => {
  it("is inert while the viewer is open, and focus still returns", async () => {
    const root = document.createElement("div");
    root.id = "root";
    const opener = document.createElement("button");
    root.append(opener);
    document.body.append(root);
    opener.focus();
    fakePdf();
    serveApi({ view: { body: pdfView() } });
    const { unmount } = openViewer();
    await screen.findByText("Page 40 of 60");
    expect(root.inert).toBe(true);
    unmount();
    expect(root.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
    root.remove();
  });

  it("keeps Cmd+K from opening search behind it", async () => {
    fakePdf();
    serveApi({ view: { body: pdfView() } });
    const { unmount } = openViewer();
    await screen.findByText("Page 40 of 60");
    expect(fireEvent.keyDown(window, { key: "k", metaKey: true })).toBe(false);
    expect(fireEvent.keyDown(window, { key: "K", ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(window, { key: "c", metaKey: true })).toBe(true);
    unmount();
    expect(fireEvent.keyDown(window, { key: "k", metaKey: true })).toBe(true);
  });
});

describe("an unreadable file", () => {
  const unreadable = (fields: Partial<KnowledgeDocumentView> = {}) =>
    textView({ segments: [], target: null, notice: "conversion_failed", original_available: true, ...fields });

  it("says so plainly and offers the original, with no contradiction", async () => {
    serveApi({ view: { body: unreadable() }, original: { blob: new Blob(["bytes"]) } });
    openViewer({ ...REQUEST, chunkId: null } as DocumentRequest);
    expect(await screen.findByText(/protected or damaged/i)).toBeInTheDocument();
    expect(screen.queryByText(/shows the text that was indexed/i)).toBeNull();
    expect(screen.queryByText("Nothing to show")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Download original" })).toHaveLength(2);
  });

  it("stays plain when there is no original either", async () => {
    serveApi({ view: { body: unreadable({ original_available: false, notice: null }) } });
    openViewer({ ...REQUEST, chunkId: null } as DocumentRequest);
    expect(await screen.findByText(/no readable text/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download original" })).toBeNull();
  });

  it.each([
    ["PasswordException", /protected by a password/i],
    ["InvalidPDFException", /damaged/i],
  ])("names %s from pdf.js, with the original and no retry", async (name, title) => {
    fakePdf({ openError: Object.assign(new Error("x"), { name }) });
    serveApi({ view: { body: pdfView() } });
    openViewer();
    expect(await screen.findByRole("alert")).toHaveTextContent(title);
    expect(screen.getByRole("button", { name: "Download original" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("failing honestly", () => {
  it("tells an expired session to sign in, with nothing that cannot work", async () => {
    serveApi({ view: { status: 401 } });
    openViewer();
    expect(await screen.findByRole("alert")).toHaveTextContent(/session has ended/i);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download original" })).toBeNull();
  });

  it("says when access is refused", async () => {
    serveApi({ view: { status: 403 } });
    openViewer();
    expect(await screen.findByRole("alert")).toHaveTextContent(/do not have access/i);
  });

  it("does not blame the file when its request fails", async () => {
    fakePdf();
    serveApi({ view: { body: pdfView() }, file: { status: 500 } });
    openViewer();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("could not be shown");
    expect(alert).not.toHaveTextContent(/password|damaged/i);
  });

  it("reports an expired session on the file route", async () => {
    fakePdf();
    serveApi({ view: { body: pdfView() }, file: { status: 401 } });
    openViewer();
    expect(await screen.findByRole("alert")).toHaveTextContent(/session has ended/i);
  });

  it("recovers on Try again when the view failed", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    let calls = 0;
    serveApi({ view: () => ((calls += 1) === 1 ? { status: 500 } : { body: pdfView() }) });
    openViewer();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Page 40 of 60")).toBeInTheDocument();
  });

  it("recovers on Try again when the file failed", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    let calls = 0;
    serveApi({ view: { body: pdfView() }, file: () => ((calls += 1) === 1 ? { status: 500 } : { blob: new Blob(["%PDF"]) }) });
    openViewer();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Page 40 of 60")).toBeInTheDocument();
  });

  it("recovers on Try again when an image failed", async () => {
    let calls = 0;
    serveApi({
      view: { body: pdfView({ mode: "image", name: "Chart.png", content_type: "image/png", target: null }) },
      file: () => ((calls += 1) === 1 ? { status: 500 } : { blob: new Blob(["png"], { type: "image/png" }) }),
    });
    openViewer();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("img", { name: "Chart.png" })).toBeInTheDocument();
  });

  it("saves the original under the server's name when the view never said", async () => {
    serveApi({
      view: { status: 500 },
      original: { blob: new Blob(["bytes"]), headers: { "Content-Disposition": "attachment; filename*=UTF-8''Lease%20v2.docx" } },
    });
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    openViewer();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Download original" }));
    await waitFor(() => expect(clicks).toEqual(["Lease v2.docx"]));
  });
});

describe("downloading the original", () => {
  it("saves it under the document's name", async () => {
    fakePdf();
    const requested = serveApi({ view: { body: pdfView() }, original: { blob: new Blob(["bytes"]) } });
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    openViewer();
    await screen.findByText("Page 40 of 60");
    fireEvent.click(screen.getByRole("button", { name: "Download original" }));
    await waitFor(() => expect(clicks).toEqual(["Handbook.pdf"]));
    expect(requested.some((url) => url.endsWith("/api/knowledge/kb-1/documents/doc-1/original"))).toBe(true);
  });

  it("says when the download fails", async () => {
    fakePdf();
    serveApi({ view: { body: pdfView() }, original: { status: 500 } });
    openViewer();
    await screen.findByText("Page 40 of 60");
    fireEvent.click(screen.getByRole("button", { name: "Download original" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Download failed");
  });
});

describe("an old citation", () => {
  const OLD: DocumentRequest = { kind: "chunk", chunkId: "chunk-1" };

  it("finds its document through the chunk and opens the passage", async () => {
    fakePdf({ text: { 40: [PASSAGE] } });
    const requested = serveApi({
      location: { body: { knowledge_config_id: "kb-1", document_id: "doc-1" } },
      view: { body: pdfView() },
    });
    openViewer(OLD);
    expect(await screen.findByText("Page 40 of 60")).toBeInTheDocument();
    expect(requested[0]).toMatch(/\/api\/knowledge\/chunks\/chunk-1\/location$/);
    expect(requested[1]).toMatch(/\/api\/knowledge\/kb-1\/documents\/doc-1\/view\?chunk_id=chunk-1$/);
  });

  it("is calm when the passage is gone", async () => {
    serveApi({ location: { status: 404 } });
    openViewer(OLD);
    expect(await screen.findByText("This passage is no longer available")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers the original when the view fails after the lookup worked", async () => {
    serveApi({
      location: { body: { knowledge_config_id: "kb-1", document_id: "doc-1" } },
      view: { status: 500 },
      original: { blob: new Blob(["bytes"]) },
    });
    openViewer(OLD);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Download original" })).toBeInTheDocument();
  });

  it("has no original to offer when the lookup itself failed", async () => {
    serveApi({ location: { status: 500 } });
    openViewer(OLD);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Download original" })).toBeNull();
  });
});

describe("text mode", () => {
  it("shows paper pages with headings, never a raw dump", async () => {
    serveApi({ view: { body: textView() } });
    openViewer();
    expect(await screen.findByRole("heading", { name: "Page 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Page 2" })).toBeInTheDocument();
    expect(document.querySelectorAll(".dv-paper")).toHaveLength(2);
  });

  it("marks the passage and opens on its sheet", async () => {
    serveApi({ view: { body: textView() } });
    openViewer();
    await screen.findByRole("heading", { name: "Page 2" });
    expect(document.querySelector("mark")).toHaveTextContent(PASSAGE.slice(0, -1));
    expect(document.querySelector(".dv-position")).toHaveTextContent("Page 2");
  });

  it("explains why the original layout is missing, and offers no download", async () => {
    serveApi({ view: { body: textView() } });
    openViewer();
    expect(await screen.findByText(/original file is not available/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download original" })).toBeNull();
  });

  it("keeps the callout for the cited passage", async () => {
    serveApi({ view: { body: textView() } });
    openViewer();
    expect(await screen.findByRole("note", { name: "Cited passage" })).toHaveTextContent(PASSAGE);
  });

  it("pages through sheets by button and key", async () => {
    serveApi({ view: { body: textView() } });
    openViewer();
    await screen.findByRole("heading", { name: "Page 2" });
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await waitFor(() => expect(document.querySelector(".dv-position")).toHaveTextContent("Page 1"));
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() => expect(document.querySelector(".dv-position")).toHaveTextContent("Page 2"));
  });

  it("jumps back to the passage's sheet", async () => {
    serveApi({ view: { body: textView() } });
    openViewer();
    await screen.findByRole("heading", { name: "Page 2" });
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to the cited passage" }));
    await waitFor(() => expect(document.querySelector(".dv-position")).toHaveTextContent("Page 2"));
  });

  it("shades a whole chunk when the words do not line up", async () => {
    serveApi({
      view: {
        body: textView({
          target: { page: 2, page_end: 2, locator: "Page 2", excerpt: "words not on the sheet", chunk_id: "chunk-2", exact: true },
        }),
      },
    });
    openViewer();
    await screen.findByRole("heading", { name: "Page 2" });
    expect(document.querySelector("mark")).toHaveTextContent("Retention.");
  });

  it("is plain about a document with no readable text", async () => {
    serveApi({ view: { body: textView({ segments: [], target: null, notice: null }) } });
    openViewer({ ...REQUEST, chunkId: null } as DocumentRequest);
    expect(await screen.findByText(/no readable text/i)).toBeInTheDocument();
  });

  it("zooms the text", async () => {
    serveApi({ view: { body: textView() } });
    openViewer();
    await screen.findByRole("heading", { name: "Page 2" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(await screen.findByText("125%")).toBeInTheDocument();
    const scroller = screen.getByRole("region", { name: "Document pages" });
    expect(scroller.style.getPropertyValue("--dv-zoom")).toBe("1.25");
  });

  it("shows sheets for a document with no pages, without inventing page numbers", async () => {
    serveApi({
      view: {
        body: textView({
          target: null,
          notice: null,
          segments: [
            { id: "a", page: null, locator: null, text: "x".repeat(3000) },
            { id: "b", page: null, locator: null, text: "y".repeat(3000) },
          ],
        }),
      },
    });
    openViewer({ ...REQUEST, chunkId: null } as DocumentRequest);
    await waitFor(() => expect(document.querySelector(".dv-position")).toHaveTextContent("Section 1 of 2"));
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("image mode", () => {
  const imageView = () =>
    pdfView({ mode: "image", name: "Chart.png", content_type: "image/png", page_count: null, target: null });

  it("shows the image from an object URL and releases it on close", async () => {
    serveApi({ view: { body: imageView() }, file: { blob: new Blob(["png"], { type: "image/png" }) } });
    const { unmount } = openViewer();
    const image = await screen.findByRole("img", { name: "Chart.png" });
    expect(image).toHaveAttribute("src", "blob:viewer");
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:viewer");
  });

  it("fails calmly when the image cannot be fetched", async () => {
    serveApi({ view: { body: imageView() }, file: { status: 500 } });
    openViewer();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be shown");
  });

  it("shows the callout for a citation of an image", async () => {
    serveApi({
      view: {
        body: pdfView({
          mode: "image",
          name: "Chart.png",
          content_type: "image/png",
          page_count: null,
          target: { page: null, page_end: null, locator: null, excerpt: "Text read from the chart.", chunk_id: "chunk-1", exact: true },
        }),
      },
      file: { blob: new Blob(["png"], { type: "image/png" }) },
    });
    openViewer();
    expect(await screen.findByRole("note", { name: "Cited passage" })).toHaveTextContent("Text read from the chart.");
  });

  it("zooms the image", async () => {
    serveApi({ view: { body: imageView() }, file: { blob: new Blob(["png"], { type: "image/png" }) } });
    openViewer();
    await screen.findByRole("img", { name: "Chart.png" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(await screen.findByText("125%")).toBeInTheDocument();
  });
});
