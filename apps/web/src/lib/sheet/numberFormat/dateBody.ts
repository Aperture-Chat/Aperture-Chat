/** Date and time sections. Serials count days in Excel's 1900 system (day 0
 * is "January 0, 1900" and 1900-02-29 exists); the fraction is the time of day. */

import { serialToDate } from "../formula/values";
import { type Token, type TokenOf, isDateToken, plainText } from "./tokens";

/** Serial of 10000-01-01, the first day Excel cannot show. */
export const DATE_LIMIT = 2_958_466;
/** What Excel shows when a number cannot be displayed in its format. */
export const OVERFLOW = "#######";

type DateFields = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** Fraction-of-second digits, as many as the section shows. */
  sub: string;
  totalSeconds: number;
};
type Piece = (fields: DateFields) => string;

export type DateBody = { pieces: Piece[]; subDigits: number };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function compileDateBody(tokens: Token[]): DateBody {
  const minutes = minuteTokens(tokens);
  const twelveHour = tokens.some((token) => token.kind === "ampm");
  const pieces: Piece[] = [];
  let subDigits = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const zeros = fractionalSecondDigits(tokens, index);
    if (zeros > 0) {
      pieces.push(subsecondPiece(zeros));
      subDigits = Math.max(subDigits, zeros);
      index += zeros;
      continue;
    }
    pieces.push(datePiece(tokens[index], minutes[index], twelveHour));
  }
  return { pieces, subDigits: Math.min(subDigits, 3) };
}

export function renderDateBody(body: DateBody, value: number): string {
  if (value < 0 || value >= DATE_LIMIT) return OVERFLOW;
  const fields = dateFields(value, body.subDigits);
  return body.pieces.map((piece) => piece(fields)).join("");
}

/** Which tokens are minutes: "m" or "mm" right after an hour or right before
 * a second, skipping literals between them. Longer runs are always months. */
export function minuteTokens(tokens: Token[]): boolean[] {
  const clock = tokens.map((token, index) => ({ token, index })).filter(({ token }) => isDateToken(token));
  const minutes = tokens.map(() => false);
  clock.forEach(({ token, index }, position) => {
    if (token.kind !== "date" || token.ch !== "m" || token.width > 2) return;
    minutes[index] = isUnit(clock[position - 1]?.token, "h") || isUnit(clock[position + 1]?.token, "s");
  });
  return minutes;
}

function isUnit(token: Token | undefined, unit: "h" | "s"): boolean {
  return (token?.kind === "date" && token.ch === unit) || (token?.kind === "elapsed" && token.unit === unit);
}

/** ".0", ".00", or ".000" after a point: tenths, hundredths, or thousandths. */
function fractionalSecondDigits(tokens: Token[], index: number): number {
  if (tokens[index].kind !== "point") return 0;
  let count = 0;
  while (isZero(tokens[index + 1 + count])) count += 1;
  return count;
}

function isZero(token: Token | undefined): boolean {
  return token?.kind === "digit" && token.ch === "0";
}

function subsecondPiece(digits: number): Piece {
  return (fields) => `.${fields.sub.slice(0, digits).padEnd(digits, "0")}`;
}

function datePiece(token: Token, minute: boolean, twelveHour: boolean): Piece {
  if (token.kind === "date") return fieldPiece(minute ? "minute" : token.ch, token.width, twelveHour);
  if (token.kind === "elapsed") return elapsedPiece(token);
  if (token.kind === "ampm") return (fields) => (fields.hours < 12 ? token.am : token.pm);
  const text = plainText(token);
  return () => text;
}

/* ------------------------------------------------------------------ fields */

const pad2 = (value: number): string => String(value).padStart(2, "0");
const sized = (value: number, width: number): string => (width >= 2 ? pad2(value) : String(value));

type FieldKind = TokenOf<"date">["ch"] | "minute";

const FIELD_PIECES: Record<FieldKind, (width: number, twelveHour: boolean) => Piece> = {
  y: (width) => (width <= 2 ? (fields) => pad2(fields.year % 100) : (fields) => String(fields.year)),
  m: (width) => monthPiece(width),
  d: (width) => dayPiece(width),
  h: (width, twelveHour) => (fields) => sized(twelveHour ? fields.hours % 12 || 12 : fields.hours, width),
  minute: (width) => (fields) => sized(fields.minutes, width),
  s: (width) => (fields) => sized(fields.seconds, width),
};

function fieldPiece(kind: FieldKind, width: number, twelveHour: boolean): Piece {
  return FIELD_PIECES[kind](width, twelveHour);
}

const MONTH_PIECES: Piece[] = [
  (fields) => String(fields.month),
  (fields) => pad2(fields.month),
  (fields) => MONTHS[fields.month - 1].slice(0, 3),
  (fields) => MONTHS[fields.month - 1],
  (fields) => MONTHS[fields.month - 1][0],
];

function monthPiece(width: number): Piece {
  return MONTH_PIECES[width > 5 ? 3 : width - 1];
}

const DAY_PIECES: Piece[] = [
  (fields) => String(fields.day),
  (fields) => pad2(fields.day),
  (fields) => DAYS[fields.weekday].slice(0, 3),
  (fields) => DAYS[fields.weekday],
];

function dayPiece(width: number): Piece {
  return DAY_PIECES[Math.min(width, 4) - 1];
}

const SECONDS_PER: Record<TokenOf<"elapsed">["unit"], number> = { h: 3600, m: 60, s: 1 };

function elapsedPiece(token: TokenOf<"elapsed">): Piece {
  const per = SECONDS_PER[token.unit];
  return (fields) => String(Math.floor(fields.totalSeconds / per)).padStart(token.width, "0");
}

/** Rounds to the shown fraction of a second (whole seconds when none is
 * shown), carrying into minutes, hours, and the next day. */
function dateFields(serial: number, subDigits: number): DateFields {
  const scale = 10 ** subDigits;
  const units = Math.round(serial * 86_400 * scale);
  const days = Math.floor(units / (86_400 * scale));
  const ofDay = units - days * 86_400 * scale;
  const second = Math.floor(ofDay / scale);
  return {
    ...calendarDay(days),
    weekday: (days + 6) % 7,
    hours: Math.floor(second / 3600),
    minutes: Math.floor((second % 3600) / 60),
    seconds: second % 60,
    sub: String(ofDay % scale).padStart(subDigits, "0"),
    totalSeconds: Math.floor(units / scale),
  };
}

/** Excel's weekday count treats 1900-01-01 as a Sunday, so weekdays come from
 * the serial itself; serial 0 is "January 0, 1900". */
function calendarDay(days: number): { year: number; month: number; day: number } {
  if (days === 0) return { year: 1900, month: 1, day: 0 };
  const { year, month, day } = serialToDate(days);
  return { year, month, day };
}
