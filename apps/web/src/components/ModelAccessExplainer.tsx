import { Check, Lock, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ChatRequestError,
  createModelAccessRequest,
  loadModelCatalog,
  withdrawModelAccessRequest,
} from "../lib/api";
import type { ModelCatalogEntry } from "../lib/types";
import { useModalFocus } from "../lib/useModalFocus";

const panelStyle: CSSProperties = {
  position: "fixed",
  top: "10vh",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 97,
  width: "min(680px, calc(100vw - 32px))",
  maxHeight: "76vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-lg)",
  overflow: "hidden",
};

const groupLabelStyle: CSSProperties = {
  margin: "0 0 6px",
  fontSize: "11.5px",
  fontWeight: 800,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: "12px",
  alignItems: "start",
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface-soft)",
};

/**
 * "Models in your organization": every enabled model the person's tenant
 * exposes, with the server's reason when one is not usable and a real
 * request flow. Nothing here is inferred client-side; the API decides.
 */
export function ModelAccessExplainer({
  userId,
  onClose,
}: {
  userId: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [entries, setEntries] = useState<ModelCatalogEntry[] | null>(null);
  const [browsingEnabled, setBrowsingEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useModalFocus(dialogRef, true, onClose);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const catalog = await loadModelCatalog(userId, { signal });
      setEntries(catalog.entries);
      setBrowsingEnabled(catalog.browsing_enabled);
    } catch (caught) {
      // A superseded fetch (unmount or refresh) is not an error worth showing.
      if (signal?.aborted) return;
      setError(caught instanceof Error ? caught.message : "Could not load the model list.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const replaceEntry = (next: ModelCatalogEntry) => {
    setEntries((current) =>
      (current ?? []).map((entry) => (entry.model.id === next.model.id ? next : entry)),
    );
  };

  const requestAccess = async (entry: ModelCatalogEntry) => {
    setBusyModelId(entry.model.id);
    setNotice(null);
    try {
      const updated = await createModelAccessRequest(userId, { model_id: entry.model.id });
      replaceEntry(updated);
      setNotice(`Request sent for ${entry.model.name}. An administrator will review it.`);
    } catch (caught) {
      setNotice(caught instanceof ChatRequestError ? caught.message : "The request could not be sent.");
    } finally {
      setBusyModelId(null);
    }
  };

  const withdraw = async (entry: ModelCatalogEntry) => {
    if (!entry.open_request) return;
    setBusyModelId(entry.model.id);
    setNotice(null);
    try {
      await withdrawModelAccessRequest(userId, entry.open_request.id);
      replaceEntry({ ...entry, open_request: null });
      setNotice(`Withdrew the request for ${entry.model.name}.`);
    } catch (caught) {
      setNotice(caught instanceof ChatRequestError ? caught.message : "The request could not be withdrawn.");
    } finally {
      setBusyModelId(null);
    }
  };

  const usable = (entries ?? []).filter((entry) => entry.decision.usable);
  const unavailable = (entries ?? []).filter((entry) => !entry.decision.usable);

  return (
    <>
      <button
        className="utility-backdrop"
        type="button"
        aria-label="Close model access"
        style={{ zIndex: 96, cursor: "default" }}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Models in your organization"
        className="command-palette-panel"
        style={panelStyle}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="command-palette-heading">
          <span>
            <strong>Models in your organization</strong>
            <small>Why each model is or is not available to your account, straight from the server.</small>
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="Refresh model access"
            data-tooltip="Re-check model access with the server"
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} />
          </button>
          <button className="icon-button" type="button" aria-label="Close model access dialog" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div style={{ overflowY: "auto", padding: "12px", display: "grid", gap: "14px", minHeight: "96px" }}>
          {loading && <p role="status" style={{ margin: 0, color: "var(--muted)" }}>Checking model access…</p>}
          {error && <p role="alert" style={{ margin: 0, color: "var(--danger, #b42318)" }}>{error}</p>}
          {notice && <p role="status" style={{ margin: 0, color: "var(--text-strong)" }}>{notice}</p>}
          {!loading && !error && entries && entries.length === 0 && (
            <p role="status" style={{ margin: 0, color: "var(--muted)" }}>
              Your organization has not enabled any models yet.
            </p>
          )}
          {!browsingEnabled && !loading && (
            <p style={{ margin: 0, color: "var(--muted)", fontSize: "12.5px" }}>
              Your organization shows only the models you can already use. Ask an administrator about others.
            </p>
          )}
          {usable.length > 0 && (
            <section aria-label="Usable models">
              <p style={groupLabelStyle}>Usable now</p>
              <div style={{ display: "grid", gap: "6px" }}>
                {usable.map((entry) => (
                  <div key={entry.model.id} style={rowStyle}>
                    <span style={{ display: "grid", gap: "2px", minWidth: 0 }}>
                      <strong style={{ color: "var(--text-strong)" }}>{entry.model.name}</strong>
                      <small style={{ color: "var(--muted)" }}>{entry.model.provider_name}</small>
                    </span>
                    <span className="pill pill-success">
                      <Check size={12} aria-hidden="true" /> Available
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {unavailable.length > 0 && (
            <section aria-label="Models not available to you">
              <p style={groupLabelStyle}>Not available to you</p>
              <div style={{ display: "grid", gap: "6px" }}>
                {unavailable.map((entry) => {
                  const pending = entry.open_request?.status === "pending" ? entry.open_request : null;
                  const busy = busyModelId === entry.model.id;
                  return (
                    <div key={entry.model.id} style={rowStyle} data-model-id={entry.model.id}>
                      <span style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                        <strong style={{ color: "var(--text-strong)" }}>{entry.model.name}</strong>
                        <small style={{ color: "var(--muted)" }}>{entry.model.provider_name}</small>
                        <span style={{ fontSize: "12.5px", color: "var(--text)" }}>{entry.decision.reason}</span>
                        {pending && (
                          <small style={{ color: "var(--muted)" }}>
                            Request pending since {new Date(pending.created_at).toLocaleDateString()}.
                          </small>
                        )}
                      </span>
                      <span style={{ display: "grid", gap: "6px", justifyItems: "end" }}>
                        <span className={`pill ${entry.decision.allowed ? "pill-warning" : "pill-info"}`}>
                          <Lock size={12} aria-hidden="true" /> {entry.decision.allowed ? "Provider offline" : "Locked"}
                        </span>
                        {pending ? (
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={busy}
                            onClick={() => void withdraw(entry)}
                          >
                            Withdraw request
                          </button>
                        ) : entry.decision.requestable ? (
                          <button
                            className="primary-button"
                            type="button"
                            disabled={busy}
                            onClick={() => void requestAccess(entry)}
                          >
                            Request access
                          </button>
                        ) : (
                          <button
                            className="secondary-button"
                            type="button"
                            disabled
                            data-tooltip={
                              entry.decision.allowed
                                ? "You already have access; the provider needs to be reconnected by the platform owner."
                                : "This restriction cannot be lifted by a request."
                            }
                          >
                            Request access
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
