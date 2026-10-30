import { Check, Columns3, Pencil, Rows3, Trash2, Undo2, type LucideIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { inlineMarkdownToHtml, type MarkdownTable } from "../lib/markdown";
import {
  canDeleteColumn,
  canDeleteRow,
  deleteTableColumn,
  deleteTableRow,
  inlineHtmlToMarkdown,
  insertTableColumn,
  insertTableRow,
  moveTableCell,
  setTableCell,
  tableCellText,
  type TableCell,
  type TableMove,
} from "../lib/tableEditing";

const MAX_UNDO = 20;
const SAVE_FAILED = "That edit could not be saved. The reply changed underneath it; try again.";

type RenderCell = (text: string) => ReactNode;
/** Saves `next` over `previous` in the reply; false when it could not. */
type SaveTable = (previous: MarkdownTable, next: MarkdownTable) => boolean;
/** Where the caret goes in a cell that opens: the clicked character, the
 * end (null), or the whole text selected ("all", so typing replaces it). */
type CaretSpot = number | "all" | null;
type ActiveCell = { cell: TableCell; caret: CaretSpot };
type EditorState = {
  /** The cell open for typing. */
  active: ActiveCell | null;
  /** The cell the row and column tools act on. */
  selected: TableCell | null;
  /** Tables to step back to, oldest first. */
  history: MarkdownTable[];
  notice: string | null;
};

const IDLE: EditorState = { active: null, selected: null, history: [], notice: null };

/** Everything the editing steps below read and change, for one render. */
type EditorKit = {
  table: MarkdownTable;
  state: EditorState;
  onSave: SaveTable;
  update: (change: (state: EditorState) => Partial<EditorState>) => void;
  editor: MutableRefObject<HTMLSpanElement | null>;
  tools: MutableRefObject<HTMLDivElement | null>;
  /** The open cell has been typed in. */
  dirty: MutableRefObject<boolean>;
  /** Set when the editor closes on purpose, so the blur that follows (some
   * browsers blur an element as it leaves the page) does not commit twice. */
  closing: MutableRefObject<boolean>;
};

/* ------------------------------------------------------------------ */
/* Caret placement                                                     */
/* ------------------------------------------------------------------ */

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function caretAt(doc: CaretDocument, x: number, y: number): { node: Node; offset: number } | null {
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** Characters before the clicked point, so the caret lands where the reader
 * clicked once the cell turns editable. Null where the browser cannot say. */
function clickOffset(cell: HTMLElement, x: number, y: number): number | null {
  const caret = caretAt(cell.ownerDocument as CaretDocument, x, y);
  if (!caret || !cell.contains(caret.node)) return null;
  const before = cell.ownerDocument.createRange();
  before.selectNodeContents(cell);
  before.setEnd(caret.node, caret.offset);
  return before.toString().length;
}

function placeCaret(editor: HTMLElement, spot: CaretSpot) {
  const selection = editor.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  const range = editor.ownerDocument.createRange();
  range.selectNodeContents(editor);
  if (spot !== "all") range.collapse(false);
  const walker = editor.ownerDocument.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let remaining = typeof spot === "number" ? spot : Number.POSITIVE_INFINITY;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // The walker shows only text nodes.
    const length = (node as Text).length;
    if (remaining <= length) {
      range.setStart(node, remaining);
      range.collapse(true);
      break;
    }
    remaining -= length;
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/* ------------------------------------------------------------------ */
/* Editing steps                                                       */
/* ------------------------------------------------------------------ */

function sameCell(left: TableCell | null | undefined, right: TableCell): boolean {
  return Boolean(left && left.row === right.row && left.col === right.col);
}

/** The table with the open cell's typing applied, or null when unchanged. */
function pendingEdit(kit: EditorKit): MarkdownTable | null {
  const editor = kit.editor.current;
  const active = kit.state.active;
  if (!active || !editor || !kit.dirty.current) return null;
  const text = inlineHtmlToMarkdown(editor);
  return text === tableCellText(kit.table, active.cell) ? null : setTableCell(kit.table, active.cell, text);
}

function saveTable(kit: EditorKit, next: MarkdownTable, undoTo: MarkdownTable[]): boolean {
  const saved = kit.onSave(kit.table, next);
  kit.update((state) =>
    saved ? { notice: null, history: [...state.history, ...undoTo].slice(-MAX_UNDO) } : { notice: SAVE_FAILED },
  );
  return saved;
}

/** Closes the open cell (saving its typing when `commit`) and returns the
 * table as it now stands. */
function closeCell(kit: EditorKit, commit: boolean): MarkdownTable {
  const edited = commit ? pendingEdit(kit) : null;
  kit.closing.current = true;
  kit.update(() => ({ active: null }));
  return edited && saveTable(kit, edited, [kit.table]) ? edited : kit.table;
}

function openCell(kit: EditorKit, cell: TableCell, caret: CaretSpot) {
  kit.update(() => ({ active: { cell, caret }, selected: cell }));
}

function clickCell(kit: EditorKit, event: MouseEvent<HTMLElement>, cell: TableCell) {
  if ((event.target as Element).closest("a") || sameCell(kit.state.active?.cell, cell)) return;
  openCell(kit, cell, clickOffset(event.currentTarget, event.clientX, event.clientY));
}

const MOVE_KEYS: Record<string, [TableMove, TableMove]> = {
  Tab: ["next", "previous"],
  Enter: ["down", "up"],
};

/** Escape cancels the open cell; Tab and Enter save it and move on, like a
 * spreadsheet (Shift goes back). */
function cellKeyDown(kit: EditorKit, event: KeyboardEvent<HTMLSpanElement>) {
  const active = kit.state.active;
  if (event.nativeEvent.isComposing || !active) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeCell(kit, false);
    kit.tools.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return;
  }
  const moves = MOVE_KEYS[event.key];
  if (!moves) return;
  event.preventDefault();
  const target = moveTableCell(closeCell(kit, true), active.cell, event.shiftKey ? moves[1] : moves[0]);
  if (target) openCell(kit, target, "all");
}

function pastePlainText(event: ClipboardEvent<HTMLSpanElement>) {
  event.preventDefault();
  const text = event.clipboardData.getData("text/plain").replace(/\s*\r?\n\s*/g, " ");
  document.execCommand("insertText", false, text);
}

type TableTool = {
  label: string;
  name: string;
  tooltip: string;
  icon: LucideIcon;
  apply: (table: MarkdownTable, cell: TableCell) => MarkdownTable;
  /** The cell in use once the tool has run. */
  select: (next: MarkdownTable, cell: TableCell) => TableCell;
  allowed: (table: MarkdownTable, cell: TableCell) => boolean;
};

const TABLE_TOOLS: TableTool[] = [
  {
    label: "Add row",
    name: "Add row below",
    tooltip: "Add an empty row under this cell's row",
    icon: Rows3,
    apply: (table, cell) => insertTableRow(table, cell.row),
    select: (_, cell) => ({ row: cell.row + 1, col: cell.col }),
    allowed: () => true,
  },
  {
    label: "Add column",
    name: "Add column to the right",
    tooltip: "Add an empty column right of this cell's column",
    icon: Columns3,
    apply: (table, cell) => insertTableColumn(table, cell.col),
    select: (_, cell) => ({ row: cell.row, col: cell.col + 1 }),
    allowed: () => true,
  },
  {
    label: "Delete row",
    name: "Delete row",
    tooltip: "Remove this cell's row (a table keeps at least one)",
    icon: Trash2,
    apply: (table, cell) => deleteTableRow(table, cell.row),
    select: (next, cell) => ({ row: Math.min(cell.row, next.rows.length - 1), col: cell.col }),
    allowed: canDeleteRow,
  },
  {
    label: "Delete column",
    name: "Delete column",
    tooltip: "Remove this cell's column (a table keeps at least two)",
    icon: Trash2,
    apply: (table, cell) => deleteTableColumn(table, cell.col),
    select: (next, cell) => ({ row: cell.row, col: Math.min(cell.col, next.headers.length - 1) }),
    allowed: (table) => canDeleteColumn(table),
  },
];

/** A tool acts on the cell in use, together with any typing still open in
 * it: one save, and Undo steps back through both. */
function runTool(kit: EditorKit, tool: TableTool) {
  const cell = kit.state.active?.cell ?? kit.state.selected;
  if (!cell) return;
  const edited = pendingEdit(kit);
  kit.closing.current = true;
  kit.update(() => ({ active: null }));
  const base = edited ?? kit.table;
  const next = tool.apply(base, cell);
  if (saveTable(kit, next, edited ? [kit.table, edited] : [kit.table])) {
    kit.update(() => ({ selected: tool.select(next, cell) }));
  }
}

function undoTable(kit: EditorKit) {
  const previous = kit.state.history.at(-1);
  if (!previous) return;
  kit.closing.current = true;
  const undone = kit.onSave(kit.table, previous);
  kit.update((state) =>
    undone ? { active: null, history: state.history.slice(0, -1), notice: null } : { active: null, notice: SAVE_FAILED },
  );
}

function finishEditing(kit: EditorKit) {
  if (kit.state.active) closeCell(kit, true);
  kit.update(() => ({ selected: null }));
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function alignStyle(table: MarkdownTable, col: number): CSSProperties | undefined {
  const align = table.aligns[col];
  return align ? { textAlign: align } : undefined;
}

function cellLabel(table: MarkdownTable, cell: TableCell): string {
  const column = (table.headers[cell.col] ?? "").replace(/[*_`]/g, "").trim() || "column";
  return `Edit ${column}, ${cell.row < 0 ? "header" : `row ${cell.row + 1}`}`;
}

function CellEditor({ kit, cell }: { kit: EditorKit; cell: TableCell }) {
  return (
    <span
      ref={kit.editor}
      className="md-table-cell-editor"
      contentEditable
      role="textbox"
      aria-label={cellLabel(kit.table, cell)}
      aria-multiline="false"
      spellCheck
      onInput={() => {
        kit.dirty.current = true;
      }}
      onKeyDown={(event) => cellKeyDown(kit, event)}
      onBlur={() => {
        if (!kit.closing.current) closeCell(kit, true);
      }}
      onPaste={pastePlainText}
      onDrop={(event) => event.preventDefault()}
    />
  );
}

function EditableCell({
  kit,
  as: Tag,
  cell,
  text,
  renderCell,
}: {
  kit: EditorKit;
  as: "th" | "td";
  cell: TableCell;
  text: string;
  renderCell: RenderCell;
}) {
  const editing = sameCell(kit.state.active?.cell, cell);
  const className = editing ? "is-active" : sameCell(kit.state.selected, cell) ? "is-selected" : undefined;
  return (
    <Tag className={className} style={alignStyle(kit.table, cell.col)} onClick={(event) => clickCell(kit, event, cell)}>
      {editing ? <CellEditor kit={kit} cell={cell} /> : renderCell(text)}
    </Tag>
  );
}

function ToolButton({
  name,
  tooltip,
  icon: Icon,
  label,
  disabled = false,
  className = "md-table-tool",
  onClick,
}: {
  name: string;
  tooltip: string;
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button className={className} type="button" aria-label={name} data-tooltip={tooltip} disabled={disabled} onClick={onClick}>
      <Icon size={13} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function TableTools({ kit }: { kit: EditorKit }) {
  const cell = kit.state.active?.cell ?? kit.state.selected;
  return (
    <div
      className="md-table-tools"
      role="toolbar"
      aria-label="Table tools"
      ref={kit.tools}
      // Pressing a tool keeps focus in the open cell; the tool saves its typing.
      onMouseDown={(event) => event.preventDefault()}
    >
      {cell ? (
        <>
          {TABLE_TOOLS.map((tool) => (
            <ToolButton
              key={tool.name}
              {...tool}
              disabled={!tool.allowed(kit.table, cell)}
              onClick={() => runTool(kit, tool)}
            />
          ))}
          <ToolButton
            name="Undo table edit"
            tooltip="Undo the last change to this table"
            icon={Undo2}
            label="Undo"
            disabled={!kit.state.history.length}
            onClick={() => undoTable(kit)}
          />
          <ToolButton
            name="Done editing table"
            tooltip="Save and close the table tools"
            icon={Check}
            label="Done"
            className="md-table-tool is-done"
            onClick={() => finishEditing(kit)}
          />
        </>
      ) : (
        <ToolButton
          name="Edit table"
          tooltip="Click any cell to type in it, or start from the first header"
          icon={Pencil}
          label="Edit table"
          className="md-table-tool is-quiet"
          onClick={() => openCell(kit, { row: -1, col: 0 }, "all")}
        />
      )}
      {kit.state.notice && (
        <span className="md-table-notice" role="status">
          {kit.state.notice}
        </span>
      )}
    </div>
  );
}

/** Seeds the cell that just opened with its text (formatting shown, not
 * markdown), focused at the clicked point. It runs once per opened cell, so
 * later renders never overwrite what the reader is typing. */
function useCellEditorSeed(kit: EditorKit) {
  const active = kit.state.active;
  useLayoutEffect(() => {
    const editor = kit.editor.current;
    if (!active || !editor) return;
    kit.closing.current = false;
    kit.dirty.current = false;
    editor.innerHTML = inlineMarkdownToHtml(tableCellText(kit.table, active.cell));
    editor.focus();
    placeCaret(editor, active.caret);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/** A press anywhere outside the table puts its tools away. */
function useLeaveOnOutsidePress(kit: EditorKit, block: MutableRefObject<HTMLDivElement | null>) {
  const selected = kit.state.selected;
  useEffect(() => {
    if (!selected) return;
    const leave = (event: PointerEvent) => {
      if (!block.current?.contains(event.target as Node)) kit.update(() => ({ selected: null }));
    };
    document.addEventListener("pointerdown", leave, true);
    return () => document.removeEventListener("pointerdown", leave, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
}

/** A table in a finished reply that the reader can edit in place: click a
 * header or cell to type in it, Tab/Enter to move on, Escape to cancel. The
 * tools under it add and remove rows and columns and undo. Every change is
 * saved into the reply's markdown, so whatever the reader shapes here is
 * what Transfer to Drafts carries. */
export function EditableMarkdownTable({
  table,
  renderCell,
  onSave,
}: {
  table: MarkdownTable;
  renderCell: RenderCell;
  onSave: SaveTable;
}) {
  const [state, setState] = useState<EditorState>(IDLE);
  const kit: EditorKit = {
    table,
    state,
    onSave,
    update: (change) => setState((current) => ({ ...current, ...change(current) })),
    editor: useRef<HTMLSpanElement | null>(null),
    tools: useRef<HTMLDivElement | null>(null),
    dirty: useRef(false),
    closing: useRef(false),
  };
  const blockRef = useRef<HTMLDivElement | null>(null);
  useCellEditorSeed(kit);
  useLeaveOnOutsidePress(kit, blockRef);
  const inUse = Boolean(state.active ?? state.selected);

  return (
    <div className={`md-table-block${inUse ? " is-editing" : ""}`} ref={blockRef}>
      <div className="md-table-scroller">
        <table className="md-table is-editable">
          <thead>
            <tr>
              {table.headers.map((header, col) => (
                <EditableCell key={col} kit={kit} as="th" cell={{ row: -1, col }} text={header} renderCell={renderCell} />
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {table.headers.map((_, col) => (
                  <EditableCell
                    key={col}
                    kit={kit}
                    as="td"
                    cell={{ row: rowIndex, col }}
                    text={row[col] ?? ""}
                    renderCell={renderCell}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TableTools kit={kit} />
    </div>
  );
}

/** A table as the reply shows it, read-only. */
export function MarkdownTableView({ table, renderCell }: { table: MarkdownTable; renderCell: RenderCell }) {
  return (
    <div className="md-table-scroller">
      <table className="md-table">
        <thead>
          <tr>
            {table.headers.map((header, col) => (
              <th key={col} style={alignStyle(table, col)}>
                {renderCell(header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {table.headers.map((_, col) => (
                <td key={col} style={alignStyle(table, col)}>
                  {renderCell(row[col] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A reply's table: editable when the reply can save it, read-only otherwise. */
export function MarkdownTableBlock({
  table,
  renderCell,
  onSave,
}: {
  table: MarkdownTable;
  renderCell: RenderCell;
  onSave?: SaveTable;
}) {
  return onSave ? (
    <EditableMarkdownTable table={table} renderCell={renderCell} onSave={onSave} />
  ) : (
    <MarkdownTableView table={table} renderCell={renderCell} />
  );
}
