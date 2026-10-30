import {
  ArrowDownAZ,
  ArrowDownZA,
  ChartColumn,
  ClipboardPaste,
  Columns3,
  Copy,
  Eraser,
  EyeOff,
  Filter,
  Highlighter,
  ListChecks,
  Rows3,
  Scissors,
  StickyNote,
  Table2,
  TableProperties,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type CellPoint, columnLabel, parseRangeRef } from "../../lib/sheet/address";
import { filterColumnValues } from "../../lib/sheet/decorations";
import type { WorkbookEngine } from "../../lib/sheet/recalc";
import type { Sheet, SheetFilter, SheetFilterCriteria, Workbook } from "../../lib/sheet/sheetModel";
import { listItems, validationAt } from "../../lib/sheet/validation";
import { AiPen } from "./AiPen";
import type { GridPointerTarget } from "./SheetGrid";
import { SelectControl } from "../SelectControl";

export type ContextMenuState = { x: number; y: number; target: GridPointerTarget };

export type ContextCommand =
  | "cut" | "copy" | "paste" | "pasteValues" | "pasteFormats" | "pasteTranspose"
  | "insertRowsAbove" | "insertRowsBelow" | "insertColsLeft" | "insertColsRight" | "deleteRows" | "deleteCols"
  | "clear" | "clearFormats" | "sortAsc" | "sortDesc" | "filter" | "note" | "chart" | "table" | "pivot"
  | "conditional" | "validation" | "hideRows" | "hideCols" | "unhide" | "autofit" | "ai";

function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", key);
    };
  }, [ref, onClose]);
}

function useClampedPosition(ref: React.RefObject<HTMLElement | null>, x: number, y: number) {
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const width = node.offsetWidth || 240;
    const height = node.offsetHeight || 300;
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
    node.querySelector<HTMLElement>("button:not(:disabled), input")?.focus({ preventScroll: true });
  }, [ref, x, y]);
  return position;
}

function Item({ icon, label, onClick, disabled, shortcut, danger }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean; shortcut?: string; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" className={danger ? "is-danger" : undefined} disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

export function SheetContextMenu({ menu, readOnly, hasClip, aiAvailable, onClose, onCommand }: { menu: ContextMenuState; readOnly: boolean; hasClip: boolean; aiAvailable: boolean; onClose: () => void; onCommand: (command: ContextCommand) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const position = useClampedPosition(ref, menu.x, menu.y);
  const kind = menu.target.kind;
  const rows = kind === "row" || kind === "corner";
  const cols = kind === "col" || kind === "corner";
  return (
    <div ref={ref} className="document-insert-menu sheet-menu sheet-context-menu" role="menu" aria-label="Cell actions" style={position}>
      <Item icon={<Scissors size={15} />} label="Cut" shortcut="⌘X" disabled={readOnly} onClick={() => onCommand("cut")} />
      <Item icon={<Copy size={15} />} label="Copy" shortcut="⌘C" onClick={() => onCommand("copy")} />
      <Item icon={<ClipboardPaste size={15} />} label="Paste" shortcut="⌘V" disabled={readOnly} onClick={() => onCommand("paste")} />
      <Item icon={<ClipboardPaste size={15} />} label="Paste values only" shortcut="⌘⇧V" disabled={readOnly} onClick={() => onCommand("pasteValues")} />
      <Item icon={<ClipboardPaste size={15} />} label="Paste formatting only" disabled={readOnly || !hasClip} onClick={() => onCommand("pasteFormats")} />
      <Item icon={<ClipboardPaste size={15} />} label="Paste transposed" disabled={readOnly} onClick={() => onCommand("pasteTranspose")} />
      <span className="sheet-menu-separator" role="separator" />
      {!cols && <Item icon={<Rows3 size={15} />} label="Insert rows above" disabled={readOnly} onClick={() => onCommand("insertRowsAbove")} />}
      {!cols && <Item icon={<Rows3 size={15} />} label="Insert rows below" disabled={readOnly} onClick={() => onCommand("insertRowsBelow")} />}
      {!rows && <Item icon={<Columns3 size={15} />} label="Insert columns left" disabled={readOnly} onClick={() => onCommand("insertColsLeft")} />}
      {!rows && <Item icon={<Columns3 size={15} />} label="Insert columns right" disabled={readOnly} onClick={() => onCommand("insertColsRight")} />}
      {!cols && <Item icon={<Trash2 size={15} />} label="Delete rows" danger disabled={readOnly} onClick={() => onCommand("deleteRows")} />}
      {!rows && <Item icon={<Trash2 size={15} />} label="Delete columns" danger disabled={readOnly} onClick={() => onCommand("deleteCols")} />}
      {kind === "row" && <Item icon={<EyeOff size={15} />} label="Hide rows" disabled={readOnly} onClick={() => onCommand("hideRows")} />}
      {kind === "col" && <Item icon={<EyeOff size={15} />} label="Hide columns" disabled={readOnly} onClick={() => onCommand("hideCols")} />}
      {kind === "col" && <Item icon={<Columns3 size={15} />} label="Auto-fit width" disabled={readOnly} onClick={() => onCommand("autofit")} />}
      {(kind === "row" || kind === "col") && <Item icon={<EyeOff size={15} />} label="Unhide nearby" disabled={readOnly} onClick={() => onCommand("unhide")} />}
      <Item icon={<Eraser size={15} />} label="Clear contents" shortcut="Del" disabled={readOnly} onClick={() => onCommand("clear")} />
      <Item icon={<Eraser size={15} />} label="Clear formatting" disabled={readOnly} onClick={() => onCommand("clearFormats")} />
      <span className="sheet-menu-separator" role="separator" />
      <Item icon={<ArrowDownAZ size={15} />} label="Sort A → Z" disabled={readOnly} onClick={() => onCommand("sortAsc")} />
      <Item icon={<ArrowDownZA size={15} />} label="Sort Z → A" disabled={readOnly} onClick={() => onCommand("sortDesc")} />
      <Item icon={<Filter size={15} />} label="Filter" shortcut="⌘⇧L" disabled={readOnly} onClick={() => onCommand("filter")} />
      <Item icon={<StickyNote size={15} />} label="Note…" disabled={readOnly} onClick={() => onCommand("note")} />
      <Item icon={<ListChecks size={15} />} label="Data validation…" disabled={readOnly} onClick={() => onCommand("validation")} />
      <Item icon={<Highlighter size={15} />} label="Conditional formatting…" disabled={readOnly} onClick={() => onCommand("conditional")} />
      <Item icon={<Table2 size={15} />} label="Format as table…" disabled={readOnly} onClick={() => onCommand("table")} />
      <Item icon={<ChartColumn size={15} />} label="Insert chart…" disabled={readOnly} onClick={() => onCommand("chart")} />
      <Item icon={<TableProperties size={15} />} label="Pivot table…" disabled={readOnly} onClick={() => onCommand("pivot")} />
      <span className="sheet-menu-separator" role="separator" />
      <Item icon={<AiPen size={15} />} label="Ask AI about this" shortcut="⌘J" disabled={readOnly || !aiAvailable} onClick={() => onCommand("ai")} />
    </div>
  );
}

type FilterMenuProps = {
  col: number;
  anchor: DOMRect;
  filter: SheetFilter;
  sheet: Sheet;
  engine: WorkbookEngine;
  readOnly: boolean;
  onApply: (filter: SheetFilter, label: string) => void;
  onSort: (desc: boolean) => void;
  onClose: () => void;
};

const CONDITIONS: { value: string; label: string }[] = [
  { value: "", label: "No condition" },
  { value: "contains", label: "Text contains" },
  { value: "notContains", label: "Text does not contain" },
  { value: "begins", label: "Text starts with" },
  { value: "eq", label: "Equals" },
  { value: "neq", label: "Does not equal" },
  { value: "gt", label: "Greater than" },
  { value: "gte", label: "Greater than or equal to" },
  { value: "lt", label: "Less than" },
  { value: "lte", label: "Less than or equal to" },
  { value: "between", label: "Between" },
  { value: "notBetween", label: "Not between" },
];

/** Conditions with a lower and an upper bound, both inclusive. */
const RANGE_CONDITIONS = new Set(["between", "notBetween"]);

/** The condition the menu describes, or none until every bound it needs is filled in. */
function menuCondition(op: string, value: string, upper: string): SheetFilterCriteria["condition"] {
  const lower = value.trim();
  if (!op || !lower) return undefined;
  if (!RANGE_CONDITIONS.has(op)) return { op: op as "gt", value: lower };
  return upper.trim() ? { op: op as "between", value: lower, value2: upper.trim() } : undefined;
}

type ColumnValue = { label: string; count: number };

const NO_CONDITION = { op: "", value: "", value2: "" };

/** What the menu opens with: the column's saved values (all when none) and condition. */
function initialMenu(current: SheetFilterCriteria | undefined, values: ColumnValue[]) {
  const saved = { ...NO_CONDITION, ...current?.condition };
  const labels = current?.values ?? values.map((item) => item.label);
  return { checked: new Set(labels.map((label) => label.toLowerCase())), condition: saved.op, operand: saved.value, upper: saved.value2 };
}

/** The checked set with `labels` switched on or off. */
function toggledLabels(checked: Set<string>, labels: string[], on: boolean): Set<string> {
  const next = new Set(checked);
  for (const label of labels) {
    if (on) next.add(label.toLowerCase());
    else next.delete(label.toLowerCase());
  }
  return next;
}

/** The column's criteria: the checked values unless every value is, and a complete condition. */
function menuCriteria(values: ColumnValue[], checked: Set<string>, condition: SheetFilterCriteria["condition"]): SheetFilterCriteria | undefined {
  const kept = values.filter((item) => checked.has(item.label.toLowerCase())).map((item) => item.label);
  const criteria: SheetFilterCriteria = {};
  if (kept.length < values.length) criteria.values = kept;
  if (condition) criteria.condition = condition;
  return criteria.values || criteria.condition ? criteria : undefined;
}

/** Filter criteria with one column's entry replaced, or removed when it has none. */
function withColumn(criteria: SheetFilter["criteria"], letter: string, entry: SheetFilterCriteria | undefined): SheetFilter["criteria"] {
  const next = { ...criteria };
  if (entry) next[letter] = entry;
  else delete next[letter];
  return next;
}

type ConditionFieldProps = {
  condition: string;
  operand: string;
  upper: string;
  onCondition: (value: string) => void;
  onOperand: (value: string) => void;
  onUpper: (value: string) => void;
};

/** The condition picker; between and not between ask for a lower and an upper value. */
function FilterConditionField({ condition, operand, upper, onCondition, onOperand, onUpper }: ConditionFieldProps) {
  const ranged = RANGE_CONDITIONS.has(condition);
  return (
    <label className="sheet-field">
      <span>Condition</span>
      <span className="sheet-field-row">
        <SelectControl value={condition} onChange={(event) => onCondition(event.target.value)} aria-label="Filter condition">
          {CONDITIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </SelectControl>
        {condition && !ranged && <input value={operand} onChange={(event) => onOperand(event.target.value)} aria-label="Condition value" placeholder="Value" />}
      </span>
      {ranged && (
        <span className="sheet-field-pair">
          <input value={operand} onChange={(event) => onOperand(event.target.value)} aria-label="Condition value" placeholder="From" />
          <input value={upper} onChange={(event) => onUpper(event.target.value)} aria-label="Upper value" placeholder="To" />
        </span>
      )}
    </label>
  );
}

/** The searchable value checklist; "(Select all)" switches the values the search shows. */
function FilterValueList({ shown, checked, onChecked }: { shown: ColumnValue[]; checked: Set<string>; onChecked: (next: Set<string>) => void }) {
  return (
    <div className="sheet-filter-values" role="group" aria-label="Values to show">
      <label className="sheet-check is-all">
        <input
          type="checkbox"
          checked={shown.every((item) => checked.has(item.label.toLowerCase()))}
          onChange={(event) => onChecked(toggledLabels(checked, shown.map((item) => item.label), event.target.checked))}
        />
        <span>(Select all)</span>
      </label>
      {shown.slice(0, 500).map((item) => (
        <label key={item.label} className="sheet-check">
          <input type="checkbox" checked={checked.has(item.label.toLowerCase())} onChange={(event) => onChecked(toggledLabels(checked, [item.label], event.target.checked))} />
          <span>{item.label}</span>
          <small>{item.count}</small>
        </label>
      ))}
    </div>
  );
}

/** Excel's autofilter dropdown: sort, condition, and a searchable value list. */
export function SheetFilterMenu({ col, anchor, filter, sheet, engine, readOnly, onApply, onSort, onClose }: FilterMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const position = useClampedPosition(ref, anchor.left, anchor.bottom + 4);
  const range = parseRangeRef(filter.ref)!;
  const letter = columnLabel(col);
  const values = useMemo(() => filterColumnValues(range, col, sheet.id, engine), [range, col, sheet.id, engine]);
  const current = filter.criteria[letter];
  const [initial] = useState(() => initialMenu(current, values));
  const [checked, setChecked] = useState(initial.checked);
  const [search, setSearch] = useState("");
  const [condition, setCondition] = useState(initial.condition);
  const [operand, setOperand] = useState(initial.operand);
  const [upper, setUpper] = useState(initial.upper);
  const shown = values.filter((item) => item.label.toLowerCase().includes(search.toLowerCase()));
  const name = engine.value(sheet.id, range.r1, col) ?? letter;

  const finish = (entry: SheetFilterCriteria | undefined, label: string) => {
    onApply({ ...filter, criteria: withColumn(filter.criteria, letter, entry) }, label);
    onClose();
  };
  const apply = () => finish(menuCriteria(values, checked, menuCondition(condition, operand, upper)), `Filtered ${name}`);

  return (
    <div ref={ref} className="sheet-filter-menu" role="dialog" aria-label={`Filter ${name}`} style={position}>
      <div className="sheet-filter-sorts">
        <button type="button" disabled={readOnly} onClick={() => onSort(false)}><ArrowDownAZ size={15} /> Sort A → Z</button>
        <button type="button" disabled={readOnly} onClick={() => onSort(true)}><ArrowDownZA size={15} /> Sort Z → A</button>
      </div>
      <FilterConditionField condition={condition} operand={operand} upper={upper} onCondition={setCondition} onOperand={setOperand} onUpper={setUpper} />
      <input className="sheet-filter-search" type="search" placeholder="Search values" aria-label="Search values" value={search} onChange={(event) => setSearch(event.target.value)} />
      <FilterValueList shown={shown} checked={checked} onChecked={setChecked} />
      <div className="sheet-panel-actions">
        <button type="button" className="secondary-button" disabled={readOnly || !current} onClick={() => finish(undefined, "Cleared column filter")}>Clear</button>
        <button type="button" className="primary-button" disabled={readOnly} onClick={apply}>Apply</button>
      </div>
    </div>
  );
}

export function SheetValidationList({ anchor, sheet, workbook, engine, point, onPick, onClose }: { anchor: DOMRect; sheet: Sheet; workbook: Workbook; engine: WorkbookEngine; point: CellPoint; onPick: (value: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const position = useClampedPosition(ref, anchor.left - 160, anchor.bottom + 2);
  const rule = validationAt(sheet, point.row, point.col);
  const items = rule ? listItems(rule, sheet, workbook, engine) : [];
  return (
    <div ref={ref} className="document-insert-menu sheet-menu sheet-validation-list" role="listbox" aria-label="Allowed values" style={position}>
      {items.length ? items.map((item) => (
        <button key={item} type="button" role="option" aria-selected={false} onClick={() => onPick(item)}>{item}</button>
      )) : <p className="sheet-menu-empty">No list items.</p>}
    </div>
  );
}
