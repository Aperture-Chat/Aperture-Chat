import { expect, test } from "vitest";
import {
  auditDeckLayout,
  changedDeckSlideIds,
  deckFitIssueSlides,
  deckFitScore,
  deckLayoutCapacityLine,
  describeDeckFitIssues,
} from "./deckLayoutCheck";
import { slideTextRegions } from "./deckGeometry";
import { blankSlideDeck, createDeckSlide, type DeckSlide, type SlideDeck } from "./deckModel";
import { DECK_NO_FIT, approximateDeckMeasure, deckFitAutofitAttributes, deckRegionFitWith } from "./deckTextFit";

const measure = approximateDeckMeasure;

function bulletsSlide(id: string, bullets: string[], title = "Quarterly results"): DeckSlide {
  const slide = createDeckSlide("title-bullets", id);
  if (slide.layout !== "title-bullets") throw new Error("layout");
  return {
    ...slide,
    title: [{ text: title }],
    bullets: bullets.map((text) => ({ runs: [{ text }], level: 0 as const })),
  };
}

function deckOf(...slides: DeckSlide[]): SlideDeck {
  return { ...blankSlideDeck("Fit"), slides };
}

test("each layout's capacity is stated in the prompt's own terms", () => {
  const line = deckLayoutCapacityLine("title-bullets");
  expect(line).toMatch(/^title ≤\d+ chars; bullets ≤\d+ one-line bullets of ~\d+ chars$/);
  expect(deckLayoutCapacityLine("quote")).toMatch(/^quote ≤\d+ lines of ~\d+ chars; attribution ≤\d+ chars$/);
});

test("a slide written to its capacity has no fit issues", () => {
  const deck = deckOf(bulletsSlide("s1", ["Pipeline grew 30 percent", "Two new regions opened", "Churn fell to 4 percent"]));
  expect(auditDeckLayout(deck, { measure })).toEqual([]);
});

test("too many words shrink below a readable size, and far too many overflow", () => {
  const paragraph = "Revenue across every region grew faster than the plan assumed, ".repeat(9);
  const tooSmall = bulletsSlide("s1", Array.from({ length: 8 }, () => paragraph));
  const overflow = bulletsSlide("s2", Array.from({ length: 8 }, () => paragraph.repeat(3).slice(0, 1990)));
  const issues = auditDeckLayout(deckOf(tooSmall, overflow), { measure });
  expect(issues.map((issue) => [issue.slideId, issue.region, issue.problem])).toEqual([
    ["s1", "bullets", "too-small"],
    ["s2", "bullets", "overflow"],
  ]);
  expect(deckFitScore(issues)).toBe(4);
  expect(deckFitIssueSlides(issues)).toEqual([1, 2]);
  const described = describeDeckFitIssues(deckOf(tooSmall, overflow), issues);
  expect(described).toContain('Slide 1 (id "s1", layout "title-bullets"):');
  expect(described).toContain('"bullets" (Bullets, 16pt)');
  expect(described).toMatch(/PowerPoint shrinks it to \d+% \([\d.]+pt\), too small to read/);
  expect(described).toContain("spills out of the box even at PowerPoint's smallest shrink");
});

test("a word wider than its box is reported as breaking mid-word", () => {
  const slide = createDeckSlide("title", "cover");
  if (slide.layout !== "title") throw new Error("layout");
  const issues = auditDeckLayout(deckOf({ ...slide, title: [{ text: "W".repeat(40) }] }), { measure });
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ region: "title", problem: "broken-word", brokenWord: "W".repeat(40) });
});

test("a long title shrinks to fit the way PowerPoint autofits, and the export records it", () => {
  const spec = slideTextRegions("title-bullets").title;
  const theme = blankSlideDeck("x").theme;
  const short = deckRegionFitWith(spec, [{ text: "Results" }], theme, measure);
  expect(short).toEqual({ fit: DECK_NO_FIT, fits: true });
  const long = deckRegionFitWith(spec, [{ text: "What the next three quarters will ask of every regional sales, service, and support team" }], theme, measure);
  expect(long.fits).toBe(true);
  expect(long.fit.fontScale).toBeLessThan(1);
  expect(deckFitAutofitAttributes(long.fit)).toMatch(/^( fontScale="\d+")? lnSpcReduction="\d+"$/);
  expect(deckFitAutofitAttributes(DECK_NO_FIT)).toBe("");
});

test("a revision checks only the slides whose words, layout, or boxes changed", () => {
  const before = deckOf(bulletsSlide("a", ["One"]), bulletsSlide("b", ["Two"]), bulletsSlide("c", ["Three"]));
  const after = deckOf(
    { ...before.slides[0], notes: "New notes only" },
    bulletsSlide("b", ["Two, reworded"]),
    { ...before.slides[2], boxes: { bullets: { x: 60, y: 140, w: 600, h: 300 } } },
    bulletsSlide("d", ["Brand new"]),
  );
  expect(changedDeckSlideIds(before, after)).toEqual(["b", "c", "d"]);
});
