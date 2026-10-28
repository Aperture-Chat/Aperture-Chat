/** Slide fit check: the deck assistant's eyes on its own work.
 *
 * After the AI drafts or edits slides, every text region is laid out exactly
 * as the stage and the .pptx export lay it out (deckTextFit) and measured
 * against its box. Text that overflows even at PowerPoint's smallest autofit
 * step, words too wide for their box, and text PowerPoint would have to shrink
 * to an unreadable size come back as issues. The assistant sends those slides
 * back to the model with the measurements. Capacity hints derived from the
 * same geometry go into the prompts up front, so most decks fit on the first
 * pass.
 */

import {
  DECK_LINE_HEIGHT,
  DECK_REGION_LABELS,
  resolvedTextRegions,
  slideRegionNames,
  slideTextRegions,
  type DeckTextRegionSpec,
} from "./deckGeometry";
import {
  deckRegionPlainText,
  deckSlideRegionContent,
  deckThemeDesign,
  defaultDeckTheme,
  isDeckBulletList,
  type DeckDesign,
  type DeckSlide,
  type DeckSlideLayout,
  type DeckTheme,
  type SlideDeck,
} from "./deckModel";
import {
  DECK_NO_FIT,
  approximateDeckMeasure,
  deckBulletGap,
  deckBulletIndent,
  deckCanvasMeasure,
  deckRegionFitWith,
  deckRegionIsList,
  deckRegionLayout,
  deckRegionTextHeight,
  deckRegionTextWidth,
  type DeckRegionContent,
  type DeckTextMeasure,
} from "./deckTextFit";

export type DeckFitProblem = "overflow" | "broken-word" | "too-small";

export type DeckFitIssue = {
  slideId: string;
  slideIndex: number;
  layout: DeckSlideLayout;
  region: string;
  label: string;
  problem: DeckFitProblem;
  text: string;
  /** The layout's type size for the region. */
  sizePt: number;
  /** The size PowerPoint's autofit lands on. */
  fittedPt: number;
  linesNeeded: number;
  linesAvailable: number;
  charsPerLine: number;
  brokenWord: string | null;
};

const PROBLEM_WEIGHT: Record<DeckFitProblem, number> = { overflow: 3, "broken-word": 2, "too-small": 1 };

/** Typical slide wording, for an average character width. */
const SAMPLE_TEXT = "Revenue grew 14% in 2025 across key markets";

function measureOrApproximate(measure?: DeckTextMeasure): DeckTextMeasure {
  return measure ?? deckCanvasMeasure() ?? approximateDeckMeasure;
}

function designSizePt(spec: DeckTextRegionSpec, content: DeckRegionContent): number {
  const sizes = isDeckBulletList(content)
    ? content.flatMap((bullet) => bullet.runs.map((run) => run.sizePt ?? spec.sizePt))
    : content.map((run) => run.sizePt ?? spec.sizePt);
  return sizes.length ? Math.max(...sizes) : spec.sizePt;
}

/** How much text a region holds at the layout's own type size. */
export function deckRegionCapacity(
  spec: DeckTextRegionSpec,
  region: string,
  theme: Pick<DeckTheme, "fonts"> = defaultDeckTheme(),
  measure: DeckTextMeasure = approximateDeckMeasure,
): { lines: number; charsPerLine: number } {
  const list = deckRegionIsList(region);
  const font = { sizePx: spec.sizePt, bold: Boolean(spec.bold), italic: Boolean(spec.italic), family: theme.fonts[spec.font] ?? "" };
  const width = Math.max(8, deckRegionTextWidth(spec) - (list ? deckBulletIndent(0, spec.sizePt) : 0));
  const charPx = measure(SAMPLE_TEXT, font) / SAMPLE_TEXT.length;
  const lineHeight = DECK_LINE_HEIGHT * spec.sizePt;
  const height = deckRegionTextHeight(spec);
  const gap = list ? deckBulletGap(spec.sizePt) : 0;
  const lines = list ? Math.floor((height + gap) / (lineHeight + gap)) : Math.floor(height / lineHeight + 0.15);
  return { lines: Math.max(1, lines), charsPerLine: Math.max(1, Math.floor(width / charPx)) };
}

/** "≤38 chars" or "≤7 bullets of ~70 chars", for the AI's layout list. */
export function deckRegionCapacityHint(spec: DeckTextRegionSpec, region: string): string {
  const { lines, charsPerLine } = deckRegionCapacity(spec, region);
  if (lines === 1) return `≤${charsPerLine} chars`;
  return deckRegionIsList(region)
    ? `≤${lines} one-line bullets of ~${charsPerLine} chars`
    : `≤${lines} lines of ~${charsPerLine} chars`;
}

/** The fit line for one layout, as the deck's design sizes it, in the AI's
 * layout list: "title ≤45 chars; bullets ≤9 one-line bullets of ~79 chars". */
export function deckLayoutCapacityLine(layout: DeckSlideLayout, design: DeckDesign): string {
  return Object.entries(slideTextRegions(layout, design))
    .map(([region, spec]) => `${region} ${deckRegionCapacityHint(spec, region)}`)
    .join("; ");
}

/** Smallest acceptable autofit size: three quarters of the design size, and
 * never under 8pt for text the layout sets at 9pt or more. */
function readableFloorPt(sizePt: number): number {
  return sizePt >= 9 ? Math.max(8, sizePt * 0.75) : sizePt * 0.75;
}

function checkRegion(
  slide: DeckSlide,
  slideIndex: number,
  region: string,
  spec: DeckTextRegionSpec,
  content: DeckRegionContent,
  theme: Pick<DeckTheme, "fonts">,
  measure: DeckTextMeasure,
): DeckFitIssue | null {
  const text = deckRegionPlainText(content).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const sizePt = designSizePt(spec, content);
  const capacity = deckRegionCapacity(spec, region, theme, measure);
  const { fit, fits } = deckRegionFitWith(spec, content, theme, measure);
  const layout = deckRegionLayout(spec, content, theme, fit, measure);
  const fittedPt = Math.round(sizePt * fit.fontScale * 10) / 10;
  const linesNeeded = deckRegionLayout(spec, content, theme, DECK_NO_FIT, measure).lines;
  const base = {
    slideId: slide.id,
    slideIndex,
    layout: slide.layout,
    region,
    label: DECK_REGION_LABELS[region] ?? region,
    text: text.length > 160 ? `${text.slice(0, 157)}…` : text,
    sizePt,
    fittedPt,
    linesNeeded,
    linesAvailable: capacity.lines,
    charsPerLine: capacity.charsPerLine,
  };
  if (!fits) return { ...base, problem: "overflow", brokenWord: layout.brokenWord };
  if (layout.brokenWord) return { ...base, problem: "broken-word", brokenWord: layout.brokenWord };
  if (fittedPt < readableFloorPt(sizePt)) return { ...base, problem: "too-small", brokenWord: null };
  return null;
}

/** Every fit issue on the deck's slides, optionally limited to some slides
 * (a revision checks only what it changed). */
export function auditDeckLayout(
  deck: Pick<SlideDeck, "slides" | "theme">,
  options: { slideIds?: Iterable<string>; regions?: Iterable<string>; measure?: DeckTextMeasure } = {},
): DeckFitIssue[] {
  const only = options.slideIds ? new Set(options.slideIds) : null;
  const regions = options.regions ? new Set(options.regions) : null;
  const measure = measureOrApproximate(options.measure);
  const issues: DeckFitIssue[] = [];
  deck.slides.forEach((slide, index) => {
    if (only && !only.has(slide.id)) return;
    for (const [region, spec] of Object.entries(resolvedTextRegions(slide, deckThemeDesign(deck.theme)))) {
      if (regions && !regions.has(region)) continue;
      const content = deckSlideRegionContent(slide, region);
      if (!content?.length) continue;
      const issue = checkRegion(slide, index, region, spec, content, deck.theme, measure);
      if (issue) issues.push(issue);
    }
  });
  return issues;
}

/** Severity total; a fix is accepted only when it lowers this. */
export function deckFitScore(issues: DeckFitIssue[]): number {
  return issues.reduce((total, issue) => total + PROBLEM_WEIGHT[issue.problem], 0);
}

/** One issue as the model reads it, with the measurements it needs. */
export function describeDeckFitIssue(issue: DeckFitIssue): string {
  const field = `"${issue.region}" (${issue.label}, ${issue.sizePt}pt): "${issue.text}"`;
  const room =
    issue.linesAvailable === 1
      ? `the box holds 1 line of about ${issue.charsPerLine} characters`
      : `the box holds about ${issue.linesAvailable} lines of ${issue.charsPerLine} characters`;
  if (issue.problem === "broken-word") {
    return `${field} — "${issue.brokenWord}" is wider than the box, so it breaks mid-word; ${room}.`;
  }
  if (issue.problem === "too-small") {
    const percent = Math.round((issue.fittedPt / issue.sizePt) * 100);
    return `${field} — needs ${issue.linesNeeded} lines, so PowerPoint shrinks it to ${percent}% (${issue.fittedPt}pt), too small to read; ${room}.`;
  }
  return `${field} — needs ${issue.linesNeeded} line${issue.linesNeeded === 1 ? "" : "s"} but ${room}, so it spills out of the box even at PowerPoint's smallest shrink.`;
}

/** Issues grouped by slide, in deck order, for the repair prompt. */
export function describeDeckFitIssues(deck: Pick<SlideDeck, "slides">, issues: DeckFitIssue[]): string {
  const bySlide = new Map<string, DeckFitIssue[]>();
  issues.forEach((issue) => bySlide.set(issue.slideId, [...(bySlide.get(issue.slideId) ?? []), issue]));
  return [...bySlide.entries()]
    .map(([slideId, slideIssues]) => {
      const index = deck.slides.findIndex((slide) => slide.id === slideId);
      const slide = deck.slides[index];
      return [
        `Slide ${index + 1} (id "${slideId}", layout "${slide?.layout ?? slideIssues[0].layout}"):`,
        ...slideIssues.map((issue) => `- ${describeDeckFitIssue(issue)}`),
      ].join("\n");
    })
    .join("\n\n");
}

/** One-based numbers of the slides with issues, in deck order. */
export function deckFitIssueSlides(issues: DeckFitIssue[]): number[] {
  return [...new Set(issues.map((issue) => issue.slideIndex + 1))].sort((a, b) => a - b);
}

/** What lays out on a slide: its layout, its words, and its boxes. */
function fitFingerprint(slide: DeckSlide): string {
  const regions = slideRegionNames(slide.layout).map((region) => deckSlideRegionContent(slide, region));
  return JSON.stringify([slide.layout, regions, slide.boxes ?? null]);
}

/** Slides a revision added or changed (layout, words, or boxes); a revision
 * checks only these, so slides the author finished are never rewritten. */
export function changedDeckSlideIds(before: Pick<SlideDeck, "slides"> | null, after: Pick<SlideDeck, "slides">): string[] {
  const previous = new Map((before?.slides ?? []).map((slide) => [slide.id, slide]));
  return after.slides
    .filter((slide) => {
      const old = previous.get(slide.id);
      return !old || fitFingerprint(old) !== fitFingerprint(slide);
    })
    .map((slide) => slide.id);
}
