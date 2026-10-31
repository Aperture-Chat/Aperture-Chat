import { describe, expect, it } from "vitest";
import {
  PAGE_GAP,
  anchorAt,
  anchorTop,
  canvasPixelRatio,
  clampPage,
  currentPage,
  fitScale,
  markLevel,
  pageLayout,
  pageNoun,
  pagePosition,
  panStep,
  paperSheets,
  passageExcerpt,
  passageNote,
  passagePages,
  passageScrollTop,
  placeLabel,
  readableExcerpt,
  resolvePageInput,
  sheetMarks,
  sheetPositionLabel,
  stepZoom,
  strongerMark,
  targetSheetIndex,
  viewNoticeText,
  viewWithPageHint,
  visiblePages,
} from "./documentViewerModel";
import type { KnowledgeDocumentSegment, KnowledgeDocumentTarget, KnowledgeDocumentView } from "./types";

const LETTER = { width: 600, height: 800 };

function target(fields: Partial<KnowledgeDocumentTarget> = {}): KnowledgeDocumentTarget {
  return { page: null, page_end: null, locator: null, excerpt: "", chunk_id: null, exact: true, ...fields };
}

function segment(id: string, fields: Partial<KnowledgeDocumentSegment> = {}): KnowledgeDocumentSegment {
  return { id, page: null, locator: null, text: "words", ...fields };
}

describe("pageLayout", () => {
  it("stacks estimated pages with a gap and an outer margin", () => {
    const layout = pageLayout(3, new Map(), LETTER, 1);
    expect(layout.tops).toEqual([PAGE_GAP, PAGE_GAP + 800 + PAGE_GAP, PAGE_GAP + 2 * (800 + PAGE_GAP)]);
    expect(layout.total).toBe(3 * 800 + 4 * PAGE_GAP);
    expect(layout.widest).toBe(600);
  });

  it("uses a measured page where it has one", () => {
    const layout = pageLayout(3, new Map([[2, { width: 900, height: 300 }]]), LETTER, 2);
    expect(layout.heights).toEqual([1600, 600, 1600]);
    expect(layout.widths).toEqual([1200, 1800, 1200]);
    expect(layout.tops[2]).toBe(PAGE_GAP * 3 + 1600 + 600);
    expect(layout.widest).toBe(1800);
  });
});

describe("currentPage", () => {
  const layout = pageLayout(5, new Map(), LETTER, 1);

  it("is the page at the top of the view", () => {
    expect(currentPage(layout, 0, 700)).toBe(1);
    expect(currentPage(layout, layout.tops[2], 700)).toBe(3);
  });

  it("moves on just past a page's top edge, not before", () => {
    expect(currentPage(layout, layout.tops[2] - 41, 700)).toBe(2);
    expect(currentPage(layout, layout.tops[2] - 40, 700)).toBe(3);
  });

  it("reports a short last page once the scroll reaches the end", () => {
    const shortLast = pageLayout(5, new Map([[5, { width: 600, height: 100 }]]), LETTER, 1);
    const end = shortLast.total - 700;
    expect(currentPage(shortLast, end, 700)).toBe(5);
    expect(currentPage(shortLast, end - 1, 700)).toBe(5);
    expect(currentPage(shortLast, end - 2, 700)).toBe(4);
  });

  it("reads a position on a very short sheet", () => {
    const short = { tops: [0], heights: [0.5], widths: [], total: 1, widest: 0 };
    expect(anchorAt(short, 0.25).fraction).toBe(0.5);
  });

  it("reads the view's middle against a zero-height sheet safely", () => {
    const flat = { tops: [0, 0], heights: [0, 0], widths: [], total: 0, widest: 0 };
    expect(anchorAt(flat, 0)).toEqual({ page: 2, fraction: 0, viewOffset: 0 });
  });

  it("does not jump to the end before the view has a size", () => {
    expect(currentPage(layout, 0, 0)).toBe(1);
  });
});

describe("visiblePages", () => {
  const layout = pageLayout(100, new Map(), LETTER, 1);

  it("keeps only the pages around the view", () => {
    expect(visiblePages(layout, layout.tops[39], 700, 1)).toEqual([39, 40, 41]);
  });

  it("includes a page that is only just in view", () => {
    expect(visiblePages(layout, layout.tops[39], 800 + PAGE_GAP + 1, 0)).toEqual([40, 41]);
    expect(visiblePages(layout, layout.tops[39], 800 + PAGE_GAP, 0)).toEqual([40]);
  });

  it("stops at the document's ends", () => {
    expect(visiblePages(layout, 0, 700, 1)).toEqual([1, 2]);
    expect(visiblePages(layout, layout.tops[99], 700, 2)).toEqual([98, 99, 100]);
  });

  it("does not render the whole document for a tall view", () => {
    expect(visiblePages(pageLayout(500, new Map(), LETTER, 1), 0, 2000, 1).length).toBeLessThan(6);
  });
});

describe("anchors", () => {
  it("round-trips a scroll position inside a page", () => {
    const layout = pageLayout(5, new Map(), LETTER, 1);
    const top = layout.tops[2] + 200;
    expect(anchorAt(layout, top)).toEqual({ page: 3, fraction: 0.25, viewOffset: 0 });
    expect(anchorTop(layout, anchorAt(layout, top))).toBe(top);
  });

  it("holds the middle of the view steady through a zoom", () => {
    const before = pageLayout(5, new Map(), LETTER, 1);
    const after = pageLayout(5, new Map(), LETTER, 2);
    const anchor = anchorAt(before, before.tops[2], 400);
    expect(anchor).toEqual({ page: 3, fraction: 0.5, viewOffset: 400 });
    expect(anchorTop(after, anchor)).toBe(after.tops[2] + 800 - 400);
  });

  it("measures a position against its own page's height", () => {
    const uneven = pageLayout(5, new Map([[3, { width: 600, height: 400 }]]), LETTER, 1);
    const anchor = anchorAt(uneven, uneven.tops[2] + 100);
    expect(anchor.fraction).toBe(0.25);
    expect(anchorTop(uneven, anchor)).toBe(uneven.tops[2] + 100);
  });

  it("never asks to scroll above the document", () => {
    const layout = pageLayout(5, new Map(), LETTER, 1);
    expect(anchorTop(layout, { page: 1, fraction: 0, viewOffset: 400 })).toBe(0);
  });

  it("keeps the same text in view through a zoom", () => {
    const before = pageLayout(5, new Map(), LETTER, 1);
    const after = pageLayout(5, new Map(), LETTER, 2);
    expect(anchorTop(after, anchorAt(before, before.tops[2] + 200))).toBe(after.tops[2] + 400);
  });

  it("stays on a page when an earlier page turns out to be another size", () => {
    const before = pageLayout(5, new Map(), LETTER, 1);
    const after = pageLayout(5, new Map([[1, { width: 600, height: 300 }]]), LETTER, 1);
    expect(anchorTop(after, anchorAt(before, before.tops[3]))).toBe(after.tops[3]);
  });

  it("anchors the gap above a page to that page's top", () => {
    const layout = pageLayout(2, new Map(), LETTER, 1);
    expect(anchorAt(layout, 0)).toEqual({ page: 1, fraction: 0, viewOffset: 0 });
  });
});

describe("clampPage", () => {
  it("keeps a page inside the document", () => {
    expect(clampPage(40, 60)).toBe(40);
    expect(clampPage(0, 60)).toBe(1);
    expect(clampPage(61, 60)).toBe(60);
  });
});

describe("fitScale", () => {
  it("fits the page to the width available", () => {
    expect(fitScale(630, 600)).toBeCloseTo(1, 5);
    expect(fitScale(330, 600)).toBeCloseTo(0.5, 5);
  });

  it("does not blow a page up on a wide screen", () => {
    expect(fitScale(4000, 600)).toBe(1.6);
  });

  it("falls back before the view has a size", () => {
    expect(fitScale(0, 600)).toBe(1);
    expect(fitScale(800, 0)).toBe(1);
  });

  it("never goes negative in a view narrower than its margin", () => {
    expect(fitScale(30, 600)).toBe(1);
    expect(fitScale(31, 600)).toBeCloseTo(1 / 600, 8);
  });

  it("fits even a tiny page", () => {
    expect(fitScale(800, 1)).toBe(1.6);
  });
});

describe("stepZoom", () => {
  it("walks the zoom stops", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
  });

  it("stops at both ends", () => {
    expect(stepZoom(3, 1)).toBe(3);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });
});

describe("canvasPixelRatio", () => {
  it("uses the device ratio for an ordinary page", () => {
    expect(canvasPixelRatio(600, 800, 2)).toBe(2);
  });

  it("holds a huge page under the canvas limit that phones enforce", () => {
    const ratio = canvasPixelRatio(4000, 5000, 3);
    expect(4000 * 5000 * ratio * ratio).toBeLessThanOrEqual(16_000_000);
    expect(ratio).toBeCloseTo(Math.sqrt(16_000_000 / 20_000_000), 5);
  });

  it("treats a missing device ratio as one", () => {
    expect(canvasPixelRatio(600, 800, 0)).toBe(1);
  });
});

describe("passagePages", () => {
  it("covers a passage's page range inside the document", () => {
    expect(passagePages(target({ page: 40, page_end: 41 }), 60)).toEqual({ first: 40, last: 41 });
  });

  it("clamps a stale page to the document", () => {
    expect(passagePages(target({ page: 70, page_end: 72 }), 60)).toEqual({ first: 60, last: 60 });
  });

  it("is a single page without an end", () => {
    expect(passagePages(target({ page: 7 }), 60)).toEqual({ first: 7, last: 7 });
  });

  it("is nothing without a target or a page", () => {
    expect(passagePages(null, 60)).toBeNull();
    expect(passagePages(target(), 60)).toBeNull();
  });
});

describe("passageExcerpt", () => {
  const cited = target({ page: 40, page_end: 41, excerpt: "words" });
  const pages = { first: 40, last: 41 };

  it("looks for the words on the passage's pages only", () => {
    expect(passageExcerpt(39, pages, cited)).toBeNull();
    expect(passageExcerpt(40, pages, cited)).toBe("words");
    expect(passageExcerpt(41, pages, cited)).toBe("words");
    expect(passageExcerpt(42, pages, cited)).toBeNull();
  });

  it("looks for nothing without a passage", () => {
    expect(passageExcerpt(40, null, cited)).toBeNull();
    expect(passageExcerpt(40, pages, null)).toBeNull();
  });
});

describe("passageScrollTop", () => {
  it("puts the passage a quarter of the way down the view", () => {
    expect(passageScrollTop({ markTop: 5000, pageTop: 4000, viewportHeight: 800 })).toBe(4800);
  });

  it("does not scroll past the top of the passage's page", () => {
    expect(passageScrollTop({ markTop: 4020, pageTop: 4000, viewportHeight: 800 })).toBe(4000 - PAGE_GAP);
  });
});

describe("paperSheets", () => {
  it("gathers chunks of one page onto one sheet, in order", () => {
    const sheets = paperSheets([
      segment("a", { page: 1, locator: "Page 1" }),
      segment("b", { page: 1, locator: "Page 1" }),
      segment("c", { page: 2, locator: "Page 2" }),
    ]);
    expect(sheets.map((sheet) => [sheet.heading, sheet.page, sheet.segments.map((item) => item.id)])).toEqual([
      ["Page 1", 1, ["a", "b"]],
      ["Page 2", 2, ["c"]],
    ]);
  });

  it("uses the locator for slides and sheets", () => {
    expect(paperSheets([segment("a", { locator: "Sheet: Q3" })])[0].heading).toBe("Sheet: Q3");
  });

  it("writes a page heading when only the number is known", () => {
    expect(paperSheets([segment("a", { page: 4 })])[0].heading).toBe("Page 4");
  });

  it("does not invent a heading", () => {
    expect(paperSheets([segment("a")])[0].heading).toBeNull();
  });

  it("breaks a long unpaged document into sheets at the size limit", () => {
    const sheets = paperSheets([
      segment("a", { text: "x".repeat(2000) }),
      segment("b", { text: "x".repeat(1200) }),
      segment("c", { text: "x" }),
    ]);
    expect(sheets.map((sheet) => sheet.segments.map((item) => item.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("starts a new sheet when the page changes under one locator", () => {
    const sheets = paperSheets([
      segment("a", { locator: "Sheet: Q3", page: 1 }),
      segment("b", { locator: "Sheet: Q3", page: 2 }),
    ]);
    expect(sheets).toHaveLength(2);
  });

  it("does not split a located sheet, however long", () => {
    const sheets = paperSheets([
      segment("a", { locator: "Sheet: Q3", text: "x".repeat(4000) }),
      segment("b", { locator: "Sheet: Q3", text: "x".repeat(4000) }),
    ]);
    expect(sheets).toHaveLength(1);
  });

  it("is empty for an empty document", () => {
    expect(paperSheets([])).toEqual([]);
  });
});

describe("targetSheetIndex", () => {
  const sheets = paperSheets([
    segment("a", { page: 1, locator: "Page 1" }),
    segment("b", { page: 2, locator: "Page 2" }),
    segment("c", { locator: "Sheet: Q3" }),
  ]);

  it("prefers the chunk itself", () => {
    expect(targetSheetIndex(sheets, target({ chunk_id: "b", page: 1 }))).toBe(1);
  });

  it("trusts the chunk over the page, even on the first sheet", () => {
    expect(targetSheetIndex(sheets, target({ chunk_id: "a", page: 2 }))).toBe(0);
  });

  it("falls back to the page", () => {
    expect(targetSheetIndex(sheets, target({ chunk_id: "gone", page: 2 }))).toBe(1);
  });

  it("falls back to the locator", () => {
    expect(targetSheetIndex(sheets, target({ chunk_id: "gone", locator: "Sheet: Q3" }))).toBe(2);
  });

  it("opens at the top without a target or a match", () => {
    expect(targetSheetIndex(sheets, null)).toBe(0);
    expect(targetSheetIndex(sheets, target({ chunk_id: "gone", page: 9, locator: "Slide 9" }))).toBe(0);
  });
});

describe("sheetMarks", () => {
  const sheet = paperSheets([
    segment("a", { text: "First chunk of the document here." }),
    segment("b", { text: "Second chunk that holds the passage." }),
  ])[0];

  it("tints the chunk when no sentence was singled out", () => {
    const marks = sheetMarks(sheet, target({ chunk_id: "b", excerpt: "holds the passage" }), null);
    expect(marks.get("b")).toEqual({ tint: [{ start: 18, end: 35 }], solid: [] });
    expect(marks.has("a")).toBe(false);
  });

  it("tints the whole chunk when the words do not match", () => {
    const marks = sheetMarks(sheet, target({ chunk_id: "b", excerpt: "completely different text" }), null);
    expect(marks.get("b")).toEqual({ tint: [{ start: 0, end: sheet.segments[1].text.length }], solid: [] });
  });

  it("marks nothing when neither the words nor the chunk are here", () => {
    expect(sheetMarks(sheet, target({ chunk_id: "zzz", excerpt: "completely different" }), null).size).toBe(0);
  });

  it("marks nothing without a target", () => {
    expect(sheetMarks(sheet, null, null).size).toBe(0);
  });

  it("makes the cited sentence solid and tints the rest of the chunk", () => {
    const marks = sheetMarks(sheet, target({ chunk_id: "b", excerpt: sheet.segments[1].text }), "holds the passage");
    expect(marks.get("b")).toEqual({ tint: [{ start: 0, end: 35 }], solid: [{ start: 18, end: 35 }] });
  });

  it("tints the chunk when the sentence is not on the sheet", () => {
    const marks = sheetMarks(sheet, target({ chunk_id: "b", excerpt: "holds the passage" }), "Words from elsewhere.");
    expect(marks.get("b")).toEqual({ tint: [{ start: 18, end: 35 }], solid: [] });
  });
});

describe("sheetPositionLabel", () => {
  it("counts pages when the sheet has one", () => {
    expect(sheetPositionLabel({ page: 3, heading: "Page 3" }, 2, 9, 212)).toBe("Page 3 of 212");
  });

  it("does not claim a total the server did not give", () => {
    expect(sheetPositionLabel({ page: 3, heading: "Page 3" }, 2, 9, null)).toBe("Page 3");
  });

  it("uses the heading for slides and worksheets", () => {
    expect(sheetPositionLabel({ page: null, heading: "Sheet: Q3" }, 1, 3, null)).toBe("Sheet: Q3");
  });

  it("counts sections when nothing else is known", () => {
    expect(sheetPositionLabel({ page: null, heading: null }, 1, 3, null)).toBe("Section 2 of 3");
  });
});

describe("pageNoun", () => {
  it("calls presentation pages slides", () => {
    expect(pageNoun("application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("Slide");
    expect(pageNoun("application/vnd.ms-powerpoint")).toBe("Slide");
    expect(pageNoun("application/vnd.oasis.opendocument.presentation")).toBe("Slide");
  });

  it("calls everything else a page", () => {
    expect(pageNoun("application/pdf")).toBe("Page");
    expect(pageNoun("")).toBe("Page");
  });
});

describe("markLevel", () => {
  it("is the strongest of what a page marked", () => {
    expect(markLevel(0, 0)).toBe("none");
    expect(markLevel(3, 0)).toBe("tint");
    expect(markLevel(1, 0)).toBe("tint");
    expect(markLevel(3, 1)).toBe("solid");
    expect(markLevel(0, 1)).toBe("solid");
  });
});

describe("strongerMark", () => {
  it("keeps the strongest level seen across pages", () => {
    expect(strongerMark(null, "none")).toBe("none");
    expect(strongerMark("none", "tint")).toBe("tint");
    expect(strongerMark("tint", "none")).toBe("tint");
    expect(strongerMark("tint", "solid")).toBe("solid");
    expect(strongerMark("solid", "tint")).toBe("solid");
  });
});

describe("passageNote", () => {
  it("waits until the page has been read", () => {
    expect(passageNote(null, false)).toBeNull();
    expect(passageNote(null, true)).toBeNull();
  });

  it("has nothing to add once the sentence is marked", () => {
    expect(passageNote("solid", true)).toBeNull();
  });

  it("says when nothing could be marked", () => {
    expect(passageNote("none", true)).toMatch(/could not be marked/);
    expect(passageNote("none", false)).toMatch(/could not be marked/);
  });

  it("is honest that no sentence was singled out", () => {
    expect(passageNote("tint", false)).toMatch(/whole passage is shaded/);
    expect(passageNote("tint", false)).toMatch(/did not single out/);
  });

  it("says so when a chosen sentence could not be found on the page", () => {
    expect(passageNote("tint", true)).toMatch(/could not be picked out/);
  });
});

describe("pagePosition", () => {
  it("counts pages when a file has no labels", () => {
    expect(pagePosition("Page", 40, 60, null)).toEqual({
      printed: "40",
      suffix: "of 60",
      compactSuffix: "of 60",
      label: "Page 40 of 60",
    });
  });

  it("uses the deck's own word", () => {
    expect(pagePosition("Slide", 7, 9, null).label).toBe("Slide 7 of 9");
  });

  it("shows the printed number and keeps the file's position", () => {
    const labels = ["i", "ii", "1", "2"];
    expect(pagePosition("Page", 4, 4, labels)).toEqual({
      printed: "2",
      suffix: "(PDF page 4 of 4)",
      compactSuffix: "PDF 4/4",
      label: "Page 2 (PDF page 4 of 4)",
    });
  });

  it("stays simple when the label agrees with the position", () => {
    expect(pagePosition("Page", 2, 4, ["1", "2", "3", "4"]).suffix).toBe("of 4");
  });

  it("trims a label and ignores an empty one", () => {
    expect(pagePosition("Page", 1, 2, ["  iv "]).printed).toBe("iv");
    expect(pagePosition("Page", 1, 2, ["   "]).printed).toBe("1");
    expect(pagePosition("Page", 2, 2, ["i"]).printed).toBe("2");
  });
});

describe("resolvePageInput", () => {
  it("takes a page in the document", () => {
    expect(resolvePageInput("12", 60, null)).toBe(12);
    expect(resolvePageInput(" 12 ", 60, null)).toBe(12);
  });

  it("clamps numbers past either end", () => {
    expect(resolvePageInput("0", 60, null)).toBe(1);
    expect(resolvePageInput("9999", 60, null)).toBe(60);
  });

  it("restores on anything that is not a page", () => {
    expect(resolvePageInput("", 60, null)).toBeNull();
    expect(resolvePageInput("   ", 60, null)).toBeNull();
    expect(resolvePageInput("abc", 60, null)).toBeNull();
    expect(resolvePageInput("-3", 60, null)).toBeNull();
    expect(resolvePageInput("1.5", 60, null)).toBeNull();
    expect(resolvePageInput("4e2", 60, null)).toBeNull();
  });

  const labels = ["i", "ii", "iii", "1", "2", "3"];

  it("finds a printed page first", () => {
    expect(resolvePageInput("2", 6, labels)).toBe(5);
    expect(resolvePageInput("iii", 6, labels)).toBe(3);
  });

  it("finds a printed label on the very first page", () => {
    expect(resolvePageInput("i", 6, labels)).toBe(1);
  });

  it("finds a printed label on the second page", () => {
    expect(resolvePageInput("ii", 6, labels)).toBe(2);
  });

  it("ignores case in a printed page", () => {
    expect(resolvePageInput("III", 6, labels)).toBe(3);
  });

  it("falls back to the position in the file", () => {
    expect(resolvePageInput("6", 6, labels)).toBe(6);
  });
});

describe("placeLabel", () => {
  it("uses the stored locator for a single place", () => {
    expect(placeLabel(target({ locator: "Slide 3" }), null, "Page")).toBe("Slide 3");
  });

  it("writes the page when only the number is known", () => {
    expect(placeLabel(target({ page: 4, page_end: 4 }), null, "Page")).toBe("Page 4");
  });

  it("writes a range when the passage crosses pages", () => {
    expect(placeLabel(target({ page: 1, page_end: 2, locator: "Page 1" }), null, "Page")).toBe("Pages 1–2");
  });

  it("shows the printed page with the file's position", () => {
    const labels = ["i", "ii", "1", "2"];
    expect(placeLabel(target({ page: 4, page_end: 4, locator: "Page 4" }), labels, "Page")).toBe("Page 2 (PDF page 4)");
  });

  it("names the file's pages when only the end of a range is relabelled", () => {
    expect(placeLabel(target({ page: 3, page_end: 4 }), ["1", "2", "3", "x"], "Page")).toBe("Pages 3–x (PDF pages 3–4)");
  });

  it("shows a printed range", () => {
    const labels = ["i", "ii", "1", "2"];
    expect(placeLabel(target({ page: 3, page_end: 4 }), labels, "Page")).toBe("Pages 1–2 (PDF pages 3–4)");
  });

  it("uses the deck's word", () => {
    expect(placeLabel(target({ page: 2, page_end: 3 }), null, "Slide")).toBe("Slides 2–3");
  });

  it("invents nothing", () => {
    expect(placeLabel(target(), null, "Page")).toBeNull();
  });
});

describe("readableExcerpt", () => {
  it("leaves a whole sentence alone", () => {
    expect(readableExcerpt("The term is seven years.")).toBe("The term is seven years.");
  });

  it("starts at a whole word when the chunk began inside one", () => {
    expect(readableExcerpt("rior county of the parcel. Next sentence.")).toBe("… county of the parcel. Next sentence.");
  });

  it("ends at a whole word when the chunk stopped inside one", () => {
    expect(readableExcerpt("The notice is due in thir")).toBe("The notice is due in …");
  });

  it("keeps an opening that starts a sentence", () => {
    expect(readableExcerpt("(a) The tenant pays.")).toBe("(a) The tenant pays.");
    expect(readableExcerpt("9.3 Exclusions apply.")).toBe("9.3 Exclusions apply.");
  });

  it("turns spreadsheet pipes into separators", () => {
    expect(readableExcerpt("Parcel 031 | Tamsin | 811.")).toBe("Parcel 031 · Tamsin · 811.");
  });

  it("collapses blank lines", () => {
    expect(readableExcerpt("One.\n\n\nTwo.")).toBe("One.\n\nTwo.");
  });

  it("does not eat a one-word excerpt", () => {
    expect(readableExcerpt("word")).toBe("word");
  });
});

describe("panStep", () => {
  const wide = { scrollLeft: 100, clientWidth: 500, scrollWidth: 900 };

  it("pans a page wider than the view", () => {
    expect(panStep("ArrowRight", wide)).toBeGreaterThan(0);
    expect(panStep("ArrowLeft", wide)).toBeLessThan(0);
  });

  it("stops panning at each edge, so the arrow turns the page", () => {
    expect(panStep("ArrowLeft", { ...wide, scrollLeft: 0 })).toBe(0);
    expect(panStep("ArrowRight", { ...wide, scrollLeft: 400 })).toBe(0);
  });

  it("still pans one pixel from each edge", () => {
    expect(panStep("ArrowLeft", { ...wide, scrollLeft: 1 })).toBeLessThan(0);
    expect(panStep("ArrowRight", { ...wide, scrollLeft: 399 })).toBeGreaterThan(0);
  });

  it("treats a fraction of a pixel from the edge as the edge", () => {
    expect(panStep("ArrowLeft", { ...wide, scrollLeft: 0.5 })).toBe(0);
    expect(panStep("ArrowRight", { ...wide, scrollLeft: 399.5 })).toBe(0);
  });

  it("does nothing when the page fits", () => {
    expect(panStep("ArrowRight", { scrollLeft: 0, clientWidth: 900, scrollWidth: 900 })).toBe(0);
  });

  it("ignores other keys", () => {
    expect(panStep("ArrowUp", wide)).toBe(0);
  });
});

describe("viewWithPageHint", () => {
  const view = { target: null, page_count: 60 } as KnowledgeDocumentView;

  it("aims a view with no target at the page the citation named, marked inexact", () => {
    expect(viewWithPageHint(view, 5).target).toEqual(
      target({ page: 5, page_end: 5, exact: false }),
    );
  });

  it("leaves a found target alone", () => {
    const found = { ...view, target: target({ page: 9 }) };
    expect(viewWithPageHint(found, 5)).toBe(found);
  });

  it("leaves the view alone with no hint", () => {
    expect(viewWithPageHint(view, null)).toBe(view);
  });
});

describe("viewNoticeText", () => {
  it("explains every notice in plain words", () => {
    expect(viewNoticeText("original_missing")).toMatch(/original file is not available/i);
    expect(viewNoticeText("conversion_unavailable")).toMatch(/cannot show this file type/i);
    expect(viewNoticeText("conversion_failed")).toMatch(/could not be prepared/i);
    expect(viewNoticeText("privacy_restricted")).toMatch(/privacy/i);
  });

  it("says nothing when there is nothing to say", () => {
    expect(viewNoticeText(null)).toBeNull();
  });
});
