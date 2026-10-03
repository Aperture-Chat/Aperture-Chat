import { BarChart3, Clock3, Layers, LineChart, ShieldAlert, Users } from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AuditEvent, SecurityAlert } from "../lib/types";
import {
  AuditInvestigationDialog,
  type AuditInvestigationSection,
  type AuditSummaryItem,
} from "./AuditSummaryCard";

type RangeDays = 7 | 14 | 30;
type Severity = "info" | "warning" | "critical";

const RANGE_OPTIONS: Array<{ days: RangeDays; label: string }> = [
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
];
const SEVERITY_ORDER: Severity[] = ["critical", "warning", "info"];
const SEVERITY_LABELS: Record<Severity, string> = { critical: "Critical", warning: "Warning", info: "Info" };
const BAR_ROW_LIMIT = 6;
const BUSINESS_HOURS_START = 7;
const BUSINESS_HOURS_END = 19;

// Friendly names for audit action namespaces (the text before the first dot).
const AREA_LABELS: Record<string, string> = {
  admin: "Administration",
  agent: "Agents",
  aperture: "Workspace runtime",
  auth: "Sign-in & identity",
  automation: "Automations",
  chat: "Chat",
  gateway: "API gateway",
  hermes: "Assistant memory",
  knowledge: "Knowledge",
  matter: "Matters",
  memory: "Memory",
  platform: "Platform",
  retention: "Retention",
  scim: "SCIM provisioning",
  security: "Security",
};

export type AuditInsightsProps = {
  events: AuditEvent[];
  alerts: SecurityAlert[];
  formatTimestamp: (value: string) => string;
  formatRole?: (role: string) => string;
  modelName?: (modelId: string) => string;
  /** Page sizes the data was loaded with; reaching one means older history was cut off. */
  eventLimit?: number;
  alertLimit?: number;
};

/** Trend charts for the audit dashboard: severity by day, security alerts,
 * who is acting, which areas are changing, and when. Every mark opens the
 * shared investigation dialog with the records behind it. */
export function AuditInsights({
  events,
  alerts,
  formatTimestamp,
  formatRole = defaultRoleLabel,
  modelName = (modelId) => modelId,
  eventLimit,
  alertLimit,
}: AuditInsightsProps) {
  const [rangeDays, setRangeDays] = useState<RangeDays>(14);
  const [alertDimension, setAlertDimension] = useState<"rule" | "person">("rule");
  const [investigation, setInvestigation] = useState<AuditSummaryItem | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const insight = useMemo(
    () => buildInsights(events, alerts, rangeDays),
    [events, alerts, rangeDays],
  );
  const describeEvent = (event: AuditEvent) =>
    `${event.actor_name || event.actor_id} · ${event.target_name || event.target || "No target"} · ${formatTimestamp(event.created_at)}${event.detail ? ` · ${event.detail}` : ""}`;
  const describeAlert = (alert: SecurityAlert) =>
    `${alert.user_name || alert.user_id} · ${modelName(alert.model_id) || "unknown model"} · ${alert.severity} ${alert.category} · ${alert.surface} · ${formatTimestamp(alert.created_at)}${alert.snippet ? ` · ${alert.snippet}` : ""}`;

  const eventSections = (rows: AuditEvent[]): AuditInvestigationSection[] =>
    SEVERITY_ORDER.map((severity) => ({
      label: `${SEVERITY_LABELS[severity]} events`,
      emptyText: `No ${severity}-severity events in this slice.`,
      items: rows
        .filter((event) => eventSeverity(event) === severity)
        .map((event) => ({ label: event.action_type || event.action, detail: describeEvent(event) })),
    }));
  const alertSections = (rows: SecurityAlert[]): AuditInvestigationSection[] => [
    {
      label: "Open alerts",
      emptyText: "No open alerts in this slice.",
      items: rows.filter((alert) => !alert.acknowledged).map((alert) => ({ label: alert.rule_label, detail: describeAlert(alert) })),
    },
    {
      label: "Acknowledged alerts",
      emptyText: "No acknowledged alerts in this slice.",
      items: rows.filter((alert) => alert.acknowledged).map((alert) => ({ label: alert.rule_label, detail: describeAlert(alert) })),
    },
  ];

  const inspect = (item: AuditSummaryItem) => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInvestigation(item);
  };
  const inspectEvents = (label: string, detail: string, description: string, rows: AuditEvent[]) =>
    inspect({
      label,
      value: rows.length.toLocaleString(),
      detail,
      issue: rows.some((event) => eventSeverity(event) === "critical"),
      description,
      sections: eventSections(rows),
    });
  const inspectAlerts = (label: string, detail: string, description: string, rows: SecurityAlert[]) =>
    inspect({
      label,
      value: rows.length.toLocaleString(),
      detail,
      issue: rows.some((alert) => !alert.acknowledged),
      description,
      sections: alertSections(rows),
    });

  const rangeLabel = `the last ${rangeDays} days`;
  const coverageNotes = [
    eventLimit && events.length >= eventLimit && insight.oldestEventMs > insight.rangeStartMs
      ? `the newest ${eventLimit.toLocaleString()} audit events reach back only to ${formatDay(new Date(insight.oldestEventMs))}`
      : "",
    alertLimit && alerts.length >= alertLimit && insight.oldestAlertMs > insight.rangeStartMs
      ? `the newest ${alertLimit.toLocaleString()} security alerts reach back only to ${formatDay(new Date(insight.oldestAlertMs))}`
      : "",
  ].filter(Boolean);
  const alertBars = alertDimension === "rule" ? insight.alertsByRule : insight.alertsByPerson;

  return (
    <div className="audit-insights">
      <div className="audit-insights-toolbar">
        <p>
          <strong>
            {insight.events.length.toLocaleString()} audit event{insight.events.length === 1 ? "" : "s"} ·{" "}
            {insight.alerts.length.toLocaleString()} security alert{insight.alerts.length === 1 ? "" : "s"}
          </strong>
          <small>
            {formatDay(new Date(insight.rangeStartMs))} – {formatDay(new Date())} · select any bar or point to inspect its
            records
          </small>
        </p>
        <div className="status-filter" role="radiogroup" aria-label="Audit insights range">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.days}
              type="button"
              role="radio"
              aria-checked={rangeDays === option.days}
              className={`status-filter-option${rangeDays === option.days ? " is-selected" : ""}`}
              data-tooltip={`Chart audit activity from the last ${option.days} days`}
              onClick={() => setRangeDays(option.days)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {coverageNotes.length > 0 && (
        <p className="audit-insights-coverage">
          Earlier days may be incomplete: {coverageNotes.join("; ")}.
        </p>
      )}

      <div className="audit-insights-grid">
        <ChartCard
          wide
          icon={<BarChart3 size={16} />}
          title="Audit events by day"
          meta={`${insight.severityTotals.critical} critical · ${insight.severityTotals.warning} warning`}
          legend={SEVERITY_ORDER.slice().reverse().map((severity) => (
            <LegendKey key={severity} className={`is-${severity}`} label={SEVERITY_LABELS[severity]} />
          ))}
        >
          {insight.events.length === 0 ? (
            <ChartEmpty text={`No audit events were recorded in ${rangeLabel}.`} />
          ) : (
            <ColumnChart
              ariaLabel="Audit events by day, stacked by severity"
              max={insight.dayMax}
              labelStep={rangeDays === 7 ? 1 : rangeDays === 14 ? 2 : 5}
              columns={insight.days.map((day) => ({
                key: day.key,
                axisLabel: day.label,
                total: day.events.length,
                segments: (["info", "warning", "critical"] as Severity[]).map((severity) => ({
                  className: `is-${severity}`,
                  value: day.severity[severity],
                })),
                tooltip: `${day.events.length.toLocaleString()} event${day.events.length === 1 ? "" : "s"} · ${day.longLabel} — ${day.severity.critical} critical, ${day.severity.warning} warning, ${day.severity.info} info`,
                onSelect: () =>
                  inspectEvents(
                    `Audit events · ${day.label}`,
                    `events on ${day.longLabel}`,
                    `Every loaded audit event recorded on ${day.longLabel}, grouped by derived severity.`,
                    day.events,
                  ),
              }))}
            />
          )}
        </ChartCard>

        <ChartCard
          icon={<LineChart size={16} />}
          title="Security alerts by day"
          meta={`${insight.openAlertCount} open`}
          legend={[
            <LegendKey key="dlp" line className="is-series-1" label={`DLP ${insight.alertCategoryTotals.dlp}`} />,
            <LegendKey key="behavior" line className="is-series-2" label={`Behavior ${insight.alertCategoryTotals.behavior}`} />,
          ]}
        >
          {insight.alerts.length === 0 ? (
            <ChartEmpty text={`No DLP or misuse alerts were raised in ${rangeLabel}.`} />
          ) : (
            <TrendChart
              ariaLabel="Security alerts by day, DLP and behavior"
              max={insight.alertDayMax}
              labelStep={rangeDays === 7 ? 1 : rangeDays === 14 ? 2 : 5}
              points={insight.days.map((day) => ({
                key: day.key,
                axisLabel: day.label,
                values: [day.alertCategories.dlp, day.alertCategories.behavior],
                tooltip: `${day.alerts.length} alert${day.alerts.length === 1 ? "" : "s"} · ${day.longLabel} — DLP ${day.alertCategories.dlp}, behavior ${day.alertCategories.behavior}`,
                onSelect:
                  day.alerts.length > 0
                    ? () =>
                        inspectAlerts(
                          `Security alerts · ${day.label}`,
                          `alerts raised on ${day.longLabel}`,
                          `DLP and behavior alerts raised on ${day.longLabel}, split by review status.`,
                          day.alerts,
                        )
                    : undefined,
              }))}
              seriesClassNames={["is-series-1", "is-series-2"]}
            />
          )}
        </ChartCard>

        <ChartCard
          icon={<ShieldAlert size={16} />}
          title="Alert breakdown"
          meta={
            <div className="audit-chart-toggle" role="radiogroup" aria-label="Group security alerts by">
              {(["rule", "person"] as const).map((dimension) => (
                <button
                  key={dimension}
                  type="button"
                  role="radio"
                  aria-checked={alertDimension === dimension}
                  className={alertDimension === dimension ? "is-selected" : undefined}
                  data-tooltip={dimension === "rule" ? "Rank alerts by the rule that raised them" : "Rank alerts by the person who triggered them"}
                  onClick={() => setAlertDimension(dimension)}
                >
                  {dimension === "rule" ? "By rule" : "By person"}
                </button>
              ))}
            </div>
          }
        >
          {alertBars.length === 0 ? (
            <ChartEmpty text={`No alerts to rank in ${rangeLabel}.`} />
          ) : (
            <BarList
              ariaLabel={alertDimension === "rule" ? "Security alerts by rule" : "Security alerts by person"}
              rows={alertBars.map((row) => ({
                key: row.key,
                label: row.label,
                detail: `${row.open} open · ${row.items.length - row.open} acknowledged`,
                value: row.items.length,
                onSelect: () =>
                  inspectAlerts(
                    row.label,
                    `alerts in ${rangeLabel}`,
                    alertDimension === "rule"
                      ? `Alerts raised by ${row.otherCount ? "the remaining rules" : "this rule"} in ${rangeLabel}.`
                      : `Alerts triggered by ${row.otherCount ? "the remaining people" : "this person"} in ${rangeLabel}.`,
                    row.items,
                  ),
              }))}
            />
          )}
        </ChartCard>

        <ChartCard icon={<Users size={16} />} title="Most active people" meta={`${insight.actorCount} active`}>
          {insight.actors.length === 0 ? (
            <ChartEmpty text={`No actors recorded in ${rangeLabel}.`} />
          ) : (
            <BarList
              ariaLabel="Audit events by person"
              rows={insight.actors.map((row) => ({
                key: row.key,
                label: row.label,
                detail: [
                  row.role ? formatRole(row.role) : "",
                  `${row.changes} change${row.changes === 1 ? "" : "s"}`,
                  row.critical ? `${row.critical} critical` : "",
                ]
                  .filter(Boolean)
                  .join(" · "),
                value: row.items.length,
                onSelect: () =>
                  inspectEvents(
                    row.label,
                    `events in ${rangeLabel}`,
                    row.otherCount
                      ? `Audit events from the ${row.otherCount} less active people in ${rangeLabel}.`
                      : `Every loaded audit event this person generated in ${rangeLabel}.`,
                    row.items,
                  ),
              }))}
            />
          )}
        </ChartCard>

        <ChartCard icon={<Layers size={16} />} title="Activity by area" meta={`${insight.changeCount} governance changes`}>
          {insight.areas.length === 0 ? (
            <ChartEmpty text={`No audit activity in ${rangeLabel}.`} />
          ) : (
            <BarList
              ariaLabel="Audit events by area"
              rows={insight.areas.map((row) => ({
                key: row.key,
                label: row.label,
                detail: [
                  row.critical ? `${row.critical} critical` : "",
                  row.warning ? `${row.warning} warning` : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || "Routine activity",
                value: row.items.length,
                onSelect: () =>
                  inspectEvents(
                    row.label,
                    `events in ${rangeLabel}`,
                    `Audit events in the ${row.label.toLowerCase()} area in ${rangeLabel}.`,
                    row.items,
                  ),
              }))}
            />
          )}
        </ChartCard>

        <ChartCard
          wide
          icon={<Clock3 size={16} />}
          title="Activity by hour"
          meta={`${insight.afterHoursCount} after hours · your local time`}
          legend={[<LegendKey key="after-hours" className="is-after-hours" label="Outside 7 AM – 7 PM" />]}
        >
          {insight.events.length === 0 ? (
            <ChartEmpty text={`No audit events were recorded in ${rangeLabel}.`} />
          ) : (
            <ColumnChart
              ariaLabel="Audit events by hour of day"
              max={insight.hourMax}
              labelStep={2}
              anchor="start"
              columns={insight.hours.map((hour) => ({
                key: String(hour.hour),
                axisLabel: hour.shortLabel,
                total: hour.events.length,
                shaded: hour.hour < BUSINESS_HOURS_START || hour.hour >= BUSINESS_HOURS_END,
                segments: [{ className: "is-series-1", value: hour.events.length }],
                tooltip: `${hour.events.length.toLocaleString()} event${hour.events.length === 1 ? "" : "s"} · ${hour.rangeLabel}`,
                onSelect: () =>
                  inspectEvents(
                    `Activity · ${hour.rangeLabel}`,
                    `events between ${hour.rangeLabel}`,
                    `Audit events recorded between ${hour.rangeLabel} (your local time) on any day in ${rangeLabel}.`,
                    hour.events,
                  ),
              }))}
            />
          )}
        </ChartCard>
      </div>

      {investigation && (
        <AuditInvestigationDialog
          item={investigation}
          intro="Review the records behind this chart."
          onClose={() => {
            setInvestigation(null);
            const target = returnFocusRef.current;
            window.setTimeout(() => target?.focus(), 0);
          }}
        />
      )}
    </div>
  );
}

function ChartCard({
  title,
  icon,
  meta,
  legend,
  wide = false,
  children,
}: {
  title: string;
  icon: ReactNode;
  meta?: ReactNode;
  legend?: ReactNode[];
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`audit-chart-card${wide ? " is-wide" : ""}`} aria-label={title}>
      <header className="audit-chart-header">
        <span>
          {icon}
          <strong>{title}</strong>
        </span>
        {typeof meta === "string" ? <small>{meta}</small> : meta}
      </header>
      {legend && legend.length > 0 && <div className="audit-chart-legend">{legend}</div>}
      {children}
    </section>
  );
}

function LegendKey({ label, className, line = false }: { label: string; className: string; line?: boolean }) {
  return (
    <span className="audit-chart-legend-item">
      <i className={`audit-chart-key${line ? " is-line" : ""} ${className}`} aria-hidden="true" />
      {label}
    </span>
  );
}

function ChartEmpty({ text }: { text: string }) {
  return <p className="audit-chart-empty">{text}</p>;
}

type ColumnDatum = {
  key: string;
  axisLabel: string;
  total: number;
  segments: Array<{ className: string; value: number }>;
  tooltip: string;
  shaded?: boolean;
  onSelect: () => void;
};

function ColumnChart({
  columns,
  max,
  labelStep,
  anchor = "end",
  ariaLabel,
}: {
  columns: ColumnDatum[];
  max: number;
  labelStep: number;
  /** Which end the axis labels count from; "end" always labels the latest day. */
  anchor?: "start" | "end";
  ariaLabel: string;
}) {
  return (
    <div className="audit-chart-frame" role="group" aria-label={ariaLabel}>
      <YAxis max={max} />
      <div className="audit-chart-plot" style={{ "--audit-chart-slots": columns.length } as CSSProperties}>
        <Gridlines />
        <div className="audit-chart-columns">
          {columns.map((column) => {
            const slotClass = `audit-chart-slot${column.shaded ? " is-shaded" : ""}`;
            // The whole slot is the hit target, so short bars stay easy to select.
            return column.total > 0 ? (
              <button
                type="button"
                className={slotClass}
                key={column.key}
                aria-label={`${column.tooltip}. Inspect records.`}
                data-tooltip={column.tooltip}
                onClick={column.onSelect}
              >
                <span className="audit-chart-column" style={{ height: `${(column.total / max) * 100}%` }}>
                  {column.segments
                    .filter((segment) => segment.value > 0)
                    .map((segment) => (
                      <span
                        className={`audit-chart-segment ${segment.className}`}
                        key={segment.className}
                        style={{ flexGrow: segment.value }}
                      />
                    ))}
                </span>
              </button>
            ) : (
              <span className={slotClass} key={column.key} data-tooltip={column.tooltip} />
            );
          })}
        </div>
      </div>
      <XAxis labels={columns.map((column) => column.axisLabel)} step={labelStep} anchor={anchor} />
    </div>
  );
}

type TrendDatum = {
  key: string;
  axisLabel: string;
  values: number[];
  tooltip: string;
  onSelect?: () => void;
};

function TrendChart({
  points,
  max,
  labelStep,
  ariaLabel,
  seriesClassNames,
}: {
  points: TrendDatum[];
  max: number;
  labelStep: number;
  ariaLabel: string;
  seriesClassNames: string[];
}) {
  const xAt = (index: number) => ((index + 0.5) / points.length) * 100;
  const yAt = (value: number) => 100 - (value / max) * 100;
  return (
    <div className="audit-chart-frame" role="group" aria-label={ariaLabel}>
      <YAxis max={max} />
      <div className="audit-chart-plot" style={{ "--audit-chart-slots": points.length } as CSSProperties}>
        <Gridlines />
        <div className="audit-chart-hits">
          {points.map((point) =>
            point.onSelect ? (
              <button
                type="button"
                className="audit-chart-hit"
                key={point.key}
                aria-label={`${point.tooltip}. Inspect records.`}
                data-tooltip={point.tooltip}
                onClick={point.onSelect}
              />
            ) : (
              <span className="audit-chart-hit is-empty" key={point.key} data-tooltip={point.tooltip} />
            ),
          )}
        </div>
        <svg className="audit-chart-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {seriesClassNames.map((className, series) => (
            <polyline
              key={className}
              className={`audit-chart-line ${className}`}
              points={points.map((point, index) => `${xAt(index)},${yAt(point.values[series])}`).join(" ")}
            />
          ))}
        </svg>
        {seriesClassNames.map((className, series) =>
          points.map((point, index) =>
            point.values[series] > 0 || index === points.length - 1 ? (
              <span
                aria-hidden="true"
                className={`audit-chart-dot ${className}`}
                key={`${className}:${point.key}`}
                style={{ left: `${xAt(index)}%`, top: `${yAt(point.values[series])}%` }}
              />
            ) : null,
          ),
        )}
      </div>
      <XAxis labels={points.map((point) => point.axisLabel)} step={labelStep} anchor="end" />
    </div>
  );
}

type BarDatum = {
  key: string;
  label: string;
  detail: string;
  value: number;
  onSelect: () => void;
};

function BarList({ rows, ariaLabel }: { rows: BarDatum[]; ariaLabel: string }) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <div className="audit-bar-list" role="list" aria-label={ariaLabel}>
      {rows.map((row) => (
        <div role="listitem" key={row.key}>
          <button
            type="button"
            className="audit-bar-row"
            aria-label={`${row.label}: ${row.value.toLocaleString()} (${row.detail}). Inspect records.`}
            data-tooltip={`${row.value.toLocaleString()} · ${row.label} — ${row.detail}`}
            onClick={row.onSelect}
          >
            <span className="audit-bar-text">
              <strong>{row.label}</strong>
              <small>{row.detail}</small>
            </span>
            <b>{row.value.toLocaleString()}</b>
            <span className="audit-bar-track" aria-hidden="true">
              <span className="audit-bar-fill" style={{ width: `${(row.value / max) * 100}%` }} />
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}

function YAxis({ max }: { max: number }) {
  return (
    <div className="audit-chart-y" aria-hidden="true">
      <span>{max.toLocaleString()}</span>
      <span>{(max / 2).toLocaleString()}</span>
      <span>0</span>
    </div>
  );
}

function Gridlines() {
  return (
    <div className="audit-chart-gridlines" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}

function XAxis({ labels, step, anchor }: { labels: string[]; step: number; anchor: "start" | "end" }) {
  return (
    <div className="audit-chart-x" aria-hidden="true" style={{ "--audit-chart-slots": labels.length } as CSSProperties}>
      {labels.map((label, index) => {
        const offset = anchor === "end" ? labels.length - 1 - index : index;
        // Every other label is "minor" so narrow charts can drop it and stay legible.
        return (
          <span className={offset % (step * 2) === 0 ? undefined : "is-minor"} key={`${label}:${index}`}>
            {offset % step === 0 ? label : ""}
          </span>
        );
      })}
    </div>
  );
}

type GroupedBar<T> = {
  key: string;
  label: string;
  items: T[];
  /** Number of groups folded into this "Other" row; 0 for a real group. */
  otherCount: number;
};

function buildInsights(allEvents: AuditEvent[], allAlerts: SecurityAlert[], rangeDays: RangeDays) {
  const today = startOfLocalDay(new Date());
  const rangeStart = new Date(today);
  rangeStart.setDate(rangeStart.getDate() - (rangeDays - 1));
  const rangeStartMs = rangeStart.getTime();

  const datedEvents = allEvents
    .map((event) => ({ event, at: Date.parse(event.created_at) }))
    .filter((row) => !Number.isNaN(row.at));
  const datedAlerts = allAlerts
    .map((alert) => ({ alert, at: Date.parse(alert.created_at) }))
    .filter((row) => !Number.isNaN(row.at));
  const oldestEventMs = Math.min(...datedEvents.map((row) => row.at), Number.POSITIVE_INFINITY);
  const oldestAlertMs = Math.min(...datedAlerts.map((row) => row.at), Number.POSITIVE_INFINITY);
  const eventsInRange = datedEvents.filter((row) => row.at >= rangeStartMs);
  const alertsInRange = datedAlerts.filter((row) => row.at >= rangeStartMs);

  const days = Array.from({ length: rangeDays }, (_, index) => {
    const date = new Date(rangeStart);
    date.setDate(date.getDate() + index);
    return {
      key: localDayKey(date),
      label: formatDay(date),
      longLabel: date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
      events: [] as AuditEvent[],
      severity: { info: 0, warning: 0, critical: 0 } as Record<Severity, number>,
      alerts: [] as SecurityAlert[],
      alertCategories: { dlp: 0, behavior: 0 },
    };
  });
  const dayByKey = new Map(days.map((day) => [day.key, day]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    shortLabel: formatHour(hour),
    rangeLabel: `${formatHour(hour)} – ${formatHour((hour + 1) % 24)}`,
    events: [] as AuditEvent[],
  }));
  const severityTotals: Record<Severity, number> = { info: 0, warning: 0, critical: 0 };
  let afterHoursCount = 0;

  for (const { event, at } of eventsInRange) {
    const date = new Date(at);
    const severity = eventSeverity(event);
    severityTotals[severity] += 1;
    const day = dayByKey.get(localDayKey(date));
    if (day) {
      day.events.push(event);
      day.severity[severity] += 1;
    }
    hours[date.getHours()].events.push(event);
    if (date.getHours() < BUSINESS_HOURS_START || date.getHours() >= BUSINESS_HOURS_END) afterHoursCount += 1;
  }
  const alertCategoryTotals = { dlp: 0, behavior: 0 };
  for (const { alert, at } of alertsInRange) {
    const category = alert.category.toLowerCase() === "dlp" ? "dlp" : "behavior";
    alertCategoryTotals[category] += 1;
    const day = dayByKey.get(localDayKey(new Date(at)));
    if (day) {
      day.alerts.push(alert);
      day.alertCategories[category] += 1;
    }
  }

  const events = eventsInRange.map((row) => row.event);
  const alerts = alertsInRange.map((row) => row.alert);
  const actorGroups = groupTop(events, (event) => event.actor_id || event.actor_name, (event) => event.actor_name || event.actor_id, "Everyone else");
  const actorRoles = new Map(events.map((event) => [event.actor_id || event.actor_name, event.actor_role]));

  return {
    rangeStartMs,
    oldestEventMs,
    oldestAlertMs,
    events,
    alerts,
    days,
    hours,
    severityTotals,
    alertCategoryTotals,
    afterHoursCount,
    openAlertCount: alerts.filter((alert) => !alert.acknowledged).length,
    changeCount: events.filter(isGovernanceChange).length,
    actorCount: new Set(events.map((event) => event.actor_id || event.actor_name)).size,
    dayMax: niceCeiling(Math.max(...days.map((day) => day.events.length), 0)),
    alertDayMax: niceCeiling(Math.max(...days.flatMap((day) => [day.alertCategories.dlp, day.alertCategories.behavior]), 0)),
    hourMax: niceCeiling(Math.max(...hours.map((hour) => hour.events.length), 0)),
    actors: actorGroups.map((group) => ({
      ...group,
      role: group.otherCount ? "" : actorRoles.get(group.key) ?? "",
      changes: group.items.filter(isGovernanceChange).length,
      critical: group.items.filter((event) => eventSeverity(event) === "critical").length,
    })),
    areas: groupTop(events, eventArea, (event) => AREA_LABELS[eventArea(event)] ?? titleCase(eventArea(event)), "Other areas").map(
      (group) => ({
        ...group,
        critical: group.items.filter((event) => eventSeverity(event) === "critical").length,
        warning: group.items.filter((event) => eventSeverity(event) === "warning").length,
      }),
    ),
    alertsByRule: withOpenCounts(groupTop(alerts, (alert) => alert.rule_id || alert.rule_label, (alert) => alert.rule_label, "Other rules")),
    alertsByPerson: withOpenCounts(groupTop(alerts, (alert) => alert.user_id, (alert) => alert.user_name || alert.user_id, "Everyone else")),
  };
}

function withOpenCounts(groups: Array<GroupedBar<SecurityAlert>>) {
  return groups.map((group) => ({ ...group, open: group.items.filter((alert) => !alert.acknowledged).length }));
}

/** Ranks groups by size, keeping the top rows and folding the tail into one
 * "Other" row so the list never grows past BAR_ROW_LIMIT. */
function groupTop<T>(
  rows: T[],
  keyOf: (row: T) => string,
  labelOf: (row: T) => string,
  otherLabel: string,
): Array<GroupedBar<T>> {
  const groups = new Map<string, GroupedBar<T>>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? { key, label: labelOf(row), items: [], otherCount: 0 };
    group.items.push(row);
    groups.set(key, group);
  }
  const ranked = [...groups.values()].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  if (ranked.length <= BAR_ROW_LIMIT) return ranked;
  const kept = ranked.slice(0, BAR_ROW_LIMIT - 1);
  const folded = ranked.slice(BAR_ROW_LIMIT - 1);
  return [
    ...kept,
    {
      key: "__other__",
      label: `${otherLabel} (${folded.length})`,
      items: folded.flatMap((group) => group.items),
      otherCount: folded.length,
    },
  ];
}

export function eventSeverity(event: AuditEvent): Severity {
  // Severity is derived server-side; events from older API builds fall back to info.
  const severity = (event.severity || "").toLowerCase();
  return severity === "critical" || severity === "warning" ? severity : "info";
}

function eventArea(event: AuditEvent): string {
  return (event.action || event.action_type || "other").split(".")[0] || "other";
}

const GOVERNANCE_AREAS = new Set(["admin", "platform", "retention", "scim", "security"]);
const GOVERNANCE_AUTH_ACTIONS = new Set([
  "auth.api_key_created",
  "auth.api_key_revoked",
  "auth.api_key_rotated",
  "auth.bootstrap_owner_created",
  "auth.mfa_disabled",
  "auth.mfa_enabled",
  "auth.mfa_recovery_codes_regenerated",
  "auth.password_updated",
]);

/** Configuration, access, and security changes, as opposed to routine runtime
 * traffic such as chat completions, sign-ins, and knowledge lookups. */
export function isGovernanceChange(event: AuditEvent): boolean {
  return (
    GOVERNANCE_AREAS.has(eventArea(event)) ||
    GOVERNANCE_AUTH_ACTIONS.has(event.action) ||
    eventSeverity(event) !== "info"
  );
}

/** Outside 7 AM–7 PM or on a weekend, in the viewer's local time. */
export function isAfterHours(value: string): boolean {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const day = date.getDay();
  const hour = date.getHours();
  return day === 0 || day === 6 || hour < BUSINESS_HOURS_START || hour >= BUSINESS_HOURS_END;
}

/** Smallest of 2/4/6/8/10 × 10^k at or above the value, so the midpoint tick
 * is always a whole number. */
function niceCeiling(value: number): number {
  if (value <= 2) return 2;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [2, 4, 6, 8, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

function startOfLocalDay(date: Date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function localDayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDay(date: Date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatHour(hour: number) {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
}

function titleCase(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Other";
}

function defaultRoleLabel(role: string) {
  return titleCase(role.toLowerCase().replace(/_/g, " "));
}
