import { describe, expect, it } from "vitest";
import { calc } from "./testWorkbook";

const results = (formulas: string[], cells: Record<string, string | number | boolean> = {}) => formulas.map((formula) => calc(formula, cells));

const near = (formula: string, expected: number, digits = 9) => {
  const result = calc(formula);
  expect(typeof result, `${formula} -> ${JSON.stringify(result)}`).toBe("number");
  expect(result as number).toBeCloseTo(expected, digits);
};

// Excel serials: 2027-01-01 is 46388, 2027-02-28 is 46446, 2027-03-15 (a Monday) is 46461.
const JAN_1_2027 = 46388;
const FEB_28_2027 = 46446;
const MAR_15_2027 = 46461;

describe("building dates and times", () => {
  it("DATE overflows months and days and reads two-digit years as 1900 + year", () => {
    expect(results(["=DATE(2027,1,1)", "=DATE(2027,1,31)", "=DATE(2027,13,1)", "=DATE(2027,3,0)", "=DATE(127,1,1)", "=DATE(1900,1,1)"]))
      .toEqual([JAN_1_2027, JAN_1_2027 + 30, JAN_1_2027 + 365, FEB_28_2027, JAN_1_2027, 1]);
    expect(results(["=DATE(-1,1,1)", "=DATE(10000,1,1)", '=DATE("x",1,1)'])).toEqual(["#NUM!", "#NUM!", "#VALUE!"]);
  });

  it("TIME wraps past midnight and rejects negative totals", () => {
    expect(results(["=TIME(12,0,0)", "=TIME(0,-1,0)"])).toEqual([0.5, "#NUM!"]);
    near("=TIME(25,0,0)", 1 / 24);
    near("=TIME(0,90,0)", 1.5 / 24);
  });

  it("TODAY and NOW come from the recalculation clock", () => {
    const now = new Date(2027, 2, 15, 14, 30, 0);
    expect(calc("=TODAY()", {}, { now })).toBe(MAR_15_2027);
    expect(calc("=NOW()", {}, { now }) as number).toBeCloseTo(MAR_15_2027 + 14.5 / 24, 9);
  });

  it("DATEVALUE and TIMEVALUE read typed text", () => {
    expect(results(['=DATEVALUE("2027-03-15")', '=DATEVALUE("3/15/2027 14:30")', '=DATEVALUE("nope")', "=DATEVALUE(5)"])).toEqual([MAR_15_2027, MAR_15_2027, "#VALUE!", "#VALUE!"]);
    near('=TIMEVALUE("2:30 PM")', 14.5 / 24);
    near('=TIMEVALUE("2027-03-15 06:00")', 0.25);
  });
});

describe("reading dates and times", () => {
  it("YEAR, MONTH, DAY, HOUR, MINUTE, and SECOND", () => {
    expect(results([`=YEAR(${MAR_15_2027})`, `=MONTH(${MAR_15_2027})`, `=DAY(${MAR_15_2027})`, '=YEAR("2027-03-15")', "=YEAR(-1)", "=DAY(0)"])).toEqual([2027, 3, 15, 2027, "#NUM!", 0]);
    expect(results(["=HOUR(0.75)", "=MINUTE(TIME(1,2,3))", "=SECOND(TIME(1,2,3))", '=HOUR("14:30")', "=HOUR(0.99999)"])).toEqual([18, 2, 3, 14, 23]);
  });

  it("WEEKDAY numbers the days from the chosen start", () => {
    const monday = `DATE(2027,3,15)`;
    expect(results([`=WEEKDAY(${monday})`, `=WEEKDAY(${monday},2)`, `=WEEKDAY(${monday},3)`, `=WEEKDAY(${monday},11)`, `=WEEKDAY(${monday},12)`, `=WEEKDAY(${monday},17)`, `=WEEKDAY(${monday},4)`]))
      .toEqual([2, 1, 0, 1, 7, 2, "#NUM!"]);
  });

  it("WEEKNUM and ISOWEEKNUM", () => {
    expect(results(["=WEEKNUM(DATE(2027,1,1))", "=WEEKNUM(DATE(2027,1,3))", "=WEEKNUM(DATE(2027,1,3),2)", "=WEEKNUM(DATE(2027,3,15),2)", "=WEEKNUM(DATE(2027,3,15),21)", "=WEEKNUM(DATE(2027,3,15),5)"]))
      .toEqual([1, 2, 1, 12, 11, "#NUM!"]);
    expect(results(["=ISOWEEKNUM(DATE(2027,1,1))", "=ISOWEEKNUM(DATE(2027,3,15))", "=ISOWEEKNUM(DATE(2027,1,4))"])).toEqual([53, 11, 1]);
  });
});

describe("date arithmetic", () => {
  it("EDATE and EOMONTH clamp to the end of the month", () => {
    expect(results(["=EDATE(DATE(2027,1,31),1)", "=EDATE(DATE(2027,3,31),-1)", "=EOMONTH(DATE(2027,1,31),1)", "=EOMONTH(DATE(2027,1,15),0)", "=EOMONTH(DATE(2028,1,15),1)"]))
      .toEqual([FEB_28_2027, FEB_28_2027, FEB_28_2027, JAN_1_2027 + 30, JAN_1_2027 + 365 + 59]);
  });

  it("DATEDIF counts complete units", () => {
    const span = (unit: string) => calc(`=DATEDIF(DATE(2020,1,15),DATE(2027,3,1),"${unit}")`);
    expect(["YM", "Y", "M", "D", "MD", "YD", "ym"].map(span)).toEqual([1, 7, 85, 2602, 14, 45, 1]);
    expect(results(['=DATEDIF(DATE(2027,1,2),DATE(2027,1,1),"D")', '=DATEDIF(DATE(2027,1,1),DATE(2027,1,2),"X")'])).toEqual(["#NUM!", "#NUM!"]);
  });

  it("DAYS and DAYS360", () => {
    expect(results(["=DAYS(DATE(2027,3,1),DATE(2027,1,1))", '=DAYS("2027-03-01","2027-01-01")'])).toEqual([59, 59]);
    expect(results(["=DAYS360(DATE(2027,1,30),DATE(2027,2,1))", "=DAYS360(DATE(2027,1,31),DATE(2027,3,31))", "=DAYS360(DATE(2027,1,31),DATE(2027,3,31),TRUE)", "=DAYS360(DATE(2027,2,28),DATE(2027,3,31))", "=DAYS360(DATE(2027,2,28),DATE(2027,3,31),TRUE)"]))
      .toEqual([1, 60, 60, 30, 32]);
  });

  it("YEARFRAC supports every day-count basis", () => {
    const frac = (basis: number) => `=YEARFRAC(DATE(2027,1,1),DATE(2027,7,1),${basis})`;
    near(frac(0), 0.5);
    near(frac(1), 181 / 365);
    near(frac(2), 181 / 360);
    near(frac(3), 181 / 365);
    near(frac(4), 0.5);
    near("=YEARFRAC(DATE(2027,7,1),DATE(2027,1,1))", 0.5);
    near("=YEARFRAC(DATE(2024,1,1),DATE(2025,1,1),1)", 1);
    near("=YEARFRAC(DATE(2027,1,1),DATE(2029,7,1),1)", 912 / ((365 + 366 + 365) / 3));
    expect(calc("=YEARFRAC(DATE(2027,1,1),DATE(2027,7,1),5)")).toBe("#NUM!");
  });
});

describe("working days", () => {
  const holiday = { A1: "=DATE(2027,3,15)" };

  it("NETWORKDAYS counts weekdays, minus holidays, signed by direction", () => {
    expect(results(["=NETWORKDAYS(DATE(2027,3,1),DATE(2027,3,31))", "=NETWORKDAYS(DATE(2027,3,1),DATE(2027,3,31),A1)", "=NETWORKDAYS(DATE(2027,3,31),DATE(2027,3,1))"], holiday))
      .toEqual([23, 22, -23]);
  });

  it("NETWORKDAYS.INTL takes weekend codes and masks", () => {
    const span = (weekend: string) => calc(`=NETWORKDAYS.INTL(DATE(2027,3,1),DATE(2027,3,31),${weekend})`);
    expect(["11", '"0000011"', "7", '"1111111"', '"0000"', "99"].map(span)).toEqual([27, 23, 23, 0, "#VALUE!", "#NUM!"]);
  });

  it("WORKDAY and WORKDAY.INTL step over weekends and holidays", () => {
    expect(results(["=WORKDAY(DATE(2027,3,12),1)", "=WORKDAY(DATE(2027,3,15),-1)", "=WORKDAY(DATE(2027,3,12),1,A1)", "=WORKDAY.INTL(DATE(2027,3,12),1,11)", '=WORKDAY.INTL(DATE(2027,3,12),1,"1111111")'], holiday))
      .toEqual([MAR_15_2027, MAR_15_2027 - 3, MAR_15_2027 + 1, MAR_15_2027 - 2, "#VALUE!"]);
  });
});

describe("calendar boundaries", () => {
  it("DATE and TIME limits", () => {
    expect(results(["=DATE(0,1,1)", "=DATE(-1,25,1)", "=DATE(10000,-11,1)", "=DATE(9999,12,31)", "=TIME(0,0,0)", "=TIME(32768,0,0)"])).toEqual([1, "#NUM!", "#NUM!", 2958465, 0, "#NUM!"]);
    near("=TIME(32767,0,0)", 7 / 24);
  });

  it("WEEKNUM types and a year that starts on the week's first day", () => {
    expect(results(["=WEEKNUM(DATE(2027,3,15),3)", "=WEEKNUM(DATE(2027,3,15),11)", "=WEEKNUM(DATE(2027,3,15),17)", "=WEEKNUM(DATE(2027,3,15),18)", "=WEEKNUM(DATE(2023,1,1))", "=WEEKNUM(DATE(2023,1,8))"]))
      .toEqual(["#NUM!", 12, 12, "#NUM!", 1, 2]);
  });

  it("EDATE stays inside years 1900 to 9999", () => {
    expect(results(["=EDATE(DATE(1900,1,15),-1)", "=EDATE(DATE(1900,3,1),-1)", "=EDATE(DATE(9999,12,1),1)", "=EDATE(DATE(1900,1,1),-22200)"])).toEqual(["#NUM!", 32, "#NUM!", "#NUM!"]);
    expect(calc("=EDATE(DATE(9999,1,1),1)")).toBe(calc("=DATE(9999,2,1)"));
  });

  it("DAYS360 moves a 31st end date by the start date, and counts whole years", () => {
    expect(results(["=DAYS360(DATE(2027,1,15),DATE(2027,3,31))", "=DAYS360(DATE(2027,1,15),DATE(2027,3,31),TRUE)", "=DAYS360(DATE(2026,1,1),DATE(2027,1,1))"])).toEqual([76, 75, 360]);
  });

  it("YEARFRAC basis 0 month-end rules", () => {
    near("=YEARFRAC(DATE(2027,1,31),DATE(2027,3,31),0)", 60 / 360);
    near("=YEARFRAC(DATE(2027,1,31),DATE(2027,3,15),0)", 45 / 360);
    near("=YEARFRAC(DATE(2027,4,30),DATE(2027,5,31),0)", 30 / 360);
    near("=YEARFRAC(DATE(2027,2,28),DATE(2028,2,29),0)", 1);
    near("=YEARFRAC(DATE(2027,2,28),DATE(2027,3,15),0)", 15 / 360);
    near("=YEARFRAC(DATE(2027,1,15),DATE(2027,2,28),0)", 43 / 360);
    near("=YEARFRAC(DATE(2027,1,15),DATE(2027,3,31),0)", 76 / 360);
    near("=YEARFRAC(DATE(2027,1,30),DATE(2027,3,15),0)", 45 / 360);
    near("=YEARFRAC(DATE(2026,1,1),DATE(2028,1,1),0)", 2);
  });

  it("YEARFRAC basis 1 uses 366 days only when a February 29 is in range", () => {
    near("=YEARFRAC(DATE(2027,3,1),DATE(2028,3,1),1)", 1);
    near("=YEARFRAC(DATE(2027,3,2),DATE(2028,3,1),1)", 365 / 366);
    near("=YEARFRAC(DATE(2027,3,1),DATE(2028,3,2),1)", 367 / 365.5);
    near("=YEARFRAC(DATE(2028,2,1),DATE(2029,1,15),1)", 349 / 366);
    near("=YEARFRAC(DATE(2027,6,1),DATE(2028,4,1),1)", 305 / 366);
    near("=YEARFRAC(DATE(2027,6,1),DATE(2028,2,29),1)", 273 / 366);
    near("=YEARFRAC(DATE(2026,6,1),DATE(2027,5,1),1)", 334 / 365);
    near("=YEARFRAC(DATE(2028,3,1),DATE(2029,2,1),1)", 337 / 365);
    near("=YEARFRAC(DATE(2027,6,1),DATE(2028,3,1),1)", 274 / 366);
    near("=YEARFRAC(DATE(2028,2,29),DATE(2029,1,15),1)", 321 / 366);
  });

  it("weekend codes, empty weekend arguments, and single days", () => {
    const span = (weekend: string) => calc(`=NETWORKDAYS.INTL(DATE(2027,3,1),DATE(2027,3,31)${weekend})`, { A1: "=DATE(2027,3,15)" });
    expect([",0", ",17", "", ",,A1", ",1"].map(span)).toEqual(["#NUM!", 27, 23, 22, 23]);
    expect(results(["=NETWORKDAYS(DATE(2027,3,1),DATE(2027,3,1))", "=NETWORKDAYS(DATE(2027,3,6),DATE(2027,3,6))", "=WORKDAY(DATE(2027,3,15),0)"])).toEqual([1, 0, MAR_15_2027]);
  });

  it("WORKDAY stops at the ends of Excel's calendar", () => {
    expect(results(["=WORKDAY.INTL(2,-1,11)", "=WORKDAY(2958464,1)", "=WORKDAY(2958465,1)", "=WORKDAY(2,-1)"])).toEqual([0, 2958465, "#NUM!", "#NUM!"]);
  });
});

describe("errors and argument counts", () => {
  it("propagates errors and rejects bad argument counts", () => {
    expect(results(["=YEAR(1/0)", "=EDATE(NA(),1)", "=DATE(2027,1)", "=TODAY(1)", "=DATEDIF(1,2)"])).toEqual(["#DIV/0!", "#N/A", "#VALUE!", "#VALUE!", "#VALUE!"]);
  });
});
