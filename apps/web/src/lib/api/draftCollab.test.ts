import { afterEach, describe, expect, it, vi } from "vitest";
import { followDraftEvents, parseSseChunk, putDraftLive, type DraftLiveEvent } from "./draftCollab";

const encoder = new TextEncoder();

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const live = {
  draft_id: "draft-1",
  kind: "document",
  seq: 3,
  current_revision: 1,
  title: "Memo",
  content: "<p>x</p>",
  content_sha256: "a".repeat(64),
  updated_at: "2026-11-03T12:00:00Z",
  updated_by_user_id: "ben",
  updated_by_client: "client-ben",
};

afterEach(() => vi.unstubAllGlobals());

describe("parseSseChunk", () => {
  it("returns whole events and keeps a partial frame for the next chunk", () => {
    const parsed = parseSseChunk('event: live\ndata: {"seq":2,"current_revision":1}\n\nevent: presence\ndata: {"partic');
    expect(parsed.events).toEqual([{ event: "live", data: { seq: 2, current_revision: 1 } }]);
    expect(parsed.rest).toBe('event: presence\ndata: {"partic');
  });

  it("skips comments, unknown events, and frames that are not JSON", () => {
    const parsed = parseSseChunk(': ping\n\nevent: other\ndata: {}\n\nevent: live\ndata: {nope\n\nevent: resync\ndata: {}\n\n');
    expect(parsed.events).toEqual([{ event: "resync", data: {} }]);
    expect(parsed.rest).toBe("");
  });
});

describe("putDraftLive", () => {
  it("answers a 409 with the live copy someone else saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ detail: "changed", live, role: "collaborator", updated_by_name: "Ben" }),
      { status: 409, headers: { "content-type": "application/json" } },
    )));
    const result = await putDraftLive("ana", "draft-1", { expected_seq: 2, client_id: "client-ana-1", content: "<p>y</p>" });
    expect(result).toEqual({ kind: "conflict", response: { detail: "changed", live, role: "collaborator", updated_by_name: "Ben" } });
  });

  it("returns the saved copy, and throws for other failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ live, role: "owner", updated_by_name: "Ana" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Draft content is limited." }), { status: 413 }))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const body = { expected_seq: 2, client_id: "client-ana-1", content: "<p>y</p>", title: "Memo" };

    await expect(putDraftLive("ana", "draft-1", body)).resolves.toMatchObject({ kind: "saved", response: { role: "owner" } });
    await expect(putDraftLive("ana", "draft-1", body)).rejects.toMatchObject({ status: 413, message: "Draft content is limited." });
    await expect(putDraftLive("ana", "draft-1", body)).rejects.toThrow("Could not reach the API");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(body);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});

describe("followDraftEvents", () => {
  it("delivers events until the server ends access", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamOf(
      'event: hello\ndata: {"client_id":"c1","role":"owner","seq":0,"current_revision":1,"participants":[]}\n\n',
      'event: live\ndata: {"seq":1,"current_revision":1}\n\nevent: access\ndata: {"state":"deleted"}\n\n',
    ), { status: 200 })));
    const events: DraftLiveEvent["event"][] = [];
    const connection: boolean[] = [];

    await followDraftEvents("ana", "draft-1", "client-ana-1", {
      onEvent: (event) => events.push(event.event),
      onConnection: (connected) => connection.push(connected),
    });

    expect(events).toEqual(["hello", "live", "access"]);
    expect(connection).toEqual([true]);
  });

  it("treats a refused reconnect as lost access", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const events: DraftLiveEvent[] = [];
    await followDraftEvents("ana", "draft-1", "client-ana-1", { onEvent: (event) => events.push(event) });
    expect(events).toEqual([{ event: "access", data: { state: "revoked" } }]);
  });

  it("reconnects after a dropped connection and stops when aborted", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockImplementationOnce(async () => new Response(streamOf('event: resync\ndata: {}\n\n'), { status: 200 }))
      .mockImplementation(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      });
    vi.stubGlobal("fetch", fetchMock);
    const events: string[] = [];
    const connection: boolean[] = [];

    await followDraftEvents("ana", "draft-1", "client-ana-1", {
      signal: controller.signal,
      onEvent: (event) => events.push(event.event),
      onConnection: (connected) => connection.push(connected),
    });

    expect(events).toEqual(["resync"]);
    expect(connection).toEqual([false, true, false]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/drafts/draft-1/live/events?client_id=client-ana-1");
  }, 10000);
});
