/** Number sections: fixed-point, scientific, and fraction layouts.
 *
 * Compiling assigns every placeholder a role (whole digits, decimals, exponent,
 * numerator, denominator) and turns the section into pieces. Rendering works
 * out the digits for each role once, then joins the pieces, so literals stay
 * exactly where the code put them. */

import {
  type DecimalParts,
  blankCells,
  groupThousands,
  integerDigits,
  placeDecimals,
  placeWhole,
  roundDigits,
  roundNumber,
  significantDigits,
} from "./digits";
import { type Fraction, bestFraction } from "./fraction";
import { type DigitChar, type Token, type TokenOf, plainText } from "./tokens";

export type Role = "int" | "dec" | "exp" | "num" | "den";
export type NumberMode = "fixed" | "scientific" | "fraction";

type Slots = Record<Role, DigitChar[]>;
type Cells = Record<Role, string[]> & { negativeExponent: boolean; blank: boolean };
type Piece = (cells: Cells) => string;
type FixedDenominator = { start: number; end: number; text: string };

export type NumberBody = {
  mode: NumberMode;
  pieces: Piece[];
  slots: Slots;
  grouping: boolean;
  /** Percent signs multiply by 100, scaling commas divide by 1,000. */
  multiplier: number;
  fixedDenominator: number | null;
};

/** Where the decimal point, exponent, and fraction bar sit. A position equal
 * to the token count means the section has none. */
export type Layout = {
  mode: NumberMode;
  pointAt: number;
  exponentAt: number;
  slashAt: number;
  fixed: FixedDenominator | null;
  roleAt: (index: number) => Role;
};

export function compileNumberBody(tokens: Token[]): NumberBody {
  const layout = analyzeLayout(tokens);
  const slots: Slots = { int: [], dec: [], exp: [], num: [], den: [] };
  const pieces: Piece[] = [];
  tokens.forEach((token, index) => {
    const piece = inFixed(layout.fixed, index) ? fixedPiece(layout.fixed, index) : pieceFor(tokens, layout, slots, index);
    if (piece) pieces.push(piece);
  });
  const commas = tokens.map((token, index) => (token.kind === "comma" ? commaUse(tokens, layout, index) : null));
  const percents = tokens.filter((token) => token.kind === "percent").length;
  return {
    mode: layout.mode,
    pieces,
    slots,
    grouping: commas.includes("group"),
    multiplier: 100 ** percents / 1000 ** commas.filter((use) => use === "scale").length,
    fixedDenominator: layout.fixed ? Number(layout.fixed.text) : null,
  };
}

export function renderNumberBody(body: NumberBody, value: number): string {
  const cells = CELLS[body.mode](body, Math.abs(value) * body.multiplier);
  const text = body.pieces.map((piece) => piece(cells)).join("");
  return value < 0 ? `-${text}` : text;
}

/* ------------------------------------------------------------------ layout */

export function analyzeLayout(tokens: Token[]): Layout {
  const fraction = fractionLayout(tokens);
  if (fraction) return fraction;
  const exponentAt = firstIndex(tokens, "exponent", tokens.length);
  const pointAt = firstIndex(tokens, "point", exponentAt);
  return {
    mode: exponentAt < tokens.length ? "scientific" : "fixed",
    pointAt,
    exponentAt,
    slashAt: tokens.length,
    fixed: null,
    roleAt: (index) => (index > exponentAt ? "exp" : index > pointAt ? "dec" : "int"),
  };
}

/** The first token of a kind before `end`, or `end` when there is none. */
function firstIndex(tokens: Token[], kind: Token["kind"], end: number): number {
  const index = tokens.slice(0, end).findIndex((token) => token.kind === kind);
  return index === -1 ? end : index;
}

/** A "/" with a placeholder before it (spaces allowed) and placeholders or a
 * whole number after it. Placeholders before the numerator are whole digits. */
function fractionLayout(tokens: Token[]): Layout | null {
  for (const [slashAt, token] of tokens.entries()) {
    if (token.kind !== "slash") continue;
    const numeratorEnd = skipBlanks(tokens, slashAt - 1, -1);
    const denominator = denominatorAfter(tokens, slashAt);
    if (tokens[numeratorEnd]?.kind === "digit" && denominator) return makeFractionLayout(tokens, slashAt, numeratorEnd, denominator.fixed);
  }
  return null;
}

function makeFractionLayout(tokens: Token[], slashAt: number, numeratorEnd: number, fixed: FixedDenominator | null): Layout {
  let numeratorStart = numeratorEnd;
  while (tokens[numeratorStart - 1]?.kind === "digit") numeratorStart -= 1;
  return {
    mode: "fraction",
    pointAt: tokens.length,
    exponentAt: tokens.length,
    slashAt,
    fixed,
    roleAt: (index) => (index < numeratorStart ? "int" : index < slashAt ? "num" : "den"),
  };
}

/** Placeholders, or a whole number such as "16" that fixes the denominator. */
function denominatorAfter(tokens: Token[], slashAt: number): { fixed: FixedDenominator | null } | null {
  const start = skipBlanks(tokens, slashAt + 1, 1);
  if (tokens[start]?.kind === "digit") return { fixed: null };
  let end = start;
  while (end < tokens.length && /^\d$/.test(plainText(tokens[end]))) end += 1;
  const text = tokens.slice(start, end).map(plainText).join("");
  return /^[1-9]/.test(text) ? { fixed: { start, end, text } } : null;
}

function skipBlanks(tokens: Token[], from: number, step: 1 | -1): number {
  let index = from;
  while (tokens[index]?.kind === "literal" && plainText(tokens[index]).trim() === "") index += step;
  return index;
}

/** A comma between whole-digit placeholders groups thousands; commas right
 * after the last placeholder scale; any other comma is shown as written. */
function commaUse(tokens: Token[], layout: Layout, index: number): "group" | "scale" | "literal" {
  const { before, after } = aroundCommas(tokens, index);
  if (before?.kind !== "digit") return "literal";
  if (after?.kind !== "digit") return "scale";
  return layout.roleAt(index) === "int" ? "group" : "literal";
}

/** The tokens on either side of the run of commas that includes `index`. */
function aroundCommas(tokens: Token[], index: number): { before: Token | undefined; after: Token | undefined } {
  let from = index;
  while (tokens[from - 1]?.kind === "comma") from -= 1;
  let to = index;
  while (tokens[to]?.kind === "comma") to += 1;
  return { before: tokens[from - 1], after: tokens[to] };
}

/* ------------------------------------------------------------------ pieces */

const constant = (text: string): Piece => () => text;

/** Points, exponents, and slashes other than the one the layout uses are
 * shown as written. */
function pieceFor(tokens: Token[], layout: Layout, slots: Slots, index: number): Piece | null {
  const token = tokens[index];
  switch (token.kind) {
    case "digit":
      return slotPiece(layout.roleAt(index), slots, token.ch);
    case "point":
      return index === layout.pointAt ? pointPiece(slots) : constant(".");
    case "comma":
      return commaPiece(tokens, layout, index);
    case "exponent":
      return index === layout.exponentAt ? exponentPiece(token) : constant(plainText(token));
    case "slash":
      return slashPiece(index === layout.slashAt);
    default:
      return constant(plainText(token));
  }
}

function slotPiece(role: Role, slots: Slots, ch: DigitChar): Piece {
  const slot = slots[role].push(ch) - 1;
  return (cells) => cells[role][slot];
}

/** ".00" has no whole-digit placeholder, so the point carries the whole digits. */
function pointPiece(slots: Slots): Piece {
  if (slots.int.length > 0) return constant(".");
  slots.int.push("#");
  return (cells) => `${cells.int[0]}.`;
}

function commaPiece(tokens: Token[], layout: Layout, index: number): Piece | null {
  return commaUse(tokens, layout, index) === "literal" ? constant(",") : null;
}

function exponentPiece(token: TokenOf<"exponent">): Piece {
  const positive = token.sign === "+" ? "E+" : "E";
  return (cells) => (cells.negativeExponent ? "E-" : positive);
}

/** The fraction bar turns into a space when a mixed fraction blanks out. */
function slashPiece(isFractionBar: boolean): Piece {
  return isFractionBar ? (cells) => (cells.blank ? " " : "/") : constant("/");
}

function inFixed(fixed: FixedDenominator | null, index: number): fixed is FixedDenominator {
  return fixed !== null && index >= fixed.start && index < fixed.end;
}

function fixedPiece(fixed: FixedDenominator, index: number): Piece | null {
  if (index !== fixed.start) return null;
  return (cells) => (cells.blank ? " ".repeat(fixed.text.length) : fixed.text);
}

/* ------------------------------------------------------------------ cells */

const NO_CELLS: Cells = { int: [], dec: [], exp: [], num: [], den: [], negativeExponent: false, blank: false };

const CELLS: Record<NumberMode, (body: NumberBody, abs: number) => Cells> = {
  fixed: fixedCells,
  scientific: scientificCells,
  fraction: fractionCells,
};

/** Whole digits, with thousands separators when the code groups them. */
function wholeCells(body: NumberBody, digits: string): string[] {
  const cells = placeWhole(digits, body.slots.int);
  return body.grouping ? groupThousands(cells) : cells;
}

function fixedCells(body: NumberBody, abs: number): Cells {
  const { int, frac } = roundNumber(abs, body.slots.dec.length);
  return { ...NO_CELLS, int: wholeCells(body, int), dec: placeDecimals(frac, body.slots.dec) };
}

function scientificCells(body: NumberBody, abs: number): Cells {
  const { mantissa, exponent } = scientificParts(abs, body.slots.int, body.slots.dec.length);
  return {
    ...NO_CELLS,
    int: wholeCells(body, mantissa.int),
    dec: placeDecimals(mantissa.frac, body.slots.dec),
    exp: placeWhole(String(Math.abs(exponent)), body.slots.exp),
    negativeExponent: exponent < 0,
  };
}

type Scientific = { mantissa: DecimalParts; exponent: number };

function scientificParts(abs: number, intSlots: DigitChar[], decimals: number): Scientific {
  if (abs === 0) return { mantissa: { int: "", frac: "0".repeat(decimals) }, exponent: 0 };
  const { digits, exponent } = significantDigits(abs);
  const parts = mantissaAt(digits, exponent, intSlots, decimals);
  // Rounding 9.99 up to 10.0 moves the number into the next power of ten.
  return parts.carried ? mantissaAt(`1${"0".repeat(14)}`, exponent + 1, intSlots, decimals) : parts;
}

function mantissaAt(digits: string, power: number, intSlots: DigitChar[], decimals: number): Scientific & { carried: boolean } {
  const exponent = exponentFor(power, intSlots);
  const intLength = power - exponent + 1;
  const mantissa = roundDigits(digits, intLength, decimals);
  return { mantissa, exponent, carried: mantissa.int.length > intLength };
}

/** "##0.0E+0" keeps the exponent a multiple of the placeholder count
 * (engineering notation); "00.0E+0" fills every whole-digit placeholder. */
function exponentFor(power: number, intSlots: DigitChar[]): number {
  const width = intSlots.length;
  if (intSlots.includes("#")) return Math.floor(power / width) * width;
  return power - width + 1;
}

function fractionCells(body: NumberBody, abs: number): Cells {
  const mixed = body.slots.int.length > 0;
  const { whole, num, den } = splitFraction(abs, body, mixed);
  // A mixed fraction with nothing after the whole number blanks out "n/d".
  const blank = mixed && num === 0;
  return {
    ...NO_CELLS,
    blank,
    int: wholeCells(body, whole > 0 ? integerDigits(whole) : blank ? "0" : ""),
    num: blank ? blankCells(body.slots.num) : placeWhole(integerDigits(num), body.slots.num),
    den: blank ? blankCells(body.slots.den) : placeDenominator(String(den), body.slots.den),
  };
}

function splitFraction(abs: number, body: NumberBody, mixed: boolean): Fraction & { whole: number } {
  const whole = mixed ? Math.floor(abs) : 0;
  const { num, den } = approximate(abs - whole, body);
  return mixed && num === den ? { whole: whole + 1, num: 0, den } : { whole, num, den };
}

function approximate(rest: number, body: NumberBody): Fraction {
  const fixed = body.fixedDenominator;
  if (fixed) return { num: Math.round(rest * fixed), den: fixed };
  return bestFraction(rest, 10 ** Math.min(body.slots.den.length, 7) - 1);
}

/** Denominators line up on the left, so "??" shows "3 ". */
function placeDenominator(digits: string, slots: DigitChar[]): string[] {
  const padded = digits.padStart(slots.filter((slot) => slot === "0").length, "0");
  return slots.map((slot, index) => padded.charAt(index) || (slot === "?" ? " " : ""));
}
