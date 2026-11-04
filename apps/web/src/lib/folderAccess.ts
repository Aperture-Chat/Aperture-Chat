/**
 * Reading folders from the person's computer: drag and drop, the folder
 * picker, and folders the browser lets Aperture read again later.
 *
 * Chromium browsers (Chrome, Edge) hand out a folder *handle* that can be kept
 * and re-read, which is what keeping a folder in sync needs. Other browsers,
 * and hosts that refuse file-system access (some desktop shells), still give
 * the folder's files once through a directory input or a drop.
 */
import { groupFolderFiles, isHiddenOrSystemName, relativeFolderPath, type LocalFolderFile } from "./folderFiles";

/** Stop reading a folder past this many files and say so. */
export const MAX_FOLDER_FILES = 10_000;

type FileHandle = { kind: "file"; name: string; getFile(): Promise<File> };
type ReadPermission = { mode: "read" };

/** The parts of a File System Access directory handle this app uses. */
export type FolderHandle = {
  kind: "directory";
  name: string;
  values(): AsyncIterable<FolderHandle | FileHandle>;
  queryPermission?(descriptor: ReadPermission): Promise<PermissionState>;
  requestPermission?(descriptor: ReadPermission): Promise<PermissionState>;
};

/** A folder to upload: a handle that can be read now and again later, or files already read. */
export type FolderSource =
  | { name: string; handle: FolderHandle }
  | { name: string; files: LocalFolderFile[]; truncated?: boolean };

export type FolderRead = { files: LocalFolderFile[]; truncated: boolean };

/** The browser offered a folder but will not let Aperture read it. */
export class FolderAccessRefused extends Error {
  constructor() {
    super("This browser did not allow Aperture to read the folder.");
    this.name = "FolderAccessRefused";
  }
}

const REFUSED_KEY = "aperture.knowledge.folderAccessRefused";

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: "read" }) => Promise<FolderHandle>;
};

/** Whether this browser can keep a folder and read it again on later visits. */
export function canKeepFolders(): boolean {
  if (typeof (window as DirectoryPickerWindow).showDirectoryPicker !== "function") return false;
  try {
    return window.localStorage.getItem(REFUSED_KEY) !== "1";
  } catch {
    return true;
  }
}

function rememberRefusal() {
  try {
    window.localStorage.setItem(REFUSED_KEY, "1");
  } catch {
    // Without storage the picker is simply offered again next time.
  }
}

/**
 * Ask for a folder Aperture may read again later. Resolves null when the
 * person cancels; throws FolderAccessRefused when the browser blocks reading,
 * and from then on canKeepFolders() is false in this browser.
 */
export async function pickKeptFolder(): Promise<FolderSource | null> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new FolderAccessRefused();
  let handle: FolderHandle;
  try {
    handle = await picker.call(window, { id: "aperture-knowledge", mode: "read" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    rememberRefusal();
    throw new FolderAccessRefused();
  }
  if (handle.queryPermission && (await handle.queryPermission({ mode: "read" })) === "denied") {
    rememberRefusal();
    throw new FolderAccessRefused();
  }
  return { name: handle.name, handle };
}

/** Whether Aperture may read a kept folder now; `ask` shows the browser's prompt (needs a click). */
export async function folderReadable(handle: FolderHandle, ask: boolean): Promise<boolean> {
  // Handles without the permission calls (older Chromium) are readable while the page is open.
  if (!handle.queryPermission) return true;
  const state = await handle.queryPermission({ mode: "read" });
  if (state === "granted") return true;
  if (!ask || state === "denied" || !handle.requestPermission) return false;
  return (await handle.requestPermission({ mode: "read" })) === "granted";
}

/** Every file under a kept folder, skipping hidden and system files and folders. */
export async function readFolderHandle(handle: FolderHandle, limit = MAX_FOLDER_FILES): Promise<FolderRead> {
  const files: LocalFolderFile[] = [];
  async function walk(folder: FolderHandle, prefix: string): Promise<boolean> {
    for await (const child of folder.values()) {
      if (isHiddenOrSystemName(child.name)) continue;
      const path = `${prefix}/${child.name}`;
      if (child.kind === "directory") {
        if (!(await walk(child, path))) return false;
      } else {
        if (files.length >= limit) return false;
        files.push({ path, file: await child.getFile() });
      }
    }
    return true;
  }
  const complete = await walk(handle, handle.name);
  return { files, truncated: !complete };
}

/** Folders chosen through `<input webkitdirectory>`: each file knows its relative path. */
export function foldersFromInput(files: File[]): FolderSource[] {
  const located = files
    .filter((file) => file.webkitRelativePath.includes("/"))
    .map((file) => ({ path: relativeFolderPath(file.webkitRelativePath), file }));
  return groupFolderFiles(located).map((group) => ({ name: group.name, files: group.files }));
}

export type DroppedItems = { files: File[]; folders: FolderSource[] };

type DropItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FolderHandle | FileHandle | null> };

/**
 * Split a drop into loose files and folders. Every item must be read before
 * the drop event returns, so the handles and entries are taken synchronously
 * and resolved afterwards.
 */
export function readDrop(dataTransfer: DataTransfer, limit = MAX_FOLDER_FILES): Promise<DroppedItems> {
  const items = Array.from(dataTransfer.items).filter((item) => item.kind === "file") as DropItem[];
  if (!items.length) return Promise.resolve({ files: Array.from(dataTransfer.files), folders: [] });
  const keep = canKeepFolders();
  const captured = items.map((item) => captureDropItem(item, keep));
  return Promise.all(captured.map((item) => resolveDropped(item, limit))).then((resolved) => ({
    files: resolved.flatMap((item) => ("file" in item ? [item.file] : [])),
    folders: resolved.flatMap((item) => ("folder" in item ? [item.folder] : [])),
  }));
}

function captureDropItem(item: DropItem, keep: boolean): CapturedDrop {
  const handle = keep && item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
  const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
  return { entry, handle, file: item.getAsFile() };
}

type CapturedDrop = {
  entry: FileSystemEntry | null;
  handle: Promise<FolderHandle | FileHandle | null> | null;
  file: File | null;
};

async function resolveDropped(
  item: CapturedDrop,
  limit: number,
): Promise<{ file: File } | { folder: FolderSource } | object> {
  if (!item.entry?.isDirectory) return item.file ? { file: item.file } : {};
  const handle = await item.handle?.catch(() => null);
  if (handle?.kind === "directory" && (await folderReadable(handle, false))) {
    return { folder: { name: handle.name, handle } };
  }
  const files: LocalFolderFile[] = [];
  const complete = await readEntry(item.entry, files, limit);
  return { folder: { name: item.entry.name, files, truncated: !complete } };
}

async function readEntry(entry: FileSystemEntry, files: LocalFolderFile[], limit: number): Promise<boolean> {
  if (isHiddenOrSystemName(entry.name)) return true;
  if (entry.isFile) {
    if (files.length >= limit) return false;
    files.push({ path: relativeFolderPath(entry.fullPath), file: await entryFile(entry as FileSystemFileEntry) });
    return true;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns at most ~100 entries per call; keep asking until empty.
  for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
    for (const child of batch) {
      if (!(await readEntry(child, files, limit))) return false;
    }
  }
  return true;
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}
