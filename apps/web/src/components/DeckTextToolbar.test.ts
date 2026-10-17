import { expect, test } from "vitest";
import { placeDeckTextToolbar } from "./DeckTextToolbar";

const viewport = { width: 1440, height: 900 };
const size = { width: 420, height: 40 };
const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

test("the toolbar sits just above its text box when that is free", () => {
  expect(placeDeckTextToolbar(box(700, 500, 1000, 560), size, viewport)).toEqual({ top: 450, left: 640, below: false });
});

test("it moves below the box rather than cover the slide title above", () => {
  const body = box(700, 500, 1360, 760);
  const title = box(700, 420, 1100, 470);
  expect(placeDeckTextToolbar(body, size, viewport, [title])).toEqual({ top: 770, left: 820, below: true });
});

test("with no free spot beside the box it sits just outside the slide", () => {
  const body = box(700, 400, 1360, 860);
  const title = box(700, 330, 1100, 380);
  const frame = box(660, 300, 1400, 880);
  expect(placeDeckTextToolbar(body, size, viewport, [title], frame)).toEqual({ top: 250, left: 820, below: false });
});

test("it stays inside the window", () => {
  const placed = placeDeckTextToolbar(box(0, 10, 100, 40), size, { width: 390, height: 844 });
  expect(placed.left).toBe(8);
  expect(placed.top).toBe(50);
  expect(placed.below).toBe(true);
});
