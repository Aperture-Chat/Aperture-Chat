import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { blankWorkbook } from "../../lib/sheet/sheetModel";
import { type SheetAiPreview, type SheetAiState, SheetAiComposer, composerAnchor } from "./SheetAiComposer";

function preview(overrides: Partial<SheetAiPreview> = {}): SheetAiPreview {
  return { workbook: blankWorkbook(), changed: new Map(), summary: "3 cells", warnings: [], problems: 0, sheetId: "s", ...overrides };
}

function show(state: Partial<SheetAiState>) {
  const handlers = { onRun: vi.fn(), onRefine: vi.fn(), onAccept: vi.fn(), onRetry: vi.fn(), onStop: vi.fn(), onClose: vi.fn() };
  render(
    <SheetAiComposer
      state={{ open: true, phase: "idle", prompt: "Add a total", label: "Add a total", ...state }}
      scopeLabel="Sheet1!B2:D5"
      agentName="Analyst"
      disabledReason={null}
      getAnchor={() => ({ top: 100, bottom: 120, left: 40, right: 200 })}
      {...handlers}
    />,
  );
  return handlers;
}

describe("SheetAiComposer", () => {
  it("applies a previewed change", () => {
    const handlers = show({ phase: "preview", message: "Added a total.", preview: preview() });
    expect(screen.getByText("Added a total.")).toBeTruthy();
    expect(screen.getByText(/3 cells — highlighted in the grid\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept AI suggestion" }));
    expect(screen.getByRole("button", { name: "Accept AI suggestion" }).textContent).toContain("Apply");
    expect(handlers.onAccept).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("leaves out the message line when the model sent none", () => {
    show({ phase: "preview", message: "", preview: preview() });
    expect(document.querySelector(".sheet-ai-message")).toBeNull();
  });

  it("closes an answer with Done instead of applying anything", () => {
    const handlers = show({ phase: "answered", message: "Column A holds units." });
    expect(document.querySelector(".sheet-ai-message.is-answer")?.textContent).toBe("Column A holds units.");
    const done = screen.getByRole("button", { name: "Accept AI suggestion" });
    expect(done.textContent).toContain("Done");
    fireEvent.click(done);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onAccept).not.toHaveBeenCalled();
  });

  it("warns about formulas that still error, in the right number", () => {
    show({ phase: "preview", preview: preview({ problems: 1 }) });
    expect(screen.getByText(/1 formula still shows an error/)).toBeTruthy();
  });

  it("pluralizes several erroring formulas, and says nothing when there are none", () => {
    show({ phase: "preview", preview: preview({ problems: 2 }) });
    expect(screen.getByText(/2 formulas still show an error/)).toBeTruthy();
  });

  it("stays quiet without problems or skipped changes", () => {
    show({ phase: "preview", preview: preview() });
    expect(document.querySelector(".sheet-ai-warning")).toBeNull();
    expect(document.querySelector(".sheet-ai-details")).toBeNull();
  });

  it("lists skipped changes, at most twelve", () => {
    show({ phase: "preview", preview: preview({ warnings: Array.from({ length: 13 }, (_, index) => `Skipped ${index}`) }) });
    expect(screen.getByText("13 skipped changes")).toBeTruthy();
    expect(document.querySelectorAll(".sheet-ai-details li")).toHaveLength(12);
    expect(screen.getByText("Skipped 0")).toBeTruthy();
  });

  it("names a single skipped change", () => {
    show({ phase: "preview", preview: preview({ warnings: ["Skipped A1"] }) });
    expect(screen.getByText("1 skipped change")).toBeTruthy();
  });

  it("says which stage the model is at instead of echoing its JSON", () => {
    show({ phase: "fixing" });
    expect(screen.getByText("Checking the formulas it wrote and fixing any errors…")).toBeTruthy();
  });

  it("shows writing once the reply streams, and thinking before that", () => {
    show({ phase: "thinking", streamed: '{"ops":[' });
    expect(screen.getByText("Writing the changes into the sheet…")).toBeTruthy();
  });

  it("shows thinking before anything streams", () => {
    show({ phase: "thinking", streamed: "" });
    expect(screen.getByText("Thinking…")).toBeTruthy();
    expect(screen.queryByText("Writing the changes into the sheet…")).toBeNull();
  });

  it("does not say writing while it fixes", () => {
    show({ phase: "fixing", streamed: "partial" });
    expect(screen.queryByText("Writing the changes into the sheet…")).toBeNull();
  });
});

type Box = { top: number; bottom: number; left: number; right: number };

function element(className: string, box: Box): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
  node.getBoundingClientRect = () => ({ ...box, width: box.right - box.left, height: box.bottom - box.top, x: box.left, y: box.top, toJSON: () => box });
  return node;
}

function gridWith(...cells: [string, Box][]) {
  const root = document.createElement("div");
  root.append(element("sheet-scroll", { top: 100, bottom: 500, left: 50, right: 900 }));
  const pane = document.createElement("div");
  pane.className = "sheet-pane is-main";
  for (const [className, box] of cells) pane.append(element(className, box));
  root.append(pane);
  return root;
}

const BAR = element("sheet-formula-bar", { top: 40, bottom: 80, left: 50, right: 850 });

describe("composerAnchor", () => {
  it("spans the selection and the changed cells, clipped to the grid", () => {
    const root = gridWith(
      ["sheet-selection", { top: 120, bottom: 200, left: 100, right: 300 }],
      ["sheet-cell is-ai-changed", { top: 200, bottom: 560, left: 80, right: 1000 }],
    );
    expect(composerAnchor(root, BAR)).toEqual({ top: 120, bottom: 500, left: 80, right: 900 });
  });

  it("clips the top and left to the grid too", () => {
    const root = gridWith(["sheet-selection", { top: 60, bottom: 200, left: 10, right: 300 }]);
    expect(composerAnchor(root, BAR)).toEqual({ top: 100, bottom: 200, left: 50, right: 300 });
  });

  it("ignores boxes with no width and boxes scrolled out of view", () => {
    const root = gridWith(
      ["sheet-selection", { top: 150, bottom: 170, left: 300, right: 300 }],
      ["sheet-cell is-ai-changed", { top: 40, bottom: 100, left: 100, right: 200 }],
      ["sheet-cell is-ai-changed", { top: 500, bottom: 540, left: 100, right: 200 }],
    );
    expect(composerAnchor(root, BAR)).toEqual({ top: 40, bottom: 80, left: 450, right: 850 });
  });

  it("keeps a one-pixel-wide box", () => {
    const root = gridWith(["sheet-selection", { top: 150, bottom: 170, left: 300, right: 301 }]);
    expect(composerAnchor(root, BAR)).toEqual({ top: 150, bottom: 170, left: 300, right: 301 });
  });

  it("falls back to the formula bar without a grid, and to nothing without either", () => {
    expect(composerAnchor(null, BAR)).toEqual({ top: 40, bottom: 80, left: 450, right: 850 });
    expect(composerAnchor(document.createElement("div"), BAR)).toEqual({ top: 40, bottom: 80, left: 450, right: 850 });
    expect(composerAnchor(null, null)).toBeNull();
  });
});
