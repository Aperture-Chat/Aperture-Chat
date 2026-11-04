/**
 * Uploads and syncs folders into knowledge bases. One run reads a folder,
 * asks the server what it already holds, and sends only new and changed
 * files, two at a time. Runs wait their turn so several folders dropped at
 * once go one after another.
 *
 * A folder kept in sync is re-checked by syncKept(), which the app calls every
 * few minutes while it is open; browsers forget folder access between visits
 * unless the person allows it, so those folders report "needs-permission".
 */
import type { FolderHandle, FolderRead, FolderSource } from "./folderAccess";
import { planFolderSync, type FolderPlan, type FolderSyncResult } from "./folderFiles";
import { knowledgeFileSkipReason } from "./knowledgeFiles";
import { keptFolderKey, type KeptFolder, type KeptFolderStore } from "./keptFolders";
import type { KnowledgeFolderFileResult, KnowledgeFolderManifest } from "./types";

/** Folders with more new files than this ask before sending. */
export const LARGE_FOLDER_FILES = 500;
const PARALLEL_SENDS = 2;

export type FolderRun =
  | { phase: "waiting" }
  | { phase: "reading" }
  | { phase: "sending"; done: number; total: number; current: string }
  | { phase: "done"; result: FolderSyncResult; at: number; truncated: boolean }
  | { phase: "failed"; message: string; at: number }
  | { phase: "needs-permission" };

export type FolderSyncState = { runs: ReadonlyMap<string, FolderRun>; kept: readonly KeptFolder[] };

export type FolderSyncEvent =
  | { type: "document"; knowledgeId: string; result: KnowledgeFolderFileResult }
  | { type: "finished"; knowledgeId: string; name: string; result: FolderSyncResult };

export type FolderSyncDeps = {
  listFolders(userId: string, knowledgeId: string, signal: AbortSignal): Promise<KnowledgeFolderManifest[]>;
  sendFile(
    userId: string,
    knowledgeId: string,
    file: File,
    path: string,
    signal: AbortSignal,
  ): Promise<KnowledgeFolderFileResult>;
  /** The server's per-file limit in MB, or null when it is not known. */
  maxUploadMb(userId: string): Promise<number | null>;
  readHandle(handle: FolderHandle): Promise<FolderRead>;
  readable(handle: FolderHandle, ask: boolean): Promise<boolean>;
  store: KeptFolderStore;
  now(): number;
};

export type FolderSyncRequest = {
  userId: string;
  knowledgeId: string;
  source: FolderSource;
  /** Asked when a folder would send more than LARGE_FOLDER_FILES files; false sends nothing. */
  confirmLarge?: (count: number, bytes: number) => boolean;
};

export function runKey(knowledgeId: string, name: string): string {
  return JSON.stringify([knowledgeId, name]);
}

export class FolderSync {
  private state: FolderSyncState = { runs: new Map(), kept: [] };
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: FolderSyncEvent) => void>();
  private readonly controllers = new Map<string, AbortController>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: FolderSyncDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): FolderSyncState => this.state;

  onEvent(listener: (event: FolderSyncEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Read the folders this browser kept for a person. */
  async load(userId: string): Promise<void> {
    this.setState({ ...this.state, kept: await this.deps.store.list(userId) });
  }

  /** Queue a run for a folder; null when it is already queued, declined, or failed. */
  sync(request: FolderSyncRequest): Promise<FolderSyncResult | null> {
    const key = runKey(request.knowledgeId, request.source.name);
    if (this.controllers.has(key)) return Promise.resolve(null);
    const controller = new AbortController();
    this.controllers.set(key, controller);
    this.setRun(key, { phase: "waiting" });
    const run = this.queue
      .then(() => this.runOnce(request, key, controller.signal))
      .finally(() => this.controllers.delete(key));
    this.queue = run;
    return run;
  }

  stop(knowledgeId: string, name: string): void {
    this.controllers.get(runKey(knowledgeId, name))?.abort();
  }

  /** Turn syncing on or off for a folder; turning it on needs the folder's handle. */
  async setKeepInSync(
    userId: string,
    knowledgeId: string,
    name: string,
    keepInSync: boolean,
    handle?: FolderHandle,
  ): Promise<void> {
    const existing = this.keptFolder(userId, knowledgeId, name);
    const folderHandle = handle || existing?.handle;
    if (!folderHandle) return;
    await this.remember({
      key: keptFolderKey(userId, knowledgeId, name),
      userId,
      knowledgeId,
      name,
      handle: folderHandle,
      keepInSync,
      lastChecked: existing ? existing.lastChecked : null,
    });
  }

  /**
   * Re-check every folder this person keeps in sync, if the browser still lets
   * Aperture read it; resolves once those runs finish.
   */
  async syncKept(userId: string): Promise<void> {
    const kept = this.state.kept.filter((folder) => folder.userId === userId && folder.keepInSync);
    const runs: Array<Promise<FolderSyncResult | null>> = [];
    for (const folder of kept) {
      if (await this.deps.readable(folder.handle, false)) {
        runs.push(this.sync({ userId, knowledgeId: folder.knowledgeId, source: { name: folder.name, handle: folder.handle } }));
      } else {
        this.setRun(runKey(folder.knowledgeId, folder.name), { phase: "needs-permission" });
      }
    }
    await Promise.all(runs);
  }

  keptFolder(userId: string, knowledgeId: string, name: string): KeptFolder | undefined {
    const key = keptFolderKey(userId, knowledgeId, name);
    return this.state.kept.find((folder) => folder.key === key);
  }

  private async runOnce(request: FolderSyncRequest, key: string, signal: AbortSignal): Promise<FolderSyncResult | null> {
    const { userId, knowledgeId, source } = request;
    try {
      this.setRun(key, { phase: "reading" });
      const read = "handle" in source ? await this.deps.readHandle(source.handle) : sourceFiles(source);
      const [folders, maxMb] = await Promise.all([
        this.deps.listFolders(userId, knowledgeId, signal),
        this.deps.maxUploadMb(userId),
      ]);
      const manifest = folders.find((folder) => folder.name === source.name);
      const plan = planFolderSync(read.files, manifest, (file) => knowledgeFileSkipReason(file, maxMb));
      if (!this.confirmed(request, plan)) {
        this.setRun(key, null);
        return null;
      }
      const result = await this.sendAll(request, key, plan, signal);
      if ("handle" in source) await this.markChecked(userId, knowledgeId, source.name, source.handle);
      this.setRun(key, { phase: "done", result, at: this.deps.now(), truncated: read.truncated });
      this.emit({ type: "finished", knowledgeId, name: source.name, result });
      return result;
    } catch (error) {
      this.setRun(key, { phase: "failed", message: readFailure(error), at: this.deps.now() });
      return null;
    }
  }

  private confirmed(request: FolderSyncRequest, plan: FolderPlan): boolean {
    if (!request.confirmLarge || plan.uploads.length <= LARGE_FOLDER_FILES) return true;
    const bytes = plan.uploads.reduce((total, item) => total + item.file.size, 0);
    return request.confirmLarge(plan.uploads.length, bytes);
  }

  private async sendAll(
    request: FolderSyncRequest,
    key: string,
    plan: FolderPlan,
    signal: AbortSignal,
  ): Promise<FolderSyncResult> {
    const tally = { added: 0, updated: 0, unchanged: plan.unchanged, failed: [] as FolderSyncResult["failed"] };
    const total = plan.uploads.length;
    let next = 0;
    let done = 0;
    const sendNext = async (): Promise<void> => {
      while (next < total && !signal.aborted) {
        const item = plan.uploads[next];
        next += 1;
        this.setRun(key, { phase: "sending", done, total, current: item.path });
        try {
          const sent = await this.deps.sendFile(request.userId, request.knowledgeId, item.file, item.path, signal);
          tally[sent.action] += 1;
          this.emit({ type: "document", knowledgeId: request.knowledgeId, result: sent });
        } catch (error) {
          if (!signal.aborted) tally.failed.push({ path: item.path, message: errorText(error) });
        }
        done += 1;
        this.setRun(key, { phase: "sending", done, total, current: item.path });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_SENDS, total) }, sendNext));
    return { ...tally, skipped: plan.skipped, keptOut: plan.keptOut, stopped: signal.aborted };
  }

  private async markChecked(userId: string, knowledgeId: string, name: string, handle: FolderHandle): Promise<void> {
    const existing = this.keptFolder(userId, knowledgeId, name);
    await this.remember({
      key: keptFolderKey(userId, knowledgeId, name),
      userId,
      knowledgeId,
      name,
      handle,
      keepInSync: Boolean(existing?.keepInSync),
      lastChecked: this.deps.now(),
    });
  }

  private async remember(folder: KeptFolder): Promise<void> {
    await this.deps.store.put(folder);
    const others = this.state.kept.filter((item) => item.key !== folder.key);
    this.setState({ ...this.state, kept: [...others, folder] });
  }

  private setRun(key: string, run: FolderRun | null): void {
    const runs = new Map(this.state.runs);
    if (run) runs.set(key, run);
    else runs.delete(key);
    this.setState({ ...this.state, runs });
  }

  private setState(next: FolderSyncState): void {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  private emit(event: FolderSyncEvent): void {
    this.eventListeners.forEach((listener) => listener(event));
  }
}

function sourceFiles(source: Extract<FolderSource, { files: unknown }>): FolderRead {
  return { files: source.files, truncated: Boolean(source.truncated) };
}

function readFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "The folder could not be found on this computer. It may have been moved or renamed.";
  }
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "This browser did not allow Aperture to read the folder.";
  }
  return errorText(error);
}

function errorText(error: unknown): string {
  const message = error instanceof Error || error instanceof DOMException ? error.message : "";
  return message || "Unknown error.";
}
