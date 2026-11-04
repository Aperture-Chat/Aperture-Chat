/**
 * Shared-draft API client: sharing, the live copy, versions, presence, and
 * the live event stream. Mirrors services/api/app/routes/draft_collaboration.py.
 *
 * Drafts stay private until their owner shares them with one of the owner's
 * groups or with specific people in those groups. Collaborators edit the
 * live copy and save versions; only the owner manages sharing.
 */
import { apiBase, apiRequest, authHeaders, ChatRequestError, pathId, readApiError, tenantHeaders } from "./http";
import type { DraftDocument, DraftKind, DraftRequestOptions, DraftRevision, DraftSnapshot } from "./drafts";

export type SharePerson = { id: string; display_name: string; email: string };
export type ShareGroup = { id: string; name: string; member_count: number };
/** Whose names a person may pick: their groups' members (most people),
 * their whole organization (administrators), or everyone (platform owners). */
export type SharePeopleScope = "groups" | "organization" | "everyone";
export type ShareDirectory = { groups: ShareGroup[]; people: SharePerson[]; people_scope: SharePeopleScope };
export type DraftRole = "owner" | "collaborator";

export type DraftSharing = {
  draft_id: string;
  owner: SharePerson;
  role: DraftRole;
  can_manage: boolean;
  matter_bound: boolean;
  groups: ShareGroup[];
  people: SharePerson[];
};

export type SharedDraftItem = {
  document: DraftDocument;
  owner: SharePerson;
  shared_via: "group" | "user";
  last_edited_at: string;
};

export type DraftShareSummary = { draft_id: string; group_count: number; people_count: number };

export type DraftLiveState = {
  draft_id: string;
  kind: DraftKind;
  seq: number;
  current_revision: number;
  title: string;
  content: string;
  content_sha256: string;
  updated_at: string;
  updated_by_user_id: string | null;
  updated_by_client: string | null;
};

export type DraftLiveResponse = { live: DraftLiveState; role: DraftRole; updated_by_name: string | null };

export type DraftVersionItem = {
  revision: number;
  title: string;
  created_at: string;
  content_sha256: string;
  author_user_id: string | null;
  author_name: string;
};

export type DraftVersionContent = { revision: DraftRevision; author_user_id: string | null; author_name: string };

export type PresenceFocus = { kind: "block" | "slide" | "cell"; ref: string };

export type DraftParticipant = {
  client_id: string;
  user_id: string;
  display_name: string;
  /** Index into the shared presence palette (0–7), the same for everyone. */
  color: number;
  focus: PresenceFocus | null;
};

export function getShareDirectory(userId: string, options: DraftRequestOptions = {}): Promise<ShareDirectory> {
  return apiRequest(userId, "/api/draft-sharing/directory", { signal: options.signal, headers: tenantHeaders(options.tenantSlug) });
}

export function listSharedWithMe(userId: string, options: DraftRequestOptions = {}): Promise<SharedDraftItem[]> {
  return apiRequest(userId, "/api/draft-sharing/shared-with-me", { signal: options.signal, headers: tenantHeaders(options.tenantSlug) });
}

export function listMySharedDrafts(userId: string, options: DraftRequestOptions = {}): Promise<DraftShareSummary[]> {
  return apiRequest(userId, "/api/draft-sharing/mine", { signal: options.signal, headers: tenantHeaders(options.tenantSlug) });
}

export function getDraftSharing(userId: string, draftId: string, options: DraftRequestOptions = {}): Promise<DraftSharing> {
  return apiRequest(userId, `/api/drafts/${pathId(draftId)}/sharing`, { signal: options.signal, headers: tenantHeaders(options.tenantSlug) });
}

export function putDraftSharing(
  userId: string,
  draftId: string,
  shares: { group_ids: string[]; user_ids: string[] },
  options: DraftRequestOptions = {},
): Promise<DraftSharing> {
  return apiRequest(userId, `/api/drafts/${pathId(draftId)}/sharing`, {
    method: "PUT",
    body: shares,
    signal: options.signal,
    headers: tenantHeaders(options.tenantSlug),
  });
}

export function getDraftLive(userId: string, draftId: string, options: DraftRequestOptions = {}): Promise<DraftLiveResponse> {
  return apiRequest(userId, `/api/drafts/${pathId(draftId)}/live`, { signal: options.signal, headers: tenantHeaders(options.tenantSlug) });
}

export type DraftLivePut =
  | { kind: "saved"; response: DraftLiveResponse }
  | { kind: "conflict"; response: DraftLiveResponse };

/** Autosave into the live copy. A 409 is an answer, not an error: it carries
 * the live copy someone else saved, which the caller merges into. */
export async function putDraftLive(
  userId: string,
  draftId: string,
  body: { expected_seq: number; client_id: string; content: string; title?: string },
  options: DraftRequestOptions = {},
): Promise<DraftLivePut> {
  const path = `/api/drafts/${pathId(draftId)}/live`;
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method: "PUT",
      headers: { ...tenantHeaders(options.tenantSlug), ...authHeaders(userId), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch {
    throw new ChatRequestError("Could not reach the API. Check your connection and try again.");
  }
  if (response.status === 409) {
    const payload = (await response.json().catch(() => null)) as DraftLiveResponse | null;
    if (payload?.live) return { kind: "conflict", response: payload };
  }
  if (!response.ok) throw new ChatRequestError(await readApiError(response), response.status);
  return { kind: "saved", response: (await response.json()) as DraftLiveResponse };
}

export function saveDraftLiveVersion(
  userId: string,
  draftId: string,
  clientId: string,
  options: DraftRequestOptions = {},
): Promise<DraftSnapshot> {
  return apiRequest(userId, `/api/drafts/${pathId(draftId)}/live/version`, {
    method: "POST",
    body: { client_id: clientId },
    signal: options.signal,
    headers: tenantHeaders(options.tenantSlug),
  });
}

export function putDraftPresence(
  userId: string,
  draftId: string,
  clientId: string,
  focus: PresenceFocus | null,
  options: DraftRequestOptions = {},
): Promise<void> {
  return apiRequest(userId, `/api/drafts/${pathId(draftId)}/live/presence`, {
    method: "PUT",
    body: { client_id: clientId, focus },
    signal: options.signal,
    headers: tenantHeaders(options.tenantSlug),
  });
}

export function listDraftVersions(userId: string, draftId: string, options: DraftRequestOptions = {}): Promise<DraftVersionItem[]> {
  return apiRequest(userId, `/api/drafts/${pathId(draftId)}/versions`, { signal: options.signal, headers: tenantHeaders(options.tenantSlug) });
}

export function getDraftVersion(
  userId: string,
  draftId: string,
  revision: number,
  options: DraftRequestOptions = {},
): Promise<DraftVersionContent> {
  return apiRequest(userId, `/api/drafts/${pathId(draftId)}/versions/${revision}`, {
    signal: options.signal,
    headers: tenantHeaders(options.tenantSlug),
  });
}

/* --------------------------------------------------------------- events */

export type DraftLiveEvent =
  | { event: "hello"; data: { client_id: string; role: DraftRole; seq: number; current_revision: number; participants: DraftParticipant[] } }
  | { event: "live"; data: { seq: number; current_revision: number; updated_by_user_id?: string | null; updated_by_client?: string | null } }
  | { event: "version"; data: { revision: number; current_revision: number; seq: number; author_user_id: string; updated_by_client: string | null } }
  | { event: "presence"; data: { participants: DraftParticipant[] } }
  | { event: "resync"; data: Record<string, never> }
  | { event: "access"; data: { state: "deleted" | "revoked" } };

const KNOWN_EVENTS = new Set(["hello", "live", "version", "presence", "resync", "access"]);

/** Splits an SSE byte stream into events; returns the unparsed remainder. */
export function parseSseChunk(buffer: string): { events: DraftLiveEvent[]; rest: string } {
  const frames = buffer.split(/\r?\n\r?\n/);
  const rest = frames.pop() ?? "";
  const events: DraftLiveEvent[] = [];
  for (const frame of frames) {
    let name = "";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!KNOWN_EVENTS.has(name) || !data.length) continue;
    try {
      events.push({ event: name, data: JSON.parse(data.join("\n")) } as DraftLiveEvent);
    } catch {
      // A malformed frame is skipped; the next live event or poll catches up.
    }
  }
  return { events, rest };
}

export type DraftEventStreamOptions = DraftRequestOptions & {
  onEvent(event: DraftLiveEvent): void;
  /** Connected (true) or waiting to reconnect (false). */
  onConnection?(connected: boolean): void;
};

const RECONNECT_STEPS_MS = [1000, 2000, 5000, 10000, 20000];

/** Delivers events; true once an `access` event ended the stream for good. */
function dispatchEvents(events: DraftLiveEvent[], onEvent: (event: DraftLiveEvent) => void): boolean {
  let ended = false;
  for (const event of events) {
    onEvent(event);
    ended ||= event.event === "access";
  }
  return ended;
}

/** Reads one open stream; true when the server ended access, false when the
 * connection dropped and should be reopened. */
async function readEventStream(body: ReadableStream<Uint8Array>, onEvent: (event: DraftLiveEvent) => void): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return false;
    const parsed = parseSseChunk(buffer + decoder.decode(value, { stream: true }));
    buffer = parsed.rest;
    if (dispatchEvents(parsed.events, onEvent)) {
      await reader.cancel().catch(() => {});
      return true;
    }
  }
}

type ConnectOutcome = "ended" | "dropped" | "reconnect";

async function connectOnce(url: string, headers: Record<string, string>, options: DraftEventStreamOptions): Promise<ConnectOutcome> {
  const response = await fetch(url, { headers, signal: options.signal });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    options.onEvent({ event: "access", data: { state: "revoked" } });
    return "ended";
  }
  if (!response.ok || !response.body) return "dropped";
  options.onConnection?.(true);
  return (await readEventStream(response.body, options.onEvent)) ? "ended" : "reconnect";
}

function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Keeps the draft's event stream open, reconnecting with backoff, until
 * `signal` aborts or the server ends access (an `access` event, or a 401,
 * 403, or 404 when reconnecting). Resolves when it stops for good.
 */
export async function followDraftEvents(
  userId: string,
  draftId: string,
  clientId: string,
  options: DraftEventStreamOptions,
): Promise<void> {
  const url = `${apiBase}/api/drafts/${pathId(draftId)}/live/events?client_id=${encodeURIComponent(clientId)}`;
  const headers = { ...tenantHeaders(options.tenantSlug), ...authHeaders(userId), Accept: "text/event-stream" };
  let failures = 0;
  while (!options.signal?.aborted) {
    const outcome = await connectOnce(url, headers, options).catch((): ConnectOutcome => "dropped");
    if (outcome === "ended" || options.signal?.aborted) return;
    if (outcome === "reconnect") failures = 0;
    options.onConnection?.(false);
    await waitOrAbort(RECONNECT_STEPS_MS[Math.min(failures, RECONNECT_STEPS_MS.length - 1)], options.signal);
    failures += 1;
  }
}
