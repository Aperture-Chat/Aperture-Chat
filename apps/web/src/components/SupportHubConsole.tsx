import clsx from "clsx";
import { ArrowLeft, Ban, ExternalLink, Github, Link2, RefreshCw, ShieldAlert, Sparkles, Undo2, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  absoluteTime,
  HUB_STATUS_LABELS,
  HUB_STATUS_TONES,
  KIND_LABELS,
  PRIORITY_LABELS,
  relativeTime,
} from "../lib/supportLabels";
import type { SupportHubQueue, SupportHubReport, SupportHubReportStatus } from "../lib/types";
import { Pill } from "./Primitives";
import { RailSwitch } from "./RailSwitch";
import type { SupportHubApi } from "./SupportTicketsConsole";

type HubFilter = "pending" | "private" | "published" | "declined" | "all";

// Each rail stop groups the statuses a maintainer treats alike: an issue
// comment counts as published, spam as declined.
const FILTER_STATUSES: Record<Exclude<HubFilter, "all">, SupportHubReportStatus[]> = {
  pending: ["pending"],
  private: ["private"],
  published: ["published", "linked"],
  declined: ["declined", "spam"],
};

const FILTERS: { value: HubFilter; label: string }[] = [
  { value: "pending", label: "Needs review" },
  { value: "private", label: "Private" },
  { value: "published", label: "Published" },
  { value: "declined", label: "Declined" },
  { value: "all", label: "All" },
];

function filterCount(counts: Record<string, number> | undefined, filter: HubFilter): number {
  if (!counts) return 0;
  if (filter === "all") return counts.all ?? 0;
  return FILTER_STATUSES[filter].reduce((total, status) => total + (counts[status] ?? 0), 0);
}

const LABEL_CHOICES = ["bug", "enhancement", "question", "documentation", "feedback"];

const DIAGNOSTIC_LABELS: Record<string, string> = {
  app_version: "Version",
  reporter_role: "Role",
  area: "Area",
  browser: "Browser",
  os: "OS",
  viewport: "Window",
  color_scheme: "Theme",
  recent_errors: "Recent errors",
  failed_requests: "Failed requests",
};

const ROLE_LABELS: Record<string, string> = {
  USER: "User",
  POWER_USER: "Power user",
  TEMP_USER: "Temporary user",
  AUDITOR: "Auditor",
  AGENT_APPROVER: "Agent approver",
  TENANT_ADMIN: "Tenant admin",
  PLATFORM_OWNER: "Platform owner",
};

function defaultLabels(report: SupportHubReport): string[] {
  if (report.triage?.labels?.length) return report.triage.labels;
  if (report.kind === "bug") return ["bug"];
  if (report.kind === "feature") return ["enhancement"];
  if (report.kind === "question") return ["question"];
  return ["feedback"];
}

/**
 * The maintainers' intake queue: reports every deployment shared through the
 * community hub, with triage hints, and the actions that put them on GitHub.
 */
export function SupportHubConsole({
  api,
  onPendingChange,
  onOpenSettings,
}: {
  api: SupportHubApi;
  onPendingChange?: (count: number) => void;
  onOpenSettings: () => void;
}) {
  const [queue, setQueue] = useState<SupportHubQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<HubFilter>("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const apply = useCallback(
    (next: SupportHubQueue) => {
      setQueue(next);
      onPendingChange?.(next.counts.pending ?? 0);
    },
    [onPendingChange],
  );

  const load = useCallback(async () => {
    try {
      apply(await api.list());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Community reports could not be loaded.");
    }
  }, [api, apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () =>
      (queue?.items ?? []).filter(
        (item) => filter === "all" || FILTER_STATUSES[filter].includes(item.status),
      ),
    [queue, filter],
  );
  const selected = queue?.items.find((item) => item.id === selectedId) ?? null;

  const replace = (report: SupportHubReport) => {
    if (!queue) return;
    const previous = queue.items.find((item) => item.id === report.id);
    const counts = { ...queue.counts };
    if (previous && previous.status !== report.status) {
      counts[previous.status] = Math.max(0, (counts[previous.status] ?? 1) - 1);
      counts[report.status] = (counts[report.status] ?? 0) + 1;
    }
    apply({ items: queue.items.map((item) => (item.id === report.id ? report : item)), counts });
  };

  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      apply(await api.sync());
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "GitHub status could not be synced.");
    } finally {
      setSyncing(false);
    }
  };

  if (queue && queue.items.length === 0) {
    return (
      <div className="ws-empty support-hub-empty">
        <span className="ws-empty-icon"><UsersRound size={22} /></span>
        <h2>No community reports</h2>
        <p>
          When this deployment runs the community hub, reports other deployments share appear here for review
          before they become GitHub issues.
        </p>
        <div className="ws-empty-actions">
          <button className="secondary-button" type="button" onClick={onOpenSettings}>Hub settings</button>
          <button className="secondary-button" type="button" onClick={() => void load()}><RefreshCw size={14} /> Refresh</button>
        </div>
      </div>
    );
  }

  return (
    <div className={clsx("support-queue", selectedId && "has-selection")}>
      <div className="ws-toolbar support-toolbar">
        <RailSwitch
          className="support-filters"
          ariaLabel="Filter community reports"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((option) => ({ ...option, count: filterCount(queue?.counts, option.value) }))}
        />
        <div className="support-toolbar-row">
          <button className="secondary-button" type="button" onClick={() => void sync()} disabled={syncing}>
            <Github size={14} /> {syncing ? "Syncing…" : "Sync GitHub status"}
          </button>
          <button className="secondary-button" type="button" onClick={() => void load()}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="support-queue-layout">
        <section className="support-queue-list" aria-label="Community reports">
          {queue === null ? (
            <div className="audit-empty-state"><span><strong>Loading…</strong></span></div>
          ) : visible.length === 0 ? (
            <div className="audit-empty-state"><span><strong>Nothing here</strong><small>Try another filter.</small></span></div>
          ) : (
            <ul>
              {visible.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={clsx("support-ticket-row", selectedId === item.id && "is-selected")}
                    aria-label={item.title}
                    aria-current={selectedId === item.id ? "true" : undefined}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className="support-ticket-row-top"><strong>{item.title}</strong></span>
                    <span className="support-ticket-row-meta">
                      <span>{KIND_LABELS[item.kind]} · v{item.instance_version || "?"}</span>
                      <time dateTime={item.received_at}>{relativeTime(item.received_at)}</time>
                    </span>
                    <span className="support-ticket-row-tags">
                      <Pill tone={HUB_STATUS_TONES[item.status]}>{HUB_STATUS_LABELS[item.status]}</Pill>
                      {item.issue_number && <span className="support-upstream-tag">#{item.issue_number}</span>}
                      {item.triage?.duplicate_of && <span className="support-needs-reply">Possible duplicate</span>}
                      {(item.triage?.spam_likelihood ?? 0) > 0.5 && <span className="support-needs-reply">Likely spam</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="support-queue-detail" aria-label="Selected community report">
          {selected ? (
            <HubReportDetail key={selected.id} api={api} report={selected} onBack={() => setSelectedId(null)} onChanged={replace} />
          ) : (
            <div className="audit-empty-state support-detail-empty">
              <UsersRound size={18} />
              <span>
                <strong>Select a community report</strong>
                <small>Publish it as a GitHub issue, add it to an existing issue, or decline it.</small>
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function HubReportDetail({
  api,
  report,
  onBack,
  onChanged,
}: {
  api: SupportHubApi;
  report: SupportHubReport;
  onBack: () => void;
  onChanged: (report: SupportHubReport) => void;
}) {
  const triage = report.triage;
  const [title, setTitle] = useState(triage?.suggested_title || report.title);
  const [body, setBody] = useState(report.body);
  const [labels, setLabels] = useState<string[]>(() => defaultLabels(report));
  const [issueNumber, setIssueNumber] = useState(triage?.duplicate_of ? String(triage.duplicate_of) : "");
  const [linkComment, setLinkComment] = useState("");
  const [reason, setReason] = useState("");
  const [spam, setSpam] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reviewable = report.status === "pending";
  const isPrivate = report.status === "private";

  const run = async (key: string, action: () => Promise<SupportHubReport>) => {
    setBusy(key);
    setError(null);
    try {
      onChanged(await action());
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  };

  const diagnostics = report.diagnostics ?? {};

  return (
    <div className="support-detail">
      <button className="back-link-button support-detail-back" type="button" onClick={onBack}>
        <ArrowLeft size={15} /> All community reports
      </button>
      <header className="support-detail-header">
        <h3>{report.title}</h3>
        <p>
          <Pill tone={HUB_STATUS_TONES[report.status]}>{HUB_STATUS_LABELS[report.status]}</Pill>{" "}
          {KIND_LABELS[report.kind]}
          {report.priority !== "normal" ? ` · ${PRIORITY_LABELS[report.priority]} impact` : ""} · received{" "}
          <time dateTime={report.received_at} title={absoluteTime(report.received_at)}>{relativeTime(report.received_at)}</time>
        </p>
        <p className="support-muted">
          Deployment {report.instance_id.slice(0, 8)}… · version {report.instance_version || "unknown"} ·{" "}
          {report.instance_report_count} report{report.instance_report_count === 1 ? "" : "s"} from this deployment
        </p>
      </header>

      {isPrivate && (
        <div className="ws-notice is-warning" role="note">
          <ShieldAlert size={15} /> Security report: it's kept private and can never be published as an issue. Review it
          here, fix it privately, and decline it once handled.
        </div>
      )}

      <article className="support-detail-message">
        <p>{report.body}</p>
      </article>

      {Object.keys(diagnostics).length > 0 && (
        <dl className="support-diagnostics-inline">
          {Object.entries(diagnostics).map(([key, value]) => (
            <div key={key}>
              <dt>{DIAGNOSTIC_LABELS[key] ?? key.replace(/_/g, " ")}</dt>
              <dd>
                {Array.isArray(value)
                  ? value.map((entry, index) => <code key={index}>{String(entry)}</code>)
                  : key === "reporter_role"
                    ? ROLE_LABELS[String(value)] ?? String(value)
                    : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <section className="support-triage">
        <header>
          <strong><Sparkles size={14} /> Triage</strong>
          <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void run("triage", () => api.triage(report.id))}>
            {busy === "triage" ? "Running…" : triage ? "Run again" : "Run triage"}
          </button>
        </header>
        {!triage ? (
          <p className="support-muted">Triage runs automatically within a minute of a report arriving.</p>
        ) : (
          <>
            {triage.summary && <p>{triage.summary}</p>}
            <div className="support-triage-facts">
              {triage.severity && <span>Severity: <b>{triage.severity}</b></span>}
              {typeof triage.spam_likelihood === "number" && <span>Spam likelihood: <b>{Math.round(triage.spam_likelihood * 100)}%</b></span>}
              {triage.labels?.length ? <span>Labels: <b>{triage.labels.join(", ")}</b></span> : null}
              {triage.security_sensitive && <span className="is-bad">Looks security-sensitive</span>}
              {triage.contains_sensitive_data && <span className="is-bad">May contain personal data</span>}
            </div>
            {triage.notes && <p className="support-muted">{triage.notes}</p>}
            {triage.ai_error && <p className="support-muted">AI triage: {triage.ai_error}</p>}
            {triage.search_error && <p className="support-muted">Duplicate search: {triage.search_error}</p>}
            {triage.candidates && triage.candidates.length > 0 && (
              <ul className="support-candidates" aria-label="Possible duplicates">
                {triage.candidates.map((candidate) => (
                  <li key={candidate.number} className={clsx(candidate.number === triage.duplicate_of && "is-likely")}>
                    <a href={candidate.url ?? undefined} target="_blank" rel="noreferrer noopener">
                      #{candidate.number} {candidate.title} <ExternalLink size={12} />
                    </a>
                    <span>{candidate.state}</span>
                    {reviewable && (
                      <button type="button" className="link-button" onClick={() => setIssueNumber(String(candidate.number))}>
                        Use
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {(report.status === "published" || report.status === "linked") && report.issue_url && (
        <section className="ticket-upstream-card support-upstream">
          <Github size={16} />
          <span>
            <strong>GitHub issue #{report.issue_number} · {report.issue_state ?? "open"}{report.issue_state_reason ? ` (${report.issue_state_reason.replace("_", " ")})` : ""}</strong>
            <small>{report.reviewed_by_name ? `Reviewed by ${report.reviewed_by_name} ${relativeTime(report.reviewed_at)}` : ""}</small>
          </span>
          <a className="ticket-upstream-link" href={report.issue_url} target="_blank" rel="noreferrer noopener">
            Open <ExternalLink size={13} />
          </a>
        </section>
      )}

      {reviewable && (
        <section className="support-hub-actions">
          <h4><Github size={15} /> Publish as a new issue</h4>
          <label className="support-field">
            <span>Title</span>
            <input maxLength={200} value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
          </label>
          <label className="support-field">
            <span>Description</span>
            <textarea rows={6} value={body} onChange={(event) => setBody(event.currentTarget.value)} />
          </label>
          <fieldset className="support-labels">
            <legend>Labels</legend>
            {LABEL_CHOICES.map((label) => (
              <label key={label} className="issue-report-check">
                <input
                  type="checkbox"
                  checked={labels.includes(label)}
                  onChange={(event) =>
                    setLabels((current) =>
                      event.currentTarget.checked ? [...current, label] : current.filter((item) => item !== label),
                    )
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <div className="support-composer-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy !== null || title.trim().length < 4 || body.trim().length < 10}
              onClick={() => void run("publish", () => api.publish(report.id, { title: title.trim(), body: body.trim(), labels }))}
            >
              <Github size={14} /> {busy === "publish" ? "Publishing…" : "Publish issue"}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void api
                  .preview(report.id)
                  .then((result) => setPreview(result.markdown))
                  .catch((previewError) => setError(previewError instanceof Error ? previewError.message : "Preview failed."))
              }
            >
              Preview
            </button>
          </div>
          {preview && <pre className="support-share-preview-text">{preview}</pre>}

          <h4><Link2 size={15} /> Add to an existing issue</h4>
          <div className="support-inline-input">
            <input
              inputMode="numeric"
              aria-label="Existing issue number"
              placeholder="Issue number"
              value={issueNumber}
              onChange={(event) => setIssueNumber(event.currentTarget.value.replace(/[^0-9]/g, ""))}
            />
            <input
              aria-label="Comment for the existing issue"
              placeholder="Optional note for the issue"
              value={linkComment}
              onChange={(event) => setLinkComment(event.currentTarget.value)}
            />
            <button
              className="secondary-button"
              type="button"
              disabled={busy !== null || !issueNumber}
              onClick={() => void run("link", () => api.link(report.id, { issue_number: Number(issueNumber), comment: linkComment }))}
            >
              {busy === "link" ? "Adding…" : "Add as comment"}
            </button>
          </div>
        </section>
      )}

      {(reviewable || isPrivate) && (
        <section className="support-hub-actions">
          <h4><Ban size={15} /> Decline</h4>
          <div className="support-inline-input">
            <input
              aria-label="Reason sent back to the reporting deployment"
              placeholder="Reason (shared with the reporting deployment)"
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
            <label className="issue-report-check">
              <input type="checkbox" checked={spam} onChange={(event) => setSpam(event.currentTarget.checked)} />
              <span>Spam</span>
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={busy !== null}
              onClick={() => void run("decline", () => api.decline(report.id, { reason, spam }))}
            >
              {busy === "decline" ? "Declining…" : "Decline"}
            </button>
          </div>
        </section>
      )}

      {(report.status === "declined" || report.status === "spam") && (
        <div className="support-composer-actions">
          {report.maintainer_note && <p className="support-muted">Note sent back: {report.maintainer_note}</p>}
          <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void run("requeue", () => api.requeue(report.id))}>
            <Undo2 size={14} /> Return to queue
          </button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
