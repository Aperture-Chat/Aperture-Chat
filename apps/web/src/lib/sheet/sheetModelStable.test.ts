import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_SOURCE_CHARS, parseWorkbook, serializeWorkbook, type Sheet, type Workbook } from "./sheetModel";

/* A stored workbook must parse back to itself: the server re-checks every
 * revision and refuses content whose canonical form would change again. */

function parsed(input: unknown): Workbook {
  const result = parseWorkbook(input);
  if (!result.ok) throw new Error(result.error);
  return result.workbook;
}

function sheetFrom(sheet: Record<string, unknown>): Sheet {
  return parsed({ sheets: [{ name: "S", ...sheet }] }).sheets[0];
}

describe("parse rules that keep stored workbooks stable", () => {
  it("strips every leading equals sign and the spaces around it from formulas", () => {
    const sheet = sheetFrom({
      cells: {
        A1: { f: "==A1" },
        A2: { f: "  =A1" },
        A3: { f: " = =A1 " },
        A4: { f: "==", v: 3 },
        A5: { f: "=" },
        A6: { f: "x".repeat(8191) + " y" },
      },
      conditional: [{ id: "c", ref: "A1", type: "formula", formula: " =$A1>0" }, { id: "d", ref: "A1", type: "formula", formula: " == " }],
    });
    expect(sheet.cells).toEqual({ A1: { f: "A1" }, A2: { f: "A1" }, A3: { f: "A1" }, A4: { v: 3 }, A6: { f: "x".repeat(8191) } });
    expect(sheet.conditional).toEqual([{ id: "c", ref: "A1", type: "formula", formula: "$A1>0", style: { fill: "#f8d7da" } }]);
  });

  it("drops text that is empty once NUL is removed and judges formats after removing it", () => {
    const sheet = sheetFrom({ cells: { A1: { v: "\u0000\u0000" }, A2: { v: 1, s: { format: "Gen\u0000eral" } }, A3: { v: 1, s: { format: `${"0".repeat(255)}\u0000` } } } });
    expect(sheet.cells).toEqual({ A2: { v: 1 }, A3: { v: 1, s: { format: "0".repeat(255) } } });
  });

  it("normalizes cell keys and anchors, keeping the last parsed cell on a collision", () => {
    const sheet = sheetFrom({
      cells: { " b2 ": { v: "first" }, B02: { v: "second" }, b2: { v: "last" }, A01: { v: 1 }, A1: {} },
      charts: [{ id: "c", type: "bar", source: "A1:B2", at: " h02 " }],
      pivots: [{ id: "p", source: "A1:B2", at: "$J$010" }],
    });
    expect(sheet.cells).toEqual({ B2: { v: "last" }, A1: { v: 1 } });
    expect(sheet.charts?.[0].at).toBe("H2");
    expect(sheet.pivots?.[0].at).toBe("J10");
  });

  it("quotes R1C1-looking sheet names and bounds the stored source text", () => {
    const pad = " ".repeat(MAX_SOURCE_CHARS - "'Q1 Data'!A1:B2".length);
    const sheet = sheetFrom({
      charts: [
        { id: "r1c1", type: "bar", at: "A1", source: "R1C1!A1:B2" },
        { id: "fits", type: "bar", at: "A1", source: `Q1 Data${pad}!A1:B2` },
        { id: "grows", type: "bar", at: "A1", source: `Q1 Data${pad} !A1:B2` },
        { id: "padded", type: "bar", at: "A1", source: `Plain!A1:B2${" ".repeat(400)}` },
      ],
    });
    expect(sheet.charts?.map((chart) => [chart.id, chart.source.length])).toEqual([["r1c1", 12], ["fits", MAX_SOURCE_CHARS], ["padded", 11]]);
    expect(sheet.charts?.[0].source).toBe("'R1C1'!A1:B2");
  });

  it("keeps the upper bound of a between filter condition and needs one", () => {
    const sheet = sheetFrom({
      filter: {
        ref: "A1:D9",
        criteria: {
          A: { condition: { op: "between", value: 3, value2: 9 } },
          B: { condition: { op: "notBetween", value: "1", value2: "\u0000" } },
          C: { condition: { op: "gt", value: "4", value2: "8" } },
        },
      },
    });
    expect(sheet.filter?.criteria).toEqual({ A: { condition: { op: "between", value: "3", value2: "9" } }, C: { condition: { op: "gt", value: "4" } } });
  });
});

/* ---------------------------------------------------------------- property */

const FIXTURE = resolve(__dirname, "../../../../../services/api/tests/fixtures/sheet-v1/cases.json");

/** Mulberry32: a small seeded generator so failures reproduce. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXT = [
  "", " ", "=", "==", "==A1", "  =A1 ", " = =B2 ", "A1", "a01", " b2 ", "$C$3", "IV20000", "IW1", "\u0000", "\u0000\u0000", "General",
  "Gen\u0000eral", "R1C1", "Q1 Data", "O'Brien", "'x'", "😀", "\ud83d", "History", "Sheet1", "sheet1", "1e21", "B2:A1", "A:C", "2:4",
  "Plan!A1:B2", "R1C1!A1:B2", "'a!b'!A1", "' Spaced '!A1", "#FFAA00", "#abc", "between", "notBetween", "gt", "contains", "list", "whole",
  "cell", "formula", "scale", "bar", "top", "line", "pie", "Sales_2027", "x".repeat(40), " ".repeat(310) + "A1", "Q1 Data" + " ".repeat(293) + "!A1:B2",
  "=" + "x".repeat(8190) + "  y",
];
const NUMBERS = [0, -0, 1, 2.5, -1.5, 3.7, 0.1 + 0.2, 1e21, 1e-7, 9007199254740993, 300, 1000, 20001];
const KEYS = ["A1", "a1", " A1", "A01", "B2", "b02", "$B$2", "IV1", "IW1", "A0", "C3", "1", "x", "AA10", "Z9"];
const FIELDS = [
  "v", "f", "s", "n", "id", "name", "ref", "type", "op", "value", "value2", "source", "at", "formula", "kind", "items", "text", "style",
  "bold", "fill", "color", "format", "font", "size", "indent", "border", "top", "condition", "values", "criteria", "sort", "col", "desc",
  "hidden", "w", "h", "min", "max", "count", "rows", "columns", "include", "field", "agg", "tables", "accent", "tone", "title",
];

type Random = () => number;
const pick = <T,>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)];

function randomValue(random: Random, depth: number): unknown {
  const roll = random();
  if (roll < 0.45) return pick(random, TEXT);
  if (roll < 0.65) return pick(random, NUMBERS);
  if (roll < 0.72) return random() < 0.5;
  if (roll < 0.75) return null;
  if (depth > 3) return pick(random, TEXT);
  if (roll < 0.85) return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth + 1));
  return randomBag(random, depth + 1, FIELDS);
}

function randomBag(random: Random, depth: number, keys: readonly string[]): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  for (let n = Math.floor(random() * 6); n > 0; n -= 1) bag[pick(random, keys)] = randomValue(random, depth);
  return bag;
}

function randomList(random: Random, make: () => unknown): unknown[] {
  return Array.from({ length: Math.floor(random() * 4) }, make);
}

function randomSheet(random: Random): Record<string, unknown> {
  const cells: Record<string, unknown> = {};
  for (let n = Math.floor(random() * 6); n > 0; n -= 1) cells[pick(random, KEYS)] = randomBag(random, 1, ["v", "f", "s", "n"]);
  const criteria: Record<string, unknown> = {};
  for (let n = Math.floor(random() * 3); n > 0; n -= 1) criteria[pick(random, ["A", "b", "C", "1"])] = { condition: randomBag(random, 2, ["op", "value", "value2"]), values: randomValue(random, 3) };
  const rule = () => ({ ...randomBag(random, 2, FIELDS), id: pick(random, ["r1", "r2", "bad id"]), ref: pick(random, ["A1:B4", "B9:A1", "nope"]), type: pick(random, ["cell", "text", "formula", "top", "scale", "bar", "unique"]) });
  return {
    id: pick(random, ["s1", "s2", "bad id", 5]),
    name: pick(random, TEXT),
    hidden: random() < 0.3,
    cells,
    filter: { ref: pick(random, ["A1:C9", "C9:A1", "nope"]), criteria, sort: randomBag(random, 2, ["col", "desc"]) },
    tables: randomList(random, () => ({ ...randomBag(random, 2, FIELDS), name: pick(random, ["T", "t", "R1C1", "Sales_2027", " Pad "]), ref: pick(random, ["A1:B4", "A1:B1"]) })),
    charts: randomList(random, () => ({ ...randomBag(random, 2, FIELDS), id: pick(random, ["c1", "c2"]), type: pick(random, ["bar", "pie", "radar"]), source: pick(random, TEXT), at: pick(random, KEYS) })),
    pivots: randomList(random, () => ({ ...randomBag(random, 2, FIELDS), id: "p", source: pick(random, TEXT), at: pick(random, KEYS) })),
    conditional: randomList(random, rule),
    validations: randomList(random, () => ({ ...rule(), kind: pick(random, ["list", "whole", "date", "time"]), source: pick(random, TEXT) })),
    merges: randomList(random, () => pick(random, TEXT)),
  };
}

function randomWorkbook(random: Random): unknown {
  return {
    sheets: Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomSheet(random)),
    names: randomList(random, () => ({ name: pick(random, ["Rate", "rate", "T", "A1", " Pad "]), ref: pick(random, TEXT) })),
  };
}

function expectStable(input: unknown): void {
  const first = parseWorkbook(input);
  if (!first.ok) return;
  const text = serializeWorkbook(first.workbook);
  const second = parseWorkbook(text);
  expect(second.ok && second.workbook).toEqual(first.workbook);
  expect(second.ok && serializeWorkbook(second.workbook)).toBe(text);
}

describe("parse(serialize(parse(x))) equals parse(x)", () => {
  it("holds for every shared fixture input", () => {
    const cases = JSON.parse(readFileSync(FIXTURE, "utf8")) as { input: string }[];
    for (const item of cases) expectStable(item.input);
  });

  it("holds for random workbooks built from awkward pieces", () => {
    const random = seeded(20261029);
    for (let run = 0; run < 400; run += 1) expectStable(randomWorkbook(random));
  });
});
