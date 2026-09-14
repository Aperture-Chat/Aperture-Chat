import { CloudOff, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CHAT_SYNC_UPDATED_EVENT, type ChatStore } from "../lib/chatStore";
import {
  loadLegacyDraftHistory,
  loadScopedDraftCache,
  unsyncedDraftEntries,
  type DraftCacheScope,
  type DraftSyncFields,
} from "../lib/draftServerSync";
import { useModalFocus } from "../lib/useModalFocus";

/** Fired by the Drafts workspace whenever the scoped draft cache changes. */
const DOCUMENT_HISTORY_UPDATED_EVENT = "aperture-document-history-updated";

type CachedDraft = DraftSyncFields & { id: string; title?: string; updatedAt?: string; content?: unknown };

function isCachedDraft(value: unknown): value is CachedDraft {
  return Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

type ReminderPreferences = { hidden: boolean; cleared: string[] };
const REMINDERS_UPDATED_EVENT = "aperture-work-reminders-updated";
function reminderKey(scope: DraftCacheScope) {
  return `aperture-work-reminders-v1:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.userId)}`;
}
function readPreferences(scope: DraftCacheScope): ReminderPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(reminderKey(scope)) || "null");
    return { hidden: value?.hidden === true, cleared: Array.isArray(value?.cleared) ? value.cleared.filter((key: unknown) => typeof key === "string") : [] };
  } catch {
    return { hidden: false, cleared: [] };
  }
}
// Keep only small content fingerprints in reminder preferences, never draft text.
// Sync timestamps/bookkeeping do not make dismissed work appear again.
function fingerprint(kind: string, id: string, content: unknown): string {
  const text = JSON.stringify(content);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `${kind}:${id}:${text.length}:${hash >>> 0}`;
}
function draftFingerprint(kind: string, draft: CachedDraft) {
  return fingerprint(kind, draft.id, [draft.title, draft.kind, draft.content ?? draft.updatedAt]);
}

export type UnsyncedWorkSummary = {
  threads: { id: string; title: string }[];
  drafts: CachedDraft[];
  legacyCount: number;
  total: number;
  reminders: string[];
};

export function summarizeUnsyncedWork(
  chat: Pick<ChatStore, "threads">,
  scope: DraftCacheScope,
  cleared: string[] = [],
): UnsyncedWorkSummary {
  const dismissed = new Set(cleared);
  const reminders: string[] = [];
  const visible = (key: string) => {
    if (dismissed.has(key)) return false;
    reminders.push(key);
    return true;
  };
  const threads = chat.threads
    .filter((thread) => thread.syncPending && thread.messages.length > 0)
    .filter((thread) => visible(fingerprint("chat", thread.id, [thread.title, thread.messages.map(message => [message.id, message.role, message.content, message.attachments])])))
    .map((thread) => ({ id: thread.id, title: thread.title || "Untitled chat" }));
  const drafts = unsyncedDraftEntries(loadScopedDraftCache<CachedDraft>(scope, isCachedDraft)).filter(
    // Running/failed provider runs and empty placeholders are not user work.
    (entry) => entry.title !== undefined && !entry.archived,
  ).filter((draft) => visible(draftFingerprint("draft", draft)));
  const legacyCount = loadLegacyDraftHistory(isCachedDraft).filter((draft) => visible(draftFingerprint("legacy", draft))).length;
  return { threads, drafts, legacyCount, total: threads.length + drafts.length + legacyCount, reminders };
}

const panelStyle: CSSProperties = {
  position: "fixed",
  top: "14vh",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 97,
  width: "min(560px, calc(100vw - 32px))",
  maxHeight: "70vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-lg)",
  overflow: "hidden",
};

/**
 * Rail badge for work that exists only in this browser: chat threads whose
 * last save failed, drafts and decks never uploaded or edited since their
 * last acknowledged save, and quarantined legacy draft history. Hidden when
 * there is nothing to report; every count comes from real local state.
 */
export function UnsyncedWorkBadge({
  chat,
  scope,
  onOpenDrafts,
  collapsed = false,
}: {
  chat: Pick<ChatStore, "threads" | "unsyncedThreadCount" | "retryUnsyncedThreads">;
  scope: DraftCacheScope;
  onOpenDrafts: () => void;
  collapsed?: boolean;
}) {
  const [preferences, setPreferences] = useState(() => readPreferences(scope));
  const [summary, setSummary] = useState<UnsyncedWorkSummary>(() => summarizeUnsyncedWork(chat, scope, readPreferences(scope).cleared));
  const [preferenceError, setPreferenceError] = useState("");
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(dialogRef, open && !preferences.hidden && summary.total > 0, () => setOpen(false));

  const refresh = useCallback(() => {
    const next = readPreferences(scope);
    setPreferences(next);
    const nextSummary = summarizeUnsyncedWork(chat, scope, next.cleared);
    setSummary(nextSummary);
    if (next.hidden || nextSummary.total === 0) setOpen(false);
  }, [chat, scope]);

  function dismiss(hide: boolean) {
    const current = readPreferences(scope);
    const next = { hidden: hide || current.hidden, cleared: [...new Set([...current.cleared, ...summary.reminders])] };
    try {
      localStorage.setItem(reminderKey(scope), JSON.stringify(next));
      setOpen(false);
      refresh();
      window.dispatchEvent(new Event(REMINDERS_UPDATED_EVENT));
    } catch {
      setPreferenceError("Your browser could not save this preference. Please try again.");
    }
  }

  useEffect(() => {
    refresh();
  }, [refresh, chat.threads, chat.unsyncedThreadCount]);

  useEffect(() => {
    window.addEventListener(DOCUMENT_HISTORY_UPDATED_EVENT, refresh);
    window.addEventListener(CHAT_SYNC_UPDATED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener(REMINDERS_UPDATED_EVENT, refresh);
    return () => {
      window.removeEventListener(DOCUMENT_HISTORY_UPDATED_EVENT, refresh);
      window.removeEventListener(CHAT_SYNC_UPDATED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener(REMINDERS_UPDATED_EVENT, refresh);
    };
  }, [refresh]);

  if (preferences.hidden || summary.total === 0) return null;

  const label = `${summary.total} ${summary.total === 1 ? "item" : "items"} only on this device`;

  return (
    <>
      <button
        type="button"
        className="minor-row unsynced-work-badge"
        aria-label={label}
        data-tooltip="Work that has not reached your account yet. Open to review or clear reminders."
        onClick={() => { setPreferenceError(""); setOpen(true); }}
      >
        <CloudOff size={16} aria-hidden="true" />
        {!collapsed && <span>{label}</span>}
      </button>
      {/* Escape the sidebar stacking context so the modal covers the workspace. */}
      {open && createPortal(
        <>
          <button
            className="utility-backdrop"
            type="button"
            aria-label="Close unsynced work"
            style={{ zIndex: 96, cursor: "default" }}
            onClick={() => setOpen(false)}
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Only on this device"
            className="command-palette-panel"
            style={panelStyle}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
              }
            }}
          >
            <div className="command-palette-heading">
              <span>
                <strong>Only on this device</strong>
                <small>These items have changes kept in this browser that have not reached your account yet.</small>
              </span>
              <button className="icon-button" type="button" aria-label="Close unsynced work dialog" onClick={() => setOpen(false)}>
                <X size={17} />
              </button>
            </div>
            <div style={{ overflowY: "auto", padding: "12px", display: "grid", gap: "14px" }}>
              {summary.threads.length > 0 && (
                <section aria-label="Chats with unsaved messages" style={{ display: "grid", gap: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                    <strong style={{ fontSize: "12.5px" }}>Chats whose last save failed</strong>
                    <button
                      className="secondary-button compact"
                      type="button"
                      disabled={retrying}
                      onClick={async () => {
                        setRetrying(true);
                        try {
                          await chat.retryUnsyncedThreads();
                        } finally {
                          setRetrying(false);
                          refresh();
                        }
                      }}
                    >
                      <RefreshCw size={14} /> Retry all
                    </button>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12.5px" }}>
                    {summary.threads.map((thread) => (
                      <li key={thread.id}>{thread.title}</li>
                    ))}
                  </ul>
                </section>
              )}
              {summary.drafts.length > 0 && (
                <section aria-label="Drafts not saved to your account" style={{ display: "grid", gap: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                    <strong style={{ fontSize: "12.5px" }}>Drafts and decks with unsent changes</strong>
                    <button className="secondary-button compact" type="button" onClick={() => { setOpen(false); onOpenDrafts(); }}>
                      Open Drafts
                    </button>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12.5px" }}>
                    {summary.drafts.map((draft) => (
                      <li key={draft.id}>
                        {draft.title || "Untitled draft"}
                        {draft.kind === "deck" ? " (deck)" : ""}
                        {draft.serverId ? " — local changes pending" : " — never uploaded"}
                      </li>
                    ))}
                  </ul>
                  <small style={{ color: "var(--muted)" }}>
                    Open a draft to save it to your account. Archiving finished work also removes it from this list.
                  </small>
                </section>
              )}
              {summary.legacyCount > 0 && (
                <section aria-label="Legacy browser history" style={{ display: "grid", gap: "6px" }}>
                  <strong style={{ fontSize: "12.5px" }}>
                    {summary.legacyCount} older {summary.legacyCount === 1 ? "draft" : "drafts"} from before account sync
                  </strong>
                  <small style={{ color: "var(--muted)" }}>
                    Kept quarantined in this browser. Import each one explicitly from Drafts › Draft history to upload it to your account.
                  </small>
                  <button className="secondary-button compact" type="button" style={{ justifySelf: "start" }} onClick={() => { setOpen(false); onOpenDrafts(); }}>
                    Open Drafts
                  </button>
                </section>
              )}
            </div>
            <div className="unsynced-work-footer">
              <small>Clear list dismisses these reminders without deleting or uploading work. New edits may appear again. Applies to this account in this browser.</small>
              {preferenceError && <small role="alert">{preferenceError}</small>}
              <div className="unsynced-work-actions">
                <button className="secondary-button compact" type="button" onClick={() => dismiss(false)}>Clear list</button>
                <button className="secondary-button compact" type="button" onClick={() => dismiss(true)}>Hide this reminder</button>
              </div>
              <small>Hide this reminder turns off the sidebar notice. Save status remains available in Drafts and chats.</small>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
