import { expect, test } from "vitest";
import { computeStewardDiagramLayout, parseStewardDiagram, type StewardDiagramModel } from "../lib/stewardDiagram";
import {
  advanceDrag,
  bendDrag,
  canvasKeyAction,
  cardDrag,
  clampToCanvas,
  connectDrag,
  designPoint,
  dragResult,
  endpointDrag,
  previewModel,
  selectionExists,
  withoutSelection,
} from "./stewardCanvasGestures";
import { textEditorGeometry } from "./StewardDiagramLayers";
import { measureCanvas } from "./StewardDiagramCanvas";

const model: StewardDiagramModel = parseStewardDiagram(
  JSON.stringify({
    rows: [[{ id: "a", title: "Alpha" }, { id: "b", title: "Bravo" }], [{ id: "c", title: "Charlie" }]],
    edges: [{ from: "a", to: "c", label: "feeds" }],
  }),
)!;
const layout = computeStewardDiagramLayout(model, false);
const box = (id: string) => layout.cardBoxes.find((item) => item.id === id)!;
const edgePath = layout.paths.find((path) => path.edgeIndex === 0)!;
const keys = { metaKey: false, ctrlKey: false, shiftKey: false };

test("pointer positions convert to design units through the rendered scale", () => {
  const svg = { getBoundingClientRect: () => ({ left: 10, top: 20 }) } as SVGSVGElement;
  expect(designPoint(svg, 2, { clientX: 110, clientY: 60 })).toEqual({ x: 50, y: 20 });
  expect(designPoint(null, 0, { clientX: 7, clientY: 9 })).toEqual({ x: 7, y: 9 });
});

test("a card drag waits for real movement, then snaps and stays on the canvas", () => {
  const start = cardDrag(1, box("b"), { x: 400, y: 90 });
  expect(advanceDrag(start, { x: 401, y: 91 }, layout, 1)).toBe(start);
  const far = advanceDrag(start, { x: 5000, y: -400 }, layout, 1);
  expect(far).toMatchObject({ moved: true, at: { x: layout.width - box("b").width - 4, y: layout.contentTop } });
  expect(clampToCanvas({ x: -50, y: 0 }, box("a"), layout)).toEqual({ x: 4, y: layout.contentTop });
  expect(previewModel(model, far, null).rows[0]![1]!.position).toBeDefined();
  expect(dragResult(start, { x: 0, y: 0 }, model, layout)).toBeNull();
  expect(dragResult(far, { x: 0, y: 0 }, model, layout)!.rows[0]![1]!.position).toBeDefined();
});

test("bend, endpoint, and connect gestures only start from real arrows and boxes", () => {
  const bend = bendDrag(1, edgePath, model)!;
  expect(bend).toMatchObject({ kind: "bend", index: 0, bend: 0, moved: false });
  expect(bendDrag(1, { ...edgePath, handle: undefined }, model)).toBeNull();
  expect(dragResult(bend, { x: 0, y: 0 }, model, layout)).toBeNull();
  const bent = advanceDrag(bend, { x: edgePath.handle!.x, y: edgePath.handle!.y + 12 }, layout, 1);
  expect(previewModel(model, bent, null).edges[0]!.bend).toBe(12);

  const toEnd = endpointDrag(1, edgePath, "to", model, { x: 0, y: 0 })!;
  expect(toEnd).toMatchObject({ end: "to", skipId: "a", anchor: { x: edgePath.ends!.from[0], y: edgePath.ends!.from[1] } });
  const fromEnd = endpointDrag(1, edgePath, "from", model, { x: 0, y: 0 })!;
  expect(fromEnd).toMatchObject({ end: "from", skipId: "c" });
  expect(endpointDrag(1, { ...edgePath, ends: undefined }, "to", model, { x: 0, y: 0 })).toBeNull();
  expect(endpointDrag(1, { ...edgePath, edgeIndex: undefined }, "to", model, { x: 0, y: 0 })).toBeNull();
  const center = { x: box("b").x + 10, y: box("b").y + 10 };
  expect(dragResult(advanceDrag(toEnd, center, layout, 1), center, model, layout)!.edges[0]!.to).toBe("b");
  expect(dragResult(toEnd, { x: -100, y: -100 }, model, layout)).toBeNull();

  const connect = connectDrag(1, "b", { x: 0, y: 0 }, { x: 0, y: 0 });
  const onC = { x: box("c").x + 5, y: box("c").y + 5 };
  expect(dragResult(advanceDrag(connect, onC, layout, 1), onC, model, layout)!.edges.at(-1)).toMatchObject({ from: "b", to: "c" });
});

test("keys map to canvas actions only when they mean something", () => {
  expect(canvasKeyAction({ ...keys, key: "z", metaKey: true }, null)).toEqual({ type: "undo" });
  expect(canvasKeyAction({ ...keys, key: "Z", ctrlKey: true, shiftKey: true }, null)).toEqual({ type: "redo" });
  expect(canvasKeyAction({ ...keys, key: "y", ctrlKey: true }, null)).toEqual({ type: "redo" });
  expect(canvasKeyAction({ ...keys, key: "c", metaKey: true }, null)).toBeNull();
  expect(canvasKeyAction({ ...keys, key: "Escape" }, null)).toEqual({ type: "deselect" });
  expect(canvasKeyAction({ ...keys, key: "Delete" }, null)).toBeNull();
  expect(canvasKeyAction({ ...keys, key: "Backspace" }, { kind: "edge", index: 0 })).toEqual({ type: "delete" });
  expect(canvasKeyAction({ ...keys, key: "ArrowLeft" }, { kind: "edge", index: 0 })).toBeNull();
  expect(canvasKeyAction({ ...keys, key: "ArrowUp", shiftKey: true }, { kind: "card", id: "a" })).toEqual({
    type: "nudge",
    delta: { x: 0, y: -1 },
    step: 10,
  });
  expect(canvasKeyAction({ ...keys, key: "a" }, { kind: "card", id: "a" })).toBeNull();
});

test("selections are checked against the model and removed cleanly", () => {
  expect(selectionExists(model, null)).toBe(true);
  expect(selectionExists(model, { kind: "card", id: "c" })).toBe(true);
  expect(selectionExists(model, { kind: "card", id: "zz" })).toBe(false);
  expect(selectionExists(model, { kind: "edge", index: 3 })).toBe(false);
  expect(withoutSelection(model, { kind: "edge", index: 0 }).edges).toEqual([]);
  expect(withoutSelection(model, { kind: "card", id: "a" }).edges).toEqual([]);
});

test("the inline editor covers the text it edits", () => {
  const origin = { x: 18, y: 20 };
  const title = layout.texts.find((el) => el.fieldRef?.scope === "card" && el.cardId === "a")!;
  const inBox = textEditorGeometry({ el: title, box: box("a"), path: null, layoutWidth: layout.width, origin, scale: 2 });
  expect(inBox).toMatchObject({ left: 18 + (box("a").x + 10) * 2, width: (box("a").width - 20) * 2, top: 20 + (title.y - 3) * 2 });
  const label = layout.texts.find((el) => el.edgeIndex === 0)!;
  expect(textEditorGeometry({ el: label, box: null, path: null, layoutWidth: layout.width, origin, scale: 1 })).toMatchObject({
    left: 18 + label.x - 100,
    width: 200,
  });
  const fresh = textEditorGeometry({ el: null, box: null, path: edgePath, layoutWidth: layout.width, origin, scale: 1 });
  expect(fresh).toMatchObject({ left: 18 + edgePath.handle!.x - 90, width: 180, fontSize: 11 });
  const noHandle = textEditorGeometry({ el: null, box: null, path: { ...edgePath, handle: undefined }, layoutWidth: 600, origin, scale: 1 });
  expect(noHandle.left).toBe(18 + edgePath.ends!.from[0] - 90);
  expect(textEditorGeometry({ el: null, box: null, path: null, layoutWidth: 600, origin, scale: 1 }).left).toBe(18 - 90);
  const chartText = { ...title, x: 30, anchor: undefined, edgeIndex: undefined };
  expect(textEditorGeometry({ el: chartText, box: null, path: null, layoutWidth: 640, origin, scale: 1 })).toMatchObject({ left: 48, width: 580 });
});

test("canvas measuring finds the SVG's scale and offset inside its scroller", () => {
  const node = {
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 800 }) as DOMRect,
    clientWidth: 780,
    clientLeft: 1,
    clientTop: 1,
    scrollLeft: 10,
    scrollTop: 0,
  };
  const svg = { getBoundingClientRect: () => ({ left: 140, top: 80, width: 640 }) as DOMRect };
  expect(measureCanvas(node, svg, 320)).toEqual({ scale: 2, origin: { x: 49, y: 29 }, width: 780 });
  expect(measureCanvas({ ...node, clientWidth: 100 }, null, 100).width).toBe(320);
  expect(measureCanvas({ ...node, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0 }) as DOMRect }, null, 390).scale).toBe(2);
});
