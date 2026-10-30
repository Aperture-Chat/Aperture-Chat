import clsx from "clsx";
import { ArrowDown, ArrowUp, ChartArea, ChartColumn, ChartLine, ChartPie, ChartScatter, CircleDot, Plus, Search, Trash2, X } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { type CellPoint, type CellRange, cellKey, columnLabel, formatRangeRef, parseCellKey, parseRangeRef, quoteSheetName, rangeContains, splitSheetQualifiedRef } from "../../lib/sheet/address";
import { readChartData } from "../../lib/sheet/chartData";
import { columnHeaderLabel, currentRegion, rangeHasHeader, tablePalette } from "../../lib/sheet/decorations";
import { SHEET_FUNCTIONS } from "../../lib/sheet/formula/functions";
import type { FunctionCategory } from "../../lib/sheet/formula/types";
import { isError } from "../../lib/sheet/formula/values";
import { formatCellValue } from "../../lib/sheet/numberFormat";
import { SHEET_ACCENT_NAMES } from "../../lib/sheet/palette";
import { pivotSourceFields } from "../../lib/sheet/pivot";
import { fitPivotColumns } from "../../lib/sheet/pivotLayout";
import type { WorkbookEngine } from "../../lib/sheet/recalc";
import { tableRanges } from "../../lib/sheet/recalc";
import {
  type AccentSlot,
  type CellOperator,
  type ConditionalRule,
  type ConditionalStyle,
  type PivotAggregate,
  type Sheet,
  type SheetChart,
  type SheetChartType,
  type SheetPivot,
  type SheetTable,
  type SheetValidation,
  type TableTone,
  type Workbook,
  nextObjectId,
  parseWorkbook,
  sheetByName,
  tableNameProblem,
} from "../../lib/sheet/sheetModel";
import { addSheet, cellInputText, getCell, removeDuplicateRows, setCellInput, setNote, sortRange, splitTextToColumns, updateSheet } from "../../lib/sheet/sheetOps";
import { clearOwnColors, clearedForStyle, nextTableName } from "../../lib/sheet/tableStyles";
import { RailSwitch } from "../RailSwitch";
import { SheetChartView } from "./SheetChart";
import { SelectControl } from "../SelectControl";

export type SidePanel =
  | { kind: "chart"; chartId: string | null }
  | { kind: "pivot"; pivotId: string | null }
  | { kind: "table" }
  | { kind: "conditional" }
  | { kind: "validation" }
  | { kind: "find"; replace: boolean }
  | { kind: "sort"; quick: boolean }
  | { kind: "note" }
  | { kind: "names" }
  | { kind: "duplicates" }
  | { kind: "split" }
  | { kind: "functions" };

type Props = {
  panel: SidePanel;
  workbook: Workbook;
  sheet: Sheet;
  engine: WorkbookEngine;
  selection: CellRange;
  active: CellPoint;
  readOnly: boolean;
  onApply: (workbook: Workbook, label: string, sheetId?: string) => void;
  onClose: () => void;
  onOpen: (panel: SidePanel) => void;
  onSelect: (range: CellRange, sheetId?: string) => void;
  onFindMatches: (matches: Set<string> | null) => void;
  onNotice: (message: string) => void;
  onInsertFunction?: (name: string) => void;
};

const TITLES: Record<SidePanel["kind"], string> = {
  chart: "Chart",
  pivot: "Pivot table",
  table: "Table",
  conditional: "Conditional formatting",
  validation: "Data validation",
  find: "Find and replace",
  sort: "Sort range",
  note: "Note",
  names: "Named ranges",
  duplicates: "Remove duplicates",
  split: "Split text to columns",
  functions: "Functions",
};

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="sheet-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <label className="sheet-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** The data region a new chart, table, pivot, or sort should start from. */
function defaultRegion(props: Props): CellRange {
  const { selection, sheet, engine, active } = props;
  const single = selection.r1 === selection.r2 && selection.c1 === selection.c2;
  return single ? currentRegion(sheet.id, engine, active.row, active.col) : selection;
}

export function SheetSidePanel(props: Props) {
  const { panel, onClose } = props;
  return (
    <aside className="sheet-side-panel" aria-label={TITLES[panel.kind]} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header className="sheet-panel-head">
        <strong>{TITLES[panel.kind]}</strong>
        <button type="button" aria-label={`Close ${TITLES[panel.kind].toLowerCase()}`} onClick={onClose}><X size={16} /></button>
      </header>
      <div className="sheet-panel-body">
        {panel.kind === "chart" && <ChartPanel {...props} chartId={panel.chartId} />}
        {panel.kind === "pivot" && <PivotPanel {...props} pivotId={panel.pivotId} />}
        {panel.kind === "table" && <TablePanel {...props} />}
        {panel.kind === "conditional" && <ConditionalPanel {...props} />}
        {panel.kind === "validation" && <ValidationPanel {...props} />}
        {panel.kind === "find" && <FindPanel {...props} replace={panel.replace} />}
        {panel.kind === "sort" && <SortPanel {...props} quickDesc={panel.quick} />}
        {panel.kind === "note" && <NotePanel {...props} />}
        {panel.kind === "names" && <NamesPanel {...props} />}
        {panel.kind === "duplicates" && <DuplicatesPanel {...props} />}
        {panel.kind === "split" && <SplitPanel {...props} />}
        {panel.kind === "functions" && <FunctionsPanel {...props} />}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ chart */

const CHART_CHOICES: { type: SheetChartType; label: string; icon: ReactNode }[] = [
  { type: "column", label: "Column", icon: <ChartColumn size={18} /> },
  { type: "bar", label: "Bar", icon: <ChartColumn size={18} style={{ transform: "rotate(90deg)" }} /> },
  { type: "line", label: "Line", icon: <ChartLine size={18} /> },
  { type: "area", label: "Area", icon: <ChartArea size={18} /> },
  { type: "pie", label: "Pie", icon: <ChartPie size={18} /> },
  { type: "doughnut", label: "Doughnut", icon: <CircleDot size={18} /> },
  { type: "scatter", label: "Scatter", icon: <ChartScatter size={18} /> },
];

function ChartPanel(props: Props & { chartId: string | null }) {
  const { sheet, workbook, engine, readOnly, onApply, onClose } = props;
  const existing = props.chartId ? sheet.charts?.find((chart) => chart.id === props.chartId) ?? null : null;
  const region = useMemo(() => defaultRegion(props), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<SheetChart>(() => existing ?? {
    id: nextObjectId("chart", workbook.sheets.flatMap((item) => item.charts ?? [])),
    type: "column",
    title: "",
    source: formatRangeRef(region),
    seriesBy: "columns",
    legend: "bottom",
    at: cellKey(region.r1, Math.min(250, region.c2 + 2)),
    w: 480,
    h: 300,
  });
  useEffect(() => { if (existing) setDraft(existing); }, [existing]);
  const sourceValid = Boolean(parseRangeRef(splitSheetQualifiedRef(draft.source).ref));
  const data = sourceValid ? readChartData(draft, sheet, workbook, engine) : null;
  const update = (patch: Partial<SheetChart>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (existing && !readOnly) {
      const parsed = parseWorkbook({ ...workbook, sheets: workbook.sheets.map((item) => (item.id === sheet.id ? { ...item, charts: item.charts?.map((chart) => (chart.id === existing.id ? next : chart)) } : item)) });
      if (parsed.ok) onApply(parsed.workbook, "Edited chart");
    }
  };
  return (
    <div className="sheet-panel-stack">
      <div className="sheet-chart-types" role="radiogroup" aria-label="Chart type">
        {CHART_CHOICES.map((choice) => (
          <button key={choice.type} type="button" role="radio" aria-checked={draft.type === choice.type} className={clsx(draft.type === choice.type && "is-active")} onClick={() => update({ type: choice.type })}>
            {choice.icon}
            <span>{choice.label}</span>
          </button>
        ))}
      </div>
      <div className="sheet-chart-preview" aria-hidden="true">
        <SheetChartView chart={draft} data={data} width={288} height={180} />
      </div>
      <Field label="Data range" hint="First column: labels. First row: series names.">
        <input value={draft.source} onChange={(event) => update({ source: event.target.value })} aria-invalid={!sourceValid} />
      </Field>
      <Field label="Title">
        <input value={draft.title ?? ""} placeholder="Chart title" onChange={(event) => update({ title: event.target.value })} />
      </Field>
      {draft.type !== "pie" && draft.type !== "doughnut" && (
        <>
          <span className="sheet-field-label">Series come from</span>
          <RailSwitch ariaLabel="Series come from" block value={draft.seriesBy} onChange={(value) => update({ seriesBy: value })} options={[{ value: "columns", label: "Columns" }, { value: "rows", label: "Rows" }]} />
        </>
      )}
      <Field label="Legend">
        <SelectControl value={draft.legend} onChange={(event) => update({ legend: event.target.value as SheetChart["legend"] })}>
          <option value="bottom">Bottom</option>
          <option value="right">Right</option>
          <option value="top">Top</option>
          <option value="none">None</option>
        </SelectControl>
      </Field>
      {(draft.type === "column" || draft.type === "bar" || draft.type === "area") && <Check label="Stack the series" checked={Boolean(draft.stacked)} onChange={(value) => update({ stacked: value || undefined })} />}
      <Check label="Show data labels" checked={Boolean(draft.showValues)} onChange={(value) => update({ showValues: value || undefined })} />
      {draft.type !== "pie" && draft.type !== "doughnut" && (
        <div className="sheet-field-pair">
          <Field label="Horizontal axis title"><input value={draft.xTitle ?? ""} onChange={(event) => update({ xTitle: event.target.value || undefined })} /></Field>
          <Field label="Vertical axis title"><input value={draft.yTitle ?? ""} onChange={(event) => update({ yTitle: event.target.value || undefined })} /></Field>
        </div>
      )}
      <div className="sheet-panel-actions">
        {existing ? (
          <button
            type="button"
            className="secondary-button is-danger"
            disabled={readOnly}
            onClick={() => {
              onApply(updateSheet(workbook, sheet.id, (current) => ({ ...current, charts: current.charts?.filter((chart) => chart.id !== existing.id) })), "Deleted chart");
              onClose();
            }}
          >
            <Trash2 size={15} /> Delete chart
          </button>
        ) : (
          <button
            type="button"
            className="primary-button"
            disabled={readOnly || !sourceValid}
            onClick={() => {
              const parsed = parseWorkbook({ ...workbook, sheets: workbook.sheets.map((item) => (item.id === sheet.id ? { ...item, charts: [...(item.charts ?? []), draft] } : item)) });
              if (!parsed.ok) return;
              onApply(parsed.workbook, `Inserted a ${draft.type} chart`);
              props.onOpen({ kind: "chart", chartId: draft.id });
            }}
          >
            <Plus size={15} /> Insert chart
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pivot */

type FieldRole = "none" | "rows" | "columns" | "values" | "filters";

function PivotPanel(props: Props & { pivotId: string | null }) {
  const { workbook, sheet, engine, readOnly, onApply, active, onClose } = props;
  const editing = useMemo(() => {
    if (props.pivotId) return sheet.pivots?.find((pivot) => pivot.id === props.pivotId) ?? null;
    const derived = engine.derivedSource(sheet.id, active.row, active.col);
    if (derived?.kind === "pivot") return sheet.pivots?.find((pivot) => pivot.id === derived.pivotId) ?? null;
    return sheet.pivots?.find((pivot) => parseCellKey(pivot.at)?.row === active.row && parseCellKey(pivot.at)?.col === active.col) ?? null;
  }, [props.pivotId, sheet, engine, active]);
  const region = useMemo(() => defaultRegion(props), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [source, setSource] = useState(editing?.source ?? `${quoteSheetName(sheet.name)}!${formatRangeRef(region)}`);
  const [destination, setDestination] = useState<"new" | "here">(editing ? "here" : "new");
  const [at, setAt] = useState(editing?.at ?? cellKey(region.r1, Math.min(250, region.c2 + 2)));
  const [roles, setRoles] = useState<Record<string, FieldRole>>(() => {
    const out: Record<string, FieldRole> = {};
    editing?.rows.forEach((field) => { out[field] = "rows"; });
    editing?.columns.forEach((field) => { out[field] = "columns"; });
    editing?.values.forEach((value) => { out[value.field] = "values"; });
    return out;
  });
  const [aggs, setAggs] = useState<Record<string, PivotAggregate>>(() => Object.fromEntries((editing?.values ?? []).map((value) => [value.field, value.agg])));
  const [rowTotals, setRowTotals] = useState(editing?.rowTotals ?? true);
  const [columnTotals, setColumnTotals] = useState(editing?.columnTotals ?? true);
  const split = splitSheetQualifiedRef(source);
  const sourceSheet = split.sheet ? sheetByName(workbook, split.sheet) : sheet;
  const sourceRange = parseRangeRef(split.ref);
  const fields = useMemo(() => {
    if (!sourceSheet || !sourceRange) return [];
    const matrix = engine.range({ sheet: sourceSheet.name, ...sourceRange, r2: sourceRange.r1 });
    return isError(matrix) ? [] : pivotSourceFields(matrix).filter(Boolean);
  }, [engine, sourceSheet, sourceRange?.r1, sourceRange?.c1, sourceRange?.c2]); // eslint-disable-line react-hooks/exhaustive-deps
  const numericField = (field: string) => {
    if (!sourceSheet || !sourceRange) return false;
    const index = fields.indexOf(field);
    const value = engine.value(sourceSheet.id, sourceRange.r1 + 1, sourceRange.c1 + index);
    return typeof value === "number";
  };
  const roleOf = (field: string): FieldRole => roles[field] ?? "none";
  const spec = (): SheetPivot => ({
    id: editing?.id ?? nextObjectId("pivot", workbook.sheets.flatMap((item) => item.pivots ?? [])),
    name: editing?.name ?? "PivotTable",
    source,
    at: destination === "new" ? "A3" : at.toUpperCase(),
    rows: fields.filter((field) => roleOf(field) === "rows"),
    columns: fields.filter((field) => roleOf(field) === "columns"),
    values: fields.filter((field) => roleOf(field) === "values").map((field) => ({ field, agg: aggs[field] ?? (numericField(field) ? "sum" : "count") })),
    filters: editing?.filters ?? [],
    rowTotals,
    columnTotals,
  });
  const valid = Boolean(sourceSheet && sourceRange && fields.length && fields.some((field) => roleOf(field) !== "none"));

  const save = () => {
    const pivot = spec();
    if (editing) {
      const next = updateSheet(workbook, sheet.id, (current) => ({ ...current, pivots: current.pivots?.map((item) => (item.id === editing.id ? { ...pivot, at: editing.at } : item)) }));
      onApply(next, "Updated pivot table");
      return;
    }
    if (destination === "new") {
      const added = addSheet(workbook, "Pivot", sourceSheet?.id);
      const next = updateSheet(added.workbook, added.sheetId, (current) => ({
        ...current,
        cells: { ...current.cells, A1: { v: `Pivot of ${split.ref}`, s: { bold: true, size: 13 } } },
        pivots: [pivot],
      }));
      onApply(fitPivotColumns(next, added.sheetId, pivot.id), "Created a pivot table", added.sheetId);
      return;
    }
    if (!parseCellKey(pivot.at)) {
      props.onNotice("Pick the cell where the pivot table should start.");
      return;
    }
    onApply(fitPivotColumns(updateSheet(workbook, sheet.id, (current) => ({ ...current, pivots: [...(current.pivots ?? []), pivot] })), sheet.id, pivot.id), "Created a pivot table");
  };

  return (
    <div className="sheet-panel-stack">
      <Field label="Source data" hint="A range with field names in its first row.">
        <input value={source} disabled={readOnly} onChange={(event) => setSource(event.target.value)} aria-invalid={!sourceRange || !sourceSheet} />
      </Field>
      {!editing && (
        <>
          <span className="sheet-field-label">Put the pivot table on</span>
          <RailSwitch ariaLabel="Pivot destination" block value={destination} onChange={setDestination} options={[{ value: "new", label: "New sheet" }, { value: "here", label: "This sheet" }]} />
          {destination === "here" && <Field label="Start at cell"><input value={at} onChange={(event) => setAt(event.target.value)} /></Field>}
        </>
      )}
      <div className="sheet-pivot-fields" role="table" aria-label="Pivot fields">
        <div className="sheet-pivot-row is-head" role="row"><span role="columnheader">Field</span><span role="columnheader">Use as</span></div>
        {fields.length === 0 && <p className="sheet-panel-empty">No field names found in the first row of the source.</p>}
        {fields.map((field) => (
          <div key={field} className="sheet-pivot-row" role="row">
            <span role="cell" className="sheet-pivot-name">{field}</span>
            <span role="cell" className="sheet-pivot-controls">
              <SelectControl aria-label={`Use ${field} as`} value={roleOf(field)} disabled={readOnly} onChange={(event) => setRoles({ ...roles, [field]: event.target.value as FieldRole })}>
                <option value="none">—</option>
                <option value="rows">Rows</option>
                <option value="columns">Columns</option>
                <option value="values">Values</option>
              </SelectControl>
              {roleOf(field) === "values" && (
                <SelectControl aria-label={`Summarize ${field} by`} value={aggs[field] ?? (numericField(field) ? "sum" : "count")} disabled={readOnly} onChange={(event) => setAggs({ ...aggs, [field]: event.target.value as PivotAggregate })}>
                  <option value="sum">Sum</option>
                  <option value="count">Count</option>
                  <option value="average">Average</option>
                  <option value="min">Min</option>
                  <option value="max">Max</option>
                  <option value="countDistinct">Distinct count</option>
                </SelectControl>
              )}
            </span>
          </div>
        ))}
      </div>
      <Check label="Grand total row" checked={rowTotals} disabled={readOnly} onChange={setRowTotals} />
      <Check label="Grand total column" checked={columnTotals} disabled={readOnly} onChange={setColumnTotals} />
      <div className="sheet-panel-actions">
        {editing && (
          <button type="button" className="secondary-button is-danger" disabled={readOnly} onClick={() => { onApply(updateSheet(workbook, sheet.id, (current) => ({ ...current, pivots: current.pivots?.filter((item) => item.id !== editing.id) })), "Deleted pivot table"); onClose(); }}>
            <Trash2 size={15} /> Delete
          </button>
        )}
        <button type="button" className="primary-button" disabled={readOnly || !valid} onClick={save}>{editing ? "Update" : "Create pivot table"}</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ table */

const TONES: { value: TableTone; label: string }[] = [{ value: "light", label: "Light" }, { value: "medium", label: "Medium" }, { value: "dark", label: "Dark" }];

function TablePanel(props: Props) {
  const { workbook, sheet, readOnly, onApply, active, engine } = props;
  const existing = sheet.tables?.find((table) => {
    const range = parseRangeRef(table.ref);
    return range && rangeContains(range, active.row, active.col);
  }) ?? null;
  const region = useMemo(() => defaultRegion(props), []); // eslint-disable-line react-hooks/exhaustive-deps
  const taken = new Set(workbook.sheets.flatMap((item) => (item.tables ?? []).map((table) => table.name.toLowerCase())));
  const suggestedName = nextTableName(workbook);
  const [draft, setDraft] = useState<SheetTable>(() => existing ?? { id: suggestedName, name: suggestedName, ref: formatRangeRef(region), accent: 1, tone: "medium", banded: true, totals: false, filterButtons: true });
  const [hasHeader, setHasHeader] = useState(() => rangeHasHeader(region, sheet.id, engine) || region.r1 === region.r2);
  const nameProblem = draft.name !== existing?.name && taken.has(draft.name.toLowerCase()) ? "That name is already used." : tableNameProblem(draft.name);
  const range = parseRangeRef(draft.ref);

  /** `base` is the workbook to write into: a new style clears the fills that would hide it. */
  const apply = (next: SheetTable, label: string, base: Workbook = workbook) => {
    let book = base;
    let table = next;
    if (!existing && !hasHeader && range) {
      // Excel adds a header row above data that has none.
      book = updateSheet(book, sheet.id, (current) => current);
      let headed = book;
      for (let col = range.c1; col <= range.c2; col += 1) headed = setCellInput(headed, sheet.id, range.r1, col, `Column${col - range.c1 + 1}`);
      book = headed;
      table = { ...next, ref: formatRangeRef(range) };
    }
    if (existing?.totals !== table.totals && range) {
      const all = parseRangeRef(table.ref)!;
      if (table.totals) {
        // Grow by a totals row with SUBTOTAL formulas under numeric columns.
        const totalsRow = all.r2 + 1;
        table = { ...table, ref: formatRangeRef({ ...all, r2: totalsRow }) };
        for (let col = all.c1; col <= all.c2; col += 1) {
          const sample = engine.value(sheet.id, all.r1 + 1, col);
          const input = col === all.c1 && typeof sample !== "number" ? "Total" : typeof sample === "number" ? `=SUBTOTAL(109,${cellKey(all.r1 + 1, col)}:${cellKey(all.r2, col)})` : "";
          if (input) book = setCellInput(book, sheet.id, totalsRow, col, input);
        }
      } else if (existing?.totals) {
        const ranges = tableRanges(existing);
        if (ranges?.totals) {
          book = updateSheet(book, sheet.id, (current) => {
            const cells = { ...current.cells };
            for (let col = ranges.all.c1; col <= ranges.all.c2; col += 1) delete cells[cellKey(ranges.totals!.r1, col)];
            return { ...current, cells };
          });
          table = { ...table, ref: formatRangeRef({ ...ranges.all, r2: ranges.all.r2 - 1 }) };
        }
      }
    }
    const parsed = parseWorkbook({ ...book, sheets: book.sheets.map((item) => (item.id === sheet.id ? { ...item, tables: [...(item.tables ?? []).filter((t) => t.id !== existing?.id), table] } : item)) });
    if (parsed.ok) {
      onApply(parsed.workbook, label);
      setDraft(parsed.workbook.sheets.find((item) => item.id === sheet.id)?.tables?.find((t) => t.name === table.name) ?? table);
    } else props.onNotice(parsed.error);
  };

  const update = (patch: Partial<SheetTable>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (!existing || readOnly || tableNameProblem(next.name)) return;
    apply(next, "Edited table", clearedForStyle(workbook, patch, { sheetId: sheet.id, tableId: existing.id }));
  };

  return (
    <div className="sheet-panel-stack">
      <Field label="Table range"><input value={draft.ref} disabled={readOnly || Boolean(existing)} onChange={(event) => setDraft({ ...draft, ref: event.target.value.toUpperCase() })} aria-invalid={!range} /></Field>
      {!existing && <Check label="My data has a header row" checked={hasHeader} onChange={setHasHeader} />}
      <Field label="Table name" hint={nameProblem ?? "Use it in formulas, e.g. =SUM(Table1[Revenue])."}>
        <input value={draft.name} disabled={readOnly} onChange={(event) => update({ name: event.target.value.replace(/\s+/g, "_"), id: existing?.id ?? event.target.value })} aria-invalid={Boolean(nameProblem)} />
      </Field>
      <span className="sheet-field-label">Style</span>
      <RailSwitch ariaLabel="Table tone" block value={draft.tone} onChange={(tone) => update({ tone })} options={TONES} />
      <div className="sheet-table-styles" role="radiogroup" aria-label="Table color">
        {([1, 2, 3, 4, 5, 6] as AccentSlot[]).map((accent) => {
          const colors = tablePalette({ accent, tone: draft.tone }, typeof document !== "undefined" && document.documentElement.classList.contains("theme-dark"));
          return (
            <button key={accent} type="button" role="radio" aria-checked={draft.accent === accent} aria-label={SHEET_ACCENT_NAMES[accent]} className={clsx(draft.accent === accent && "is-active")} onClick={() => update({ accent })} style={{ "--table-header": colors.header, "--table-band": colors.band, "--table-line": colors.line } as CSSProperties}>
              <span className="sheet-table-swatch" aria-hidden="true"><i /><i /><i /><i /></span>
              <small>{SHEET_ACCENT_NAMES[accent]}</small>
            </button>
          );
        })}
      </div>
      <Check label="Banded rows" checked={draft.banded} disabled={readOnly} onChange={(banded) => update({ banded })} />
      <Check label="Filter buttons" checked={draft.filterButtons} disabled={readOnly} onChange={(filterButtons) => update({ filterButtons })} />
      <Check label="Totals row" checked={draft.totals} disabled={readOnly} onChange={(totals) => update({ totals })} />
      <Check label="Bold first column" checked={Boolean(draft.firstColumn)} disabled={readOnly} onChange={(firstColumn) => update({ firstColumn: firstColumn || undefined })} />
      <div className="sheet-panel-actions">
        {existing ? (
          <button type="button" className="secondary-button" disabled={readOnly} onClick={() => { onApply(updateSheet(workbook, sheet.id, (current) => ({ ...current, tables: current.tables?.filter((table) => table.id !== existing.id) })), "Converted table to a range"); props.onClose(); }}>Convert to range</button>
        ) : (
          <button type="button" className="primary-button" disabled={readOnly || !range || Boolean(nameProblem) || (hasHeader && range.r2 <= range.r1)} onClick={() => apply(draft, `Formatted ${draft.ref} as a table`, range ? clearOwnColors(workbook, sheet.id, range) : workbook)}>Create table</button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ conditional formatting */

type RuleKind = "scale" | "bar" | "gt" | "lt" | "between" | "eq" | "text" | "top" | "bottom" | "above" | "below" | "duplicate" | "unique" | "blank" | "notBlank" | "formula";

const RULE_KINDS: { value: RuleKind; label: string }[] = [
  { value: "scale", label: "Color scale" },
  { value: "bar", label: "Data bars" },
  { value: "gt", label: "Greater than" },
  { value: "lt", label: "Less than" },
  { value: "between", label: "Between" },
  { value: "eq", label: "Equal to" },
  { value: "text", label: "Text contains" },
  { value: "top", label: "Top values" },
  { value: "bottom", label: "Bottom values" },
  { value: "above", label: "Above average" },
  { value: "below", label: "Below average" },
  { value: "duplicate", label: "Duplicate values" },
  { value: "unique", label: "Unique values" },
  { value: "blank", label: "Blank cells" },
  { value: "notBlank", label: "Non-blank cells" },
  { value: "formula", label: "Custom formula" },
];

const STYLE_PRESETS: { label: string; style: ConditionalStyle }[] = [
  { label: "Light red fill, dark red text", style: { fill: "#fde2e1", color: "#9b1c1c" } },
  { label: "Yellow fill, dark yellow text", style: { fill: "#fef3c7", color: "#92400e" } },
  { label: "Green fill, dark green text", style: { fill: "#dcfce7", color: "#166534" } },
  { label: "Teal fill, bold", style: { fill: "#d6efef", color: "#05525b", bold: true } },
  { label: "Red text, bold", style: { color: "#b91c1c", bold: true } },
];

const SCALE_PRESETS: { label: string; min: string; mid?: string; max: string }[] = [
  { label: "Red → yellow → green", min: "#f8696b", mid: "#ffeb84", max: "#63be7b" },
  { label: "Green → yellow → red", min: "#63be7b", mid: "#ffeb84", max: "#f8696b" },
  { label: "White → teal", min: "#ffffff", max: "#087d8b" },
  { label: "White → blue", min: "#ffffff", max: "#2f6eba" },
];

function describeRule(rule: ConditionalRule): string {
  switch (rule.type) {
    case "scale": return "Color scale";
    case "bar": return "Data bars";
    case "cell": return `Cell ${({ gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=", neq: "≠", between: "between", notBetween: "not between" } as Record<CellOperator, string>)[rule.op]} ${rule.value}${rule.value2 ? ` and ${rule.value2}` : ""}`;
    case "text": return `Text ${rule.op} "${rule.text}"`;
    case "top": case "bottom": return `${rule.type === "top" ? "Top" : "Bottom"} ${rule.count}${rule.percent ? "%" : ""}`;
    case "formula": return `Formula =${rule.formula}`;
    default: return RULE_KINDS.find((item) => item.value === rule.type)?.label ?? rule.type;
  }
}

function ConditionalPanel(props: Props) {
  const { workbook, sheet, selection, readOnly, onApply } = props;
  const [kind, setKind] = useState<RuleKind>("gt");
  const [ref, setRef] = useState(formatRangeRef(selection));
  const [value, setValue] = useState("");
  const [value2, setValue2] = useState("");
  const [count, setCount] = useState("10");
  const [stylePreset, setStylePreset] = useState(0);
  const [scalePreset, setScalePreset] = useState(0);
  const [barColor, setBarColor] = useState("#087d8b");
  useEffect(() => setRef(formatRangeRef(selection)), [selection]);
  const rules = sheet.conditional ?? [];
  const needsValue = kind === "gt" || kind === "lt" || kind === "between" || kind === "eq" || kind === "text" || kind === "formula";

  const build = (): ConditionalRule | null => {
    const id = nextObjectId("rule", rules);
    const style = STYLE_PRESETS[stylePreset].style;
    const range = parseRangeRef(ref);
    if (!range) return null;
    const base = { id, ref: formatRangeRef(range) };
    switch (kind) {
      case "scale": { const preset = SCALE_PRESETS[scalePreset]; return { ...base, type: "scale", min: preset.min, ...(preset.mid ? { mid: preset.mid } : {}), max: preset.max }; }
      case "bar": return { ...base, type: "bar", color: barColor };
      case "gt": case "lt": case "eq": return value.trim() ? { ...base, type: "cell", op: kind, value: value.trim(), style } : null;
      case "between": return value.trim() && value2.trim() ? { ...base, type: "cell", op: "between", value: value.trim(), value2: value2.trim(), style } : null;
      case "text": return value.trim() ? { ...base, type: "text", op: "contains", text: value.trim(), style } : null;
      case "top": case "bottom": return { ...base, type: kind, count: Math.max(1, Number(count) || 10), style };
      case "formula": return value.trim() ? { ...base, type: "formula", formula: value.trim().replace(/^=/, ""), style } : null;
      default: return { ...base, type: kind, style };
    }
  };
  const candidate = build();

  return (
    <div className="sheet-panel-stack">
      <Field label="Apply to range"><input value={ref} onChange={(event) => setRef(event.target.value.toUpperCase())} aria-invalid={!parseRangeRef(ref)} /></Field>
      <Field label="Format cells if">
        <SelectControl value={kind} onChange={(event) => setKind(event.target.value as RuleKind)}>
          {RULE_KINDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </SelectControl>
      </Field>
      {needsValue && (
        <div className="sheet-field-pair">
          <Field label={kind === "formula" ? "Formula (for the top-left cell)" : kind === "text" ? "Text" : "Value"}>
            <input value={value} placeholder={kind === "formula" ? "=$E2<0" : ""} onChange={(event) => setValue(event.target.value)} />
          </Field>
          {kind === "between" && <Field label="and"><input value={value2} onChange={(event) => setValue2(event.target.value)} /></Field>}
        </div>
      )}
      {(kind === "top" || kind === "bottom") && <Field label="How many"><input type="number" min={1} value={count} onChange={(event) => setCount(event.target.value)} /></Field>}
      {kind === "scale" ? (
        <Field label="Colors">
          <SelectControl value={scalePreset} onChange={(event) => setScalePreset(Number(event.target.value))}>
            {SCALE_PRESETS.map((preset, index) => <option key={preset.label} value={index}>{preset.label}</option>)}
          </SelectControl>
        </Field>
      ) : kind === "bar" ? (
        <Field label="Bar color"><input type="color" value={barColor} onChange={(event) => setBarColor(event.target.value)} /></Field>
      ) : (
        <Field label="Format with">
          <SelectControl value={stylePreset} onChange={(event) => setStylePreset(Number(event.target.value))}>
            {STYLE_PRESETS.map((preset, index) => <option key={preset.label} value={index}>{preset.label}</option>)}
          </SelectControl>
        </Field>
      )}
      <div className="sheet-panel-actions">
        <button
          type="button"
          className="primary-button"
          disabled={readOnly || !candidate}
          onClick={() => candidate && onApply(updateSheet(workbook, sheet.id, (current) => ({ ...current, conditional: [...(current.conditional ?? []), candidate] })), `Added a ${RULE_KINDS.find((item) => item.value === kind)?.label.toLowerCase()} rule`)}
        >
          <Plus size={15} /> Add rule
        </button>
      </div>
      <h3 className="sheet-panel-subhead">Rules on this sheet</h3>
      {rules.length === 0 && <p className="sheet-panel-empty">No rules yet.</p>}
      <ul className="sheet-rule-list">
        {rules.map((rule, index) => (
          <li key={rule.id}>
            <span className="sheet-rule-swatch" style={{ background: "style" in rule ? rule.style.fill ?? "transparent" : rule.type === "bar" ? rule.color : rule.type === "scale" ? `linear-gradient(90deg, ${rule.min}, ${rule.mid ?? rule.max}, ${rule.max})` : "transparent", color: "style" in rule ? rule.style.color : undefined }} aria-hidden="true">Aa</span>
            <span className="sheet-rule-text"><strong>{describeRule(rule)}</strong><small>{rule.ref}</small></span>
            <span className="sheet-rule-actions">
              <button type="button" aria-label="Move rule up" disabled={readOnly || index === 0} onClick={() => onApply(updateSheet(workbook, sheet.id, (current) => { const list = (current.conditional ?? []).slice(); [list[index - 1], list[index]] = [list[index], list[index - 1]]; return { ...current, conditional: list }; }), "Reordered rules")}><ArrowUp size={14} /></button>
              <button type="button" aria-label="Move rule down" disabled={readOnly || index === rules.length - 1} onClick={() => onApply(updateSheet(workbook, sheet.id, (current) => { const list = (current.conditional ?? []).slice(); [list[index + 1], list[index]] = [list[index], list[index + 1]]; return { ...current, conditional: list }; }), "Reordered rules")}><ArrowDown size={14} /></button>
              <button type="button" aria-label="Delete rule" disabled={readOnly} onClick={() => onApply(updateSheet(workbook, sheet.id, (current) => ({ ...current, conditional: (current.conditional ?? []).filter((item) => item.id !== rule.id) })), "Deleted a rule")}><Trash2 size={14} /></button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ validation */

function ValidationPanel(props: Props) {
  const { workbook, sheet, selection, readOnly, onApply, active } = props;
  const existing = (sheet.validations ?? []).find((rule) => {
    const range = parseRangeRef(rule.ref);
    return range && rangeContains(range, active.row, active.col);
  });
  const [kind, setKind] = useState<SheetValidation["kind"]>(existing?.kind ?? "list");
  const [items, setItems] = useState(existing?.items?.join(", ") ?? "");
  const [source, setSource] = useState(existing?.source ?? "");
  const [op, setOp] = useState<CellOperator>(existing?.op ?? "between");
  const [value, setValue] = useState(existing?.value ?? "");
  const [value2, setValue2] = useState(existing?.value2 ?? "");
  const [strict, setStrict] = useState(existing?.strict ?? true);
  const [message, setMessage] = useState(existing?.message ?? "");
  const ref = existing?.ref ?? formatRangeRef(selection);

  const save = () => {
    const rule: SheetValidation = {
      id: existing?.id ?? nextObjectId("valid", sheet.validations ?? []),
      ref,
      kind,
      strict,
      ...(message.trim() ? { message: message.trim() } : {}),
      ...(kind === "list"
        ? source.trim() ? { source: source.trim() } : { items: items.split(",").map((item) => item.trim()).filter(Boolean) }
        : { op, value: value.trim(), ...(op === "between" || op === "notBetween" ? { value2: value2.trim() } : {}) }),
    };
    const parsed = parseWorkbook({ ...workbook, sheets: workbook.sheets.map((item) => (item.id === sheet.id ? { ...item, validations: [...(item.validations ?? []).filter((v) => v.id !== rule.id), rule] } : item)) });
    if (!parsed.ok || !parsed.workbook.sheets.find((item) => item.id === sheet.id)?.validations?.some((v) => v.id === rule.id)) {
      props.onNotice("Fill in the rule's values first.");
      return;
    }
    onApply(parsed.workbook, existing ? "Updated data validation" : `Added data validation to ${ref}`);
  };

  return (
    <div className="sheet-panel-stack">
      <p className="sheet-panel-note">Applies to <strong>{ref}</strong></p>
      <Field label="Allow">
        <SelectControl value={kind} onChange={(event) => setKind(event.target.value as SheetValidation["kind"])}>
          <option value="list">A list of choices</option>
          <option value="whole">Whole numbers</option>
          <option value="decimal">Numbers</option>
          <option value="date">Dates</option>
          <option value="textLength">Text of a length</option>
        </SelectControl>
      </Field>
      {kind === "list" ? (
        <>
          <Field label="Choices (comma separated)"><input value={items} placeholder="Open, In progress, Done" onChange={(event) => setItems(event.target.value)} disabled={Boolean(source.trim())} /></Field>
          <Field label="…or a range holding the choices" hint="For example Lists!A2:A20"><input value={source} onChange={(event) => setSource(event.target.value)} /></Field>
        </>
      ) : (
        <>
          <Field label="Condition">
            <SelectControl value={op} onChange={(event) => setOp(event.target.value as CellOperator)}>
              <option value="between">Between</option>
              <option value="notBetween">Not between</option>
              <option value="gt">Greater than</option>
              <option value="gte">At least</option>
              <option value="lt">Less than</option>
              <option value="lte">At most</option>
              <option value="eq">Equal to</option>
              <option value="neq">Not equal to</option>
            </SelectControl>
          </Field>
          <div className="sheet-field-pair">
            <Field label={op === "between" || op === "notBetween" ? "Minimum" : "Value"}><input value={value} onChange={(event) => setValue(event.target.value)} /></Field>
            {(op === "between" || op === "notBetween") && <Field label="Maximum"><input value={value2} onChange={(event) => setValue2(event.target.value)} /></Field>}
          </div>
        </>
      )}
      <Check label="Reject entries that break the rule" checked={strict} onChange={setStrict} />
      <Field label="Message when an entry breaks the rule"><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Optional" /></Field>
      <div className="sheet-panel-actions">
        {existing && <button type="button" className="secondary-button" disabled={readOnly} onClick={() => { onApply(updateSheet(workbook, sheet.id, (current) => ({ ...current, validations: (current.validations ?? []).filter((rule) => rule.id !== existing.id) })), "Removed data validation"); props.onClose(); }}>Remove rule</button>}
        <button type="button" className="primary-button" disabled={readOnly} onClick={save}>{existing ? "Update" : "Add rule"}</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ find and replace */

type Match = { sheetId: string; sheetName: string; row: number; col: number; text: string };

function FindPanel(props: Props & { replace: boolean }) {
  const { workbook, sheet, engine, readOnly, onApply, onSelect, onFindMatches } = props;
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(props.replace);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeCell, setWholeCell] = useState(false);
  const [inFormulas, setInFormulas] = useState(false);
  const [allSheets, setAllSheets] = useState(false);
  const [index, setIndex] = useState(0);

  const matches = useMemo<Match[]>(() => {
    if (!query) return [];
    const needle = matchCase ? query : query.toLowerCase();
    const out: Match[] = [];
    for (const item of allSheets ? workbook.sheets : [sheet]) {
      const used = engine.usedRange(item.id);
      if (!used) continue;
      for (let row = used.r1; row <= used.r2 && out.length < 2000; row += 1) {
        for (let col = used.c1; col <= used.c2; col += 1) {
          const cell = getCell(item, row, col);
          const raw = inFormulas && cell?.f ? `=${cell.f}` : formatCellValue(engine.value(item.id, row, col), cell?.s?.format).text;
          if (!raw) continue;
          const hay = matchCase ? raw : raw.toLowerCase();
          if (wholeCell ? hay === needle : hay.includes(needle)) out.push({ sheetId: item.id, sheetName: item.name, row, col, text: raw });
        }
      }
    }
    return out;
  }, [query, matchCase, wholeCell, inFormulas, allSheets, workbook, sheet, engine]);

  useEffect(() => {
    onFindMatches(matches.length ? new Set(matches.filter((match) => match.sheetId === sheet.id).map((match) => cellKey(match.row, match.col))) : null);
  }, [matches, sheet.id, onFindMatches]);
  useEffect(() => () => onFindMatches(null), [onFindMatches]);

  const go = (next: number) => {
    if (!matches.length) return;
    const wrapped = (next + matches.length) % matches.length;
    setIndex(wrapped);
    const match = matches[wrapped];
    onSelect({ r1: match.row, c1: match.col, r2: match.row, c2: match.col }, match.sheetId);
  };

  const replaceIn = (targets: Match[]) => {
    let next = workbook;
    let count = 0;
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "g" : "gi");
    for (const match of targets) {
      const target = next.sheets.find((item) => item.id === match.sheetId)!;
      const cell = getCell(target, match.row, match.col);
      const input = cellInputText(cell);
      if (cell?.f && !inFormulas) continue;
      const replaced = wholeCell ? replacement : input.replace(pattern, replacement);
      if (replaced === input) continue;
      next = setCellInput(next, match.sheetId, match.row, match.col, replaced);
      count += 1;
    }
    if (count) onApply(next, `Replaced ${count} cell${count === 1 ? "" : "s"}`);
    props.onNotice(count ? `Replaced ${count} cell${count === 1 ? "" : "s"}.` : "Nothing to replace (formula results can only be replaced with “Search formulas” on).");
  };

  return (
    <div className="sheet-panel-stack">
      <div className="sheet-find-row">
        <Search size={15} aria-hidden="true" />
        <input autoFocus type="search" value={query} placeholder="Find" aria-label="Find" onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); go(event.shiftKey ? index - 1 : index + (matches[index] ? 1 : 0)); } }} />
      </div>
      {showReplace && <input value={replacement} placeholder="Replace with" aria-label="Replace with" onChange={(event) => setReplacement(event.target.value)} />}
      <div className="sheet-find-options">
        <Check label="Match case" checked={matchCase} onChange={setMatchCase} />
        <Check label="Entire cell" checked={wholeCell} onChange={setWholeCell} />
        <Check label="Search formulas" checked={inFormulas} onChange={setInFormulas} />
        <Check label="All sheets" checked={allSheets} onChange={setAllSheets} />
      </div>
      <p className="sheet-panel-note" role="status">{query ? `${matches.length.toLocaleString("en-US")} match${matches.length === 1 ? "" : "es"}${matches.length ? ` · ${index + 1} of ${matches.length}` : ""}` : "Type to search."}</p>
      <div className="sheet-panel-actions is-wrap">
        <button type="button" className="secondary-button" disabled={!matches.length} onClick={() => go(index - 1)}>Previous</button>
        <button type="button" className="secondary-button" disabled={!matches.length} onClick={() => go(index + 1)}>Next</button>
        {!showReplace && <button type="button" className="secondary-button" onClick={() => setShowReplace(true)}>Replace…</button>}
        {showReplace && <button type="button" className="secondary-button" disabled={readOnly || !matches[index]} onClick={() => replaceIn([matches[index]])}>Replace</button>}
        {showReplace && <button type="button" className="primary-button" disabled={readOnly || !matches.length} onClick={() => replaceIn(matches)}>Replace all</button>}
      </div>
      <ul className="sheet-find-results">
        {matches.slice(0, 200).map((match, position) => (
          <li key={`${match.sheetId}-${match.row}-${match.col}`}>
            <button type="button" aria-current={position === index} onClick={() => go(position)}>
              <code>{allSheets ? `${match.sheetName}!` : ""}{cellKey(match.row, match.col)}</code>
              <span>{match.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ sort */

function SortPanel(props: Props & { quickDesc: boolean }) {
  const { workbook, sheet, engine, readOnly, onApply, active, onClose } = props;
  const region = useMemo(() => defaultRegion(props), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [ref, setRef] = useState(formatRangeRef(region));
  const range = parseRangeRef(ref);
  const [header, setHeader] = useState(() => rangeHasHeader(region, sheet.id, engine));
  const [levels, setLevels] = useState<{ col: number; desc: boolean }[]>([{ col: Math.min(Math.max(active.col, region.c1), region.c2), desc: props.quickDesc }]);
  const columns = range ? Array.from({ length: range.c2 - range.c1 + 1 }, (_, i) => range.c1 + i) : [];
  return (
    <div className="sheet-panel-stack">
      <Field label="Range to sort"><input value={ref} onChange={(event) => setRef(event.target.value.toUpperCase())} aria-invalid={!range} /></Field>
      <Check label="The first row is a header" checked={header} onChange={setHeader} />
      {levels.map((level, index) => (
        <div key={index} className="sheet-sort-level">
          <span className="sheet-field-label">{index === 0 ? "Sort by" : "Then by"}</span>
          <SelectControl aria-label={`Sort level ${index + 1} column`} value={level.col} onChange={(event) => setLevels(levels.map((item, i) => (i === index ? { ...item, col: Number(event.target.value) } : item)))}>
            {columns.map((col) => <option key={col} value={col}>{range ? columnHeaderLabel(range, col, sheet.id, engine, header) : columnLabel(col)}</option>)}
          </SelectControl>
          <RailSwitch ariaLabel={`Sort level ${index + 1} order`} value={level.desc ? "desc" : "asc"} onChange={(value) => setLevels(levels.map((item, i) => (i === index ? { ...item, desc: value === "desc" } : item)))} options={[{ value: "asc", label: "A → Z" }, { value: "desc", label: "Z → A" }]} />
          {index > 0 && <button type="button" className="sheet-icon-button" aria-label="Remove sort level" onClick={() => setLevels(levels.filter((_, i) => i !== index))}><X size={14} /></button>}
        </div>
      ))}
      <button type="button" className="secondary-button" disabled={levels.length >= 4 || !columns.length} onClick={() => setLevels([...levels, { col: columns[0], desc: false }])}><Plus size={14} /> Add level</button>
      <div className="sheet-panel-actions">
        <button
          type="button"
          className="primary-button"
          disabled={readOnly || !range}
          onClick={() => {
            if (!range) return;
            onApply(sortRange(workbook, sheet.id, range, levels, (row, col) => engine.value(sheet.id, row, col), header), `Sorted ${ref}`);
            onClose();
          }}
        >
          Sort
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ note */

function NotePanel(props: Props) {
  const { workbook, sheet, active, readOnly, onApply, onClose } = props;
  const current = getCell(sheet, active.row, active.col)?.n ?? "";
  const [text, setText] = useState(current);
  useEffect(() => setText(current), [current, active.row, active.col]);
  return (
    <div className="sheet-panel-stack">
      <p className="sheet-panel-note">Note on <strong>{cellKey(active.row, active.col)}</strong>. It shows when you point at the cell and exports to Excel as a comment.</p>
      <textarea className="sheet-note-input" autoFocus value={text} maxLength={2000} rows={6} aria-label="Note text" onChange={(event) => setText(event.target.value)} />
      <div className="sheet-panel-actions">
        {current && <button type="button" className="secondary-button" disabled={readOnly} onClick={() => { onApply(setNote(workbook, sheet.id, active.row, active.col, ""), "Deleted note"); onClose(); }}>Delete note</button>}
        <button type="button" className="primary-button" disabled={readOnly || text === current} onClick={() => { onApply(setNote(workbook, sheet.id, active.row, active.col, text), current ? "Edited note" : "Added note"); onClose(); }}>Save note</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ names */

function NamesPanel(props: Props) {
  const { workbook, sheet, selection, readOnly, onApply, onSelect } = props;
  const [name, setName] = useState("");
  const [ref, setRef] = useState(`${quoteSheetName(sheet.name)}!${formatRangeRef(selection).replace(/([A-Z]+)(\d+)/g, "$$$1$$$2")}`);
  const names = workbook.names ?? [];
  const problem = name && (tableNameProblem(name) ?? (names.some((item) => item.name.toLowerCase() === name.toLowerCase()) ? "That name exists." : null));
  return (
    <div className="sheet-panel-stack">
      <div className="sheet-field-pair">
        <Field label="Name" hint={problem || "Letters, digits, and underscores"}><input value={name} placeholder="TaxRate" onChange={(event) => setName(event.target.value.replace(/\s+/g, "_"))} aria-invalid={Boolean(problem)} /></Field>
        <Field label="Refers to"><input value={ref} onChange={(event) => setRef(event.target.value)} /></Field>
      </div>
      <div className="sheet-panel-actions">
        <button
          type="button"
          className="primary-button"
          disabled={readOnly || !name || Boolean(problem)}
          onClick={() => {
            const parsed = parseWorkbook({ ...workbook, names: [...names, { name, ref }] });
            if (!parsed.ok || (parsed.workbook.names?.length ?? 0) <= names.length) {
              props.onNotice("That reference is not a valid range.");
              return;
            }
            onApply(parsed.workbook, `Defined name ${name}`);
            setName("");
          }}
        >
          <Plus size={15} /> Add name
        </button>
      </div>
      {names.length === 0 && <p className="sheet-panel-empty">No names yet. Name inputs like a tax rate, then write =B4*TaxRate.</p>}
      <ul className="sheet-rule-list">
        {names.map((item) => (
          <li key={item.name}>
            <span className="sheet-rule-text"><strong>{item.name}</strong><small>{item.ref}</small></span>
            <span className="sheet-rule-actions">
              <button type="button" aria-label={`Go to ${item.name}`} onClick={() => {
                const split = splitSheetQualifiedRef(item.ref);
                const target = split.sheet ? sheetByName(workbook, split.sheet) : sheet;
                const range = parseRangeRef(split.ref);
                if (range && target) onSelect(range, target.id);
              }}><Search size={14} /></button>
              <button type="button" aria-label={`Delete ${item.name}`} disabled={readOnly} onClick={() => onApply({ ...workbook, names: names.filter((entry) => entry.name !== item.name) }, `Deleted name ${item.name}`)}><Trash2 size={14} /></button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ data tools */

function DuplicatesPanel(props: Props) {
  const { workbook, sheet, engine, readOnly, onApply } = props;
  const region = useMemo(() => defaultRegion(props), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [header, setHeader] = useState(() => rangeHasHeader(region, sheet.id, engine));
  const columns = Array.from({ length: region.c2 - region.c1 + 1 }, (_, i) => region.c1 + i);
  const [picked, setPicked] = useState<Set<number>>(new Set(columns));
  return (
    <div className="sheet-panel-stack">
      <p className="sheet-panel-note">Rows in <strong>{formatRangeRef(region)}</strong> whose checked columns repeat an earlier row are removed.</p>
      <Check label="The first row is a header" checked={header} onChange={setHeader} />
      <div className="sheet-check-list">
        {columns.map((col) => <Check key={col} label={columnHeaderLabel(region, col, sheet.id, engine, header)} checked={picked.has(col)} onChange={(value) => { const next = new Set(picked); if (value) next.add(col); else next.delete(col); setPicked(next); }} />)}
      </div>
      <div className="sheet-panel-actions">
        <button
          type="button"
          className="primary-button"
          disabled={readOnly || !picked.size}
          onClick={() => {
            const result = removeDuplicateRows(workbook, sheet.id, region, Array.from(picked), (row, col) => engine.value(sheet.id, row, col), header);
            if (result.removed) onApply(result.workbook, `Removed ${result.removed} duplicate row${result.removed === 1 ? "" : "s"}`);
            props.onNotice(result.removed ? `Removed ${result.removed} duplicate row${result.removed === 1 ? "" : "s"}.` : "No duplicate rows found.");
          }}
        >
          Remove duplicates
        </button>
      </div>
    </div>
  );
}

function SplitPanel(props: Props) {
  const { workbook, sheet, selection, readOnly, onApply } = props;
  const [delimiter, setDelimiter] = useState(",");
  const [custom, setCustom] = useState("");
  const actual = delimiter === "custom" ? custom : delimiter;
  return (
    <div className="sheet-panel-stack">
      <p className="sheet-panel-note">Splits the text in column <strong>{columnLabel(selection.c1)}</strong> ({formatRangeRef({ ...selection, c2: selection.c1 })}) into the columns to its right.</p>
      <Field label="Separator">
        <SelectControl value={delimiter} onChange={(event) => setDelimiter(event.target.value)}>
          <option value=",">Comma</option>
          <option value=";">Semicolon</option>
          <option value=" ">Space</option>
          <option value={"\t"}>Tab</option>
          <option value="custom">Other…</option>
        </SelectControl>
      </Field>
      {delimiter === "custom" && <Field label="Other separator"><input value={custom} maxLength={5} onChange={(event) => setCustom(event.target.value)} /></Field>}
      <div className="sheet-panel-actions">
        <button type="button" className="primary-button" disabled={readOnly || !actual} onClick={() => onApply(splitTextToColumns(workbook, sheet.id, selection, actual), "Split text to columns")}>Split</button>
      </div>
    </div>
  );
}

const CATEGORY_ORDER: FunctionCategory[] = ["Math", "Statistical", "Logical", "Lookup", "Text", "Date & time", "Financial", "Information", "Array"];

function FunctionsPanel(props: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<FunctionCategory | "All">("All");
  const list = Object.entries(SHEET_FUNCTIONS)
    .filter(([name, spec]) => (category === "All" || spec.category === category) && (!query || name.includes(query.toUpperCase()) || spec.description.toLowerCase().includes(query.toLowerCase())))
    .sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="sheet-panel-stack">
      <div className="sheet-find-row">
        <Search size={15} aria-hidden="true" />
        <input autoFocus type="search" placeholder="Search functions" aria-label="Search functions" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <Field label="Category">
        <SelectControl value={category} onChange={(event) => setCategory(event.target.value as FunctionCategory | "All")}>
          <option value="All">All ({Object.keys(SHEET_FUNCTIONS).length})</option>
          {CATEGORY_ORDER.map((item) => <option key={item} value={item}>{item}</option>)}
        </SelectControl>
      </Field>
      <ul className="sheet-function-list">
        {list.slice(0, 300).map(([name, spec]) => (
          <li key={name}>
            <button type="button" disabled={props.readOnly} onClick={() => props.onInsertFunction?.(name)}>
              <code>{name}({spec.signature})</code>
              <span>{spec.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
