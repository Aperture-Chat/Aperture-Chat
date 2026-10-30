import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { tablePalette } from "../../lib/sheet/decorations";
import { blankWorkbook, parseWorkbook, type Workbook } from "../../lib/sheet/sheetModel";
import { type SheetAiAsk, SpreadsheetEditor } from "./SpreadsheetEditor";

function Harness({ initial, ask, onState }: { initial?: Workbook; ask?: SheetAiAsk; onState?: (workbook: Workbook) => void }) {
  const [workbook, setWorkbook] = useState(initial ?? blankWorkbook());
  return (
    <SpreadsheetEditor
      workbook={workbook}
      historyKey="test"
      title="Test workbook"
      onChange={(next) => {
        setWorkbook(next);
        onState?.(next);
      }}
      mobileExpanded={false}
      onToggleMobile={() => undefined}
      ai={{ available: Boolean(ask), reason: "No model", ask: ask ?? (async () => "") }}
    />
  );
}

function grid() {
  return screen.getByRole("grid");
}

/** Types into the active cell the way a person does: a first key opens the
 * cell editor, the rest goes into it, and Enter commits. */
function typeIntoActiveCell(text: string) {
  fireEvent.keyDown(grid(), { key: text[0] });
  const editor = screen.getByLabelText(/^Edit [A-Z]+\d+$/);
  fireEvent.change(editor, { target: { value: text, selectionStart: text.length } });
  fireEvent.keyDown(editor, { key: "Enter" });
}

function cellText(address: string) {
  return document.querySelector(`.sheet-pane.is-main [data-cell='${address}'] .sheet-cell-text`)?.textContent ?? null;
}

function nameBox() {
  return screen.getByLabelText(/Name box/) as HTMLInputElement;
}

describe("SpreadsheetEditor", () => {
  it("stores typed values, calculates formulas, and moves down on Enter", () => {
    let latest: Workbook | null = null;
    render(<Harness onState={(workbook) => { latest = workbook; }} />);
    typeIntoActiveCell("12");
    typeIntoActiveCell("30");
    typeIntoActiveCell("=SUM(A1:A2)*2");
    expect(latest!.sheets[0].cells).toMatchObject({ A1: { v: 12 }, A2: { v: 30 }, A3: { f: "SUM(A1:A2)*2" } });
    expect(cellText("A3")).toBe("84");
    expect(nameBox().value).toBe("A4");
  });

  it("keeps keys typed while the cell editor is still opening", () => {
    let latest: Workbook | null = null;
    render(<Harness onState={(workbook) => { latest = workbook; }} />);
    for (const key of ["S", "c", "o", "r", "e"]) fireEvent.keyDown(grid(), { key });
    const editor = screen.getByLabelText("Edit A1") as HTMLTextAreaElement;
    expect(editor.value).toBe("Score");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(latest!.sheets[0].cells.A1).toEqual({ v: "Score" });
    // Enter that lands on the grid before the editor has focus still commits.
    for (const key of ["4", "2", "Enter"]) fireEvent.keyDown(grid(), { key });
    expect(latest!.sheets[0].cells.A2).toEqual({ v: 42 });
    expect(nameBox().value).toBe("A3");
  });

  it("undoes and redoes edits from the keyboard", () => {
    render(<Harness />);
    typeIntoActiveCell("first");
    expect(cellText("A1")).toBe("first");
    fireEvent.keyDown(grid(), { key: "z", metaKey: true });
    expect(cellText("A1")).toBeNull();
    fireEvent.keyDown(grid(), { key: "z", metaKey: true, shiftKey: true });
    expect(cellText("A1")).toBe("first");
  });

  it("shows the formula in the formula bar and the result in the cell", () => {
    render(<Harness />);
    typeIntoActiveCell("$1,200.50");
    expect(cellText("A1")).toBe("$1,200.50");
    fireEvent.keyDown(grid(), { key: "ArrowUp" });
    expect((screen.getByLabelText("Contents of A1") as HTMLTextAreaElement).value).toBe("1200.5");
  });

  it("rejects entries that break a strict list rule", () => {
    const parsed = parseWorkbook({
      sheets: [{ id: "s", name: "Tasks", cells: {}, validations: [{ id: "v", ref: "A1:A9", kind: "list", items: ["Open", "Done"], strict: true }] }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    let latest: Workbook | null = null;
    render(<Harness initial={parsed.workbook} onState={(workbook) => { latest = workbook; }} />);
    typeIntoActiveCell("Maybe");
    expect(latest).toBeNull();
    expect(document.querySelector(".sheet-notice")?.textContent).toMatch(/Choose one of: Open, Done/);
  });

  it("adds and renames sheets from the tabs", () => {
    let latest: Workbook | null = null;
    render(<Harness onState={(workbook) => { latest = workbook; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
    expect(latest!.sheets.map((sheet) => sheet.name)).toEqual(["Sheet1", "Sheet2"]);
    fireEvent.doubleClick(screen.getByRole("tab", { name: "Sheet2" }));
    const input = screen.getByLabelText("Sheet name");
    fireEvent.change(input, { target: { value: "Summary" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(latest!.sheets.map((sheet) => sheet.name)).toEqual(["Sheet1", "Summary"]);
  });

  it("previews an AI change in the grid and applies it as one undoable step", async () => {
    const ask = vi.fn<SheetAiAsk>(async () => '{"message":"Added a total.","ops":[{"op":"set","range":"A3","values":[["=SUM(A1:A2)"]]}]}');
    let latest: Workbook | null = null;
    render(<Harness ask={ask} onState={(workbook) => { latest = workbook; }} />);
    typeIntoActiveCell("5");
    typeIntoActiveCell("7");
    fireEvent.click(screen.getByRole("button", { name: "Ask AI about the selection" }));
    const composer = screen.getByRole("dialog", { name: "Ask AI" });
    expect(within(composer).getByText("Sheet1!A3")).toBeTruthy();
    fireEvent.change(within(composer).getByLabelText("AI instruction"), { target: { value: "Add a total under these" } });
    fireEvent.click(within(composer).getByRole("button", { name: "Run AI instruction" }));
    await screen.findByText(/highlighted in the grid/);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toContain("User request: Add a total under these");
    expect(cellText("A3")).toBe("12");
    expect(document.querySelector("[data-cell='A3']")?.classList.contains("is-ai-changed")).toBe(true);
    expect(latest!.sheets[0].cells.A3).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Accept AI suggestion" }));
    expect(latest!.sheets[0].cells.A3).toEqual({ f: "SUM(A1:A2)" });
    fireEvent.keyDown(grid(), { key: "z", metaKey: true });
    expect(latest!.sheets[0].cells.A3).toBeUndefined();
  });

  it("sends formula errors back to the model once before showing the preview", async () => {
    const replies = [
      '{"message":"Added it.","ops":[{"op":"set","range":"B1","values":[["=SUMM(A1:A2)"]]}]}',
      '{"message":"Fixed the formula.","ops":[{"op":"set","range":"B1","values":[["=SUM(A1:A2)"]]}]}',
    ];
    const ask = vi.fn<SheetAiAsk>(async () => replies.shift() ?? "");
    render(<Harness ask={ask} />);
    typeIntoActiveCell("4");
    fireEvent.click(screen.getByRole("button", { name: "Ask AI about the selection" }));
    const composer = screen.getByRole("dialog", { name: "Ask AI" });
    fireEvent.click(within(composer).getByRole("option", { name: "Write a formula for this cell" }));
    await screen.findByText(/highlighted in the grid/);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0]).toContain("Sheet1!B1: =SUMM(A1:A2) → #NAME?");
    expect(cellText("B1")).toBe("4");
    await act(async () => undefined);
  });

  it("answers questions without changing cells", async () => {
    const ask = vi.fn<SheetAiAsk>(async () => '{"message":"Column A holds monthly units.","ops":[]}');
    let latest: Workbook | null = null;
    render(<Harness ask={ask} onState={(workbook) => { latest = workbook; }} />);
    typeIntoActiveCell("3");
    const before = latest;
    fireEvent.click(screen.getByRole("button", { name: "Ask AI about the selection" }));
    fireEvent.change(screen.getByLabelText("AI instruction"), { target: { value: "What is in this column?" } });
    fireEvent.click(screen.getByRole("button", { name: "Run AI instruction" }));
    await waitFor(() => expect(document.querySelector(".sheet-ai-message.is-answer")?.textContent).toBe("Column A holds monthly units."));
    expect(latest).toBe(before);
  });

  it("closes Ask AI on a click anywhere outside it, and toggles from its button", () => {
    const ask = vi.fn<SheetAiAsk>(async () => "");
    render(<Harness ask={ask} />);
    const trigger = screen.getByRole("button", { name: "Ask AI about the selection" });
    fireEvent.click(trigger);
    const composer = screen.getByRole("dialog", { name: "Ask AI" });
    pointer(within(composer).getByLabelText("AI instruction"), "pointerdown", 10, 10);
    expect(screen.getByRole("dialog", { name: "Ask AI" })).toBeTruthy();
    pointer(grid(), "pointerdown", 10, 10);
    expect(screen.queryByRole("dialog", { name: "Ask AI" })).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Ask AI" })).toBeTruthy();
    pointer(trigger, "pointerdown", 10, 10);
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Ask AI" })).toBeNull();
  });

  it("closes Ask AI even when the press lands on a control that keeps it to itself", () => {
    render(<Harness ask={vi.fn<SheetAiAsk>(async () => "")} />);
    fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask AI about the selection" }));
    // A tab's delete key stops its press from bubbling.
    pointer(screen.getByRole("button", { name: "Delete sheet Sheet1" }), "pointerdown", 10, 10);
    expect(screen.queryByRole("dialog", { name: "Ask AI" })).toBeNull();
  });

  it("brings a deleted sheet back with undo", () => {
    let latest: Workbook | null = null;
    render(<Harness onState={(workbook) => { latest = workbook; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete sheet Sheet2" }));
    expect(latest!.sheets.map((sheet) => sheet.name)).toEqual(["Sheet1"]);
    fireEvent.keyDown(grid(), { key: "z", metaKey: true });
    expect(latest!.sheets.map((sheet) => sheet.name)).toEqual(["Sheet1", "Sheet2"]);
  });

  it("refines an AI preview on top of itself and applies both changes together", async () => {
    const replies = [
      '{"message":"Added a total.","ops":[{"op":"set","range":"A3","values":[["=SUM(A1:A2)"]]}]}',
      '{"message":"Made it bold.","ops":[{"op":"format","range":"A3","style":{"bold":true}}]}',
    ];
    const ask = vi.fn<SheetAiAsk>(async () => replies.shift() ?? "");
    let latest: Workbook | null = null;
    render(<Harness ask={ask} onState={(workbook) => { latest = workbook; }} />);
    typeIntoActiveCell("5");
    typeIntoActiveCell("7");
    fireEvent.click(screen.getByRole("button", { name: "Ask AI about the selection" }));
    fireEvent.change(screen.getByLabelText("AI instruction"), { target: { value: "Add a total" } });
    fireEvent.click(screen.getByRole("button", { name: "Run AI instruction" }));
    await screen.findByText(/highlighted in the grid/);
    fireEvent.change(screen.getByLabelText("Refine the AI suggestion"), { target: { value: "Make the total bold" } });
    fireEvent.click(screen.getByRole("button", { name: "Refine suggestion" }));
    await screen.findByText("Made it bold.");
    expect(ask.mock.calls[1][0]).toContain("User request: Make the total bold");
    expect(ask.mock.calls[1][0]).toContain("=SUM(A1:A2)");
    fireEvent.click(screen.getByRole("button", { name: "Accept AI suggestion" }));
    expect(latest!.sheets[0].cells.A3).toEqual({ f: "SUM(A1:A2)", s: expect.anything() });
    fireEvent.keyDown(grid(), { key: "z", metaKey: true });
    expect(latest!.sheets[0].cells.A3).toBeUndefined();
  });

  it("draws a chart anchored in a frozen column across the freeze line instead of clipping it to that column", () => {
    const parsed = parseWorkbook({
      sheets: [{
        id: "s",
        name: "P&L",
        cells: { A1: { v: "Year" }, B1: { v: "Revenue" }, A2: { v: "FY1" }, B2: { v: 5 }, A3: { v: "FY2" }, B3: { v: 8 } },
        freeze: { rows: 1, cols: 1 },
        charts: [{ id: "c1", type: "line", source: "A1:B3", at: "A10", w: 640, h: 320, title: "Trend" }],
      }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    render(<Harness initial={parsed.workbook} />);
    const inLeft = document.querySelector(".sheet-pane.is-left .sheet-chart") as HTMLElement;
    const inMain = document.querySelector(".sheet-pane.is-main .sheet-chart") as HTMLElement;
    expect(inLeft).toBeTruthy();
    expect(inMain).toBeTruthy();
    expect([inLeft.style.left, inLeft.style.width]).toEqual([inMain.style.left, inMain.style.width]);
    // One copy is the chart people and screen readers use; the other only shows the rest of it.
    expect(screen.getAllByRole("group", { name: "Trend chart" })).toHaveLength(1);
    expect(inMain.getAttribute("aria-hidden")).toBe("true");
  });

  it("selects a chart on a click and opens its settings on a double-click, as Excel does", () => {
    const parsed = parseWorkbook({
      sheets: [{
        id: "s",
        name: "Data",
        cells: { A1: { v: "Year" }, B1: { v: "Revenue" }, A2: { v: "FY1" }, B2: { v: 5 } },
        charts: [
          { id: "c1", type: "line", source: "A1:B2", at: "D2", w: 400, h: 240, title: "Trend" },
          { id: "c2", type: "column", source: "A1:B2", at: "D20", w: 400, h: 240, title: "Mix" },
        ],
      }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    render(<Harness initial={parsed.workbook} />);
    const trend = screen.getByRole("group", { name: "Trend chart" });
    pointer(trend, "pointerdown", 10, 10);
    pointer(trend, "pointerup", 10, 10);
    expect(trend.classList.contains("is-selected")).toBe(true);
    expect(screen.queryByRole("complementary", { name: "Chart" })).toBeNull();
    fireEvent.doubleClick(trend);
    expect(screen.getByRole("complementary", { name: "Chart" })).toBeTruthy();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Trend");
    // With the settings open, selecting another chart shows that chart's settings.
    const mix = screen.getByRole("group", { name: "Mix chart" });
    pointer(mix, "pointerdown", 10, 10);
    pointer(mix, "pointerup", 10, 10);
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Mix");
    expect(mix.getAttribute("data-tooltip")).toBe("Double-click to edit the chart");
  });

  it("lights the select-all corner and the headers when the whole sheet is selected", () => {
    render(<Harness />);
    const corner = screen.getByRole("button", { name: "Select all" });
    expect(corner.classList.contains("is-selected")).toBe(false);
    fireEvent.keyDown(grid(), { key: "a", metaKey: true });
    expect(nameBox().value).toBe("A:IV");
    expect(corner.classList.contains("is-selected")).toBe(true);
    expect(document.querySelector(".sheet-col-headers .sheet-header")!.classList.contains("is-full")).toBe(true);
    expect(document.querySelectorAll(".sheet-row-headers .sheet-header").length).toBeLessThan(200);
    // The grid never lays out past the sheet's last row and column.
    expect([grid().getAttribute("aria-rowcount"), grid().getAttribute("aria-colcount")]).toEqual(["20000", "256"]);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    expect(corner.classList.contains("is-selected")).toBe(false);
  });

  it("resizes a column by dragging its header edge and autofits on double-click", () => {
    let latest: Workbook | null = null;
    render(<Harness onState={(workbook) => { latest = workbook; }} />);
    const handle = screen.getByRole("separator", { name: "Resize column B" });
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.className).toBe("sheet-resize-handle is-col");
    expect(handle.dataset.tooltip).toBe("Drag to resize · double-click to fit the text");
    const before = handleOffset(handle);
    pointer(handle, "pointerdown", 200, 10);
    pointer(handle, "pointermove", 260, 10);
    pointer(handle, "pointerup", 260, 10);
    const width = latest!.sheets[0].cols?.B?.w;
    expect(width).toBeGreaterThan(before + 50);
    typeIntoActiveCell("A fairly long heading that needs room");
    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize column A" }));
    expect(latest!.sheets[0].cols?.A?.w).toBeGreaterThan(120);
  });

  it("fits a row to its wrapped text on double-click, and back to the default when it no longer needs room", () => {
    let latest: Workbook | null = null;
    render(<Harness onState={(workbook) => { latest = workbook; }} />);
    // jsdom measures 7px a character: 40 characters in a 92px text area wrap onto 4 lines of 16px.
    typeIntoActiveCell("x".repeat(40));
    fireEvent.keyDown(grid(), { key: "ArrowUp" });
    fireEvent.click(screen.getByRole("button", { name: "Wrap text" }));
    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize row 1" }));
    expect(latest!.sheets[0].rows?.["1"]?.h).toBe(72);
    fireEvent.click(screen.getByRole("button", { name: "Wrap text" }));
    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize row 1" }));
    expect(latest!.sheets[0].rows?.["1"]).toBeUndefined();
  });

  it("resizes a row by dragging its header edge", () => {
    let latest: Workbook | null = null;
    render(<Harness onState={(workbook) => { latest = workbook; }} />);
    const handle = screen.getByRole("separator", { name: "Resize row 3" });
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.className).toBe("sheet-resize-handle is-row");
    expect(handle.dataset.tooltip).toBe("Drag to resize · double-click to fit");
    pointer(handle, "pointerdown", 10, 100);
    pointer(handle, "pointermove", 10, 140);
    pointer(handle, "pointerup", 10, 140);
    expect(latest!.sheets[0].rows?.["3"]?.h).toBeGreaterThan(50);
  });

  it("offers the keys a narrow toolbar hides under More", () => {
    let latest: Workbook | null = null;
    render(<Harness onState={(workbook) => { latest = workbook; }} />);
    typeIntoActiveCell("Total");
    fireEvent.keyDown(grid(), { key: "ArrowUp" });
    const more = () => {
      fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
      return screen.getByRole("menu", { name: "More formatting" });
    };
    fireEvent.click(within(more()).getByRole("menuitem", { name: "Strikethrough" }));
    expect(latest!.sheets[0].cells.A1.s).toMatchObject({ strike: true });
    fireEvent.click(within(more()).getByRole("menuitem", { name: "Increase font size" }));
    expect(latest!.sheets[0].cells.A1.s).toMatchObject({ size: 11 });
    fireEvent.click(within(more()).getByRole("menuitem", { name: "Align center" }));
    expect(latest!.sheets[0].cells.A1.s).toMatchObject({ align: "center" });
    fireEvent.click(within(more()).getByRole("menuitem", { name: "Align top" }));
    expect(latest!.sheets[0].cells.A1.s).toMatchObject({ valign: "top" });
    // Bottom is Excel's default, so choosing it clears the stored alignment.
    fireEvent.click(within(more()).getByRole("menuitem", { name: "Align bottom" }));
    expect(latest!.sheets[0].cells.A1.s?.valign).toBeUndefined();
  });

  it("offers AutoSum under More when the toolbar is too narrow for its key", () => {
    let latest: Workbook | null = null;
    render(<Harness onState={(workbook) => { latest = workbook; }} />);
    typeIntoActiveCell("4");
    typeIntoActiveCell("6");
    fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
    const more = screen.getByRole("menu", { name: "More formatting" });
    fireEvent.click(within(more).getByRole("menuitem", { name: "AutoSum: Sum" }));
    // As in Excel, AutoSum writes the formula into the cell and waits for Enter.
    const editor = screen.getByLabelText("Edit A3") as HTMLTextAreaElement;
    expect(editor.value).toBe("=SUM(A1:A2)");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(latest!.sheets[0].cells.A3).toEqual({ f: "SUM(A1:A2)" });
  });

  it("switches a table's style from the toolbar while the cursor is in it, as Excel's Table Design gallery does", () => {
    const parsed = parseWorkbook({
      sheets: [{
        id: "s",
        name: "Data",
        cells: { A1: { v: "Item" }, B1: { v: "Qty" }, A2: { v: "Pens" }, B2: { v: 3 }, D1: { v: "Region" }, E1: { v: "Units" }, D2: { v: "East" }, E2: { v: 4 } },
        tables: [{ id: "t1", name: "Sales", ref: "A1:B2", accent: 1, tone: "medium" }, { id: "t2", name: "Regions", ref: "D1:E2", accent: 1, tone: "medium" }],
      }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    let latest: Workbook | null = null;
    render(<Harness initial={parsed.workbook} onState={(workbook) => { latest = workbook; }} />);
    fireEvent.keyDown(grid(), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Table styles" }));
    const gallery = screen.getByRole("menu", { name: "Table styles" });
    expect(within(gallery).getAllByRole("menuitemradio")).toHaveLength(18);
    const checked = within(gallery).getAllByRole("menuitemradio").filter((choice) => choice.getAttribute("aria-checked") === "true");
    expect(checked.map((choice) => choice.getAttribute("aria-label"))).toEqual(["Teal · Medium"]);
    expect(gallery.querySelectorAll(".sheet-table-choice.is-active")).toHaveLength(1);
    // Inside a table with no painted cells there is nothing to explain.
    expect(gallery.querySelector(".sheet-menu-note")).toBeNull();
    expect(within(gallery).queryByRole("menuitem", { name: "Format this data as a table…" })).toBeNull();
    expect(checked[0]).toHaveClass("is-active");
    // A tick marks the options that are on, and only those.
    const ticks = (name: string) => within(gallery).getByRole("menuitemcheckbox", { name }).querySelectorAll("svg").length;
    expect([ticks("Banded rows"), ticks("Filter buttons"), ticks("Bold first column")]).toEqual([1, 1, 0]);
    fireEvent.click(within(gallery).getByRole("menuitemradio", { name: "Violet · Dark" }));
    expect(latest!.sheets[0].tables!.map((table) => [table.name, table.accent, table.tone])).toEqual([["Sales", 3, "dark"], ["Regions", 1, "medium"]]);
    // The gallery stays open so another style is one more click away.
    const open = screen.getByRole("menu", { name: "Table styles" });
    expect(within(open).getByRole("menuitemradio", { name: "Violet · Dark" }).getAttribute("aria-checked")).toBe("true");
    const banded = within(open).getByRole("menuitemcheckbox", { name: "Banded rows" });
    expect(banded.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(banded);
    expect(latest!.sheets[0].tables![0].banded).toBe(false);
    fireEvent.click(within(open).getByRole("menuitemcheckbox", { name: "Bold first column" }));
    expect(latest!.sheets[0].tables![0].firstColumn).toBe(true);
    fireEvent.click(within(open).getByRole("menuitemcheckbox", { name: "Filter buttons" }));
    expect(latest!.sheets[0].tables![0].filterButtons).toBe(false);
    fireEvent.click(within(open).getByRole("menuitem", { name: "Use this style for every table" }));
    expect(latest!.sheets[0].tables!.map((table) => [table.accent, table.tone])).toEqual([[3, "dark"], [3, "dark"]]);
    fireEvent.click(screen.getByRole("button", { name: "Table styles" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Table styles" })).getByRole("menuitem", { name: "More table options…" }));
    expect(screen.getByRole("complementary", { name: "Table" })).toBeTruthy();
  });

  it("keeps Table styles in the toolbar outside tables: it restyles every table at once, clearing fills that would hide the style", () => {
    const parsed = parseWorkbook({
      sheets: [
        {
          id: "s",
          name: "Budget",
          cells: { A1: { v: "Monthly budget" }, A3: { v: "Item", s: { fill: "#0f766e", color: "#ffffff" } }, B3: { v: "Cost" }, A4: { v: "Rent" }, B4: { v: 1800 } },
          tables: [{ id: "t1", name: "Costs", ref: "A3:B4", accent: 1, tone: "medium" }],
        },
        { id: "n", name: "Notes", cells: { A1: { v: "Who" }, A2: { v: "Ana" } }, tables: [{ id: "t2", name: "People", ref: "A1:A2", accent: 2, tone: "light" }] },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    let latest: Workbook | null = null;
    render(<Harness initial={parsed.workbook} onState={(workbook) => { latest = workbook; }} />);
    // The cursor starts on the title in A1, outside every table.
    fireEvent.click(screen.getByRole("button", { name: "Table styles" }));
    const gallery = screen.getByRole("menu", { name: "Table styles" });
    expect(within(gallery).getByText("Restyle all 2 tables")).toBeTruthy();
    expect(within(gallery).getByText(/Cell fill colors inside the tables hide their style/)).toBeTruthy();
    expect(within(gallery).getAllByRole("menuitemradio").filter((choice) => choice.getAttribute("aria-checked") === "true")).toHaveLength(0);
    expect(within(gallery).queryByRole("menuitemcheckbox", { name: "Banded rows" })).toBeNull();
    fireEvent.click(within(gallery).getByRole("menuitemradio", { name: "Rose · Dark" }));
    expect(latest!.sheets.map((sheet) => sheet.tables!.map((table) => [table.name, table.accent, table.tone]))).toEqual([[["Costs", 5, "dark"]], [["People", 5, "dark"]]]);
    expect(latest!.sheets[0].cells.A3.s).toBeUndefined();
    expect(within(screen.getByRole("menu", { name: "Table styles" })).getByRole("menuitemradio", { name: "Rose · Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(within(screen.getByRole("menu", { name: "Table styles" })).queryByText(/hide their style/)).toBeNull();
  });

  it("restyles a workbook's one table from outside it, and offers to make the data under the cursor a table too", () => {
    const parsed = parseWorkbook({
      sheets: [{
        id: "s",
        name: "Budget",
        cells: { A1: { v: "Item", s: { fill: "#0f766e" } }, A2: { v: "Rent" }, D1: { v: "Month" }, D2: { v: "Jan" } },
        tables: [{ id: "t1", name: "Costs", ref: "A1:A2", accent: 1, tone: "medium" }],
      }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    let latest: Workbook | null = null;
    render(<Harness initial={parsed.workbook} onState={(workbook) => { latest = workbook; }} />);
    for (let step = 0; step < 3; step += 1) fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Table styles" }));
    const gallery = screen.getByRole("menu", { name: "Table styles" });
    expect(within(gallery).getByText("Restyle the table")).toBeTruthy();
    expect(within(gallery).getByText("Cell fill colors inside the table hide its style; picking one clears them.")).toBeTruthy();
    expect(within(gallery).getByRole("menuitemradio", { name: "Teal · Medium" }).getAttribute("aria-checked")).toBe("true");
    expect(within(gallery).getByRole("menuitem", { name: "Format this data as a table…" })).toBeTruthy();
    fireEvent.click(within(gallery).getByRole("menuitemradio", { name: "Amber · Light" }));
    expect(latest!.sheets[0].tables!.map((table) => [table.accent, table.tone])).toEqual([[4, "light"]]);
  });

  it("formats the data around the cursor as a table in the picked style when there are no tables yet", () => {
    const parsed = parseWorkbook({ sheets: [{ id: "s", name: "Data", cells: { A1: { v: "Item" }, B1: { v: "Qty" }, A2: { v: "Pens" }, B2: { v: 3 }, A3: { v: "Pads" }, B3: { v: 5 } } }] });
    if (!parsed.ok) throw new Error(parsed.error);
    let latest: Workbook | null = null;
    render(<Harness initial={parsed.workbook} onState={(workbook) => { latest = workbook; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Table styles" }));
    const gallery = screen.getByRole("menu", { name: "Table styles" });
    expect(within(gallery).getByText("Format A1:B3 as a table")).toBeTruthy();
    fireEvent.click(within(gallery).getByRole("menuitemradio", { name: "Blue · Light" }));
    expect(latest!.sheets[0].tables).toEqual([{ id: "Table1", name: "Table1", ref: "A1:B3", accent: 2, tone: "light", banded: true, totals: false, filterButtons: true }]);
    // Now in a table, the gallery restyles it and offers its options.
    expect(within(screen.getByRole("menu", { name: "Table styles" })).getByRole("menuitemcheckbox", { name: "Banded rows" })).toBeTruthy();
  });

  it("says what to do when there is no data to make a table from", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Table styles" }));
    const gallery = screen.getByRole("menu", { name: "Table styles" });
    expect(within(gallery).getByText(/Click inside your data/)).toBeTruthy();
    expect(within(gallery).getAllByRole("menuitemradio").every((choice) => (choice as HTMLButtonElement).disabled)).toBe(true);
    expect(within(gallery).getByRole("menuitem", { name: "More table options…" })).toBeTruthy();
  });

  it("clears fills inside a table when you pick a new style for it", () => {
    const parsed = parseWorkbook({
      sheets: [{ id: "s", name: "Data", cells: { A1: { v: "Item", s: { fill: "#123456", bold: true } }, A2: { v: "Pens", s: { fill: "#ffff00" } } }, tables: [{ id: "t1", name: "Sales", ref: "A1:A2", accent: 1, tone: "medium" }] }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    let latest: Workbook | null = null;
    render(<Harness initial={parsed.workbook} onState={(workbook) => { latest = workbook; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Table styles" }));
    const gallery = screen.getByRole("menu", { name: "Table styles" });
    expect(within(gallery).getByText(/Cell fill colors inside the table hide its style/)).toBeTruthy();
    // A style option keeps the fills; a new style clears them.
    fireEvent.click(within(gallery).getByRole("menuitemcheckbox", { name: "Banded rows" }));
    expect(latest!.sheets[0].cells.A1.s).toEqual({ fill: "#123456", bold: true });
    fireEvent.click(within(screen.getByRole("menu", { name: "Table styles" })).getByRole("menuitemradio", { name: "Green · Dark" }));
    expect([latest!.sheets[0].cells.A1.s, latest!.sheets[0].cells.A2.s]).toEqual([{ bold: true }, undefined]);
  });

  it("clears fills the same way from the Table panel: a new color on a table, or a new table over painted cells", () => {
    const painted = { A1: { v: "Item", s: { fill: "#123456", bold: true } }, A2: { v: "Pens", s: { fill: "#ffff00" } } };
    const tabled = parseWorkbook({ sheets: [{ id: "s", name: "Data", cells: painted, tables: [{ id: "t1", name: "Sales", ref: "A1:A2", accent: 1, tone: "medium" }] }] });
    if (!tabled.ok) throw new Error(tabled.error);
    let latest: Workbook | null = null;
    const first = render(<Harness initial={tabled.workbook} onState={(workbook) => { latest = workbook; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Table styles" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Table styles" })).getByRole("menuitem", { name: "More table options…" }));
    const panel = screen.getByRole("complementary", { name: "Table" });
    fireEvent.click(within(within(panel).getByRole("radiogroup", { name: "Table color" })).getByRole("radio", { name: "Rose" }));
    expect(latest!.sheets[0].tables![0].accent).toBe(5);
    expect([latest!.sheets[0].cells.A1.s, latest!.sheets[0].cells.A2.s]).toEqual([{ bold: true }, undefined]);
    first.unmount();

    const plain = parseWorkbook({ sheets: [{ id: "s", name: "Data", cells: painted }] });
    if (!plain.ok) throw new Error(plain.error);
    render(<Harness initial={plain.workbook} onState={(workbook) => { latest = workbook; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Table styles" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Table styles" })).getByRole("menuitem", { name: "More table options…" }));
    const create = screen.getByRole("complementary", { name: "Table" });
    expect(within(create).getByDisplayValue("Table1")).toBeTruthy();
    fireEvent.click(within(create).getByRole("button", { name: "Create table" }));
    expect(latest!.sheets[0].tables!.map((table) => table.ref)).toEqual(["A1:A2"]);
    expect([latest!.sheets[0].cells.A1.s, latest!.sheets[0].cells.A2.s]).toEqual([{ bold: true }, undefined]);
  });

  it("offers one table's style to every table only when there are others, and follows the theme as it changes", async () => {
    const parsed = parseWorkbook({
      sheets: [{ id: "s", name: "Data", cells: { A1: { v: "Item" }, A2: { v: "Pens" } }, tables: [{ id: "t1", name: "Sales", ref: "A1:A2", accent: 1, tone: "medium" }] }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const header = () => within(screen.getByRole("menu", { name: "Table styles" })).getByRole("menuitemradio", { name: "Teal · Medium" }).style.getPropertyValue("--table-header");
    render(<Harness initial={parsed.workbook} />);
    fireEvent.click(screen.getByRole("button", { name: "Table styles" }));
    expect(screen.queryByRole("menuitem", { name: "Use this style for every table" })).toBeNull();
    expect(header()).toBe(tablePalette({ accent: 1, tone: "medium" }, false).header);
    // Switching the app to dark while the gallery is open redraws it.
    document.documentElement.classList.add("theme-dark");
    try {
      await waitFor(() => expect(header()).toBe(tablePalette({ accent: 1, tone: "medium" }, true).header));
    } finally {
      document.documentElement.classList.remove("theme-dark");
    }
  });

  it("shares the document status bar: zoom steps, find, and keyboard shortcuts", () => {
    render(<Harness />);
    const status = screen.getByRole("contentinfo", { name: "Spreadsheet status" });
    fireEvent.click(within(status).getByRole("button", { name: "Zoom in" }));
    expect(within(status).getByRole("button", { name: /^Zoom 110 percent/ })).toBeTruthy();
    fireEvent.click(within(status).getByRole("button", { name: "Keyboard shortcuts" }));
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Fill down")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close keyboard shortcuts" }));
    fireEvent.keyDown(grid(), { key: "/", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });
});

function handleOffset(handle: HTMLElement) {
  const header = handle.closest(".sheet-header") as HTMLElement;
  return parseFloat(header.style.width);
}

/** jsdom has no PointerEvent, so drags are sent as mouse events named like
 * pointer events; React reads clientX/Y from them the same way. */
function pointer(target: HTMLElement, type: string, clientX: number, clientY: number) {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 }));
  });
}
