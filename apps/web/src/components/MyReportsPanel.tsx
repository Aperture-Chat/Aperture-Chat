import clsx from "clsx";
import { ArrowLeft, ExternalLink, GitPullRequest, Image, MessageSquare, Plus, RotateCcw, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  absoluteTime,
  describeEvent,
  isOpen,
  issueStateLabel,
  KIND_LABELS,
  relativeTime,
  STATUS_LABELS,
  STATUS_TONES,
  ticketKind,
  ticketNumber,
  ticketStatus,
  UPSTREAM_LABELS,
} from "../lib/supportLabels";
import type { IssueReportDetail, IssueReportListItem, IssueReportStatus } from "../lib/types";
import { Pill } from "./Primitives";
import { RailSwitch } from "./RailSwitch";
import { TicketKindIcon } from "./TicketKindIcon";

export type MyReportsApi = {
  list: () => Promise<IssueReportListItem[]>;
  get: (reportId: string) => Promise<IssueReportDetail>;
  markSeen: (reportId: string) => Promise<void>;
  reply: (reportId: string, body: string) => Promise<IssueReportDetail>;
  reopen: (reportId: string, body: string) => Promise<IssueReportDetail>;
  loadScreenshot: (reportId: string) => Promise<Blob>;
};

type Filter = "open" | "closed" | "all";

const TRACKER_STEPS: { key: IssueReportStatus; label: string }[] = [
  { key: "new", label: "Received" },
  { key: "in_review", label: "In review" },
  { key: "in_progress", label: "In progress" },
  { key: "resolved", label: "Resolved" },
];

function trackerIndex(status: IssueReportStatus): number {
  if (status === "on_hold") return 2;
  if (status === "closed") return 3;
  return Math.max(0, TRACKER_STEPS.findIndex((step) => step.key === status));
}

export function MyReportsPanel({
  api,
  focusReportId,
  onNewReport,
  onBackToHelp,
  onUnreadChange,
}: {
  api: MyReportsApi;
  focusReportId?: string | null;
  onNewReport: () => void;
  /** Shown on the list only; a report's detail view goes back to the list. */
  onBackToHelp?: () => void;
  onUnreadChange?: (count: number) => void;
}) {
  const [items, setItems] = useState<IssueReportListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [selectedId, setSelectedId] = useState<string | null>(focusReportId ?? null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.list();
      setItems(next);
      setLoadError(null);
      onUnreadChange?.(next.filter((item) => item.unread).length);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Your reports could not be loaded.");
    }
  }, [api, onUnreadChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (focusReportId) setSelectedId(focusReportId);
  }, [focusReportId]);

  const counts = useMemo(() => {
    const list = items ?? [];
    const open = list.filter(isOpen).length;
    return { open, closed: list.length - open, all: list.length };
  }, [items]);

  const visible = useMemo(() => {
    const list = items ?? [];
    if (filter === "open") return list.filter(isOpen);
    if (filter === "closed") return list.filter((item) => !isOpen(item));
    return list;
  }, [items, filter]);

  if (selectedId) {
    return (
      <MyReportDetail
        api={api}
        reportId={selectedId}
        onBack={() => {
          setSelectedId(null);
          void refresh();
        }}
        onSeen={(reportId) => {
          if (!items) return;
          const next = items.map((item) => (item.id === reportId ? { ...item, unread: false } : item));
          setItems(next);
          onUnreadChange?.(next.filter((item) => item.unread).length);
        }}
      />
    );
  }

  return (
    <div className="my-reports">
      <div className="my-reports-head">
        {onBackToHelp && (
          <button className="back-link-button" type="button" onClick={onBackToHelp}>
            <ArrowLeft size={15} /> Back to Help
          </button>
        )}
        <button className="secondary-button compact my-reports-new" type="button" onClick={onNewReport}>
          <Plus size={14} /> New report
        </button>
      </div>
      <RailSwitch
        ariaLabel="Show reports"
        block
        value={filter}
        onChange={setFilter}
        options={[
          { value: "open", label: "Open", count: counts.open },
          { value: "closed", label: "Closed", count: counts.closed },
          { value: "all", label: "All", count: counts.all },
        ]}
      />
      {loadError && <p className="form-error" role="alert">{loadError}</p>}
      {items === null && !loadError ? (
        <div className="drawer-card">
          <strong>Loading your reports…</strong>
        </div>
      ) : visible.length === 0 ? (
        <div className="drawer-card my-reports-empty">
          <strong>{counts.all === 0 ? "No reports yet" : filter === "open" ? "Nothing open" : "Nothing here"}</strong>
          <span>
            {counts.all === 0
              ? "When you report a problem or share an idea, you can follow it here."
              : "Switch the filter to see your other reports."}
          </span>
        </div>
      ) : (
        <ul className="my-reports-list" aria-label="Your reports">
          {visible.map((item) => {
            const status = ticketStatus(item);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={clsx("drawer-row my-report-row", item.unread && "is-unread")}
                  aria-label={`${ticketNumber(item)} ${item.subject}${item.unread ? ", new reply" : ""}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  {item.unread && <span className="chat-unread-dot" role="status" aria-label="New update" />}
                  <span className="my-report-row-main">
                    <strong>
                      <span className="my-report-number">{ticketNumber(item)}</span> {item.subject}
                    </strong>
                    <small>
                      {KIND_LABELS[ticketKind(item)]} · Updated {relativeTime(item.updated_at ?? item.created_at)}
                      {item.upstream?.issue_number ? ` · GitHub #${item.upstream.issue_number}` : ""}
                    </small>
                  </span>
                  <Pill tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Pill>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function MyReportDetail({
  api,
  reportId,
  onBack,
  onSeen,
}: {
  api: MyReportsApi;
  reportId: string;
  onBack: () => void;
  onSeen: (reportId: string) => void;
}) {
  const [detail, setDetail] = useState<IssueReportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDetail(null);
    api
      .get(reportId)
      .then((next) => {
        if (!active) return;
        setDetail(next);
        if (next.report.unread) {
          void api.markSeen(reportId).then(() => onSeen(reportId)).catch(() => undefined);
        }
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "This report could not be loaded.");
      });
    return () => {
      active = false;
    };
    // onSeen is a fresh closure each render; the fetch must run once per report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  if (!detail) {
    return (
      <div className="my-report-detail">
        <button className="back-link-button" type="button" onClick={onBack}>
          <ArrowLeft size={15} /> My reports
        </button>
        {error ? <p className="form-error" role="alert">{error}</p> : <div className="drawer-card"><strong>Loading…</strong></div>}
      </div>
    );
  }

  const report = detail.report;
  const status = ticketStatus(report);
  const open = isOpen(report);
  const step = trackerIndex(status);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = reply.trim();
    if (open && !text) return;
    setBusy(true);
    setError(null);
    try {
      const next = open ? await api.reply(report.id, text) : await api.reopen(report.id, text);
      setDetail(next);
      setReply("");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Your message could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-report-detail">
      <button className="back-link-button" type="button" onClick={onBack}>
        <ArrowLeft size={15} /> My reports
      </button>
      <div className="my-report-header">
        <span className="my-report-number">{ticketNumber(report)}</span>
        <h3>{report.subject}</h3>
        <Pill tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Pill>
      </div>
      <ol className={clsx("ticket-tracker", status === "closed" && "is-closed")} aria-label="Progress">
        {TRACKER_STEPS.map((entry, index) => (
          <li
            key={entry.key}
            className={clsx(index < step && "is-done", index === step && "is-current")}
            aria-current={index === step ? "step" : undefined}
          >
            <span className="ticket-tracker-dot" />
            <span>
              {index === step && status === "on_hold"
                ? "On hold"
                : index === step && status === "closed"
                  ? "Closed"
                  : entry.label}
            </span>
          </li>
        ))}
      </ol>
      {report.upstream && (
        <div className="ticket-upstream-card" role="note">
          <GitPullRequest size={16} />
          <span>
            <strong>{UPSTREAM_LABELS[report.upstream.state]}</strong>
            <small>
              {report.upstream.issue_number
                ? `Shared with the Aperture Chat maintainers · ${issueStateLabel(report.upstream)}`
                : "Shared with the Aperture Chat maintainers"}
            </small>
          </span>
          {report.upstream.issue_url && (
            <a href={report.upstream.issue_url} target="_blank" rel="noreferrer noopener" className="ticket-upstream-link">
              GitHub <ExternalLink size={13} />
            </a>
          )}
        </div>
      )}
      <ol className="ticket-timeline" aria-label="Conversation">
        <li className="ticket-message is-reporter">
          <div className="ticket-message-head">
            <strong>You</strong>
            <time dateTime={report.created_at} title={absoluteTime(report.created_at)}>
              {relativeTime(report.created_at)}
            </time>
          </div>
          <p className="ticket-message-kind">
            <TicketKindIcon kind={ticketKind(report)} /> {KIND_LABELS[ticketKind(report)]}
          </p>
          <p>{report.body}</p>
          {report.screenshot_filename && (
            <div className="ticket-screenshot">
              {screenshotUrl ? (
                <a href={screenshotUrl} target="_blank" rel="noreferrer">
                  <img src={screenshotUrl} alt={`Screenshot attached to ${report.subject}`} />
                </a>
              ) : (
                <span><Image size={14} /> {report.screenshot_filename}</span>
              )}
            </div>
          )}
        </li>
        {detail.events.map((event) =>
          event.kind === "comment" || (event.kind === "reopened" && event.body) || (event.kind === "status" && event.body) ? (
            <li
              key={event.id}
              className={clsx("ticket-message", event.actor_kind === "reporter" ? "is-reporter" : "is-support")}
            >
              <div className="ticket-message-head">
                <strong>{event.actor_kind === "reporter" ? "You" : event.actor_name || "Support team"}</strong>
                <time dateTime={event.created_at} title={absoluteTime(event.created_at)}>
                  {relativeTime(event.created_at)}
                </time>
              </div>
              {event.kind !== "comment" && <p className="ticket-message-kind">{describeEvent(event)}</p>}
              <p>{event.body}</p>
            </li>
          ) : (
            <li key={event.id} className="ticket-event">
              <span>{describeEvent(event)}</span>
              <time dateTime={event.created_at} title={absoluteTime(event.created_at)}>
                {relativeTime(event.created_at)}
              </time>
            </li>
          ),
        )}
      </ol>
      <form className="ticket-composer" onSubmit={submit}>
        <label>
          <span>{open ? "Add a reply" : "Still having this problem?"}</span>
          <textarea
            rows={3}
            maxLength={5000}
            value={reply}
            onChange={(event) => setReply(event.currentTarget.value)}
            placeholder={open ? "Add detail or answer a question from support" : "Tell support what's still happening (optional)"}
          />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className={open ? "primary-button" : "secondary-button"} type="submit" disabled={busy || (open && !reply.trim())}>
          {open ? <Send size={15} /> : <RotateCcw size={15} />}
          {busy ? "Sending…" : open ? "Send reply" : "Reopen report"}
        </button>
        {open && (
          <small className="ticket-composer-hint">
            <MessageSquare size={12} /> Replies go to your administrators.
          </small>
        )}
      </form>
    </div>
  );
}
