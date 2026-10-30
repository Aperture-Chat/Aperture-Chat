import { describe, expect, it } from "vitest";
import { buildGeometry, panesForRect } from "./geometry";
import type { Sheet } from "./sheetModel";

/** Columns 100px and rows 24px wide, as the defaults are. */
function geometryWith(freeze?: { rows: number; cols: number }) {
  const sheet: Sheet = { id: "s", name: "S", cells: {}, freeze };
  return buildGeometry(sheet, { rows: 40, cols: 20 }, new Set(), 1);
}

describe("panesForRect", () => {
  it("puts everything in the main pane when nothing is frozen", () => {
    expect(panesForRect(geometryWith(), { x: 0, y: 0, w: 640, h: 320 })).toEqual(["main"]);
  });

  it("spreads a chart anchored in a frozen column across the freeze line, as Excel draws it", () => {
    const geometry = geometryWith({ rows: 1, cols: 1 });
    expect(panesForRect(geometry, { x: 2, y: 218, w: 640, h: 320 })).toEqual(["main", "left"]);
    expect(panesForRect(geometry, { x: 2, y: 2, w: 640, h: 320 })).toEqual(["main", "top", "left", "corner"]);
  });

  it("keeps a chart that fits inside one region in that region only", () => {
    const geometry = geometryWith({ rows: 1, cols: 1 });
    expect(panesForRect(geometry, { x: 2, y: 50, w: 90, h: 100 })).toEqual(["left"]);
    expect(panesForRect(geometry, { x: 300, y: 2, w: 200, h: 20 })).toEqual(["top"]);
    expect(panesForRect(geometry, { x: 300, y: 300, w: 200, h: 200 })).toEqual(["main"]);
  });

  it("treats a box that only touches the freeze line as on one side", () => {
    const geometry = geometryWith({ rows: 1, cols: 1 });
    expect(panesForRect(geometry, { x: 0, y: 100, w: 100, h: 50 })).toEqual(["left"]);
    expect(panesForRect(geometry, { x: 100, y: 100, w: 50, h: 50 })).toEqual(["main"]);
    expect(panesForRect(geometry, { x: 300, y: 0, w: 50, h: 24 })).toEqual(["top"]);
    expect(panesForRect(geometry, { x: 300, y: 24, w: 50, h: 24 })).toEqual(["main"]);
  });
});
