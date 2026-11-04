/**
 * React glue for shared drafts: loads who a draft is shared with, and while
 * it is shared keeps a DraftLiveSession and the live event stream open for
 * the draft in the editor.
 *
 * A draft goes live when its owner has shared it, or when the person
 * opening it is a collaborator. Private drafts keep the classic flow
 * (explicit "Save version" only), unchanged.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  followDraftEvents,
  getDraftLive,
  getDraftSharing,
  putDraftLive,
  putDraftPresence,
  putDraftSharing,
  saveDraftLiveVersion,
  type DraftLiveEvent,
  type DraftLiveResponse,
  type DraftParticipant,
  type DraftSharing,
  type PresenceFocus,
} from "./api/draftCollab";
import type { DraftKind, DraftSnapshot } from "./api/drafts";
import { isDraftConflictError } from "./api/drafts";
import { mergeDraftContent } from "./draftMerge";
import {
  DraftLiveSession,
  type LiveDoc,
  type LiveHooks,
  type LiveRemoteChange,
  type LiveServerState,
  type LiveStatus,
  type LiveTransport,
} from "./draftLiveSession";

export type CollabTarget = { id: string; kind: DraftKind };

/** How the workspace reads and writes the editor for the live session. */
export type CollabAdapter = {
  /** Which server draft the editor shows right now (null: none). */
  showing(): CollabTarget | null;
  read(): LiveDoc;
  normalize(content: string): string;
  apply(doc: LiveDoc, change: LiveRemoteChange): void;
};

export type VersionNotice = { revision: number; authorUserId: string; byThisEditor: boolean };

export type RemoteChangeNotice = LiveRemoteChange & { at: number };

export type DraftCollaboration = {
  clientId: string;
  sharing: DraftSharing | null;
  /** The live session is running for the draft in the editor. */
  live: boolean;
  status: LiveStatus | null;
  /** Everyone with the draft open, this person's other tabs included. */
  participants: DraftParticipant[];
  lastRemoteChange: RemoteChangeNotice | null;
  accessLost: "deleted" | "revoked" | null;
  updateSharing(shares: { group_ids: string[]; user_ids: string[] }): Promise<DraftSharing>;
  reloadSharing(): void;
  noteLocalChange(): void;
  /** Resolves once the server holds what the editor shows. */
  flush(): Promise<void>;
  hasUnsavedChanges(): boolean;
  /** Save the live copy as the next numbered version. */
  saveVersion(): Promise<DraftSnapshot>;
  setFocus(focus: PresenceFocus | null): void;
};

type RequestScope = { userId: string; tenantSlug?: string; signal?: AbortSignal };

const SAVE_VERSION_ATTEMPTS = 3;

function newClientId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto?.getRandomValues?.(bytes);
  return `c${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function liveServerState(response: DraftLiveResponse): LiveServerState {
  const live = response.live;
  return {
    seq: live.seq,
    currentRevision: live.current_revision,
    title: live.title,
    content: live.content,
    updatedByUserId: live.updated_by_user_id,
    updatedByClient: live.updated_by_client,
    updatedByName: response.updated_by_name,
  };
}

/** A draft is live once shared, and always for a collaborator. */
export function isLiveSharing(sharing: DraftSharing | null, draftId: string | null): boolean {
  if (!sharing || !draftId || sharing.draft_id !== draftId) return false;
  return sharing.role === "collaborator" || sharing.groups.length > 0 || sharing.people.length > 0;
}

function targetKeyOf(target: CollabTarget | null): string {
  return target ? `${target.kind}:${target.id}` : "";
}

function targetFromKey(key: string): CollabTarget | null {
  const split = key.indexOf(":");
  return split > 0 ? { kind: key.slice(0, split) as DraftKind, id: key.slice(split + 1) } : null;
}

function sameTarget(left: CollabTarget | null, right: CollabTarget | null): boolean {
  return left?.id === right?.id && left?.kind === right?.kind;
}

function liveTransport(scope: RequestScope, draftId: string, clientId: string): LiveTransport {
  const options = { tenantSlug: scope.tenantSlug, signal: scope.signal };
  return {
    fetch: async () => liveServerState(await getDraftLive(scope.userId, draftId, options)),
    put: async ({ expectedSeq, title, content }) => {
      const result = await putDraftLive(
        scope.userId,
        draftId,
        { expected_seq: expectedSeq, client_id: clientId, title, content },
        options,
      );
      return { kind: result.kind, state: liveServerState(result.response) };
    },
  };
}

/** Session hooks that refuse to read or write once the editor shows another draft. */
function guardedHooks(
  adapter: { current: CollabAdapter },
  target: CollabTarget,
  onStatus: (status: LiveStatus) => void,
  onRemoteChange: (change: LiveRemoteChange) => void,
): LiveHooks {
  const stillShowing = () => sameTarget(adapter.current.showing(), target);
  return {
    read: () => {
      if (!stillShowing()) throw new Error("The editor moved to another draft.");
      return adapter.current.read();
    },
    normalize: (content) => adapter.current.normalize(content),
    merge: (base, ours, theirs) => mergeDraftContent(target.kind, base, ours, theirs),
    apply: (doc, change) => {
      if (!stillShowing()) return;
      adapter.current.apply(doc, change);
      onRemoteChange(change);
    },
    status: onStatus,
  };
}

/** Joins with retries: until the first fetch lands there is nothing to merge
 * against, so autosave waits rather than guessing. */
async function joinLive(
  session: DraftLiveSession,
  adapter: { current: CollabAdapter },
  target: CollabTarget,
  signal: AbortSignal,
  onStatus: (status: LiveStatus) => void,
): Promise<boolean> {
  for (let attempt = 0; !signal.aborted; attempt += 1) {
    if (!sameTarget(adapter.current.showing(), target)) return false;
    try {
      await session.start(adapter.current.read());
      return true;
    } catch {
      onStatus({ kind: "offline", message: "Connecting to the shared draft…", retryInMs: 2000 });
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(15000, 2000 * (attempt + 1))));
    }
  }
  return false;
}

type LiveEventCallbacks = {
  onParticipants(participants: DraftParticipant[]): void;
  onVersion(notice: VersionNotice): void;
  onAccessLost(state: "deleted" | "revoked"): void;
};

/** What each event-stream message means for the session and the screen. */
export function liveEventHandler(
  session: Pick<DraftLiveSession, "remoteSaved" | "stop" | "seq">,
  clientId: string,
  callbacks: LiveEventCallbacks,
): (event: DraftLiveEvent) => void {
  return (event) => {
    switch (event.event) {
      case "hello":
        callbacks.onParticipants(event.data.participants);
        session.remoteSaved(event.data.seq);
        return;
      case "presence":
        callbacks.onParticipants(event.data.participants);
        return;
      case "live":
        if (event.data.updated_by_client !== clientId) session.remoteSaved(event.data.seq);
        return;
      case "version":
        session.remoteSaved(event.data.seq);
        callbacks.onVersion({
          revision: event.data.revision,
          authorUserId: event.data.author_user_id,
          byThisEditor: event.data.updated_by_client === clientId,
        });
        return;
      case "resync":
        session.remoteSaved(session.seq + 1);
        return;
      case "access":
        session.stop();
        callbacks.onAccessLost(event.data.state);
    }
  };
}

type LiveSessionHandlers = LiveEventCallbacks & {
  onStatus(status: LiveStatus): void;
  onRemoteChange(change: LiveRemoteChange): void;
};

/** Starts the live session and its event stream; returns the stop function. */
function startLiveSession(
  scope: Omit<RequestScope, "signal">,
  target: CollabTarget,
  clientId: string,
  adapter: { current: CollabAdapter },
  handlers: LiveSessionHandlers,
): { session: DraftLiveSession; stop(): void } {
  const controller = new AbortController();
  const requestScope = { ...scope, signal: controller.signal };
  const session = new DraftLiveSession(
    liveTransport(requestScope, target.id, clientId),
    guardedHooks(adapter, target, handlers.onStatus, handlers.onRemoteChange),
  );
  void (async () => {
    if (!(await joinLive(session, adapter, target, controller.signal, handlers.onStatus))) return;
    await followDraftEvents(scope.userId, target.id, clientId, {
      tenantSlug: scope.tenantSlug,
      signal: controller.signal,
      onEvent: liveEventHandler(session, clientId, handlers),
    });
  })();
  return {
    session,
    stop: () => {
      controller.abort();
      session.stop();
    },
  };
}

/** Saves a version, retrying when someone saved the live copy meanwhile. */
async function saveVersionWithRetry(
  session: DraftLiveSession | null,
  scope: Omit<RequestScope, "signal">,
  draftId: string,
  clientId: string,
): Promise<DraftSnapshot> {
  for (let attempt = 1; ; attempt += 1) {
    await session?.flush();
    try {
      return await saveDraftLiveVersion(scope.userId, draftId, clientId, { tenantSlug: scope.tenantSlug });
    } catch (error) {
      if (!isDraftConflictError(error) || attempt >= SAVE_VERSION_ATTEMPTS) throw error;
    }
  }
}

function useDraftSharing(userId: string, tenantSlug: string | undefined, targetId: string | null) {
  const [sharing, setSharing] = useState<DraftSharing | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    setSharing(null);
    if (!targetId) return undefined;
    const controller = new AbortController();
    getDraftSharing(userId, targetId, { tenantSlug, signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setSharing(next);
      })
      .catch(() => {
        // A draft this person cannot share (or an older server) stays private.
      });
    return () => controller.abort();
  }, [userId, tenantSlug, targetId, nonce]);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { sharing, setSharing, reload };
}

export function useDraftCollaboration(options: {
  userId: string;
  tenantSlug?: string;
  target: CollabTarget | null;
  adapter: { current: CollabAdapter };
  onVersionSaved?(notice: VersionNotice): void;
}): DraftCollaboration {
  const { userId, tenantSlug, target, adapter } = options;
  const clientId = useMemo(newClientId, []);
  const targetId = target?.id ?? null;
  const { sharing, setSharing, reload: reloadSharing } = useDraftSharing(userId, tenantSlug, targetId);
  const liveState = useLiveSession({
    shared: isLiveSharing(sharing, targetId),
    scope: { userId, tenantSlug },
    target,
    clientId,
    adapter,
    onVersionSaved: options.onVersionSaved,
  });
  const { live, sessionRef, accessLost } = liveState;
  const controls = useSessionControls(sessionRef);
  const saveVersion = useCallback(() => {
    if (!targetId) return Promise.reject(new Error("This draft is not saved to your account yet."));
    return saveVersionWithRetry(sessionRef.current, { userId, tenantSlug }, targetId, clientId);
  }, [targetId, userId, clientId, tenantSlug]);
  const updateSharing = useCallback(
    async (shares: { group_ids: string[]; user_ids: string[] }) => {
      if (!targetId) throw new Error("Save this draft to your account before sharing it.");
      const next = await putDraftSharing(userId, targetId, shares, { tenantSlug });
      setSharing(next);
      return next;
    },
    [targetId, userId, tenantSlug, setSharing],
  );
  const setFocus = usePresenceFocus(live, { userId, tenantSlug }, targetId, clientId);
  const shown = live ? liveState.shown : NOT_LIVE;

  return {
    clientId,
    sharing,
    live,
    ...shown,
    accessLost,
    updateSharing,
    reloadSharing,
    ...controls,
    saveVersion,
    setFocus,
  };
}

const NOT_LIVE = { status: null, participants: [], lastRemoteChange: null };

/** Starts the session for `active` (the shared draft in the editor) and
 * stops it when that changes. Handlers may change identity every render. */
function useSessionEffect(
  active: CollabTarget | null,
  options: { scope: Omit<RequestScope, "signal">; clientId: string; adapter: { current: CollabAdapter } },
  sessionRef: { current: DraftLiveSession | null },
  handlers: LiveSessionHandlers,
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const { scope, clientId, adapter } = options;
  const { userId, tenantSlug } = scope;
  useEffect(() => {
    if (!active) return undefined;
    const relay: LiveSessionHandlers = {
      onStatus: (status) => handlersRef.current.onStatus(status),
      onRemoteChange: (change) => handlersRef.current.onRemoteChange(change),
      onParticipants: (people) => handlersRef.current.onParticipants(people),
      onVersion: (notice) => handlersRef.current.onVersion(notice),
      onAccessLost: (state) => handlersRef.current.onAccessLost(state),
    };
    const running = startLiveSession({ userId, tenantSlug }, active, clientId, adapter, relay);
    sessionRef.current = running.session;
    return () => {
      running.stop();
      sessionRef.current = null;
      relay.onParticipants([]);
    };
  }, [active, userId, tenantSlug, clientId, adapter, sessionRef]);
}

/** Runs the live session while the draft is shared and access holds. */
function useLiveSession(options: {
  shared: boolean;
  scope: Omit<RequestScope, "signal">;
  target: CollabTarget | null;
  clientId: string;
  adapter: { current: CollabAdapter };
  onVersionSaved?(notice: VersionNotice): void;
}) {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [participants, setParticipants] = useState<DraftParticipant[]>([]);
  const [lastRemoteChange, setLastRemoteChange] = useState<RemoteChangeNotice | null>(null);
  const [accessLost, setAccessLost] = useState<DraftCollaboration["accessLost"]>(null);
  const sessionRef = useRef<DraftLiveSession | null>(null);
  const onVersionSavedRef = useRef(options.onVersionSaved);
  onVersionSavedRef.current = options.onVersionSaved;
  const targetKey = targetKeyOf(options.target);
  useEffect(() => {
    setAccessLost(null);
    setStatus(null);
  }, [targetKey]);
  const live = options.shared && accessLost === null;
  // Keyed by kind and id, so a re-render with an equal target never restarts it.
  const active = useMemo(() => (live ? targetFromKey(targetKey) : null), [live, targetKey]);
  useSessionEffect(active, options, sessionRef, {
    onStatus: setStatus,
    onRemoteChange: (change) => setLastRemoteChange({ ...change, at: Date.now() }),
    onParticipants: setParticipants,
    onVersion: (notice) => onVersionSavedRef.current?.(notice),
    onAccessLost: setAccessLost,
  });
  return { live, sessionRef, accessLost, shown: { status, participants, lastRemoteChange } };
}

/** Stable controls for whichever live session is running now, if any. */
function useSessionControls(sessionRef: { current: DraftLiveSession | null }) {
  return useMemo(
    () => ({
      noteLocalChange: () => sessionRef.current?.noteLocalChange(),
      flush: async () => {
        await sessionRef.current?.flush();
      },
      hasUnsavedChanges: () => {
        try {
          return sessionRef.current?.hasUnsavedChanges() ?? false;
        } catch {
          return false;
        }
      },
    }),
    [sessionRef],
  );
}

function usePresenceFocus(
  live: boolean,
  scope: Omit<RequestScope, "signal">,
  targetId: string | null,
  clientId: string,
): (focus: PresenceFocus | null) => void {
  const lastFocusRef = useRef("");
  const { userId, tenantSlug } = scope;
  return useCallback(
    (focus: PresenceFocus | null) => {
      const key = focus ? `${focus.kind}:${focus.ref}` : "";
      if (!live || !targetId || key === lastFocusRef.current) return;
      lastFocusRef.current = key;
      void putDraftPresence(userId, targetId, clientId, focus, { tenantSlug }).catch(() => {
        // Presence is a courtesy; a missed update is replaced by the next one.
      });
    },
    [live, targetId, userId, clientId, tenantSlug],
  );
}
