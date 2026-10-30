/** Matching rules shared by VLOOKUP, HLOOKUP, LOOKUP, MATCH, XLOOKUP, and
 * XMATCH. Exact matches need the same type (the number 1 never matches the
 * text "1"), compare text case-insensitively, and may use wildcards.
 * Approximate matches assume sorted data, as Excel's binary search does. */

import { ERR, type Scalar, type SheetError, compareScalars } from "../values";
import { wildcardToRegExp } from "./criteria";

/** Whether a cell can match the lookup at all: the same primitive type. A
 * blank lookup matches nothing (callers handle error lookups first). */
function sameKind(lookup: Scalar, value: Scalar): boolean {
  return typeof lookup !== "object" && typeof lookup === typeof value;
}

export function exactMatcher(lookup: Scalar, wildcards: boolean): (value: Scalar) => boolean {
  if (wildcards && typeof lookup === "string" && /[*?~]/.test(lookup)) {
    const pattern = wildcardToRegExp(lookup);
    return (value) => typeof value === "string" && pattern.test(value);
  }
  return (value) => sameKind(lookup, value) && compareScalars(lookup, value) === 0;
}

/** Position of the last value not above (ascending) or not below
 * (descending) the lookup, stopping where the sorted run passes it; -1 if
 * there is none. Values of another type are skipped. */
export function approximateIndex(values: Scalar[], lookup: Scalar, descending: boolean): number {
  let found = -1;
  for (const [index, value] of values.entries()) {
    if (!sameKind(lookup, value)) continue;
    const order = compareScalars(value, lookup);
    if (descending ? order < 0 : order > 0) break;
    found = index;
  }
  return found;
}

/** MATCH's position (0-based, -1 when absent) for match types 1, 0, and -1. */
export function matchIndex(values: Scalar[], lookup: Scalar, type: -1 | 0 | 1): number {
  if (type === 0) return values.findIndex(exactMatcher(lookup, true));
  return approximateIndex(values, lookup, type === -1);
}

/** Among values strictly below (-1) or above (1) the lookup, the closest;
 * ties go to the first one in search order. */
function nearestIndex(values: Scalar[], lookup: Scalar, matchMode: number, order: number[]): number {
  const beyond = (a: Scalar, b: Scalar) => (matchMode === 1 ? compareScalars(a, b) > 0 : compareScalars(a, b) < 0);
  let best = -1;
  for (const index of order) {
    const value = values[index];
    if (sameKind(lookup, value) && beyond(value, lookup) && (best < 0 || beyond(values[best], value))) best = index;
  }
  return best;
}

/** XMATCH/XLOOKUP search modes: whether each one searches from the end. */
const SEARCHES_BACKWARD: Record<number, boolean> = { 1: false, 2: false, [-1]: true, [-2]: true };

/** XLOOKUP and XMATCH: match_mode 0 exact, -1 or next smaller, 1 or next
 * larger, 2 wildcard; search_mode 1 first-to-last, -1 last-to-first, and
 * 2/-2 (binary search, which finds the same items in sorted data). */
export function xIndex(values: Scalar[], lookup: Scalar, matchMode: number, searchMode: number): number | SheetError {
  const backward = SEARCHES_BACKWARD[searchMode];
  if (![0, -1, 1, 2].includes(matchMode) || backward === undefined) return ERR.value;
  const forward = Array.from({ length: values.length }, (_, index) => index);
  const order = backward ? forward.reverse() : forward;
  const exact = exactMatcher(lookup, matchMode === 2);
  const hit = order.find((index) => exact(values[index]));
  if (hit !== undefined) return hit;
  return matchMode === -1 || matchMode === 1 ? nearestIndex(values, lookup, matchMode, order) : -1;
}
