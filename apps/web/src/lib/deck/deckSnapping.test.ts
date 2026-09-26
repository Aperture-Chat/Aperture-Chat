import { expect, test } from "vitest";
import { clampBoxToCanvas, snapMovedBox } from "./deckSnapping";

test("a dragged box snaps its center to the slide center and reports the guide", () => {
  const result = snapMovedBox({ x: 277, y: 100, w: 400, h: 80 }, []);
  expect(result.box.x).toBe(280);
  expect(result.guides.x).toEqual([480]);
  expect(result.guides.y).toEqual([]);
});

test("edges snap to other boxes on the slide", () => {
  const title = { x: 60, y: 38, w: 840, h: 64 };
  const result = snapMovedBox({ x: 64, y: 300, w: 300, h: 100 }, [title]);
  expect(result.box.x).toBe(60);
  expect(result.guides.x).toEqual([60]);
});

test("boxes far from any guide move freely and never leave the canvas", () => {
  const free = snapMovedBox({ x: 123, y: 211, w: 200, h: 50 }, []);
  expect(free.box).toEqual({ x: 123, y: 211, w: 200, h: 50 });
  expect(clampBoxToCanvas({ x: 900, y: -20, w: 200, h: 50 })).toEqual({ x: 760, y: 0, w: 200, h: 50 });
});
