import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contentDispositionName,
  getKnowledgeDocumentView,
  loadKnowledgeDocumentBytes,
  loadKnowledgeDocumentOriginal,
  locateKnowledgeChunk,
  parseKnowledgeDocumentView,
} from "./knowledge";
import { ChatRequestError, setSessionToken } from "./http";

const fetchMock = vi.fn<typeof fetch>();

function respondWith(body: BodyInit | null, init: ResponseInit = {}) {
  fetchMock.mockResolvedValue(new Response(body, init));
  globalThis.fetch = fetchMock;
}

function requested() {
  const [url, init] = fetchMock.mock.calls[0];
  return { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
}

const VIEW = {
  document_id: "doc-1",
  knowledge_config_id: "kb-1",
  name: "Handbook.pdf",
  content_type: "application/pdf",
  mode: "pdf",
  file_url: "/api/knowledge/kb-1/documents/doc-1/view/file",
  original_available: true,
  page_count: 60,
  target: { page: 40, page_end: 41, locator: "Page 40", excerpt: "chunk text", chunk_id: "chunk-1", exact: true },
  segments: [],
  notice: null,
};

afterEach(() => {
  fetchMock.mockReset();
  setSessionToken(null);
});

describe("getKnowledgeDocumentView", () => {
  it("asks for the document with the session header and the chunk", async () => {
    setSessionToken("session-token");
    respondWith(JSON.stringify(VIEW));
    const view = await getKnowledgeDocumentView("user-1", "kb-1", "doc-1", { chunkId: "chunk-1" });
    expect(requested().url).toMatch(/\/api\/knowledge\/kb-1\/documents\/doc-1\/view\?chunk_id=chunk-1$/);
    expect(requested().headers["x-aperture-session"]).toBe("session-token");
    expect(view.target?.page).toBe(40);
  });

  it("leaves the query off without a chunk", async () => {
    respondWith(JSON.stringify(VIEW));
    await getKnowledgeDocumentView("user-1", "kb-1", "doc-1");
    expect(requested().url).toMatch(/\/view$/);
  });

  it("encodes ids so a stored citation cannot walk the path", async () => {
    respondWith(JSON.stringify(VIEW));
    await getKnowledgeDocumentView("user-1", "../admin", "a/b", { chunkId: "x&y=1" });
    expect(requested().url).toContain("/api/knowledge/..%2Fadmin/documents/a%2Fb/view?chunk_id=x%26y%3D1");
  });

  it("reports a missing document with its status", async () => {
    respondWith(JSON.stringify({ detail: "Not found" }), { status: 404 });
    await expect(getKnowledgeDocumentView("user-1", "kb-1", "doc-1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("parseKnowledgeDocumentView", () => {
  it("passes a well-formed view through", () => {
    expect(parseKnowledgeDocumentView(VIEW)).toEqual(VIEW);
  });

  it("rejects an unknown mode and a non-object", () => {
    expect(() => parseKnowledgeDocumentView({ ...VIEW, mode: "html" })).toThrow(ChatRequestError);
    expect(() => parseKnowledgeDocumentView(null)).toThrow(ChatRequestError);
  });

  it("turns a nonsense page into no page instead of a fabricated one", () => {
    const view = parseKnowledgeDocumentView({ ...VIEW, target: { ...VIEW.target, page: 0, page_end: "4" } });
    expect(view.target?.page).toBeNull();
    expect(view.target?.page_end).toBeNull();
  });

  it("rejects pages that are not whole numbers", () => {
    expect(parseKnowledgeDocumentView({ ...VIEW, page_count: 1.5 }).page_count).toBeNull();
    expect(parseKnowledgeDocumentView({ ...VIEW, page_count: 1 }).page_count).toBe(1);
  });

  it("falls back to the first page for a one-page target", () => {
    const view = parseKnowledgeDocumentView({ ...VIEW, target: { ...VIEW.target, page_end: null } });
    expect(view.target?.page_end).toBe(40);
  });

  it("treats a target as a best guess unless the server says exact", () => {
    const { exact: _exact, ...target } = VIEW.target;
    expect(parseKnowledgeDocumentView({ ...VIEW, target }).target?.exact).toBe(false);
  });

  it("reads a null target and a missing excerpt", () => {
    expect(parseKnowledgeDocumentView({ ...VIEW, target: null }).target).toBeNull();
    const view = parseKnowledgeDocumentView({ ...VIEW, target: { page: 2 } });
    expect(view.target).toEqual({ page: 2, page_end: 2, locator: null, excerpt: "", chunk_id: null, exact: false });
  });

  it("reads segments and skips junk entries", () => {
    const view = parseKnowledgeDocumentView({
      ...VIEW,
      mode: "text",
      segments: [{ id: "s1", page: 3, locator: "Page 3", text: "Hello" }, "junk", { text: 4 }],
    });
    expect(view.segments).toEqual([
      { id: "s1", page: 3, locator: "Page 3", text: "Hello" },
      { id: "segment-1", page: null, locator: null, text: "" },
    ]);
  });

  it("reads a missing segment list as empty", () => {
    expect(parseKnowledgeDocumentView({ ...VIEW, segments: null }).segments).toEqual([]);
  });

  it("keeps known notices and drops unknown ones", () => {
    expect(parseKnowledgeDocumentView({ ...VIEW, notice: "privacy_restricted" }).notice).toBe("privacy_restricted");
    expect(parseKnowledgeDocumentView({ ...VIEW, notice: "other" }).notice).toBeNull();
  });

  it("does not claim an original exists unless told so", () => {
    expect(parseKnowledgeDocumentView({ ...VIEW, original_available: "yes" }).original_available).toBe(false);
  });

  it("names an unnamed document plainly", () => {
    expect(parseKnowledgeDocumentView({ ...VIEW, name: "" }).name).toBe("Document");
  });
});

describe("file routes", () => {
  it("fetches view bytes from the route built from the ids", async () => {
    setSessionToken("session-token");
    respondWith(new Uint8Array([37, 80, 68, 70]));
    const blob = await loadKnowledgeDocumentBytes("user-1", "kb-1", "doc-1");
    expect(requested().url).toMatch(/\/api\/knowledge\/kb-1\/documents\/doc-1\/view\/file$/);
    expect(requested().headers["x-aperture-session"]).toBe("session-token");
    expect(blob.size).toBe(4);
  });

  it("fetches the original with the name the server gave it", async () => {
    respondWith(new Uint8Array([1]), { headers: { "Content-Disposition": 'attachment; filename="Lease.docx"' } });
    const original = await loadKnowledgeDocumentOriginal("user-1", "kb-1", "doc-1");
    expect(requested().url).toMatch(/\/api\/knowledge\/kb-1\/documents\/doc-1\/original$/);
    expect(original.filename).toBe("Lease.docx");
    expect(original.blob.size).toBe(1);
  });

  it("has no name when the server gave none", async () => {
    respondWith(new Uint8Array([1]));
    expect((await loadKnowledgeDocumentOriginal("user-1", "kb-1", "doc-1")).filename).toBeNull();
  });

  it("carries the status of a refused download", async () => {
    respondWith("gone", { status: 404 });
    await expect(loadKnowledgeDocumentBytes("user-1", "kb-1", "doc-1")).rejects.toMatchObject({ status: 404 });
  });

  it("says when the API cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    globalThis.fetch = fetchMock;
    await expect(loadKnowledgeDocumentBytes("user-1", "kb-1", "doc-1")).rejects.toThrow("Could not reach the API");
  });

  it("says when the request was cancelled", async () => {
    fetchMock.mockRejectedValue(new DOMException("stopped", "AbortError"));
    globalThis.fetch = fetchMock;
    await expect(loadKnowledgeDocumentBytes("user-1", "kb-1", "doc-1")).rejects.toThrow("cancelled");
  });
});

describe("contentDispositionName", () => {
  it("reads a plain and an unquoted name", () => {
    expect(contentDispositionName('attachment; filename="Lease.docx"')).toBe("Lease.docx");
    expect(contentDispositionName("attachment; filename=Lease.docx")).toBe("Lease.docx");
  });

  it("prefers the encoded name", () => {
    expect(contentDispositionName("attachment; filename=\"x.docx\"; filename*=UTF-8''Caf%C3%A9%20v2.docx")).toBe("Café v2.docx");
  });

  it("survives a malformed encoding", () => {
    expect(contentDispositionName("attachment; filename*=UTF-8''%E0%A4%A; filename=\"safe.pdf\"")).toBe("safe.pdf");
  });

  it("has no name without a header or a filename", () => {
    expect(contentDispositionName(null)).toBeNull();
    expect(contentDispositionName("inline")).toBeNull();
  });
});

describe("locateKnowledgeChunk", () => {
  it("looks the chunk up by id", async () => {
    respondWith(JSON.stringify({ knowledge_config_id: "kb-1", document_id: "doc-1" }));
    await expect(locateKnowledgeChunk("user-1", "chunk/1")).resolves.toEqual({
      knowledge_config_id: "kb-1",
      document_id: "doc-1",
    });
    expect(requested().url).toMatch(/\/api\/knowledge\/chunks\/chunk%2F1\/location$/);
  });
});
