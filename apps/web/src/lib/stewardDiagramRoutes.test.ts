import { expect, test } from "vitest";
import {
  clippedCenterLine,
  drawEdgeRoute,
  elbowPath,
  freeEdgeSkeleton,
  stewardBendFromPointer,
  type RouteBox,
} from "./stewardDiagramRoutes";

const box = (x: number, y: number, width = 100, height = 60): RouteBox => ({ x, y, width, height, headerHeight: 20 });

test("a box above its target leaves from the bottom and enters the top", () => {
  const skeleton = freeEdgeSkeleton(box(0, 0), box(300, 200), 0);
  expect(skeleton.axis).toBe("y");
  expect(skeleton.points).toEqual([[50, 60], [50, 128], [350, 128], [350, 196]]);
});

test("a box below its target leaves from the top and enters the bottom, bend shifting the run", () => {
  const skeleton = freeEdgeSkeleton(box(300, 200), box(0, 0), 10);
  expect(skeleton.points).toEqual([[350, 200], [350, 142], [50, 142], [50, 64]]);
});

test("vertically aligned boxes join with one straight run", () => {
  const skeleton = freeEdgeSkeleton(box(0, 0), box(0, 200), 30);
  expect(skeleton.points).toEqual([[50, 60], [50, 196]]);
  expect(skeleton.axis).toBeUndefined();
  expect(skeleton.label).toEqual([50, 115]);
});

test("side-by-side boxes join through facing sides at header height", () => {
  const rightward = freeEdgeSkeleton(box(0, 0), box(300, 40), 0);
  expect(rightward.axis).toBe("x");
  expect(rightward.points).toEqual([[100, 10], [198, 10], [198, 50], [296, 50]]);
  const leftward = freeEdgeSkeleton(box(300, 40), box(0, 0), -8);
  expect(leftward.points).toEqual([[300, 50], [194, 50], [194, 10], [104, 10]]);
  const level = freeEdgeSkeleton(box(0, 0), box(300, 0), 0);
  expect(level.points).toEqual([[100, 10], [296, 10]]);
  expect(level.label).toEqual([198, -6]);
});

test("overlapping boxes fall back to a clipped center line", () => {
  const skeleton = freeEdgeSkeleton(box(0, 0), box(50, 20), 0);
  expect(skeleton.points).toEqual(clippedCenterLine(box(0, 0), box(50, 20)));
  expect(skeleton.axis).toBeUndefined();
});

test("center lines stop at both borders, short of the target for the arrowhead", () => {
  const [start, end] = clippedCenterLine(box(0, 0), box(300, 0));
  expect(start).toEqual([100, 30]);
  expect(end).toEqual([296, 30]);
  // Concentric boxes cannot be clipped apart; the segment stays as found.
  const [a, b] = clippedCenterLine(box(0, 0), box(0, 0));
  expect(a).toEqual(b);
});

test("elbow and curved routes expose a handle that maps back to the bend", () => {
  const from = box(0, 0);
  const to = box(300, 200);
  for (const connector of ["elbow", "curved"] as const) {
    for (const bend of [0, 24, -18]) {
      const route = drawEdgeRoute(freeEdgeSkeleton(from, to, bend), connector, from, to, bend);
      expect(stewardBendFromPointer(route.handle!, route.handle!)).toBe(bend);
      expect(route.label).toEqual([route.handle!.x, route.handle!.y - 13]);
    }
  }
  const sideways = drawEdgeRoute(freeEdgeSkeleton(from, box(300, 40), 0), "elbow", from, box(300, 40), 0);
  expect(sideways.handle!.axis).toBe("x");
  expect(sideways.label).toEqual([sideways.handle!.x, sideways.handle!.y - 7]);
});

test("two-point routes draw a line with their own label and no handle", () => {
  const route = drawEdgeRoute({ points: [[0, 0], [0, 80]] }, "curved", box(0, 0), box(0, 100), 0);
  expect(route.d).toBe("M 0 0 L 0 80");
  expect(route.handle).toBeUndefined();
  expect(route.label).toEqual([0, 33]);
  expect(route.ends).toEqual({ from: [0, 0], to: [0, 80] });
});

test("elbows round their corners but never past half a short leg", () => {
  expect(elbowPath([[0, 0], [0, 40], [40, 40]])).toBe("M 0 0 L 0 31 Q 0 40 9 40 L 40 40");
  expect(elbowPath([[0, 0], [0, 1], [40, 1]])).toBe("M 0 0 L 0 1 L 40 1");
});
