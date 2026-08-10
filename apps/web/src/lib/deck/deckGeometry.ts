/** Shared slide geometry for deck mode.
 *
 * One table drives BOTH the on-screen slide stage and the PPTX export: boxes
 * are authored in preview pixels on a 960x540 canvas, and the exporter
 * multiplies by EMU_PER_PREVIEW_PX (960px ↔ 12192000 EMU exactly, so
 * 1px ↔ 12700 EMU ↔ 1pt at 96dpi/72pt parity). The export mirrors the screen
 * by construction — same principle as PREVIEW_CONTENT_WIDTH_PX in docxExport.
 */

import type { DeckSlide, DeckSlideLayout } from "./deckModel";

export const DECK_PREVIEW_WIDTH_PX = 960;
export const DECK_PREVIEW_HEIGHT_PX = 540;
export const DECK_SLIDE_WIDTH_EMU = 12_192_000;
export const DECK_SLIDE_HEIGHT_EMU = 6_858_000;
export const EMU_PER_PREVIEW_PX = DECK_SLIDE_WIDTH_EMU / DECK_PREVIEW_WIDTH_PX; // 12700

/** Box in preview pixels on the 960x540 canvas. */
export type DeckBox = { x: number; y: number; w: number; h: number };

export type DeckColorRole = "heading" | "body" | "accent1" | "accent2" | "background" | "surface";

export type DeckTextRegionSpec = {
  box: DeckBox;
  sizePt: number;
  bold?: boolean;
  italic?: boolean;
  align: "left" | "center";
  colorRole: Extract<DeckColorRole, "heading" | "body" | "accent1">;
  font: "major" | "minor";
  /** Vertical anchor within the box. */
  anchor: "top" | "middle";
};

export type DeckDecorationSpec = { box: DeckBox; colorRole: DeckColorRole };

/** Bottom-right logo slot, drawn identically on screen and in the export. */
export const DECK_LOGO_BOX: DeckBox = { x: 844, y: 494, w: 86, h: 30 };

const HEADING_BAND: DeckBox = { x: 60, y: 38, w: 840, h: 64 };

type LayoutGeometry = {
  text: Record<string, DeckTextRegionSpec>;
  decorations: DeckDecorationSpec[];
};

const LAYOUT_GEOMETRY: Record<DeckSlideLayout, LayoutGeometry> = {
  title: {
    text: {
      title: {
        box: { x: 80, y: 178, w: 800, h: 122 },
        sizePt: 40,
        bold: true,
        align: "center",
        colorRole: "heading",
        font: "major",
        anchor: "middle",
      },
      subtitle: {
        box: { x: 140, y: 330, w: 680, h: 64 },
        sizePt: 18,
        align: "center",
        colorRole: "body",
        font: "minor",
        anchor: "top",
      },
    },
    decorations: [{ box: { x: 430, y: 312, w: 100, h: 5 }, colorRole: "accent1" }],
  },
  section: {
    text: {
      title: {
        box: { x: 80, y: 226, w: 800, h: 92 },
        sizePt: 32,
        bold: true,
        align: "left",
        colorRole: "heading",
        font: "major",
        anchor: "middle",
      },
      subtitle: {
        box: { x: 80, y: 330, w: 720, h: 54 },
        sizePt: 16,
        align: "left",
        colorRole: "body",
        font: "minor",
        anchor: "top",
      },
    },
    decorations: [{ box: { x: 80, y: 204, w: 120, h: 6 }, colorRole: "accent1" }],
  },
  "title-bullets": {
    text: {
      title: {
        box: HEADING_BAND,
        sizePt: 26,
        bold: true,
        align: "left",
        colorRole: "heading",
        font: "major",
        anchor: "middle",
      },
      bullets: {
        box: { x: 60, y: 126, w: 840, h: 356 },
        sizePt: 16,
        align: "left",
        colorRole: "body",
        font: "minor",
        anchor: "top",
      },
    },
    decorations: [{ box: { x: 60, y: 108, w: 840, h: 2 }, colorRole: "surface" }],
  },
  "two-column": {
    text: {
      title: {
        box: HEADING_BAND,
        sizePt: 26,
        bold: true,
        align: "left",
        colorRole: "heading",
        font: "major",
        anchor: "middle",
      },
      left: {
        box: { x: 60, y: 126, w: 408, h: 356 },
        sizePt: 15,
        align: "left",
        colorRole: "body",
        font: "minor",
        anchor: "top",
      },
      right: {
        box: { x: 492, y: 126, w: 408, h: 356 },
        sizePt: 15,
        align: "left",
        colorRole: "body",
        font: "minor",
        anchor: "top",
      },
    },
    decorations: [{ box: { x: 60, y: 108, w: 840, h: 2 }, colorRole: "surface" }],
  },
  quote: {
    text: {
      quote: {
        box: { x: 124, y: 150, w: 756, h: 210 },
        sizePt: 24,
        italic: true,
        align: "left",
        colorRole: "heading",
        font: "major",
        anchor: "middle",
      },
      attribution: {
        box: { x: 124, y: 372, w: 756, h: 40 },
        sizePt: 14,
        align: "left",
        colorRole: "body",
        font: "minor",
        anchor: "top",
      },
    },
    decorations: [{ box: { x: 84, y: 150, w: 8, h: 240 }, colorRole: "accent1" }],
  },
  "image-caption": {
    text: {
      title: {
        box: { x: 60, y: 38, w: 840, h: 56 },
        sizePt: 24,
        bold: true,
        align: "left",
        colorRole: "heading",
        font: "major",
        anchor: "middle",
      },
      caption: {
        box: { x: 60, y: 462, w: 840, h: 42 },
        sizePt: 13,
        align: "center",
        colorRole: "body",
        font: "minor",
        anchor: "top",
      },
    },
    decorations: [],
  },
  chart: {
    text: {
      title: {
        box: { x: 60, y: 38, w: 840, h: 56 },
        sizePt: 24,
        bold: true,
        align: "left",
        colorRole: "heading",
        font: "major",
        anchor: "middle",
      },
    },
    decorations: [],
  },
  closing: {
    text: {
      title: {
        box: { x: 80, y: 196, w: 800, h: 94 },
        sizePt: 34,
        bold: true,
        align: "center",
        colorRole: "heading",
        font: "major",
        anchor: "middle",
      },
      body: {
        box: { x: 160, y: 306, w: 640, h: 96 },
        sizePt: 16,
        align: "center",
        colorRole: "body",
        font: "minor",
        anchor: "top",
      },
    },
    decorations: [{ box: { x: 430, y: 292, w: 100, h: 5 }, colorRole: "accent1" }],
  },
};

/** Media boxes for the rich-media layouts (image/chart content areas). */
export const DECK_MEDIA_BOXES: Partial<Record<DeckSlideLayout, DeckBox>> = {
  "image-caption": { x: 160, y: 112, w: 640, h: 334 },
  chart: { x: 130, y: 112, w: 700, h: 386 },
};

export function slideTextRegions(layout: DeckSlideLayout): Record<string, DeckTextRegionSpec> {
  return LAYOUT_GEOMETRY[layout].text;
}

/** The slide's text regions with any user-resized boxes merged in. Both the
 * stage and the PPTX export resolve through here, so an adjusted block lands
 * in the same place on screen and in PowerPoint by construction. */
export function resolvedTextRegions(slide: DeckSlide): Record<string, DeckTextRegionSpec> {
  const base = slideTextRegions(slide.layout);
  const overrides = slide.boxes;
  if (!overrides) return base;
  const merged: Record<string, DeckTextRegionSpec> = {};
  for (const [region, spec] of Object.entries(base)) {
    const box = overrides[region];
    merged[region] = box ? { ...spec, box } : spec;
  }
  return merged;
}

/** The media (picture) box for a slide, honoring a user-resized "image" box. */
export function resolvedMediaBox(slide: DeckSlide): DeckBox | null {
  const base = DECK_MEDIA_BOXES[slide.layout];
  if (!base) return null;
  return slide.boxes?.image ?? base;
}

export function slideDecorations(layout: DeckSlideLayout): DeckDecorationSpec[] {
  return LAYOUT_GEOMETRY[layout].decorations;
}

export function boxToEmu(box: DeckBox) {
  return {
    xEmu: Math.round(box.x * EMU_PER_PREVIEW_PX),
    yEmu: Math.round(box.y * EMU_PER_PREVIEW_PX),
    wEmu: Math.round(box.w * EMU_PER_PREVIEW_PX),
    hEmu: Math.round(box.h * EMU_PER_PREVIEW_PX),
  };
}
