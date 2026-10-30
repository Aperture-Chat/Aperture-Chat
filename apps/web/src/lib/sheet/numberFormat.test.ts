import { describe, expect, it } from "vitest";
import { ERR, dateToSerial, timeToFraction } from "./formula/values";
import {
  BUILTIN_NUMBER_FORMATS,
  NUMBER_FORMAT_PRESETS,
  adjustDecimals,
  builtinNumberFormatId,
  formatCellValue,
  isDateFormat,
  numberFormatKind,
  numberFormatLabel,
  parseCellInput,
} from "./numberFormat";

const ACCOUNTING = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)';
const MARCH_15_2027 = dateToSerial(2027, 3, 15);
const text = (value: Parameters<typeof formatCellValue>[0], format?: string) => formatCellValue(value, format).text;

describe("formatCellValue: General", () => {
  it("aligns text left, numbers right, and booleans and errors in the centre", () => {
    expect(formatCellValue("Plan", undefined)).toEqual({ text: "Plan", align: "left" });
    expect(formatCellValue(1234.5)).toEqual({ text: "1234.5", align: "right" });
    expect(formatCellValue(true, "0.00")).toEqual({ text: "TRUE", align: "center" });
    expect(formatCellValue(ERR.div0, "0.00")).toEqual({ text: "#DIV/0!", align: "center" });
    expect(formatCellValue(null, "0.00")).toEqual({ text: "", align: "left" });
  });

  it("shows integers below 1e11 plainly and rounds the rest to 10 significant digits", () => {
    expect([0, -42, 99_999_999_999, 1 / 3, 0.1 + 0.2, 123456.7890123456, 0.00001234].map((n) => text(n))).toEqual([
      "0",
      "-42",
      "99999999999",
      "0.3333333333",
      "0.3",
      "123456.789",
      "0.00001234",
    ]);
    expect(text(1234.5, "General")).toBe("1234.5");
  });

  it("places the point for every size of rounded number", () => {
    expect([0.5, -0.25, 123.0000000001, 12345678901.5, 1e-9].map((n) => text(n))).toEqual([
      "0.5",
      "-0.25",
      "123",
      "12345678900",
      "0.000000001",
    ]);
    expect(text(99_999_999_999.99)).toBe("1E+11");
  });

  it("switches to six-digit scientific at 1e11 and below 1e-9", () => {
    expect(text(12_345_678_901_234)).toBe("1.23457E+13");
    expect(text(1e11)).toBe("1E+11");
    expect(text(-1.5e-12)).toBe("-1.5E-12");
    expect(text(1e-10)).toBe("1E-10");
  });
});

describe("formatCellValue: digit placeholders", () => {
  it("groups thousands and pads decimals", () => {
    expect(text(1234.5, "#,##0.00")).toBe("1,234.50");
    expect(text(1234567.891, "#,##0")).toBe("1,234,568");
    expect(text(5, "0,000")).toBe("0,005");
    expect(text(-1234.5, "#,##0.00")).toBe("-1,234.50");
  });

  it("rounds half away from zero on Excel's 15 significant digits", () => {
    expect(text(2.5, "0")).toBe("3");
    expect(text(1.005, "0.00")).toBe("1.01");
    expect(text(12345678901234567, "0")).toBe("12345678901234600");
    expect(text(1e20, "0")).toBe("100000000000000000000");
    expect([text(0.6, "0"), text(0.005, "0.00"), text(0.004, "0.00")]).toEqual(["1", "0.01", "0.00"]);
  });

  it("treats 0 as a forced digit, # as optional, and ? as a space", () => {
    expect(text(0, "#,###")).toBe("");
    expect(text(0.5, "#.00")).toBe(".50");
    expect(text(12.5, ".00")).toBe("12.50");
    expect(text(1, "0.##")).toBe("1.");
    expect([1.5, 1.25, 1].map((n) => text(n, "0.0#"))).toEqual(["1.5", "1.25", "1.0"]);
    expect(text(1.5, "0.0??")).toBe("1.5  ");
    expect(text(5, "000")).toBe("005");
    expect(text(5, "??0")).toBe("  5");
  });

  it("keeps literals between digits in place", () => {
    expect(text(5551234567, "(000) 000-0000")).toBe("(555) 123-4567");
    expect(text(123456789, "000-00-0000")).toBe("123-45-6789");
  });

  it("shows stray commas, slashes, brackets, and quotes as written", () => {
    expect([",0", "0/", "/0", "[0", '0" units'].map((code) => text(5, code))).toEqual([",5", "5/", "/5", "[5", "5 units"]);
  });

  it("puts the minus sign of a one-section format in front of everything", () => {
    expect(text(-5, "$#,##0")).toBe("-$5");
    expect(text(-0.001, "0")).toBe("-0");
  });
});

describe("formatCellValue: sections, conditions, and colors", () => {
  it("uses the negative section without a sign, in its color", () => {
    expect(formatCellValue(-1234.5, "#,##0.00;[Red](#,##0.00)")).toEqual({ text: "(1,234.50)", color: "#ff0000", align: "right" });
    expect(formatCellValue(1234.5, "#,##0.00;[Red](#,##0.00)")).toEqual({ text: "1,234.50", align: "right" });
    expect(text(-5, "0;0")).toBe("5");
  });

  it("uses the zero section and lets empty sections hide values", () => {
    expect(text(0, '0.00;(0.00);"zero"')).toBe("zero");
    expect(text(0, "0;-0;;@")).toBe("");
    expect(text(5, ";;;")).toBe("");
    expect(text("hidden", ";;;")).toBe("");
  });

  it("picks sections by condition and falls back to the unconditioned one", () => {
    const format = '[>=1000000]0.0,,"M";[>=1000]0.0,"K";0';
    expect([1_234_567, 1234, 999].map((n) => text(n, format))).toEqual(["1.2M", "1.2K", "999"]);
    expect(text(1234, '[>=1000]#,##0,"K";0')).toBe("1K");
    expect(text(-5, '[>=1000]#,##0,"K";0')).toBe("-5");
    expect(text(-5, "[>=0]0;0")).toBe("5");
  });

  it("drops the sign only when the chosen section takes negatives alone", () => {
    const format = "[Blue][>=100]0;[Red][<0]-0.0;0";
    expect(formatCellValue(-5, format)).toEqual({ text: "-5.0", color: "#ff0000", align: "right" });
    expect(formatCellValue(150, format)).toEqual({ text: "150", color: "#0000ff", align: "right" });
    expect(formatCellValue(5, format)).toEqual({ text: "5", align: "right" });
  });

  it("keeps or drops the sign by what each condition admits", () => {
    expect([text(5, "0;[<-5]0"), text(-10, "0;[<-5]0")]).toEqual(["5", "10"]);
    expect([text(-5, "[>0]0;0"), text(-5, "[>=1]0;0"), text(-5, "[>-10]0;0")]).toEqual(["5", "-5", "-5"]);
    expect([text(-5, '[<=-1]"("0")";0'), text(-5, '[<1]"low "0.0;0'), text(-1, '[=-1]"minus one";0')]).toEqual([
      "(5)",
      "-low 5.0",
      "minus one",
    ]);
  });

  it("fills the cell with # when no section takes the number", () => {
    expect(text(5, "[>100]0;[<-100]0")).toBe("#######");
  });

  it("reads palette colors as hex", () => {
    expect(formatCellValue(1, "[Color10]0").color).toBe("#008000");
    expect(formatCellValue(1, "[color 3]0").color).toBe("#ff0000");
    expect(formatCellValue(1, "[Magenta]0").color).toBe("#ff00ff");
  });
});

describe("formatCellValue: percent, scaling, and scientific", () => {
  it("multiplies by 100 for each percent sign", () => {
    expect(text(0.256, "0.0%")).toBe("25.6%");
    expect(text(0.1234, "0%")).toBe("12%");
  });

  it("divides by 1,000 for each trailing comma", () => {
    expect(text(1_234_567, '#,##0,,"M"')).toBe("1M");
    expect(text(1_234_567, '0.0,,"M"')).toBe("1.2M");
    expect(text(1_234_567, "#,##0,")).toBe("1,235");
  });

  it("writes mantissa and exponent like Excel", () => {
    expect(text(12345, "0.00E+00")).toBe("1.23E+04");
    expect(text(0.000123, "0.00E+00")).toBe("1.23E-04");
    expect(text(12345, "0.00E-00")).toBe("1.23E04");
    expect(text(-12345, "0.00E+00")).toBe("-1.23E+04");
    expect(text(0, "0.00E+00")).toBe("0.00E+00");
    expect(text(99999, "0.0E+00")).toBe("1.0E+05");
    expect(text(5, "0E+0")).toBe("5E+0");
    expect(text(12.5, "0.00E+00")).toBe("1.25E+01");
  });

  it("fills every whole-digit placeholder of a zero-only mantissa", () => {
    expect([text(12345, "00.0E+0"), text(0, "00.0E+0")]).toEqual(["12.3E+3", "00.0E+0"]);
  });

  it("uses engineering exponents when # widens the mantissa", () => {
    expect([12345, 1234, 999_999, 0.01234].map((n) => text(n, "##0.0E+0"))).toEqual(["12.3E+3", "1.2E+3", "1.0E+6", "12.3E-3"]);
  });
});

describe("formatCellValue: fractions", () => {
  it("writes mixed fractions with Excel's padding", () => {
    expect(text(0.3333, "# ?/?")).toBe(" 1/3");
    expect(text(1.5, "# ?/?")).toBe("1 1/2");
    expect(text(-1.5, "# ?/?")).toBe("-1 1/2");
    expect(text(2, "# ?/?")).toBe("2    ");
    expect(text(0, "# ?/?")).toBe("0    ");
    expect(text(0.3333, "# ??/??")).toBe("  1/3 ");
    expect(text(3.14159, "# ???/???")).toBe("3  16/113");
    expect(text(1234.5, "# ?/?")).toBe("1234 1/2");
    expect(text(0.1, "# ?/?")).toBe(" 1/9");
    expect(text(1.5, "# ? / ?")).toBe("1 1 / 2");
    expect(text(1e20, "?/?")).toBe("100000000000000000000/1");
  });

  it("keeps the simpler fraction when two are equally close", () => {
    expect(text(1 / 18, "?/?")).toBe("0/1");
  });

  it("finds the closest fraction the placeholders allow", () => {
    const closest = (x: number, maxDen: number) => {
      let best = { num: 0, den: 1 };
      for (let den = 1; den <= maxDen; den += 1) {
        const num = Math.round(x * den);
        if (Math.abs(x - num / den) < Math.abs(x - best.num / best.den) - 1e-15) best = { num, den };
      }
      return best;
    };
    for (let step = 0; step < 1000; step += 1) {
      const x = step / 1000 + (step % 7) * 1e-5;
      const one = closest(x, 9);
      const two = closest(x, 99);
      expect([x, text(x, "?/?")]).toEqual([x, `${one.num}/${one.den}`]);
      expect([x, text(x, "??/??")]).toEqual([x, `${String(two.num).padStart(2)}/${String(two.den).padEnd(2)}`]);
    }
  });

  it("writes improper fractions and fixed denominators", () => {
    expect(text(1.75, "?/?")).toBe("7/4");
    expect(text(0, "?/?")).toBe("0/1");
    expect(text(0.5, "# ??/16")).toBe("  8/16");
    expect(text(1.99, "# ??/16")).toBe("2      ");
    expect(text(0.3, "# ?/10")).toBe(" 3/10");
    expect(text(1.5, '# ?/4" lbs"')).toBe("1 2/4 lbs");
  });
});

describe("formatCellValue: text and literals", () => {
  it("applies the text section to text and leaves text alone without one", () => {
    expect(text("Ada", '0;-0;0;"Name: "@')).toBe("Name: Ada");
    expect(formatCellValue("Ada", "0;-0;0;[Red]@")).toEqual({ text: "Ada", color: "#ff0000", align: "left" });
    expect(text("Ada", "0.00")).toBe("Ada");
    expect(text("Ada", '0;0;0;"n/a"')).toBe("n/a");
    expect(text(5, "@")).toBe("5");
    expect(text(5, '0;"Note: "@')).toBe("5");
    expect(text("Ada", "0;0;0;@*-")).toBe("Ada");
  });

  it("passes quoted, escaped, and plain symbols through and ignores fills", () => {
    expect(text(5, '0" items"')).toBe("5 items");
    expect(text(5, "\\#0")).toBe("#5");
    expect(text(5, "0_)")).toBe("5 ");
    expect(text(5, "**0")).toBe("5");
    expect(text(5, "$ +-/():0")).toBe("$ +-/():5");
  });

  it("formats Excel's accounting layout", () => {
    expect(text(1234.5, ACCOUNTING)).toBe(" $1,234.50 ");
    expect(text(-1234.5, ACCOUNTING)).toBe(" $(1,234.50)");
    expect(text(0, ACCOUNTING)).toBe(" $-   ");
    expect(text("Total", ACCOUNTING)).toBe(" Total ");
  });

  it("shows the currency symbol of a locale bracket and drops the locale", () => {
    expect(text(1234.5, "[$€-x-euro2] #,##0.00")).toBe("€ 1,234.50");
    expect(text(1234.5, "#,##0.00 [$€-407]")).toBe("1,234.50 €");
    expect(text(MARCH_15_2027, "[$-409]mmmm d, yyyy")).toBe("March 15, 2027");
  });

  it("supports General inside a section", () => {
    expect(text(-2.5, 'General;[Red]"minus "General')).toBe("minus 2.5");
    expect([0, 0.5, -5].map((n) => text(n, '"Total: "General'))).toEqual(["Total: 0", "Total: 0.5", "-Total: 5"]);
  });
});

describe("formatCellValue: dates and times", () => {
  it("writes day, month, and year codes", () => {
    expect(MARCH_15_2027).toBe(46461);
    expect(text(46461, "mmmm d, yyyy")).toBe("March 15, 2027");
    expect(text(46461, "m/d/yyyy")).toBe("3/15/2027");
    expect(text(46461, "dd/mm/yy")).toBe("15/03/27");
    expect(text(46461, "ddd, mmm d")).toBe("Mon, Mar 15");
    expect(text(46461, "dddd mmmmm")).toBe("Monday M");
    expect(text(46461, "DD-MMM-YYYY")).toBe("15-Mar-2027");
    expect(text(46461, "[$-F800]dddd, mmmm dd, yyyy")).toBe("Monday, March 15, 2027");
    expect(text(46461, "d-mmm-yy")).toBe("15-Mar-27");
    expect(text(46461, "d.m.yyyy")).toBe("15.3.2027");
  });

  it("follows Excel's 1900 calendar, including day 0 and 1900-02-29", () => {
    expect(text(60, "m/d/yyyy")).toBe("2/29/1900");
    expect(text(0, "m/d/yyyy")).toBe("1/0/1900");
    expect(text(1, "dddd")).toBe("Sunday");
    expect(text(2958465, "m/d/yyyy")).toBe("12/31/9999");
  });

  it("writes hours, minutes, seconds, and AM/PM", () => {
    expect(text(0.5, "h:mm AM/PM")).toBe("12:00 PM");
    expect(text(0, "h:mm AM/PM")).toBe("12:00 AM");
    expect(text(0.75, "h:mm a/p")).toBe("6:00 p");
    expect(text(0.75, "hh:mm:ss")).toBe("18:00:00");
    expect(text(46461.75, "m/d/yyyy h:mm")).toBe("3/15/2027 18:00");
    expect(text(46461 + timeToFraction(9, 5, 7), "yyyy-mm-dd hh:mm:ss")).toBe("2027-03-15 09:05:07");
  });

  it("reads m as minutes after an hour or before seconds", () => {
    const value = 46461 + timeToFraction(9, 5, 7);
    expect(text(value, "mm")).toBe("03");
    expect(text(value, "h:mm")).toBe("9:05");
    expect(text(value, "mm:ss")).toBe("05:07");
    expect(text(timeToFraction(1, 2, 3), "h:ss")).toBe("1:03");
  });

  it("rounds to the second unless fractions of a second are shown", () => {
    const almostNoon = timeToFraction(11, 59, 59.6);
    expect(text(almostNoon, "h:mm:ss")).toBe("12:00:00");
    expect(text(almostNoon, "h:mm:ss.0")).toBe("11:59:59.6");
    expect(text(timeToFraction(0, 1, 1.37), "mm:ss.00")).toBe("01:01.37");
    expect(text(46461 + timeToFraction(9, 5, 7.5), "m/d/yyyy h:mm:ss.0")).toBe("3/15/2027 9:05:07.5");
  });

  it("counts elapsed hours, minutes, and seconds", () => {
    expect(text(1.75, "[h]:mm")).toBe("42:00");
    expect(text(0.5, "[mm]:ss")).toBe("720:00");
    expect(text(0.01, "[s]")).toBe("864");
    expect(text(timeToFraction(0, 12, 30.5), "[s].0")).toBe("750.5");
    expect(text(-1.5, "[h]:mm;-[h]:mm")).toBe("-36:00");
  });

  it("shows ####### for dates Excel cannot display", () => {
    expect(text(2958466, "m/d/yyyy")).toBe("#######");
    expect(text(-1, "m/d/yyyy")).toBe("#######");
    expect(text(-0.25, "[h]:mm")).toBe("#######");
  });
});

describe("parseCellInput", () => {
  it("recognises empty cells, formulas, and forced text", () => {
    expect(parseCellInput("")).toEqual({ kind: "empty" });
    expect(parseCellInput("   ")).toEqual({ kind: "empty" });
    expect(parseCellInput("=SUM(A1:A3)")).toEqual({ kind: "formula", formula: "SUM(A1:A3)" });
    expect(parseCellInput("=")).toEqual({ kind: "value", value: "=" });
    expect(parseCellInput("'00123")).toEqual({ kind: "value", value: "00123" });
    expect(parseCellInput("'=A1")).toEqual({ kind: "value", value: "=A1" });
  });

  it("reads plain and grouped numbers", () => {
    expect(parseCellInput("42")).toEqual({ kind: "value", value: 42 });
    expect(parseCellInput(" -3.5 ")).toEqual({ kind: "value", value: -3.5 });
    expect(parseCellInput("+7")).toEqual({ kind: "value", value: 7 });
    expect(parseCellInput(".5")).toEqual({ kind: "value", value: 0.5 });
    expect(parseCellInput("(42)")).toEqual({ kind: "value", value: -42 });
    expect(parseCellInput("-1")).toEqual({ kind: "value", value: -1 });
    expect(parseCellInput("-0")).toEqual({ kind: "value", value: 0 });
    expect(parseCellInput("1,234.5")).toEqual({ kind: "value", value: 1234.5, format: "#,##0.00" });
    expect(parseCellInput("1,234")).toEqual({ kind: "value", value: 1234, format: "#,##0" });
  });

  it("reads currency and keeps the typed style", () => {
    expect(parseCellInput("$1,234.50")).toEqual({ kind: "value", value: 1234.5, format: "$#,##0.00" });
    expect(parseCellInput("$5")).toEqual({ kind: "value", value: 5, format: "$#,##0" });
    expect(parseCellInput("$5.5")).toEqual({ kind: "value", value: 5.5, format: "$#,##0.00" });
    expect(parseCellInput("-$5")).toEqual({ kind: "value", value: -5, format: "$#,##0" });
    expect(parseCellInput("$-5")).toEqual({ kind: "value", value: -5, format: "$#,##0" });
    expect(parseCellInput("($5)")).toEqual({ kind: "value", value: -5, format: "$#,##0_);($#,##0)" });
    expect(parseCellInput("£7.25")).toEqual({ kind: "value", value: 7.25, format: '"£"#,##0.00' });
  });

  it("reads percentages with the typed decimals", () => {
    expect(parseCellInput("12%")).toEqual({ kind: "value", value: 0.12, format: "0%" });
    expect(parseCellInput("12.5%")).toEqual({ kind: "value", value: 0.125, format: "0.0%" });
    expect(parseCellInput("33.3%")).toEqual({ kind: "value", value: 0.333, format: "0.0%" });
    expect(parseCellInput("-3%")).toEqual({ kind: "value", value: -0.03, format: "0%" });
  });

  it("reads scientific notation", () => {
    expect(parseCellInput("1e5")).toEqual({ kind: "value", value: 100000, format: "0.00E+00" });
    expect(parseCellInput("-1.5E-3")).toEqual({ kind: "value", value: -0.0015, format: "0.00E+00" });
  });

  it("reads dates and times with a matching format", () => {
    expect(parseCellInput("3/15/2027")).toEqual({ kind: "value", value: 46461, format: "m/d/yyyy" });
    expect(parseCellInput("2027-03-15")).toEqual({ kind: "value", value: 46461, format: "yyyy-mm-dd" });
    expect(parseCellInput("15-Mar-2027")).toEqual({ kind: "value", value: 46461, format: "d-mmm-yyyy" });
    expect(parseCellInput("Mar 15, 2027")).toEqual({ kind: "value", value: 46461, format: "mmm d, yyyy" });
    expect(parseCellInput("March 15, 2027")).toEqual({ kind: "value", value: 46461, format: "mmmm d, yyyy" });
    expect(parseCellInput("2:30 PM")).toEqual({ kind: "value", value: timeToFraction(14, 30, 0), format: "h:mm AM/PM" });
    expect(parseCellInput("14:30")).toEqual({ kind: "value", value: timeToFraction(14, 30, 0), format: "h:mm" });
    expect(parseCellInput("14:30:15")).toEqual({ kind: "value", value: timeToFraction(14, 30, 15), format: "h:mm:ss" });
    expect(parseCellInput("3/15/2027 9:00")).toEqual({ kind: "value", value: 46461 + 9 / 24, format: "m/d/yyyy h:mm" });
    expect(parseCellInput("2027-03-15 14:30")).toEqual({ kind: "value", value: 46461 + timeToFraction(14, 30, 0), format: "yyyy-mm-dd h:mm" });
  });

  it("reads TRUE and FALSE in any case", () => {
    expect(parseCellInput("TRUE")).toEqual({ kind: "value", value: true });
    expect(parseCellInput("false")).toEqual({ kind: "value", value: false });
    expect(parseCellInput(" True ")).toEqual({ kind: "value", value: true });
  });

  it("keeps everything else as the text that was typed", () => {
    for (const entry of ["hello", " hello ", "2/30/2027", "0x10", "1,23", "Infinity", "1.2.3", "(-5)", "$5%", "$1e5", "."]) {
      expect(parseCellInput(entry)).toEqual({ kind: "value", value: entry });
    }
  });
});

describe("built-in number formats", () => {
  it("lists the en-US built-in table by id", () => {
    const ids = Object.keys(BUILTIN_NUMBER_FORMATS).map(Number);
    const expected = [...Array(23).keys(), ...Array.from({ length: 13 }, (_, index) => 37 + index)];
    expect(ids).toEqual(expected);
    expect(BUILTIN_NUMBER_FORMATS[0]).toBe("General");
    expect(BUILTIN_NUMBER_FORMATS[14]).toBe("m/d/yyyy");
    expect(BUILTIN_NUMBER_FORMATS[44]).toBe(ACCOUNTING);
    expect(BUILTIN_NUMBER_FORMATS[49]).toBe("@");
  });

  it("finds the id of every built-in code, including escaped spellings", () => {
    for (const [id, code] of Object.entries(BUILTIN_NUMBER_FORMATS)) expect(builtinNumberFormatId(code)).toBe(Number(id));
    expect(builtinNumberFormatId("general")).toBe(0);
    expect(builtinNumberFormatId('_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)')).toBe(44);
    expect(builtinNumberFormatId("[$-409]m/d/yyyy")).toBe(14);
    expect(builtinNumberFormatId("0.000")).toBeNull();
  });
});

describe("NUMBER_FORMAT_PRESETS", () => {
  it("offers the toolbar formats with examples from the formatter", () => {
    expect(NUMBER_FORMAT_PRESETS.map((preset) => [preset.label, preset.format, preset.example])).toEqual([
      ["General", undefined, "1234.5"],
      ["Number", "#,##0.00", "1,234.50"],
      ["Currency", "$#,##0.00", "$1,234.50"],
      ["Accounting", ACCOUNTING, "$1,234.50"],
      ["Percent", "0%", "12%"],
      ["Percent (2 decimals)", "0.00%", "12.34%"],
      ["Short date", "m/d/yyyy", "3/15/2027"],
      ["Long date", "mmmm d, yyyy", "March 15, 2027"],
      ["Time", "h:mm AM/PM", "2:30 PM"],
      ["Date & time", "m/d/yyyy h:mm", "3/15/2027 14:30"],
      ["Scientific", "0.00E+00", "1.23E+03"],
      ["Fraction", "# ?/?", "1 1/4"],
      ["Text", "@", "1234.5"],
      ["Whole number", "#,##0", "1,235"],
    ]);
    expect(new Set(NUMBER_FORMAT_PRESETS.map((preset) => preset.id)).size).toBe(NUMBER_FORMAT_PRESETS.length);
  });
});

describe("adjustDecimals", () => {
  it("starts General from the decimals the sample shows", () => {
    expect(adjustDecimals(undefined, 1, 1234.5)).toBe("0.00");
    expect(adjustDecimals(undefined, -1, 1234.56)).toBe("0.0");
    expect(adjustDecimals("General", 1, 5)).toBe("0.0");
    expect(adjustDecimals(undefined, 1)).toBe("0.0");
    expect(adjustDecimals(undefined, -1, 5)).toBe("General");
    expect(adjustDecimals(undefined, 1, 12_345_678_901_234)).toBe("0.000000E+00");
    expect(adjustDecimals(undefined, -1, 1234.5)).toBe("0");
    expect(adjustDecimals(undefined, 1, "Plan")).toBe("0.0");
  });

  it("adds and removes decimals in number, currency, percent, and scientific codes", () => {
    expect(adjustDecimals("#,##0.00", 1)).toBe("#,##0.000");
    expect(adjustDecimals("#,##0.0", -1)).toBe("#,##0");
    expect(adjustDecimals("$#,##0", 1)).toBe("$#,##0.0");
    expect(adjustDecimals("0%", 1)).toBe("0.0%");
    expect(adjustDecimals("0.00%", -1)).toBe("0.0%");
    expect(adjustDecimals("0.00E+00", 1)).toBe("0.000E+00");
    expect(adjustDecimals("0.0E+00", -1)).toBe("0E+00");
    expect(adjustDecimals('#,##0,"K"', 1)).toBe('#,##0.0,"K"');
    expect(adjustDecimals('"v0.0 "0', 1)).toBe('"v0.0 "0.0');
    expect(adjustDecimals("0.0##", 1)).toBe("0.0##0");
  });

  it("changes every number section, including the accounting dash", () => {
    expect(adjustDecimals("#,##0.00;[Red](#,##0.00)", 1)).toBe("#,##0.000;[Red](#,##0.000)");
    expect(adjustDecimals(ACCOUNTING, 1)).toBe('_($* #,##0.000_);_($* (#,##0.000);_($* "-"???_);_(@_)');
    expect(adjustDecimals(adjustDecimals(ACCOUNTING, -1), -1)).toBe(BUILTIN_NUMBER_FORMATS[42]);
    expect(adjustDecimals(BUILTIN_NUMBER_FORMATS[42], 1)).toBe('_($* #,##0.0_);_($* (#,##0.0);_($* "-"?_);_(@_)');
  });

  it("round-trips and leaves codes without decimals alone", () => {
    for (const code of ["0", "#,##0.00", "$#,##0.00_);($#,##0.00)", ACCOUNTING, "0.00%", "0.00E+00", BUILTIN_NUMBER_FORMATS[42]]) {
      expect(adjustDecimals(adjustDecimals(code, 1), -1)).toBe(code);
    }
    for (const code of ["0", "m/d/yyyy", "@", "# ?/?", '"x"']) expect(adjustDecimals(code, -1)).toBe(code);
    expect(adjustDecimals("m/d/yyyy", 1)).toBe("m/d/yyyy");
    expect(adjustDecimals("h:mm:ss.00", 1)).toBe("h:mm:ss.00");
    const thirty = `0.${"0".repeat(30)}`;
    expect(adjustDecimals(thirty, 1)).toBe(thirty);
  });
});

describe("format classification", () => {
  it("tells date and time codes from number codes", () => {
    for (const code of ["m/d/yyyy", "[h]:mm", "h:mm AM/PM", "[$-409]mmmm d", "[Red]dd"]) expect(isDateFormat(code)).toBe(true);
    for (const code of [undefined, "General", "0.00", "[Red]0", '"days: "0', "\\d0", "#,##0_);[Red](#,##0)", '0 "hrs"']) {
      expect(isDateFormat(code)).toBe(false);
    }
  });

  it("names the kind of each code", () => {
    const kinds: Array<[string | undefined, string]> = [
      [undefined, "general"],
      ["#,##0.00", "number"],
      ["#,##0.00;[Red](#,##0.00)", "number"],
      ["$#,##0.00", "currency"],
      ["$#,##0_);($#,##0)", "currency"],
      ["[$€-x-euro2] #,##0.00", "currency"],
      [ACCOUNTING, "accounting"],
      ["0%", "percent"],
      ["m/d/yyyy", "date"],
      ["h:mm AM/PM", "time"],
      ["[h]:mm", "time"],
      ["m/d/yyyy h:mm", "datetime"],
      ["0.00E+00", "scientific"],
      ["# ?/?", "fraction"],
      ["@", "text"],
      ['#,##0,"K"', "custom"],
      ['0" items"', "custom"],
      ["[Red]General", "general"],
      ['"x"General', "custom"],
    ];
    for (const [code, kind] of kinds) expect([code, numberFormatKind(code)]).toEqual([code, kind]);
  });

  it("labels a code for the toolbar chip", () => {
    expect(numberFormatLabel(undefined)).toBe("General");
    expect(numberFormatLabel("m/d/yyyy")).toBe("Short date");
    expect(numberFormatLabel("#,##0")).toBe("Whole number");
    expect(numberFormatLabel("0.000")).toBe("Number");
    expect(numberFormatLabel("dd/mm/yyyy")).toBe("Date");
    expect(numberFormatLabel('0" items"')).toBe("Custom");
  });
});
