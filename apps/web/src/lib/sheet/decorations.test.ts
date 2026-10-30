import { describe, expect, it } from "vitest";
import { cellKey } from "./address";
import { computeDecorations, computeFilter, currentRegion, decorationAt, filterColumnValues, mixColors, tablePalette, type CellDecoration } from "./decorations";
import { computeWorkbook } from "./recalc";
import type { ConditionalRule, Sheet, SheetCell, Workbook } from "./sheetModel";
import { SHEET_SCHEMA_VERSION } from "./sheetModel";

/** A sheet from rows of literals; strings starting with "=" become formulas. */
function sheetOf(rows: (string | number | boolean | null)[][], extra: Partial<Sheet> = {}): Sheet {
  const cells: Record<string, SheetCell> = {};
  rows.forEach((line, row) =>
    line.forEach((value, col) => {
      if (value === null) return;
      cells[cellKey(row, col)] = typeof value === "string" && value.startsWith("=") ? { f: value.slice(1) } : { v: value };
    }),
  );
  return { id: "s1", name: "Data", cells, ...extra };
}

function decorate(sheet: Sheet, dark = false) {
  const workbook: Workbook = { schema: SHEET_SCHEMA_VERSION, sheets: [sheet] };
  const engine = computeWorkbook(workbook);
  return { map: computeDecorations(sheet, engine, computeFilter(sheet.filter, sheet.id, engine), dark), engine };
}

function painted(map: Map<number, CellDecoration>, rows: number, cols: number, pick: (decoration: CellDecoration) => unknown): unknown[][] {
  return Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => pick(decorationAt(map, row, col) ?? {}) ?? "."));
}

const NUMBERS = [["n"], [4], [-2], ["x"], [10], [4], [null], [7]];

function ruleSheet(rule: Partial<ConditionalRule> & Pick<ConditionalRule, "type">, rows = NUMBERS) {
  return sheetOf(rows, { conditional: [{ id: "r1", ref: "A1:A8", ...rule } as ConditionalRule] });
}

const fills = (map: Map<number, CellDecoration>) => painted(map, 8, 1, (d) => d.fill).map((line) => line[0]);

describe("conditional format decorations", () => {
  it("colors a two- and three-color scale across numeric cells", () => {
    expect(fills(decorate(ruleSheet({ type: "scale", min: "#000000", max: "#ffffff" })).map)).toEqual([".", "#808080", "#000000", ".", "#ffffff", "#808080", ".", "#bfbfbf"]);
    expect(fills(decorate(ruleSheet({ type: "scale", min: "#000000", mid: "#ff0000", max: "#ffffff" })).map)).toEqual([".", "#ff0000", "#000000", ".", "#ffffff", "#ff0000", ".", "#ff8080"]);
    const flat = decorate(ruleSheet({ type: "scale", min: "#000000", max: "#ffffff" }, [[3], [3]])).map;
    expect(decorationAt(flat, 0, 0)).toEqual({ fill: "#ffffff" });
    expect(decorate(ruleSheet({ type: "scale", min: "#000000", max: "#ffffff" }, [["a"]])).map.size).toBe(0);
  });

  it("draws data bars relative to the largest magnitude", () => {
    const { map } = decorate(ruleSheet({ type: "bar", color: "#087d8b" }));
    expect(painted(map, 8, 1, (d) => d.bar?.fraction).map((line) => line[0])).toEqual([".", 0.4, 0.2, ".", 1, 0.4, ".", 0.7]);
    expect(decorationAt(map, 1, 0)?.bar?.color).toBe("#087d8b");
    const zeros = decorate(ruleSheet({ type: "bar", color: "#087d8b" }, [[0], [0]])).map;
    expect(decorationAt(zeros, 0, 0)).toEqual({ bar: { fraction: 0, color: "#087d8b" } });
    expect(decorate(ruleSheet({ type: "bar", color: "#087d8b" }, [["a"]])).map.size).toBe(0);
  });

  it("matches cell value rules by operator, numerically or as text", () => {
    const style = { fill: "#ff0000", color: "#ffffff", bold: true };
    const ops: [string, string, string | undefined, unknown[]][] = [
      ["gt", "4", undefined, [true, ".", ".", true, true, ".", ".", true]],
      ["gte", "4", undefined, [true, true, ".", true, true, true, ".", true]],
      ["lt", "4", undefined, [".", ".", true, ".", ".", ".", ".", "."]],
      ["lte", "4", undefined, [".", true, true, ".", ".", true, ".", "."]],
      ["eq", "4", undefined, [".", true, ".", ".", ".", true, ".", "."]],
      ["neq", "4", undefined, [true, ".", true, true, true, ".", ".", true]],
      ["between", "0", "7", [".", true, ".", ".", ".", true, ".", true]],
      ["notBetween", "0", "7", [true, ".", true, true, true, ".", ".", "."]],
      // Without a second bound only the lower one constrains numbers.
      ["between", "5", undefined, [".", ".", ".", ".", true, ".", ".", true]],
      ["eq", "x", undefined, [".", ".", ".", true, ".", ".", ".", "."]],
    ];
    for (const [op, value, value2, expected] of ops) {
      const { map } = decorate(ruleSheet({ type: "cell", op, value, value2, style } as never));
      expect([op, value, value2, painted(map, 8, 1, (d) => d.bold).map((line) => line[0])]).toEqual([op, value, value2, expected]);
    }
    const { map } = decorate(ruleSheet({ type: "cell", op: "gt", value: "4", style }));
    expect(decorationAt(map, 4, 0)).toEqual(style);
  });

  it("matches text rules case-insensitively and skips blanks and errors", () => {
    const rows = [["Late fee"], ["on time"], ["LATE"], [null], ["=1/0"], [12]];
    const expectations: [string, string, unknown[]][] = [
      ["contains", "late", [true, ".", true, ".", ".", "."]],
      ["notContains", "late", [".", true, ".", ".", ".", true]],
      ["begins", "on", [".", true, ".", ".", ".", "."]],
      ["ends", "FEE", [true, ".", ".", ".", ".", "."]],
    ];
    for (const [op, text, expected] of expectations) {
      const { map } = decorate(ruleSheet({ type: "text", op, text, style: { bold: true } } as never, rows));
      expect([op, painted(map, 6, 1, (d) => d.bold).map((line) => line[0])]).toEqual([op, expected]);
    }
  });

  it("highlights top and bottom counts and percentages", () => {
    const bold = (rule: Partial<ConditionalRule>) => painted(decorate(ruleSheet({ style: { bold: true }, ...rule } as never)).map, 8, 1, (d) => d.bold).map((line) => line[0]);
    expect(bold({ type: "top", count: 2 })).toEqual([".", ".", ".", ".", true, ".", ".", true]);
    expect(bold({ type: "bottom", count: 2 })).toEqual([".", true, true, ".", ".", true, ".", "."]);
    expect(bold({ type: "top", count: 40, percent: true })).toEqual([".", ".", ".", ".", true, ".", ".", true]);
    expect(bold({ type: "top", count: 99 })).toEqual([".", true, true, ".", true, true, ".", true]);
    expect(bold({ type: "top", count: 0 })).toEqual([".", ".", ".", ".", ".", ".", ".", "."]);
    expect(decorate(ruleSheet({ type: "top", count: 1, style: { bold: true } }, [["a"]])).map.size).toBe(0);
  });

  it("highlights duplicates, uniques, and values above or below the average", () => {
    const rows = [["a"], ["A"], [4], [4], ["b"], [null], [""], [true]];
    const bold = (type: string, data = rows) => painted(decorate(ruleSheet({ type, style: { bold: true } } as never, data)).map, 8, 1, (d) => d.bold).map((line) => line[0]);
    expect(bold("duplicate")).toEqual([true, true, true, true, ".", ".", ".", "."]);
    expect(bold("unique")).toEqual([".", ".", ".", ".", true, ".", ".", true]);
    expect(bold("above", NUMBERS)).toEqual([".", ".", ".", ".", true, ".", ".", true]);
    expect(bold("below", NUMBERS)).toEqual([".", true, true, ".", ".", true, ".", "."]);
    expect(decorate(ruleSheet({ type: "above", style: { bold: true } }, [["a"]])).map.size).toBe(0);
  });

  it("highlights blank and filled cells within the used range", () => {
    const rows = [["a", null], [null, 1], ["", null]];
    const sheet = (type: string) => sheetOf(rows, { conditional: [{ id: "r1", ref: "A1:C9", type, style: { fill: "#00ff00" } } as ConditionalRule] });
    expect(painted(decorate(sheet("blank")).map, 4, 3, (d) => d.fill)).toEqual([
      [".", "#00ff00", "."],
      ["#00ff00", ".", "."],
      ["#00ff00", "#00ff00", "."],
      [".", ".", "."],
    ]);
    expect(painted(decorate(sheet("notBlank")).map, 3, 3, (d) => d.fill)).toEqual([["#00ff00", ".", "."], [".", "#00ff00", "."], [".", ".", "."]]);
    const empty: Sheet = { id: "s1", name: "Data", cells: {}, conditional: [{ id: "r1", ref: "A1:B2", type: "blank", style: { fill: "#00ff00" } }] };
    expect(decorate(empty).map.size).toBe(4);
  });

  it("evaluates formula rules relative to the range's top-left cell", () => {
    const rows = [[5, 1], [-3, 1], [8, 0], [-1, 0]];
    const sheet = sheetOf(rows, { conditional: [{ id: "r1", ref: "A1:A4", type: "formula", formula: "AND($A1>0,B1=1)", style: { bold: true } }, { id: "r2", ref: "B1:B4", type: "formula", formula: "SEQUENCE(1)", style: { color: "#123456" } }, { id: "r3", ref: "A1", type: "formula", formula: "SUM(", style: { bold: true } }] });
    const { map } = decorate(sheet);
    expect(painted(map, 4, 2, (d) => d.bold ?? d.color)).toEqual([[true, "#123456"], [".", "#123456"], [".", "#123456"], [".", "#123456"]]);
  });

  it("lets later rules win and ignores rules with an unreadable range", () => {
    const sheet = sheetOf([[1], [2]], {
      conditional: [
        { id: "r1", ref: "A1:A2", type: "cell", op: "gt", value: "0", style: { fill: "#111111", bold: true } },
        { id: "r2", ref: "A2", type: "cell", op: "gt", value: "0", style: { fill: "#222222" } },
        { id: "r3", ref: "nope", type: "cell", op: "gt", value: "0", style: { fill: "#333333" } },
      ],
    });
    const { map } = decorate(sheet);
    expect([decorationAt(map, 0, 0), decorationAt(map, 1, 0)]).toEqual([{ fill: "#111111", bold: true }, { fill: "#222222", bold: true }]);
  });
});

describe("table and pivot decorations", () => {
  it("styles table headers, bands, first column, and totals", () => {
    const sheet = sheetOf([["Name", "N"], ["a", 1], ["b", 2], ["c", 3], ["Total", 6]], {
      tables: [
        { id: "t1", name: "T1", ref: "A1:B5", accent: 2, tone: "medium", banded: true, totals: true, filterButtons: true, firstColumn: true },
        { id: "t2", name: "T2", ref: "D1:D1", accent: 1, tone: "light", banded: true, totals: false, filterButtons: false },
      ],
    });
    const { map } = decorate(sheet);
    const colors = tablePalette({ accent: 2, tone: "medium" });
    expect(decorationAt(map, 0, 0)).toEqual({ fill: colors.header, color: colors.headerText, bold: true, lineBottom: colors.line, filterButton: { active: false } });
    expect([decorationAt(map, 1, 0), decorationAt(map, 1, 1), decorationAt(map, 2, 0), decorationAt(map, 2, 1), decorationAt(map, 3, 1)]).toEqual([
      { fill: colors.band, bold: true },
      { fill: colors.band },
      { bold: true },
      {},
      { fill: colors.band },
    ]);
    expect(decorationAt(map, 4, 1)).toEqual({ bold: true, lineTop: colors.line });
    expect(decorationAt(map, 0, 3)).toBeUndefined();
    const plain = decorate(sheetOf([["H"], ["x"]], { tables: [{ id: "t1", name: "T1", ref: "A1:A2", accent: 1, tone: "dark", banded: false, totals: false, filterButtons: false }] }), true).map;
    expect(decorationAt(plain, 0, 0)).toEqual({ ...pick(tablePalette({ accent: 1, tone: "dark" }, true)), bold: true });
    expect(decorationAt(plain, 1, 0)).toEqual({});
  });

  it("mixes table palettes for every tone in light and dark mode", () => {
    expect(mixColors("#000000", "#ffffff", 0.5)).toBe("#808080");
    const tones = ["light", "medium", "dark"] as const;
    const palettes = [false, true].flatMap((dark) => tones.map((tone) => tablePalette({ accent: 1, tone }, dark)));
    expect(new Set(palettes.map((palette) => palette.header)).size).toBe(6);
    expect(palettes[1]).toEqual({ header: "#087d8b", headerText: "#ffffff", band: mixColors("#087d8b", "#ffffff", 0.84), line: "#087d8b" });
  });

  it("styles pivot header, total, and label cells", () => {
    const sheet = sheetOf([["Region", "Sales"], ["East", 1], ["West", 2]], {
      pivots: [
        { id: "p1", name: "P", source: "A1:B3", at: "D1", rows: ["Region"], columns: [], values: [{ field: "Sales", agg: "sum" }], filters: [], rowTotals: true, columnTotals: true },
        { id: "p2", name: "Bad", source: "A1:B3", at: "H1", rows: ["Nope"], columns: [], values: [], filters: [], rowTotals: true, columnTotals: true },
      ],
    });
    for (const dark of [false, true]) {
      const { map } = decorate(sheet, dark);
      const base = dark ? "#0d1c27" : "#ffffff";
      const header = mixColors("#087d8b", base, dark ? 0.7 : 0.82);
      const total = mixColors("#087d8b", base, dark ? 0.82 : 0.9);
      expect(painted(map, 4, 5, (d) => JSON.stringify(d)).map((line) => line.slice(3))).toEqual([
        [JSON.stringify({ fill: header, bold: true, lineBottom: "#087d8b" }), JSON.stringify({ fill: header, bold: true, lineBottom: "#087d8b" })],
        [JSON.stringify({ bold: false }), "{}"],
        [JSON.stringify({ bold: false }), "{}"],
        [JSON.stringify({ bold: true, lineTop: "#087d8b", fill: total }), JSON.stringify({ bold: true, lineTop: "#087d8b", fill: total })],
      ]);
      expect(decorationAt(map, 0, 7)).toBeUndefined();
    }
  });
});

function pick(palette: ReturnType<typeof tablePalette>): CellDecoration {
  return { fill: palette.header, color: palette.headerText, lineBottom: palette.line };
}

describe("autofilter", () => {
  const rows = [["Name", "Score", "Note"], ["Ana", 3, "late"], ["Bo", 9, ""], ["cy", 5, "On time"], [null, 1, "LATE"], ["Ana", 12, null]];
  const run = (criteria: Record<string, unknown>, ref = "A1:C6") => {
    const sheet = sheetOf(rows, { filter: { ref, criteria } as never });
    const { map, engine } = decorate(sheet);
    return { result: computeFilter(sheet.filter, sheet.id, engine), map, engine };
  };

  it("hides rows outside the allowed values, conditions, or both", () => {
    expect([...run({ A: { values: ["ana", "(Blanks)"] } }).result!.hiddenRows]).toEqual([2, 3]);
    expect([...run({ B: { condition: { op: "gt", value: "4" } } }).result!.hiddenRows]).toEqual([1, 4]);
    // Scores are 3, 9, 5, 1, 12: between is inclusive at both ends.
    expect([...run({ B: { condition: { op: "between", value: "3", value2: "9" } } }).result!.hiddenRows]).toEqual([4, 5]);
    expect([...run({ B: { condition: { op: "notBetween", value: "3", value2: "9" } } }).result!.hiddenRows]).toEqual([1, 2, 3]);
    expect([...run({ C: { condition: { op: "contains", value: "late" } } }).result!.hiddenRows]).toEqual([2, 3, 5]);
    expect([...run({ C: { condition: { op: "ends", value: "TIME" } } }).result!.hiddenRows]).toEqual([1, 2, 4, 5]);
    expect([...run({ A: { values: ["Ana"] }, B: { condition: { op: "lt", value: "10" } } }).result!.hiddenRows]).toEqual([2, 3, 4, 5]);
    expect([...run({ A: {} }).result!.hiddenRows]).toEqual([]);
  });

  it("marks active columns, ignores criteria outside the range, and draws the buttons", () => {
    const { result, map } = run({ B: { values: ["3"] }, E: { values: ["x"] } }, "A1:C99");
    expect(result).toEqual({ range: { r1: 0, c1: 0, r2: 5, c2: 2 }, hiddenRows: new Set([2, 3, 4, 5]), activeColumns: new Set([1]) });
    expect(painted(map, 1, 3, (d) => d.filterButton?.active)).toEqual([[false, true, false]]);
    expect(computeFilter(undefined, "s1", run({}).engine)).toBeNull();
    expect(computeFilter({ ref: "bad", criteria: {} }, "s1", run({}).engine)).toBeNull();
    const empty = computeWorkbook({ schema: SHEET_SCHEMA_VERSION, sheets: [{ id: "s1", name: "Data", cells: {} }] });
    expect(computeFilter({ ref: "B3:D9", criteria: { C: { values: ["x"] } } }, "s1", empty)).toEqual({ range: { r1: 2, c1: 1, r2: 2, c2: 3 }, hiddenRows: new Set(), activeColumns: new Set([2]) });
  });

  it("lists distinct column values with blanks last", () => {
    const { engine } = run({});
    expect(filterColumnValues({ r1: 0, c1: 0, r2: 9, c2: 2 }, 0, "s1", engine)).toEqual([{ label: "Ana", count: 2 }, { label: "Bo", count: 1 }, { label: "cy", count: 1 }, { label: "(Blanks)", count: 1 }]);
  });
});

describe("current region", () => {
  const rows = [
    [null, null, null, null, null],
    [null, "a", "b", null, null],
    [null, 1, null, null, "far"],
    [null, null, 2, 3, null],
    [null, null, null, null, null],
  ];
  const engine = computeWorkbook({ schema: SHEET_SCHEMA_VERSION, sheets: [sheetOf(rows)] });

  it("grows across touching cells, including diagonals", () => {
    expect(currentRegion("s1", engine, 1, 1)).toEqual({ r1: 1, c1: 1, r2: 3, c2: 4 });
    expect(currentRegion("s1", engine, 4, 0)).toEqual({ r1: 4, c1: 0, r2: 4, c2: 0 });
    expect(currentRegion("s1", engine, 0, 0)).toEqual({ r1: 0, c1: 0, r2: 3, c2: 4 });
  });

  it("stops at the sheet's top-left edge", () => {
    const corner = computeWorkbook({ schema: SHEET_SCHEMA_VERSION, sheets: [sheetOf([[1, 2], [3, null]])] });
    expect(currentRegion("s1", corner, 1, 1)).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 });
  });
});
