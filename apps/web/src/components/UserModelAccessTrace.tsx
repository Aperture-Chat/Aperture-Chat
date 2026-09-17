import { Check, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { traceUserModelAccess } from "../lib/api";
import type { Group, UserModelAccessTrace as TraceResponse } from "../lib/types";
import { useModalFocus } from "../lib/useModalFocus";

const panelStyle: CSSProperties = {
  position: "fixed",
  top: "8vh",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 97,
  width: "min(760px, calc(100vw - 32px))",
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-lg)",
  overflow: "hidden",
};

/** Read-only per-user access trace: every catalog model with each gate's outcome. */
export function UserModelAccessTrace({
  actorUserId,
  targetUserId,
  targetName,
  groups,
  onClose,
}: {
  actorUserId: string;
  targetUserId: string;
  targetName: string;
  groups: Group[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useModalFocus(dialogRef, true, onClose);

  useEffect(() => {
    let active = true;
    setTrace(null);
    setError(null);
    traceUserModelAccess(actorUserId, targetUserId)
      .then((result) => {
        if (active) setTrace(result);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load the access trace.");
      });
    return () => {
      active = false;
    };
  }, [actorUserId, targetUserId]);

  const groupNames = (ids: string[]) =>
    ids.map((id) => groups.find((group) => group.id === id)?.name ?? id).join(", ") || "none";

  return (
    <>
      <button
        className="utility-backdrop"
        type="button"
        aria-label="Close model access trace"
        style={{ zIndex: 96, cursor: "default" }}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Model access trace for ${targetName}`}
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
            <strong>Model access trace: {targetName}</strong>
            <small>
              Groups: {trace ? groupNames(trace.group_ids) : "…"}. Every gate the policy evaluates, in order.
            </small>
          </span>
          <button className="icon-button" type="button" aria-label="Close trace dialog" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div style={{ overflowY: "auto", padding: "12px", display: "grid", gap: "8px" }}>
          {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
          {!trace && !error && <p role="status" style={{ margin: 0, color: "var(--muted)" }}>Evaluating…</p>}
          {trace && trace.entries.length === 0 && (
            <p role="status" style={{ margin: 0, color: "var(--muted)" }}>No models are enabled for this organization.</p>
          )}
          {trace?.entries.map((entry) => (
            <details
              key={entry.model.id}
              className="drawer-card"
              style={{ padding: "8px 12px" }}
              open={!entry.decision.usable}
            >
              <summary style={{ display: "flex", gap: "10px", alignItems: "center", cursor: "pointer" }}>
                <span className={`pill ${entry.decision.usable ? "pill-success" : entry.decision.allowed ? "pill-warning" : "pill-danger"}`}>
                  {entry.decision.usable ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}
                  {entry.decision.usable ? "Usable" : entry.decision.allowed ? "Allowed, provider offline" : "Blocked"}
                </span>
                <strong style={{ color: "var(--text-strong)" }}>{entry.model.name}</strong>
                <small style={{ color: "var(--muted)" }}>{entry.model.provider_name}</small>
              </summary>
              <p style={{ margin: "8px 0 6px", fontSize: "12.5px" }}>{entry.decision.reason}</p>
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: "4px" }}>
                {entry.decision.gates.map((gate) => (
                  <li key={gate.key} style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "12px" }}>
                    <span className={`pill ${gate.passed ? "pill-success" : "pill-danger"}`} style={{ minWidth: "160px", justifyContent: "flex-start" }}>
                      {gate.passed ? <Check size={11} aria-hidden="true" /> : <X size={11} aria-hidden="true" />} {gate.key}
                    </span>
                    <span style={{ color: "var(--muted)" }}>{gate.detail}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </div>
    </>
  );
}
