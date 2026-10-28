import { expect, test } from "vitest";
import { parseStewardDiagram, type StewardDiagramModel } from "./stewardDiagram";
import {
  addStewardEdge,
  reconnectStewardEdge,
  removeStewardEdge,
  resetStewardLayout,
  reverseStewardEdge,
  snapStewardCardPosition,
  stewardCardAt,
  stewardHasManualLayout,
  withStewardCardColor,
  withStewardCardPosition,
  withStewardCardVariant,
  withStewardChartStyle,
  withStewardEdgeBend,
  withStewardEdgeKind,
} from "./stewardDiagramEdits";

function chart(): StewardDiagramModel {
  return parseStewardDiagram(
    JSON.stringify({
      rows: [[{ id: "a", title: "Alpha" }, { id: "b", title: "Bravo" }], [{ id: "c", title: "Charlie" }]],
      edges: [
        { from: "a", to: "c", label: "feeds", bend: 12 },
        { from: "b", to: "c", kind: "contingent" },
      ],
    }),
  )!;
}

test("dragging a card stores a rounded position and clearing returns it to its row", () => {
  const original = chart();
  const moved = withStewardCardPosition(original, "b", { x: 101.6, y: -7 });
  expect(moved.rows[0]![1]!.position).toEqual({ x: 102, y: 0 });
  expect(original.rows[0]![1]!.position).toBeUndefined();
  expect(withStewardCardPosition(moved, "b", null).rows[0]![1]!.position).toBeUndefined();
});

test("card color and variant edits touch only that card", () => {
  const colored = withStewardCardColor(chart(), "a", "violet");
  expect(colored.rows[0]![0]!.color).toBe("violet");
  expect(colored.rows[0]![1]!.color).toBeUndefined();
  expect(withStewardCardColor(colored, "a", null).rows[0]![0]!.color).toBeUndefined();
  expect(withStewardCardVariant(chart(), "c", "banner").rows[1]![0]!.variant).toBe("banner");
});

test("arrow edits: style, bend, reverse, delete", () => {
  expect(withStewardEdgeKind(chart(), 0, "inactive").edges[0]!.kind).toBe("inactive");
  expect(withStewardEdgeBend(chart(), 1, 30).edges[1]!.bend).toBe(30);
  expect(withStewardEdgeBend(chart(), 0, null).edges[0]!.bend).toBeUndefined();
  expect(withStewardEdgeBend(chart(), 0, 0).edges[0]!.bend).toBeUndefined();
  const reversed = reverseStewardEdge(chart(), 0);
  expect(reversed.edges[0]).toMatchObject({ from: "c", to: "a", label: "feeds" });
  expect(reversed.edges[0]!.bend).toBeUndefined();
  expect(removeStewardEdge(chart(), 0).edges.map((edge) => edge.from)).toEqual(["b"]);
});

test("reconnecting an arrow end moves it to another card, never onto its own other end", () => {
  const reconnected = reconnectStewardEdge(chart(), 0, "to", "b")!;
  expect(reconnected.edges[0]).toMatchObject({ from: "a", to: "b" });
  expect(reconnected.edges[0]!.bend).toBeUndefined();
  expect(reconnectStewardEdge(chart(), 0, "from", "b")!.edges[0]).toMatchObject({ from: "b", to: "c" });
  expect(reconnectStewardEdge(chart(), 0, "to", "a")).toBeNull();
  expect(reconnectStewardEdge(chart(), 0, "to", "missing")).toBeNull();
  expect(reconnectStewardEdge(chart(), 9, "to", "b")).toBeNull();
});

test("drawing a new arrow between two cards, once", () => {
  const added = addStewardEdge(chart(), "a", "b")!;
  expect(added.edges.at(-1)).toEqual({ from: "a", to: "b", kind: "primary" });
  expect(addStewardEdge(added, "a", "b")).toBeNull();
  expect(addStewardEdge(chart(), "a", "a")).toBeNull();
  expect(addStewardEdge(chart(), "a", "nowhere")).toBeNull();
});

test("chart style: defaults clear the field so the source stays as the model wrote it", () => {
  const styled = withStewardChartStyle(chart(), { theme: "ember", connector: "curved", corners: "square" });
  expect(styled).toMatchObject({ theme: "ember", connector: "curved", corners: "square" });
  const back = withStewardChartStyle(styled, { theme: "aperture", connector: "elbow", corners: "rounded" });
  expect("theme" in back || "connector" in back || "corners" in back).toBe(false);
  expect(withStewardChartStyle(styled, { connector: "straight" })).toMatchObject({ theme: "ember", connector: "straight" });
});

test("reset layout clears every dragged position and arrow bend", () => {
  const messy = withStewardCardPosition(chart(), "a", { x: 300, y: 300 });
  expect(stewardHasManualLayout(chart())).toBe(true);
  expect(stewardHasManualLayout(messy)).toBe(true);
  const clean = resetStewardLayout(messy);
  expect(stewardHasManualLayout(clean)).toBe(false);
  expect(clean.rows[0]![0]!.position).toBeUndefined();
  expect(clean.edges[0]!.bend).toBeUndefined();
  expect(clean.edges[0]!.label).toBe("feeds");
});

const others = [
  { id: "x", x: 100, y: 100, width: 200, height: 80 },
  { id: "y", x: 500, y: 300, width: 160, height: 120 },
];

test("snapping aligns a dragged card's edges and centers with its neighbors", () => {
  const snapped = snapStewardCardPosition({ x: 103, y: 252 }, { width: 200, height: 60 }, others);
  expect(snapped.x).toBe(100);
  expect(snapped.guides).toContainEqual({ axis: "x", at: 100, from: 100, to: 316 });
  // Center line: 500 + 80 = 580 → a 100-wide card centered there starts at 530.
  const centered = snapStewardCardPosition({ x: 527, y: 20 }, { width: 100, height: 40 }, others);
  expect(centered.x).toBe(530);
});

test("without a neighbor nearby, positions snap to the 8-unit grid", () => {
  const snapped = snapStewardCardPosition({ x: 37, y: 613 }, { width: 50, height: 50 }, others);
  expect(snapped).toEqual({ x: 40, y: 616, guides: [] });
  // A whole card box may stand in for its size; its old x/y never leak back.
  const fromBox = snapStewardCardPosition({ x: 37, y: 613 }, { id: "z", x: 900, y: 900, width: 50, height: 50 }, others);
  expect(fromBox).toEqual({ x: 40, y: 616, guides: [] });
});

test("hit testing finds the top-most card under a point", () => {
  const boxes = [
    { id: "back", x: 0, y: 0, width: 100, height: 100 },
    { id: "front", x: 50, y: 50, width: 100, height: 100 },
  ];
  expect(stewardCardAt(boxes, { x: 60, y: 60 })).toBe("front");
  expect(stewardCardAt(boxes, { x: 60, y: 60 }, "front")).toBe("back");
  expect(stewardCardAt(boxes, { x: 400, y: 10 })).toBeNull();
});
