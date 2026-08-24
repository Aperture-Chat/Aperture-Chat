import { Eye, Search, ShieldAlert, X } from "lucide-react";
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
};

export function AuditSummaryCard({ item }: { item: AuditSummaryItem }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const titleId = useId();
  const descriptionId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const recordCount = item.sections.reduce((count, section) => count + section.items.length, 0);
  const tooltip = `Open ${item.label.toLowerCase()} details and review every record behind this metric.`;

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

  const close = () => {
    setOpen(false);
    setQuery("");
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`audit-summary-card${item.issue ? " is-issue" : ""}`}
        aria-label={`${item.label}: ${item.value} ${item.detail}. Open investigation.`}
        aria-haspopup="dialog"
        data-tooltip={tooltip}
        title={tooltip}
        onClick={() => setOpen(true)}
      >
        <span>{item.label}</span>
        <strong>{item.value}</strong>
        <small>{item.detail}</small>
        <span className="audit-summary-card-action">
          <Eye size={13} aria-hidden="true" /> Inspect details
        </span>
      </button>

      {open &&
        createPortal(
          <div className="modal-backdrop audit-investigation-backdrop" role="presentation" onClick={close}>
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
                  <p>Review the records reflected in this dashboard metric.</p>
                </div>
                <button
                  autoFocus
                  className="icon-button"
                  type="button"
                  aria-label={`Close ${item.label} investigation`}
                  data-tooltip="Close investigation"
                  onClick={close}
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
        )}
    </>
  );
}
