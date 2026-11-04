/** The app's one folder-sync engine, wired to the real API, browser, and IndexedDB. */
import { getKnowledgeLimits, listKnowledgeFolders, uploadKnowledgeFolderFile } from "./api";
import { folderReadable, readFolderHandle } from "./folderAccess";
import { FolderSync } from "./folderSync";
import { browserKeptFolderStore } from "./keptFolders";

export function createBrowserFolderSync(): FolderSync {
  const limits = new Map<string, Promise<number | null>>();
  return new FolderSync({
    listFolders: (userId, knowledgeId, signal) => listKnowledgeFolders(userId, knowledgeId, { signal }),
    sendFile: (userId, knowledgeId, file, path, signal) =>
      uploadKnowledgeFolderFile(userId, knowledgeId, file, path, { signal }),
    maxUploadMb: (userId) => {
      const cached = limits.get(userId);
      if (cached) return cached;
      const pending = getKnowledgeLimits(userId)
        .then((value) => value.upload_max_mb)
        .catch(() => {
          // The server still enforces its limit; ask again next time.
          limits.delete(userId);
          return null;
        });
      limits.set(userId, pending);
      return pending;
    },
    readHandle: (handle) => readFolderHandle(handle),
    readable: folderReadable,
    store: browserKeptFolderStore(),
    now: () => Date.now(),
  });
}

let shared: FolderSync | null = null;

export function sharedFolderSync(): FolderSync {
  shared ??= createBrowserFolderSync();
  return shared;
}
