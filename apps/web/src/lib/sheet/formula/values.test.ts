import { describe, expect, it } from "vitest";
import { dateToSerial, serialToDate } from "./values";

describe("Excel serial dates", () => {
  it("follows Excel's 1900 calendar, including its fictional leap day", () => {
    expect(serialToDate(0)).toEqual({ year: 1900, month: 1, day: 0, weekday: 6 });
    expect(serialToDate(1)).toEqual({ year: 1900, month: 1, day: 1, weekday: 0 });
    expect(serialToDate(59)).toEqual({ year: 1900, month: 2, day: 28, weekday: 2 });
    expect(serialToDate(60)).toEqual({ year: 1900, month: 2, day: 29, weekday: 3 });
    expect(serialToDate(61)).toEqual({ year: 1900, month: 3, day: 1, weekday: 4 });
    expect(serialToDate(46461)).toEqual({ year: 2027, month: 3, day: 15, weekday: 1 });
    expect(dateToSerial(2027, 3, 15)).toBe(46461);
    expect(dateToSerial(1900, 1, 1)).toBe(1);
  });
});
