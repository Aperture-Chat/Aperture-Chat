import clsx from "clsx";
import { ChevronLeft, ChevronRight, Copy, Eye, EyeOff, List, Palette, PencilLine, Plus, Trash2, X } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SHEET_ACCENTS } from "../../lib/sheet/palette";
import { type Sheet, type Workbook, MAX_SHEETS } from "../../lib/sheet/sheetModel";
import { addSheet, deleteSheet, duplicateSheet, moveSheet, renameSheet, setSheetProps } from "../../lib/sheet/sheetOps";

type Props = {
  workbook: Workbook;
  activeId: string;
  readOnly: boolean;
  onActivate: (id: string) => void;
  onChange: (workbook: Workbook, label: string, activeId?: string) => void;
  onNotice: (message: string) => void;
};

const TAB_COLORS = [...Object.values(SHEET_ACCENTS), "#64748b"];

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

/** What deleting a sheet would take with it, or null when it holds nothing. */
export function sheetContents(sheet: Sheet): string | null {
  const parts = [
    [Object.keys(sheet.cells).length, "filled cell"],
    [sheet.charts?.length ?? 0, "chart"],
    [sheet.pivots?.length ?? 0, "pivot table"],
    [sheet.tables?.length ?? 0, "table"],
  ] as const;
  const held = parts.filter(([count]) => count > 0).map(([count, noun]) => plural(count, noun));
  return held.length ? held.join(", ") : null;
}

/** The platform's confirm dialog for deleting a sheet that holds something. */
function DeleteSheetDialog({ sheet, onCancel, onConfirm }: { sheet: Sheet; onCancel: () => void; onConfirm: (sheet: Sheet) => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const title = `Delete "${sheet.name}"?`;
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section
        className="modal confirm-dialog sheet-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onCancel();
        }}
      >
        <h2>{title}</h2>
        <p>This removes its {sheetContents(sheet)}. Formulas on other sheets that read it will show #REF!. You can undo this with ⌘Z.</p>
        <div className="modal-actions">
          <button ref={cancel} type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="danger-button" onClick={() => onConfirm(sheet)}>Delete sheet</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

type Change = (workbook: Workbook, label: string, activeId?: string) => void;
type MenuAt = { id: string; x: number; y: number };
type Renaming = { id: string; value: string };

function AddSheetButton({ workbook, activeId, readOnly, onChange }: { workbook: Workbook; activeId: string; readOnly: boolean; onChange: Change }) {
  const full = workbook.sheets.length >= MAX_SHEETS;
  return (
    <button
      type="button"
      className="sheet-tab-add"
      aria-label="Add sheet"
      data-tooltip={full ? `Workbooks can hold up to ${MAX_SHEETS} sheets` : "Add a sheet"}
      disabled={readOnly || full}
      onClick={() => {
        const added = addSheet(workbook, undefined, activeId);
        onChange(added.workbook, "Added a sheet", added.sheetId);
      }}
    >
      <Plus size={16} />
    </button>
  );
}

/** Every sheet, hidden ones too: pick one to show it. */
function AllSheetsMenu({ workbook, activeId, readOnly, onPick }: { workbook: Workbook; activeId: string; readOnly: boolean; onPick: (sheet: Sheet) => void }) {
  return (
    <div className="document-insert-menu sheet-menu sheet-tab-menu is-up" role="menu" aria-label="All sheets">
      {workbook.sheets.map((sheet) => (
        <button key={sheet.id} type="button" role="menuitemradio" aria-checked={sheet.id === activeId} disabled={sheet.hidden && readOnly} onClick={() => onPick(sheet)}>
          {sheet.hidden ? <EyeOff size={15} /> : <span className="sheet-tab-dot" style={{ background: sheet.color ?? "transparent" }} aria-hidden="true" />}
          <span>{sheet.name}</span>
          {sheet.hidden && <small>Hidden — click to show</small>}
        </button>
      ))}
    </div>
  );
}

function TabRenameInput({ renaming, onEdit, onFinish, onCancel }: { renaming: Renaming; onEdit: (value: string) => void; onFinish: () => void; onCancel: () => void }) {
  return (
    <input
      className="sheet-tab-rename"
      aria-label="Sheet name"
      autoFocus
      value={renaming.value}
      maxLength={31}
      onChange={(event) => onEdit(event.target.value)}
      onBlur={onFinish}
      onKeyDown={(event) => {
        if (event.key === "Enter") onFinish();
        if (event.key === "Escape") onCancel();
        event.stopPropagation();
      }}
    />
  );
}

type TabHandlers = {
  onActivate: (id: string) => void;
  onRename: (sheet: Sheet) => void;
  onMenu: (at: MenuAt) => void;
  onDelete: (sheet: Sheet) => void;
  onDragStart: (id: string, position: number) => void;
  onDragOver: (position: number) => void;
  onDrop: (sheet: Sheet) => void;
};

/** Keys on a focused tab: F2 renames, Delete deletes, the menu key opens its menu. */
function tabKeyDown(event: KeyboardEvent<HTMLButtonElement>, sheet: Sheet, handlers: TabHandlers) {
  if (event.key === "F2") handlers.onRename(sheet);
  if (event.key === "Delete") handlers.onDelete(sheet);
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    const box = event.currentTarget.getBoundingClientRect();
    handlers.onMenu({ id: sheet.id, x: box.left, y: box.top });
  }
}

/** The tab itself: click to show, double-click or F2 to rename, right-click
 * for its menu, and drag onto another tab to reorder. */
function TabButton({ sheet, position, active, readOnly, handlers }: { sheet: Sheet; position: number; active: boolean; readOnly: boolean; handlers: TabHandlers }) {
  const startsDrag = (event: ReactPointerEvent) => !readOnly && event.button === 0 && event.pointerType !== "touch";
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-tooltip="Double-click to rename; right-click for more"
      onClick={() => handlers.onActivate(sheet.id)}
      onDoubleClick={() => handlers.onRename(sheet)}
      onContextMenu={(event) => {
        event.preventDefault();
        handlers.onActivate(sheet.id);
        handlers.onMenu({ id: sheet.id, x: event.clientX, y: event.clientY });
      }}
      onPointerDown={(event) => startsDrag(event) && handlers.onDragStart(sheet.id, position)}
      onPointerUp={() => handlers.onDrop(sheet)}
      onKeyDown={(event) => tabKeyDown(event, sheet, handlers)}
    >
      {sheet.color && <span className="sheet-tab-dot" style={{ background: sheet.color }} aria-hidden="true" />}
      <span>{sheet.name}</span>
    </button>
  );
}

function TabCloseButton({ sheet, onDelete }: { sheet: Sheet; onDelete: (sheet: Sheet) => void }) {
  return (
    <button
      type="button"
      className="sheet-tab-close"
      aria-label={`Delete sheet ${sheet.name}`}
      data-tooltip="Delete this sheet"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onDelete(sheet)}
    >
      <X size={12} strokeWidth={2.5} aria-hidden="true" />
    </button>
  );
}

type SheetTabProps = {
  sheet: Sheet;
  position: number;
  active: boolean;
  readOnly: boolean;
  closable: boolean;
  dropTarget: boolean;
  rename: ReactNode;
  handlers: TabHandlers;
};

/** One tab: the sheet's name (or the rename field) and its delete key. */
function SheetTab({ sheet, position, active, readOnly, closable, dropTarget, rename, handlers }: SheetTabProps) {
  return (
    <div
      className={clsx("sheet-tab", active && "is-active", closable && "is-closable", dropTarget && "is-drop-target")}
      data-sheet-tab={sheet.id}
      onPointerEnter={() => handlers.onDragOver(position)}
    >
      {rename ?? <TabButton sheet={sheet} position={position} active={active} readOnly={readOnly} handlers={handlers} />}
      {closable && !rename && <TabCloseButton sheet={sheet} onDelete={handlers.onDelete} />}
    </div>
  );
}

function TabColors({ target, readOnly, onPick }: { target: Sheet; readOnly: boolean; onPick: (color: string | undefined) => void }) {
  return (
    <div className="sheet-tab-colors" role="group" aria-label="Tab color">
      <Palette size={15} aria-hidden="true" />
      {TAB_COLORS.map((color) => (
        <button key={color} type="button" aria-label={`Tab color ${color}`} aria-pressed={target.color === color} disabled={readOnly} style={{ "--swatch-color": color } as CSSProperties} onClick={() => onPick(color)} />
      ))}
      <button type="button" className="sheet-tab-color-none" aria-label="No tab color" disabled={readOnly} onClick={() => onPick(undefined)}>×</button>
    </div>
  );
}

type TabMenuProps = {
  at: MenuAt;
  target: Sheet;
  workbook: Workbook;
  readOnly: boolean;
  canDelete: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  onChange: Change;
  onRename: (sheet: Sheet) => void;
  onUnhide: () => void;
  onDelete: (sheet: Sheet) => void;
};

/** Right-click on a tab: rename, duplicate, move, color, hide, delete. */
function SheetTabMenu({ at, target, workbook, readOnly, canDelete, menuRef, onChange, onRename, onUnhide, onDelete }: TabMenuProps) {
  const index = workbook.sheets.indexOf(target);
  const visible = workbook.sheets.filter((sheet) => !sheet.hidden);
  const hiddenCount = workbook.sheets.length - visible.length;
  const move = (to: number, label: string) => onChange(moveSheet(workbook, target.id, to), label);
  const duplicate = () => {
    const copy = duplicateSheet(workbook, target.id);
    onChange(copy.workbook, `Duplicated "${target.name}"`, copy.sheetId);
  };
  // Hide is offered only while another sheet is visible, so there is always one to show.
  const hide = () => onChange(setSheetProps(workbook, target.id, { hidden: true }), `Hid "${target.name}"`, visible.find((sheet) => sheet.id !== target.id)!.id);
  const recolor = (color: string | undefined) => onChange(setSheetProps(workbook, target.id, { color }), color ? "Changed tab color" : "Removed tab color");
  return (
    <div ref={menuRef} className="document-insert-menu sheet-menu sheet-tab-context" role="menu" aria-label={`${target.name} options`} style={{ left: Math.min(at.x, window.innerWidth - 240), top: Math.max(12, at.y - 300) }}>
      <button type="button" role="menuitem" disabled={readOnly} onClick={() => onRename(target)}><PencilLine size={15} /><span>Rename</span></button>
      <button type="button" role="menuitem" disabled={readOnly || workbook.sheets.length >= MAX_SHEETS} onClick={duplicate}><Copy size={15} /><span>Duplicate</span></button>
      <button type="button" role="menuitem" disabled={readOnly || index <= 0} onClick={() => move(index - 1, "Moved sheet left")}><ChevronLeft size={15} /><span>Move left</span></button>
      <button type="button" role="menuitem" disabled={readOnly || index >= workbook.sheets.length - 1} onClick={() => move(index + 1, "Moved sheet right")}><ChevronRight size={15} /><span>Move right</span></button>
      <TabColors target={target} readOnly={readOnly} onPick={recolor} />
      <button type="button" role="menuitem" disabled={readOnly || visible.length <= 1} onClick={hide}><EyeOff size={15} /><span>Hide</span></button>
      {hiddenCount > 0 && <button type="button" role="menuitem" disabled={readOnly} onClick={onUnhide}><Eye size={15} /><span>Unhide…</span></button>}
      <button type="button" role="menuitem" className="is-danger" disabled={!canDelete} onClick={() => onDelete(target)}><Trash2 size={15} /><span>Delete</span></button>
    </div>
  );
}

/** Closes the tab menu and sheet list on a press anywhere outside them. */
function useDismissOutside(open: boolean, menuRef: RefObject<HTMLDivElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, menuRef, close]);
}

/** The tab menu and the list of every sheet; at most one is open. */
function useTabMenus() {
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenus = useCallback(() => {
    setMenu(null);
    setListOpen(false);
  }, []);
  useDismissOutside(Boolean(menu) || listOpen, menuRef, closeMenus);
  return { menu, setMenu, listOpen, setListOpen, menuRef };
}

type TabsProps = Props & { visible: Sheet[] };

function useRenaming({ workbook, readOnly, onChange, onNotice }: TabsProps) {
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const start = (sheet: Sheet) => {
    if (!readOnly) setRenaming({ id: sheet.id, value: sheet.name });
  };
  const finish = () => {
    if (!renaming) return;
    const result = renameSheet(workbook, renaming.id, renaming.value);
    setRenaming(null);
    if (result.error) onNotice(result.error);
    else if (result.workbook !== workbook) onChange(result.workbook, `Renamed sheet to "${renaming.value.trim()}"`);
  };
  return { renaming, setRenaming, start, finish };
}

/** Deleting another sheet keeps you where you are; deleting this one moves to its neighbour. */
function deletionOutcome(workbook: Workbook, visible: Sheet[], sheet: Sheet, activeId: string): { workbook: Workbook; activeId?: string } {
  const position = visible.indexOf(sheet);
  const neighbour = visible[position - 1] ?? visible[position + 1];
  return { workbook: deleteSheet(workbook, sheet.id), activeId: sheet.id === activeId ? neighbour?.id : activeId };
}

/** An empty sheet goes at once; one that holds something asks first. */
function useSheetDeletion({ workbook, visible, activeId, readOnly, onChange, onNotice }: TabsProps) {
  const [confirming, setConfirming] = useState<Sheet | null>(null);
  const canDelete = !readOnly && workbook.sheets.length > 1;
  const confirm = (sheet: Sheet) => {
    setConfirming(null);
    const outcome = deletionOutcome(workbook, visible, sheet, activeId);
    onChange(outcome.workbook, `Deleted sheet "${sheet.name}"`, outcome.activeId);
    onNotice(`Deleted "${sheet.name}". Press ⌘Z to undo.`);
  };
  const request = (sheet: Sheet) => {
    if (!canDelete) return;
    if (sheetContents(sheet)) setConfirming(sheet);
    else confirm(sheet);
  };
  return { canDelete, confirming, request, confirm, cancel: () => setConfirming(null) };
}

/** Drag a tab onto another to put it there. */
function useTabDrag({ workbook, visible, onChange }: TabsProps) {
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const start = (id: string, position: number) => setDrag({ id, over: position });
  const over = (position: number) => setDrag((current) => (current ? { ...current, over: position } : current));
  const drop = (sheet: Sheet) => {
    setDrag(null);
    if (drag && drag.id !== sheet.id) onChange(moveSheet(workbook, drag.id, workbook.sheets.indexOf(visible[drag.over])), "Moved sheet");
  };
  const isTarget = (sheet: Sheet, position: number) => drag?.over === position && drag.id !== sheet.id;
  return { start, over, drop, isTarget };
}

/** The list button and, while open, the list of every sheet. */
function AllSheetsControl({ workbook, activeId, readOnly, open, setOpen, menuRef, onChange, onActivate }: Props & { open: boolean; setOpen: (open: boolean | ((value: boolean) => boolean)) => void; menuRef: RefObject<HTMLDivElement | null> }) {
  const pick = (sheet: Sheet) => {
    setOpen(false);
    if (sheet.hidden) onChange(setSheetProps(workbook, sheet.id, { hidden: false }), `Unhid "${sheet.name}"`, sheet.id);
    else onActivate(sheet.id);
  };
  return (
    <div className="sheet-tab-list-control" ref={open ? menuRef : undefined}>
      <button type="button" className="sheet-tab-all" aria-label="All sheets" aria-expanded={open} data-tooltip="List every sheet" onClick={() => setOpen((value) => !value)}>
        <List size={16} />
      </button>
      {open && <AllSheetsMenu workbook={workbook} activeId={activeId} readOnly={readOnly} onPick={pick} />}
    </div>
  );
}

/** The rename field for the sheet being renamed; null for every other tab. */
function renameFieldFor(sheet: Sheet, rename: ReturnType<typeof useRenaming>): ReactNode {
  if (rename.renaming?.id !== sheet.id) return null;
  return <TabRenameInput renaming={rename.renaming} onEdit={(value) => rename.setRenaming({ id: sheet.id, value })} onFinish={rename.finish} onCancel={() => rename.setRenaming(null)} />;
}

/** The menu for the tab that was right-clicked, while that sheet exists. */
function OpenTabMenu({ menu, ...rest }: Omit<TabMenuProps, "at" | "target"> & { menu: MenuAt | null }) {
  const target = menu && rest.workbook.sheets.find((sheet) => sheet.id === menu.id);
  return target ? <SheetTabMenu at={menu} target={target} {...rest} /> : null;
}

/** Sheet tabs along the bottom: switch, add, rename (double-click or F2),
 * recolor, duplicate, hide, delete (its × key or Delete), and drag to reorder. */
export function SheetTabs(props: Props) {
  const { workbook, activeId, readOnly, onActivate, onChange } = props;
  const visible = workbook.sheets.filter((sheet) => !sheet.hidden);
  const tabsProps = { ...props, visible };
  const { menu, setMenu, listOpen, setListOpen, menuRef } = useTabMenus();
  const rename = useRenaming(tabsProps);
  const deletion = useSheetDeletion(tabsProps);
  const drag = useTabDrag(tabsProps);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-sheet-tab="${activeId}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  const handlers: TabHandlers = {
    onActivate,
    onRename: (sheet) => {
      setMenu(null);
      rename.start(sheet);
    },
    onMenu: setMenu,
    onDelete: (sheet) => {
      setMenu(null);
      deletion.request(sheet);
    },
    onDragStart: drag.start,
    onDragOver: drag.over,
    onDrop: drag.drop,
  };

  return (
    <div className="sheet-tabs" role="tablist" aria-label="Sheets">
      <AddSheetButton workbook={workbook} activeId={activeId} readOnly={readOnly} onChange={onChange} />
      <AllSheetsControl {...props} open={listOpen} setOpen={setListOpen} menuRef={menuRef} />
      <div className="sheet-tab-strip" ref={strip}>
        {visible.map((sheet, position) => (
          <SheetTab
            key={sheet.id}
            sheet={sheet}
            position={position}
            active={sheet.id === activeId}
            readOnly={readOnly}
            closable={deletion.canDelete}
            dropTarget={drag.isTarget(sheet, position)}
            rename={renameFieldFor(sheet, rename)}
            handlers={handlers}
          />
        ))}
      </div>
      <OpenTabMenu
        menu={menu}
        workbook={workbook}
        readOnly={readOnly}
        canDelete={deletion.canDelete}
        menuRef={menuRef}
        onChange={(next, label, active) => {
          setMenu(null);
          onChange(next, label, active);
        }}
        onRename={handlers.onRename}
        onUnhide={() => {
          setMenu(null);
          setListOpen(true);
        }}
        onDelete={handlers.onDelete}
      />
      {deletion.confirming && <DeleteSheetDialog sheet={deletion.confirming} onCancel={deletion.cancel} onConfirm={deletion.confirm} />}
    </div>
  );
}
