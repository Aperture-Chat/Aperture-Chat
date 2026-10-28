import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { stewardDiagramPalette } from "./diagramThemes";
import {
  computeStewardDiagramLayout,
  parseStewardDiagram,
  renderStewardDiagramSvg,
  serializeStewardDiagram,
  stewardDiagramMarkerDefs,
  stewardFieldValue,
  stewardMarkerId,
  withStewardFieldValue,
  type StewardDiagramModel,
} from "./stewardDiagram";
import { PIN_FIXTURES } from "./stewardDiagramPinFixtures";
import { stewardBendFromPointer } from "./stewardDiagramRoutes";

const PINNED: Record<string, string> = {
  "estate:light": "b0c23dec36fe3f8ff9d8bfd1106b83ef707379bce6e9c4816f641615e1dc210a",
  "estate:dark": "cb6704a6cda61c9fb09a594efe981e9f3daef18f212ef0a0aba53fbb70410124",
  "rowRoutes:light": "d5456a3561544d6a64c320795b6313fcd386581c7728fe841c1c0a8a87f4206d",
  "rowRoutes:dark": "75abeda8a0f681f52f8aacefbdd5052f8183814bfbb9e97a9f025262e3e82884",
  "plain:light": "aa8d2fe6428247019bfe7f5e01054757cf325230a93e2b3da3981f7abe4aa123",
  "plain:dark": "e8620b5e785c3b6caabf2aa58852fa7a808c908ba523e15ac98aaa7effba62a5",
};

function model(source: string): StewardDiagramModel {
  const parsed = parseStewardDiagram(source);
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

const TWO_ROWS = JSON.stringify({
  rows: [[{ id: "a", title: "Alpha" }, { id: "b", title: "Bravo" }], [{ id: "c", title: "Charlie" }]],
  edges: [{ from: "a", to: "c" }, { from: "a", to: "b", label: "hands off" }],
});

test("charts without studio fields render exactly as before", () => {
  for (const [name, source] of Object.entries(PIN_FIXTURES)) {
    for (const dark of [false, true]) {
      const svg = renderStewardDiagramSvg(model(source), dark);
      const hash = createHash("sha256").update(svg).digest("hex");
      expect(hash, `${name} ${dark ? "dark" : "light"}`).toBe(PINNED[`${name}:${dark ? "dark" : "light"}`]);
    }
  }
});

test("studio fields parse, validate, and round-trip through the source", () => {
  const source = JSON.stringify({
    theme: "forest",
    connector: "curved",
    corners: "square",
    rows: [[{ id: "a", title: "Alpha", color: "amber", position: { x: 120.4, y: 300.6 } }, { id: "b", title: "Bravo" }]],
    edges: [{ from: "a", to: "b", bend: 24.2 }],
  });
  const parsed = model(source);
  expect(parsed.theme).toBe("forest");
  expect(parsed.connector).toBe("curved");
  expect(parsed.corners).toBe("square");
  expect(parsed.rows[0]![0]!.color).toBe("amber");
  expect(parsed.rows[0]![0]!.position).toEqual({ x: 120, y: 301 });
  expect(parsed.edges[0]!.bend).toBe(24);
  expect(model(serializeStewardDiagram(parsed))).toEqual(parsed);
});

test("invalid studio values are dropped and extreme numbers clamped", () => {
  const parsed = model(
    JSON.stringify({
      theme: "neon",
      connector: "zigzag",
      corners: "pointy",
      rows: [
        [
          { id: "a", title: "Alpha", color: "chartreuse", position: { x: "1", y: 4 } },
          { id: "b", title: "Bravo", position: { x: -50, y: 99999 } },
        ],
      ],
      edges: [
        { from: "a", to: "b", bend: "far" },
        { from: "b", to: "a", bend: -99999 },
      ],
    }),
  );
  expect(parsed.theme).toBeUndefined();
  expect(parsed.connector).toBeUndefined();
  expect(parsed.corners).toBeUndefined();
  expect(parsed.rows[0]![0]!.color).toBeUndefined();
  expect(parsed.rows[0]![0]!.position).toBeUndefined();
  expect(parsed.rows[0]![1]!.position).toEqual({ x: 0, y: 4000 });
  expect(parsed.edges[0]!.bend).toBeUndefined();
  expect(parsed.edges[1]!.bend).toBe(-2000);
  // Absent fields stay absent so the serialized source does not grow.
  expect(serializeStewardDiagram(model(TWO_ROWS))).not.toMatch(/theme|connector|corners|position|color|bend/);
});

test("a positioned card draws where it was dropped and the canvas grows to hold it", () => {
  const base = computeStewardDiagramLayout(model(TWO_ROWS), false);
  const moved = model(TWO_ROWS);
  moved.rows[0]![1]!.position = { x: 200, y: base.height + 140 };
  const layout = computeStewardDiagramLayout(moved, false);
  const box = layout.cardBoxes.find((item) => item.id === "b")!;
  expect(box).toMatchObject({ x: 200, y: base.height + 140, positioned: true });
  expect(layout.height).toBeGreaterThan(base.height + 140 + box.height);
  const titles = layout.texts.filter((el) => el.cardId === "b");
  expect(titles.length).toBeGreaterThan(0);
  expect(titles.every((el) => el.y >= box.y && el.x >= box.x && el.x <= box.x + box.width)).toBe(true);
  // Other cards keep their row slots.
  expect(layout.cardBoxes.find((item) => item.id === "a")).toEqual(base.cardBoxes.find((item) => item.id === "a"));
});

test("positions are kept inside the canvas width and below the heading", () => {
  const moved = model(JSON.stringify({ title: "Heading", rows: [[{ id: "a", title: "Alpha", position: { x: 3000, y: 0 } }]] }));
  const layout = computeStewardDiagramLayout(moved, false);
  const box = layout.cardBoxes[0]!;
  expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
  expect(box.y).toBe(layout.contentTop);
  expect(layout.contentTop).toBeGreaterThan(26);
});

test("an arrow to a moved card reroutes between facing sides", () => {
  const below = model(TWO_ROWS);
  below.rows[1]![0]!.position = { x: 500, y: 400 };
  const layout = computeStewardDiagramLayout(below, false);
  const a = layout.cardBoxes.find((item) => item.id === "a")!;
  const c = layout.cardBoxes.find((item) => item.id === "c")!;
  const path = layout.paths.find((el) => el.edgeIndex === 0)!;
  expect(path.ends!.from).toEqual([a.x + a.width / 2, a.y + a.height]);
  expect(path.ends!.to).toEqual([c.x + c.width / 2, c.y - 4]);
  expect(path.handle).toMatchObject({ axis: "y" });

  const beside = model(TWO_ROWS);
  beside.rows[1]![0]!.position = { x: 380, y: 60 };
  beside.rows[0]![0]!.position = { x: 4, y: 60 };
  const sideLayout = computeStewardDiagramLayout(beside, false);
  const sa = sideLayout.cardBoxes.find((item) => item.id === "a")!;
  const sidePath = sideLayout.paths.find((el) => el.edgeIndex === 0)!;
  expect(sidePath.ends!.from[0]).toBeCloseTo(sa.x + sa.width, 6);
  expect(sidePath.ends!.from[1]).toBeCloseTo(sa.y + sa.headerHeight / 2, 6);
});

test("bend moves the arrow's middle run and its handle maps a pointer back to a bend", () => {
  const straightRun = computeStewardDiagramLayout(model(TWO_ROWS), false).paths.find((el) => el.edgeIndex === 0)!;
  const bent = model(TWO_ROWS);
  bent.edges[0]!.bend = 20;
  const bentPath = computeStewardDiagramLayout(bent, false).paths.find((el) => el.edgeIndex === 0)!;
  expect(bentPath.handle!.y).toBe(straightRun.handle!.y + 20);
  expect(stewardBendFromPointer(bentPath.handle!, { x: 0, y: straightRun.handle!.y + 37 })).toBe(37);

  const curved = model(TWO_ROWS);
  curved.connector = "curved";
  curved.edges[0]!.bend = 16;
  const curvedPath = computeStewardDiagramLayout(curved, false).paths.find((el) => el.edgeIndex === 0)!;
  expect(curvedPath.d).toMatch(/ C /);
  expect(stewardBendFromPointer(curvedPath.handle!, { x: curvedPath.handle!.x, y: curvedPath.handle!.y })).toBe(16);
});

test("straight connectors draw one clipped segment with no bend handle", () => {
  const straight = model(TWO_ROWS);
  straight.connector = "straight";
  const layout = computeStewardDiagramLayout(straight, false);
  const path = layout.paths.find((el) => el.edgeIndex === 0)!;
  expect(path.d).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
  expect(path.handle).toBeUndefined();
  const a = layout.cardBoxes.find((item) => item.id === "a")!;
  const [x, y] = path.ends!.from;
  const onBorder =
    Math.abs(y - (a.y + a.height)) < 0.01 || Math.abs(x - a.x) < 0.01 || Math.abs(x - (a.x + a.width)) < 0.01;
  expect(onBorder).toBe(true);
});

test("arrow labels follow their arrow and are editable text", () => {
  const layout = computeStewardDiagramLayout(model(TWO_ROWS), false);
  const label = layout.texts.find((el) => el.block.lines.join(" ") === "hands off")!;
  expect(label.fieldRef).toEqual({ scope: "edge", index: 1, field: "label" });
  const current = model(TWO_ROWS);
  expect(stewardFieldValue(current, { scope: "edge", index: 1, field: "label" })).toBe("hands off");
  const renamed = withStewardFieldValue(current, { scope: "edge", index: 1, field: "label" }, "escalates");
  expect(renamed.edges[1]!.label).toBe("escalates");
  expect(withStewardFieldValue(current, { scope: "edge", index: 1, field: "label" }, " ").edges[1]!.label).toBeUndefined();
});

test("themes recolor header bands and arrows with their own marker ids", () => {
  const themed = model(TWO_ROWS);
  themed.theme = "plum";
  const palette = stewardDiagramPalette("plum", false);
  const layout = computeStewardDiagramLayout(themed, false);
  expect(layout.rects.some((el) => el.fill === palette.ink)).toBe(true);
  expect(layout.paths.find((el) => el.edgeIndex === 0)!.color).toBe(palette.edgeStrong);
  expect(stewardMarkerId("primary", false, "plum")).toBe("aperture-sd-arrow-primary-plum");
  expect(stewardMarkerId("primary", true)).toBe("aperture-sd-arrow-primary-dark");
  expect(stewardDiagramMarkerDefs(false, "plum")).toContain(`fill="${palette.edgeStrong}"`);
  const svg = renderStewardDiagramSvg(themed, false);
  expect(svg).toContain('marker-end="url(#aperture-sd-arrow-primary-plum)"');
});

test("a card's own color recolors only that card, and square corners sharpen every box", () => {
  const colored = model(TWO_ROWS);
  colored.rows[0]![1]!.color = "green";
  colored.corners = "square";
  const layout = computeStewardDiagramLayout(colored, false);
  const header = (id: string) => layout.rects.find((el) => el.cardId === id && el.corners === "top")!;
  expect(header("b").fill).not.toBe(header("a").fill);
  expect(header("a").fill).toBe(stewardDiagramPalette(undefined, false).ink);
  expect(layout.rects.filter((el) => el.cardId && el.shadow).every((el) => el.rx === 3)).toBe(true);
});

test("text fields read and write every scope; emptied optional fields disappear", () => {
  const source = model(
    JSON.stringify({
      title: "Chart",
      footnote: "Footnote",
      rows: [[{ id: "a", title: "Alpha", subtitle: "Sub", note: "Watch", bullets: ["One", "Two"], footer: { text: "Done", tone: "positive" } }]],
    }),
  );
  const read = (ref: Parameters<typeof stewardFieldValue>[1]) => stewardFieldValue(source, ref);
  expect(read({ scope: "chart", field: "footnote" })).toBe("Footnote");
  expect(read({ scope: "chart", field: "subtitle" })).toBe("");
  expect(read({ scope: "card", cardId: "a", field: "note" })).toBe("Watch");
  expect(read({ scope: "card", cardId: "a", field: "footer" })).toBe("Done");
  expect(read({ scope: "bullet", cardId: "a", index: 1 })).toBe("Two");
  expect(read({ scope: "bullet", cardId: "a", index: 5 })).toBe("");
  expect(read({ scope: "card", cardId: "missing", field: "title" })).toBe("");
  expect(read({ scope: "edge", index: 0, field: "label" })).toBe("");

  const card = (next: StewardDiagramModel) => next.rows[0]![0]!;
  expect(card(withStewardFieldValue(source, { scope: "card", cardId: "a", field: "title" }, "  "))).toMatchObject({ title: "Alpha" });
  expect(card(withStewardFieldValue(source, { scope: "card", cardId: "a", field: "subtitle" }, "")).subtitle).toBeUndefined();
  expect(card(withStewardFieldValue(source, { scope: "card", cardId: "a", field: "footer" }, "Open")).footer).toEqual({ text: "Open", tone: "positive" });
  expect(card(withStewardFieldValue(source, { scope: "card", cardId: "a", field: "footer" }, "")).footer).toBeUndefined();
  expect(card(withStewardFieldValue(source, { scope: "bullet", cardId: "a", index: 0 }, "")).bullets).toEqual(["Two"]);
  const noBullets = withStewardFieldValue(withStewardFieldValue(source, { scope: "bullet", cardId: "a", index: 0 }, ""), { scope: "bullet", cardId: "a", index: 0 }, "");
  expect(card(noBullets).bullets).toBeUndefined();
  expect(withStewardFieldValue(source, { scope: "chart", field: "footnote" }, "").footnote).toBeUndefined();
  expect(withStewardFieldValue(source, { scope: "card", cardId: "missing", field: "title" }, "X")).toEqual(source);
  expect(withStewardFieldValue(source, { scope: "edge", index: 3, field: "label" }, "X")).toEqual(source);
});

test("card parsing keeps only usable bullets, footers, and legend entries", () => {
  const parsed = model(
    JSON.stringify({
      rows: [
        { cards: [{ id: "a", title: "Alpha", bullets: ["", 4, "Keep"], footer: { text: "" } }, { id: "a", title: "Duplicate" }, "junk"] },
        "not a row",
        [{ id: "b", title: "Bravo", footer: "flat", connects: ["junk", { to: "a", label: "back" }] }],
      ],
      edges: ["junk", { from: "a", to: "b" }, { from: "a", to: "b" }, { from: "a", to: "a" }],
      legend: ["junk", { label: "" }, { kind: "contingent", label: "Maybe" }],
    }),
  );
  expect(parsed.rows.map((row) => row.map((card) => card.id))).toEqual([["a"], ["b"]]);
  expect(parsed.rows[0]![0]!.bullets).toEqual(["Keep"]);
  expect(parsed.rows[0]![0]!.footer).toBeUndefined();
  expect(parsed.rows[1]![0]!.footer).toBeUndefined();
  expect(parsed.edges).toEqual([
    { from: "b", to: "a", kind: "primary", label: "back", bend: undefined },
    { from: "a", to: "b", kind: "primary", label: undefined, bend: undefined },
  ]);
  expect(parsed.legend).toEqual([{ kind: "contingent", label: "Maybe" }]);
  expect(model(JSON.stringify({ rows: [[{ id: "a", title: "A" }]], legend: [{ label: "" }] })).legend).toBeUndefined();
  expect(parseStewardDiagram(JSON.stringify({ rows: [["junk"]] }))).toBeNull();
  expect(parseStewardDiagram('"just a string"')).toBeNull();
});
