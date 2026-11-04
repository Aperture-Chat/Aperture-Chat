import { describe, expect, it } from "vitest";
import {
  commonSubsequence,
  diff3,
  htmlBlocks,
  mergeDraftContent,
  mergeDraftHtml,
  mergeDraftJson,
  myersCommonSubsequence,
  tokenizeHtml,
} from "./draftMerge";

const page = (body: string) => `<section class="document-sheet">${body}</section>`;

describe("diff3", () => {
  it("keeps both sides' changes when they touch different places", () => {
    const merged = diff3(["a", "b", "c", "d"], ["a", "B", "c", "d"], ["a", "b", "c", "D"], {
      equal: (x, y) => x === y,
      conflict: (region) => region.mine,
    });
    expect(merged.items).toEqual(["a", "B", "c", "D"]);
    expect(merged.conflicts).toBe(0);
  });

  it("asks the resolver only where both sides changed the same place", () => {
    const seen: string[][] = [];
    const merged = diff3(["a", "b", "c"], ["a", "X", "c"], ["a", "Y", "c"], {
      equal: (x, y) => x === y,
      conflict: (region) => {
        seen.push([...region.base, "|", ...region.mine, "|", ...region.theirs]);
        return region.mine;
      },
    });
    expect(seen).toEqual([["b", "|", "X", "|", "Y"]]);
    expect(merged.items).toEqual(["a", "X", "c"]);
    expect(merged.conflicts).toBe(1);
  });

  it("does not count the same change made on both sides as a conflict", () => {
    const merged = diff3(["a", "b"], ["a", "c"], ["a", "c"], { equal: (x, y) => x === y, conflict: (r) => r.mine });
    expect(merged).toEqual({ items: ["a", "c"], conflicts: 0 });
  });
});

describe("mergeDraftHtml", () => {
  const base = page("<p>Alpha one.</p><p>Beta two.</p><p>Gamma three.</p>");

  it("returns the other side untouched when one side made no change", () => {
    const mine = page("<p>Alpha one, edited.</p><p>Beta two.</p><p>Gamma three.</p>");
    expect(mergeDraftHtml(base, base, mine).value).toBe(mine);
    expect(mergeDraftHtml(base, mine, base).value).toBe(mine);
  });

  it("keeps edits two people made in different paragraphs", () => {
    const mine = page("<p>Alpha one, by me.</p><p>Beta two.</p><p>Gamma three.</p>");
    const theirs = page("<p>Alpha one.</p><p>Beta two.</p><p>Gamma three, by them.</p>");
    expect(mergeDraftHtml(base, mine, theirs)).toEqual({
      value: page("<p>Alpha one, by me.</p><p>Beta two.</p><p>Gamma three, by them.</p>"),
      conflicts: 0,
    });
  });

  it("keeps edits two people made to different words of one paragraph", () => {
    const one = page("<p>The quick brown fox jumps over the lazy dog.</p>");
    const mine = page("<p>The quick red fox jumps over the lazy dog.</p>");
    const theirs = page("<p>The quick brown fox jumps over the sleepy dog.</p>");
    expect(mergeDraftHtml(one, mine, theirs)).toEqual({
      value: page("<p>The quick red fox jumps over the sleepy dog.</p>"),
      conflicts: 0,
    });
  });

  it("keeps both people's words when they type at the same spot, theirs first", () => {
    const one = page("<p>Signed by</p>");
    const mine = page("<p>Signed by Ana</p>");
    const theirs = page("<p>Signed by Ben</p>");
    const merged = mergeDraftHtml(one, mine, theirs);
    expect(merged.value).toBe(page("<p>Signed by Ben Ana</p>"));
    expect(merged.conflicts).toBe(1);
  });

  it("lets my wording win when both people rewrote the same words", () => {
    const one = page("<p>Due in thirty days.</p>");
    const mine = page("<p>Due in ten days.</p>");
    const theirs = page("<p>Due in sixty days.</p>");
    const merged = mergeDraftHtml(one, mine, theirs);
    expect(merged.value).toBe(mine);
    expect(merged.conflicts).toBe(1);
  });

  it("never splits a tag while merging formatting and text changes", () => {
    const one = page("<p>Payment terms apply.</p>");
    const mine = page("<p><strong>Payment</strong> terms apply.</p>");
    const theirs = page("<p>Payment terms always apply.</p>");
    expect(mergeDraftHtml(one, mine, theirs).value).toBe(page("<p><strong>Payment</strong> terms always apply.</p>"));
  });

  it("merges a page reflow on one side with typing on the other", () => {
    const two = `${page("<p>One.</p><p>Two.</p>")}${page("<p>Three.</p>")}`;
    const reflowed = `${page("<p>One.</p>")}${page("<p>Two.</p><p>Three.</p>")}`;
    const typed = `${page("<p>One.</p><p>Two.</p>")}${page("<p>Three, typed.</p>")}`;
    expect(mergeDraftHtml(two, reflowed, typed).value).toBe(`${page("<p>One.</p>")}${page("<p>Two.</p><p>Three, typed.</p>")}`);
  });

  it("adds paragraphs both people inserted in different places", () => {
    const mine = page("<p>Alpha one.</p><p>New after alpha.</p><p>Beta two.</p><p>Gamma three.</p>");
    const theirs = page("<p>Alpha one.</p><p>Beta two.</p><p>Gamma three.</p><p>New at the end.</p>");
    expect(mergeDraftHtml(base, mine, theirs).value).toBe(
      page("<p>Alpha one.</p><p>New after alpha.</p><p>Beta two.</p><p>Gamma three.</p><p>New at the end.</p>"),
    );
  });

  it("tokenizes tags whole and text into words and spaces", () => {
    expect(tokenizeHtml('<p class="a b">Hi  there</p>')).toEqual(['<p class="a b">', "Hi", "  ", "there", "</p>"]);
  });
});

describe("mergeDraftJson", () => {
  it("merges different keys of an object and different cells of a sheet", () => {
    const base = { sheets: [{ id: "s1", name: "Plan", cells: { A1: { v: 1 }, B1: { v: 2 } } }] };
    const mine = { sheets: [{ id: "s1", name: "Plan", cells: { A1: { v: 10 }, B1: { v: 2 } } }] };
    const theirs = { sheets: [{ id: "s1", name: "Budget", cells: { A1: { v: 1 }, B1: { v: 2 }, C1: { v: 3 } } }] };
    expect(mergeDraftJson(base, mine, theirs)).toEqual({
      value: { sheets: [{ id: "s1", name: "Budget", cells: { A1: { v: 10 }, B1: { v: 2 }, C1: { v: 3 } } }] },
      conflicts: 0,
    });
  });

  it("deletes a cell one side cleared and the other left alone", () => {
    const base = { cells: { A1: { v: 1 }, B1: { v: 2 } } };
    const mine = { cells: { A1: { v: 1 } } };
    const theirs = { cells: { A1: { v: 1 }, B1: { v: 2 }, C1: { v: 3 } } };
    expect(mergeDraftJson(base, mine, theirs).value).toEqual({ cells: { A1: { v: 1 }, C1: { v: 3 } } });
  });

  it("lets my value win when both sides changed the same field", () => {
    const merged = mergeDraftJson({ cells: { A1: { v: 1 } } }, { cells: { A1: { v: 2 } } }, { cells: { A1: { v: 3 } } });
    expect(merged).toEqual({ value: { cells: { A1: { v: 2 } } }, conflicts: 1 });
  });

  it("merges slides by id: one person edits a slide while another adds and reorders", () => {
    const s = (id: string, title: string) => ({ id, layout: "title", title: [{ text: title }] });
    const base = { slides: [s("a", "Intro"), s("b", "Plan"), s("c", "Close")] };
    const mine = { slides: [s("a", "Welcome"), s("b", "Plan"), s("c", "Close")] };
    const theirs = { slides: [s("a", "Intro"), s("c", "Close"), s("b", "Plan"), s("d", "Appendix")] };
    expect(mergeDraftJson(base, mine, theirs).value).toEqual({
      slides: [s("a", "Welcome"), s("c", "Close"), s("b", "Plan"), s("d", "Appendix")],
    });
  });

  it("keeps both slides when two people add one at the same spot", () => {
    const s = (id: string) => ({ id });
    const merged = mergeDraftJson({ slides: [s("a")] }, { slides: [s("a"), s("mine")] }, { slides: [s("a"), s("theirs")] });
    expect(merged.value).toEqual({ slides: [s("a"), s("theirs"), s("mine")] });
  });

  it("drops a slide one person deleted", () => {
    const s = (id: string) => ({ id });
    const merged = mergeDraftJson({ slides: [s("a"), s("b")] }, { slides: [s("a")] }, { slides: [s("a"), s("b"), s("c")] });
    expect(merged.value).toEqual({ slides: [s("a"), s("c")] });
  });
});

describe("mergeDraftContent", () => {
  it("merges JSON drafts structurally and returns canonical-order JSON text", () => {
    const base = JSON.stringify({ cells: { A1: 1, B1: 2 } });
    const mine = JSON.stringify({ cells: { A1: 5, B1: 2 } });
    const theirs = JSON.stringify({ cells: { A1: 1, B1: 7 } });
    expect(JSON.parse(mergeDraftContent("spreadsheet", base, mine, theirs).value)).toEqual({ cells: { A1: 5, B1: 7 } });
  });

  it("falls back to my copy when a JSON side cannot be read", () => {
    expect(mergeDraftContent("deck", "{", '{"a":1}', '{"a":2}')).toEqual({ value: '{"a":1}', conflicts: 1 });
  });

  it("is the identity on unchanged input", () => {
    const html = page("<p>Same.</p>");
    expect(mergeDraftContent("document", html, html, html)).toEqual({ value: html, conflicts: 0 });
  });
});

describe("merge properties (seeded random)", () => {
  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const word = (next: () => number) => "abcde"[Math.floor(next() * 5)];
  const list = (next: () => number, length: number) => Array.from({ length }, () => word(next));
  function lcsLength(a: string[], b: string[]): number {
    const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
    return table[a.length][b.length];
  }
  function edit(next: () => number, items: string[]): string[] {
    const copy = [...items];
    const edits = 1 + Math.floor(next() * 3);
    for (let count = 0; count < edits; count += 1) {
      const at = Math.floor(next() * (copy.length + 1));
      const roll = next();
      if (roll < 0.34 && copy.length) copy.splice(Math.min(at, copy.length - 1), 1);
      else if (roll < 0.67) copy.splice(at, 0, word(next));
      else if (copy.length) copy[Math.min(at, copy.length - 1)] = word(next);
    }
    return copy;
  }

  it("finds a longest common subsequence", () => {
    const next = random(7);
    for (let round = 0; round < 300; round += 1) {
      const a = list(next, Math.floor(next() * 14));
      const b = list(next, Math.floor(next() * 14));
      const pairs = commonSubsequence(a, b, (x, y) => x === y);
      expect(pairs.length).toBe(lcsLength(a, b));
      pairs.forEach(([i, j], index) => {
        expect(a[i]).toBe(b[j]);
        if (index) expect(i > pairs[index - 1][0] && j > pairs[index - 1][1]).toBe(true);
      });
    }
  });

  it("returns the changed side exactly when the other side is unchanged", () => {
    const next = random(11);
    const options = { equal: (x: string, y: string) => x === y, conflict: (r: { mine: string[] }) => r.mine };
    for (let round = 0; round < 300; round += 1) {
      const base = list(next, Math.floor(next() * 12));
      const changed = edit(next, base);
      expect(diff3(base, changed, base, options).items).toEqual(changed);
      expect(diff3(base, base, changed, options).items).toEqual(changed);
      expect(diff3(base, changed, changed, options)).toEqual({ items: changed, conflicts: 0 });
    }
  });
});


describe("edge cases that pin the algorithms", () => {
  const same = (x: string, y: string) => x === y;
  const pick = { equal: same, conflict: (region: { mine: string[] }) => region.mine };

  it("finds no pairs in empty input and every pair in identical input", () => {
    expect(commonSubsequence([], [], same)).toEqual([]);
    expect(commonSubsequence(["a", "b"], ["a", "b"], same)).toEqual([[0, 0], [1, 1]]);
    expect(commonSubsequence(["x", "a"], ["y", "a"], same)).toEqual([[1, 1]]);
    expect(commonSubsequence(["a", "x"], ["a", "y"], same)).toEqual([[0, 0]]);
    expect(commonSubsequence(["a", "b", "c"], ["b"], same)).toEqual([[1, 0]]);
  });

  it("stops at the edit cap and treats the rest as one change", () => {
    expect(commonSubsequence(["a", "x"], ["y", "a"], same, 2)).toEqual([[0, 1]]);
    expect(commonSubsequence(["a", "x"], ["y", "a"], same, 1)).toEqual([]);
  });

  it("finds a longest common subsequence without the prefix and suffix trim", () => {
    let state = 99;
    const next = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let round = 0; round < 300; round += 1) {
      const a = Array.from({ length: Math.floor(next() * 10) }, () => "ab"[Math.floor(next() * 2)]);
      const b = Array.from({ length: Math.floor(next() * 10) }, () => "ab"[Math.floor(next() * 2)]);
      const pairs = myersCommonSubsequence(a, b, same);
      const trimmed = commonSubsequence(a, b, same);
      expect(pairs.length).toBe(trimmed.length);
      pairs.forEach(([i, j], index) => {
        expect(a[i]).toBe(b[j]);
        if (index) expect(i > pairs[index - 1][0] && j > pairs[index - 1][1]).toBe(true);
      });
    }
    expect(myersCommonSubsequence(["a", "b"], ["a", "b"], same)).toEqual([[0, 0], [1, 1]]);
    expect(myersCommonSubsequence(["a"], [], same)).toEqual([]);
  });

  it("merges edits whose hunks arrive out of order", () => {
    const merged = diff3(["a", "b", "c", "d"], ["a", "b", "c", "D"], ["A", "b", "c", "d"], pick);
    expect(merged).toEqual({ items: ["A", "b", "c", "D"], conflicts: 0 });
  });

  it("keeps an insertion just before a change on the other side", () => {
    expect(diff3(["a", "b"], ["a", "X", "b"], ["a", "B"], pick)).toEqual({ items: ["a", "X", "B"], conflicts: 0 });
    expect(diff3(["a", "b"], ["a", "B"], ["a", "X", "b"], pick)).toEqual({ items: ["a", "X", "B"], conflicts: 0 });
  });

  it("hands the resolver each side's text over the whole region both touched", () => {
    const regions: string[][][] = [];
    const record = { equal: same, conflict: (region: { base: string[]; mine: string[]; theirs: string[] }) => {
      regions.push([region.base, region.mine, region.theirs]);
      return region.mine;
    } };
    diff3(["a", "b", "c", "d"], ["a", "B", "c", "d"], ["a", "X", "d"], record);
    diff3(["a", "b", "c", "d"], ["a", "b", "C", "d"], ["a", "X", "d"], record);
    expect(regions).toEqual([
      [["b", "c"], ["B", "c"], ["X"]],
      [["b", "c"], ["b", "C"], ["X"]],
    ]);
  });

  it("splits HTML into blocks at closing block tags and at rules", () => {
    expect(htmlBlocks(tokenizeHtml("<p>a</p><hr><p>b</p>tail"))).toEqual(["<p>a</p>", "<hr>", "<p>b</p>", "tail"]);
  });

  it("tokenizes losslessly, even a stray angle bracket", () => {
    const html = '<p title="x>y">1 < 2\n\nand  more</p>';
    expect(tokenizeHtml(html).join("")).toBe(html);
    expect(tokenizeHtml("")).toEqual([]);
  });

  it("reports no conflict when only one side changed", () => {
    const base = page("<p>One.</p>");
    const theirs = page("<p>Two.</p>");
    expect(mergeDraftHtml(base, base, theirs)).toEqual({ value: theirs, conflicts: 0 });
    expect(mergeDraftHtml(base, theirs, theirs)).toEqual({ value: theirs, conflicts: 0 });
    expect(mergeDraftContent("deck", '{"a":1}', '{"a":1}', '{"a":2}')).toEqual({ value: '{"a":2}', conflicts: 0 });
  });

  it("returns my JSON text exactly when nothing else changed it", () => {
    const mine = '{ "a": 1 }';
    expect(mergeDraftContent("deck", '{"a":0}', mine, '{"a":0}')).toEqual({ value: mine, conflicts: 0 });
    expect(mergeDraftContent("deck", '{"a":0}', mine, mine)).toEqual({ value: mine, conflicts: 0 });
  });

  it("keeps my copy when my JSON cannot be read", () => {
    expect(mergeDraftContent("spreadsheet", '{"a":1}', "{", '{"a":2}')).toEqual({ value: "{", conflicts: 1 });
  });

  it("keeps a key the other side added when my side left it alone", () => {
    expect(mergeDraftJson({ a: 1 }, { a: 1 }, { a: 1, b: 2 })).toEqual({ value: { a: 1, b: 2 }, conflicts: 0 });
    expect(mergeDraftJson({ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1 })).toEqual({ value: { a: 1 }, conflicts: 0 });
  });

  it("merges two new objects both sides added under one key", () => {
    expect(mergeDraftJson({}, { k: { a: 1 } }, { k: { b: 2 } })).toEqual({ value: { k: { a: 1, b: 2 } }, conflicts: 0 });
  });

  it("treats a change of shape as a conflict that keeps mine", () => {
    expect(mergeDraftJson({ a: 0 }, { a: { x: 1 } }, { a: "s" })).toEqual({ value: { a: { x: 1 } }, conflicts: 1 });
    expect(mergeDraftJson({ a: "s" }, { a: { x: 1 } }, { a: { y: 2 } })).toEqual({ value: { a: { x: 1 } }, conflicts: 1 });
  });

  it("merges lists without ids item by item", () => {
    expect(mergeDraftJson({ l: [1, 2, 3] }, { l: [1, 2, 3, 4] }, { l: [0, 1, 2, 3] }).value).toEqual({ l: [0, 1, 2, 3, 4] });
    const runs = (...texts: string[]) => texts.map((t) => ({ t }));
    expect(mergeDraftJson({ r: runs("a", "b") }, { r: runs("a", "b", "c") }, { r: runs("z", "a", "b") }).value).toEqual({
      r: runs("z", "a", "b", "c"),
    });
    expect(
      mergeDraftJson({ l: [{ id: "a" }] }, { l: [{ id: "a" }, { id: "b" }] }, { l: [{ id: "a" }, { x: 1 }] }).value,
    ).toEqual({ l: [{ id: "a" }, { x: 1 }, { id: "b" }] });
    expect(mergeDraftJson({ l: [1] }, { l: [{ id: "a" }] }, { l: [{ id: "b" }] })).toEqual({
      value: { l: [{ id: "a" }] },
      conflicts: 1,
    });
  });

  it("lets a deletion win over a move on the other side", () => {
    const s = (id: string) => ({ id });
    // Moving b to the end has one longest common run (a, c, d), so the move
    // is a delete plus an insert that the other side's delete must outrank.
    const base = { slides: [s("a"), s("b"), s("c"), s("d")] };
    expect(mergeDraftJson(base, { slides: [s("a"), s("c"), s("d")] }, { slides: [s("a"), s("c"), s("d"), s("b")] }).value).toEqual({
      slides: [s("a"), s("c"), s("d")],
    });
  });

  it("does not merge an object into a value of another shape added at the same key", () => {
    expect(mergeDraftJson({}, { k: { x: 1 } }, { k: "s" })).toEqual({ value: { k: { x: 1 } }, conflicts: 1 });
  });
});
