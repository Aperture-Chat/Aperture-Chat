import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import { folderReadable, readFolderHandle, type FolderHandle } from "../lib/folderAccess";
import { FolderSync, runKey } from "../lib/folderSync";
import { keptFolderKey, memoryKeptFolderStore } from "../lib/keptFolders";
import type { BootstrapData, KnowledgeBase, KnowledgeDocument, KnowledgeFolderFileResult } from "../lib/types";
import {
  FolderSyncContext,
  KnowledgeDropZone,
  confirmLargeFolder,
  listedFolders,
  runStatusText,
  useFolderSyncWatcher,
} from "./KnowledgeFolders";
import { LibraryConsole } from "./LibraryConsole";

const BASE_ID = "kb-folders";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const base: KnowledgeBase = {
  id: BASE_ID,
  name: "Synthetic Matter Files",
  description: "Uploaded files.",
  source: "Uploaded files",
  source_type: "upload",
  linked_sources: [],
  connector_id: "upload",
  status: "synced",
  document_count: 0,
  last_sync: "Nov 3, 2026, 9:00 PM UTC",
  acl: "Groups: Litigation",
  owner_group_id: "group-litigation",
  owner_user_id: sampleData.me.id,
  enabled: true,
};

function folderDocument(path: string, id = `doc-${path}`): KnowledgeDocument {
  return {
    id,
    knowledge_config_id: BASE_ID,
    tenant_id: "tenant-example",
    name: path.split("/").pop() ?? path,
    source_uri: "upload://x",
    source_type: "upload",
    status: "indexed",
    chunk_count: 2,
    acl_group_ids: [],
    updated_at: "Nov 3, 2026, 9:05 PM UTC",
    citation_required: true,
    folder_file: { path, size: 1, modified: 1 },
  };
}

function sent(path: string): KnowledgeFolderFileResult {
  return {
    config: {
      id: BASE_ID,
      tenant_id: "tenant-example",
      name: base.name,
      source_type: "upload",
      connector_config_id: null,
      enabled: true,
      acl_group_ids: ["group-litigation"],
      owner_user_id: sampleData.me.id,
      secret_set: false,
      settings: { status: "synced", document_count: 1, last_sync: "now", source: "Uploaded files" },
    } as unknown as KnowledgeFolderFileResult["config"],
    document: folderDocument(path),
    action: "added",
    provider_message: `Added ${path}.`,
  };
}

function handleFor(name: string, files: Record<string, string>, permission: PermissionState = "granted"): FolderHandle {
  return {
    kind: "directory",
    name,
    values: async function* () {
      for (const [child, text] of Object.entries(files)) {
        yield { kind: "file" as const, name: child, getFile: async () => new File([text], child) };
      }
    },
    queryPermission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => "granted" as PermissionState),
  };
}

function engine(existing: KnowledgeDocument[] = []) {
  const sentPaths: string[] = [];
  const store = memoryKeptFolderStore();
  const sync = new FolderSync({
    listFolders: async () =>
      existing.length
        ? [
            {
              name: existing[0].folder_file!.path.split("/")[0],
              files: existing.map((item) => ({ ...item.folder_file!, document_id: item.id })),
              removed: [],
            },
          ]
        : [],
    sendFile: async (_user, _base, _file, path) => {
      sentPaths.push(path);
      return sent(path);
    },
    maxUploadMb: async () => 250,
    readHandle: (handle) => readFolderHandle(handle),
    readable: folderReadable,
    store,
    now: () => new Date("2026-11-03T21:10:00Z").getTime(),
  });
  return { sync, sentPaths, store };
}

function renderLibrary(sync: FolderSync, documents: KnowledgeDocument[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/knowledge/limits")) {
        return json({ upload_max_mb: 250, max_extracted_chars: 1_000_000, ocr_enabled: false, ocr_max_pages: 0 });
      }
      if (url.includes("/index-status")) {
        return json({ knowledge_config_id: BASE_ID, semantic_search: "on", total_chunks: 0, pending_chunks: 0, pending_by_document: {} });
      }
      if (url.includes("/documents") && (init?.method ?? "GET") === "GET") return json(documents);
      return json({ detail: "Unhandled" }, 500);
    }),
  );
  function Harness({ children }: { children?: ReactNode }) {
    const [data, setData] = useState<BootstrapData>({
      ...sampleData,
      me: { ...sampleData.me, role: "TENANT_ADMIN" },
      knowledgeBases: [{ ...base, document_count: documents.length }],
    });
    return (
      <FolderSyncContext.Provider value={sync}>
        <LibraryConsole data={data} view="knowledge" onDataChange={(updater) => setData(updater)} />
        {children}
      </FolderSyncContext.Provider>
    );
  }
  render(<Harness />);
}

async function openBase() {
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
  await screen.findByText(/Drag files or folders here/);
}

function folderEntry(name: string, files: Record<string, string>): FileSystemEntry {
  const children = Object.entries(files).map(
    ([child, text]) =>
      ({
        isFile: true,
        isDirectory: false,
        name: child,
        fullPath: `/${name}/${child}`,
        file: (resolve: (file: File) => void) => resolve(new File([text], child)),
      }) as unknown as FileSystemEntry,
  );
  let read = false;
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    createReader: () => ({
      readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
        resolve(read ? [] : children);
        read = true;
      },
    }),
  } as unknown as FileSystemEntry;
}

const pickerWindow = window as Window & { showDirectoryPicker?: unknown };

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  delete pickerWindow.showDirectoryPicker;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("dropping folders sends each file with its folder path and lists the folder", async () => {
  const { sync, sentPaths } = engine();
  renderLibrary(sync);
  await openBase();
  const zone = screen.getByText(/Drag files or folders here/).closest(".knowledge-dropzone") as HTMLElement;
  const items = [folderEntry("Matter 12", { "brief.txt": "b", "notes.txt": "n" }), folderEntry("Estate", { "will.txt": "w" })].map(
    (entry) => ({ kind: "file", webkitGetAsEntry: () => entry, getAsFile: () => null }),
  );
  await act(async () => {
    fireEvent.drop(zone, { dataTransfer: { items, files: [] } });
  });

  await waitFor(() => expect(sentPaths).toEqual(["Matter 12/brief.txt", "Matter 12/notes.txt", "Estate/will.txt"]));
  const folders = await screen.findByRole("region", { name: "Folders" });
  await within(folders).findByText(`Added 2 new files. Checked at ${timeOf()}.`);
  expect(within(folders).getByText(`Added 1 new file. Checked at ${timeOf()}.`)).toBeInTheDocument();
  expect(within(folders).getByText("Matter 12")).toBeInTheDocument();
  expect(within(folders).getByText("Estate")).toBeInTheDocument();
  expect(within(folders).getByText("2 files in Aperture")).toBeInTheDocument();
  const list = screen.getByRole("region", { name: "Indexed files" });
  expect(within(list).getByRole("button", { name: "Open brief.txt" })).toBeInTheDocument();
  expect(within(list).getAllByText(/^In Matter 12 · 2 passages · Synced/)).toHaveLength(2);
});

function timeOf() {
  return new Date("2026-11-03T21:10:00Z").toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

test("a chosen folder can be kept in sync on this computer", async () => {
  const matter = handleFor("Matter 12", { "brief.txt": "b" });
  pickerWindow.showDirectoryPicker = vi.fn(async () => matter);
  const { sync, sentPaths, store } = engine();
  renderLibrary(sync);
  await openBase();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "choose a folder" }));
  });
  await waitFor(() => expect(sentPaths).toEqual(["Matter 12/brief.txt"]));
  const folders = await screen.findByRole("region", { name: "Folders" });
  const keep = within(folders).getByRole("switch", { name: "Keep Matter 12 in sync" });
  expect(keep).toHaveAttribute("aria-checked", "false");
  expect(within(folders).getByText("Keep in sync: Off")).toBeInTheDocument();
  expect(within(folders).getByText("Turn on Keep in sync to add new and changed files automatically.")).toBeInTheDocument();

  await act(async () => {
    fireEvent.click(keep);
  });
  await waitFor(() => expect(keep).toHaveAttribute("aria-checked", "true"));
  expect(within(folders).getByText(/Kept in sync on this computer/)).toBeInTheDocument();
  expect(within(folders).getByText(/added every few minutes while Aperture is open in this browser/)).toBeInTheDocument();
  expect((await store.list(sampleData.me.id))[0]).toMatchObject({ name: "Matter 12", keepInSync: true });
  expect(pickerWindow.showDirectoryPicker).toHaveBeenCalledTimes(1);
});

test("turning sync on for a folder this browser never kept asks for that folder by name", async () => {
  pickerWindow.showDirectoryPicker = vi.fn(async () => handleFor("Other folder", {}));
  const { sync } = engine([folderDocument("Matter 12/brief.txt")]);
  renderLibrary(sync, [folderDocument("Matter 12/brief.txt")]);
  await openBase();
  const folders = await screen.findByRole("region", { name: "Folders" });
  await act(async () => {
    fireEvent.click(within(folders).getByRole("switch", { name: "Keep Matter 12 in sync" }));
  });
  expect(
    await within(folders).findByText("You chose “Other folder”. Choose the folder named “Matter 12” to sync it. Nothing was added."),
  ).toBeInTheDocument();
  expect(within(folders).getByRole("switch", { name: "Keep Matter 12 in sync" })).toHaveAttribute("aria-checked", "false");
});

test("browsers that cannot keep folders sync by choosing the folder again", async () => {
  const { sync, sentPaths } = engine([folderDocument("Matter 12/brief.txt")]);
  renderLibrary(sync, [folderDocument("Matter 12/brief.txt")]);
  await openBase();
  const folders = await screen.findByRole("region", { name: "Folders" });
  expect(within(folders).queryByRole("switch")).not.toBeInTheDocument();
  expect(within(folders).getByText("To add new files later, choose Sync now and pick this folder again.")).toBeInTheDocument();
  const input = within(folders).getByLabelText("Choose the folder again to sync it") as HTMLInputElement;
  const click = vi.spyOn(input, "click").mockImplementation(() => {});
  fireEvent.click(within(folders).getByRole("button", { name: "Sync Matter 12 now" }));
  await waitFor(() => expect(click).toHaveBeenCalled());

  const chosen = (name: string, path: string) => {
    const file = new File(["n"], name);
    Object.defineProperty(file, "webkitRelativePath", { value: path });
    return file;
  };
  fireEvent.change(input, { target: { files: [chosen("brief.txt", "Matter 12/brief.txt"), chosen("new.txt", "Matter 12/new.txt")] } });
  await waitFor(() => expect(sentPaths).toEqual(["Matter 12/brief.txt", "Matter 12/new.txt"]));

  fireEvent.click(within(folders).getByRole("button", { name: "Sync Matter 12 now" }));
  fireEvent.change(input, { target: { files: [chosen("x.txt", "Unrelated/x.txt")] } });
  expect(
    await within(folders).findByText("You chose “Unrelated”. Choose the folder named “Matter 12” to sync it. Nothing was added."),
  ).toBeInTheDocument();
});

test("a kept folder the browser stopped trusting asks for permission in words", async () => {
  const matter = handleFor("Matter 12", { "brief.txt": "b" }, "prompt");
  pickerWindow.showDirectoryPicker = vi.fn();
  const { sync, store, sentPaths } = engine([folderDocument("Matter 12/brief.txt")]);
  await store.put({
    key: keptFolderKey(sampleData.me.id, BASE_ID, "Matter 12"),
    userId: sampleData.me.id,
    knowledgeId: BASE_ID,
    name: "Matter 12",
    handle: matter,
    keepInSync: true,
    lastChecked: null,
  });
  renderLibrary(sync, [folderDocument("Matter 12/brief.txt")]);
  await openBase();
  await act(async () => {
    await sync.load(sampleData.me.id);
    await sync.syncKept(sampleData.me.id);
  });
  const folders = await screen.findByRole("region", { name: "Folders" });
  expect(within(folders).getByText(/Paused\. This browser needs your OK to read the folder again\./)).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(within(folders).getByRole("button", { name: "Allow and sync Matter 12" }));
  });
  expect(matter.requestPermission).toHaveBeenCalledWith({ mode: "read" });
  await waitFor(() => expect(sync.getState().runs.get(runKey(BASE_ID, "Matter 12"))?.phase).toBe("done"));
  expect(sentPaths).toEqual(["Matter 12/brief.txt"]);
});

test("folder files can be found by their folder in the file search", async () => {
  const documents = Array.from({ length: 9 }, (_, index) =>
    folderDocument(index < 3 ? `Matter 12/Pleadings/p${index}.txt` : `Matter 12/Letters/l${index}.txt`),
  );
  const { sync } = engine(documents);
  renderLibrary(sync, documents);
  await openBase();
  fireEvent.change(await screen.findByRole("searchbox", { name: "Search files" }), { target: { value: "pleadings" } });
  const list = screen.getByRole("region", { name: "Indexed files" });
  expect(within(list).getAllByRole("button", { name: /^Open p\d\.txt$/ })).toHaveLength(3);
  expect(within(list).queryByRole("button", { name: /^Open l\d\.txt$/ })).not.toBeInTheDocument();
});

test("each run phase reads as a sentence", () => {
  expect(runStatusText({ phase: "waiting" })).toBe("Waiting for another folder to finish…");
  expect(runStatusText({ phase: "reading" })).toBe("Checking the folder for new and changed files…");
  expect(runStatusText({ phase: "sending", done: 2, total: 40, current: "Matter 12/Pleadings/brief.pdf" })).toBe(
    "Adding 3 of 40: Pleadings/brief.pdf",
  );
  expect(runStatusText({ phase: "sending", done: 40, total: 40, current: "Matter 12/z.pdf" })).toBe("Adding 40 of 40: z.pdf");
  expect(runStatusText({ phase: "failed", message: "Network down", at: 0 })).toBe("Could not sync: Network down");
  const done = {
    phase: "done" as const,
    result: { added: 0, updated: 0, unchanged: 3, skipped: [], failed: [], keptOut: 0, stopped: false },
    at: new Date("2026-11-03T21:10:00Z").getTime(),
    truncated: true,
  };
  expect(runStatusText(done)).toBe(
    `Everything was already up to date. Only the first 10,000 files were read. Checked at ${timeOf()}.`,
  );
});

// ------------------------------------------------------------------ watcher

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

test("kept folders are checked on start, every few minutes while visible, and on return after a minute", async () => {
  vi.useFakeTimers();
  try {
    setVisibility("visible");
    const service = { load: vi.fn(async () => {}), syncKept: vi.fn(async () => {}) };
    const { unmount } = renderHook(() => useFolderSyncWatcher("user-a", service));
    await act(async () => {});
    expect(service.load).toHaveBeenCalledWith("user-a");
    expect(service.syncKept).toHaveBeenCalledTimes(1);
    expect(service.syncKept).toHaveBeenCalledWith("user-a");

    // Coming back within a minute does not check again; a minute later it does.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(service.syncKept).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(service.syncKept).toHaveBeenCalledTimes(2);

    // The three-minute timer checks too (t = 3:00), unless a check just ran.
    await act(async () => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(service.syncKept).toHaveBeenCalledTimes(3);
    await act(async () => {
      vi.advanceTimersByTime(2 * 60_000 + 30_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(service.syncKept).toHaveBeenCalledTimes(4);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(service.syncKept).toHaveBeenCalledTimes(4);

    // Nothing is checked while the page is hidden.
    setVisibility("hidden");
    await act(async () => {
      vi.advanceTimersByTime(3 * 60_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(service.syncKept).toHaveBeenCalledTimes(4);

    unmount();
    setVisibility("visible");
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(service.syncKept).toHaveBeenCalledTimes(4);
  } finally {
    setVisibility("visible");
    vi.useRealTimers();
  }
});

test("no one signed in, or a failed load, checks nothing", async () => {
  setVisibility("visible");
  const idle = { load: vi.fn(async () => {}), syncKept: vi.fn(async () => {}) };
  renderHook(() => useFolderSyncWatcher(null, idle));
  const broken = { load: vi.fn(async () => Promise.reject(new Error("no storage"))), syncKept: vi.fn(async () => {}) };
  renderHook(() => useFolderSyncWatcher("user-a", broken));
  await act(async () => {});
  expect(idle.load).not.toHaveBeenCalled();
  expect(broken.load).toHaveBeenCalled();
  expect(idle.syncKept).not.toHaveBeenCalled();
  expect(broken.syncKept).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------- drop zone

function renderDropZone(limits: Parameters<typeof KnowledgeDropZone>[0]["limits"] = null) {
  const handlers = { onFiles: vi.fn(), onFolders: vi.fn(), onNotice: vi.fn() };
  const view = render(<KnowledgeDropZone limits={limits} {...handlers} />);
  return { ...handlers, view, zone: view.container.querySelector(".knowledge-dropzone") as HTMLElement };
}

test("the drop zone describes only the limits the server reported", () => {
  const { view } = renderDropZone();
  const text = view.container.textContent ?? "";
  expect(text).toContain("PDF, Word, Excel, PowerPoint, email, images, text, audio, and video. Files are searchable");
  expect(text).not.toContain("MB each");
  expect(text).not.toContain("OCR");
  expect(text).toContain("Drop several folders at once to add a whole project; each folder keeps its subfolders and can stay in sync.");
  view.unmount();

  const full = renderDropZone({
    upload_max_mb: 1250,
    max_extracted_chars: 1,
    ocr_enabled: true,
    ocr_max_pages: 1500,
    semantic_search: "on",
    vision_ocr: { available: true, model_name: "Vision QA" },
  } as Parameters<typeof KnowledgeDropZone>[0]["limits"]);
  const fullText = full.view.container.textContent ?? "";
  expect(fullText).toContain("· up to 1,250 MB each.");
  expect(fullText).toContain("Scanned pages are read with OCR (first 1,500 pages).");
  expect(fullText).toContain("Handwriting, stamps, and pictures are read by Vision QA.");
});

test("dragging over the zone highlights it until the last child is left or something is dropped", async () => {
  const { zone, onFiles } = renderDropZone();
  expect(zone).not.toHaveClass("is-dragging");
  fireEvent.dragEnter(zone);
  fireEvent.dragEnter(zone);
  expect(zone).toHaveClass("is-dragging");
  fireEvent.dragLeave(zone);
  expect(zone).toHaveClass("is-dragging");
  fireEvent.dragLeave(zone);
  expect(zone).not.toHaveClass("is-dragging");
  fireEvent.dragLeave(zone);
  fireEvent.dragEnter(zone);
  expect(zone).toHaveClass("is-dragging");
  fireEvent.dragLeave(zone);
  expect(zone).not.toHaveClass("is-dragging");
  fireEvent.dragEnter(zone);
  fireEvent.dragEnter(zone);
  const loose = new File(["x"], "memo.txt");
  await act(async () => {
    fireEvent.drop(zone, { dataTransfer: { items: [], files: [loose] } });
  });
  expect(zone).not.toHaveClass("is-dragging");
  expect(onFiles).toHaveBeenCalledWith([loose]);
  fireEvent.dragEnter(zone);
  expect(zone).toHaveClass("is-dragging");
  fireEvent.dragLeave(zone);
  expect(zone).not.toHaveClass("is-dragging");
});

test("choosing a folder falls back to the folder input when the browser cannot keep it", async () => {
  const { view, onFolders, onNotice } = renderDropZone();
  const input = view.getByLabelText("Choose a folder to add") as HTMLInputElement;
  expect(input).toHaveAttribute("tabindex", "-1");
  expect(input).toHaveAttribute("aria-hidden", "true");
  expect(input).toHaveAttribute("webkitdirectory");
  const click = vi.spyOn(input, "click").mockImplementation(() => {});
  const choose = view.getByRole("button", { name: "choose a folder" });

  fireEvent.click(choose);
  expect(click).toHaveBeenCalledTimes(1);

  pickerWindow.showDirectoryPicker = vi.fn(async () => Promise.reject(new DOMException("cancel", "AbortError")));
  await act(async () => {
    fireEvent.click(choose);
  });
  expect(click).toHaveBeenCalledTimes(1);
  expect(onFolders).not.toHaveBeenCalled();

  pickerWindow.showDirectoryPicker = vi.fn(async () => Promise.reject(new DOMException("no", "SecurityError")));
  await act(async () => {
    fireEvent.click(choose);
  });
  expect(click).toHaveBeenCalledTimes(2);

  window.localStorage.clear();
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: false } });
  try {
    await act(async () => {
      fireEvent.click(choose);
    });
    expect(click).toHaveBeenCalledTimes(2);
    expect(onNotice).toHaveBeenCalledWith("This browser reads folders another way. Choose “choose a folder” again to pick it.");
  } finally {
    delete (navigator as { userActivation?: unknown }).userActivation;
  }

  const chosen = new File(["w"], "will.txt");
  Object.defineProperty(chosen, "webkitRelativePath", { value: "Estate/will.txt" });
  fireEvent.change(input, { target: { files: [chosen] } });
  expect(onFolders).toHaveBeenCalledWith([{ name: "Estate", files: [{ path: "Estate/will.txt", file: chosen }] }]);
  fireEvent.change(input, { target: { files: [] } });
  expect(onFolders).toHaveBeenCalledTimes(1);
});

test("choosing files hands them over as files", () => {
  const { view, onFiles } = renderDropZone();
  const memo = new File(["m"], "memo.txt");
  fireEvent.change(view.getByLabelText("Choose files to add"), { target: { files: [memo] } });
  expect(onFiles).toHaveBeenCalledWith([memo]);
  fireEvent.change(view.getByLabelText("Choose files to add"), { target: { files: [] } });
  expect(onFiles).toHaveBeenCalledTimes(1);
});

test("a large folder asks first with its size in plain units", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const ask = confirmLargeFolder("Archive");
  expect(ask(1200, 3 * 1024 ** 3)).toBe(false);
  expect(confirm).toHaveBeenLastCalledWith(
    "Add 1,200 files (3.0 GB) from “Archive”? Large folders can take a while, and you can stop at any time.",
  );
  const sizes: Array<[number, string]> = [
    [1024 ** 3, "1.0 GB"],
    [1024 ** 3 - 1, "1024.0 MB"],
    [1024 ** 2, "1.0 MB"],
    [1536 * 1024, "1.5 MB"],
    [1024 ** 2 - 1, "1,024 KB"],
    [1536, "2 KB"],
    [100, "1 KB"],
  ];
  for (const [bytes, label] of sizes) {
    ask(1, bytes);
    expect(confirm.mock.lastCall?.[0]).toContain(`(${label})`);
  }
});

// ------------------------------------------------------------------ rows

test("listed folders include running and kept folders of this base only", () => {
  const handle = { kind: "directory" as const, name: "x", values: async function* () {} };
  const state = {
    runs: new Map([
      [runKey(BASE_ID, "Running"), { phase: "reading" as const }],
      [runKey("other-base", "Elsewhere"), { phase: "reading" as const }],
    ]),
    kept: [
      { key: "1", userId: "me", knowledgeId: BASE_ID, name: "Kept", handle, keepInSync: true, lastChecked: null },
      { key: "2", userId: "someone", knowledgeId: BASE_ID, name: "Theirs", handle, keepInSync: true, lastChecked: null },
      { key: "3", userId: "me", knowledgeId: "other-base", name: "Other", handle, keepInSync: true, lastChecked: null },
      { key: "4", userId: "me", knowledgeId: BASE_ID, name: "Matter 12", handle, keepInSync: true, lastChecked: null },
    ],
  };
  const documents = [folderDocument("Matter 12/a.txt"), folderDocument("Matter 12/b.txt")];
  expect(listedFolders(documents, state, "me", BASE_ID)).toEqual([
    ["Kept", 0],
    ["Matter 12", 2],
    ["Running", 0],
  ]);
});

test("a row shows progress, its count, and what could not be added", async () => {
  const waiting: Array<() => void> = [];
  const { sync, store } = engine();
  const realSend = sync["deps"].sendFile;
  sync["deps"].sendFile = async (...args) => {
    await new Promise<void>((resolve) => waiting.push(resolve));
    return realSend(...args);
  };
  renderLibrary(sync);
  await openBase();
  const files = ["a.txt", "b.txt", "c.txt", "d.txt", "tool.exe"].map((name) => ({ path: `Matter 12/${name}`, file: new File(["x"], name) }));
  await act(async () => {
    void sync.sync({ userId: sampleData.me.id, knowledgeId: BASE_ID, source: { name: "Matter 12", files } });
  });
  const folders = await screen.findByRole("region", { name: "Folders" });
  const bar = await within(folders).findByRole("progressbar", { name: "Matter 12 sync progress" });
  expect(bar).toHaveAttribute("aria-valuemin", "0");
  expect(bar).toHaveAttribute("aria-valuenow", "0");
  expect(within(folders).getByText("Adding 1 of 4: b.txt")).toBeInTheDocument();
  expect(folders.querySelector(".knowledge-folder-row")).toHaveClass("is-busy");
  expect(within(folders).getByRole("button", { name: "Stop syncing Matter 12" })).toBeInTheDocument();
  await act(async () => {
    waiting.shift()?.();
  });
  await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "25"));
  await act(async () => {
    while (waiting.length) waiting.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    while (waiting.length) waiting.shift()?.();
  });
  await within(folders).findByText("Not added: tool.exe (unsupported type).");
  expect(within(folders).getByText(`Added 4 new files. 1 was skipped. Checked at ${timeOf()}.`)).toBeInTheDocument();
  expect(folders.querySelector(".knowledge-folder-message")).toBeNull();
  expect(folders.querySelector(".knowledge-folder-row")?.className.trim()).toBe("knowledge-folder-row");
  expect(await store.list(sampleData.me.id)).toEqual([]);
});

test("one file reads in the singular, and a failed or paused folder is marked", async () => {
  const { sync, store } = engine([folderDocument("Matter 12/brief.txt")]);
  const matter = handleFor("Matter 12", {}, "prompt");
  await store.put({
    key: keptFolderKey(sampleData.me.id, BASE_ID, "Matter 12"),
    userId: sampleData.me.id,
    knowledgeId: BASE_ID,
    name: "Matter 12",
    handle: matter,
    keepInSync: true,
    lastChecked: null,
  });
  renderLibrary(sync, [folderDocument("Matter 12/brief.txt")]);
  await openBase();
  const folders = await screen.findByRole("region", { name: "Folders" });
  expect(await within(folders).findByText("1 file in Aperture · Kept in sync on this computer")).toBeInTheDocument();
  await act(async () => {
    await sync.load(sampleData.me.id);
    await sync.syncKept(sampleData.me.id);
  });
  expect(folders.querySelector(".knowledge-folder-row")).toHaveClass("is-paused");
  sync["deps"].readHandle = async () => Promise.reject(new Error("Disk unplugged"));
  await act(async () => {
    await sync.sync({ userId: sampleData.me.id, knowledgeId: BASE_ID, source: { name: "Matter 12", handle: matter } });
  });
  expect(within(folders).getByText("Could not sync: Disk unplugged")).toBeInTheDocument();
  expect(folders.querySelector(".knowledge-folder-row")).toHaveClass("is-error");
});

test("keep in sync can be turned off again, keeping the folder for Sync now", async () => {
  const matter = handleFor("Matter 12", { "brief.txt": "b" });
  pickerWindow.showDirectoryPicker = vi.fn(async () => matter);
  const { sync, store } = engine();
  renderLibrary(sync);
  await openBase();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "choose a folder" }));
  });
  const folders = await screen.findByRole("region", { name: "Folders" });
  const keep = await within(folders).findByRole("switch", { name: "Keep Matter 12 in sync" });
  await act(async () => {
    fireEvent.click(keep);
  });
  await waitFor(() => expect(keep).toHaveAttribute("aria-checked", "true"));
  await act(async () => {
    fireEvent.click(keep);
  });
  await waitFor(() => expect(keep).toHaveAttribute("aria-checked", "false"));
  expect((await store.list(sampleData.me.id))[0]).toMatchObject({ keepInSync: false, handle: matter });
});
