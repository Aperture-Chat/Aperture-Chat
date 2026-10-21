import type {
  IssueReportEvent,
  IssueReportKind,
  IssueReportListItem,
  IssueReportPriority,
  IssueReportStatus,
  IssueReportUpstreamView,
  SupportHubReportStatus,
} from "./types";

/** Shared wording for support tickets in the Help drawer and both consoles. */

export const STATUS_LABELS: Record<IssueReportStatus, string> = {
  new: "Received",
  in_review: "In review",
  in_progress: "In progress",
  on_hold: "On hold",
  resolved: "Resolved",
  closed: "Closed",
};

export const STATUS_ORDER: IssueReportStatus[] = [
  "new",
  "in_review",
  "in_progress",
  "on_hold",
  "resolved",
  "closed",
];

export const OPEN_STATUSES = new Set<IssueReportStatus>(["new", "in_review", "in_progress", "on_hold"]);

export type PillTone = "neutral" | "success" | "warning" | "danger" | "info";

export const STATUS_TONES: Record<IssueReportStatus, PillTone> = {
  new: "info",
  in_review: "info",
  in_progress: "warning",
  on_hold: "neutral",
  resolved: "success",
  closed: "neutral",
};

export const KIND_LABELS: Record<IssueReportKind, string> = {
  bug: "Problem",
  feature: "Idea",
  question: "Question",
  feedback: "Feedback",
  security: "Security concern",
};

export const KIND_ORDER: IssueReportKind[] = ["bug", "feature", "question", "feedback", "security"];

export const PRIORITY_LABELS: Record<IssueReportPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/** What the reporter picks; support can later raise a ticket to Urgent. */
export const IMPACT_OPTIONS: { value: "high" | "normal" | "low"; label: string }[] = [
  { value: "high", label: "Blocking me" },
  { value: "normal", label: "Slows me down" },
  { value: "low", label: "Minor" },
];

export const UPSTREAM_LABELS: Record<IssueReportUpstreamView["state"], string> = {
  queued: "Waiting to send",
  failed: "Send failed",
  sent: "With the maintainers",
  published: "Tracked on GitHub",
  declined: "Declined by the maintainers",
  private: "Held privately",
};

export const HUB_STATUS_LABELS: Record<SupportHubReportStatus, string> = {
  pending: "Needs review",
  private: "Private",
  published: "Published",
  linked: "Added to issue",
  declined: "Declined",
  spam: "Spam",
};

export const HUB_STATUS_TONES: Record<SupportHubReportStatus, PillTone> = {
  pending: "info",
  private: "warning",
  published: "success",
  linked: "success",
  declined: "neutral",
  spam: "danger",
};

export function ticketStatus(item: { status?: IssueReportStatus | null }): IssueReportStatus {
  return item.status ?? "new";
}

export function ticketKind(item: { kind?: IssueReportKind | null }): IssueReportKind {
  return item.kind ?? "bug";
}

export function ticketNumber(item: { number?: number | null }): string {
  return item.number ? `#${item.number}` : "";
}

export function isOpen(item: IssueReportListItem): boolean {
  return OPEN_STATUSES.has(ticketStatus(item));
}

export function issueStateLabel(upstream: IssueReportUpstreamView): string | null {
  if (!upstream.issue_number) return null;
  if (upstream.issue_state === "closed") {
    if (upstream.issue_state_reason === "completed") return `#${upstream.issue_number} fixed`;
    if (upstream.issue_state_reason === "duplicate") return `#${upstream.issue_number} duplicate`;
    return `#${upstream.issue_number} closed`;
  }
  return `#${upstream.issue_number} open`;
}

/** One-line description of a non-comment timeline entry. */
export function describeEvent(event: IssueReportEvent): string {
  const label = (value?: string | null) =>
    value ? (STATUS_LABELS as Record<string, string>)[value] ?? value : "";
  switch (event.kind) {
    case "status":
      return `Status changed to ${label(event.to_value)}`;
    case "reopened":
      return "Reopened the report";
    case "priority":
      return `Priority changed to ${(PRIORITY_LABELS as Record<string, string>)[event.to_value ?? ""] ?? event.to_value}`;
    case "kind":
      return `Type changed to ${(KIND_LABELS as Record<string, string>)[event.to_value ?? ""] ?? event.to_value}`;
    case "assignment":
      return event.to_value ? `Assigned to ${event.to_value}` : "Unassigned";
    case "upstream":
      return event.body;
    default:
      return event.body;
  }
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function relativeTime(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return "";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export function absoluteTime(value: string | null | undefined): string {
  if (!value) return "";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
