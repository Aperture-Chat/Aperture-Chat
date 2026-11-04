/**
 * Folders this browser may read again: their handles, and whether each is
 * kept in sync. Stored per browser profile in IndexedDB (handles cannot go to
 * the server), keyed by person, knowledge base, and folder name.
 */
import type { FolderHandle } from "./folderAccess";

export type KeptFolder = {
  key: string;
  userId: string;
  knowledgeId: string;
  name: string;
  handle: FolderHandle;
  keepInSync: boolean;
  /** When this browser last finished reading the folder (ms), or null. */
  lastChecked: number | null;
};

export type KeptFolderStore = {
  list(userId: string): Promise<KeptFolder[]>;
  put(folder: KeptFolder): Promise<void>;
  remove(key: string): Promise<void>;
};

export function keptFolderKey(userId: string, knowledgeId: string, name: string): string {
  return JSON.stringify([userId, knowledgeId, name]);
}

export function memoryKeptFolderStore(): KeptFolderStore {
  const folders = new Map<string, KeptFolder>();
  return {
    list: async (userId) => [...folders.values()].filter((folder) => folder.userId === userId),
    put: async (folder) => {
      folders.set(folder.key, folder);
    },
    remove: async (key) => {
      folders.delete(key);
    },
  };
}

const DATABASE = "aperture-kept-folders";
const STORE = "folders";

/** IndexedDB when the browser has it; otherwise folders are remembered only until the page reloads. */
export function browserKeptFolderStore(): KeptFolderStore {
  const factory = typeof indexedDB === "undefined" ? null : indexedDB;
  if (!factory) return memoryKeptFolderStore();
  let opened: Promise<IDBDatabase> | null = null;
  const database = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return opened;
  };
  const run = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>) => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const request = act(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    list: async (userId) => {
      const all = await run<KeptFolder[]>("readonly", (store) => store.getAll() as IDBRequest<KeptFolder[]>);
      return all.filter((folder) => folder.userId === userId);
    },
    put: async (folder) => {
      await run("readwrite", (store) => store.put(folder));
    },
    remove: async (key) => {
      await run("readwrite", (store) => store.delete(key));
    },
  };
}
