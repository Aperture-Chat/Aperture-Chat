import { describe, expect, it } from "vitest";
import { argb, cellText, escapeXml, WarningLog } from "./xml";

describe("xlsx xml helpers", () => {
  it("escapes markup characters", () => {
    expect(escapeXml(`a<b & "c" 'd'>`)).toBe("a&lt;b &amp; &quot;c&quot; &apos;d&apos;&gt;");
  });

  it("writes #rrggbb colors as opaque ARGB", () => {
    expect(argb("#087d8b")).toBe("FF087D8B");
  });

  it("strips characters XML 1.0 cannot hold and reports it once", () => {
    const log = new WarningLog();
    expect(cellText("ok\u0001\u0008tab\there", log)).toBe("oktab\there");
    expect(cellText("again\u000b", log)).toBe("again");
    expect(log.list()).toEqual(["Removed characters Excel cannot store from 2 cells."]);
  });

  it("keeps a literal _xHHHH_ sequence from being decoded by Excel", () => {
    expect(cellText("code _x0041_ here", new WarningLog())).toBe("code _x005F_x0041_ here");
  });

  it("truncates text past Excel's 32,767-character cell limit", () => {
    const log = new WarningLog();
    expect(cellText("x".repeat(40_000), log)).toHaveLength(32_767);
    expect(log.list()).toEqual(["Shortened 1 cell to Excel's 32,767-character limit."]);
  });

  it("shortens derived text too, without counting it", () => {
    expect(cellText("z".repeat(40_000))).toHaveLength(32_767);
  });

  it("keeps text of exactly 32,767 characters whole and silent", () => {
    const log = new WarningLog();
    expect(cellText("y".repeat(32_767), log)).toHaveLength(32_767);
    expect(log.list()).toEqual([]);
  });

  it("normalizes carriage returns to line feeds", () => {
    expect(cellText("a\r\nb\rc", new WarningLog())).toBe("a\nb\nc");
  });
});
