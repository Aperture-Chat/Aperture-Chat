import { ChevronRight, Eye, LayoutGrid, Rows3, Search, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type AuditInvestigationRow = {
  label: string;
  detail?: string;
};

export type AuditInvestigationSection = {
  label: string;
  items: AuditInvestigationRow[];
  emptyText: string;
};

export type AuditSummaryItem = {
  label: string;
  value: string;
  detail: string;
  issue: boolean;
  description: string;
  sections: AuditInvestigationSection[];
  /** Board group this signal renders under; see AuditSummaryBoard. */
  group?: string;
};

export type AuditSummaryGroup = {
  id: string;
  label: string;
};

type BoardLayout = "list" | "cards";
const BOARD_LAYOUT_KEY = "aperture-audit-board-layout";

function readBoardLayout(): BoardLayout {
  try {
    return window.localStorage.getItem(BOARD_LAYOUT_KEY) === "cards" ? "cards" : "list";
  } catch {
    return "list";
  }
}

/** Signals sorted into collapsible groups. Groups that need attention open by
 * default and all-clear groups fold to one summary line, so the board stays
 * short until someone asks for more. The compact list is the default layout;
 * the full cards remain one switch away. */
export function AuditSummaryBoard({ items, groups }: { items: AuditSummaryItem[]; groups: AuditSummaryGroup[] }) {
  const [layout, setLayout] = useState<BoardLayout>(readBoardLayout);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const issueCount = items.filter((item) => item.issue).length;
  const knownGroups = new Set(groups.map((group) => group.id));
  const sections = [
    ...groups.map((group) => ({ ...group, items: items.filter((item) => item.group === group.id) })),
    { id: "other", label: "Other signals", items: items.filter((item) => !item.group || !knownGroups.has(item.group)) },
  ]
    .filter((section) => section.items.length > 0)
    .map((section) => ({ ...section, issues: section.items.filter((item) => item.issue).length }));
  const isOpen = (section: (typeof sections)[number]) => openGroups[section.id] ?? section.issues > 0;
  const allOpen = sections.every(isOpen);

  const chooseLayout = (next: BoardLayout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(BOARD_LAYOUT_KEY, next);
    } catch {
      // Private browsing can refuse storage; the choice still applies this visit.
    }
  };

  return (
    <div className={`audit-summary-board is-${layout}`}>
      <div className={`audit-summary-attention${issueCount ? " is-issue" : ""}`}>
        {issueCount ? <ShieldAlert size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
        <strong>
          {issueCount ? `${issueCount} of ${items.length} signals need attention` : `All ${items.length} signals are clear`}
        </strong>
        <span className="audit-summary-controls">
          <button
            type="button"
            className="audit-summary-expand"
            data-tooltip={allOpen ? "Fold every group to its summary line" : "Show every signal in every group"}
            onClick={() =>
              setOpenGroups(Object.fromEntries(sections.map((section) => [section.id, !allOpen])))
            }
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
          <span className="audit-chart-toggle" role="radiogroup" aria-label="Signal layout">
            {(["list", "cards"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={layout === option}
                className={layout === option ? "is-selected" : undefined}
                data-tooltip={option === "list" ? "Compact rows: one line per signal" : "Full cards with each signal's description"}
                onClick={() => chooseLayout(option)}
              >
                {option === "list" ? <Rows3 size={13} aria-hidden="true" /> : <LayoutGrid size={13} aria-hidden="true" />}
                {option === "list" ? "List" : "Cards"}
              </button>
            ))}
          </span>
        </span>
      </div>
      {sections.map((section) => {
        const open = isOpen(section);
        const bodyId = `audit-group-${section.id}`;
        return (
          <section className={`audit-summary-group${open ? " is-open" : ""}`} key={section.id} aria-label={section.label}>
            <h3>
              <button
                type="button"
                className="audit-summary-group-toggle"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => setOpenGroups((current) => ({ ...current, [section.id]: !open }))}
              >
                <ChevronRight size={15} aria-hidden="true" />
                <span className="audit-summary-group-name">{section.label}</span>
                <span className="audit-summary-group-count">{section.items.length} signals</span>
                <span className={`audit-summary-group-status${section.issues ? " is-issue" : ""}`}>
                  {section.issues ? `${section.issues} need${section.issues === 1 ? "s" : ""} attention` : "Clear"}
                </span>
              </button>
            </h3>
            {open && (
              <div
                id={bodyId}
                className={layout === "cards" ? "audit-summary-grid" : "audit-signal-list"}
                role={layout === "cards" ? undefined : "list"}
              >
                {section.items.map((item) =>
                  layout === "cards" ? (
                    <AuditSummaryCard item={item} key={item.label} />
                  ) : (
                    <div role="listitem" key={item.label}>
                      <AuditSummaryCard item={item} variant="row" />
                    </div>
                  ),
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function AuditSummaryCard({ item, variant = "card" }: { item: AuditSummaryItem; variant?: "card" | "row" }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const tooltip =
    variant === "row"
      ? `${item.value} ${item.detail}. Select to review every record behind this signal.`
      : `Open ${item.label.toLowerCase()} details and review every record behind this metric.`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${variant === "row" ? "audit-signal-row" : "audit-summary-card"}${item.issue ? " is-issue" : ""}`}
        aria-label={`${item.label}: ${item.value} ${item.detail}. Open investigation.`}
        aria-haspopup="dialog"
        data-tooltip={tooltip}
        title={tooltip}
        onClick={() => setOpen(true)}
      >
        {variant === "row" ? (
          <>
            <span className="audit-signal-dot" aria-hidden="true" />
            <span className="audit-signal-label">{item.label}</span>
            <strong>{item.value}</strong>
            <ChevronRight size={14} aria-hidden="true" />
          </>
        ) : (
          <>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.detail}</small>
            <span className="audit-summary-card-action">
              <Eye size={13} aria-hidden="true" /> Inspect details
            </span>
          </>
        )}
      </button>

      {open && (
        <AuditInvestigationDialog
          item={item}
          onClose={() => {
            setOpen(false);
            window.setTimeout(() => triggerRef.current?.focus(), 0);
          }}
        />
      )}
    </>
  );
}

/** The record drill-down shared by summary cards and Audit Insights chart
 * marks, so every number on the audit dashboard opens the same review view. */
export function AuditInvestigationDialog({
  item,
  intro = "Review the records reflected in this dashboard metric.",
  onClose,
}: {
  item: AuditSummaryItem;
  intro?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const titleId = useId();
  const descriptionId = useId();
  const recordCount = item.sections.reduce((count, section) => count + section.items.length, 0);

  const visibleSections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return item.sections;
    return item.sections.map((section) => ({
      ...section,
      items: section.items.filter((row) =>
        `${row.label} ${row.detail ?? ""}`.toLowerCase().includes(needle),
      ),
    }));
  }, [item.sections, query]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  return createPortal(
    <div className="modal-backdrop audit-investigation-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal audit-investigation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className={`modal-icon audit-investigation-icon${item.issue ? " is-issue" : ""}`}>
            {item.issue ? <ShieldAlert size={21} /> : <Eye size={21} />}
          </span>
          <div>
            <span className="modal-kicker">Audit investigation</span>
            <h2 id={titleId}>{item.label}</h2>
            <p>{intro}</p>
          </div>
          <button
            autoFocus
            className="icon-button"
            type="button"
            aria-label={`Close ${item.label} investigation`}
            data-tooltip="Close investigation"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>

        <div className={`audit-investigation-metric${item.issue ? " is-issue" : ""}`}>
          <span>Current snapshot</span>
          <strong>{item.value}</strong>
          <small>{item.detail}</small>
        </div>

        <p className="audit-investigation-description" id={descriptionId}>
          {item.description}
        </p>

        {recordCount > 8 && (
          <label className="audit-investigation-search">
            <span>
              <Search size={14} aria-hidden="true" /> Filter investigation records
            </span>
            <input
              type="search"
              value={query}
              placeholder="Search names, statuses, models, or people"
              aria-label={`Filter ${item.label} investigation records`}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}

        <div className="audit-investigation-sections">
          {visibleSections.map((section) => (
            <section className="audit-investigation-section" key={section.label}>
              <header>
                <h3>{section.label}</h3>
                <span>{section.items.length}</span>
              </header>
              {section.items.length > 0 ? (
                <ul>
                  {section.items.map((row, index) => (
                    <li key={`${row.label}:${index}`}>
                      <strong>{row.label}</strong>
                      {row.detail && <span>{row.detail}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{query.trim() ? "No records in this section match your filter." : section.emptyText}</p>
              )}
            </section>
          ))}
        </div>

        <p className="audit-investigation-footnote">
          This investigation reflects the same current snapshot as the audit dashboard.
        </p>
      </section>
    </div>,
    document.body,
  );
}
