import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { computeStewardDiagramLayout, parseStewardDiagram, type StewardDiagramModel } from "../lib/stewardDiagram";
import { Markdown } from "./Markdown";
import { StewardDiagramCanvas } from "./StewardDiagramCanvas";

// jsdom has no PointerEvent; React's pointer handlers only need the fields below.
beforeAll(() => {
  if (typeof window.PointerEvent === "function") return;
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.assign(window, { PointerEvent: PointerEventShim });
});

afterEach(() => vi.useRealTimers());

const SOURCE = JSON.stringify({
  title: "Studio test",
  rows: [[{ id: "a", title: "Alpha" }, { id: "b", title: "Bravo" }], [{ id: "c", title: "Charlie" }]],
  edges: [{ from: "a", to: "c" }],
});

function chart(): StewardDiagramModel {
  return parseStewardDiagram(SOURCE)!;
}

function boxOf(id: string) {
  return computeStewardDiagramLayout(chart(), false).cardBoxes.find((box) => box.id === id)!;
}

function centerOf(id: string) {
  const box = boxOf(id);
  return { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
}

function titleText(container: HTMLElement, title: string) {
  return [...container.querySelectorAll("text.sdc-text")].find((el) => el.textContent === title)!;
}

function drag(target: Element, from: { clientX: number; clientY: number }, to: { clientX: number; clientY: number }) {
  fireEvent.pointerDown(target, { ...from, button: 0, pointerId: 7 });
  fireEvent.pointerMove(window, { ...to, pointerId: 7 });
  fireEvent.pointerUp(window, { ...to, pointerId: 7 });
}

function lastCommit(onCommit: ReturnType<typeof vi.fn>): StewardDiagramModel {
  return onCommit.mock.calls.at(-1)![0] as StewardDiagramModel;
}

test("dragging a box drops it on the grid and saves its position, without opening the text editor", () => {
  const onCommit = vi.fn();
  const { container } = render(<StewardDiagramCanvas dark={false} model={chart()} onCommit={onCommit} />);
  const title = titleText(container, "Bravo");
  const start = centerOf("b");
  drag(title, start, { clientX: start.clientX - 83, clientY: start.clientY + 157 });
  fireEvent.click(title);

  expect(onCommit).toHaveBeenCalledTimes(1);
  const position = lastCommit(onCommit).rows[0]![1]!.position!;
  const box = boxOf("b");
  expect(Math.abs(position.x - (box.x - 83))).toBeLessThanOrEqual(6);
  expect(Math.abs(position.y - (box.y + 157))).toBeLessThanOrEqual(6);
  expect(screen.queryByRole("textbox", { name: "Edit diagram text" })).not.toBeInTheDocument();
});

test("a press without movement is still a click that edits the text in place", () => {
  const onCommit = vi.fn();
  const { container } = render(<StewardDiagramCanvas dark={false} model={chart()} onCommit={onCommit} />);
  const title = titleText(container, "Alpha");
  const at = centerOf("a");
  drag(title, at, { clientX: at.clientX + 1, clientY: at.clientY });
  fireEvent.click(title);
  expect(screen.getByRole("textbox", { name: "Edit diagram text" })).toHaveValue("Alpha");
  expect(onCommit).not.toHaveBeenCalled();
});

test("selecting an arrow offers style, direction, and delete controls", () => {
  const onCommit = vi.fn();
  const { container } = render(<StewardDiagramCanvas dark={false} model={chart()} onCommit={onCommit} />);
  fireEvent.click(container.querySelector('path.sdc-edge-hit[data-edge-index="0"]')!);
  const chip = screen.getByRole("group", { name: "Arrow controls" });

  fireEvent.click(within(chip).getByRole("radio", { name: "Dashed" }));
  expect(lastCommit(onCommit).edges[0]!.kind).toBe("contingent");

  fireEvent.click(within(chip).getByRole("button", { name: "Reverse arrow direction" }));
  expect(lastCommit(onCommit).edges[0]).toMatchObject({ from: "c", to: "a" });

  fireEvent.click(within(chip).getByRole("button", { name: "Delete arrow" }));
  expect(lastCommit(onCommit).edges).toEqual([]);
});

test("dragging an arrow's middle bends its route", () => {
  const onCommit = vi.fn();
  const { container } = render(<StewardDiagramCanvas dark={false} model={chart()} onCommit={onCommit} />);
  fireEvent.click(container.querySelector('path.sdc-edge-hit[data-edge-index="0"]')!);
  const handle = computeStewardDiagramLayout(chart(), false).paths.find((path) => path.edgeIndex === 0)!.handle!;
  drag(
    screen.getByRole("button", { name: "Drag to bend the arrow" }),
    { clientX: handle.x, clientY: handle.y },
    { clientX: handle.x, clientY: handle.y + 30 },
  );
  expect(lastCommit(onCommit).edges[0]!.bend).toBe(30);
  // The arrow stays selected through the drag, though its handles hid.
  expect(screen.getByRole("group", { name: "Arrow controls" })).toBeInTheDocument();
});

test("a press outside the figure lets go of the selection", () => {
  const { container } = render(
    <>
      <button type="button">Elsewhere</button>
      <StewardDiagramCanvas dark={false} model={chart()} onCommit={vi.fn()} />
    </>,
  );
  fireEvent.click(container.querySelector('path.sdc-edge-hit[data-edge-index="0"]')!);
  expect(screen.getByRole("group", { name: "Arrow controls" })).toBeInTheDocument();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
  expect(screen.queryByRole("group", { name: "Arrow controls" })).not.toBeInTheDocument();
});

test("dropping an arrow's end on another box reconnects it", () => {
  const onCommit = vi.fn();
  const { container } = render(<StewardDiagramCanvas dark={false} model={chart()} onCommit={onCommit} />);
  fireEvent.click(container.querySelector('path.sdc-edge-hit[data-edge-index="0"]')!);
  const ends = computeStewardDiagramLayout(chart(), false).paths.find((path) => path.edgeIndex === 0)!.ends!;
  drag(
    screen.getByRole("button", { name: "Drag to move the arrow's end" }),
    { clientX: ends.to[0], clientY: ends.to[1] },
    centerOf("b"),
  );
  expect(lastCommit(onCommit).edges[0]).toMatchObject({ from: "a", to: "b" });
});

test("dragging from a box's connector dot to another box draws a new arrow", () => {
  const onCommit = vi.fn();
  const { container } = render(<StewardDiagramCanvas dark={false} model={chart()} onCommit={onCommit} />);
  fireEvent.mouseEnter(titleText(container, "Bravo"));
  const dot = container.querySelectorAll("g.sdc-connector")[2]!;
  const box = boxOf("b");
  drag(dot, { clientX: box.x + box.width / 2, clientY: box.y + box.height }, centerOf("c"));
  expect(lastCommit(onCommit).edges.at(-1)).toEqual({ from: "b", to: "c", kind: "primary" });
});

test("a selected box nudges with arrow keys, deletes with Delete, and undo restores it", async () => {
  vi.useFakeTimers();
  const onCommit = vi.fn();
  const { container } = render(<StewardDiagramCanvas dark={false} model={chart()} onCommit={onCommit} />);
  const shape = container.querySelector("rect.sdc-card-shape")!;
  const at = centerOf("a");
  drag(shape, at, at);
  const canvas = screen.getByRole("group", { name: "Diagram editor" });
  expect(canvas).toHaveFocus();

  fireEvent.keyDown(canvas, { key: "ArrowRight", shiftKey: true });
  fireEvent.keyDown(canvas, { key: "ArrowDown" });
  expect(onCommit).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(450));
  const box = boxOf("a");
  expect(lastCommit(onCommit).rows[0]![0]!.position).toEqual({ x: box.x + 10, y: box.y + 1 });

  fireEvent.keyDown(canvas, { key: "Delete" });
  expect(lastCommit(onCommit).rows.flat().map((card) => card.id)).toEqual(["b", "c"]);

  fireEvent.keyDown(canvas, { key: "z", metaKey: true });
  expect(lastCommit(onCommit)).toEqual(chart());
});

test("the box chip recolors a header and turns a card into a banner", () => {
  const onCommit = vi.fn();
  const { container } = render(<StewardDiagramCanvas dark={false} model={chart()} onCommit={onCommit} />);
  fireEvent.mouseEnter(titleText(container, "Charlie"));
  fireEvent.click(screen.getByRole("button", { name: "Header color" }));
  fireEvent.click(screen.getByRole("button", { name: "Green header" }));
  expect(lastCommit(onCommit).rows[1]![0]!.color).toBe("green");
  fireEvent.click(screen.getByRole("button", { name: "Show as a banner" }));
  expect(lastCommit(onCommit).rows[1]![0]!.variant).toBe("banner");
});

test("a banner box turns back into a card", () => {
  const onCommit = vi.fn();
  const banners = chart();
  banners.rows[1]![0]!.variant = "banner";
  const { container } = render(<StewardDiagramCanvas dark={false} model={banners} onCommit={onCommit} />);
  fireEvent.mouseEnter(titleText(container, "Charlie"));
  fireEvent.click(screen.getByRole("button", { name: "Show as a card" }));
  expect(lastCommit(onCommit).rows[1]![0]!.variant).toBe("card");
});

test("the Style tray switches theme and connectors and saves them with the diagram", async () => {
  const onUpdateDiagram = vi.fn().mockReturnValue(true);
  render(<Markdown content={`\`\`\`steward-diagram\n${SOURCE}\n\`\`\``} onUpdateDiagram={onUpdateDiagram} />);
  fireEvent.click(screen.getByRole("button", { name: "Style" }));
  const tray = screen.getByRole("group", { name: "Diagram style" });
  expect(within(tray).getByRole("radio", { name: "Aperture" })).toHaveAttribute("aria-checked", "true");
  expect(within(tray).getByRole("button", { name: /Reset layout/ })).toBeDisabled();

  fireEvent.click(within(tray).getByRole("radio", { name: "Forest" }));
  await waitFor(() => expect(onUpdateDiagram).toHaveBeenCalledTimes(1));
  expect(onUpdateDiagram.mock.calls[0][0]).toBe(SOURCE);
  expect(JSON.parse(onUpdateDiagram.mock.calls[0][1]).theme).toBe("forest");

  fireEvent.click(within(tray).getByRole("radio", { name: "Curved" }));
  expect(JSON.parse(onUpdateDiagram.mock.calls[1][1]).connector).toBe("curved");
});

test("a themed diagram draws its arrows with the theme's own markers", () => {
  const themed = { ...chart(), theme: "ember" as const };
  const { container } = render(<StewardDiagramCanvas dark={false} model={themed} />);
  expect(container.querySelector('path[marker-end="url(#aperture-sd-arrow-primary-ember)"]')).toBeInTheDocument();
  expect(container.querySelector("#aperture-sd-arrow-primary-ember")).toBeInTheDocument();
  // Read-only canvases offer no editing affordances.
  expect(container.querySelector(".sdc-edge-hit")).toBeNull();
  expect(screen.queryByRole("group", { name: "Diagram editor" })).not.toBeInTheDocument();
});

test("an unlabeled arrow gets a label from its chip, and a bent arrow can be straightened", () => {
  const onCommit = vi.fn();
  const bent = { ...chart(), edges: [{ from: "a", to: "c", kind: "primary" as const, bend: 18 }] };
  const { container } = render(<StewardDiagramCanvas dark={false} model={bent} onCommit={onCommit} />);
  fireEvent.click(container.querySelector('path.sdc-edge-hit[data-edge-index="0"]')!);
  fireEvent.click(screen.getByRole("button", { name: "Reset arrow route" }));
  expect(lastCommit(onCommit).edges[0]!.bend).toBeUndefined();

  fireEvent.click(screen.getByRole("button", { name: "Edit arrow label" }));
  const input = screen.getByRole("textbox", { name: "Edit diagram text" });
  fireEvent.change(input, { target: { value: "reports to" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(lastCommit(onCommit).edges[0]!.label).toBe("reports to");
});

test("a dragged box can return to its row, and row moves put it back in the flow", () => {
  const onCommit = vi.fn();
  const placed = chart();
  placed.rows[0]![0]!.position = { x: 200, y: 260 };
  const { container } = render(<StewardDiagramCanvas dark={false} model={placed} onCommit={onCommit} />);
  fireEvent.mouseEnter(titleText(container, "Alpha"));
  fireEvent.click(screen.getByRole("button", { name: "Return box to its row" }));
  expect(lastCommit(onCommit).rows[0]![0]!.position).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Move box right" }));
  const moved = lastCommit(onCommit);
  expect(moved.rows[0]!.map((card) => card.id)).toEqual(["b", "a"]);
  expect(moved.rows[0]![1]!.position).toBeUndefined();
});

/** A host that applies every commit, as chat does. */
function LiveCanvas({ onCommit }: { onCommit: (next: StewardDiagramModel) => void }) {
  const [current, setCurrent] = useState(chart);
  return (
    <StewardDiagramCanvas
      dark={false}
      model={current}
      onCommit={(next) => {
        onCommit(next);
        setCurrent(next);
      }}
    />
  );
}

test("redo replays an undone edit; Escape lets go of the selection", () => {
  const onCommit = vi.fn();
  const { container } = render(<LiveCanvas onCommit={onCommit} />);
  const at = centerOf("c");
  drag(titleText(container, "Charlie"), at, at);
  const canvas = screen.getByRole("group", { name: "Diagram editor" });
  fireEvent.keyDown(canvas, { key: "Backspace" });
  const deleted = lastCommit(onCommit);
  fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
  expect(lastCommit(onCommit)).toEqual(chart());
  fireEvent.keyDown(canvas, { key: "y", ctrlKey: true });
  expect(lastCommit(onCommit)).toEqual(deleted);
  fireEvent.keyDown(canvas, { key: "z", metaKey: true });
  fireEvent.keyDown(canvas, { key: "z", metaKey: true, shiftKey: true });
  expect(lastCommit(onCommit)).toEqual(deleted);
  // Nothing left to redo.
  fireEvent.keyDown(canvas, { key: "z", metaKey: true, shiftKey: true });
  expect(onCommit).toHaveBeenCalledTimes(5);

  const at2 = centerOf("a");
  drag(titleText(container, "Alpha"), at2, at2);
  expect(container.querySelector(".sdc-select-outline")).not.toBeNull();
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(container.querySelector(".sdc-select-outline")).toBeNull();
  fireEvent.keyDown(canvas, { key: "Delete" });
  expect(onCommit).toHaveBeenCalledTimes(5);
});

test("the Style tray sets corners and resets a hand-placed layout", async () => {
  const onUpdateDiagram = vi.fn().mockReturnValue(true);
  const placed = JSON.stringify({ ...JSON.parse(SOURCE), edges: [{ from: "a", to: "c", bend: 20 }] });
  render(<Markdown content={`\`\`\`steward-diagram\n${placed}\n\`\`\``} onUpdateDiagram={onUpdateDiagram} />);
  fireEvent.click(screen.getByRole("button", { name: "Style" }));
  const tray = screen.getByRole("group", { name: "Diagram style" });
  fireEvent.click(within(tray).getByRole("radio", { name: "Square" }));
  expect(JSON.parse(onUpdateDiagram.mock.calls[0][1]).corners).toBe("square");
  fireEvent.click(within(tray).getByRole("button", { name: /Reset layout/ }));
  expect(JSON.parse(onUpdateDiagram.mock.calls[1][1]).edges[0].bend).toBeUndefined();
  // Arrow keys walk the theme swatches.
  fireEvent.keyDown(within(tray).getByRole("radio", { name: "Aperture" }), { key: "ArrowRight" });
  expect(JSON.parse(onUpdateDiagram.mock.calls[2][1]).theme).toBe("graphite");
  // The Code view hides the Style key and tray.
  fireEvent.click(screen.getByRole("button", { name: "Code" }));
  expect(screen.queryByRole("button", { name: "Style" })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Diagram style" })).not.toBeInTheDocument();
});

test("the full editor keeps studio fields and can change the theme", async () => {
  const onUpdateDiagram = vi.fn().mockResolvedValue(true);
  const placed = JSON.stringify({ ...JSON.parse(SOURCE), connector: "curved", edges: [{ from: "a", to: "c", bend: 20 }] });
  render(<Markdown content={`\`\`\`steward-diagram\n${placed}\n\`\`\``} onUpdateDiagram={onUpdateDiagram} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit diagram" });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Theme" }), { target: { value: "blueprint" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save diagram" }));
  await waitFor(() => expect(onUpdateDiagram).toHaveBeenCalledTimes(1));
  const saved = JSON.parse(onUpdateDiagram.mock.calls[0][1]);
  expect(saved).toMatchObject({ theme: "blueprint", connector: "curved" });
  expect(saved.edges[0].bend).toBe(20);
});
