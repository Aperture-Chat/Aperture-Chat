import { Bot, Eye, MessageSquareText, UserRound, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { Role, UserPromptRecord } from "../lib/types";
import { Markdown } from "./Markdown";
import { Pill } from "./Primitives";

const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_OWNER: "Platform Owner",
  TENANT_ADMIN: "Admin",
  POWER_USER: "Power User",
  AUDITOR: "Auditor",
  AGENT_APPROVER: "Agent Approver",
  USER: "User",
};

function promptPreview(content: string, maxLength = 180) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function roleLabel(role?: Role) {
  return role ? ROLE_LABELS[role] : "User";
}

/** One generated image from a saved output, rendered for audit review. A
 * file the server no longer has gets an honest note, never a broken image. */
function AuditGeneratedImage({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span className="prompt-output-image-missing">
        A generated image in this output is no longer available on the server.
      </span>
    );
  }
  return (
    <a
      className="prompt-output-image-link"
      href={url}
      target="_blank"
      rel="noreferrer"
      data-tooltip="Open the full-size generated image"
    >
      <img
        src={url}
        alt="Generated image saved with this model output"
        loading="lazy"
        onError={() => setBroken(true)}
      />
    </a>
  );
}

export function PromptActivityList({
  records,
  ariaLabel,
  formatTimestamp,
}: {
  records: UserPromptRecord[];
  ariaLabel: string;
  formatTimestamp: (record: UserPromptRecord) => string;
}) {
  const [selected, setSelected] = useState<UserPromptRecord | null>(null);
  const titleId = useId();
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);

  const closePreview = () => {
    setSelected(null);
    window.setTimeout(() => lastTriggerRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePreview();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  const openPreview = (record: UserPromptRecord, event: MouseEvent<HTMLButtonElement>) => {
    lastTriggerRef.current = event.currentTarget;
    setSelected(record);
  };

  return (
    <>
      <div className="prompt-activity-list scrollable-log-list" role="list" aria-label={ariaLabel}>
        {records.map((record) => (
          <div className="prompt-activity-row" role="listitem" key={`${record.thread_id}:${record.id}`}>
            <button
              className="prompt-activity-trigger"
              type="button"
              aria-label={`Preview prompt and model output: ${record.thread_title}`}
              onClick={(event) => openPreview(record, event)}
            >
              <span className="prompt-activity-summary">
                <strong>{record.thread_title}</strong>
                <small>
                  {record.user_name || record.user_id} · {roleLabel(record.user_role)} · {record.model_id} · {formatTimestamp(record)}
                </small>
                <span>{promptPreview(record.content)}</span>
              </span>
              <span className="prompt-activity-row-actions">
                {record.alert_count > 0 && (
                  <Pill tone="warning">
                    {record.alert_count} active alert{record.alert_count === 1 ? "" : "s"}
                  </Pill>
                )}
                <span className="prompt-activity-preview-label" aria-hidden="true">
                  <Eye size={14} /> Preview
                </span>
              </span>
            </button>
          </div>
        ))}
      </div>

      {selected &&
        createPortal(
          <div className="modal-backdrop prompt-output-backdrop" role="presentation" onClick={closePreview}>
            <section
              className="modal prompt-output-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-head">
                <span className="modal-icon">
                  <MessageSquareText size={20} />
                </span>
                <div>
                  <h2 id={titleId}>Prompt and model output</h2>
                  <p>{selected.thread_title}</p>
                </div>
                <button
                  autoFocus
                  className="icon-button"
                  type="button"
                  aria-label="Close prompt and model output preview"
                  data-tooltip="Close preview"
                  onClick={closePreview}
                >
                  <X size={17} />
                </button>
              </div>

              <div className="prompt-output-meta" aria-label="Prompt audit metadata">
                <span><strong>User</strong>{selected.user_name || selected.user_id}</span>
                <span><strong>Role</strong>{roleLabel(selected.user_role)}</span>
                <span><strong>Model</strong>{selected.model_id}</span>
                <span><strong>Sent</strong>{formatTimestamp(selected)}</span>
              </div>

              <div className="prompt-output-dialog-body">
                <section className="prompt-output-message is-prompt" aria-label="User prompt">
                  <header>
                    <span><UserRound size={15} /> User prompt</span>
                  </header>
                  <div className="prompt-output-rendered">
                    <Markdown content={selected.content} />
                  </div>
                </section>

                <section className="prompt-output-message is-response" aria-label="Saved model output">
                  <header>
                    <span><Bot size={15} /> Model output</span>
                    {selected.response_status && <Pill tone={selected.response_status === "ok" ? "success" : "warning"}>{selected.response_status}</Pill>}
                  </header>
                  {selected.response_message_id || selected.response_content != null ? (
                    <>
                      <div className="prompt-output-rendered">
                        {selected.response_content ? (
                          // The audit view shows what the user saw: the same
                          // renderer chat uses, so markdown, tables, and
                          // diagrams read the way they were sent.
                          <Markdown content={selected.response_content} />
                        ) : (
                          <p className="prompt-output-plain">The saved model output was empty.</p>
                        )}
                      </div>
                      {(selected.response_images?.length ?? 0) > 0 && (
                        <div
                          className="prompt-output-images"
                          role="group"
                          aria-label="Generated images saved with this output"
                        >
                          {selected.response_images!.map((url) => (
                            <AuditGeneratedImage url={url} key={url} />
                          ))}
                        </div>
                      )}
                      {selected.response_truncated && (
                        <small className="prompt-output-truncated">
                          Preview limited to the first 12,000 saved characters.
                        </small>
                      )}
                    </>
                  ) : (
                    <div className="prompt-output-empty">
                      No saved model output is attached to this prompt. The request may have stopped before a response was persisted.
                    </div>
                  )}
                </section>
              </div>

              <footer className="modal-foot">
                <Eye size={14} /> This preview shows persisted text and saved generated images; it does not run the model again.
              </footer>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
