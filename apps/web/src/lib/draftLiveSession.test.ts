import { describe, expect, it } from "vitest";
import { mergeDraftHtml } from "./draftMerge";
import {
  DraftLiveSession,
  LIVE_SAVE_DELAY_MS,
  LIVE_SAVE_MAX_WAIT_MS,
  type LiveDoc,
  type LiveServerState,
  type LiveStatus,
  type LiveTimers,
  type LiveTransport,
} from "./draftLiveSession";

/** The server's live copy with the same compare-and-set rule as the API. */
class FakeServer {
  seq = 0;
  doc: LiveDoc;
  by: string | null = null;
  offline = false;
  /** Bumps seq before every save lands, as if someone always saved first. */
  contested = false;
  puts: string[] = [];
  attempts = 0;
  fetches = 0;
  failWith: Error | null = null;
  constructor(start: LiveDoc) {
    this.doc = start;
  }
  state(): LiveServerState {
    return {
      seq: this.seq,
      currentRevision: 1,
      title: this.doc.title,
      content: this.doc.content,
      updatedByUserId: this.by,
      updatedByClient: null,
      updatedByName: this.by,
    };
  }
  transport(who: string): LiveTransport {
    return {
      fetch: async () => {
        this.fetches += 1;
        if (this.offline) throw this.failWith ?? new Error("Could not reach the API.");
        return this.state();
      },
      put: async ({ expectedSeq, title, content }) => {
        this.attempts += 1;
        if (this.offline) throw this.failWith ?? new Error("Could not reach the API.");
        if (this.contested) {
          this.seq += 1;
          this.doc = { ...this.doc, content: `${this.doc.content}<p>Someone else ${this.seq}.</p>` };
          return { kind: "conflict", state: this.state() };
        }
        if (expectedSeq !== this.seq) return { kind: "conflict", state: this.state() };
        this.puts.push(who);
        if (title !== this.doc.title || content !== this.doc.content) {
          this.seq += 1;
          this.doc = { title, content };
          this.by = who;
        }
        return { kind: "saved", state: this.state() };
      },
    };
  }
}

class ManualTimers implements LiveTimers {
  private next = 1;
  private pending = new Map<number, { at: number; run: () => void }>();
  time = 0;
  get pendingCount() {
    return this.pending.size;
  }
  set(callback: () => void, ms: number) {
    const id = this.next++;
    this.pending.set(id, { at: this.time + ms, run: callback });
    return id;
  }
  clear(handle: unknown) {
    this.pending.delete(handle as number);
  }
  async advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.time) continue;
      this.pending.delete(id);
      timer.run();
      await settle();
    }
    await settle();
  }
}

async function settle() {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
}

/** One person's editor: a document plus the session that keeps it live. */
function editor(server: FakeServer, who: string, timers = new ManualTimers()) {
  const view = { doc: { ...server.doc }, statuses: [] as LiveStatus[], applied: [] as string[] };
  const session = new DraftLiveSession(
    server.transport(who),
    {
      read: () => ({ ...view.doc }),
      normalize: (content) => content,
      merge: mergeDraftHtml,
      apply: (doc, change) => {
        view.doc = { ...doc };
        view.applied.push(change.merged ? "merged" : `from ${change.byName}`);
      },
      status: (status) => view.statuses.push(status),
    },
    timers,
    () => timers.time,
  );
  const type = (content: string) => {
    view.doc = { ...view.doc, content };
    session.noteLocalChange();
  };
  return { view, session, timers, type };
}

const start: LiveDoc = { title: "Memo", content: "<p>One.</p><p>Two.</p>" };

describe("DraftLiveSession", () => {
  it("autosaves a short pause after typing, once", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);

    ana.type("<p>One, edited.</p><p>Two.</p>");
    ana.type("<p>One, edited again.</p><p>Two.</p>");
    await ana.timers.advance(LIVE_SAVE_DELAY_MS - 1);
    expect(server.puts).toEqual([]);
    await ana.timers.advance(1);

    expect(server.puts).toEqual(["ana"]);
    expect(server.doc.content).toBe("<p>One, edited again.</p><p>Two.</p>");
    expect(ana.view.statuses.at(-1)).toEqual({ kind: "synced", seq: 1 });
    expect(ana.session.hasUnsavedChanges()).toBe(false);
  });

  it("still saves during nonstop typing, at the latest after the max wait", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);

    for (let ms = 0; ms < LIVE_SAVE_MAX_WAIT_MS; ms += 500) {
      ana.type(`<p>One ${ms}.</p><p>Two.</p>`);
      await ana.timers.advance(500);
    }
    expect(server.puts.length).toBeGreaterThanOrEqual(1);
  });

  it("shows someone else's saved edit in an editor with nothing unsaved", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    const ben = editor(server, "ben");
    await ana.session.start(start);
    await ben.session.start(start);

    ben.type("<p>One.</p><p>Two, from Ben.</p>");
    await ben.timers.advance(LIVE_SAVE_DELAY_MS);
    ana.session.remoteSaved(server.seq);
    await settle();

    expect(ana.view.doc.content).toBe("<p>One.</p><p>Two, from Ben.</p>");
    expect(ana.view.applied).toEqual(["from ben"]);
    expect(server.puts).toEqual(["ben"]);
  });

  it("merges two people typing at once so both edits survive everywhere", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    const ben = editor(server, "ben");
    await ana.session.start(start);
    await ben.session.start(start);

    ana.type("<p>One, from Ana.</p><p>Two.</p>");
    ben.type("<p>One.</p><p>Two, from Ben.</p>");
    await ana.timers.advance(LIVE_SAVE_DELAY_MS);
    await ben.timers.advance(LIVE_SAVE_DELAY_MS); // conflicts, merges, saves again
    ana.session.remoteSaved(server.seq);
    await settle();

    const both = "<p>One, from Ana.</p><p>Two, from Ben.</p>";
    expect(server.doc.content).toBe(both);
    expect(ana.view.doc.content).toBe(both);
    expect(ben.view.doc.content).toBe(both);
    expect(ben.view.applied).toEqual(["merged"]);
  });

  it("merges edits made before joining with what was saved live meanwhile", async () => {
    const server = new FakeServer(start);
    const ben = editor(server, "ben");
    await ben.session.start(start);
    ben.type("<p>One.</p><p>Two, from Ben.</p>");
    await ben.timers.advance(LIVE_SAVE_DELAY_MS);

    const ana = editor(new FakeServer(start), "ana");
    ana.view.doc = { title: "Memo", content: "<p>One, from Ana.</p><p>Two.</p>" };
    const joined = new DraftLiveSession(
      server.transport("ana"),
      {
        read: () => ({ ...ana.view.doc }),
        normalize: (content) => content,
        merge: mergeDraftHtml,
        apply: (doc) => {
          ana.view.doc = { ...doc };
        },
        status: () => {},
      },
      ana.timers,
      () => ana.timers.time,
    );
    await joined.start(start);

    expect(server.doc.content).toBe("<p>One, from Ana.</p><p>Two, from Ben.</p>");
    expect(ana.view.doc.content).toBe(server.doc.content);
  });

  it("keeps edits through an outage and saves them when the server is back", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);
    server.offline = true;

    ana.type("<p>Typed offline.</p><p>Two.</p>");
    await ana.timers.advance(LIVE_SAVE_DELAY_MS);
    expect(ana.view.statuses.at(-1)).toMatchObject({ kind: "offline", retryInMs: 2000 });
    expect(ana.session.hasUnsavedChanges()).toBe(true);

    server.offline = false;
    await ana.timers.advance(2000);
    expect(server.doc.content).toBe("<p>Typed offline.</p><p>Two.</p>");
    expect(ana.view.statuses.at(-1)).toEqual({ kind: "synced", seq: 1 });
  });

  it("flush saves immediately and fails loudly when it cannot", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);

    ana.type("<p>Before a version.</p><p>Two.</p>");
    await ana.session.flush();
    expect(server.doc.content).toBe("<p>Before a version.</p><p>Two.</p>");

    server.offline = true;
    ana.type("<p>Lost signal.</p><p>Two.</p>");
    await expect(ana.session.flush()).rejects.toThrow("could not be saved");
  });

  it("ignores announcements it has already caught up with and stops cleanly", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);
    ana.type("<p>Mine.</p><p>Two.</p>");
    await ana.timers.advance(LIVE_SAVE_DELAY_MS);

    ana.session.remoteSaved(1); // its own save
    await settle();
    expect(ana.view.applied).toEqual([]);

    ana.session.stop();
    ana.type("<p>After stop.</p><p>Two.</p>");
    await ana.timers.advance(LIVE_SAVE_DELAY_MS);
    expect(server.doc.content).toBe("<p>Mine.</p><p>Two.</p>");
  });
});


describe("DraftLiveSession timing and recovery", () => {
  it("reports its seq, and joins from a copy it was handed without fetching", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    expect(ana.session.seq).toBe(-1);
    expect(ana.session.hasUnsavedChanges()).toBe(false);
    ana.session.noteLocalChange();
    expect(ana.timers.pendingCount).toBe(0);

    server.seq = 4;
    await ana.session.start(start, server.state());
    expect(server.fetches).toBe(0);
    expect(ana.session.seq).toBe(4);
  });

  it("waits for a pause in typing before saving", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);

    ana.type("<p>One a.</p><p>Two.</p>");
    await ana.timers.advance(500);
    ana.type("<p>One ab.</p><p>Two.</p>");
    await ana.timers.advance(300);
    expect(server.puts).toEqual([]);
    await ana.timers.advance(400);
    expect(server.puts).toEqual(["ana"]);
    expect(ana.timers.pendingCount).toBe(0);
  });

  it("saves exactly at the max wait during nonstop typing", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);

    for (let ms = 0; ms <= 2500; ms += 500) {
      ana.type(`<p>One ${ms}.</p><p>Two.</p>`);
      await ana.timers.advance(ms === 2500 ? 499 : 500);
    }
    expect(server.puts).toEqual([]);
    await ana.timers.advance(1);
    expect(server.puts).toEqual(["ana"]);
  });

  it("flush and stop leave no timer behind", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);
    ana.type("<p>Flushed.</p><p>Two.</p>");
    await ana.session.flush();
    expect(ana.timers.pendingCount).toBe(0);

    ana.type("<p>Pending.</p><p>Two.</p>");
    ana.session.stop();
    expect(ana.timers.pendingCount).toBe(0);
    const fetched = server.fetches;
    ana.session.remoteSaved(99);
    await settle();
    expect(server.fetches).toBe(fetched);
  });

  it("does not pull when the announced save is already caught up, or the server has not moved", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);
    const before = server.fetches;

    ana.session.remoteSaved(0);
    await settle();
    expect(server.fetches).toBe(before);
    ana.session.remoteSaved(5); // the server is still at 0
    await settle();
    expect(server.fetches).toBe(before + 1);
    expect(ana.view.applied).toEqual([]);
  });

  it("retries a failed catch-up and then shows the change", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    const ben = editor(server, "ben");
    await ana.session.start(start);
    await ben.session.start(start);
    ben.type("<p>One.</p><p>Two, Ben.</p>");
    await ben.timers.advance(LIVE_SAVE_DELAY_MS);

    server.offline = true;
    ana.session.remoteSaved(server.seq);
    await settle();
    expect(ana.view.statuses.at(-1)).toMatchObject({ kind: "offline" });
    server.offline = false;
    await ana.timers.advance(2000);

    expect(ana.view.doc.content).toBe("<p>One.</p><p>Two, Ben.</p>");
    expect(ana.view.applied).toEqual(["from ben"]);
  });

  it("backs off 2, 4, 8, 15, then 30 seconds, and starts over after a success", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);
    server.offline = true;
    ana.type("<p>Offline.</p><p>Two.</p>");
    await ana.timers.advance(LIVE_SAVE_DELAY_MS);
    for (const wait of [2000, 4000, 8000, 15000, 30000]) await ana.timers.advance(wait);
    const delays = ana.view.statuses.filter((status) => status.kind === "offline").map((status) => status.kind === "offline" && status.retryInMs);
    expect(delays).toEqual([2000, 4000, 8000, 15000, 30000, 30000]);
    expect(ana.timers.pendingCount).toBe(1);

    server.offline = false;
    await ana.timers.advance(30000);
    expect(ana.view.statuses.at(-1)).toEqual({ kind: "synced", seq: 1 });
    server.offline = true;
    ana.type("<p>Offline again.</p><p>Two.</p>");
    await ana.timers.advance(LIVE_SAVE_DELAY_MS);
    expect(ana.view.statuses.at(-1)).toMatchObject({ kind: "offline", retryInMs: 2000 });
  });

  it("says the server could not be reached when the failure has no words", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);
    server.offline = true;
    server.failWith = new Error("");
    ana.type("<p>x</p><p>Two.</p>");
    await ana.timers.advance(LIVE_SAVE_DELAY_MS);
    expect(ana.view.statuses.at(-1)).toMatchObject({ kind: "offline", message: "The server could not be reached." });
  });

  it("keeps one retry pending when saves fail back to back", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);
    server.offline = true;
    ana.type("<p>x</p><p>Two.</p>");
    await ana.timers.advance(LIVE_SAVE_DELAY_MS);
    await expect(ana.session.flush()).rejects.toThrow();
    expect(ana.timers.pendingCount).toBe(1);
  });

  it("a save retry does not also pull, once it has recovered", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);
    server.offline = true;
    ana.type("<p>First outage.</p><p>Two.</p>");
    await ana.timers.advance(LIVE_SAVE_DELAY_MS);
    server.offline = false;
    await ana.timers.advance(2000);
    server.offline = true;
    ana.type("<p>Second outage.</p><p>Two.</p>");
    await ana.timers.advance(LIVE_SAVE_DELAY_MS);
    const fetches = server.fetches;
    server.offline = false;
    await ana.timers.advance(2000);
    expect(server.fetches).toBe(fetches);
    expect(server.doc.content).toBe("<p>Second outage.</p><p>Two.</p>");
  });

  it("sends typing that arrived while a save was on its way, right away", async () => {
    const server = new FakeServer(start);
    let release: () => void = () => {};
    const transport = server.transport("ana");
    const slow = {
      ...transport,
      put: async (body: Parameters<typeof transport.put>[0]) => {
        await new Promise<void>((resolve) => (release = resolve));
        return transport.put(body);
      },
    };
    let doc = { ...start };
    const timers = new ManualTimers();
    const session = new DraftLiveSession(
      slow,
      { read: () => ({ ...doc }), normalize: (c) => c, merge: mergeDraftHtml, apply: (d) => (doc = { ...d }), status: () => {} },
      timers,
      () => timers.time,
    );
    await session.start(start);
    doc = { ...doc, content: "<p>First.</p><p>Two.</p>" };
    const saving = session.flush();
    await settle();
    doc = { ...doc, content: "<p>First and more.</p><p>Two.</p>" };
    release();
    await settle();
    release();
    await saving;
    expect(server.doc.content).toBe("<p>First and more.</p><p>Two.</p>");
  });

  it("saves a merge with someone else's work at once, without waiting for its own pause", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    const ben = editor(server, "ben");
    await ana.session.start(start);
    await ben.session.start(start);
    ben.type("<p>One.</p><p>Two, Ben.</p>");
    await ben.timers.advance(LIVE_SAVE_DELAY_MS);

    ana.type("<p>One, Ana.</p><p>Two.</p>");
    ana.session.remoteSaved(server.seq);
    await settle();

    expect(server.doc.content).toBe("<p>One, Ana.</p><p>Two, Ben.</p>");
    expect(ana.view.applied).toEqual(["merged"]);
  });

  it("gives up after six merge rounds against someone who always saves first", async () => {
    const server = new FakeServer(start);
    const ana = editor(server, "ana");
    await ana.session.start(start);
    server.contested = true;
    ana.type("<p>One, Ana.</p><p>Two.</p>");
    await ana.timers.advance(LIVE_SAVE_DELAY_MS);
    expect(server.attempts).toBe(6);
    expect(ana.session.hasUnsavedChanges()).toBe(true);
  });

  it("keeps my new title, takes theirs when I left it alone, and reports a clean apply as no conflict", async () => {
    const server = new FakeServer(start);
    const changes: Array<{ merged: boolean; conflicts: number }> = [];
    let doc = { ...start };
    const session = new DraftLiveSession(
      server.transport("ana"),
      {
        read: () => ({ ...doc }),
        normalize: (c) => c,
        merge: mergeDraftHtml,
        apply: (d, change) => {
          doc = { ...d };
          changes.push({ merged: change.merged, conflicts: change.conflicts });
        },
        status: () => {},
      },
      new ManualTimers(),
    );
    await session.start(start);
    server.seq = 1;
    server.doc = { title: "Memo (Ben)", content: start.content };
    session.remoteSaved(1);
    await settle();
    expect(doc.title).toBe("Memo (Ben)");
    expect(changes).toEqual([{ merged: false, conflicts: 0 }]);

    doc = { ...doc, title: "Memo (Ana)" };
    server.seq = 2;
    server.doc = { title: "Memo (Ben)", content: "<p>One.</p><p>Two, Ben.</p>" };
    session.remoteSaved(2);
    await settle();
    expect(doc).toEqual({ title: "Memo (Ana)", content: "<p>One.</p><p>Two, Ben.</p>" });
  });
});
