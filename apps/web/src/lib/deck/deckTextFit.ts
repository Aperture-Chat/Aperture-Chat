/** PowerPoint's "shrink text on overflow" for slide text regions.
 *
 * Every text box in an exported deck carries <a:normAutofit>: when the words
 * outgrow the box, PowerPoint first tightens line spacing, then steps the font
 * down. The stage, the slide thumbnails, and the PowerPoint export share this
 * one measurement, so the stage shows the same shrink the .pptx records and a
 * slide never looks fitted on screen while overflowing in PowerPoint. The deck
 * fit check (deckLayoutCheck.ts) lays text out through the same functions.
 *
 * Text is laid out inside PowerPoint's default insets at the stage's line
 * height, with bullet indents and spacing at the larger of the stage's and
 * the export's, so a region measured as fitting fits in both. Words are
 * measured with canvas text metrics in the theme font. Where no canvas exists
 * (tests, server-side), regions report no shrink; the fit check falls back to
 * approximate widths there instead.
 */

import {
  DECK_LINE_HEIGHT,
  DECK_LIST_REGIONS,
  DECK_TEXT_INSET_X,
  DECK_TEXT_INSET_Y,
  type DeckTextRegionSpec,
} from "./deckGeometry";
import {
  deckRichTextParagraphs,
  isDeckBulletList,
  type DeckBullet,
  type DeckRichText,
  type DeckTextRun,
  type DeckTheme,
} from "./deckModel";

export type DeckRegionContent = DeckRichText | DeckBullet[];

export type DeckTextFit = { fontScale: number; lineReduction: number };

export const DECK_NO_FIT: DeckTextFit = { fontScale: 1, lineReduction: 0 };

/** PowerPoint's autofit ladder: spacing tightens first, then the font steps. */
export const DECK_FIT_STEPS: DeckTextFit[] = [
  { fontScale: 1, lineReduction: 0 },
  { fontScale: 1, lineReduction: 0.1 },
  { fontScale: 0.925, lineReduction: 0.1 },
  { fontScale: 0.85, lineReduction: 0.2 },
  { fontScale: 0.775, lineReduction: 0.2 },
  { fontScale: 0.7, lineReduction: 0.2 },
  { fontScale: 0.625, lineReduction: 0.2 },
  { fontScale: 0.55, lineReduction: 0.2 },
  { fontScale: 0.475, lineReduction: 0.2 },
  { fontScale: 0.4, lineReduction: 0.2 },
];

/** Bullet indent per level: the export's 0.3in, or the stage's 1.15em. */
const BULLET_INDENT_PT = 21.6;
const BULLET_INDENT_EM = 1.15;
/** Space between bullets: the export's 6pt, or the stage's 0.32em gap. */
const BULLET_GAP_PT = 6;
const BULLET_GAP_EM = 0.32;

export type DeckTextFont = { sizePx: number; bold: boolean; italic: boolean; family: string };

/** Advance width in pixels (1px is 1pt on the 960×540 slide) of `text`. */
export type DeckTextMeasure = (text: string, font: DeckTextFont) => number;

/** The CSS font stack the stage renders a family with. */
export function deckFontStack(family: string): string {
  const clean = family.replace(/["'\\;{}]/g, "").trim();
  return `${clean ? `"${clean}", ` : ""}"Plus Jakarta Sans", ui-sans-serif, sans-serif`;
}

let measureContext: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (measureContext !== undefined) return measureContext;
  measureContext = null;
  try {
    if (typeof document === "undefined" || /jsdom/i.test(globalThis.navigator?.userAgent ?? "")) {
      return measureContext;
    }
    measureContext = document.createElement("canvas").getContext("2d");
  } catch {
    measureContext = null;
  }
  return measureContext;
}

let canvasMeasure: DeckTextMeasure | null | undefined;

/** Canvas text metrics in the stage's fonts, or null where no canvas exists. */
export function deckCanvasMeasure(): DeckTextMeasure | null {
  if (canvasMeasure !== undefined) return canvasMeasure;
  const ctx = context();
  canvasMeasure = ctx
    ? (text, font) => {
        const value = `${font.italic ? "italic " : ""}${font.bold ? "700 " : "400 "}${font.sizePx}px ${deckFontStack(font.family)}`;
        if (ctx.font !== value) ctx.font = value;
        return ctx.measureText(text).width;
      }
    : null;
  return canvasMeasure;
}

/** Sans-serif advance widths by character class, in ems. Close enough to
 * size AI prompts deterministically and to check layout where no canvas
 * exists. */
function approximateCharEm(char: string, bold: boolean): number {
  if (char === " ") return 0.278;
  if (/[il.,:;'!|]/.test(char)) return bold ? 0.29 : 0.24;
  if (/[fjtrI()[\]/\\-]/.test(char)) return bold ? 0.36 : 0.32;
  if (/[mwMW%@]/.test(char)) return bold ? 0.89 : 0.86;
  if (/[A-Z&]/.test(char)) return bold ? 0.72 : 0.68;
  if (/[0-9$#+]/.test(char)) return 0.556;
  return bold ? 0.59 : 0.53;
}

export const approximateDeckMeasure: DeckTextMeasure = (text, font) => {
  let ems = 0;
  for (const char of text) ems += approximateCharEm(char, font.bold);
  return ems * font.sizePx;
};

type Paragraph = { runs: DeckTextRun[]; level: number };

function paragraphsOf(content: DeckRegionContent): Paragraph[] {
  if (isDeckBulletList(content)) {
    return content.filter((bullet) => bullet.runs.some((run) => run.text.trim()));
  }
  return deckRichTextParagraphs(content).map((runs) => ({ runs, level: -1 }));
}

/** True when a region holds bullets (and so takes bullet indents). */
export function deckRegionIsList(region: string): boolean {
  return DECK_LIST_REGIONS.has(region);
}

/** Text width available inside the box. */
export function deckRegionTextWidth(spec: DeckTextRegionSpec): number {
  return Math.max(8, spec.box.w - DECK_TEXT_INSET_X * 2);
}

/** Text height available inside the box. */
export function deckRegionTextHeight(spec: DeckTextRegionSpec): number {
  return Math.max(4, spec.box.h - DECK_TEXT_INSET_Y * 2);
}

/** Left indent of a bullet paragraph at a size. */
export function deckBulletIndent(level: number, sizePt: number): number {
  return Math.max(BULLET_INDENT_PT, BULLET_INDENT_EM * sizePt) * (level + 1);
}

/** Space between two bullet paragraphs at a size. */
export function deckBulletGap(sizePt: number): number {
  return Math.max(BULLET_GAP_PT, BULLET_GAP_EM * sizePt);
}

/** How a region's content lays out in its box at one fit step. */
export type DeckRegionLayout = {
  /** Laid-out text height in pixels (insets excluded). */
  height: number;
  lines: number;
  /** A word wider than the box, which wraps mid-word; null when none. */
  brokenWord: string | null;
};

/** Lays the content out line by line at one fit step. */
export function deckRegionLayout(
  spec: DeckTextRegionSpec,
  content: DeckRegionContent,
  theme: Pick<DeckTheme, "fonts">,
  fit: DeckTextFit,
  measure: DeckTextMeasure,
): DeckRegionLayout {
  const width = deckRegionTextWidth(spec);
  const family = theme.fonts[spec.font] ?? "";
  let height = 0;
  let totalLines = 0;
  let brokenWord: string | null = null;
  paragraphsOf(content).forEach((paragraph, index) => {
    const baseSize = Math.max(spec.sizePt, ...paragraph.runs.map((run) => run.sizePt ?? spec.sizePt));
    const sizePt = baseSize * fit.fontScale;
    const indent = paragraph.level >= 0 ? deckBulletIndent(paragraph.level, spec.sizePt) * fit.fontScale : 0;
    const available = Math.max(8, width - indent);
    const lineHeight = DECK_LINE_HEIGHT * sizePt * (1 - fit.lineReduction);
    if (index > 0 && paragraph.level >= 0) height += deckBulletGap(spec.sizePt) * fit.fontScale;
    let lines = 1;
    let lineWidth = 0;
    for (const run of paragraph.runs) {
      const font = {
        sizePx: (run.sizePt ?? spec.sizePt) * fit.fontScale,
        bold: run.bold ?? Boolean(spec.bold),
        italic: run.italic ?? Boolean(spec.italic),
        family: run.font ?? family,
      };
      for (const word of run.text.split(/(?<=\s)/)) {
        if (!word) continue;
        const wordWidth = measure(word, font);
        const trimmedWidth = measure(word.trimEnd(), font);
        if (lineWidth > 0 && lineWidth + trimmedWidth > available) {
          lines += 1;
          lineWidth = 0;
        }
        if (trimmedWidth > available + 1) {
          // A single word wider than the box breaks across lines.
          brokenWord ??= word.trim();
          lines += Math.floor(wordWidth / available);
          lineWidth = wordWidth % available;
        } else {
          lineWidth += wordWidth;
        }
      }
    }
    height += lines * lineHeight;
    totalLines += lines;
  });
  return { height, lines: totalLines, brokenWord };
}

/** The autofit step a region needs, by the given measure; `fits` is false
 * when even the smallest step overflows. */
export function deckRegionFitWith(
  spec: DeckTextRegionSpec,
  content: DeckRegionContent,
  theme: Pick<DeckTheme, "fonts">,
  measure: DeckTextMeasure,
): { fit: DeckTextFit; fits: boolean } {
  const available = deckRegionTextHeight(spec) + 0.5;
  for (const step of DECK_FIT_STEPS) {
    if (deckRegionLayout(spec, content, theme, step, measure).height <= available) return { fit: step, fits: true };
  }
  return { fit: DECK_FIT_STEPS[DECK_FIT_STEPS.length - 1], fits: false };
}

const fitCache = new Map<string, DeckTextFit>();

/** The autofit step a region's content needs to stay inside its box. */
export function deckRegionFit(
  spec: DeckTextRegionSpec,
  content: DeckRegionContent | null | undefined,
  theme: Pick<DeckTheme, "fonts">,
): DeckTextFit {
  if (!content?.length) return DECK_NO_FIT;
  const measure = deckCanvasMeasure();
  if (!measure) return DECK_NO_FIT;
  const key = JSON.stringify([spec.box, spec.sizePt, spec.bold, spec.italic, theme.fonts[spec.font], content]);
  const cached = fitCache.get(key);
  if (cached) return cached;
  const chosen = deckRegionFitWith(spec, content, theme, measure).fit;
  if (fitCache.size > 500) fitCache.clear();
  fitCache.set(key, chosen);
  return chosen;
}

/** The fit as <a:normAutofit> attributes, in PowerPoint's thousandths of a
 * percent; empty when the text fits at full size. */
export function deckFitAutofitAttributes(fit: DeckTextFit): string {
  const scale = fit.fontScale < 1 ? ` fontScale="${Math.round(fit.fontScale * 100_000)}"` : "";
  const lines = fit.lineReduction > 0 ? ` lnSpcReduction="${Math.round(fit.lineReduction * 100_000)}"` : "";
  return `${scale}${lines}`;
}
