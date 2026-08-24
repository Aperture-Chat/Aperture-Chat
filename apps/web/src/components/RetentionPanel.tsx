import {
  Archive,
  Bot,
  Check,
  DatabaseZap,
  MessageSquareText,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  RetentionTaggedThread,
  TenantRetentionPolicy,
  TenantRetentionPolicyUpdateRequest,
  UserPromptRecord,
} from "../lib/types";
import { Markdown } from "./Markdown";
import { Panel, Toggle } from "./Primitives";

type BatchAction = "delete" | "archive";

/** Chronological position of a record inside its thread; records without a
 * parseable timestamp keep their server order at the front. */
function recordSortValue(record: UserPromptRecord) {
  const parsed = Date.parse(record.created_at_iso ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Slim retention policy panel for the admin Policies / owner Org Settings
 * tabs: tagging switches only. The chat list itself lives in the Audit tab's
 * prompt panel (RetentionTagsView) so this panel never grows with data. */
export function RetentionPanel({
  policy,
  error,
  busy,
  onPolicyChange,
}: {
  policy: TenantRetentionPolicy | null;
  error: string | null;
  busy: boolean;
  onPolicyChange: (patch: TenantRetentionPolicyUpdateRequest) => void;
}) {
  const disabled = busy || policy === null;
  return (
    <Panel
      title={<><DatabaseZap size={18} /> Data Retention</>}
      subtitle="Tag chats by connection, uploads, and subject so they can be found, held, and eventually purged by policy. Review and batch-manage tagged chats under Audit → User Prompt Activity → Tags."
      defaultCollapsed
    >
      <div className="permission-row policy-toggle-row">
        <span>
          <strong>Tag chats that use MCP connections</strong>
          <small>
            {policy?.mcp_tagging_enabled
              ? "Every chat that invokes an MCP server is tagged with that connection so it can be targeted for holds, archiving, or purge later."
              : "No tags are recorded. Turn this on before connecting sources like Box so their chats stay identifiable."}
          </small>
        </span>
        <Toggle
          checked={Boolean(policy?.mcp_tagging_enabled)}
          disabled={disabled}
          label="Tag chats that use MCP connections"
          tooltip="Record a retention tag on every chat that invokes an MCP server"
          onChange={(next) => onPolicyChange({ mcp_tagging_enabled: next })}
        />
      </div>
      <div className="permission-row policy-toggle-row">
        <span>
          <strong>Tag chats with file uploads</strong>
          <small>
            {policy?.attachment_tagging_enabled
              ? "Every chat whose messages carried uploaded files is tagged as document- or image-bearing so those conversations can be targeted too."
              : "Chats with uploaded documents are not tagged. Turn this on so document-bearing conversations stay identifiable."}
          </small>
        </span>
        <Toggle
          checked={Boolean(policy?.attachment_tagging_enabled)}
          disabled={disabled}
          label="Tag chats with file uploads"
          tooltip="Record a retention tag on every chat whose messages carried uploaded files"
          onChange={(next) => onPolicyChange({ attachment_tagging_enabled: next })}
        />
      </div>
      <div className="permission-row policy-toggle-row">
        <span>
          <strong>Tag chats by subject</strong>
          <small>
            {policy?.subject_tagging_enabled
              ? "Each new conversation is classified once into a curated taxonomy (legal, financial, medical, code, …) using the chat's own model."
              : "Conversations are not classified. Turning this on runs one small background completion per new conversation to label it (for example legal / litigation or financial / ira)."}
          </small>
        </span>
        <Toggle
          checked={Boolean(policy?.subject_tagging_enabled)}
          disabled={disabled}
          label="Tag chats by subject"
          tooltip="Classify each conversation once into the retention subject taxonomy using its own model"
          onChange={(next) => onPolicyChange({ subject_tagging_enabled: next })}
        />
      </div>
      {error ? (
        <div className="audit-empty-state">
          <ShieldCheck size={20} />
          <span>
            <strong>Retention policy could not be loaded</strong>
            <small>{error}</small>
          </span>
        </div>
      ) : null}
    </Panel>
  );
}

/** The Tags side of the Audit prompt panel: every chat in the organization
 * with its retention tags, searchable and bounded, with batch archive/delete.
 * Everything shown is thread metadata and already-audited prompt records. */
export function RetentionTagsView({
  tagged,
  error,
  busy,
  onRefresh,
  loadThreadRecords,
  onBatchAction,
}: {
  tagged: RetentionTaggedThread[] | null;
  error: string | null;
  busy: boolean;
  onRefresh: () => void;
  /** Loads every saved exchange of one thread so the preview shows the whole
   * conversation. Without it, rows are not clickable. */
  loadThreadRecords?: (threadId: string) => Promise<UserPromptRecord[] | void>;
  /** Runs a batch action; resolves true when it succeeded so the view can
   * clear its selection. Without it, no batch controls render. */
  onBatchAction?: (action: BatchAction, threadIds: string[]) => Promise<boolean>;
}) {
  const allRows = tagged ?? [];
  const [query, setQuery] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<BatchAction | null>(null);
  const [preview, setPreview] = useState<RetentionTaggedThread | null>(null);
  const [previewRecords, setPreviewRecords] = useState<UserPromptRecord[] | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const titleId = useId();
  const searchId = useId();
  const searchHintId = useId();
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);

  const namespaces = useMemo(
    () =>
      [...new Set(allRows.flatMap((row) => row.tags.map((tag) => tag.namespace)))].sort(),
    [allRows],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allRows.filter((row) => {
      if (namespaceFilter === "untagged") {
        if (row.tags.length > 0) return false;
      } else if (namespaceFilter !== "all") {
        if (!row.tags.some((tag) => tag.namespace === namespaceFilter)) return false;
      }
      if (!needle) return true;
      const haystack = [
        row.title ?? "",
        row.thread_id,
        row.owner_user_id ?? "",
        row.matter_id ?? "",
        row.matter_label ?? "",
        ...row.tags.map((tag) => `${tag.namespace} ${tag.key} ${tag.value ?? ""}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [allRows, namespaceFilter, query]);

  // Rows can disappear underneath a selection after a refresh, filter change,
  // or batch run.
  const rowIds = useMemo(() => new Set(rows.map((row) => row.thread_id)), [rows]);
  const selected = selectedIds.filter((id) => rowIds.has(id));
  const allSelected = rows.length > 0 && selected.length === rows.length;

  const closePreview = () => {
    setPreview(null);
    setPreviewRecords(null);
    setPreviewFailed(false);
    window.setTimeout(() => lastTriggerRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!preview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePreview();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [preview]);

  useEffect(() => {
    if (!preview || !loadThreadRecords) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => loadThreadRecords(preview.thread_id))
      .then((records) => {
        if (!cancelled && Array.isArray(records)) setPreviewRecords(records);
      })
      .catch(() => {
        if (!cancelled) setPreviewFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // The loader identity changes every console render; keying on the
    // preview target keeps this to one fetch per opened thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  const conversation = useMemo(() => {
    if (!previewRecords) return [];
    // The API returns newest-first; flip to read the chat top-down, then a
    // stable timestamp sort guards against out-of-order rows.
    return [...previewRecords].reverse().sort((a, b) => recordSortValue(a) - recordSortValue(b));
  }, [previewRecords]);

  const toggleRow = (threadId: string) => {
    setSelectedIds((current) =>
      current.includes(threadId)
        ? current.filter((id) => id !== threadId)
        : [...current, threadId],
    );
  };

  const runBatch = async (action: BatchAction) => {
    if (!onBatchAction || selected.length === 0) return;
    setConfirming(null);
    const succeeded = await onBatchAction(action, selected);
    if (succeeded) setSelectedIds([]);
  };

  if (error) {
    return (
      <div className="audit-empty-state">
        <ShieldCheck size={20} />
        <span>
          <strong>Retention data could not be loaded</strong>
          <small>{error}</small>
        </span>
      </div>
    );
  }
  if (allRows.length === 0) {
    return (
      <div className="audit-empty-state">
        <DatabaseZap size={20} />
        <span>
          <strong>No chats to govern yet</strong>
          <small>
            Every chat in this organization appears here — tagged or not — for batch
            archiving and deletion. Turn tagging on under Policies so MCP, document, and
            subject labels accumulate.
          </small>
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="retention-tags-toolbar">
        <label className="retention-search-control" htmlFor={searchId}>
          <span className="retention-search-title">
            <Search size={14} aria-hidden="true" />
            Conversation finder
          </span>
          <span className="retention-search-hint" id={searchHintId}>
            Search chat titles, owners, tags, or client/matter numbers.
          </span>
          <input
            id={searchId}
            type="search"
            className="retention-tag-search"
            placeholder="Start typing to filter chats"
            aria-label="Search chats and tags"
            aria-describedby={searchHintId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          className="retention-namespace-select"
          aria-label="Filter by tag type"
          value={namespaceFilter}
          onChange={(event) => setNamespaceFilter(event.target.value)}
        >
          <option value="all">All chats</option>
          <option value="untagged">Untagged only</option>
          {namespaces.map((namespace) => (
            <option key={namespace} value={namespace}>
              {namespace} tags
            </option>
          ))}
        </select>
        <span className="retention-tags-count">
          {rows.length === allRows.length
            ? `${allRows.length} chat${allRows.length === 1 ? "" : "s"}`
            : `${rows.length} of ${allRows.length} chats`}
        </span>
        <button type="button" className="secondary-button compact" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      {onBatchAction && (
        <div className="retention-batch-bar">
          <label className="retention-select-all">
            <input
              type="checkbox"
              checked={allSelected}
              aria-label="Select all listed chats"
              onChange={() =>
                setSelectedIds(allSelected ? [] : rows.map((row) => row.thread_id))
              }
            />
            <span>
              {selected.length === 0
                ? "Select chats for a batch action"
                : `${selected.length} selected`}
            </span>
          </label>
          {confirming ? (
            <span className="memory-purge-confirm">
              <span>
                {confirming === "delete"
                  ? `Permanently delete ${selected.length} chat${selected.length === 1 ? "" : "s"} and their attachments? Chats under an active legal hold are skipped. This cannot be undone.`
                  : `Archive ${selected.length} chat${selected.length === 1 ? "" : "s"}? They stay stored and searchable but leave the active list.`}
              </span>
              <button
                type="button"
                className="secondary-button compact"
                onClick={() => void runBatch(confirming)}
              >
                <Check size={14} /> Yes, {confirming}
              </button>
              <button
                type="button"
                className="secondary-button compact"
                onClick={() => setConfirming(null)}
              >
                Cancel
              </button>
            </span>
          ) : (
            <span className="retention-batch-actions">
              <button
                type="button"
                className="secondary-button compact"
                disabled={selected.length === 0 || busy}
                onClick={() => setConfirming("archive")}
              >
                <Archive size={14} /> Archive selected
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={selected.length === 0 || busy}
                onClick={() => setConfirming("delete")}
              >
                <Trash2 size={14} /> Delete selected
              </button>
            </span>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="retention-filter-empty">No chats match the current search or filter.</p>
      ) : (
        <ul className="retention-tagged-list scrollable-log-list">
          {rows.map((row) => {
            const title = row.title ?? "(unsaved or deleted chat)";
            return (
              <li key={row.thread_id} className="retention-tagged-row">
                {onBatchAction && (
                  <input
                    type="checkbox"
                    checked={selected.includes(row.thread_id)}
                    aria-label={`Select ${title} for a batch action`}
                    onChange={() => toggleRow(row.thread_id)}
                  />
                )}
                {loadThreadRecords ? (
                  <button
                    type="button"
                    className="retention-tagged-title is-clickable"
                    aria-label={`Preview the full conversation: ${title}`}
                    onClick={(event) => {
                      lastTriggerRef.current = event.currentTarget;
                      setPreviewRecords(null);
                      setPreviewFailed(false);
                      setPreview(row);
                    }}
                  >
                    <strong>{title}</strong>
                    <small>{row.thread_id}</small>
                  </button>
                ) : (
                  <span className="retention-tagged-title">
                    <strong>{title}</strong>
                    <small>{row.thread_id}</small>
                  </span>
                )}
                <span className="retention-tag-chips">
                  {row.matter_label && (
                    <span
                      className="retention-tag-chip is-matter"
                      title={`Matter ${row.matter_id ?? ""}`}
                    >
                      matter: {row.matter_label}
                    </span>
                  )}
                  {row.archived && (
                    <span className="retention-tag-chip is-archived">archived</span>
                  )}
                  {row.tags.map((tag) => (
                    <span
                      key={tag.id}
                      className="retention-tag-chip"
                      title={`${tag.namespace}:${tag.key}`}
                    >
                      {tag.namespace}: {tag.value ? `${tag.key} / ${tag.value}` : tag.key}
                    </span>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {preview &&
        createPortal(
          <div
            className="modal-backdrop prompt-output-backdrop"
            role="presentation"
            onClick={closePreview}
          >
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
                  <h2 id={titleId}>Tagged conversation</h2>
                  <p>{preview.title ?? preview.thread_id}</p>
                </div>
                <button
                  autoFocus
                  className="icon-button"
                  type="button"
                  aria-label="Close conversation preview"
                  data-tooltip="Close preview"
                  onClick={closePreview}
                >
                  <X size={17} />
                </button>
              </div>

              <p className="prompt-output-thread-note">
                {previewRecords === null && !previewFailed && "Loading the conversation…"}
                {previewFailed &&
                  "The conversation could not be loaded. It may not be saved yet, or it belongs to a chat you cannot audit."}
                {previewRecords !== null &&
                  (conversation.length === 0
                    ? "No saved exchanges were found for this chat."
                    : conversation.length === 1
                      ? "1 exchange in this conversation."
                      : `${conversation.length} exchanges in this conversation, oldest first.`)}
              </p>

              <div className="prompt-output-dialog-body">
                {conversation.map((record, index) => (
                  <article
                    key={`${record.thread_id}:${record.id}`}
                    className="prompt-output-exchange"
                    aria-label={`Exchange ${index + 1} of ${conversation.length}`}
                  >
                    <section className="prompt-output-message is-prompt" aria-label="User prompt">
                      <header>
                        <span><UserRound size={15} /> User prompt</span>
                        <span className="prompt-output-exchange-meta">
                          <small>{record.created_at}</small>
                        </span>
                      </header>
                      <div className="prompt-output-rendered">
                        <Markdown content={record.content} />
                      </div>
                    </section>
                    <section
                      className="prompt-output-message is-response"
                      aria-label="Saved model output"
                    >
                      <header>
                        <span><Bot size={15} /> Model output</span>
                      </header>
                      {record.response_content ? (
                        <div className="prompt-output-rendered">
                          <Markdown content={record.response_content} />
                        </div>
                      ) : (
                        <div className="prompt-output-empty">
                          No saved model output is attached to this prompt.
                        </div>
                      )}
                    </section>
                  </article>
                ))}
              </div>

              <footer className="modal-foot">
                <MessageSquareText size={14} /> This preview shows persisted text; it does not run
                the model again.
              </footer>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
