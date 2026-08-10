import { Users } from "lucide-react";
import type { ReactNode } from "react";
import { SelectControl } from "./SelectControl";

export type DateRangeState = {
  fromDate: string;
  throughDate: string;
};

export type SectionScope = DateRangeState & { userId: string };

export const EMPTY_SECTION_SCOPE: SectionScope = { fromDate: "", throughDate: "", userId: "all" };

export function timestampInDateRange(value: string, fromDate: string, throughDate: string) {
  if (!fromDate && !throughDate) return true;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  const fromTime = fromDate ? Date.parse(`${fromDate}T00:00:00`) : Number.NEGATIVE_INFINITY;
  const throughTime = throughDate ? Date.parse(`${throughDate}T23:59:59.999`) : Number.POSITIVE_INFINITY;
  return timestamp >= fromTime && timestamp <= throughTime;
}

export function sectionScopeMatch(scope: SectionScope, timestamp: string, userId: string | null | undefined) {
  return (
    timestampInDateRange(timestamp, scope.fromDate, scope.throughDate) &&
    (scope.userId === "all" || userId === scope.userId)
  );
}

export function DateRangeFilter({
  label,
  range,
  onChange,
  selectedCount,
  totalCount,
  extra,
}: {
  label: string;
  range: DateRangeState;
  onChange: (range: DateRangeState) => void;
  selectedCount: number;
  totalCount: number;
  extra?: ReactNode;
}) {
  function applyPreset(preset: "all" | "today" | "week" | "30d") {
    const now = new Date();
    if (preset === "all") {
      onChange({ fromDate: "", throughDate: "" });
      return;
    }
    if (preset === "today") {
      const today = dateInputValue(now);
      onChange({ fromDate: today, throughDate: today });
      return;
    }
    if (preset === "week") {
      const start = new Date(now);
      const daysFromMonday = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - daysFromMonday);
      onChange({ fromDate: dateInputValue(start), throughDate: dateInputValue(now) });
      return;
    }
    const start = new Date(now);
    start.setDate(start.getDate() - 29);
    onChange({ fromDate: dateInputValue(start), throughDate: dateInputValue(now) });
  }

  return (
    <section className={`date-range-filter ${extra ? "has-extra" : ""}`} aria-label={label}>
      <div className="date-range-filter-summary">
        <strong>{label}</strong>
        <small>{selectedCount.toLocaleString()} of {totalCount.toLocaleString()} records</small>
      </div>
      {extra && <div className="date-range-filter-extra">{extra}</div>}
      <label>
        From
        <input
          type="date"
          aria-label={`${label} start date`}
          value={range.fromDate}
          onChange={(event) => onChange({ ...range, fromDate: event.target.value })}
        />
      </label>
      <label>
        Through
        <input
          type="date"
          aria-label={`${label} end date`}
          value={range.throughDate}
          onChange={(event) => onChange({ ...range, throughDate: event.target.value })}
        />
      </label>
      <div className="date-range-filter-presets" aria-label={`${label} presets`}>
        <button type="button" className="secondary-button compact" onClick={() => applyPreset("all")}>
          All
        </button>
        <button type="button" className="secondary-button compact" onClick={() => applyPreset("today")}>
          Today
        </button>
        <button type="button" className="secondary-button compact" onClick={() => applyPreset("week")}>
          Week
        </button>
        <button type="button" className="secondary-button compact" onClick={() => applyPreset("30d")}>
          30 days
        </button>
      </div>
    </section>
  );
}

export function SectionScopeFilter({
  label,
  scope,
  onChange,
  users,
  selectedCount,
  totalCount,
  allUsersLabel = "All users",
}: {
  label: string;
  scope: SectionScope;
  onChange: (scope: SectionScope) => void;
  users: Array<{ id: string; label: string }>;
  selectedCount: number;
  totalCount: number;
  allUsersLabel?: string;
}) {
  return (
    <DateRangeFilter
      label={label}
      range={scope}
      onChange={(range) => onChange({ ...scope, ...range })}
      selectedCount={selectedCount}
      totalCount={totalCount}
      extra={
        <label className="compact-select-field">
          <Users size={14} />
          <SelectControl
            aria-label={`${label} user`}
            value={scope.userId}
            onChange={(event) => onChange({ ...scope, userId: event.target.value })}
          >
            <option value="all">{allUsersLabel}</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.label}
              </option>
            ))}
          </SelectControl>
        </label>
      }
    />
  );
}

function dateInputValue(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
