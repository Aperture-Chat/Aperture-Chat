/**
 * Keeps one open draft in step with its shared live copy on the server.
 *
 * The editor stays the source of truth for what this person sees. The
 * session autosaves it (debounced), and when someone else saved first it
 * merges: `base` is the server copy this editor last agreed with, `mine` is
 * the editor now, `theirs` is the server copy now (see draftMerge.ts). Only
 * one save is in flight at a time, so saves from this tab never race each
 * other; races with other people are settled by the server's `seq`.
 *
 * Every value here is in "merge space": the kind's canonical account form
 * (flow HTML for documents, canonical JSON for decks and spreadsheets), so
 * page layout and serializer differences never look like edits.
 */
import type { MergeResult } from "./draftMerge";

export type LiveDoc = { title: string; content: string };

export type LiveServerState = {
  seq: number;
  currentRevision: number;
  title: string;
  content: string;
  updatedByUserId: string | null;
  updatedByClient: string | null;
  updatedByName: string | null;
};

export type LivePutResult = { kind: "saved"; state: LiveServerState } | { kind: "conflict"; state: LiveServerState };

export type LiveTransport = {
  fetch(): Promise<LiveServerState>;
  put(body: { expectedSeq: number; title: string; content: string }): Promise<LivePutResult>;
};

export type LiveStatus =
  | { kind: "synced"; seq: number }
  | { kind: "saving" }
  | { kind: "offline"; message: string; retryInMs: number };

export type LiveRemoteChange = { byName: string | null; byUserId: string | null; merged: boolean; conflicts: number };

export type LiveHooks = {
  /** The editor's content now, in merge space. */
  read(): LiveDoc;
  /** Server content into merge space. */
  normalize(content: string): string;
  merge(base: string, mine: string, theirs: string): MergeResult<string>;
  /** Show `doc` in the editor (someone else's edit, or a merge with it).
   * Must take effect synchronously: `read()` right after returns `doc` (as
   * the editor serializes it), or a save could resend the pre-merge text. */
  apply(doc: LiveDoc, change: LiveRemoteChange): void;
  status(status: LiveStatus): void;
};

export type LiveTimers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export const LIVE_SAVE_DELAY_MS = 700;
export const LIVE_SAVE_MAX_WAIT_MS = 3000;
const RETRY_STEPS_MS = [2000, 4000, 8000, 15000, 30000];
const MAX_MERGE_ROUNDS = 6;

const browserTimers: LiveTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function sameDoc(left: LiveDoc, right: LiveDoc): boolean {
  return left.title === right.title && left.content === right.content;
}

export class DraftLiveSession {
  private shadow: { seq: number; doc: LiveDoc } | null = null;
  /** What this editor last showed or sent that the server holds at shadow.seq. */
  private agreed: LiveDoc | null = null;
  private saveTimer: unknown = null;
  private retryTimer: unknown = null;
  private firstUnsavedAt: number | null = null;
  private running: Promise<void> | null = null;
  private wantsSave = false;
  private wantsPull = false;
  private failures = 0;
  private retryNeeds = { pull: false, save: false };
  private stopped = false;

  constructor(
    private readonly transport: LiveTransport,
    private readonly hooks: LiveHooks,
    private readonly timers: LiveTimers = browserTimers,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The newest live seq this editor has caught up with. */
  get seq(): number {
    return this.shadow?.seq ?? -1;
  }

  /**
   * Join the live copy. `loadedFrom` is the content the editor was opened
   * with (merge space), so edits made before joining merge with anything
   * saved live since, instead of replacing it.
   */
  async start(loadedFrom: LiveDoc, initial?: LiveServerState): Promise<void> {
    const state = initial ?? (await this.transport.fetch());
    if (this.stopped) return;
    const theirs = this.serverDoc(state);
    const mine = this.hooks.read();
    this.shadow = { seq: state.seq, doc: theirs };
    if (sameDoc(mine, theirs)) {
      this.agreed = mine;
      this.hooks.status({ kind: "synced", seq: state.seq });
      return;
    }
    const merged = this.mergeDocs(loadedFrom, mine, theirs);
    if (!sameDoc(merged.doc, mine)) this.applyRemote(merged.doc, state, true, merged.conflicts);
    this.agreed = sameDoc(merged.doc, theirs) ? this.hooks.read() : null;
    if (this.agreed) this.hooks.status({ kind: "synced", seq: state.seq });
    else await this.saveNow();
  }

  /** The editor changed; autosave soon. */
  noteLocalChange(): void {
    if (this.stopped || !this.shadow) return;
    if (this.agreed && sameDoc(this.hooks.read(), this.agreed)) return;
    const now = this.now();
    this.firstUnsavedAt ??= now;
    const waited = now - this.firstUnsavedAt;
    const delay = Math.max(0, Math.min(LIVE_SAVE_DELAY_MS, LIVE_SAVE_MAX_WAIT_MS - waited));
    if (this.saveTimer !== null) this.timers.clear(this.saveTimer);
    this.saveTimer = this.timers.set(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, delay);
  }

  /** Someone saved the live copy (an event-stream announcement). */
  remoteSaved(seq: number): void {
    if (this.stopped || !this.shadow || seq <= this.shadow.seq) return;
    this.wantsPull = true;
    void this.drain();
  }

  /** Save now and wait until the server holds what the editor shows. */
  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      this.timers.clear(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveNow();
    if (this.hasUnsavedChanges()) throw new Error("The live draft could not be saved.");
  }

  /** True while the editor shows something the server does not hold yet. */
  hasUnsavedChanges(): boolean {
    if (!this.shadow) return false;
    return !this.agreed || !sameDoc(this.hooks.read(), this.agreed);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of [this.saveTimer, this.retryTimer]) if (timer !== null) this.timers.clear(timer);
    this.saveTimer = this.retryTimer = null;
  }

  private saveNow(): Promise<void> {
    this.wantsSave = true;
    return this.drain();
  }

  /** Runs pending pulls and saves one at a time until none are wanted. */
  private drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        while (!this.stopped && (this.wantsPull || this.wantsSave)) {
          if (this.wantsPull) {
            this.wantsPull = false;
            await this.pull();
          }
          if (this.wantsSave) {
            this.wantsSave = false;
            await this.push();
          }
        }
      } catch {
        // The editor refused a read or apply (it moved to another draft):
        // this session is over, and must not write anything further.
        this.stop();
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async pull(): Promise<void> {
    const shadow = this.shadow;
    if (!shadow) return;
    let state: LiveServerState;
    try {
      state = await this.transport.fetch();
    } catch (error) {
      this.scheduleRetry(error, { pull: true });
      return;
    }
    if (this.stopped || state.seq <= shadow.seq) return;
    this.takeServer(state);
  }

  /** Bring the editor to the server copy `state`, merging unsaved edits. */
  private takeServer(state: LiveServerState): void {
    const shadow = this.shadow!;
    const theirs = this.serverDoc(state);
    const mine = this.hooks.read();
    const clean = this.agreed !== null && sameDoc(mine, this.agreed);
    if (clean) {
      this.applyRemote(theirs, state, false, 0);
      this.shadow = { seq: state.seq, doc: theirs };
      this.agreed = this.hooks.read();
      this.hooks.status({ kind: "synced", seq: state.seq });
      return;
    }
    const merged = this.mergeDocs(shadow.doc, mine, theirs);
    if (!sameDoc(merged.doc, mine)) this.applyRemote(merged.doc, state, true, merged.conflicts);
    this.shadow = { seq: state.seq, doc: theirs };
    this.agreed = sameDoc(merged.doc, theirs) ? this.hooks.read() : null;
    if (this.agreed) this.hooks.status({ kind: "synced", seq: state.seq });
    else this.wantsSave = true;
  }

  private async push(): Promise<void> {
    for (let round = 0; round < MAX_MERGE_ROUNDS && !this.stopped; round += 1) {
      const shadow = this.shadow;
      if (!shadow) return;
      const mine = this.hooks.read();
      if (this.agreed && sameDoc(mine, this.agreed)) {
        this.firstUnsavedAt = null;
        this.hooks.status({ kind: "synced", seq: shadow.seq });
        return;
      }
      this.hooks.status({ kind: "saving" });
      let result: LivePutResult;
      try {
        result = await this.transport.put({ expectedSeq: shadow.seq, title: mine.title, content: mine.content });
      } catch (error) {
        this.scheduleRetry(error, { save: true });
        return;
      }
      if (this.stopped) return;
      this.failures = 0;
      if (this.settle(result, mine)) return;
    }
  }

  /** Records a save's answer; true when nothing is left to send. */
  private settle(result: LivePutResult, sent: LiveDoc): boolean {
    if (result.kind === "conflict") {
      this.takeServer(result.state);
      this.wantsSave = false;
      return this.agreed !== null;
    }
    this.shadow = { seq: result.state.seq, doc: this.serverDoc(result.state) };
    this.agreed = sent;
    // More typing may have arrived while saving; then the loop sends again.
    if (!sameDoc(this.hooks.read(), sent)) return false;
    this.firstUnsavedAt = null;
    this.hooks.status({ kind: "synced", seq: result.state.seq });
    return true;
  }

  /** Stops this drain and tries again after a growing delay. Only the timer
   * retries, so an outage never becomes a tight loop of failing requests. */
  private scheduleRetry(error: unknown, retry: { pull?: boolean; save?: boolean }): void {
    this.wantsPull = false;
    this.wantsSave = false;
    this.retryNeeds.pull ||= Boolean(retry.pull);
    this.retryNeeds.save ||= Boolean(retry.save);
    const delay = RETRY_STEPS_MS[Math.min(this.failures, RETRY_STEPS_MS.length - 1)];
    this.failures += 1;
    const message = error instanceof Error && error.message ? error.message : "The server could not be reached.";
    this.hooks.status({ kind: "offline", message, retryInMs: delay });
    if (this.retryTimer !== null) this.timers.clear(this.retryTimer);
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = null;
      this.wantsPull ||= this.retryNeeds.pull;
      this.wantsSave ||= this.retryNeeds.save;
      this.retryNeeds = { pull: false, save: false };
      void this.drain();
    }, delay);
  }

  private serverDoc(state: LiveServerState): LiveDoc {
    return { title: state.title, content: this.hooks.normalize(state.content) };
  }

  private mergeDocs(base: LiveDoc, mine: LiveDoc, theirs: LiveDoc): { doc: LiveDoc; conflicts: number } {
    const content = this.hooks.merge(base.content, mine.content, theirs.content);
    const title = mine.title === base.title ? theirs.title : mine.title;
    return { doc: { title, content: content.value }, conflicts: content.conflicts };
  }

  private applyRemote(doc: LiveDoc, state: LiveServerState, merged: boolean, conflicts: number): void {
    this.hooks.apply(doc, { byName: state.updatedByName, byUserId: state.updatedByUserId, merged, conflicts });
  }
}
