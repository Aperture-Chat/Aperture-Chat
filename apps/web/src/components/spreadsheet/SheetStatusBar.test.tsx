import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { computeWorkbook } from "../../lib/sheet/recalc";
import { parseWorkbook } from "../../lib/sheet/sheetModel";
import { SheetStatusBar } from "./SheetStatusBar";

function setup({ zoom = 1, range = { r1: 0, c1: 0, r2: 2, c2: 0 }, active = "c" } = {}) {
  const parsed = parseWorkbook({
    sheets: [
      { id: "a", name: "Summary", cells: {} },
      { id: "b", name: "Scratch", cells: {}, hidden: true },
      { id: "c", name: "Sales", cells: { A1: { v: "Total" }, A2: { v: 1200 }, A3: { v: 800.5 } } },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const workbook = parsed.workbook;
  const onZoom = vi.fn();
  const onOpenFind = vi.fn();
  const onShowShortcuts = vi.fn();
  render(
    <SheetStatusBar
      engine={computeWorkbook(workbook)}
      workbook={workbook}
      sheet={workbook.sheets.find((sheet) => sheet.id === active)!}
      range={range}
      zoom={zoom}
      onZoom={onZoom}
      onOpenFind={onOpenFind}
      onShowShortcuts={onShowShortcuts}
    />,
  );
  return { onZoom, onOpenFind, onShowShortcuts };
}

describe("SheetStatusBar", () => {
  it("names the sheet among the visible ones and totals the selection", () => {
    setup();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Sheet 2 of 2Sum 2000.5Average 1000.25Min 800.5Max 1200Count 3");
  });

  it("shows only the sheet for a single cell", () => {
    setup({ range: { r1: 1, c1: 0, r2: 1, c2: 0 }, active: "a" });
    expect(screen.getByRole("status").textContent).toBe("Sheet 1 of 2");
  });

  it("totals a selection holding a single number", () => {
    setup({ range: { r1: 0, c1: 0, r2: 1, c2: 0 } });
    expect(screen.getByRole("status").textContent).toBe("Sheet 2 of 2Sum 1200Average 1200Min 1200Max 1200Count 2");
  });

  it("shows no figures for an empty selection", () => {
    setup({ range: { r1: 0, c1: 0, r2: 2, c2: 1 }, active: "a" });
    expect(screen.getByRole("status").textContent).toBe("Sheet 1 of 2");
  });

  it("counts text without summing it", () => {
    setup({ range: { r1: 0, c1: 0, r2: 0, c2: 1 } });
    expect(screen.getByRole("status").textContent).toBe("Sheet 2 of 2Count 1");
  });

  it("steps zoom through the document zoom stops and resets to 100%", () => {
    const { onZoom } = setup({ zoom: 1.25 });
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom 125 percent. Reset to 100 percent" }));
    expect(onZoom.mock.calls).toEqual([[1.1], [1.5], [1]]);
    expect(screen.getByRole("button", { name: /^Zoom 125 percent/ }).textContent).toBe("125%");
  });

  it("stops zoom at both ends", () => {
    setup({ zoom: 0.5 });
    expect((screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stops zoom in at the top", () => {
    const { onZoom } = setup({ zoom: 2 });
    const zoomIn = screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement;
    expect(zoomIn.disabled).toBe(true);
    fireEvent.click(zoomIn);
    expect(onZoom).not.toHaveBeenCalled();
  });

  it("opens find and the shortcuts list", () => {
    const { onOpenFind, onShowShortcuts } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Find and replace" }));
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(onOpenFind).toHaveBeenCalledTimes(1);
    expect(onShowShortcuts).toHaveBeenCalledTimes(1);
  });
});
