import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SHEET_ACCENTS } from "../../lib/sheet/palette";
import { MAX_SHEETS, parseWorkbook, type Workbook } from "../../lib/sheet/sheetModel";
import { SheetTabs } from "./SheetTabs";

function workbookOf(sheets: unknown[]): Workbook {
  const parsed = parseWorkbook({ sheets });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.workbook;
}

const TAB_COLOR = Object.values(SHEET_ACCENTS)[2];

const TWO_SHEETS = [
  { id: "a", name: "Summary", cells: { A1: { v: "Total" } } },
  { id: "b", name: "Scratch", cells: {} },
];

function Harness({ initial, onState, onNotice = () => undefined, startOn = "a" }: { initial: Workbook; onState?: (workbook: Workbook, activeId: string) => void; onNotice?: (message: string) => void; startOn?: string }) {
  const [workbook, setWorkbook] = useState(initial);
  const [activeId, setActiveId] = useState(startOn);
  return (
    <SheetTabs
      workbook={workbook}
      activeId={activeId}
      readOnly={false}
      onActivate={setActiveId}
      onChange={(next, _label, nextActive) => {
        const active = nextActive ?? activeId;
        setWorkbook(next);
        setActiveId(active);
        onState?.(next, active);
      }}
      onNotice={onNotice}
    />
  );
}

describe("deleting sheets from the tabs", () => {
  it("deletes an empty sheet from its tab right away and keeps the sheet on screen", () => {
    const onState = vi.fn();
    const onNotice = vi.fn();
    render(<Harness initial={workbookOf(TWO_SHEETS)} onState={onState} onNotice={onNotice} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete sheet Scratch" }));
    const [workbook, active] = onState.mock.calls.at(-1)!;
    expect(workbook.sheets.map((sheet: { name: string }) => sheet.name)).toEqual(["Summary"]);
    expect(active).toBe("a");
    expect(onNotice).toHaveBeenCalledWith('Deleted "Scratch". Press ⌘Z to undo.');
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks in the platform's dialog before deleting a sheet with content, and moves to a neighbour", () => {
    const onState = vi.fn();
    render(<Harness initial={workbookOf(TWO_SHEETS)} onState={onState} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete sheet Summary" }));
    const dialog = screen.getByRole("dialog", { name: 'Delete "Summary"?' });
    expect(within(dialog).getByText(/^This removes its 1 filled cell\. Formulas on other sheets/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onState).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete sheet Summary" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete sheet" }));
    const [workbook, active] = onState.mock.calls.at(-1)!;
    expect(workbook.sheets.map((sheet: { name: string }) => sheet.name)).toEqual(["Scratch"]);
    expect(active).toBe("b");
  });

  it("closes the dialog with Escape or a click outside it", () => {
    const onState = vi.fn();
    render(<Harness initial={workbookOf(TWO_SHEETS)} onState={onState} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete sheet Summary" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete sheet Summary" }));
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onState).not.toHaveBeenCalled();
  });

  it("counts charts and tables as content too", () => {
    const sheets = [{ id: "a", name: "Summary", cells: {} }, { id: "b", name: "Chart", cells: {}, charts: [{ id: "c1", type: "column", source: "A1:B3", at: "D2", w: 400, h: 260 }] }];
    render(<Harness initial={workbookOf(sheets)} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete sheet Chart" }));
    expect(screen.getByRole("dialog", { name: 'Delete "Chart"?' }).textContent).toMatch(/This removes its 1 chart\./);
  });

  it("uses the same dialog from the tab's menu and from the Delete key", () => {
    render(<Harness initial={workbookOf(TWO_SHEETS)} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Summary" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: 'Delete "Summary"?' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Summary" }), { key: "Delete" });
    expect(screen.getByRole("dialog", { name: 'Delete "Summary"?' })).toBeTruthy();
  });

  it("offers no delete when the workbook has one sheet", () => {
    render(<Harness initial={workbookOf([TWO_SHEETS[0]])} />);
    expect(screen.queryByRole("button", { name: /^Delete sheet/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Summary" }), { key: "Delete" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

const THREE_SHEETS = [
  { id: "a", name: "Summary", cells: { A1: { v: "Total" } } },
  { id: "b", name: "Scratch", cells: {} },
  { id: "c", name: "Notes", cells: {} },
];

function names(workbook: Workbook) {
  return workbook.sheets.map((sheet) => `${sheet.name}${sheet.hidden ? " (hidden)" : ""}${sheet.color ? ` ${sheet.color}` : ""}`);
}

function openMenu(name: string) {
  fireEvent.contextMenu(screen.getByRole("tab", { name }));
  return screen.getByRole("menu", { name: `${name} options` });
}

describe("the tab menu, sheet list, and reordering", () => {
  it("duplicates, moves, and recolors a sheet from its menu", () => {
    const onState = vi.fn();
    render(<Harness initial={workbookOf(THREE_SHEETS)} onState={onState} />);
    fireEvent.click(within(openMenu("Scratch")).getByRole("menuitem", { name: "Duplicate" }));
    expect(names(onState.mock.calls.at(-1)![0])).toEqual(["Summary", "Scratch", "Scratch (2)", "Notes"]);
    expect(onState.mock.calls.at(-1)![1]).not.toBe("b");
    fireEvent.click(within(openMenu("Notes")).getByRole("menuitem", { name: "Move left" }));
    expect(names(onState.mock.calls.at(-1)![0])).toEqual(["Summary", "Scratch", "Notes", "Scratch (2)"]);
    fireEvent.click(within(openMenu("Notes")).getByRole("menuitem", { name: "Move right" }));
    expect(names(onState.mock.calls.at(-1)![0])).toEqual(["Summary", "Scratch", "Scratch (2)", "Notes"]);
    const menu = openMenu("Summary");
    expect((within(menu).getByRole("menuitem", { name: "Move left" }) as HTMLButtonElement).disabled).toBe(true);
    const swatch = within(menu).getAllByRole("button", { name: /^Tab color #/ })[1];
    fireEvent.click(swatch);
    expect(onState.mock.calls.at(-1)![0].sheets[0].color).toBe(swatch.getAttribute("aria-label")!.slice("Tab color ".length));
    fireEvent.click(within(openMenu("Summary")).getByRole("button", { name: "No tab color" }));
    expect(onState.mock.calls.at(-1)![0].sheets[0].color).toBeUndefined();
    expect((within(openMenu("Notes")).getByRole("menuitem", { name: "Move right" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides a sheet, then shows it again from the list of every sheet", () => {
    const onState = vi.fn();
    render(<Harness initial={workbookOf(THREE_SHEETS)} onState={onState} />);
    fireEvent.click(within(openMenu("Summary")).getByRole("menuitem", { name: "Hide" }));
    const [hidden, active] = onState.mock.calls.at(-1)!;
    expect(names(hidden)).toEqual(["Summary (hidden)", "Scratch", "Notes"]);
    expect(active).toBe("b");
    expect(screen.queryByRole("tab", { name: "Summary" })).toBeNull();
    fireEvent.click(within(openMenu("Scratch")).getByRole("menuitem", { name: "Unhide…" }));
    const list = screen.getByRole("menu", { name: "All sheets" });
    expect(within(list).getByText("Hidden — click to show")).toBeTruthy();
    fireEvent.click(within(list).getByRole("menuitemradio", { name: /Summary/ }));
    expect(names(onState.mock.calls.at(-1)![0])).toEqual(["Summary", "Scratch", "Notes"]);
    expect(onState.mock.calls.at(-1)![1]).toBe("a");
  });

  it("switches sheets from the list and closes menus on a click elsewhere", () => {
    render(<Harness initial={workbookOf(THREE_SHEETS)} />);
    fireEvent.click(screen.getByRole("button", { name: "All sheets" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "All sheets" })).getByRole("menuitemradio", { name: "Notes" }));
    expect(screen.getByRole("tab", { name: "Notes" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("menu", { name: "All sheets" })).toBeNull();
    openMenu("Notes");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Notes options" })).toBeNull();
  });

  it("does not hide the only visible sheet", () => {
    render(<Harness initial={workbookOf([THREE_SHEETS[0]])} />);
    expect((within(openMenu("Summary")).getByRole("menuitem", { name: "Hide" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renames with F2 and keeps the old name on Escape or a clash", () => {
    const onState = vi.fn();
    const onNotice = vi.fn();
    render(<Harness initial={workbookOf(THREE_SHEETS)} onState={onState} onNotice={onNotice} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Scratch" }), { key: "F2" });
    fireEvent.keyDown(screen.getByLabelText("Sheet name"), { key: "Escape" });
    expect(screen.queryByLabelText("Sheet name")).toBeNull();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Scratch" }), { key: "F2" });
    fireEvent.change(screen.getByLabelText("Sheet name"), { target: { value: "Summary" } });
    fireEvent.keyDown(screen.getByLabelText("Sheet name"), { key: "Enter" });
    expect(onState).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/Summary/));
    fireEvent.click(within(openMenu("Notes")).getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Sheet name"), { target: { value: "Ideas" } });
    fireEvent.blur(screen.getByLabelText("Sheet name"));
    expect(names(onState.mock.calls.at(-1)![0])).toEqual(["Summary", "Scratch", "Ideas"]);
  });

  it("reorders by dragging one tab onto another", () => {
    const onState = vi.fn();
    render(<Harness initial={workbookOf(THREE_SHEETS)} onState={onState} />);
    fireEvent(screen.getByRole("tab", { name: "Notes" }), new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    fireEvent(screen.getByRole("tab", { name: "Summary" }).parentElement!, new MouseEvent("pointerover", { bubbles: true }));
    fireEvent(screen.getByRole("tab", { name: "Summary" }).parentElement!, new MouseEvent("pointerenter", { bubbles: false }));
    expect(screen.getByRole("tab", { name: "Summary" }).parentElement!.classList.contains("is-drop-target")).toBe(true);
    fireEvent(screen.getByRole("tab", { name: "Summary" }), new MouseEvent("pointerup", { bubbles: true }));
    expect(names(onState.mock.calls.at(-1)![0])).toEqual(["Notes", "Summary", "Scratch"]);
  });

  it("offers no edits when read-only", () => {
    render(
      <SheetTabs workbook={workbookOf(THREE_SHEETS)} activeId="a" readOnly onActivate={() => undefined} onChange={() => undefined} onNotice={() => undefined} />,
    );
    expect((screen.getByRole("button", { name: "Add sheet" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Delete sheet/ })).toBeNull();
    fireEvent.doubleClick(screen.getByRole("tab", { name: "Scratch" }));
    expect(screen.queryByLabelText("Sheet name")).toBeNull();
  });
});

function manySheets(count: number) {
  return workbookOf(Array.from({ length: count }, (_, index) => ({ id: `s${index}`, name: `S${index + 1}`, cells: {} })));
}

describe("tab details", () => {
  it("stops adding and duplicating at the sheet limit", () => {
    const { unmount } = render(<Harness initial={manySheets(MAX_SHEETS)} startOn="s0" />);
    expect((screen.getByRole("button", { name: "Add sheet" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(openMenu("S1")).getByRole("menuitem", { name: "Duplicate" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    render(<Harness initial={manySheets(MAX_SHEETS - 1)} startOn="s0" />);
    expect((screen.getByRole("button", { name: "Add sheet" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(openMenu("S1")).getByRole("menuitem", { name: "Duplicate" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("marks the sheet on screen, its color, and which tabs can close", () => {
    const sheets = [{ ...THREE_SHEETS[0], color: TAB_COLOR }, THREE_SHEETS[1]];
    render(<Harness initial={workbookOf(sheets)} />);
    const tabs = Array.from(document.querySelectorAll(".sheet-tab"));
    expect(tabs.map((tab) => tab.className)).toEqual(["sheet-tab is-active is-closable", "sheet-tab is-closable"]);
    const menu = openMenu("Summary");
    expect(within(menu).getByRole("button", { name: `Tab color ${TAB_COLOR}` }).getAttribute("aria-pressed")).toBe("true");
    expect(within(menu).getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(within(menu).queryByRole("menuitem", { name: "Unhide…" })).toBeNull();
    expect((within(openMenu("Scratch")).getByRole("menuitem", { name: "Move left" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "All sheets" }));
    const list = screen.getByRole("menu", { name: "All sheets" });
    // Right-clicking Scratch above also showed it.
    expect(within(list).getAllByRole("menuitemradio").map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  });

  it("places the tab menu inside the window", () => {
    render(<Harness initial={workbookOf(THREE_SHEETS)} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Scratch" }), { clientX: window.innerWidth - 10, clientY: 400 });
    const menu = screen.getByRole("menu", { name: "Scratch options" }) as HTMLElement;
    expect([menu.style.left, menu.style.top]).toEqual([`${window.innerWidth - 240}px`, "100px"]);
    fireEvent.pointerDown(document.body);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Scratch" }), { clientX: 30, clientY: 200 });
    const near = screen.getByRole("menu", { name: "Scratch options" }) as HTMLElement;
    expect([near.style.left, near.style.top]).toEqual(["30px", "12px"]);
  });

  it("closes both menus, and opens neither, on a press elsewhere", () => {
    render(<Harness initial={workbookOf(THREE_SHEETS)} />);
    openMenu("Scratch");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the tab menu from the menu key or Shift+F10, not plain F10", () => {
    render(<Harness initial={workbookOf(THREE_SHEETS)} />);
    const tab = screen.getByRole("tab", { name: "Scratch" });
    fireEvent.keyDown(tab, { key: "F10" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(tab, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "Scratch options" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(tab, { key: "ContextMenu" });
    expect(screen.getByRole("menu", { name: "Scratch options" })).toBeTruthy();
  });

  it("copes with the sheet on screen having no tab (hidden by a change elsewhere)", () => {
    render(<Harness initial={workbookOf([THREE_SHEETS[0], { ...THREE_SHEETS[1], hidden: true }])} startOn="b" />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Summary"]);
  });

  it("moves to the sheet on the left after deleting the one on screen", () => {
    const onState = vi.fn();
    render(<Harness initial={workbookOf(THREE_SHEETS)} onState={onState} startOn="b" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete sheet Scratch" }));
    expect(onState.mock.calls.at(-1)![1]).toBe("a");
  });

  it("deletes the only visible sheet when others are hidden", () => {
    const onState = vi.fn();
    render(<Harness initial={workbookOf([THREE_SHEETS[1], { ...THREE_SHEETS[2], hidden: true }])} onState={onState} startOn="b" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete sheet Scratch" }));
    expect(names(onState.mock.calls.at(-1)![0])).toEqual(["Notes"]);
  });

  it("does not reorder on a stray release, a press on the same tab, a right-button drag, or when read-only", () => {
    const onState = vi.fn();
    const { unmount } = render(<Harness initial={workbookOf(THREE_SHEETS)} onState={onState} />);
    const down = (name: string, button = 0) => fireEvent(screen.getByRole("tab", { name }), new MouseEvent("pointerdown", { bubbles: true, button }));
    const up = (name: string) => fireEvent(screen.getByRole("tab", { name }), new MouseEvent("pointerup", { bubbles: true }));
    up("Summary");
    down("Notes");
    up("Notes");
    down("Notes", 2);
    up("Summary");
    expect(onState).not.toHaveBeenCalled();
    unmount();
    const onChange = vi.fn();
    render(<SheetTabs workbook={workbookOf(THREE_SHEETS)} activeId="a" readOnly onActivate={() => undefined} onChange={onChange} onNotice={() => undefined} />);
    down("Notes");
    up("Summary");
    expect(onChange).not.toHaveBeenCalled();
  });
});

