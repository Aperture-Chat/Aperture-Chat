import { describe, expect, it } from "vitest";
import { ADMIN_FOCUS_REGIONS, ADMIN_TRAINING_VIDEOS } from "./trainingDecks/admin";
import { OWNER_FOCUS_REGIONS } from "./trainingDecks/owner";
import { layoutForRect, TRAINING_HEIGHT, TRAINING_WIDTH, type FocusRect } from "./trainingVideoKit";

/* Card placement mirror of the .training-title-card CSS, expanded a touch so
 * the root-inset arrow start always counts as "under the card". */
const CARD_BOUNDS = {
  "upper-left": { x: 292, y: 112, w: 470, h: 200 },
  "upper-right": { x: TRAINING_WIDTH - 68 - 470, y: 112, w: 470, h: 200 },
  "lower-left": { x: 292, y: TRAINING_HEIGHT - 96 - 200, w: 740, h: 200 },
  "lower-right": { x: TRAINING_WIDTH - 72 - 520, y: TRAINING_HEIGHT - 96 - 200, w: 520, h: 200 },
} as const;

function insideRect(point: { x: number; y: number }, rect: FocusRect, pad = 0): boolean {
  return (
    point.x >= rect.x - pad &&
    point.x <= rect.x + rect.w + pad &&
    point.y >= rect.y - pad &&
    point.y <= rect.y + rect.h + pad
  );
}

const QUADRANT_CASES: Array<{ name: string; rect: FocusRect; placement: keyof typeof CARD_BOUNDS }> = [
  { name: "target upper-left", rect: { x: 60, y: 60, w: 180, h: 40 }, placement: "lower-right" },
  { name: "target upper-right", rect: { x: 940, y: 60, w: 180, h: 40 }, placement: "lower-left" },
  { name: "target lower-left", rect: { x: 60, y: 700, w: 180, h: 40 }, placement: "upper-right" },
  { name: "target lower-right", rect: { x: 940, y: 700, w: 180, h: 40 }, placement: "upper-left" },
];

describe("layoutForRect", () => {
  for (const { name, rect, placement } of QUADRANT_CASES) {
    it(`${name}: card sits opposite and the arrow lands aimed at the rect`, () => {
      const layout = layoutForRect(rect);
      expect(layout.placement).toBe(placement);
      expect(layout.arrowStart).not.toBeNull();
      expect(layout.arrowEnd).not.toBeNull();
      expect(layout.arrowAim).not.toBeNull();

      const start = layout.arrowStart!;
      const end = layout.arrowEnd!;
      const aim = layout.arrowAim!;

      // The root hides under the callout card.
      expect(insideRect(start, CARD_BOUNDS[placement])).toBe(true);

      // The tip stops just outside the highlight: never inside, never far.
      expect(insideRect(end, rect)).toBe(false);
      expect(insideRect(end, rect, 15)).toBe(true);

      // The head points at the rect center as a unit vector.
      expect(Math.hypot(aim.x, aim.y)).toBeCloseTo(1, 5);
      const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      const toCenter = Math.hypot(center.x - end.x, center.y - end.y);
      const along = { x: end.x + aim.x * toCenter, y: end.y + aim.y * toCenter };
      expect(along.x).toBeCloseTo(center.x, 4);
      expect(along.y).toBeCloseTo(center.y, 4);

      // Everything stays on the canvas.
      for (const point of [start, end]) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(TRAINING_WIDTH);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(TRAINING_HEIGHT);
      }
    });
  }

  it("skips the arrow when the focus rect covers most of the screen", () => {
    const layout = layoutForRect({ x: 268, y: 100, w: 876, h: 600 });
    expect(layout.arrowStart).toBeNull();
    expect(layout.arrowEnd).toBeNull();
  });

  it("keeps every close-up policy outline inside the readable console viewport", () => {
    const ownerRegions = [
      OWNER_FOCUS_REGIONS.policyCollapsed,
      OWNER_FOCUS_REGIONS.policyFloor,
      OWNER_FOCUS_REGIONS.policyToggles,
      OWNER_FOCUS_REGIONS.budgetControls,
      OWNER_FOCUS_REGIONS.policyCallout,
    ];
    const adminRegions = [
      ADMIN_FOCUS_REGIONS.policyCollapsed,
      ADMIN_FOCUS_REGIONS.policyServiceAvailability,
      ADMIN_FOCUS_REGIONS.policyDefaults,
      ADMIN_FOCUS_REGIONS.policyMemory,
      ADMIN_FOCUS_REGIONS.policyCounts,
    ];

    for (const { rect } of ownerRegions) {
      expect(rect.x).toBeGreaterThanOrEqual(370);
      expect(rect.x + rect.w + 8).toBeLessThanOrEqual(1155);
      expect(rect.y).toBeGreaterThanOrEqual(130);
      expect(rect.y + rect.h + 8).toBeLessThanOrEqual(840);
      expect(rect.w).toBeLessThanOrEqual(780);
      expect(rect.h).toBeLessThanOrEqual(600);
    }

    for (const { rect, zoom } of adminRegions) {
      expect(zoom).toBeUndefined();
      expect(rect.x).toBeGreaterThanOrEqual(260);
      expect(rect.x + rect.w + 8).toBeLessThanOrEqual(1155);
      expect(rect.y).toBeGreaterThanOrEqual(130);
      expect(rect.y + rect.h + 8).toBeLessThanOrEqual(840);
      expect(rect.w).toBeLessThanOrEqual(900);
      expect(rect.h).toBeLessThanOrEqual(600);
    }
  });

  it("can reserve the left rail for narration beside a close-up console target", () => {
    const rect = OWNER_FOCUS_REGIONS.policyToggles.rect;
    const layout = layoutForRect(rect, "left-rail");

    expect(layout.placement).toBe("left-rail");
    expect(rect.x).toBeGreaterThan(270);
    expect(layout.arrowStart).not.toBeNull();
    expect(layout.arrowEnd).not.toBeNull();
    expect(layout.arrowStart!.x).toBeLessThan(rect.x);
    expect(layout.arrowEnd!.x).toBeLessThan(rect.x);
  });

  it("keeps the hidden service-operator role out of every admin video surface", () => {
    expect(JSON.stringify(ADMIN_TRAINING_VIDEOS)).not.toMatch(/platform[- ]owner|owner[- ]only|owner ceiling|owner boundary/i);
  });

  it("skips the arrow when the focus rect sits right next to the card", () => {
    // Just above the lower-left card: too close for a readable arrow.
    const layout = layoutForRect({ x: 320, y: 560, w: 400, h: 60 });
    if (layout.arrowStart && layout.arrowEnd) {
      const length = Math.hypot(
        layout.arrowEnd.x - layout.arrowStart.x,
        layout.arrowEnd.y - layout.arrowStart.y,
      );
      expect(length).toBeGreaterThanOrEqual(64);
    } else {
      expect(layout.arrowStart).toBeNull();
    }
  });

  it("keeps the caption clear of low targets under an upper card", () => {
    const layout = layoutForRect({ x: 80, y: 640, w: 300, h: 120 });
    expect(layout.placement).toBe("upper-right");
    expect(layout.caption).toBe("top");
  });
});
