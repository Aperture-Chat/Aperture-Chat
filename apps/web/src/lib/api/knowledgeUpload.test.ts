import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { listKnowledgeFolders, uploadKnowledgeFile, uploadKnowledgeFolderFile } from "./knowledge";

type Listener = (event?: ProgressEvent) => void;

class FakeRequest {
  static last: FakeRequest;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: FormData | null = null;
  status = 0;
  responseText = "";
  responseType = "";
  aborted = false;
  upload: { onprogress: Listener | null; onload: Listener | null } = { onprogress: null, onload: null };
  onload: Listener | null = null;
  onerror: Listener | null = null;
  onabort: Listener | null = null;

  constructor() {
    FakeRequest.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

beforeEach(() => {
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("a folder file is posted with its path and whole-millisecond modified time", async () => {
  const file = new File(["brief"], "brief.txt", { lastModified: 1_700_000_000_123 });
  const sending = uploadKnowledgeFolderFile("user-a", "kb 1", file, "Matter 12/brief.txt");
  const request = FakeRequest.last;
  expect(request.method).toBe("POST");
  expect(request.url).toMatch(/\/api\/knowledge\/kb%201\/folder-files$/);
  expect(request.body?.get("path")).toBe("Matter 12/brief.txt");
  expect(request.body?.get("modified")).toBe("1700000000123");
  expect((request.body?.get("file") as File).name).toBe("brief.txt");
  expect(request.upload.onprogress).toBeNull();
  request.respond(200, JSON.stringify({ action: "added" }));
  await expect(sending).resolves.toEqual({ action: "added" });
});

test("a file without a modified time is sent as zero", async () => {
  const file = new File(["x"], "x.txt");
  Object.defineProperty(file, "lastModified", { value: Number.NaN });
  void uploadKnowledgeFolderFile("user-a", "kb", file, "M/x.txt").catch(() => undefined);
  expect(FakeRequest.last.body?.get("modified")).toBe("0");
});

test("a plain upload reports progress and the server's reply", async () => {
  const progress = vi.fn();
  const sending = uploadKnowledgeFile("user-a", "kb", new File(["x"], "x.txt"), { onUploadProgress: progress });
  const request = FakeRequest.last;
  expect(request.url).toMatch(/\/api\/knowledge\/kb\/documents$/);
  expect((request.body?.get("files") as File).name).toBe("x.txt");
  request.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
  request.upload.onprogress?.({ lengthComputable: false, loaded: 5, total: 0 } as ProgressEvent);
  request.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 0 } as ProgressEvent);
  request.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 } as ProgressEvent);
  request.upload.onload?.();
  expect(progress.mock.calls).toEqual([[0.5], [1], [1]]);
  request.respond(201, JSON.stringify({ documents: [] }));
  await expect(sending).resolves.toEqual({ documents: [] });
});

test("refusals carry the server's words and unreadable replies say so", async () => {
  const refused = uploadKnowledgeFolderFile("user-a", "kb", new File(["x"], "x.txt"), "M/x.txt");
  FakeRequest.last.respond(422, JSON.stringify({ detail: "This file could not be added from its folder." }));
  await expect(refused).rejects.toThrow("This file could not be added from its folder.");

  const garbled = uploadKnowledgeFolderFile("user-a", "kb", new File(["x"], "x.txt"), "M/x.txt");
  FakeRequest.last.respond(200, "<html>proxy</html>");
  await expect(garbled).rejects.toThrow("The server finished the upload but sent an unreadable reply.");

  const redirected = uploadKnowledgeFolderFile("user-a", "kb", new File(["x"], "x.txt"), "M/x.txt");
  FakeRequest.last.respond(300, JSON.stringify({ detail: "Multiple choices" }));
  await expect(redirected).rejects.toThrow("Multiple choices");

  const tooBig = uploadKnowledgeFolderFile("user-a", "kb", new File(["x"], "x.txt"), "M/x.txt");
  FakeRequest.last.respond(413, "Request Entity Too Large");
  await expect(tooBig).rejects.toThrow("The file is larger than the server accepts.");

  const offline = uploadKnowledgeFolderFile("user-a", "kb", new File(["x"], "x.txt"), "M/x.txt");
  FakeRequest.last.onerror?.();
  await expect(offline).rejects.toThrow("Could not upload the file. Check your connection and try again.");
});

test("stopping an upload aborts the request, and a stopped signal never sends", async () => {
  const controller = new AbortController();
  const sending = uploadKnowledgeFolderFile("user-a", "kb", new File(["x"], "x.txt"), "M/x.txt", {
    signal: controller.signal,
  });
  const request = FakeRequest.last;
  controller.abort();
  expect(request.aborted).toBe(true);
  await expect(sending).rejects.toThrow("Upload cancelled.");

  const before = FakeRequest.last;
  await expect(
    uploadKnowledgeFolderFile("user-a", "kb", new File(["x"], "x.txt"), "M/x.txt", { signal: controller.signal }),
  ).rejects.toThrow("Upload cancelled.");
  expect(FakeRequest.last).toBe(before);
});

test("the folder list comes from the folders endpoint", async () => {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ folders: [{ name: "Matter 12", files: [], removed: [] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(listKnowledgeFolders("user-a", "kb-1")).resolves.toEqual([{ name: "Matter 12", files: [], removed: [] }]);
  expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/api\/knowledge\/kb-1\/folders$/);
});
