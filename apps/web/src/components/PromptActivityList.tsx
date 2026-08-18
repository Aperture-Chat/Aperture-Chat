import { Bot, Eye, MessageSquareText, ThumbsDown, ThumbsUp, UserRound, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { ChatFeedbackRating, Role, UserPromptRecord } from "../lib/types";
import { Markdown } from "./Markdown";
import { Pill } from "./Primitives";

const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_OWNER: "Platform Owner",
  TENANT_ADMIN: "Admin",
  TEMP_USER: "Temp User",
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

/** Chronological position of a record inside its thread; records without a
 * parseable timestamp keep their server order at the front. */
function recordSortValue(record: UserPromptRecord) {
  const parsed = Date.parse(record.created_at_iso ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
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
  loadThreadRecords,
  extraThreadSearchText,
}: {
  records: UserPromptRecord[];
  ariaLabel: string;
  formatTimestamp: (record: UserPromptRecord) => string;
  /** Fetches every saved exchange of one thread so the preview can show the
   * whole conversation even when the activity list only holds a recent
   * window. Without it, the preview falls back to the exchanges in view. */
  loadThreadRecords?: (
    threadId: string,
  ) => Promise<UserPromptRecord[] | void> | UserPromptRecord[] | void;
  /** Extra searchable text per thread id (matter labels, retention tags), so
   * a phrase search can find prompts by client/matter number even though the
   * records themselves only carry chat text. */
  extraThreadSearchText?: Record<string, string>;
}) {
  const [selected, setSelected] = useState<UserPromptRecord | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [threadRecords, setThreadRecords] = useState<UserPromptRecord[] | null>(null);
  const [threadLoadFailed, setThreadLoadFailed] = useState(false);
  const titleId = useId();
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const selectedExchangeRef = useRef<HTMLElement | null>(null);
  // The loader identity can change every render (inline console closures);
  // reading it through a ref keeps the fetch effect keyed on the selection.
  const loadThreadRecordsRef = useRef(loadThreadRecords);
  loadThreadRecordsRef.current = loadThreadRecords;

  const closePreview = () => {
    setSelected(null);
    setThreadRecords(null);
    setThreadLoadFailed(false);
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

  // Pulls the clicked thread's complete history. The already-listed
  // exchanges render immediately; this fills in turns that fell outside
  // the activity list's newest-first window.
  useEffect(() => {
    if (!selected) return;
    const loader = loadThreadRecordsRef.current;
    if (!loader) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => loader(selected.thread_id))
      .then((full) => {
        if (!cancelled && Array.isArray(full)) setThreadRecords(full);
      })
      .catch(() => {
        if (!cancelled) setThreadLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const conversation = useMemo(() => {
    if (!selected) return [];
    const source = (threadRecords ?? records).filter(
      (record) => record.thread_id === selected.thread_id,
    );
    // The clicked record always shows, even if a refresh dropped it.
    const base = source.some((record) => record.id === selected.id)
      ? source
      : [...source, selected];
    // The API returns newest-first; flip to read the chat top-down, then a
    // stable timestamp sort guards against any out-of-order rows.
    return [...base].reverse().sort((a, b) => recordSortValue(a) - recordSortValue(b));
  }, [records, selected, threadRecords]);

  // Lands the auditor on the exchange they clicked once the modal renders.
  useEffect(() => {
    if (!selected) return;
    selectedExchangeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected, conversation]);

  const openPreview = (record: UserPromptRecord, event: MouseEvent<HTMLButtonElement>) => {
    lastTriggerRef.current = event.currentTarget;
    setThreadRecords(null);
    setThreadLoadFailed(false);
    setSelected(record);
  };

  const loadingFullThread =
    Boolean(loadThreadRecords) && threadRecords === null && !threadLoadFailed;

  const visibleRecords = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return records;
    return records.filter((record) => {
      const haystack = [
        record.thread_title,
        record.content,
        record.response_content ?? "",
        record.user_name,
        record.user_email,
        record.user_id,
        record.model_id,
        record.thread_id,
        extraThreadSearchText?.[record.thread_id] ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [extraThreadSearchText, records, searchQuery]);

  return (
    <>
      <div className="prompt-activity-search">
        <input
          type="search"
          className="retention-tag-search"
          placeholder="Search prompts, outputs, people, tags, or client/matter numbers"
          aria-label="Search prompt activity"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        {searchQuery.trim() && (
          <span className="retention-tags-count">
            {visibleRecords.length} of {records.length} prompts
          </span>
        )}
      </div>
      {visibleRecords.length === 0 && searchQuery.trim() ? (
        <p className="retention-filter-empty">No prompts match this search.</p>
      ) : (
      <div className="prompt-activity-list scrollable-log-list" role="list" aria-label={ariaLabel}>
        {visibleRecords.map((record) => (
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
      )}

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

              <p className="prompt-output-thread-note">
                {conversation.length === 1
                  ? "1 exchange in this conversation."
                  : `${conversation.length} exchanges in this conversation, oldest first.`}
                {loadingFullThread && " Loading the full conversation…"}
                {threadLoadFailed &&
                  " The full conversation could not be loaded; showing the exchanges already in this view."}
              </p>

              <div className="prompt-output-dialog-body">
                {conversation.map((record, index) => {
                  const isClicked = record.id === selected.id;
                  return (
                    <article
                      key={`${record.thread_id}:${record.id}`}
                      className={`prompt-output-exchange${isClicked ? " is-selected" : ""}`}
                      aria-label={`Exchange ${index + 1} of ${conversation.length}`}
                      ref={
                        isClicked
                          ? (node) => {
                              selectedExchangeRef.current = node;
                            }
                          : undefined
                      }
                    >
                      <section className="prompt-output-message is-prompt" aria-label="User prompt">
                        <header>
                          <span><UserRound size={15} /> User prompt</span>
                          <span className="prompt-output-exchange-meta">
                            {isClicked && <Pill tone="info">Selected exchange</Pill>}
                            <small>{formatTimestamp(record)}</small>
                          </span>
                        </header>
                        <div className="prompt-output-rendered">
                          <Markdown content={record.content} />
                        </div>
                      </section>

                      <section className="prompt-output-message is-response" aria-label="Saved model output">
                        <header>
                          <span><Bot size={15} /> Model output</span>
                          {record.response_status && <Pill tone={record.response_status === "ok" ? "success" : "warning"}>{record.response_status}</Pill>}
                        </header>
                        {record.response_message_id || record.response_content != null ? (
                          <>
                            <div className="prompt-output-rendered">
                              {record.response_content ? (
                                // The audit view shows what the user saw: the same
                                // renderer chat uses, so markdown, tables, and
                                // diagrams read the way they were sent.
                                <Markdown content={record.response_content} />
                              ) : (
                                <p className="prompt-output-plain">The saved model output was empty.</p>
                              )}
                            </div>
                            {(record.response_images?.length ?? 0) > 0 && (
                              <div
                                className="prompt-output-images"
                                role="group"
                                aria-label="Generated images saved with this output"
                              >
                                {record.response_images!.map((url) => (
                                  <AuditGeneratedImage url={url} key={url} />
                                ))}
                              </div>
                            )}
                            {record.response_truncated && (
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
                    </article>
                  );
                })}
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

export type FeedbackPreviewItem = {
  thread_id: string;
  thread_title: string;
  message_id: string;
  rating: ChatFeedbackRating;
  comment?: string;
  user_name: string;
  model_id: string;
  message_preview?: string;
};

/** Full-conversation preview for one feedback entry: the same rendered-chat
 * dialog auditors get from prompt activity, plus the person's written note.
 * The rated exchange is highlighted and scrolled into view; markdown, tables,
 * diagrams, and saved generated images render exactly as the user saw them. */
export function FeedbackConversationPreview({
  item,
  sentLabel,
  loadThreadRecords,
  onClose,
}: {
  item: FeedbackPreviewItem;
  /** Display-formatted timestamp of the rating. */
  sentLabel: string;
  loadThreadRecords?: (
    threadId: string,
  ) => Promise<UserPromptRecord[] | void> | UserPromptRecord[] | void;
  onClose: () => void;
}) {
  const [records, setRecords] = useState<UserPromptRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const titleId = useId();
  const ratedExchangeRef = useRef<HTMLElement | null>(null);
  // The loader identity can change every render (inline console closures);
  // reading it through a ref keeps the fetch keyed on the previewed item.
  const loaderRef = useRef(loadThreadRecords);
  loaderRef.current = loadThreadRecords;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    const loader = loaderRef.current;
    if (!loader) {
      setLoadFailed(true);
      return;
    }
    let cancelled = false;
    Promise.resolve()
      .then(() => loader(item.thread_id))
      .then((full) => {
        if (!cancelled && Array.isArray(full)) setRecords(full);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [item.thread_id]);

  const conversation = useMemo(() => {
    if (!records) return [];
    // The API returns newest-first; flip to read the chat top-down, then a
    // stable timestamp sort guards against any out-of-order rows.
    return [...records].reverse().sort((a, b) => recordSortValue(a) - recordSortValue(b));
  }, [records]);

  // Feedback targets an assistant message; its exchange is the prompt whose
  // saved response carries that id.
  const isRatedExchange = (record: UserPromptRecord) =>
    record.response_message_id === item.message_id || record.id === item.message_id;

  useEffect(() => {
    ratedExchangeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [conversation]);

  const isPositive = item.rating === "positive";

  return createPortal(
    <div className="modal-backdrop prompt-output-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal prompt-output-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            {isPositive ? <ThumbsUp size={20} /> : <ThumbsDown size={20} />}
          </span>
          <div>
            <h2 id={titleId}>Feedback and conversation</h2>
            <p>{item.thread_title}</p>
          </div>
          <button
            autoFocus
            className="icon-button"
            type="button"
            aria-label="Close feedback preview"
            data-tooltip="Close preview"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>

        <div className="prompt-output-meta" aria-label="Feedback metadata">
          <span><strong>User</strong>{item.user_name}</span>
          <span><strong>Sentiment</strong>{isPositive ? "Positive" : "Negative"}</span>
          <span><strong>Model</strong>{item.model_id}</span>
          <span><strong>Sent</strong>{sentLabel}</span>
        </div>

        {item.comment ? (
          <div className="feedback-note-banner" role="note" aria-label="User feedback note">
            {isPositive ? <ThumbsUp size={15} /> : <ThumbsDown size={15} />}
            <p>“{item.comment}”</p>
          </div>
        ) : (
          <p className="prompt-output-thread-note">No written note was added to this rating.</p>
        )}

        <p className="prompt-output-thread-note">
          {records === null && !loadFailed && "Loading the conversation…"}
          {loadFailed &&
            "The conversation could not be loaded; showing the rated response preview only."}
          {records !== null &&
            (conversation.length === 0
              ? "No saved exchanges were found for this chat."
              : conversation.length === 1
                ? "1 exchange in this conversation."
                : `${conversation.length} exchanges in this conversation, oldest first.`)}
        </p>

        <div className="prompt-output-dialog-body">
          {loadFailed && (
            <article className="prompt-output-exchange is-selected" aria-label="Rated output preview">
              <section className="prompt-output-message is-response" aria-label="Saved model output">
                <header>
                  <span><Bot size={15} /> Rated output (saved preview)</span>
                </header>
                <div className="prompt-output-rendered">
                  <Markdown content={item.message_preview ?? ""} />
                </div>
              </section>
            </article>
          )}
          {conversation.map((record, index) => {
            const rated = isRatedExchange(record);
            return (
              <article
                key={`${record.thread_id}:${record.id}`}
                className={`prompt-output-exchange${rated ? " is-selected" : ""}`}
                aria-label={`Exchange ${index + 1} of ${conversation.length}`}
                ref={
                  rated
                    ? (node) => {
                        ratedExchangeRef.current = node;
                      }
                    : undefined
                }
              >
                <section className="prompt-output-message is-prompt" aria-label="User prompt">
                  <header>
                    <span><UserRound size={15} /> User prompt</span>
                    <span className="prompt-output-exchange-meta">
                      {rated && (
                        <Pill tone={isPositive ? "success" : "warning"}>Rated exchange</Pill>
                      )}
                      <small>{record.created_at}</small>
                    </span>
                  </header>
                  <div className="prompt-output-rendered">
                    <Markdown content={record.content} />
                  </div>
                </section>

                <section className="prompt-output-message is-response" aria-label="Saved model output">
                  <header>
                    <span><Bot size={15} /> Model output</span>
                    {record.response_status && (
                      <Pill tone={record.response_status === "ok" ? "success" : "warning"}>
                        {record.response_status}
                      </Pill>
                    )}
                  </header>
                  {record.response_message_id || record.response_content != null ? (
                    <>
                      <div className="prompt-output-rendered">
                        {record.response_content ? (
                          <Markdown content={record.response_content} />
                        ) : (
                          <p className="prompt-output-plain">The saved model output was empty.</p>
                        )}
                      </div>
                      {(record.response_images?.length ?? 0) > 0 && (
                        <div
                          className="prompt-output-images"
                          role="group"
                          aria-label="Generated images saved with this output"
                        >
                          {record.response_images!.map((url) => (
                            <AuditGeneratedImage url={url} key={url} />
                          ))}
                        </div>
                      )}
                      {record.response_truncated && (
                        <small className="prompt-output-truncated">
                          Preview limited to the first 12,000 saved characters.
                        </small>
                      )}
                    </>
                  ) : (
                    <div className="prompt-output-empty">
                      No saved model output is attached to this prompt.
                    </div>
                  )}
                </section>
              </article>
            );
          })}
        </div>

        <footer className="modal-foot">
          <Eye size={14} /> This preview shows persisted text and saved generated images; it does
          not run the model again.
        </footer>
      </section>
    </div>,
    document.body,
  );
}
