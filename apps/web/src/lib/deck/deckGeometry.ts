/** Shared slide geometry for deck mode.
 *
 * One table drives BOTH the on-screen slide stage and the PPTX export: boxes
 * are authored in preview pixels on a 960x540 canvas, and the exporter
 * multiplies by EMU_PER_PREVIEW_PX (960px ↔ 12192000 EMU exactly, so
 * 1px ↔ 12700 EMU ↔ 1pt at 96dpi/72pt parity). The export mirrors the screen
 * by construction — same principle as PREVIEW_CONTENT_WIDTH_PX in docxExport.
 */

import { DECK_LAYOUT_REGIONS, type DeckDesign, type DeckSlide, type DeckSlideLayout, type DeckTheme } from "./deckModel";

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
  /** "background" is text set on a strong fill (an accent panel, a dark
   * band): the slide's own background color reads on it in light and dark
   * themes alike. */
  colorRole: Extract<DeckColorRole, "heading" | "body" | "accent1" | "background">;
  font: "major" | "minor";
  /** Vertical anchor within the box. */
  anchor: "top" | "middle";
};

/** A filled shape a design draws behind the slide text. Shapes may run off
 * the canvas (a circle bleeding off a corner); the slide clips them. */
export type DeckDecorationSpec = {
  box: DeckBox;
  colorRole: DeckColorRole;
  shape?: "ellipse";
  /** Share of the slide background mixed into the color, 0..1, for soft
   * shapes text can still sit on. */
  tint?: number;
};

/** Regions that hold bullets; every other region is flat rich text. */
export const DECK_LIST_REGIONS: ReadonlySet<string> = new Set(["bullets", "left", "right"]);

/** How the editor names each region to authors and to the AI fit check. */
export const DECK_REGION_LABELS: Record<string, string> = {
  title: "Title",
  subtitle: "Subtitle",
  bullets: "Bullets",
  left: "Left column",
  right: "Right column",
  quote: "Quote",
  attribution: "Attribution",
  caption: "Caption",
  body: "Closing message",
};

/** PowerPoint's default text box insets (0.1in sides, 0.05in top and
 * bottom), which the exported text boxes keep; the fit check measures inside
 * them so text that fits there fits on the stage too. */
export const DECK_TEXT_INSET_X = 7.2;
export const DECK_TEXT_INSET_Y = 3.6;
/** The stage's slide text line height, as a multiple of the font size. */
export const DECK_LINE_HEIGHT = 1.28;

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
  // Layouts added after the original seven, in the classic spirit (an accent
  // mark, big type, a picture panel) rather than one more centred rule.
  statement: {
    decorations: [fill(box(80, 84, 14, 14), "accent1")],
    text: { title: heading(box(80, 104, 800, 230), 40), body: body(box(80, 350, 700, 100), 18) },
  },
  "big-number": {
    decorations: [],
    text: {
      title: heading(box(80, 100, 800, 210), 96, { colorRole: "accent1", align: "center" }),
      subtitle: body(box(140, 326, 680, 90), 20, { align: "center" }),
    },
  },
  "image-bullets": {
    decorations: [fill(box(0, 0, 440, 540), "surface")],
    text: { title: heading(box(480, 48, 420, 100), 26), bullets: body(box(480, 164, 420, 320), 16) },
  },
};

/** Media boxes for the rich-media layouts (image/chart content areas). */
export const DECK_MEDIA_BOXES: Partial<Record<DeckSlideLayout, DeckBox>> = {
  "image-caption": { x: 160, y: 112, w: 640, h: 334 },
  "image-bullets": { x: 0, y: 0, w: 440, h: 540 },
  chart: { x: 130, y: 112, w: 700, h: 386 },
};

/* ------------------------------ designs ------------------------------ */

type TextOptions = Partial<Omit<DeckTextRegionSpec, "box" | "sizePt">>;

function box(x: number, y: number, w: number, h: number): DeckBox {
  return { x, y, w, h };
}

/** A bold, theme-heading-font line of text, centred on its box's middle. */
function heading(area: DeckBox, sizePt: number, options: TextOptions = {}): DeckTextRegionSpec {
  return { box: area, sizePt, bold: true, align: "left", colorRole: "heading", font: "major", anchor: "middle", ...options };
}

/** Body-font text flowing from the top of its box. */
function body(area: DeckBox, sizePt: number, options: TextOptions = {}): DeckTextRegionSpec {
  return { box: area, sizePt, align: "left", colorRole: "body", font: "minor", anchor: "top", ...options };
}

function fill(area: DeckBox, colorRole: DeckColorRole): DeckDecorationSpec {
  return { box: area, colorRole };
}

function circle(area: DeckBox, colorRole: DeckColorRole, tint?: number): DeckDecorationSpec {
  return tint ? { box: area, colorRole, shape: "ellipse", tint } : { box: area, colorRole, shape: "ellipse" };
}

const FULL_SLIDE = box(0, 0, DECK_PREVIEW_WIDTH_PX, DECK_PREVIEW_HEIGHT_PX);
const ON_FILL: TextOptions = { colorRole: "background" };
const QUOTE_TEXT: TextOptions = { bold: false, italic: true };

type DesignGeometry = Partial<Record<DeckSlideLayout, LayoutGeometry>>;

/** Color block: full-bleed accent slides and an accent band across the top
 * of content slides, with the words set in the slide background color. */
const BAND: DesignGeometry = {
  title: {
    decorations: [fill(FULL_SLIDE, "accent1"), fill(box(0, 500, 960, 40), "heading")],
    text: {
      title: heading(box(72, 236, 780, 140), 44, ON_FILL),
      subtitle: body(box(72, 386, 700, 64), 18, ON_FILL),
    },
  },
  section: {
    decorations: [fill(FULL_SLIDE, "heading"), fill(box(0, 0, 24, 540), "accent1")],
    text: {
      title: heading(box(80, 200, 800, 110), 36, ON_FILL),
      subtitle: body(box(80, 320, 720, 60), 16, ON_FILL),
    },
  },
  "title-bullets": {
    decorations: [fill(box(0, 0, 960, 118), "accent1")],
    text: { title: heading(box(60, 27, 840, 64), 26, ON_FILL), bullets: body(box(60, 146, 840, 350), 16) },
  },
  "two-column": {
    decorations: [fill(box(0, 0, 960, 118), "accent1")],
    text: {
      title: heading(box(60, 27, 840, 64), 26, ON_FILL),
      left: body(box(60, 146, 408, 350), 15),
      right: body(box(492, 146, 408, 350), 15),
    },
  },
  "image-caption": {
    decorations: [fill(box(0, 0, 960, 96), "accent1")],
    text: {
      title: heading(box(60, 20, 840, 56), 24, ON_FILL),
      caption: body(box(60, 462, 840, 42), 13, { align: "center" }),
    },
  },
  "image-bullets": {
    decorations: [fill(box(440, 0, 520, 540), "accent1")],
    text: {
      title: heading(box(480, 48, 440, 100), 26, ON_FILL),
      bullets: body(box(480, 164, 440, 330), 16, ON_FILL),
    },
  },
  statement: {
    decorations: [fill(FULL_SLIDE, "accent1")],
    text: { title: heading(box(80, 110, 800, 230), 42, ON_FILL), body: body(box(80, 356, 700, 100), 18, ON_FILL) },
  },
  "big-number": {
    decorations: [fill(box(0, 0, 480, 540), "accent1")],
    text: {
      title: heading(box(40, 150, 400, 200), 88, { ...ON_FILL, align: "center" }),
      subtitle: body(box(520, 170, 380, 200), 22, { colorRole: "heading", anchor: "middle" }),
    },
  },
  quote: {
    decorations: [fill(box(0, 0, 300, 540), "accent1")],
    text: {
      quote: heading(box(360, 130, 540, 240), 24, QUOTE_TEXT),
      attribution: body(box(360, 386, 540, 40), 14),
    },
  },
  closing: {
    decorations: [fill(FULL_SLIDE, "accent1")],
    text: {
      title: heading(box(80, 180, 800, 110), 40, { ...ON_FILL, align: "center" }),
      body: body(box(160, 300, 640, 96), 18, { ...ON_FILL, align: "center" }),
    },
  },
};

/** Split panel: a solid side panel carries the color, and the words sit
 * beside it; content slides set the title in a side column. */
const SPLIT: DesignGeometry = {
  title: {
    decorations: [fill(box(0, 0, 400, 540), "accent1")],
    text: { title: heading(box(440, 150, 470, 170), 38), subtitle: body(box(440, 330, 470, 90), 17) },
  },
  section: {
    decorations: [fill(box(600, 0, 360, 540), "accent1")],
    text: { title: heading(box(80, 190, 480, 120), 34), subtitle: body(box(80, 320, 480, 70), 16) },
  },
  "title-bullets": {
    decorations: [fill(box(0, 0, 330, 540), "surface")],
    text: {
      title: heading(box(48, 60, 250, 300), 26, { anchor: "top" }),
      bullets: body(box(380, 60, 530, 430), 16),
    },
  },
  "two-column": {
    decorations: [fill(box(0, 0, 960, 112), "surface")],
    text: {
      title: heading(box(60, 24, 840, 64), 26),
      left: body(box(60, 140, 408, 350), 15),
      right: body(box(492, 140, 408, 350), 15),
    },
  },
  "image-caption": {
    decorations: [fill(box(0, 0, 330, 540), "surface")],
    text: {
      title: heading(box(40, 60, 260, 220), 24, { anchor: "top" }),
      caption: body(box(40, 300, 260, 180), 14),
    },
  },
  "image-bullets": {
    decorations: [fill(box(520, 0, 440, 540), "surface")],
    text: { title: heading(box(60, 48, 420, 100), 26), bullets: body(box(60, 164, 420, 330), 16) },
  },
  statement: {
    decorations: [fill(box(0, 0, 300, 540), "accent1")],
    text: { title: heading(box(340, 110, 570, 250), 36), body: body(box(340, 370, 560, 100), 18) },
  },
  "big-number": {
    decorations: [fill(box(0, 0, 480, 540), "surface")],
    text: {
      title: heading(box(40, 150, 400, 200), 88, { colorRole: "accent1", align: "center" }),
      subtitle: body(box(520, 170, 380, 200), 22, { colorRole: "heading", anchor: "middle" }),
    },
  },
  quote: {
    decorations: [fill(box(660, 0, 300, 540), "accent1")],
    text: { quote: heading(box(80, 130, 540, 240), 24, QUOTE_TEXT), attribution: body(box(80, 386, 540, 40), 14) },
  },
  closing: {
    decorations: [fill(box(0, 0, 400, 540), "accent1")],
    text: { title: heading(box(440, 170, 470, 120), 36), body: body(box(440, 300, 470, 100), 17) },
  },
};

/** Editorial: regular-weight display type and hairline rules in the
 * heading color, like a printed magazine page. */
const EDITORIAL_TITLE: TextOptions = { bold: false };
const EDITORIAL: DesignGeometry = {
  title: {
    decorations: [fill(box(60, 60, 840, 2), "heading"), fill(box(60, 384, 840, 1), "heading")],
    text: {
      title: heading(box(60, 220, 840, 150), 48, EDITORIAL_TITLE),
      subtitle: body(box(60, 398, 840, 56), 17, { italic: true }),
    },
  },
  section: {
    decorations: [fill(FULL_SLIDE, "surface"), fill(box(60, 180, 840, 1), "heading")],
    text: {
      title: heading(box(60, 200, 840, 110), 42, EDITORIAL_TITLE),
      subtitle: body(box(60, 320, 840, 56), 17, { italic: true }),
    },
  },
  "title-bullets": {
    decorations: [fill(box(60, 106, 840, 1), "heading"), fill(box(60, 500, 840, 1), "heading")],
    text: { title: heading(box(60, 38, 840, 64), 30, EDITORIAL_TITLE), bullets: body(box(60, 126, 840, 360), 16) },
  },
  "two-column": {
    decorations: [fill(box(60, 106, 840, 1), "heading"), fill(box(480, 130, 1, 350), "heading")],
    text: {
      title: heading(box(60, 38, 840, 64), 30, EDITORIAL_TITLE),
      left: body(box(60, 126, 396, 360), 15),
      right: body(box(504, 126, 396, 360), 15),
    },
  },
  "image-caption": {
    decorations: [fill(box(60, 92, 840, 1), "heading")],
    text: {
      title: heading(box(60, 30, 840, 56), 26, EDITORIAL_TITLE),
      caption: body(box(60, 456, 840, 44), 13, { italic: true }),
    },
  },
  "image-bullets": {
    decorations: [fill(box(60, 170, 400, 1), "heading")],
    text: { title: heading(box(60, 60, 400, 100), 30, EDITORIAL_TITLE), bullets: body(box(60, 186, 400, 300), 16) },
  },
  statement: {
    decorations: [fill(box(450, 118, 60, 1), "heading"), fill(box(450, 392, 60, 1), "heading")],
    text: {
      title: heading(box(100, 134, 760, 240), 38, { ...QUOTE_TEXT, align: "center" }),
      body: body(box(160, 404, 640, 70), 17, { align: "center" }),
    },
  },
  "big-number": {
    decorations: [fill(box(600, 120, 1, 300), "heading")],
    text: {
      title: heading(box(40, 120, 530, 300), 96, { ...EDITORIAL_TITLE, colorRole: "accent1", align: "center" }),
      subtitle: body(box(630, 150, 280, 240), 20, { italic: true, anchor: "middle" }),
    },
  },
  quote: {
    decorations: [fill(box(420, 108, 120, 1), "heading")],
    text: {
      quote: heading(box(120, 124, 720, 240), 30, { ...QUOTE_TEXT, align: "center" }),
      attribution: body(box(120, 380, 720, 40), 14, { align: "center" }),
    },
  },
  closing: {
    decorations: [fill(box(430, 312, 100, 1), "heading")],
    text: {
      title: heading(box(80, 196, 800, 110), 44, { ...EDITORIAL_TITLE, align: "center" }),
      body: body(box(160, 326, 640, 90), 17, { italic: true, align: "center" }),
    },
  },
};

/** Orbit: large circles bleeding off the slide edges, with the words kept
 * clear of them (or set in the background color inside one). */
const ORBIT_CORNER = [circle(box(850, -70, 180, 180), "accent1"), circle(box(60, 61, 18, 18), "accent2")];
const ORBIT_TITLE = heading(box(90, 38, 700, 64), 26);
const ORBIT: DesignGeometry = {
  title: {
    decorations: [circle(box(600, -140, 520, 520), "accent1"), circle(box(570, 410, 180, 180), "accent2")],
    text: { title: heading(box(70, 160, 500, 160), 40), subtitle: body(box(70, 330, 480, 70), 17) },
  },
  section: {
    decorations: [circle(box(-160, 90, 420, 420), "accent1")],
    text: { title: heading(box(320, 200, 580, 100), 34), subtitle: body(box(320, 310, 580, 60), 16) },
  },
  "title-bullets": {
    decorations: ORBIT_CORNER,
    text: { title: ORBIT_TITLE, bullets: body(box(60, 126, 840, 356), 16) },
  },
  "two-column": {
    decorations: ORBIT_CORNER,
    text: { title: ORBIT_TITLE, left: body(box(60, 126, 408, 356), 15), right: body(box(492, 126, 408, 356), 15) },
  },
  "image-caption": {
    decorations: [circle(box(-70, 450, 160, 160), "accent2"), circle(box(60, 61, 18, 18), "accent1")],
    text: {
      title: heading(box(90, 38, 810, 56), 24),
      caption: body(box(120, 462, 720, 42), 13, { align: "center" }),
    },
  },
  "image-bullets": {
    decorations: [fill(box(0, 0, 440, 540), "surface"), circle(box(870, 450, 140, 140), "accent1")],
    text: { title: heading(box(480, 48, 380, 100), 26), bullets: body(box(480, 164, 380, 280), 16) },
  },
  statement: {
    decorations: [circle(box(200, -50, 560, 560), "accent1", 0.85)],
    text: {
      title: heading(box(140, 160, 680, 190), 38, { align: "center" }),
      body: body(box(180, 360, 600, 80), 18, { align: "center" }),
    },
  },
  "big-number": {
    decorations: [circle(box(320, 40, 320, 320), "accent1")],
    text: {
      title: heading(box(320, 130, 320, 140), 72, { ...ON_FILL, align: "center" }),
      subtitle: body(box(180, 380, 600, 90), 20, { align: "center" }),
    },
  },
  quote: {
    decorations: [circle(box(-90, -90, 330, 330), "accent1", 0.75)],
    text: { quote: heading(box(150, 150, 720, 220), 26, QUOTE_TEXT), attribution: body(box(150, 386, 720, 40), 14) },
  },
  closing: {
    decorations: [circle(box(-110, 370, 280, 280), "accent1"), circle(box(800, -90, 240, 240), "accent2")],
    text: {
      title: heading(box(120, 190, 720, 100), 38, { align: "center" }),
      body: body(box(160, 300, 640, 90), 18, { align: "center" }),
    },
  },
};

/** Frame: a thin accent border inset on every slide, with corner marks on
 * the statement slides. */
const FRAME_BORDER = [
  fill(box(24, 24, 912, 3), "accent1"),
  fill(box(24, 513, 912, 3), "accent1"),
  fill(box(24, 24, 3, 492), "accent1"),
  fill(box(933, 24, 3, 492), "accent1"),
];
const FRAME_CORNERS = [
  fill(box(16, 16, 16, 16), "accent1"),
  fill(box(928, 16, 16, 16), "accent1"),
  fill(box(16, 508, 16, 16), "accent1"),
  fill(box(928, 508, 16, 16), "accent1"),
];
const FRAME_INSIDE = fill(box(27, 27, 906, 486), "surface");
const FRAME_TITLE = heading(box(60, 48, 840, 64), 26);
const FRAME: DesignGeometry = {
  title: {
    decorations: [...FRAME_BORDER, ...FRAME_CORNERS],
    text: {
      title: heading(box(100, 170, 760, 140), 40, { align: "center" }),
      subtitle: body(box(140, 322, 680, 64), 18, { align: "center" }),
    },
  },
  section: {
    decorations: [FRAME_INSIDE, ...FRAME_BORDER],
    text: {
      title: heading(box(80, 210, 800, 100), 34, { align: "center" }),
      subtitle: body(box(140, 320, 680, 56), 16, { align: "center" }),
    },
  },
  "title-bullets": {
    decorations: FRAME_BORDER,
    text: { title: FRAME_TITLE, bullets: body(box(60, 128, 840, 352), 16) },
  },
  "two-column": {
    decorations: [...FRAME_BORDER, fill(box(479, 132, 2, 340), "surface")],
    text: { title: FRAME_TITLE, left: body(box(60, 128, 400, 352), 15), right: body(box(500, 128, 400, 352), 15) },
  },
  "image-caption": {
    decorations: FRAME_BORDER,
    text: {
      title: heading(box(60, 44, 840, 56), 24),
      caption: body(box(60, 458, 840, 42), 13, { align: "center" }),
    },
  },
  "image-bullets": {
    decorations: [...FRAME_BORDER, fill(box(48, 48, 400, 444), "surface")],
    text: { title: heading(box(480, 56, 420, 100), 26), bullets: body(box(480, 170, 420, 310), 16) },
  },
  statement: {
    decorations: [...FRAME_BORDER, ...FRAME_CORNERS],
    text: {
      title: heading(box(100, 130, 760, 220), 38, { align: "center" }),
      body: body(box(160, 360, 640, 90), 18, { align: "center" }),
    },
  },
  "big-number": {
    decorations: FRAME_BORDER,
    text: {
      title: heading(box(80, 100, 800, 220), 96, { colorRole: "accent1", align: "center" }),
      subtitle: body(box(140, 330, 680, 90), 20, { align: "center" }),
    },
  },
  quote: {
    decorations: [...FRAME_BORDER, ...FRAME_CORNERS],
    text: {
      quote: heading(box(120, 140, 720, 220), 26, { ...QUOTE_TEXT, align: "center" }),
      attribution: body(box(120, 380, 720, 40), 14, { align: "center" }),
    },
  },
  closing: {
    decorations: [FRAME_INSIDE, ...FRAME_BORDER],
    text: {
      title: heading(box(100, 190, 760, 100), 36, { align: "center" }),
      body: body(box(160, 300, 640, 90), 18, { align: "center" }),
    },
  },
};

/** Swiss: oversized type on an asymmetric grid, full-bleed pictures, and a
 * single accent square instead of rules. */
const SWISS: DesignGeometry = {
  title: {
    decorations: [fill(box(860, 440, 40, 40), "accent1")],
    text: {
      title: heading(box(60, 60, 840, 240), 56, { anchor: "top" }),
      subtitle: body(box(60, 420, 700, 60), 17),
    },
  },
  section: {
    decorations: [fill(box(60, 60, 120, 120), "accent1")],
    text: {
      title: heading(box(60, 290, 840, 100), 40, { anchor: "top" }),
      subtitle: body(box(60, 400, 840, 56), 16),
    },
  },
  "title-bullets": {
    decorations: [fill(box(60, 132, 24, 24), "accent1")],
    text: { title: heading(box(60, 40, 840, 64), 28), bullets: body(box(340, 128, 560, 360), 16) },
  },
  "two-column": {
    decorations: [fill(box(60, 110, 12, 12), "accent1")],
    text: {
      title: heading(box(60, 36, 840, 64), 28),
      left: body(box(60, 136, 400, 350), 15),
      right: body(box(500, 136, 400, 350), 15),
    },
  },
  "image-caption": {
    decorations: [fill(box(0, 0, 960, 380), "surface")],
    text: { title: heading(box(60, 398, 840, 56), 26), caption: body(box(60, 456, 840, 50), 14) },
  },
  "image-bullets": {
    decorations: [fill(box(480, 0, 480, 540), "surface")],
    text: {
      title: heading(box(60, 60, 380, 120), 30, { anchor: "top" }),
      bullets: body(box(60, 200, 380, 300), 16),
    },
  },
  statement: {
    decorations: [fill(box(860, 440, 40, 40), "accent1")],
    text: { title: heading(box(60, 60, 840, 300), 48, { anchor: "top" }), body: body(box(60, 400, 700, 80), 18) },
  },
  "big-number": {
    decorations: [fill(box(60, 60, 24, 24), "accent1")],
    text: {
      title: heading(box(53, 90, 860, 220), 96, { colorRole: "accent1" }),
      subtitle: body(box(60, 330, 640, 100), 22, { colorRole: "heading" }),
    },
  },
  quote: {
    decorations: [fill(box(60, 40, 24, 24), "accent1")],
    text: {
      quote: heading(box(60, 90, 840, 260), 32),
      attribution: body(box(60, 380, 840, 40), 15, { colorRole: "accent1" }),
    },
  },
  closing: {
    decorations: [fill(box(60, 140, 28, 28), "accent1")],
    text: { title: heading(box(60, 180, 840, 120), 48, { anchor: "top" }), body: body(box(60, 310, 700, 80), 18) },
  },
};

const DESIGN_GEOMETRY: Record<DeckDesign, DesignGeometry> = {
  rule: {},
  band: BAND,
  split: SPLIT,
  editorial: EDITORIAL,
  orbit: ORBIT,
  frame: FRAME,
  swiss: SWISS,
};

const DESIGN_MEDIA_BOXES: Partial<Record<DeckDesign, Partial<Record<DeckSlideLayout, DeckBox>>>> = {
  split: { "image-caption": box(370, 40, 550, 460), "image-bullets": box(520, 0, 440, 540) },
  editorial: { "image-caption": box(60, 108, 840, 338), "image-bullets": box(500, 60, 400, 420) },
  frame: { "image-caption": box(160, 108, 640, 340), "image-bullets": box(48, 48, 400, 444) },
  swiss: { "image-caption": box(0, 0, 960, 380), "image-bullets": box(480, 0, 480, 540) },
};

/** A design's geometry for a layout; layouts a design does not restyle keep
 * the classic geometry. */
function layoutGeometry(layout: DeckSlideLayout, design: DeckDesign): LayoutGeometry {
  return DESIGN_GEOMETRY[design][layout] ?? LAYOUT_GEOMETRY[layout];
}

export function slideTextRegions(layout: DeckSlideLayout, design: DeckDesign): Record<string, DeckTextRegionSpec> {
  return layoutGeometry(layout, design).text;
}

/** The text regions a layout has. Every design draws the same set, so the
 * names never depend on the theme. */
export function slideRegionNames(layout: DeckSlideLayout): string[] {
  return [...DECK_LAYOUT_REGIONS[layout]];
}

/** The slide's text regions with any user-resized boxes merged in. Both the
 * stage and the PPTX export resolve through here, so an adjusted block lands
 * in the same place on screen and in PowerPoint by construction. */
export function resolvedTextRegions(slide: DeckSlide, design: DeckDesign): Record<string, DeckTextRegionSpec> {
  const base = slideTextRegions(slide.layout, design);
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
export function resolvedMediaBox(slide: DeckSlide, design: DeckDesign): DeckBox | null {
  const base = DESIGN_MEDIA_BOXES[design]?.[slide.layout] ?? DECK_MEDIA_BOXES[slide.layout];
  if (!base) return null;
  return slide.boxes?.image ?? base;
}

export function slideDecorations(layout: DeckSlideLayout, design: DeckDesign): DeckDecorationSpec[] {
  return layoutGeometry(layout, design).decorations;
}

/** The "#rrggbb" a color role paints with, `tint` of the way toward the
 * slide background. The stage and the PowerPoint export both resolve here. */
export function deckRoleColor(theme: Pick<DeckTheme, "colors">, role: DeckColorRole, tint = 0): string {
  const base = theme.colors[role];
  const channels = (hex: string) => [0, 2, 4].map((offset) => parseInt(hex.slice(1 + offset, 3 + offset), 16));
  const from = channels(base);
  const to = channels(theme.colors.background);
  return `#${from
    .map((value, index) => Math.round(value + (to[index] - value) * tint).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function boxToEmu(box: DeckBox) {
  return {
    xEmu: Math.round(box.x * EMU_PER_PREVIEW_PX),
    yEmu: Math.round(box.y * EMU_PER_PREVIEW_PX),
    wEmu: Math.round(box.w * EMU_PER_PREVIEW_PX),
    hEmu: Math.round(box.h * EMU_PER_PREVIEW_PX),
  };
}
