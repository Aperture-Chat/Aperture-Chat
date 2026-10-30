/** Decimal digits for number formats. Excel keeps 15 significant digits and
 * rounds half away from zero on them, so 1.005 shows as 1.01 although the
 * double is a hair below 1.005. All rounding here works on digit strings. */

import type { DigitChar } from "./tokens";

/** The 15 significant digits of a non-negative number, and the power of ten of the first. */
export function significantDigits(abs: number): { digits: string; exponent: number } {
  const [mantissa, exponent] = abs.toExponential(14).split("e");
  return { digits: mantissa.replace(".", ""), exponent: Number(exponent) };
}

export type DecimalParts = { int: string; frac: string };

/** Rounds `digits`, whose point sits after `intLength` of them, to `decimals`
 * places. `int` has no leading zeros ("" for zero); `frac` has `decimals` digits. */
export function roundDigits(digits: string, intLength: number, decimals: number): DecimalParts {
  const keep = intLength + decimals;
  if (keep < 0) return { int: "", frac: "0".repeat(decimals) };
  let kept = digits.slice(0, keep).padEnd(keep, "0");
  if (digits.charAt(keep) >= "5") kept = String(BigInt(kept) + 1n);
  kept = kept.padStart(decimals, "0");
  const split = kept.length - decimals;
  return { int: kept.slice(0, split).replace(/^0+/, ""), frac: kept.slice(split) };
}

export function roundNumber(abs: number, decimals: number): DecimalParts {
  const { digits, exponent } = significantDigits(abs);
  return roundDigits(digits, exponent + 1, decimals);
}

/** Digits of a whole number, 15 significant and the rest zeros, without the
 * exponent notation String() switches to at 1e21. */
export function integerDigits(whole: number): string {
  const { digits, exponent } = significantDigits(whole);
  return digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
}

/* ------------------------------------------------------------------ placing digits */

const PAD: Record<DigitChar, string> = { "0": "0", "#": "", "?": " " };

/** Right-aligns `digits` into the placeholders. The leftmost placeholder takes
 * any extra digits; empty placeholders pad by their kind. */
export function placeWhole(digits: string, slots: DigitChar[]): string[] {
  const overflow = digits.slice(0, Math.max(0, digits.length - slots.length));
  return slots
    .map((slot, index) => digits.charAt(digits.length - slots.length + index) || PAD[slot])
    .map((cell, index) => (index === 0 ? overflow + cell : cell));
}

/** Left-aligns decimal digits; trailing zeros under "#" and "?" give way. */
export function placeDecimals(frac: string, slots: DigitChar[]): string[] {
  const cells = slots.map((_slot, index) => frac[index]);
  for (let index = slots.length - 1; index >= 0 && frac[index] === "0" && slots[index] !== "0"; index -= 1) {
    cells[index] = PAD[slots[index]];
  }
  return cells;
}

/** Puts a separator every three characters from the right, across cells. A
 * "?" pad gets a space so columns stay aligned. */
export function groupThousands(cells: string[]): string[] {
  let count = 0;
  return cells
    .map((_cell, offset) => cells.length - 1 - offset)
    .map((index) => {
      let grouped = "";
      for (const ch of [...cells[index]].reverse()) {
        grouped = ch + separatorAfter(count, ch) + grouped;
        count += 1;
      }
      return grouped;
    })
    .reverse();
}

function separatorAfter(count: number, ch: string): string {
  if (count === 0 || count % 3 !== 0) return "";
  return ch === " " ? " " : ",";
}

export function blankCells(slots: DigitChar[]): string[] {
  return slots.map((slot) => (slot === "#" ? "" : " "));
}
