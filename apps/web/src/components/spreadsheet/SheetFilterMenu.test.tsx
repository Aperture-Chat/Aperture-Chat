import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { computeWorkbook } from "../../lib/sheet/recalc";
import { parseWorkbook, type SheetFilter } from "../../lib/sheet/sheetModel";
import { SheetFilterMenu } from "./SheetMenus";

const SCORES = { A1: { v: "Name" }, B1: { v: "Score" }, A2: { v: "Ana" }, B2: { v: 91 }, A3: { v: "Ben" }, B3: { v: 78 }, A4: { v: "Cy" }, B4: { v: 88 } };

function openMenu(filter: SheetFilter = { ref: "A1:B4", criteria: {} }, readOnly = false, cells: Record<string, unknown> = SCORES) {
  const parsed = parseWorkbook({ sheets: [{ id: "s", name: "Scores", cells }] });
  if (!parsed.ok) throw new Error(parsed.error);
  const sheet = parsed.workbook.sheets[0];
  const onApply = vi.fn();
  const onSort = vi.fn();
  const onClose = vi.fn();
  render(
    <SheetFilterMenu
      col={1}
      anchor={new DOMRect(10, 10, 80, 20)}
      filter={filter}
      sheet={sheet}
      engine={computeWorkbook(parsed.workbook)}
      readOnly={readOnly}
      onApply={onApply}
      onSort={onSort}
      onClose={onClose}
    />,
  );
  return { onApply, onSort, onClose };
}

const choose = (op: string) => fireEvent.change(screen.getByLabelText("Filter condition"), { target: { value: op } });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const apply = () => fireEvent.click(screen.getByRole("button", { name: "Apply" }));

describe("filter menu conditions", () => {
  it("asks for an upper value only for between and not between", () => {
    openMenu();
    expect(screen.queryByLabelText("Condition value")).toBeNull();
    choose("gt");
    expect(screen.getByLabelText("Condition value")).toBeTruthy();
    expect(screen.queryByLabelText("Upper value")).toBeNull();
    choose("between");
    expect(screen.getByLabelText("Upper value")).toBeTruthy();
    choose("notBetween");
    expect(screen.getByLabelText("Upper value")).toBeTruthy();
  });

  it("applies a between condition with both bounds", () => {
    const { onApply } = openMenu();
    choose("between");
    type("Condition value", " 80 ");
    type("Upper value", "95");
    apply();
    expect(onApply).toHaveBeenCalledWith({ ref: "A1:B4", criteria: { B: { condition: { op: "between", value: "80", value2: "95" } } } }, "Filtered Score");
  });

  it("needs the upper bound before a between condition applies, and drops it for other conditions", () => {
    const { onApply } = openMenu();
    choose("between");
    type("Condition value", "80");
    apply();
    expect(onApply).toHaveBeenLastCalledWith({ ref: "A1:B4", criteria: {} }, "Filtered Score");
  });

  it("ignores a typed value once the condition is set back to none", () => {
    const { onApply } = openMenu();
    choose("gt");
    type("Condition value", "5");
    choose("");
    apply();
    expect(onApply).toHaveBeenLastCalledWith({ ref: "A1:B4", criteria: {} }, "Filtered Score");
  });

  it("opens with a saved between condition filled in", () => {
    const { onApply } = openMenu({ ref: "A1:B4", criteria: { B: { condition: { op: "notBetween", value: "80", value2: "95" } } } });
    expect((screen.getByLabelText("Condition value") as HTMLInputElement).value).toBe("80");
    expect((screen.getByLabelText("Upper value") as HTMLInputElement).value).toBe("95");
    choose("gt");
    apply();
    expect(onApply).toHaveBeenCalledWith({ ref: "A1:B4", criteria: { B: { condition: { op: "gt", value: "80" } } } }, "Filtered Score");
  });
});

describe("filter menu values, sorting, and clearing", () => {
  const box = (label: string) => screen.getByRole("checkbox", { name: new RegExp(`^${label}`) });

  it("keeps only the checked values, and none when every value is checked", () => {
    const { onApply } = openMenu();
    apply();
    expect(onApply).toHaveBeenLastCalledWith({ ref: "A1:B4", criteria: {} }, "Filtered Score");
    fireEvent.click(box("78"));
    apply();
    expect(onApply).toHaveBeenLastCalledWith({ ref: "A1:B4", criteria: { B: { values: ["88", "91"] } } }, "Filtered Score");
  });

  it("lets select-all follow the search", () => {
    const { onApply } = openMenu();
    fireEvent.change(screen.getByLabelText("Search values"), { target: { value: "8" } });
    expect(screen.queryByRole("checkbox", { name: /^91/ })).toBeNull();
    fireEvent.click(box("\\(Select all\\)"));
    apply();
    expect(onApply).toHaveBeenLastCalledWith({ ref: "A1:B4", criteria: { B: { values: ["91"] } } }, "Filtered Score");
  });

  it("sorts, clears the column, and closes", () => {
    const { onApply, onSort, onClose } = openMenu({ ref: "A1:B4", criteria: { A: { values: ["Ana"] }, B: { values: ["91"] } } });
    expect((box("91") as HTMLInputElement).checked).toBe(true);
    expect((box("78") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Sort A → Z/ }));
    fireEvent.click(screen.getByRole("button", { name: /Sort Z → A/ }));
    expect(onSort.mock.calls).toEqual([[false], [true]]);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onApply).toHaveBeenCalledWith({ ref: "A1:B4", criteria: { A: { values: ["Ana"] } } }, "Cleared column filter");
    expect(onClose).toHaveBeenCalled();
  });

  it("disables every action when read-only, and Clear when the column has no filter", () => {
    const disabled = (name: RegExp) => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
    openMenu(undefined, true);
    expect([/Sort A → Z/, /Sort Z → A/, /Clear/, /Apply/].map(disabled)).toEqual([true, true, true, true]);
    cleanup();
    openMenu();
    expect([disabled(/Clear/), disabled(/Apply/)]).toEqual([true, false]);
    cleanup();
    openMenu({ ref: "A1:B4", criteria: { B: { values: ["91"] } } });
    expect(disabled(/Clear/)).toBe(false);
    cleanup();
    openMenu({ ref: "A1:B4", criteria: { B: { values: ["91"] } } }, true);
    expect(disabled(/Clear/)).toBe(true);
  });

  it("opens with nothing checked when the saved list is empty", () => {
    openMenu({ ref: "A1:B4", criteria: { B: { values: [] } } });
    expect(["78", "88", "91"].map((label) => (box(label) as HTMLInputElement).checked)).toEqual([false, false, false]);
  });

  it("sits just below its anchor and names the column by its header, even a zero", () => {
    const { onApply } = openMenu(undefined, false, { ...SCORES, B1: { v: 0 } });
    expect(screen.getByRole("dialog").style.top).toBe("34px");
    apply();
    expect(onApply).toHaveBeenLastCalledWith({ ref: "A1:B4", criteria: {} }, "Filtered 0");
  });
});
