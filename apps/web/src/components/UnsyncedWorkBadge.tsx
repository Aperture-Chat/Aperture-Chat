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

type CachedDraft = DraftSyncFields & { id: string; title?: string; updatedAt?: string };

function isCachedDraft(value: unknown): value is CachedDraft {
  return Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

export type UnsyncedWorkSummary = {
  threads: { id: string; title: string }[];
  drafts: CachedDraft[];
  legacyCount: number;
  total: number;
};

export function summarizeUnsyncedWork(
  chat: Pick<ChatStore, "threads">,
  scope: DraftCacheScope,
): UnsyncedWorkSummary {
  const threads = chat.threads
    .filter((thread) => thread.syncPending && thread.messages.length > 0)
    .map((thread) => ({ id: thread.id, title: thread.title || "Untitled chat" }));
  const drafts = unsyncedDraftEntries(loadScopedDraftCache<CachedDraft>(scope, isCachedDraft)).filter(
    // Running/failed provider runs and empty placeholders are not user work.
    (entry) => entry.title !== undefined,
  );
  const legacyCount = loadLegacyDraftHistory(isCachedDraft).length;
  return { threads, drafts, legacyCount, total: threads.length + drafts.length + legacyCount };
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
  const [summary, setSummary] = useState<UnsyncedWorkSummary>(() => summarizeUnsyncedWork(chat, scope));
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(dialogRef, open, () => setOpen(false));

  const refresh = useCallback(() => setSummary(summarizeUnsyncedWork(chat, scope)), [chat, scope]);

  useEffect(() => {
    refresh();
  }, [refresh, chat.threads, chat.unsyncedThreadCount]);

  useEffect(() => {
    window.addEventListener(DOCUMENT_HISTORY_UPDATED_EVENT, refresh);
    window.addEventListener(CHAT_SYNC_UPDATED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(DOCUMENT_HISTORY_UPDATED_EVENT, refresh);
      window.removeEventListener(CHAT_SYNC_UPDATED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [refresh]);

  if (summary.total === 0) return null;

  const label = `${summary.total} ${summary.total === 1 ? "item" : "items"} only on this device`;

  return (
    <>
      <button
        type="button"
        className="minor-row unsynced-work-badge"
        aria-label={label}
        data-tooltip="Work that has not reached your account yet. Open to retry or import."
        onClick={() => setOpen(true)}
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
                <small>These items have not been saved to your account. Nothing here is uploaded without you.</small>
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
                    Open the draft in Drafts and use Retry on its save badge; pending saves resume automatically.
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
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
