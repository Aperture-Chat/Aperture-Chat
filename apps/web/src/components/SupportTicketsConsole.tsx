import clsx from "clsx";
import {
  ArrowLeft,
  ExternalLink,
  GitPullRequest,
  Inbox,
  Lock,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Share2,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import {
  absoluteTime,
  describeEvent,
  issueStateLabel,
  KIND_LABELS,
  KIND_ORDER,
  OPEN_STATUSES,
  PRIORITY_LABELS,
  relativeTime,
  STATUS_LABELS,
  STATUS_ORDER,
  STATUS_TONES,
  ticketKind,
  ticketNumber,
  ticketStatus,
  UPSTREAM_LABELS,
} from "../lib/supportLabels";
import type {
  IssueReportDetail,
  IssueReportKind,
  IssueReportListItem,
  IssueReportPriority,
  IssueReportQueue,
  IssueReportStatus,
  IssueReportUpdateRequest,
  IssueReportUpstreamDraft,
  SupportHubQueue,
  SupportHubReport,
  SupportHubStatus,
  SupportSettings,
  SupportSettingsUpdateRequest,
} from "../lib/types";
import { Pill } from "./Primitives";
import { RailSwitch } from "./RailSwitch";
import { SelectControl } from "./SelectControl";
import { SupportHubConsole } from "./SupportHubConsole";
import { SupportSettingsPanel } from "./SupportSettingsPanel";
import { TicketKindIcon } from "./TicketKindIcon";

export type SupportHubApi = {
  list: () => Promise<SupportHubQueue>;
  preview: (reportId: string) => Promise<{ markdown: string }>;
  publish: (reportId: string, payload: { title: string; body: string; labels: string[] }) => Promise<SupportHubReport>;
  link: (reportId: string, payload: { issue_number: number; comment: string }) => Promise<SupportHubReport>;
  decline: (reportId: string, payload: { reason: string; spam: boolean }) => Promise<SupportHubReport>;
  requeue: (reportId: string) => Promise<SupportHubReport>;
  triage: (reportId: string) => Promise<SupportHubReport>;
  sync: () => Promise<SupportHubQueue>;
  check: () => Promise<{ ok: boolean; repository: string; private: boolean }>;
};

export type SupportTicketsApi = {
  queue: () => Promise<IssueReportQueue>;
  get: (reportId: string) => Promise<IssueReportDetail>;
  update: (reportId: string, patch: IssueReportUpdateRequest) => Promise<IssueReportDetail>;
  comment: (reportId: string, payload: { body: string; visibility: "public" | "internal" }) => Promise<IssueReportDetail>;
  loadScreenshot: (reportId: string) => Promise<Blob>;
  // Platform owner only: sharing sends redacted text off the platform.
  draftUpstream?: (
    reportId: string,
    payload: { use_ai?: boolean; include_diagnostics?: boolean },
  ) => Promise<IssueReportUpstreamDraft>;
  shareUpstream?: (
    reportId: string,
    payload: { title: string; body: string; include_diagnostics: boolean },
  ) => Promise<IssueReportDetail>;
  refreshUpstream?: (reportId: string) => Promise<IssueReportDetail>;
  getSettings?: () => Promise<SupportSettings>;
  updateSettings?: (patch: SupportSettingsUpdateRequest) => Promise<SupportSettings>;
  hubStatus?: () => Promise<SupportHubStatus>;
  hub?: SupportHubApi;
};

// The rail holds the everyday views; the Status menu narrows to one exact
// status (and switches the rail to All so the two never conflict).
type QueueView = "needs_reply" | "open" | "closed" | "all";
type OwnerView = "tickets" | "hub" | "settings";

const VIEWS: { value: QueueView; label: string }[] = [
  { value: "needs_reply", label: "Needs reply" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

function matchesView(item: IssueReportListItem, view: QueueView): boolean {
  const status = ticketStatus(item);
  if (view === "all") return true;
  if (view === "open") return OPEN_STATUSES.has(status);
  if (view === "closed") return !OPEN_STATUSES.has(status);
  return OPEN_STATUSES.has(status) && item.last_activity_by === "reporter";
}

/**
 * Support ticket queue for the Admin console (the people an admin manages)
 * and the Owner console (every organization, plus sharing with the Aperture
 * Chat maintainers, the community hub, and support settings).
 */
export function SupportTicketsConsole({
  variant,
  api,
}: {
  variant: "admin" | "owner";
  api: SupportTicketsApi;
}) {
  const [view, setView] = useState<OwnerView>("tickets");
  const [hubPending, setHubPending] = useState<number | null>(null);
  const ownerViews = variant === "owner" && Boolean(api.getSettings);

  return (
    <div className="support-console">
      {ownerViews && (
        <RailSwitch
          className="support-view-switch"
          ariaLabel="Reports views"
          value={view}
          onChange={setView}
          options={[
            { value: "tickets", label: "Tickets", icon: <Inbox size={15} /> },
            ...(api.hub
              ? [{
                  value: "hub" as const,
                  label: "Community hub",
                  icon: <UsersRound size={15} />,
                  count: hubPending || undefined,
                }]
              : []),
            { value: "settings", label: "Settings", icon: <Settings2 size={15} /> },
          ]}
        />
      )}
      {view === "tickets" && <TicketQueue variant={variant} api={api} onOpenSettings={ownerViews ? () => setView("settings") : undefined} />}
      {view === "hub" && api.hub && (
        <SupportHubConsole api={api.hub} onPendingChange={setHubPending} onOpenSettings={() => setView("settings")} />
      )}
      {view === "settings" && api.getSettings && api.updateSettings && (
        <SupportSettingsPanel
          load={api.getSettings}
          save={api.updateSettings}
          hubStatus={api.hubStatus}
          checkGitHub={api.hub?.check}
        />
      )}
    </div>
  );
}

function TicketQueue({
  variant,
  api,
  onOpenSettings,
}: {
  variant: "admin" | "owner";
  api: SupportTicketsApi;
  onOpenSettings?: () => void;
}) {
  const [queue, setQueue] = useState<IssueReportQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueView>("open");
  const [statusFilter, setStatusFilter] = useState<"any" | IssueReportStatus>("any");
  const [kindFilter, setKindFilter] = useState<"all" | IssueReportKind>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setQueue(await api.queue());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Reports could not be loaded.");
    } finally {
      setRefreshing(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const multiTenant = useMemo(
    () => new Set((queue?.items ?? []).map((item) => item.tenant_id)).size > 1,
    [queue],
  );

  const counts = useMemo(() => {
    const items = queue?.items ?? [];
    const result: Record<string, number> = {};
    for (const option of VIEWS) result[option.value] = items.filter((item) => matchesView(item, option.value)).length;
    return result;
  }, [queue]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase().replace(/^#/, "");
    return (queue?.items ?? [])
      .filter((item) => matchesView(item, filter))
      .filter((item) => statusFilter === "any" || ticketStatus(item) === statusFilter)
      .filter((item) => kindFilter === "all" || ticketKind(item) === kindFilter)
      .filter((item) => {
        if (!needle) return true;
        return [item.subject, item.body, item.user_name, item.tenant_name ?? "", String(item.number ?? "")]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at));
  }, [queue, filter, statusFilter, kindFilter, search]);

  const replaceItem = (detail: IssueReportDetail) => {
    setQueue((current) =>
      current
        ? { ...current, items: current.items.map((item) => (item.id === detail.report.id ? detail.report : item)) }
        : current,
    );
  };

  return (
    <div className={clsx("support-queue", selectedId && "has-selection")}>
      <div className="ws-toolbar support-toolbar">
        <RailSwitch
          className="support-filters"
          ariaLabel="Filter reports"
          value={filter}
          onChange={(next) => {
            setFilter(next);
            setStatusFilter("any");
          }}
          options={VIEWS.map((option) => ({ ...option, count: counts[option.value] ?? 0 }))}
        />
        <div className="support-toolbar-row">
          <label className="support-search">
            <Search size={14} />
            <input
              type="search"
              aria-label="Search reports"
              placeholder="Search subject, person, or #number"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </label>
          <label className="compact-select-field">
            <span className="sr-only">Status</span>
            <SelectControl
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(event) => {
                const next = event.currentTarget.value as "any" | IssueReportStatus;
                setStatusFilter(next);
                if (next !== "any") setFilter("all");
              }}
            >
              <option value="any">Any status</option>
              {STATUS_ORDER.map((value) => (
                <option key={value} value={value}>{STATUS_LABELS[value]}</option>
              ))}
            </SelectControl>
          </label>
          <label className="compact-select-field">
            <span className="sr-only">Type</span>
            <SelectControl
              aria-label="Filter by type"
              value={kindFilter}
              onChange={(event) => setKindFilter(event.currentTarget.value as "all" | IssueReportKind)}
            >
              <option value="all">All types</option>
              {KIND_ORDER.map((kind) => (
                <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
              ))}
            </SelectControl>
          </label>
          <button className="secondary-button" type="button" onClick={() => void load()} disabled={refreshing}>
            <RefreshCw size={14} /> {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="support-queue-layout">
        <section className="support-queue-list" aria-label="Reports">
          {queue === null && !error ? (
            <div className="audit-empty-state"><span><strong>Loading reports…</strong></span></div>
          ) : visible.length === 0 ? (
            <div className="audit-empty-state">
              <Inbox size={18} />
              <span>
                <strong>{(queue?.items.length ?? 0) === 0 ? "No reports yet" : "Nothing matches"}</strong>
                <small>
                  {(queue?.items.length ?? 0) === 0
                    ? "Reports people send from Help › Report a problem appear here."
                    : "Try another filter or search."}
                </small>
              </span>
            </div>
          ) : (
            <ul>
              {visible.map((item) => {
                const status = ticketStatus(item);
                const needsReply = OPEN_STATUSES.has(status) && item.last_activity_by === "reporter";
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={clsx("support-ticket-row", selectedId === item.id && "is-selected", needsReply && "needs-reply")}
                      aria-label={`${ticketNumber(item)} ${item.subject}`}
                      aria-current={selectedId === item.id ? "true" : undefined}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <span className="support-ticket-row-top">
                        <span className="support-ticket-number">{ticketNumber(item)}</span>
                        <strong>{item.subject}</strong>
                      </span>
                      <span className="support-ticket-row-meta">
                        <span>
                          {item.user_name}
                          {multiTenant && item.tenant_name ? ` · ${item.tenant_name}` : ""} · {KIND_LABELS[ticketKind(item)]}
                        </span>
                        <time dateTime={item.updated_at ?? item.created_at}>{relativeTime(item.updated_at ?? item.created_at)}</time>
                      </span>
                      <span className="support-ticket-row-tags">
                        <Pill tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Pill>
                        {(item.priority === "high" || item.priority === "urgent") && (
                          <Pill tone={item.priority === "urgent" ? "danger" : "warning"}>{PRIORITY_LABELS[item.priority]}</Pill>
                        )}
                        {needsReply && <span className="support-needs-reply">Needs reply</span>}
                        {item.upstream && (
                          <span className="support-upstream-tag" title={UPSTREAM_LABELS[item.upstream.state]}>
                            <GitPullRequest size={12} /> {item.upstream.issue_number ? `#${item.upstream.issue_number}` : "Shared"}
                          </span>
                        )}
                        {item.screenshot_filename && <span className="support-shot-tag">Screenshot</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="support-queue-detail" aria-label="Selected report">
          {selectedId ? (
            <TicketDetail
              key={selectedId}
              variant={variant}
              api={api}
              reportId={selectedId}
              assignees={queue?.assignees ?? []}
              showTenant={multiTenant}
              onBack={() => setSelectedId(null)}
              onChanged={replaceItem}
              onOpenSettings={onOpenSettings}
            />
          ) : (
            <div className="audit-empty-state support-detail-empty">
              <MessageSquare size={18} />
              <span>
                <strong>Select a report</strong>
                <small>Read it, reply to the person, change its status, or share it with the maintainers.</small>
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TicketDetail({
  variant,
  api,
  reportId,
  assignees,
  showTenant,
  onBack,
  onChanged,
  onOpenSettings,
}: {
  variant: "admin" | "owner";
  api: SupportTicketsApi;
  reportId: string;
  assignees: { id: string; name: string }[];
  showTenant: boolean;
  onBack: () => void;
  onChanged: (detail: IssueReportDetail) => void;
  onOpenSettings?: () => void;
}) {
  const [detail, setDetail] = useState<IssueReportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reply, setReply] = useState("");
  const [visibility, setVisibility] = useState<"public" | "internal">("public");
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .get(reportId)
      .then((next) => {
        if (active) setDetail(next);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "This report could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [api, reportId]);

  const hasScreenshot = Boolean(detail?.report.screenshot_filename);
  useEffect(() => {
    if (!hasScreenshot || typeof URL.createObjectURL !== "function") return;
    let active = true;
    let objectUrl: string | null = null;
    api
      .loadScreenshot(reportId)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setScreenshotUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL?.(objectUrl);
    };
  }, [api, reportId, hasScreenshot]);

  const apply = async (run: () => Promise<IssueReportDetail>) => {
    setSaving(true);
    setError(null);
    try {
      const next = await run();
      setDetail(next);
      onChanged(next);
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The change could not be saved.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (!detail) {
    return (
      <div className="support-detail">
        <button className="back-link-button support-detail-back" type="button" onClick={onBack}>
          <ArrowLeft size={15} /> All reports
        </button>
        {error ? <p className="form-error" role="alert">{error}</p> : <p className="support-muted">Loading…</p>}
      </div>
    );
  }

  const report = detail.report;
  const status = ticketStatus(report);
  const diagnostics = report.diagnostics;
  const canShare = variant === "owner" && Boolean(api.draftUpstream && api.shareUpstream);

  const submitReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = reply.trim();
    if (!text) return;
    if (await apply(() => api.comment(report.id, { body: text, visibility }))) setReply("");
  };

  return (
    <div className="support-detail">
      <button className="back-link-button support-detail-back" type="button" onClick={onBack}>
        <ArrowLeft size={15} /> All reports
      </button>
      <header className="support-detail-header">
        <span className="support-ticket-number">{ticketNumber(report)}</span>
        <h3>{report.subject}</h3>
        <p>
          {report.user_name}
          {showTenant && report.tenant_name ? ` · ${report.tenant_name}` : ""} · sent{" "}
          <time dateTime={report.created_at} title={absoluteTime(report.created_at)}>{relativeTime(report.created_at)}</time>
        </p>
      </header>

      <div className="support-detail-controls">
        <label>
          <span>Status</span>
          <SelectControl
            aria-label="Status"
            value={status}
            disabled={saving}
            onChange={(event) => void apply(() => api.update(report.id, { status: event.currentTarget.value as IssueReportStatus }))}
          >
            {STATUS_ORDER.map((value) => (
              <option key={value} value={value}>{STATUS_LABELS[value]}</option>
            ))}
          </SelectControl>
        </label>
        <label>
          <span>Priority</span>
          <SelectControl
            aria-label="Priority"
            value={report.priority ?? "normal"}
            disabled={saving}
            onChange={(event) => void apply(() => api.update(report.id, { priority: event.currentTarget.value as IssueReportPriority }))}
          >
            {(["low", "normal", "high", "urgent"] as IssueReportPriority[]).map((value) => (
              <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>
            ))}
          </SelectControl>
        </label>
        <label>
          <span>Assignee</span>
          <SelectControl
            aria-label="Assignee"
            value={report.assignee_user_id ?? ""}
            disabled={saving}
            onChange={(event) => void apply(() => api.update(report.id, { assignee_user_id: event.currentTarget.value }))}
          >
            <option value="">Unassigned</option>
            {assignees.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </SelectControl>
        </label>
        <label>
          <span>Type</span>
          <SelectControl
            aria-label="Type"
            value={ticketKind(report)}
            disabled={saving}
            onChange={(event) => void apply(() => api.update(report.id, { kind: event.currentTarget.value as IssueReportKind }))}
          >
            {KIND_ORDER.map((value) => (
              <option key={value} value={value}>{KIND_LABELS[value]}</option>
            ))}
          </SelectControl>
        </label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}

      <article className="support-detail-message">
        <p className="ticket-message-kind"><TicketKindIcon kind={ticketKind(report)} /> {KIND_LABELS[ticketKind(report)]}{report.priority && report.priority !== "normal" ? ` · ${PRIORITY_LABELS[report.priority]} impact` : ""}</p>
        <p>{report.body}</p>
        {report.screenshot_filename && (
          <div className="ticket-screenshot">
            {screenshotUrl ? (
              <a href={screenshotUrl} target="_blank" rel="noreferrer">
                <img src={screenshotUrl} alt={`Screenshot attached to ${report.subject}`} />
              </a>
            ) : (
              <span>Loading screenshot…</span>
            )}
          </div>
        )}
      </article>

      {diagnostics && (
        <section className="support-diagnostics">
          <button type="button" className="issue-report-details-toggle" aria-expanded={diagnosticsOpen} onClick={() => setDiagnosticsOpen((open) => !open)}>
            Technical details
          </button>
          {diagnosticsOpen && (
            <dl>
              {diagnostics.app_version && (<><dt>Version</dt><dd>{diagnostics.app_version}</dd></>)}
              {diagnostics.reporter_role && (<><dt>Role</dt><dd>{diagnostics.reporter_role}</dd></>)}
              {diagnostics.route && (<><dt>Page</dt><dd>{diagnostics.route}</dd></>)}
              {diagnostics.viewport && (<><dt>Window</dt><dd>{[diagnostics.viewport, diagnostics.color_scheme].filter(Boolean).join(" · ")}</dd></>)}
              {diagnostics.user_agent && (<><dt>Browser</dt><dd>{diagnostics.user_agent}</dd></>)}
              {diagnostics.timezone && (<><dt>Time zone</dt><dd>{diagnostics.timezone}</dd></>)}
              <dt>Recent errors</dt>
              <dd>
                {diagnostics.recent_errors?.length
                  ? diagnostics.recent_errors.map((entry, index) => <code key={index}>{entry.message}</code>)
                  : "None"}
              </dd>
              <dt>Failed requests</dt>
              <dd>
                {diagnostics.failed_requests?.length
                  ? diagnostics.failed_requests.map((entry, index) => <code key={index}>{`${entry.method} ${entry.path} → ${entry.status}`}</code>)
                  : "None"}
              </dd>
            </dl>
          )}
        </section>
      )}

      {variant === "owner" && (
        <UpstreamCard
          report={report}
          canShare={canShare}
          busy={saving}
          onShare={() => setShareOpen(true)}
          onRefresh={api.refreshUpstream ? () => void apply(() => api.refreshUpstream!(report.id)) : undefined}
        />
      )}

      <ol className="ticket-timeline support-timeline" aria-label="Activity">
        {detail.events.length === 0 && <li className="ticket-event"><span>No replies yet.</span></li>}
        {detail.events.map((event) =>
          event.kind === "comment" || event.body ? (
            <li
              key={event.id}
              className={clsx(
                "ticket-message",
                event.actor_kind === "reporter" ? "is-reporter" : "is-support",
                event.visibility === "internal" && "is-internal",
              )}
            >
              <div className="ticket-message-head">
                <strong>{event.actor_name || (event.actor_kind === "system" ? "System" : "Support")}</strong>
                {event.visibility === "internal" && <span className="support-internal-tag"><Lock size={11} /> Internal note</span>}
                <time dateTime={event.created_at} title={absoluteTime(event.created_at)}>{relativeTime(event.created_at)}</time>
              </div>
              {event.kind !== "comment" && <p className="ticket-message-kind">{describeEvent(event)}</p>}
              {event.kind !== "upstream" && <p>{event.body}</p>}
            </li>
          ) : (
            <li key={event.id} className={clsx("ticket-event", event.visibility === "internal" && "is-internal")}>
              <span>
                <strong>{event.actor_name}</strong> {describeEvent(event).replace(/^./, (letter) => letter.toLowerCase())}
              </span>
              <time dateTime={event.created_at} title={absoluteTime(event.created_at)}>{relativeTime(event.created_at)}</time>
            </li>
          ),
        )}
      </ol>

      <form className={clsx("ticket-composer support-composer", visibility === "internal" && "is-internal")} onSubmit={submitReply}>
        <RailSwitch
          ariaLabel="Reply visibility"
          value={visibility}
          onChange={setVisibility}
          options={[
            {
              value: "public",
              label: `Reply to ${report.user_name.split(" ")[0] || "reporter"}`,
              icon: <MessageSquare size={14} />,
            },
            { value: "internal", label: "Internal note", icon: <Lock size={14} /> },
          ]}
        />
        <textarea
          aria-label={visibility === "public" ? "Reply" : "Internal note"}
          rows={3}
          maxLength={5000}
          value={reply}
          onChange={(event) => setReply(event.currentTarget.value)}
          placeholder={visibility === "public" ? "The person sees this in My reports." : "Only administrators see internal notes."}
        />
        <div className="support-composer-actions">
          <button className="primary-button" type="submit" disabled={saving || !reply.trim()}>
            <Send size={14} /> {visibility === "public" ? "Send reply" : "Add note"}
          </button>
          {visibility === "public" && OPEN_STATUSES.has(status) && (
            <button
              className="secondary-button"
              type="button"
              disabled={saving || !reply.trim()}
              onClick={() =>
                void apply(() => api.update(report.id, { status: "resolved", note: reply.trim() })).then((ok) => {
                  if (ok) setReply("");
                })
              }
            >
              Reply and resolve
            </button>
          )}
        </div>
      </form>

      {shareOpen && api.draftUpstream && api.shareUpstream && (
        <ShareUpstreamDialog
          report={report}
          draft={(payload) => api.draftUpstream!(report.id, payload)}
          share={(payload) => api.shareUpstream!(report.id, payload)}
          onOpenSettings={onOpenSettings}
          onClose={() => setShareOpen(false)}
          onShared={(next) => {
            setDetail(next);
            onChanged(next);
            setShareOpen(false);
          }}
        />
      )}
    </div>
  );
}

function UpstreamCard({
  report,
  canShare,
  busy,
  onShare,
  onRefresh,
}: {
  report: IssueReportListItem;
  canShare: boolean;
  busy: boolean;
  onShare: () => void;
  onRefresh?: () => void;
}) {
  const upstream = report.upstream;
  if (!upstream) {
    if (!canShare) return null;
    return (
      <section className="ticket-upstream-card support-upstream">
        <GitPullRequest size={16} />
        <span>
          <strong>Aperture Chat maintainers</strong>
          <small>
            {ticketKind(report) === "security"
              ? "Security concerns are reported privately, never as public issues."
              : "Share a redacted copy so it can be tracked as a GitHub issue. You review the text first."}
          </small>
        </span>
        <button className="secondary-button" type="button" onClick={onShare} disabled={busy}>
          <Share2 size={14} /> {ticketKind(report) === "security" ? "Report privately" : "Share with maintainers"}
        </button>
      </section>
    );
  }
  const issue = issueStateLabel(upstream);
  return (
    <section className={clsx("ticket-upstream-card support-upstream", upstream.state === "failed" && "is-failed")}>
      <GitPullRequest size={16} />
      <span>
        <strong>{UPSTREAM_LABELS[upstream.state]}{issue ? ` · ${issue}` : ""}</strong>
        <small>
          {upstream.state === "failed"
            ? `${upstream.last_error ?? "The hub could not be reached."} ${upstream.attempts} attempt${upstream.attempts === 1 ? "" : "s"}.`
            : upstream.maintainer_note
              ? `Maintainer note: ${upstream.maintainer_note}`
              : `Shared ${relativeTime(upstream.sent_at ?? upstream.queued_at)}${upstream.shared_by_name ? ` by ${upstream.shared_by_name}` : ""}${upstream.checked_at ? ` · checked ${relativeTime(upstream.checked_at)}` : ""}`}
        </small>
      </span>
      <span className="support-upstream-actions">
        {upstream.issue_url && (
          <a className="ticket-upstream-link" href={upstream.issue_url} target="_blank" rel="noreferrer noopener">
            GitHub <ExternalLink size={13} />
          </a>
        )}
        {upstream.state === "failed" && canShare && (
          <button className="secondary-button" type="button" onClick={onShare} disabled={busy}>Edit and resend</button>
        )}
        {onRefresh && upstream.state !== "declined" && upstream.state !== "private" && (
          <button className="secondary-button" type="button" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={13} /> {upstream.state === "failed" || upstream.state === "queued" ? "Retry now" : "Check status"}
          </button>
        )}
      </span>
    </section>
  );
}

function ShareUpstreamDialog({
  report,
  draft,
  share,
  onOpenSettings,
  onClose,
  onShared,
}: {
  report: IssueReportListItem;
  draft: (payload: { use_ai?: boolean; include_diagnostics?: boolean }) => Promise<IssueReportUpstreamDraft>;
  share: (payload: { title: string; body: string; include_diagnostics: boolean }) => Promise<IssueReportDetail>;
  onOpenSettings?: () => void;
  onClose: () => void;
  onShared: (detail: IssueReportDetail) => void;
}) {
  const titleId = useId();
  const [current, setCurrent] = useState<IssueReportUpstreamDraft | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [loading, setLoading] = useState<"draft" | "ai" | "send" | null>("draft");
  const [error, setError] = useState<string | null>(null);

  const loadDraft = useCallback(
    async (useAi: boolean, withDiagnostics: boolean, keepText = false) => {
      setLoading(useAi ? "ai" : "draft");
      setError(null);
      try {
        const next = await draft({ use_ai: useAi, include_diagnostics: withDiagnostics });
        setCurrent(next);
        // Toggling technical details only refreshes the preview; it never
        // throws away an AI rewrite or the owner's edits.
        if (!keepText) {
          setTitle(next.title);
          setBody(next.body);
        }
        if (next.ai_error) setError(next.ai_error);
      } catch (draftError) {
        setError(draftError instanceof Error ? draftError.message : "The draft could not be prepared.");
      } finally {
        setLoading(null);
      }
    },
    [draft],
  );

  useEffect(() => {
    void loadDraft(false, true);
  }, [loadDraft]);

  const send = async () => {
    setLoading("send");
    setError(null);
    try {
      onShared(await share({ title: title.trim(), body: body.trim(), include_diagnostics: includeDiagnostics }));
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "The report could not be shared.");
      setLoading(null);
    }
  };

  const blocked = current ? !current.hub_available : false;

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={() => loading !== "send" && onClose()}>
      <section
        className="modal support-share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon"><Share2 size={20} /></span>
          <div>
            <h2 id={titleId}>Share with the Aperture Chat maintainers</h2>
            <p>
              {ticketNumber(report)} {report.subject}
            </p>
          </div>
          <button className="icon-button" type="button" aria-label="Close" onClick={onClose} disabled={loading === "send"}>
            <X size={17} />
          </button>
        </div>
        <div className="support-share-body">
          <p className="support-share-explainer">
            Nothing leaves this platform until you send. Names, organizations, email addresses,
            links, hosts, and keys are replaced with placeholders, and screenshots never leave. The
            maintainers' community hub reviews it and files a public GitHub issue; this ticket then
            shows the issue's status.
          </p>
          {loading === "draft" && !current ? (
            <p className="support-muted">Preparing a redacted draft…</p>
          ) : blocked ? (
            <div className="ws-notice is-warning" role="note">
              <p>{current?.blocked_reason}</p>
              {onOpenSettings && current?.blocked_reason?.includes("Reports settings") && (
                <button className="secondary-button" type="button" onClick={onOpenSettings}>Open settings</button>
              )}
            </div>
          ) : (
            <>
              <label className="support-field">
                <span>Issue title</span>
                <input maxLength={200} value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
              </label>
              <label className="support-field">
                <span>Description</span>
                <textarea rows={8} maxLength={12000} value={body} onChange={(event) => setBody(event.currentTarget.value)} />
              </label>
              <div className="support-share-options">
                <label className="issue-report-check">
                  <input
                    type="checkbox"
                    checked={includeDiagnostics}
                    onChange={(event) => {
                      setIncludeDiagnostics(event.currentTarget.checked);
                      void loadDraft(false, event.currentTarget.checked, true);
                    }}
                  />
                  <span>Include technical details (version, browser, page, recent errors)</span>
                </label>
                <button className="secondary-button" type="button" disabled={loading !== null} onClick={() => void loadDraft(true, includeDiagnostics)}>
                  <Sparkles size={14} /> {loading === "ai" ? "Rewriting…" : "Rewrite with AI"}
                </button>
              </div>
              {current && (
                <p className="support-muted">
                  {current.redaction_count > 0
                    ? `${current.redaction_count} value${current.redaction_count === 1 ? " was" : "s were"} replaced with placeholders.`
                    : "Nothing needed redacting."}
                  {current.ai_drafted ? " Rewritten by the support assistant; review it before sending." : ""}
                </p>
              )}
              {current?.preview_markdown && (
                <details className="support-share-preview">
                  <summary>Preview the GitHub issue</summary>
                  {body.trim() !== current.body.trim() && (
                    <p className="support-muted">Your edited description replaces the draft text shown here.</p>
                  )}
                  <pre>{current.preview_markdown}</pre>
                </details>
              )}
            </>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-actions support-share-actions">
          {current?.github_new_issue_url && (
            <a className="support-github-link" href={current.github_new_issue_url} target="_blank" rel="noreferrer noopener">
              {ticketKind(report) === "security" ? "Open a private security advisory" : "Or open a prefilled GitHub issue yourself"}{" "}
              <ExternalLink size={13} />
            </a>
          )}
          <button className="secondary-button" type="button" onClick={onClose} disabled={loading === "send"}>Cancel</button>
          {!blocked && (
            <button
              className="primary-button"
              type="button"
              disabled={loading !== null || title.trim().length < 4 || body.trim().length < 10}
              onClick={() => void send()}
            >
              <Send size={14} /> {loading === "send" ? "Sending…" : "Send to maintainers"}
            </button>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
