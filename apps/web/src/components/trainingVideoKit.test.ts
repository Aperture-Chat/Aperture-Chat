import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_FOCUS_REGIONS, ADMIN_TRAINING_VIDEOS } from "./trainingDecks/admin";
import { OWNER_FOCUS_REGIONS } from "./trainingDecks/owner";
import { USER_FOCUS_REGIONS } from "./trainingDecks/user";
import { layoutForRect, TrainingComposition, TRAINING_HEIGHT, TRAINING_WIDTH, TRAINING_LEFT_RAIL_CARD, type FocusRect, type FocusRegion, type TrainingVideoBase } from "./trainingVideoKit";

const playback = vi.hoisted(() => ({ frame: 30 }));
vi.mock("remotion", async (importOriginal) => {
  const original = await importOriginal<typeof import("remotion")>();
  const { createElement } = await import("react");
  return {
    ...original,
    useCurrentFrame: () => playback.frame,
    useVideoConfig: () => ({ fps: 30 }),
    AbsoluteFill: ({ children, ...props }: import("react").HTMLAttributes<HTMLDivElement>) => createElement("div", props, children),
    Img: (props: import("react").ImgHTMLAttributes<HTMLImageElement>) => createElement("img", props),
    Audio: () => null,
    Sequence: ({ children }: { children: import("react").ReactNode }) => children,
    staticFile: (file: string) => file,
  };
});

describe("recorded image fit", () => {
  const video: TrainingVideoBase = {
    id: "fit-regression", title: "Image fit", description: "", outcomes: [],
    scenes: [
      { title: "Portrait", caption: "", narration: "", durationSeconds: 2, focus: "portrait" },
      { title: "Desktop", caption: "", narration: "", durationSeconds: 2, focus: "desktop" },
    ],
  };

  it("aligns normalized phone focus to the centered contained image without stretching or double scaling", () => {
    playback.frame = 30;
    // A 390 × 844 CSS viewport captured at 2x produces a 780 × 1688 image.
    // Its menu occupies x=20,y=242,w=350,h=359 in the source viewport.
    const scale = TRAINING_HEIGHT / 844;
    const imageLeft = (TRAINING_WIDTH - 390 * scale) / 2;
    const rect = { x: imageLeft + 20 * scale, y: 242 * scale, w: 350 * scale, h: 359 * scale };
    const regions: Record<string, FocusRegion> = {
      portrait: { frame: "phone.png", rect, fit: "contain" },
      desktop: { frame: "desktop.png", rect: { x: 300, y: 300, w: 300, h: 100 } },
    };
    const { container } = render(createElement(TrainingComposition, { video, regions, badge: "Guide" }));
    const image = container.querySelector<HTMLImageElement>(".training-recorded-image")!;
    expect(image.style.objectFit).toBe("contain");
    expect(image.style.objectPosition).toBe("center");
    expect(image.style.transform).toBe("scale(1)");
    const highlight = container.querySelector<HTMLDivElement>(".training-highlight")!;
    const left = Number.parseFloat(highlight.style.left);
    const top = Number.parseFloat(highlight.style.top);
    const width = Number.parseFloat(highlight.style.width);
    const height = Number.parseFloat(highlight.style.height);
    expect(imageLeft).toBeCloseTo(394.95853, 5);
    expect((left - imageLeft) / scale).toBeCloseTo(20, 5);
    expect(top / scale).toBeCloseTo(242, 5);
    expect(width / scale).toBeCloseTo(350, 5);
    expect(height / scale).toBeCloseTo(359, 5);
    expect(left + width).toBeLessThan(imageLeft + 390 * scale);
    expect(USER_FOCUS_REGIONS.mobileNavigation.fit).toBe("contain");
    expect(USER_FOCUS_REGIONS.mobileInstall.fit).toBe("contain");
  });

  it("keeps desktop fill and zoom while retaining portrait containment during a crossfade", () => {
    playback.frame = 61;
    const desktopRect = { x: 300, y: 300, w: 300, h: 100 };
    const regions: Record<string, FocusRegion> = {
      portrait: { frame: "phone.png", rect: { x: 400, y: 20, w: 300, h: 200 }, fit: "contain" },
      desktop: { frame: "desktop.png", rect: desktopRect, zoom: 4 / 3 },
    };
    const { container } = render(createElement(TrainingComposition, { video, regions, badge: "Guide" }));
    const images = container.querySelectorAll<HTMLImageElement>(".training-recorded-image");
    expect(images).toHaveLength(2);
    expect(images[0].style.objectFit).toBe("contain");
    expect(images[1].style.objectFit).toBe("fill");
    expect(images[1].style.transform).toBe(`scale(${4 / 3})`);
    const highlight = container.querySelector<HTMLDivElement>(".training-highlight")!;
    expect(highlight.style.left).toBe("300px");
    expect(highlight.style.top).toBe("300px");
    expect(highlight.style.width).toBe("300px");
    expect(highlight.style.height).toBe("100px");
  });

  it("keeps a long policy callout in the sidebar beside an unzoomed console panel", () => {
    playback.frame = 30;
    const policyVideo: TrainingVideoBase = {
      ...video,
      scenes: [{
        title: "Owner-managed shared connectors", durationSeconds: 10,
        caption: "Org Settings → Connectors is the owner-only home for shared configuration, credentials, connection tests, and workspace authorization.",
        narration: "", focus: "policy", calloutPlacement: "left-rail",
      }],
    };
    const rect = { x: 261, y: 0, w: 889, h: 855 };
    const { container } = render(createElement(TrainingComposition, {
      video: policyVideo, badge: "Owner guide", regions: { policy: { frame: "policy.png", rect } },
    }));
    const card = container.querySelector<HTMLDivElement>(".training-title-card")!;
    expect(card.style.left).toBe(`${TRAINING_LEFT_RAIL_CARD.x}px`);
    expect(card.style.width).toBe(`${TRAINING_LEFT_RAIL_CARD.w}px`);
    expect(Number.parseFloat(card.style.left) + Number.parseFloat(card.style.width) + 14).toBeLessThan(rect.x);
    expect(card.textContent).toContain("workspace authorization");
  });
});

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
    ];
    const adminRegions = [
      ADMIN_FOCUS_REGIONS.policyCollapsed,
      ADMIN_FOCUS_REGIONS.policyServiceAvailability,
      ADMIN_FOCUS_REGIONS.policyDefaults,
      ADMIN_FOCUS_REGIONS.policyMemory,
      ADMIN_FOCUS_REGIONS.policyCounts,
    ];

    for (const { rect, zoom } of ownerRegions) {
      expect(zoom).toBeUndefined();
      expect(rect.x).toBeGreaterThanOrEqual(260);
      expect(rect.x + rect.w).toBeLessThanOrEqual(TRAINING_WIDTH);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.h).toBeLessThanOrEqual(TRAINING_HEIGHT);
      expect(rect.w).toBeLessThanOrEqual(900);
      expect(rect.h).toBeLessThanOrEqual(600);
    }

    // Shared connector controls use the full unzoomed capture; the visible
    // part of a tall scrolled panel must remain inside the composition.
    const connectors = OWNER_FOCUS_REGIONS.sharedConnectors;
    expect(connectors.zoom).toBeUndefined();
    expect(connectors.rect.x).toBeGreaterThanOrEqual(0);
    expect(connectors.rect.y).toBeGreaterThanOrEqual(0);
    expect(connectors.rect.x + connectors.rect.w).toBeLessThanOrEqual(TRAINING_WIDTH);
    expect(connectors.rect.y + connectors.rect.h).toBeLessThanOrEqual(TRAINING_HEIGHT);

    for (const { rect, zoom } of adminRegions) {
      expect(zoom).toBeUndefined();
      expect(rect.x).toBeGreaterThanOrEqual(260);
      expect(rect.x + rect.w).toBeLessThanOrEqual(TRAINING_WIDTH);
      // Expanded policy controls have their own scrolled capture. Its top
      // need not retain the console header, but every outline must stay in
      // the actual composition instead of extending below a stale crop.
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.h).toBeLessThanOrEqual(TRAINING_HEIGHT);
      expect(rect.w).toBeLessThanOrEqual(900);
      expect(rect.h).toBeLessThanOrEqual(600);
    }
  });

  it("reserves the left rail for narration and omits a stub arrow beside a nearby panel", () => {
    const rect = OWNER_FOCUS_REGIONS.policyToggles.rect;
    const layout = layoutForRect(rect, "left-rail");

    expect(layout.placement).toBe("left-rail");
    expect(rect.x).toBeGreaterThan(TRAINING_LEFT_RAIL_CARD.x + TRAINING_LEFT_RAIL_CARD.w + 14);
    if (layout.arrowStart && layout.arrowEnd) {
      expect(layout.arrowStart.x).toBeLessThan(rect.x);
      expect(layout.arrowEnd.x).toBeLessThan(rect.x);
      expect(Math.hypot(layout.arrowEnd.x - layout.arrowStart.x, layout.arrowEnd.y - layout.arrowStart.y)).toBeGreaterThanOrEqual(64);
    } else {
      expect(layout.arrowStart).toBeNull();
      expect(layout.arrowEnd).toBeNull();
    }
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
