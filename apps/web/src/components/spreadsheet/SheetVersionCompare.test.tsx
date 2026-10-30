import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseWorkbook, serializeWorkbook } from "../../lib/sheet/sheetModel";
import { SheetVersionCompare, versionChoice } from "./SheetVersionCompare";

const version = (summary: string) => ({ id: "v3", label: "Version 3", summary, content: "{}" });

describe("versionChoice", () => {
  it("keeps a short summary whole", () => {
    expect(versionChoice(version("Added totals"))).toBe("Version 3 · Added totals");
    expect(versionChoice(version("x".repeat(24)))).toBe(`Version 3 · ${"x".repeat(24)}`);
  });

  it("shortens a long summary so the closed picker reads whole", () => {
    expect(versionChoice(version("Manual spreadsheet edit snapshot"))).toBe("Version 3 · Manual spreadsheet edit…");
    expect(versionChoice(version("x".repeat(25)))).toBe(`Version 3 · ${"x".repeat(23)}…`);
  });

  it("shows only the label without a summary", () => {
    expect(versionChoice(version("   "))).toBe("Version 3");
  });
});

function contentOf(sheets: unknown[]): string {
  const parsed = parseWorkbook({ sheets });
  if (!parsed.ok) throw new Error(parsed.error);
  return serializeWorkbook(parsed.workbook);
}

const V1 = { id: "v1", label: "Version 1", summary: "Opened", content: contentOf([{ id: "a", name: "Budget", cells: { A1: { v: "Rent" }, B1: { v: 1800 } } }]) };
const V2 = {
  id: "v2",
  label: "Version 2",
  summary: "Raised rent",
  content: contentOf([
    { id: "a", name: "Costs", cells: { A1: { v: "Rent" }, B1: { v: 1900 }, A2: { v: "Food" }, B2: { v: 420 } } },
    { id: "b", name: "Notes", cells: {} },
  ]),
};

function showCompare(versions = [V1, V2]) {
  const onClose = vi.fn();
  render(<SheetVersionCompare versions={versions} onClose={onClose} />);
  return { onClose, dialog: screen.getByRole("dialog", { name: "Compare workbook versions" }) };
}

describe("SheetVersionCompare", () => {
  it("compares the newest version with the one before it, cell by cell", () => {
    const { dialog } = showCompare();
    const [base, compared] = within(dialog).getAllByRole("combobox") as HTMLSelectElement[];
    expect(base.value).toBe("v1");
    expect(compared.value).toBe("v2");
    expect(document.activeElement).toBe(base);
    const totals = within(dialog).getByRole("status");
    expect(totals).toHaveTextContent("2 added");
    expect(totals).toHaveTextContent("1 changed");
    expect(totals).toHaveTextContent("Sheets added: Notes");
    expect(totals).toHaveTextContent("Renamed Budget → Costs");
    expect(totals).not.toHaveTextContent(/removed|same cells/);
    expect(within(dialog).queryByText(/more changed cells/)).not.toBeInTheDocument();
    const changes = within(dialog).getByRole("region", { name: "Changes on Costs" });
    const changed = within(changes).getByRole("rowheader", { name: "B1" }).closest("tr")!;
    expect(changed).toHaveClass("is-changed");
    expect(changed).toHaveTextContent(/1800.*1900.*Changed/);
    expect(within(within(changes).getByRole("rowheader", { name: "A2" }).closest("tr")!).getByText("empty")).toBeInTheDocument();
  });

  it("says when two versions hold the same cells", () => {
    const { dialog } = showCompare([V1, { ...V1, id: "v1b", label: "Version 2" }]);
    expect(within(dialog).getByRole("status")).toHaveTextContent("These versions hold the same cells.");
  });

  it("lists sheets removed when the base is the newer version", () => {
    const { dialog } = showCompare();
    fireEvent.change(within(dialog).getAllByRole("combobox")[0], { target: { value: "v2" } });
    fireEvent.change(within(dialog).getAllByRole("combobox")[1], { target: { value: "v1" } });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Sheets removed: Notes");
    expect(within(dialog).getByRole("status")).not.toHaveTextContent(/Sheets added|same cells/);
  });

  it("counts any one kind of difference as a difference", () => {
    const budget = { id: "a", name: "Budget", cells: { A1: { v: "Rent" } } };
    const pairs = [
      [[budget], [budget, { id: "b", name: "Notes", cells: {} }]],
      [[budget, { id: "b", name: "Notes", cells: {} }], [budget]],
      [[budget], [{ ...budget, name: "Costs" }]],
      [[budget], [{ ...budget, cells: { A1: { v: "Food" } } }]],
    ];
    for (const [before, after] of pairs) {
      const { dialog } = showCompare([{ ...V1, content: contentOf(before) }, { ...V2, content: contentOf(after) }]);
      expect(within(dialog).getByRole("status")).not.toHaveTextContent("same cells");
      cleanup();
    }
  });

  it("defaults to the last two of several versions", () => {
    const { dialog } = showCompare([V1, V2, { ...V2, id: "v3", label: "Version 3" }]);
    expect((within(dialog).getAllByRole("combobox") as HTMLSelectElement[]).map((select) => select.value)).toEqual(["v2", "v3"]);
  });

  it("caps a long list of changed cells and says how many more there are", () => {
    const empty = { ...V1, content: contentOf([{ id: "a", name: "Budget", cells: {} }]) };
    const filled = (count: number) => {
      const cells = Object.fromEntries(Array.from({ length: count }, (_, index) => [`A${index + 1}`, { v: index }]));
      return { ...V2, content: contentOf([{ id: "a", name: "Budget", cells }]) };
    };
    expect(within(showCompare([empty, filled(2_001)]).dialog).getByText("…and 1 more changed cell.")).toBeInTheDocument();
    cleanup();
    expect(within(showCompare([empty, filled(2_002)]).dialog).getByText("…and 2 more changed cells.")).toBeInTheDocument();
  });

  it("compares a lone version with itself", () => {
    const { dialog } = showCompare([V1]);
    const [base, compared] = within(dialog).getAllByRole("combobox") as HTMLSelectElement[];
    expect([base.value, compared.value]).toEqual(["v1", "v1"]);
  });

  it("says so with no versions to compare", () => {
    const { dialog } = showCompare([]);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("One of these versions could not be read.");
  });

  it("says so when a version cannot be read", () => {
    const { dialog } = showCompare([V1, { ...V2, content: "not a workbook" }]);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("One of these versions could not be read.");
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
  });

  it("closes from Escape, the close button, and the backdrop, but not a press inside", () => {
    const { dialog, onClose } = showCompare();
    fireEvent.keyDown(dialog, { key: "Enter" });
    fireEvent.pointerDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close comparison" }));
    fireEvent.pointerDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
