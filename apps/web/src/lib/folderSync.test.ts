import { expect, test, vi } from "vitest";
import type { FolderHandle } from "./folderAccess";
import type { LocalFolderFile } from "./folderFiles";
import { FolderSync, runKey, type FolderSyncDeps, type FolderSyncEvent } from "./folderSync";
import { keptFolderKey, memoryKeptFolderStore } from "./keptFolders";
import type { KnowledgeDocument, KnowledgeFolderFileResult, KnowledgeFolderManifest } from "./types";

const USER = "user-a";
const BASE = "kb-1";

function local(path: string, size = 4, lastModified = 1000): LocalFolderFile {
  return { path, file: new File(["x".repeat(size)], path.split("/").pop() ?? path, { lastModified }) };
}

function handle(name: string): FolderHandle {
  return { kind: "directory", name, values: async function* () {} };
}

function sentResult(path: string, action: KnowledgeFolderFileResult["action"] = "added"): KnowledgeFolderFileResult {
  const document: KnowledgeDocument = {
    id: `doc-${path}`,
    knowledge_config_id: BASE,
    tenant_id: "t",
    name: path.split("/").pop() ?? path,
    source_uri: "upload://x",
    source_type: "upload",
    status: "indexed",
    chunk_count: 2,
    acl_group_ids: [],
    updated_at: "now",
    citation_required: true,
    folder_file: { path, size: 4, modified: 1000 },
  };
  return {
    config: {
      id: BASE,
      tenant_id: "t",
      name: "Base",
      source_type: "upload",
      connector_config_id: null,
      enabled: true,
      acl_group_ids: [],
      owner_user_id: USER,
      secret_set: false,
      settings: {},
    } as unknown as KnowledgeFolderFileResult["config"],
    document,
    action,
    provider_message: `Added ${path}.`,
  };
}

function harness(overrides: Partial<FolderSyncDeps> = {}, manifests: KnowledgeFolderManifest[] = []) {
  const sent: string[] = [];
  const store = memoryKeptFolderStore();
  const deps: FolderSyncDeps = {
    listFolders: vi.fn(async () => manifests),
    sendFile: vi.fn(async (_user, _base, _file, path) => {
      sent.push(path);
      return sentResult(path);
    }),
    maxUploadMb: vi.fn(async () => 250),
    readHandle: vi.fn(async () => ({ files: [], truncated: false })),
    readable: vi.fn(async () => true),
    store,
    now: () => 5_000,
    ...overrides,
  };
  const sync = new FolderSync(deps);
  const events: FolderSyncEvent[] = [];
  sync.onEvent((event) => events.push(event));
  return { sync, deps, sent, store, events };
}

test("a first sync sends every readable file and reports what it added", async () => {
  const { sync, sent, events } = harness();
  const result = await sync.sync({
    userId: USER,
    knowledgeId: BASE,
    source: { name: "Matter", files: [local("Matter/b.txt"), local("Matter/a.txt"), local("Matter/tool.exe")] },
  });
  expect(sent).toEqual(["Matter/a.txt", "Matter/b.txt"]);
  expect(result).toMatchObject({ added: 2, updated: 0, unchanged: 0, failed: [], stopped: false });
  expect(result?.skipped).toEqual([{ path: "Matter/tool.exe", reason: "unsupported type" }]);
  expect(events.filter((event) => event.type === "document")).toHaveLength(2);
  expect(events.at(-1)).toMatchObject({ type: "finished", knowledgeId: BASE, name: "Matter" });
  expect(sync.getState().runs.get(runKey(BASE, "Matter"))).toMatchObject({ phase: "done", at: 5_000 });
});

test("a later sync sends only new and changed files", async () => {
  const manifest: KnowledgeFolderManifest = {
    name: "Matter",
    files: [
      { path: "Matter/same.txt", size: 4, modified: 1000, document_id: "d1" },
      { path: "Matter/edited.txt", size: 4, modified: 1000, document_id: "d2" },
    ],
    removed: ["Matter/removed.txt"],
  };
  const { sync, sent, deps } = harness(
    {
      sendFile: vi.fn(async (_user, _base, _file, path: string) => {
        sent.push(path);
        return sentResult(path, path.includes("edited") ? "updated" : "added");
      }),
    },
    [manifest],
  );
  const result = await sync.sync({
    userId: USER,
    knowledgeId: BASE,
    source: {
      name: "Matter",
      files: [local("Matter/same.txt"), local("Matter/edited.txt", 9), local("Matter/new.txt"), local("Matter/removed.txt")],
    },
  });
  expect(sent).toEqual(["Matter/edited.txt", "Matter/new.txt"]);
  expect(result).toMatchObject({ added: 1, updated: 1, unchanged: 1, keptOut: 1 });
  expect(deps.listFolders).toHaveBeenCalledWith(USER, BASE, expect.any(AbortSignal));
});

test("a file the server already had counts as unchanged", async () => {
  const { sync } = harness({ sendFile: vi.fn(async (_u, _b, _f, path: string) => sentResult(path, "unchanged")) });
  const result = await sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "M", files: [local("M/a.txt")] } });
  expect(result).toMatchObject({ added: 0, unchanged: 1 });
});

test("no more than two files are sent at once", async () => {
  let active = 0;
  let peak = 0;
  const { sync } = harness({
    sendFile: vi.fn(async (_user, _base, _file, path: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return sentResult(path);
    }),
  });
  const files = Array.from({ length: 7 }, (_, index) => local(`M/${index}.txt`));
  const result = await sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "M", files } });
  expect(result?.added).toBe(7);
  expect(peak).toBe(2);
});

test("a file that fails is listed and the rest still go", async () => {
  const { sync, sent } = harness({
    sendFile: vi.fn(async (_user, _base, _file, path: string) => {
      if (path === "M/bad.txt") throw new Error("Server error");
      sent.push(path);
      return sentResult(path);
    }),
  });
  const result = await sync.sync({
    userId: USER,
    knowledgeId: BASE,
    source: { name: "M", files: [local("M/bad.txt"), local("M/good.txt")] },
  });
  expect(sent).toEqual(["M/good.txt"]);
  expect(result?.failed).toEqual([{ path: "M/bad.txt", message: "Server error" }]);
});

test("stopping a sync sends nothing more and says it stopped", async () => {
  const waiting: Array<() => void> = [];
  const release = () => waiting.splice(0).forEach((resolve) => resolve());
  const { sync, sent } = harness({
    sendFile: vi.fn(async (_user, _base, _file, path: string, signal: AbortSignal) => {
      sent.push(path);
      await new Promise<void>((resolve) => waiting.push(resolve));
      if (signal.aborted) throw new Error("Upload cancelled.");
      return sentResult(path);
    }),
  });
  const files = Array.from({ length: 5 }, (_, index) => local(`M/${index}.txt`));
  const running = sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "M", files } });
  await vi.waitFor(() => expect(sent.length).toBe(2));
  sync.stop(BASE, "M");
  release();
  const result = await running;
  expect(result?.stopped).toBe(true);
  expect(result?.failed).toEqual([]);
  expect(sent.length).toBeLessThanOrEqual(2);
});

test("a large folder asks first and sends nothing when the person declines", async () => {
  const { sync, sent } = harness();
  const files = Array.from({ length: 501 }, (_, index) => local(`Big/${index}.txt`));
  const confirmLarge = vi.fn(() => false);
  const result = await sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "Big", files }, confirmLarge });
  expect(confirmLarge).toHaveBeenCalledWith(501, 501 * 4);
  expect(result).toBeNull();
  expect(sent).toEqual([]);
  expect(sync.getState().runs.has(runKey(BASE, "Big"))).toBe(false);
});

test("a second sync of a folder that is already running is ignored", async () => {
  const { sync } = harness();
  const source = { name: "M", files: [local("M/a.txt")] };
  const first = sync.sync({ userId: USER, knowledgeId: BASE, source });
  expect(await sync.sync({ userId: USER, knowledgeId: BASE, source })).toBeNull();
  expect((await first)?.added).toBe(1);
});

test("a folder read through its handle is remembered for later syncs", async () => {
  const matter = handle("Matter");
  const { sync, store, deps } = harness({
    readHandle: vi.fn(async () => ({ files: [local("Matter/a.txt")], truncated: true })),
  });
  await sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "Matter", handle: matter } });
  expect(deps.readHandle).toHaveBeenCalledWith(matter);
  const kept = await store.list(USER);
  expect(kept).toEqual([
    {
      key: keptFolderKey(USER, BASE, "Matter"),
      userId: USER,
      knowledgeId: BASE,
      name: "Matter",
      handle: matter,
      keepInSync: false,
      lastChecked: 5_000,
    },
  ]);
  expect(sync.getState().kept).toEqual(kept);
  expect(sync.getState().runs.get(runKey(BASE, "Matter"))).toMatchObject({ phase: "done", truncated: true });
});

test("keeping a folder in sync survives later syncs and can be turned off", async () => {
  const matter = handle("Matter");
  const { sync, store } = harness();
  await sync.setKeepInSync(USER, BASE, "Matter", true, matter);
  expect((await store.list(USER))[0]).toMatchObject({ keepInSync: true, lastChecked: null });
  await sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "Matter", handle: matter } });
  expect((await store.list(USER))[0]).toMatchObject({ keepInSync: true, lastChecked: 5_000 });
  await sync.setKeepInSync(USER, BASE, "Matter", false);
  expect((await store.list(USER))[0]).toMatchObject({ keepInSync: false, handle: matter, lastChecked: 5_000 });
  expect(sync.getState().kept[0]?.keepInSync).toBe(false);
});

test("turning sync off for a folder this browser never kept changes nothing", async () => {
  const { sync, store } = harness();
  await sync.setKeepInSync(USER, BASE, "Unknown", false);
  expect(await store.list(USER)).toEqual([]);
});

test("automatic syncs run only kept folders this browser may still read", async () => {
  const readable = handle("Readable");
  const locked = handle("Locked");
  const notKept = handle("NotKept");
  const { sync, deps, store } = harness({
    readable: vi.fn(async (folder: FolderHandle) => folder !== locked),
  });
  await sync.setKeepInSync(USER, BASE, "Readable", true, readable);
  await sync.setKeepInSync(USER, BASE, "Locked", true, locked);
  await store.put({
    key: keptFolderKey(USER, BASE, "NotKept"),
    userId: USER,
    knowledgeId: BASE,
    name: "NotKept",
    handle: notKept,
    keepInSync: false,
    lastChecked: null,
  });
  await store.put({
    key: keptFolderKey("someone-else", BASE, "Readable"),
    userId: "someone-else",
    knowledgeId: BASE,
    name: "Readable",
    handle: readable,
    keepInSync: true,
    lastChecked: null,
  });
  await sync.load(USER);
  await sync.syncKept(USER);
  expect(sync.getState().runs.get(runKey(BASE, "Readable"))).toMatchObject({ phase: "done" });
  expect(deps.readHandle).toHaveBeenCalledTimes(1);
  expect(deps.readHandle).toHaveBeenCalledWith(readable);
  expect(deps.readable).toHaveBeenCalledWith(locked, false);
  expect(sync.getState().runs.get(runKey(BASE, "Locked"))).toEqual({ phase: "needs-permission" });
});

test("a folder that cannot be read reports why in plain words", async () => {
  const gone = Object.assign(new DOMException("missing", "NotFoundError"));
  const { sync, events } = harness({ readHandle: vi.fn(async () => Promise.reject(gone)) });
  const result = await sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "Matter", handle: handle("Matter") } });
  expect(result).toBeNull();
  expect(sync.getState().runs.get(runKey(BASE, "Matter"))).toEqual({
    phase: "failed",
    message: "The folder could not be found on this computer. It may have been moved or renamed.",
    at: 5_000,
  });
  expect(events).toEqual([]);
});

test("a refused or unexpected failure is reported too", async () => {
  const refused = new DOMException("no", "NotAllowedError");
  const first = harness({ readHandle: vi.fn(async () => Promise.reject(refused)) });
  await first.sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "M", handle: handle("M") } });
  expect(first.sync.getState().runs.get(runKey(BASE, "M"))).toMatchObject({
    message: "This browser did not allow Aperture to read the folder.",
  });
  const second = harness({ listFolders: vi.fn(async () => Promise.reject(new Error("Network down"))) });
  await second.sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "M", files: [local("M/a.txt")] } });
  expect(second.sync.getState().runs.get(runKey(BASE, "M"))).toMatchObject({ message: "Network down" });
});

test("listeners hear each change and can stop listening", async () => {
  const { sync } = harness();
  const listener = vi.fn();
  const unsubscribe = sync.subscribe(listener);
  await sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "M", files: [local("M/a.txt")] } });
  const calls = listener.mock.calls.length;
  expect(calls).toBeGreaterThan(2);
  unsubscribe();
  await sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "M", files: [local("M/b.txt")] } });
  expect(listener.mock.calls.length).toBe(calls);
});

test("stopping a folder that is not running does nothing", () => {
  const { sync } = harness();
  expect(() => sync.stop(BASE, "Nothing running")).not.toThrow();
});

test("exactly the large-folder limit goes without asking, and no question means no limit", async () => {
  const atLimit = harness();
  const confirmLarge = vi.fn(() => false);
  const files = Array.from({ length: 500 }, (_, index) => local(`Edge/${index}.txt`));
  const result = await atLimit.sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "Edge", files }, confirmLarge });
  expect(confirmLarge).not.toHaveBeenCalled();
  expect(result?.added).toBe(500);

  const unasked = harness();
  const more = Array.from({ length: 501 }, (_, index) => local(`Big/${index}.txt`));
  expect((await unasked.sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "Big", files: more } }))?.added).toBe(501);
});

test("progress counts files as they finish", async () => {
  const { sync } = harness();
  const seen: string[] = [];
  sync.subscribe(() => {
    const run = sync.getState().runs.get(runKey(BASE, "M"));
    if (run?.phase === "sending") seen.push(`${run.done}/${run.total} ${run.current}`);
  });
  await sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "M", files: [local("M/a.txt"), local("M/b.txt"), local("M/c.txt")] } });
  expect(seen[0]).toBe("0/3 M/a.txt");
  expect(seen).toContain("1/3 M/c.txt");
  expect(seen.at(-1)).toMatch(/^3\/3 /);
});

test("failures without useful words still read as sentences", async () => {
  const cases: Array<[unknown, string]> = [
    [new DOMException("no", "SecurityError"), "This browser did not allow Aperture to read the folder."],
    [new DOMException("Type was wrong", "TypeMismatchError"), "Type was wrong"],
    [new Error(""), "Unknown error."],
    ["plain text", "Unknown error."],
  ];
  for (const [error, message] of cases) {
    const { sync } = harness({ readHandle: vi.fn(async () => Promise.reject(error)) });
    await sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "M", handle: handle("M") } });
    expect(sync.getState().runs.get(runKey(BASE, "M"))).toMatchObject({ phase: "failed", message });
  }
  const sending = harness({ sendFile: vi.fn(async () => Promise.reject(new Error(""))) });
  const result = await sending.sync.sync({ userId: USER, knowledgeId: BASE, source: { name: "M", files: [local("M/a.txt")] } });
  expect(result?.failed).toEqual([{ path: "M/a.txt", message: "Unknown error." }]);
});
