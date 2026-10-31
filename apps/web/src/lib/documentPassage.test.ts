import { describe, expect, it } from "vitest";
import { findPassage, layerPieces, locatePassage, passageWithin, readableMarks, type PassageRange } from "./documentPassage";

function markedText(parts: string[], ranges: PassageRange[]): string[] {
  return ranges.map((range) => parts[range.part].slice(range.start, range.end));
}

const LONG_A = "The retention period for client files is seven years after the matter closes";
const LONG_B = "unless a court order requires the firm to keep them for a longer period of time";

describe("findPassage", () => {
  it("marks only the excerpt inside a single span", () => {
    const parts = ["Before the passage. Seven years applies here. After the passage."];
    expect(markedText(parts, findPassage(parts, "Seven years applies here."))).toEqual(["Seven years applies here"]);
  });

  it("marks across spans, whole middle spans included", () => {
    const parts = ["Intro then the first", " part (of", " the passage) ends", " here and more"];
    expect(markedText(parts, findPassage(parts, "the first part of the passage ends here"))).toEqual([
      "the first",
      " part (of",
      " the passage) ends",
      " here",
    ]);
  });

  it("is tolerant of whitespace and line breaks", () => {
    const parts = ["Clause   nine\tsurvives", "termination\nof this agreement"];
    expect(findPassage(parts, "Clause nine survives termination of this agreement")).not.toEqual([]);
  });

  it("joins a word hyphenated across a line", () => {
    const parts = ["the reten-", "tion schedule"];
    expect(markedText(parts, findPassage(parts, "the retention schedule"))).toEqual(["the reten-", "tion schedule"]);
  });

  it("ignores soft hyphens", () => {
    const parts = ["the reten­tion schedule"];
    expect(findPassage(parts, "the retention schedule")).toEqual([{ part: 0, start: 0, end: 23 }]);
  });

  it("folds ligatures, curly quotes, and case", () => {
    const parts = ["THE ﬁrst “Oﬃce” Rule"];
    expect(markedText(parts, findPassage(parts, 'the first "office" rule'))).toEqual(["THE ﬁrst “Oﬃce” Rule"]);
  });

  it("keeps offsets right after a character outside the basic plane", () => {
    const parts = ["😀 the policy applies"];
    expect(markedText(parts, findPassage(parts, "the policy applies"))).toEqual(["the policy applies"]);
  });

  it("marks the part of an excerpt that continues on the next page", () => {
    const parts = [`Earlier text. ${LONG_A}`];
    expect(markedText(parts, findPassage(parts, `${LONG_A} ${LONG_B}`))).toEqual([LONG_A]);
  });

  it("marks both sides when a page header interrupts the passage", () => {
    const parts = [LONG_A, "Page 12 of 60 Confidential", LONG_B];
    expect(markedText(parts, findPassage(parts, `${LONG_A} ${LONG_B}`))).toEqual([LONG_A, LONG_B]);
  });

  it("marks passages the extractor read in a different column order", () => {
    const parts = [LONG_B, "gutter", LONG_A];
    expect(markedText(parts, findPassage(parts, `${LONG_A} ${LONG_B}`))).toEqual([LONG_B, LONG_A]);
  });

  it("does not mark a page that only shares a short phrase with the excerpt", () => {
    const parts = ["Retention period for client files is unrelated here."];
    expect(findPassage(parts, `${LONG_A} ${LONG_B}`)).toEqual([]);
  });

  it("requires one run to reach the seed length", () => {
    const parts = ["abcdefghijklmnopqrs", "x".repeat(40), "abcdefghijklmnopqrst"];
    const wanted = `abcdefghijklmnopqrstZZ${"y".repeat(60)}`;
    expect(findPassage(parts, wanted)).toEqual([]);
  });

  it("accepts a partial match that reaches the minimum exactly", () => {
    const shared = "a1b2c3d4e5f6g7h8i9j0".repeat(3);
    const parts = [shared, "-----"];
    expect(findPassage(parts, `${shared}!! tail words that are absent`)).toEqual([{ part: 0, start: 0, end: 60 }]);
  });

  it("rejects a partial match just under the minimum", () => {
    const shared = "a1b2c3d4e5f6g7h8i9j0".repeat(3).slice(0, 59);
    const parts = [shared, "-----"];
    expect(findPassage(parts, `${shared}!! tail words that are absent`)).toEqual([]);
  });

  it("finds nothing on a page with no text", () => {
    expect(findPassage([], LONG_A)).toEqual([]);
    expect(findPassage(["", " "], LONG_A)).toEqual([]);
  });

  it("finds nothing for an excerpt with no words", () => {
    expect(findPassage(["some text"], "  ... ")).toEqual([]);
  });

  const OPENING = "abcdefghijklmnopqrstuvwxyz0123456789zyxwvutsrqponmlkjihgfedc";
  const FIRST = "abcdefghij0123456789klmnopqrst9876543210";
  const SECOND = "uvwxyz0246813579acegikmoqsuwy1357924680b";

  it("merges ranges that overlap inside one span", () => {
    expect(findPassage([OPENING], `${OPENING} Z ${OPENING}`)).toEqual([{ part: 0, start: 0, end: 60 }]);
  });

  it("sorts ranges into reading order inside one span", () => {
    expect(findPassage([`${SECOND} qq ${FIRST}`], `${FIRST} ${SECOND}`)).toEqual([
      { part: 0, start: 0, end: 40 },
      { part: 0, start: 44, end: 84 },
    ]);
  });

  it("finds a last stretch that ends both the page and the excerpt", () => {
    const tail = "9876543210mnbvcxzlkj";
    expect(findPassage([`${OPENING} qqq ${tail}`], `${OPENING} ${tail}`)).toEqual([
      { part: 0, start: 0, end: 60 },
      { part: 0, start: 65, end: 85 },
    ]);
  });

  it("matches composed and decomposed accents", () => {
    const parts = ["The résumé of the café"];
    expect(findPassage(parts, "The re\u0301sume\u0301 of the cafe\u0301")).toEqual([{ part: 0, start: 0, end: 22 }]);
    expect(findPassage(["The re\u0301sume\u0301"], "The résumé")).toEqual([{ part: 0, start: 0, end: 12 }]);
  });

  it("starts a mark at a word, when the stored chunk began mid-word", () => {
    const parts = ["under the prior county of the parcel"];
    expect(markedText(parts, findPassage(parts, "rior county of the parcel"))).toEqual(["county of the parcel"]);
  });

  it("ends a mark at a word, when the stored chunk stopped mid-word", () => {
    const parts = ["records the eastern boundary line"];
    expect(markedText(parts, findPassage(parts, "records the eastern bound"))).toEqual(["records the eastern"]);
  });

  it("snaps even when a single letter was cut off", () => {
    const parts = ["prior county line"];
    expect(markedText(parts, findPassage(parts, "rior county line"))).toEqual(["county line"]);
  });

  it("does not move a mark that already sits on word edges", () => {
    const parts = ["(records the eastern), then"];
    expect(markedText(parts, findPassage(parts, "records the eastern"))).toEqual(["records the eastern"]);
  });

  it("treats the start and end of a span as word edges", () => {
    const parts = ["records the eastern"];
    expect(markedText(parts, findPassage(parts, "records the eastern"))).toEqual(["records the eastern"]);
  });

  it("marks nothing when snapping leaves no whole word", () => {
    expect(findPassage(["county"], "ount")).toEqual([]);
  });

  it("leaves no empty mark when a span's only words were cut", () => {
    const parts = ["the pri", " county is here"];
    expect(markedText(parts, findPassage(parts, "ri county is here"))).toEqual([" county is here"]);
  });

  it("snaps past punctuation and spaces to the next word", () => {
    const parts = ["the prior, (county) line"];
    expect(markedText(parts, findPassage(parts, "rior county line"))).toEqual(["county) line"]);
  });

  it("marks the first of two equal occurrences", () => {
    expect(findPassage([OPENING, "gap", OPENING], `${OPENING}ZZ words not here`)).toEqual([
      { part: 0, start: 0, end: 60 },
    ]);
  });

  it("prefers the longest occurrence, wherever it is", () => {
    const parts = ["z".repeat(40), OPENING.slice(0, 30), "gap", OPENING];
    expect(findPassage(parts, `${OPENING}ZZ words not here`)).toEqual([{ part: 3, start: 0, end: 60 }]);
  });
});

describe("locatePassage", () => {
  const CHUNK = "Clause 9.1 covers fixtures in full. Clause 9.2 covers ordinary wear in full. Clause 9.3 excludes flood damage.";

  it("finds the chunk and the cited sentence inside it", () => {
    const parts = [`Heading. ${CHUNK} Footer.`];
    const { chunk, passage } = locatePassage(parts, CHUNK, "Clause 9.3 excludes flood damage.");
    expect(markedText(parts, chunk)).toEqual([CHUNK.slice(0, -1)]);
    expect(markedText(parts, passage)).toEqual(["Clause 9.3 excludes flood damage"]);
  });

  it("prefers the copy inside the chunk to an earlier copy on the page", () => {
    const sentence = "The notice period is thirty days in every case.";
    const chunk = `Other terms apply to the lease here. ${sentence} More terms follow.`;
    const parts = [`Preamble. ${sentence} Gap words here. ${chunk}`];
    const { passage } = locatePassage(parts, chunk, sentence);
    expect(passage).toEqual([{ part: 0, start: parts[0].lastIndexOf("The notice"), end: parts[0].lastIndexOf("days in every case") + 18 }]);
  });

  it("checks every stretch of a chunk split by a header", () => {
    const opening = "The first stretch of the chunk runs long enough to count as evidence here.";
    const closing = "The second stretch of the same chunk carries the sentence that was cited.";
    const parts = [opening, "Page 4 Confidential", closing];
    const { passage } = locatePassage(parts, `${opening} ${closing}`, closing);
    expect(markedText(parts, passage)).toEqual([closing.slice(0, -1)]);
  });

  const LONG_CHUNK = "Words in the middle of this chunk go on for long enough to count as evidence on the page.";
  const SENTENCE = "The notice period is thirty days in every case.";

  it("finds a sentence that sits before the chunk", () => {
    const parts = [`${SENTENCE} Gap words. ${LONG_CHUNK}`];
    expect(locatePassage(parts, LONG_CHUNK, SENTENCE).passage).toEqual([{ part: 0, start: 0, end: SENTENCE.length - 1 }]);
  });

  it("takes the first copy when no copy is inside the chunk", () => {
    const parts = [`Open. ${SENTENCE} Gap words. ${LONG_CHUNK} Later. ${SENTENCE}`];
    expect(locatePassage(parts, LONG_CHUNK, SENTENCE).passage).toEqual([{ part: 0, start: 6, end: 6 + SENTENCE.length - 1 }]);
  });

  it("counts a sentence that ends exactly where the chunk ends as inside it", () => {
    const chunk = `${LONG_CHUNK} ${SENTENCE}`;
    const parts = [`Open. ${SENTENCE} Gap words. ${chunk}`];
    const start = parts[0].lastIndexOf("The notice");
    expect(locatePassage(parts, chunk, SENTENCE).passage).toEqual([{ part: 0, start, end: start + SENTENCE.length - 1 }]);
  });

  it("finds nothing for a passage with no words", () => {
    expect(locatePassage([LONG_CHUNK], LONG_CHUNK, " ... ").passage).toEqual([]);
  });

  describe("a sentence that crosses a page", () => {
    const opening = "The chunk opens on the first page with plenty of words for evidence, and then the cited sentence begins here on this page";
    const tail = "and ends here on the next";
    const closing = "page, after which the chunk carries on with enough further words to count as evidence of its own.";
    const chunk = `${opening} ${tail} ${closing}`;
    const sentence = `the cited sentence begins here on this page ${tail} page, after`;

    it("marks the part on the first page", () => {
      const parts = [opening];
      expect(markedText(parts, locatePassage(parts, chunk, sentence).passage)).toEqual(["the cited sentence begins here on this page"]);
    });

    it("marks the short part on the next page, with no evidence floor of its own", () => {
      const parts = [`${tail} ${closing}`];
      expect(markedText(parts, locatePassage(parts, chunk, sentence).passage)).toEqual([`${tail} page, after`]);
    });

    it("marks nothing on a page that holds only other parts of the chunk", () => {
      const parts = [closing.replace("page, after which ", "")];
      expect(locatePassage(parts, chunk, sentence).passage).toEqual([]);
    });

    it("does not mark a repeat outside the chunk when the sentence is on the other page", () => {
      const parts = [`the cited sentence begins here on this page ${tail} page, after Gap words. ${closing}`];
      const { passage } = locatePassage(parts, `${closing} ${sentence} and more words of the chunk follow here.`, sentence);
      expect(markedText(parts, passage)).toEqual([`the cited sentence begins here on this page ${tail} page, after`]);
    });
  });

  it("marks both sides of a sentence split by a running header", () => {
    const first = "The first half of the chunk has enough words to count as evidence";
    const second = "and the second half of the chunk has enough words to count as well.";
    const parts = [first, "Page 12 Confidential", second];
    const { passage } = locatePassage(parts, `${first} ${second}`, "as evidence and the second half");
    expect(markedText(parts, passage)).toEqual(["as evidence", "and the second half"]);
  });

  it("takes the copy inside the chunk when the sentence opens the chunk", () => {
    const chunk = `${SENTENCE} ${LONG_CHUNK}`;
    const parts = [`Open. ${SENTENCE} Gap words. ${chunk}`];
    const start = parts[0].lastIndexOf("The notice");
    expect(locatePassage(parts, chunk, SENTENCE).passage).toEqual([{ part: 0, start, end: start + SENTENCE.length - 1 }]);
  });

  it("still finds a passage when the chunk cannot be matched", () => {
    const parts = ["An exact sentence sits on this page alone."];
    const { chunk, passage } = locatePassage(parts, "Entirely different chunk text that is not on this page at all.", "An exact sentence");
    expect(chunk).toEqual([]);
    expect(markedText(parts, passage)).toEqual(["An exact sentence"]);
  });

  it("finds no passage when the page does not hold it", () => {
    expect(locatePassage(["Some page text."], "Some page text.", "Words from elsewhere.").passage).toEqual([]);
  });

  it("marks only the chunk without a passage", () => {
    const { chunk, passage } = locatePassage(["Some page text."], "Some page text.", null);
    expect(chunk).toHaveLength(1);
    expect(passage).toEqual([]);
  });
});

describe("readableMarks", () => {
  it("joins marked pieces into one line", () => {
    expect(readableMarks(["The Stafford office", " confirmed  it."])).toBe("The Stafford office confirmed it.");
  });

  it("adds the space a line break stood for", () => {
    expect(readableMarks(["end of a line", "start of the next"])).toBe("end of a line start of the next");
  });

  it("rejoins a word hyphenated across lines", () => {
    expect(readableMarks(["the prede-", "cessor agreement"])).toBe("the predecessor agreement");
  });

  it("keeps a hyphen before a capital, which is a real one", () => {
    expect(readableMarks(["the Anglo-", "Saxon rule"])).toBe("the Anglo- Saxon rule");
  });

  it("is empty for nothing", () => {
    expect(readableMarks([])).toBe("");
  });
});

describe("passageWithin", () => {
  it("accepts a passage that is part of the excerpt", () => {
    expect(passageWithin("The cited sentence sits here. Others follow.", "cited sentence sits here")).toBe(true);
  });

  it("tolerates the same differences the page does", () => {
    expect(passageWithin("The reten-\ntion period", "the retention period")).toBe(true);
  });

  it("refuses text the excerpt does not hold", () => {
    expect(passageWithin("The cited sentence.", "A forged sentence.")).toBe(false);
  });

  it("accepts a one-character passage", () => {
    expect(passageWithin("a b", "b")).toBe(true);
  });

  it("refuses a passage with no words", () => {
    expect(passageWithin("The cited sentence.", " ... ")).toBe(false);
  });
});

describe("layerPieces", () => {
  it("cuts text into plain, tinted, and solid pieces in order", () => {
    expect(layerPieces("abcdefgh", [{ start: 1, end: 6 }], [{ start: 2, end: 4 }])).toEqual([
      { text: "a", level: "none" },
      { text: "b", level: "tint" },
      { text: "cd", level: "solid" },
      { text: "ef", level: "tint" },
      { text: "gh", level: "none" },
    ]);
  });

  it("leaves no empty pieces at the edges", () => {
    expect(layerPieces("abc", [], [{ start: 0, end: 3 }])).toEqual([{ text: "abc", level: "solid" }]);
  });

  it("handles separate ranges", () => {
    expect(layerPieces("abcd", [], [{ start: 0, end: 1 }, { start: 3, end: 4 }])).toEqual([
      { text: "a", level: "solid" },
      { text: "bc", level: "none" },
      { text: "d", level: "solid" },
    ]);
  });

  it("returns the whole text when nothing is marked", () => {
    expect(layerPieces("abc", [], [])).toEqual([{ text: "abc", level: "none" }]);
  });

  it("returns nothing for empty text", () => {
    expect(layerPieces("", [], [])).toEqual([]);
  });
});
