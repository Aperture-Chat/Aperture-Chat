/** Date and time functions on Excel serials (days since 1899-12-30, with
 * Excel's fictional 1900-02-29), so results take part in arithmetic and
 * number formats exactly as they do in Excel. */

import type { CallContext, FunctionSpec } from "../types";
import { ERR, type Scalar, type SheetError, type Value, dateToSerial, isError, parseDateText, serialToDate, toNumber } from "../values";
import { argAt, collectNumbers, define, liftScalar } from "./helpers";
import { type Arg, bool, int, num, opt, scalar, text } from "./scalar";

const dt = define("Date & time");

const MAX_SERIAL = 2_958_465; // 9999-12-31
type Parts = { year: number; month: number; day: number };

/** A date serial argument: numbers or date text, within Excel's calendar. */
const serial: Arg<number> = (value) => {
  const number = toNumber(value ?? null);
  if (isError(number)) return number;
  return number < 0 || number >= MAX_SERIAL + 1 ? ERR.num : number;
};

const day: Arg<number> = (value) => {
  const number = serial(value);
  return isError(number) ? number : Math.floor(number);
};

function partsOf(value: number): Parts {
  return value < 1 ? { year: 1900, month: 1, day: 0 } : serialToDate(value);
}

function inCalendar(value: number): number | SheetError {
  return value < 0 || value > MAX_SERIAL ? ERR.num : value;
}

function daysInMonth(year: number, month: number): number {
  if (year === 1900 && month === 2) return 29;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function date(year: number, month: number, dayOfMonth: number): number | SheetError {
  if (year < 0 || year >= 10_000) return ERR.num;
  const full = year < 1900 ? year + 1900 : year;
  return inCalendar(dateToSerial(full, month, dayOfMonth));
}

function time(hours: number, minutes: number, seconds: number): number | SheetError {
  const total = hours * 3600 + minutes * 60 + seconds;
  if (total < 0 || hours > 32_767) return ERR.num;
  return (total % 86_400) / 86_400;
}

function clock(value: number): { hours: number; minutes: number; seconds: number } {
  const seconds = Math.round((value - Math.floor(value)) * 86_400) % 86_400;
  return { hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60), seconds: seconds % 60 };
}

/* ------------------------------------------------------------------ weeks */

/** Weekday index with 0 = Sunday, from the serial (Excel's 1900 calendar). */
function weekdayIndex(value: number): number {
  return (Math.floor(value) + 6) % 7;
}

/** WEEKDAY return types: the first day of the week and whether it counts from 0. */
function weekStart(type: number): { start: number; offset: number } | null {
  if (type === 1) return { start: 0, offset: 1 };
  if (type === 2) return { start: 1, offset: 1 };
  if (type === 3) return { start: 1, offset: 0 };
  if (type >= 11 && type <= 17) return { start: (type - 10) % 7, offset: 1 };
  return null;
}

function weekday(value: number, type: number): number | SheetError {
  const rule = weekStart(type);
  if (!rule) return ERR.num;
  return ((weekdayIndex(value) - rule.start + 7) % 7) + rule.offset;
}

function isoWeek(value: number): number {
  const whole = Math.floor(value);
  const thursday = whole - ((weekdayIndex(whole) + 6) % 7) + 3;
  const jan1 = dateToSerial(partsOf(thursday).year, 1, 1);
  return Math.floor((thursday - jan1) / 7) + 1;
}

function weekNum(value: number, type: number): number | SheetError {
  if (type === 21) return isoWeek(value);
  const rule = type === 3 ? null : weekStart(type);
  if (!rule) return ERR.num;
  const jan1 = dateToSerial(partsOf(value).year, 1, 1);
  const lead = (weekdayIndex(jan1) - rule.start + 7) % 7;
  return Math.floor((Math.floor(value) - jan1 + lead) / 7) + 1;
}

/* ------------------------------------------------------------------ months */

function addMonths(value: number, months: number, toEnd: boolean): number | SheetError {
  const start = partsOf(value);
  const index = start.year * 12 + (start.month - 1) + Math.trunc(months);
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  if (year < 1900 || year > 9999) return ERR.num;
  const last = daysInMonth(year, month);
  return inCalendar(dateToSerial(year, month, toEnd ? last : Math.min(start.day, last)));
}

function wholeYears(s: Parts, e: Parts): number {
  return e.year - s.year - (e.month < s.month || (e.month === s.month && e.day < s.day) ? 1 : 0);
}

function wholeMonths(s: Parts, e: Parts): number {
  return (e.year - s.year) * 12 + e.month - s.month - (e.day < s.day ? 1 : 0);
}

function dayOfYearGap(start: number, end: number, s: Parts, e: Parts): number {
  const anchor = dateToSerial(e.year, s.month, s.day);
  return end - (anchor > end ? dateToSerial(e.year - 1, s.month, s.day) : anchor);
}

const DATEDIF_UNITS: Record<string, (start: number, end: number, s: Parts, e: Parts) => number> = {
  Y: (_start, _end, s, e) => wholeYears(s, e),
  M: (_start, _end, s, e) => wholeMonths(s, e),
  D: (start, end) => end - start,
  MD: (_start, end, s, e) => (e.day >= s.day ? e.day - s.day : end - dateToSerial(e.year, e.month - 1, s.day)),
  YM: (_start, _end, s, e) => wholeMonths(s, e) % 12,
  YD: dayOfYearGap,
};

function datedif(start: number, end: number, unit: string): number | SheetError {
  const measure = DATEDIF_UNITS[unit.toUpperCase()];
  if (!measure || start > end) return ERR.num;
  return measure(start, end, partsOf(start), partsOf(end));
}

/* ------------------------------------------------------------------ 30/360 */

function isLastOfFebruary(p: Parts): boolean {
  return p.month === 2 && p.day === daysInMonth(p.year, 2);
}

function days360(start: number, end: number, european: boolean): number {
  const s = partsOf(start);
  const e = partsOf(end);
  const startDay = s.day === 31 || (!european && isLastOfFebruary(s)) ? 30 : s.day;
  let endDay = e.day;
  let endMonth = e.month;
  if (endDay === 31 && !european && startDay < 30) [endDay, endMonth] = [1, endMonth + 1];
  else if (endDay === 31) endDay = 30;
  return (e.year - s.year) * 360 + (endMonth - s.month) * 30 + endDay - startDay;
}

/* ------------------------------------------------------------------ YEARFRAC */

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** YEARFRAC basis 0, which differs from DAYS360 at month ends. */
function us30360(s: Parts, e: Parts): number {
  let [d1, d2] = [s.day, e.day];
  if (d1 === 31 && d2 === 31) [d1, d2] = [30, 30];
  else if (d1 === 31) d1 = 30;
  else if (d1 === 30 && d2 === 31) d2 = 30;
  else if (isLastOfFebruary(s) && isLastOfFebruary(e)) [d1, d2] = [30, 30];
  else if (isLastOfFebruary(s)) d1 = 30;
  return ((e.year - s.year) * 360 + (e.month - s.month) * 30 + (d2 - d1)) / 360;
}

function within(s: Parts, e: Parts): boolean {
  return s.year === e.year || (e.year === s.year + 1 && (s.month > e.month || (s.month === e.month && s.day >= e.day)));
}

/** Whether a February 29 lies between the dates, inclusive. */
function spansLeapDay(start: number, end: number, s: Parts, e: Parts): boolean {
  const contains = (year: number) => isLeap(year) && start <= dateToSerial(year, 2, 29) && end >= dateToSerial(year, 2, 29);
  return contains(s.year) || contains(e.year);
}

/** Actual/actual as Excel computes it (the analysis by David A. Wheeler). */
function actualActual(start: number, end: number, s: Parts, e: Parts): number {
  if (within(s, e)) {
    const leap = (s.year === e.year && isLeap(s.year)) || spansLeapDay(start, end, s, e);
    return (end - start) / (leap ? 366 : 365);
  }
  const years = e.year - s.year + 1;
  const days = dateToSerial(e.year + 1, 1, 1) - dateToSerial(s.year, 1, 1);
  return (end - start) / (days / years);
}

const YEARFRAC_BASES: ((start: number, end: number, s: Parts, e: Parts) => number)[] = [
  (_start, _end, s, e) => us30360(s, e),
  actualActual,
  (start, end) => (end - start) / 360,
  (start, end) => (end - start) / 365,
  (_start, _end, s, e) => ((e.year - s.year) * 360 + (e.month - s.month) * 30 + Math.min(e.day, 30) - Math.min(s.day, 30)) / 360,
];

function yearFrac(first: number, second: number, basis: number): number | SheetError {
  const measure = YEARFRAC_BASES[basis];
  if (!measure) return ERR.num;
  const [start, end] = first <= second ? [first, second] : [second, first];
  return measure(start, end, partsOf(start), partsOf(end));
}

/* ------------------------------------------------------------------ workdays */

/** Weekend days as a 7-flag mask indexed from Sunday. */
type Weekend = boolean[];

function weekendFromCode(code: number): Weekend | SheetError {
  const mask = new Array<boolean>(7).fill(false);
  if (code >= 1 && code <= 7) {
    mask[(code + 5) % 7] = true;
    mask[(code + 6) % 7] = true;
  } else if (code >= 11 && code <= 17) mask[code - 11] = true;
  else return ERR.num;
  return mask;
}

/** A NETWORKDAYS.INTL weekend argument: a code, or "0000011" from Monday. */
function weekendOf(value: Scalar | undefined): Weekend | SheetError {
  if (value === undefined || value === null) return weekendFromCode(1);
  if (typeof value === "string") {
    if (!/^[01]{7}$/.test(value)) return ERR.value;
    return Array.from({ length: 7 }, (_, index) => value[(index + 6) % 7] === "1");
  }
  const code = toNumber(value);
  return isError(code) ? code : weekendFromCode(Math.trunc(code));
}

function holidaysOf(args: Value[], ctx: CallContext, index: number): Set<number> | SheetError {
  if (index >= args.length) return new Set();
  const numbers = collectNumbers([args[index]], { ...ctx, refs: [ctx.refs[index]] });
  return isError(numbers) ? numbers : new Set(numbers.map(Math.floor));
}

type Calendar = { weekend: Weekend; holidays: Set<number> };

function isWorkday(value: number, calendar: Calendar): boolean {
  return !calendar.weekend[weekdayIndex(value)] && !calendar.holidays.has(value);
}

function networkDays(start: number, end: number, calendar: Calendar): number {
  let count = 0;
  for (let value = Math.min(start, end); value <= Math.max(start, end); value += 1) if (isWorkday(value, calendar)) count += 1;
  return start <= end ? count : -count;
}

function workday(start: number, days: number, calendar: Calendar): number | SheetError {
  if (calendar.weekend.every(Boolean)) return ERR.value;
  const step = Math.sign(days);
  let value = start;
  for (let remaining = Math.abs(days); remaining > 0;) {
    value += step;
    if (value < 0 || value > MAX_SERIAL) return ERR.num;
    if (isWorkday(value, calendar)) remaining -= 1;
  }
  return value;
}

/** Shared argument reading for the four workday functions. */
function workdays(intl: boolean, run: (start: number, second: number, calendar: Calendar) => number | SheetError) {
  return (args: Value[], ctx: CallContext): Value => {
    const weekend = intl ? weekendOf(argAt(args, 2)) : weekendFromCode(1);
    if (isError(weekend)) return weekend;
    const holidays = holidaysOf(args, ctx, intl ? 3 : 2);
    if (isError(holidays)) return holidays;
    return scalar([day, num], (start, second) => run(start, second, { weekend, holidays }))(args.slice(0, 2));
  };
}

/* ------------------------------------------------------------------ text */

/** DATEVALUE and TIMEVALUE: date-and-time text, of which `pick` keeps a part. */
function fromDateText(pick: (parsed: number) => number) {
  return liftScalar(([value]) => {
    if (isError(value)) return value;
    const parsed = typeof value === "string" ? parseDateText(value) : null;
    return parsed === null ? ERR.value : pick(parsed);
  });
}

const part = (pick: (p: Parts) => number) => ({ fn: scalar([serial], (value) => pick(partsOf(value))) });
const clockPart = (pick: (c: ReturnType<typeof clock>) => number) => ({ fn: scalar([serial], (value) => pick(clock(value))) });

export const DATETIME_FUNCTIONS: Record<string, FunctionSpec> = {
  TODAY: dt("", "Returns today's date.", { volatile: true, fn: (_args, ctx) => Math.floor(ctx.host.now) }),
  NOW: dt("", "Returns the current date and time.", { volatile: true, fn: (_args, ctx) => ctx.host.now }),
  DATE: dt("year, month, day", "Returns the date for a year, month, and day; months and days may overflow.", { fn: scalar([int, int, int], date) }),
  TIME: dt("hour, minute, second", "Returns the time of day for hours, minutes, and seconds.", { fn: scalar([int, int, int], time) }),
  YEAR: dt("serial_number", "Returns the year of a date.", part((p) => p.year)),
  MONTH: dt("serial_number", "Returns the month of a date, from 1 to 12.", part((p) => p.month)),
  DAY: dt("serial_number", "Returns the day of the month of a date.", part((p) => p.day)),
  HOUR: dt("serial_number", "Returns the hour of a time, from 0 to 23.", clockPart((c) => c.hours)),
  MINUTE: dt("serial_number", "Returns the minute of a time, from 0 to 59.", clockPart((c) => c.minutes)),
  SECOND: dt("serial_number", "Returns the second of a time, from 0 to 59.", clockPart((c) => c.seconds)),
  WEEKDAY: dt("serial_number, [return_type]", "Returns the day of the week as a number.", { fn: scalar([serial, opt(int, 1)], weekday) }),
  WEEKNUM: dt("serial_number, [return_type]", "Returns the week number of a date in its year.", { fn: scalar([serial, opt(int, 1)], weekNum) }),
  ISOWEEKNUM: dt("date", "Returns the ISO 8601 week number of a date.", { fn: scalar([serial], isoWeek) }),
  EDATE: dt("start_date, months", "Returns the date a number of months before or after a date.", { fn: scalar([day, num], (start, months) => addMonths(start, months, false)) }),
  EOMONTH: dt("start_date, months", "Returns the last day of the month a number of months away.", { fn: scalar([day, num], (start, months) => addMonths(start, months, true)) }),
  DATEDIF: dt("start_date, end_date, unit", "Returns the years (Y), months (M), or days (D, MD, YM, YD) between two dates.", { fn: scalar([day, day, text], datedif) }),
  DAYS: dt("end_date, start_date", "Returns the number of days between two dates.", { fn: scalar([day, day], (end, start) => end - start) }),
  DAYS360: dt("start_date, end_date, [method]", "Returns the days between two dates on a 360-day year.", { fn: scalar([day, day, opt(bool, false)], days360) }),
  NETWORKDAYS: dt("start_date, end_date, [holidays]", "Counts the working days between two dates.", { fn: workdays(false, (start, end, calendar) => networkDays(start, Math.floor(end), calendar)) }),
  "NETWORKDAYS.INTL": dt("start_date, end_date, [weekend], [holidays]", "Counts the working days between two dates with a custom weekend.", { fn: workdays(true, (start, end, calendar) => networkDays(start, Math.floor(end), calendar)) }),
  WORKDAY: dt("start_date, days, [holidays]", "Returns the date a number of working days away.", { fn: workdays(false, (start, days, calendar) => workday(start, Math.trunc(days), calendar)) }),
  "WORKDAY.INTL": dt("start_date, days, [weekend], [holidays]", "Returns the date a number of working days away, with a custom weekend.", { fn: workdays(true, (start, days, calendar) => workday(start, Math.trunc(days), calendar)) }),
  YEARFRAC: dt("start_date, end_date, [basis]", "Returns the fraction of a year between two dates.", { fn: scalar([day, day, opt(int, 0)], yearFrac) }),
  DATEVALUE: dt("date_text", "Converts date text to a date serial.", { fn: fromDateText(Math.floor) }),
  TIMEVALUE: dt("time_text", "Converts time text to a fraction of a day.", { fn: fromDateText((parsed) => parsed - Math.floor(parsed)) }),
};
