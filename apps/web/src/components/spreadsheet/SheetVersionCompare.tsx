import { FileDiff, X } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useMemo, useState } from "react";
import { compareWorkbooks } from "../../lib/sheet/compare";
import { parseWorkbook } from "../../lib/sheet/sheetModel";
import { SelectControl } from "../SelectControl";

export type ComparableVersion = { id: string; label: string; summary: string; content: string };

const KIND_LABEL = { added: "Added", removed: "Cleared", changed: "Changed", formatted: "Formatting" } as const;

/** A version's picker line, short enough to read whole in the closed picker. */
export function versionChoice(version: ComparableVersion): string {
  const summary = version.summary.trim();
  return summary ? `${version.label} · ${summary.length > 24 ? `${summary.slice(0, 23).trimEnd()}…` : summary}` : version.label;
}

type Comparison = ReturnType<typeof compareWorkbooks>;

type PickerProps = { label: string; versions: ComparableVersion[]; value: string | undefined; onChange: (id: string) => void; autoFocus?: boolean };

function VersionPicker({ label, versions, value, onChange, autoFocus }: PickerProps) {
  return (
    <label className="sheet-field"><span>{label}</span>
      <SelectControl value={value} autoFocus={autoFocus} onChange={(event) => onChange(event.target.value)}>
        {versions.map((version) => <option key={version.id} value={version.id}>{versionChoice(version)}</option>)}
      </SelectControl>
    </label>
  );
}

function isSame(comparison: Comparison): boolean {
  return !comparison.changes.length && !comparison.addedSheets.length && !comparison.removedSheets.length && !comparison.renamedSheets.length;
}

function CompareTotals({ comparison }: { comparison: Comparison }) {
  const counts = (["added", "changed", "removed", "formatted"] as const).map((kind) => [kind, comparison.changes.filter((change) => change.kind === kind).length] as const);
  return (
    <p className="sheet-compare-totals" role="status">
      {counts.filter(([, count]) => count).map(([kind, count]) => <span key={kind} className={`is-${kind}`}>{count} {KIND_LABEL[kind].toLowerCase()}</span>)}
      {comparison.addedSheets.length > 0 && <span className="is-added">Sheets added: {comparison.addedSheets.join(", ")}</span>}
      {comparison.removedSheets.length > 0 && <span className="is-removed">Sheets removed: {comparison.removedSheets.join(", ")}</span>}
      {comparison.renamedSheets.map((item) => <span key={item.from}>Renamed {item.from} → {item.to}</span>)}
      {isSame(comparison) && <span>These versions hold the same cells.</span>}
    </p>
  );
}

function SheetChanges({ sheet, changes }: { sheet: string; changes: Comparison["changes"] }) {
  return (
    <section className="sheet-compare-sheet" aria-label={`Changes on ${sheet}`}>
      <h3>{sheet}</h3>
      <table>
        <thead><tr><th scope="col">Cell</th><th scope="col">Before</th><th scope="col">After</th><th scope="col"><span className="sr-only">Change</span></th></tr></thead>
        <tbody>
          {changes.map((change) => (
            <tr key={change.address} className={`is-${change.kind}`}>
              <th scope="row">{change.address}</th>
              <td>{change.before || <em>empty</em>}</td>
              <td>{change.after || <em>empty</em>}</td>
              <td><small>{KIND_LABEL[change.kind]}</small></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CompareBody({ comparison }: { comparison: Comparison }) {
  const bySheet = new Map<string, Comparison["changes"]>();
  for (const change of comparison.changes) {
    const list = bySheet.get(change.sheet);
    if (list) list.push(change);
    else bySheet.set(change.sheet, [change]);
  }
  return (
    <div className="sheet-compare-body">
      <CompareTotals comparison={comparison} />
      {Array.from(bySheet.entries()).map(([sheet, changes]) => <SheetChanges key={sheet} sheet={sheet} changes={changes} />)}
      {comparison.more > 0 && <p className="sheet-panel-note">…and {comparison.more.toLocaleString("en-US")} more changed {comparison.more === 1 ? "cell" : "cells"}.</p>}
    </div>
  );
}

function workbookIn(versions: ComparableVersion[], id: string | undefined) {
  return parseWorkbook(versions.find((version) => version.id === id)?.content);
}

function compareVersions(versions: ComparableVersion[], baseId: string | undefined, comparisonId: string | undefined): Comparison | null {
  const base = workbookIn(versions, baseId);
  const next = workbookIn(versions, comparisonId);
  return base.ok && next.ok ? compareWorkbooks(base.workbook, next.workbook) : null;
}

/** The newest version compared with the one before it. */
function defaultPair(versions: ComparableVersion[]): { base?: string; comparison?: string } {
  const newest = versions.at(-1)?.id;
  return { base: versions.length > 1 ? versions[versions.length - 2].id : newest, comparison: newest };
}

/** Read-only comparison of two workbook versions, cell by cell. */
export function SheetVersionCompare({ versions, onClose }: { versions: ComparableVersion[]; onClose: () => void }) {
  const [baseId, setBaseId] = useState(() => defaultPair(versions).base);
  const [comparisonId, setComparisonId] = useState(() => defaultPair(versions).comparison);
  const comparison = useMemo(() => compareVersions(versions, baseId, comparisonId), [versions, baseId, comparisonId]);
  const closeOnBackdrop = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };

  return (
    <div className="modal-backdrop sheet-compare-backdrop" role="presentation" onPointerDown={closeOnBackdrop}>
      <div className="sheet-compare" role="dialog" aria-modal="true" aria-label="Compare workbook versions" onKeyDown={closeOnEscape}>
        <header className="modal-head">
          <span className="modal-icon" aria-hidden="true"><FileDiff size={18} /></span>
          <div>
            <h2>Compare workbook versions</h2>
            <p>Every cell that differs, with what it held before and after.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close comparison" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="sheet-compare-pickers">
          <VersionPicker label="Base" versions={versions} value={baseId} onChange={setBaseId} autoFocus />
          <span className="sheet-compare-arrow" aria-hidden="true">→</span>
          <VersionPicker label="Compared with" versions={versions} value={comparisonId} onChange={setComparisonId} />
        </div>
        {comparison ? <CompareBody comparison={comparison} /> : <p className="sheet-panel-note" role="alert">One of these versions could not be read.</p>}
      </div>
    </div>
  );
}
