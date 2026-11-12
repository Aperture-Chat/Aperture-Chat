import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import type { DraftEventStreamOptions, DraftLiveEvent, DraftLiveResponse, DraftSharing } from "../lib/api/draftCollab";

// A colleague's change to a shared deck, driven through the real
// live session. Only the network edges of draftCollab are faked: an in-memory
// live copy that saves on the expected seq and answers a stale seq with 409.
vi.mock("../lib/api/draftCollab", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api/draftCollab")>();
  return {
    ...actual,
    getDraftSharing: vi.fn(),
    getDraftLive: vi.fn(),
    putDraftLive: vi.fn(),
    putDraftPresence: vi.fn(),
    followDraftEvents: vi.fn(),
  };
});

import * as collab from "../lib/api/draftCollab";
import { DocumentAssistantWorkspace } from "./DocumentAssistantWorkspace";

const DRAFT_ID = "deck-live-1";
const rich = (text: string) => (text ? [{ text }] : []);

function deck(title: string, subtitle: string) {
  return JSON.stringify({
    schema: "aperture-deck-v1",
    title: "Hartwell board update",
    slides: [
      { id: "slide-1", layout: "title", notes: "", title: rich(title), subtitle: rich(subtitle) },
      { id: "slide-2", layout: "title-bullets", notes: "", title: rich("Agenda"), bullets: [] },
      { id: "slide-3", layout: "closing", notes: "", title: rich("Next steps"), body: rich("") },
    ],
  });
}

function snapshot(content: string) {
  const now = "2026-11-03T12:00:00Z";
  return {
    document: {
      id: DRAFT_ID, tenant_id: "tenant-example", owner_user_id: "user-admin", matter_id: null,
      title: "Hartwell board update", current_revision: 1, created_at: now, updated_at: now, kind: "deck",
    },
    revision: {
      draft_id: DRAFT_ID, tenant_id: "tenant-example", owner_user_id: "user-admin", revision: 1,
      title: "Hartwell board update", content, content_sha256: "0".repeat(64), sanitizer_version: "deck-json-v1", created_at: now,
    },
  };
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

let server: { seq: number; content: string; byUserId: string | null };
let stream: DraftEventStreamOptions | null;
let clientId = "";
let errors: string[];

function liveResponse(): DraftLiveResponse {
  return {
    live: {
      draft_id: DRAFT_ID, kind: "deck", seq: server.seq, current_revision: 1, title: "Hartwell board update",
      content: server.content, content_sha256: String(server.seq), updated_at: "2026-11-03T12:00:00Z",
      updated_by_user_id: server.byUserId, updated_by_client: null,
    },
    role: "owner",
    updated_by_name: server.byUserId ? "Bea Lane" : null,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  server = { seq: 1, content: deck("Kickoff", "Board update, N"), byUserId: null };
  stream = null;
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  const sharing: DraftSharing = {
    draft_id: DRAFT_ID,
    owner: { id: "user-admin", display_name: "Alex Morgan", email: "alex@example.test" },
    role: "owner", can_manage: true, matter_bound: false, groups: [],
    people: [{ id: "user-bea", display_name: "Bea Lane", email: "bea@example.test" }],
  };
  vi.mocked(collab.getDraftSharing).mockResolvedValue(sharing);
  vi.mocked(collab.getDraftLive).mockImplementation(async () => liveResponse());
  vi.mocked(collab.putDraftLive).mockImplementation(async (_user, _draft, body) => {
    if (body.expected_seq !== server.seq) return { kind: "conflict", response: liveResponse() };
    server = { seq: server.seq + 1, content: body.content, byUserId: "user-admin" };
    return { kind: "saved", response: liveResponse() };
  });
  vi.mocked(collab.putDraftPresence).mockResolvedValue(undefined as never);
  vi.mocked(collab.followDraftEvents).mockImplementation((_user, _draft, id, options) => {
    clientId = id;
    stream = options;
    return new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve()));
  });
  (globalThis.fetch as unknown as { mockImplementation: (f: typeof fetch) => void }).mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith(`/api/drafts/${DRAFT_ID}`) && method === "GET") return json(snapshot(deck("Kickoff", "Board update, N")));
    if (/\/api\/drafts(\?.*)?$/.test(url) && method === "GET") return json([]);
    return json({ error: "offline" }, 503);
  });
});

afterEach(() => vi.restoreAllMocks());

const box = (label: string) => screen.getByRole("textbox", { name: label });

function deliver(event: DraftLiveEvent) {
  act(() => stream?.onEvent(event));
}

test("a colleague's change lands in a shared deck while you type in another box, and the editor settles", async () => {
  render(<DocumentAssistantWorkspace data={sampleData} brandName="Aperture Chat" initialServerDraftId={DRAFT_ID} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /^Shared/ })).toBeInTheDocument());
  await waitFor(() => expect(stream).not.toBeNull());
  deliver({ event: "hello", data: { client_id: clientId, role: "owner", seq: server.seq, current_revision: 1, participants: [] } });

  // The owner is typing in the title, so the text toolbar is up.
  const title = box("Title slide title");
  fireEvent.focus(title);
  fireEvent.mouseUp(title);
  title.textContent = "Hartwell acquisition";
  fireEvent.input(title);

  // Bea finishes the subtitle on the server.
  server = { seq: server.seq + 1, content: deck("Kickoff", "Board update, November"), byUserId: "user-bea" };
  deliver({ event: "live", data: { seq: server.seq, current_revision: 1, updated_by_user_id: "user-bea", updated_by_client: "bea-client" } });

  await waitFor(() => expect(box("Title slide subtitle").textContent).toBe("Board update, November"));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1600)); });

  expect(errors.filter((message) => /Maximum update depth|#185/.test(message))).toEqual([]);
  expect(box("Title slide subtitle").textContent).toBe("Board update, November");
  expect(box("Title slide title").textContent).toBe("Hartwell acquisition");
  // What the owner's editor saves keeps both people's words.
  const saved = JSON.parse(server.content) as { slides: { layout: string; subtitle?: { text: string }[] }[] };
  expect(saved.slides[0].subtitle).toEqual([{ text: "Board update, November" }]);
  expect(saved.slides.map((slide) => slide.layout)).toEqual(["title", "title-bullets", "closing"]);
});
