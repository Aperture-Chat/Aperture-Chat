import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  FolderAccessRefused,
  canKeepFolders,
  folderReadable,
  foldersFromInput,
  pickKeptFolder,
  readDrop,
  readFolderHandle,
  type FolderHandle,
} from "./folderAccess";

type Tree = { [name: string]: Tree | string };

function file(name: string, text = "x"): File {
  return new File([text], name);
}

function handleFor(name: string, tree: Tree, permission: PermissionState = "granted"): FolderHandle {
  return {
    kind: "directory",
    name,
    values: async function* () {
      for (const [child, value] of Object.entries(tree)) {
        if (typeof value === "string") yield { kind: "file" as const, name: child, getFile: async () => file(child, value) };
        else yield handleFor(child, value, permission);
      }
    },
    queryPermission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => "granted" as PermissionState),
  };
}

function entryFor(path: string, tree: Tree | string): FileSystemEntry {
  const name = path.split("/").pop() ?? path;
  if (typeof tree === "string") {
    return {
      isFile: true,
      isDirectory: false,
      name,
      fullPath: path,
      file: (resolve: (value: File) => void) => resolve(file(name, tree)),
    } as unknown as FileSystemEntry;
  }
  const children = Object.entries(tree).map(([child, value]) => entryFor(`${path}/${child}`, value));
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: path,
    createReader: () => {
      // Hand entries out two at a time, as browsers batch them.
      let offset = 0;
      return {
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
          resolve(children.slice(offset, offset + 2));
          offset += 2;
        },
      };
    },
  } as unknown as FileSystemEntry;
}

function dropItem(entry: FileSystemEntry | null, loose: File | null, handle?: Promise<FolderHandle | null>) {
  return {
    kind: "file",
    webkitGetAsEntry: () => entry,
    getAsFile: () => loose,
    ...(handle ? { getAsFileSystemHandle: () => handle } : {}),
  };
}

const pickerWindow = window as Window & { showDirectoryPicker?: unknown };

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  delete pickerWindow.showDirectoryPicker;
  vi.restoreAllMocks();
});

test("a kept folder is read recursively without hidden or system files", async () => {
  const handle = handleFor("Matter", {
    "brief.txt": "b",
    ".DS_Store": "junk",
    ".git": { config: "c" },
    Pleadings: { "answer.txt": "a", "~$answer.docx": "lock" },
  });
  const read = await readFolderHandle(handle);
  expect(read.files.map((item) => item.path)).toEqual(["Matter/brief.txt", "Matter/Pleadings/answer.txt"]);
  expect(read.truncated).toBe(false);
});

test("reading stops at the limit and says the folder was cut short", async () => {
  const handle = handleFor("Big", { "a.txt": "a", sub: { "b.txt": "b", "c.txt": "c" } });
  const read = await readFolderHandle(handle, 2);
  expect(read.files.map((item) => item.path)).toEqual(["Big/a.txt", "Big/sub/b.txt"]);
  expect(read.truncated).toBe(true);
  const exact = await readFolderHandle(handleFor("Two", { "a.txt": "a", "b.txt": "b" }), 2);
  expect(exact.truncated).toBe(false);
});

test("files from a folder input group by their top folder", () => {
  const withPath = (name: string, path: string) => {
    const item = file(name);
    Object.defineProperty(item, "webkitRelativePath", { value: path });
    return item;
  };
  const folders = foldersFromInput([
    withPath("a.txt", "Matter/a.txt"),
    withPath("b.txt", "Matter/sub/b.txt"),
    withPath("loose.txt", ""),
  ]);
  expect(folders).toHaveLength(1);
  expect(folders[0].name).toBe("Matter");
  expect("files" in folders[0] && folders[0].files.map((item) => item.path)).toEqual(["Matter/a.txt", "Matter/sub/b.txt"]);
});

test("a drop splits loose files from folders and walks every batch of a folder", async () => {
  const loose = file("memo.txt");
  const folder = entryFor("/Matter", { "a.txt": "a", "b.txt": "b", sub: { "c.txt": "c" }, ".hidden": "h" });
  const dropped = await readDrop({
    items: [dropItem(entryFor("/memo.txt", "m"), loose), dropItem(folder, null)],
    files: [],
  } as unknown as DataTransfer);
  expect(dropped.files).toEqual([loose]);
  expect(dropped.folders).toHaveLength(1);
  const [matter] = dropped.folders;
  expect(matter.name).toBe("Matter");
  expect("files" in matter && matter.files.map((item) => item.path)).toEqual([
    "Matter/a.txt",
    "Matter/b.txt",
    "Matter/sub/c.txt",
  ]);
  expect("files" in matter && matter.truncated).toBe(false);
});

test("a drop without item details falls back to its plain files", async () => {
  const loose = file("memo.txt");
  const dropped = await readDrop({ items: [], files: [loose] } as unknown as DataTransfer);
  expect(dropped).toEqual({ files: [loose], folders: [] });
});

test("a dropped folder keeps its handle when the browser can keep folders", async () => {
  pickerWindow.showDirectoryPicker = vi.fn();
  const kept = handleFor("Matter", { "a.txt": "a" });
  const dropped = await readDrop({
    items: [dropItem(entryFor("/Matter", { "a.txt": "a" }), null, Promise.resolve(kept))],
    files: [],
  } as unknown as DataTransfer);
  expect(dropped.folders).toEqual([{ name: "Matter", handle: kept }]);
});

test("a dropped folder whose handle cannot be read is walked instead", async () => {
  pickerWindow.showDirectoryPicker = vi.fn();
  const refused = handleFor("Matter", { "a.txt": "a" }, "denied");
  const dropped = await readDrop({
    items: [
      dropItem(entryFor("/Matter", { "a.txt": "a" }), null, Promise.resolve(refused)),
      dropItem(entryFor("/Estate", { "b.txt": "b" }), null, Promise.reject(new Error("no handle"))),
    ],
    files: [],
  } as unknown as DataTransfer);
  expect(dropped.folders.map((folder) => ["files" in folder, folder.name])).toEqual([
    [true, "Matter"],
    [true, "Estate"],
  ]);
});

test("keeping folders needs the directory picker and no earlier refusal", () => {
  expect(canKeepFolders()).toBe(false);
  pickerWindow.showDirectoryPicker = vi.fn();
  expect(canKeepFolders()).toBe(true);
  window.localStorage.setItem("aperture.knowledge.folderAccessRefused", "1");
  expect(canKeepFolders()).toBe(false);
});

test("picking a kept folder returns its handle, or null when cancelled", async () => {
  const matter = handleFor("Matter", {});
  pickerWindow.showDirectoryPicker = vi.fn(async () => matter);
  expect(await pickKeptFolder()).toEqual({ name: "Matter", handle: matter });
  pickerWindow.showDirectoryPicker = vi.fn(async () => Promise.reject(new DOMException("cancel", "AbortError")));
  expect(await pickKeptFolder()).toBeNull();
  expect(canKeepFolders()).toBe(true);
});

test("a browser that refuses folder access stops offering kept folders", async () => {
  pickerWindow.showDirectoryPicker = vi.fn(async () => Promise.reject(new DOMException("no", "SecurityError")));
  await expect(pickKeptFolder()).rejects.toBeInstanceOf(FolderAccessRefused);
  expect(canKeepFolders()).toBe(false);

  window.localStorage.clear();
  pickerWindow.showDirectoryPicker = vi.fn(async () => handleFor("Matter", {}, "denied"));
  await expect(pickKeptFolder()).rejects.toThrow("did not allow Aperture to read the folder");
  expect(canKeepFolders()).toBe(false);

  delete pickerWindow.showDirectoryPicker;
  await expect(pickKeptFolder()).rejects.toBeInstanceOf(FolderAccessRefused);
});

test("folder access is checked quietly and asked for only on request", async () => {
  expect(await folderReadable(handleFor("A", {}, "granted"), false)).toBe(true);
  const prompt = handleFor("B", {}, "prompt");
  expect(await folderReadable(prompt, false)).toBe(false);
  expect(prompt.requestPermission).not.toHaveBeenCalled();
  expect(await folderReadable(prompt, true)).toBe(true);
  expect(prompt.requestPermission).toHaveBeenCalledWith({ mode: "read" });
  const denied = handleFor("C", {}, "denied");
  expect(await folderReadable(denied, true)).toBe(false);
  expect(denied.requestPermission).not.toHaveBeenCalled();
  expect(await folderReadable({ kind: "directory", name: "D", values: async function* () {} }, false)).toBe(true);
});

test("blocked storage does not stop the browser from keeping folders", () => {
  pickerWindow.showDirectoryPicker = vi.fn();
  const real = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get: () => {
      throw new DOMException("blocked", "SecurityError");
    },
  });
  try {
    expect(canKeepFolders()).toBe(true);
  } finally {
    if (real) Object.defineProperty(window, "localStorage", real);
  }
});

test("a dropped folder the browser has not yet allowed is read once, without asking", async () => {
  pickerWindow.showDirectoryPicker = vi.fn();
  const waiting = handleFor("Matter", { "a.txt": "a" }, "prompt");
  const dropped = await readDrop({
    items: [dropItem(entryFor("/Matter", { "a.txt": "a" }), null, Promise.resolve(waiting))],
    files: [],
  } as unknown as DataTransfer);
  expect("files" in dropped.folders[0]).toBe(true);
  expect(waiting.requestPermission).not.toHaveBeenCalled();
});

test("handles without permission calls are treated as readable", async () => {
  const bare: FolderHandle = { kind: "directory", name: "Bare", values: async function* () {} };
  pickerWindow.showDirectoryPicker = vi.fn(async () => bare);
  expect(await pickKeptFolder()).toEqual({ name: "Bare", handle: bare });
  const promptOnly: FolderHandle = { ...bare, queryPermission: vi.fn(async () => "prompt" as PermissionState) };
  expect(await folderReadable(promptOnly, true)).toBe(false);
});

test("a drop reads folder entries when the browser cannot keep folders, even if it offers handles", async () => {
  const handle = handleFor("Matter", { "a.txt": "a" });
  const dropped = await readDrop({
    items: [dropItem(entryFor("/Matter", { "a.txt": "a" }), null, Promise.resolve(handle))],
    files: [],
  } as unknown as DataTransfer);
  expect(dropped.folders).toHaveLength(1);
  expect("files" in dropped.folders[0]).toBe(true);
});

test("an item without entry support drops as a loose file", async () => {
  const loose = file("memo.txt");
  const dropped = await readDrop({ items: [{ kind: "file", getAsFile: () => loose }], files: [] } as unknown as DataTransfer);
  expect(dropped).toEqual({ files: [loose], folders: [] });
});

test("a dropped handle without permission calls is kept", async () => {
  pickerWindow.showDirectoryPicker = vi.fn();
  const bare: FolderHandle = { kind: "directory", name: "Matter", values: async function* () {} };
  const dropped = await readDrop({
    items: [dropItem(entryFor("/Matter", {}), null, Promise.resolve(bare))],
    files: [],
  } as unknown as DataTransfer);
  expect(dropped.folders).toEqual([{ name: "Matter", handle: bare }]);
});

test("a dropped folder stops at the limit, inside subfolders too", async () => {
  const tree = { "a.txt": "a", sub: { "b.txt": "b", "c.txt": "c" }, "z.txt": "z" };
  const read = async (limit: number) =>
    (await readDrop({ items: [dropItem(entryFor("/Big", tree), null)], files: [] } as unknown as DataTransfer, limit))
      .folders[0] as { files: Array<{ path: string }>; truncated: boolean };
  const cut = await read(2);
  expect(cut.files.map((item) => item.path)).toEqual(["Big/a.txt", "Big/sub/b.txt"]);
  expect(cut.truncated).toBe(true);
  const whole = await read(4);
  expect(whole.files.map((item) => item.path)).toEqual(["Big/a.txt", "Big/sub/b.txt", "Big/sub/c.txt", "Big/z.txt"]);
  expect(whole.truncated).toBe(false);
});
