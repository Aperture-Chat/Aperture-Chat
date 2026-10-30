import { formatCellValue } from "../../numberFormat";
import type { FunctionSpec } from "../types";
import { ERR, type Matrix, type Scalar, type SheetError, type Value, asMatrix, flatten, isError, sheetError, toBoolean, toNumber, toText } from "../values";
import { wildcardSource } from "./criteria";
import { argAt, define, liftScalar } from "./helpers";
import { roundTo } from "./math";
import { bool, int, num, opt, optBlank, scalar, text } from "./scalar";

const txt = define("Text");

const MAX_TEXT = 32_767;

function fits(result: string): string | SheetError {
  return result.length > MAX_TEXT ? sheetError("#VALUE!", "The text is longer than 32,767 characters.") : result;
}

/** Every item of every argument as text, flattening ranges and arrays. */
function texts(values: Value[]): string[] | SheetError {
  const out: string[] = [];
  for (const item of flatten(values)) {
    const piece = toText(item);
    if (isError(piece)) return piece;
    out.push(piece);
  }
  return out;
}

function concat(args: Value[]): Scalar {
  const pieces = texts(args);
  return isError(pieces) ? pieces : fits(pieces.join(""));
}

function textJoin(args: Value[]): Value {
  const delimiters = texts([args[0]]);
  if (isError(delimiters)) return delimiters;
  const skipEmpty = toBoolean(asMatrix(args[1])[0][0]);
  if (isError(skipEmpty)) return skipEmpty;
  const pieces = texts(args.slice(2));
  if (isError(pieces)) return pieces;
  const kept = skipEmpty ? pieces.filter(Boolean) : pieces;
  const joined = kept.reduce((acc, piece, index) => (index ? acc + delimiters[(index - 1) % delimiters.length] + piece : piece), "");
  return fits(joined);
}

/* ------------------------------------------------------------------ slicing */

function left(value: string, count: number): string | SheetError {
  return count < 0 ? ERR.value : value.slice(0, count);
}

function right(value: string, count: number): string | SheetError {
  if (count < 0) return ERR.value;
  return count === 0 ? "" : value.slice(-count);
}

function mid(value: string, start: number, count: number): string | SheetError {
  if (start < 1 || count < 0) return ERR.value;
  return value.slice(start - 1, start - 1 + count);
}

/** Capitalizes each letter that follows a non-letter (digits included). */
function proper(value: string): string {
  let out = "";
  let afterLetter = false;
  for (const ch of value) {
    out += afterLetter ? ch.toLowerCase() : ch.toUpperCase();
    afterLetter = /\p{L}/u.test(ch);
  }
  return out;
}

function trim(value: string): string {
  return value.replace(/^ +| +$/g, "").replace(/ {2,}/g, " ");
}

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f]/g, "");
}

/* ------------------------------------------------------------------ replace */

function substitute(value: string, old: string, replacement: string, instance: number | null): string | SheetError {
  if (instance !== null && instance < 1) return ERR.value;
  if (!old) return value;
  if (instance === null) return fits(value.split(old).join(replacement));
  let at = -1;
  for (let seen = 0; seen < instance; seen += 1) {
    at = value.indexOf(old, at < 0 ? 0 : at + old.length);
    if (at < 0) return value;
  }
  return fits(value.slice(0, at) + replacement + value.slice(at + old.length));
}

function replace(value: string, start: number, count: number, replacement: string): string | SheetError {
  if (start < 1 || count < 0) return ERR.value;
  return fits(value.slice(0, start - 1) + replacement + value.slice(start - 1 + count));
}

function find(needle: string, haystack: string, start: number): number | SheetError {
  if (start < 1 || start > haystack.length) return ERR.value;
  const at = haystack.indexOf(needle, start - 1);
  return at < 0 ? ERR.value : at + 1;
}

function search(needle: string, haystack: string, start: number): number | SheetError {
  if (start < 1 || start > haystack.length) return ERR.value;
  const match = new RegExp(wildcardSource(needle), "i").exec(haystack.slice(start - 1));
  return match ? match.index + start : ERR.value;
}

/* ------------------------------------------------------------------ numbers */

/** TEXT: numeric text is formatted as the number it reads as. */
function textFormat([item, format]: Scalar[]): Scalar {
  if (isError(item)) return item;
  const code = toText(format);
  if (isError(code)) return code;
  const number = typeof item === "string" ? toNumber(item) : item;
  return formatCellValue(isError(number) ? item : number, code).text;
}

function value(item: Scalar): Scalar {
  return typeof item === "boolean" ? ERR.value : toNumber(item);
}

function numberValue(input: string, decimal: string, group: string): number | SheetError {
  const [dec, grp] = [decimal[0] ?? ".", group[0] ?? ","];
  if (dec === grp) return ERR.value;
  let body = input.replace(/\s+/g, "");
  const percents = /%*$/.exec(body)![0].length;
  body = body.slice(0, body.length - percents).split(grp).join("").replace(dec, ".");
  if (!body) return 0;
  const number = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(body) ? Number(body) : NaN;
  return Number.isNaN(number) ? ERR.value : number / 100 ** percents;
}

function grouped(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** FIXED's text: rounded half away from zero, optionally with separators. */
function fixed(x: number, decimals: number, noCommas: boolean): string | SheetError {
  const places = Math.trunc(decimals);
  if (places > 127) return ERR.value;
  const rounded = roundTo(x, places, Math.round);
  // toFixed stops at 100 decimals; Excel allows 127, so pad the rest with zeros.
  const [whole, fraction] = Math.abs(rounded).toFixed(Math.min(Math.max(places, 0), 100)).split(".");
  const digits = fraction ? fraction + "0".repeat(Math.max(places - 100, 0)) : "";
  const body = (noCommas ? whole : grouped(whole)) + (digits ? `.${digits}` : "");
  return rounded < 0 ? `-${body}` : body;
}

function dollar(x: number, decimals: number): string | SheetError {
  const body = fixed(Math.abs(x), decimals, false);
  if (isError(body)) return body;
  return roundTo(x, decimals, Math.round) < 0 ? `($${body})` : `$${body}`;
}

function rept(value: string, times: number): string | SheetError {
  if (times < 0) return ERR.value;
  return fits(value.repeat(times));
}

/* ------------------------------------------------------------------ characters */

/** Windows-1252 characters 128-159, which CHAR and CODE use (Excel on Windows). */
const CP1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ";

function char(code: number): string | SheetError {
  if (code < 1 || code > 255) return ERR.value;
  return code >= 128 && code < 160 ? CP1252[code - 128] : String.fromCharCode(code);
}

function code(value: string): number | SheetError {
  if (!value) return ERR.value;
  const ch = value[0];
  const windows = CP1252.indexOf(ch);
  if (windows >= 0) return 128 + windows;
  const point = ch.charCodeAt(0);
  return point < 256 ? point : 63;
}

function unichar(point: number): string | SheetError {
  if (point < 1 || point > 0x10ffff) return ERR.value;
  return point >= 0xd800 && point <= 0xdfff ? ERR.na : String.fromCodePoint(point);
}

function unicode(value: string): number | SheetError {
  return value ? value.codePointAt(0)! : ERR.value;
}

/* ------------------------------------------------------------------ delimiters */

type Span = { start: number; end: number };

/** Non-overlapping delimiter matches from the left; where several delimiters
 * match at one place, the longest wins. */
function delimiterSpans(value: string, delimiters: string[], ignoreCase: boolean): Span[] {
  const haystack = ignoreCase ? value.toLowerCase() : value;
  const needles = delimiters.filter(Boolean).map((item) => (ignoreCase ? item.toLowerCase() : item)).sort((a, b) => b.length - a.length);
  const spans: Span[] = [];
  for (let index = 0; index < haystack.length && needles.length;) {
    const needle = needles.find((item) => haystack.startsWith(item, index));
    if (needle) {
      spans.push({ start: index, end: index + needle.length });
      index += needle.length;
    } else index += 1;
  }
  return spans;
}

function delimiterList(arg: Value): string[] | SheetError {
  return texts([arg]);
}

type Options = { instance: number; ignoreCase: boolean; matchEnd: boolean };

function chosenSpan(value: string, delimiters: string[], options: Options): Span | null {
  const { instance, ignoreCase, matchEnd } = options;
  if (delimiters.every((item) => !item)) return instance > 0 ? { start: 0, end: 0 } : { start: value.length, end: value.length };
  const spans = delimiterSpans(value, delimiters, ignoreCase);
  if (matchEnd && instance > 0) spans.push({ start: value.length, end: value.length });
  if (matchEnd && instance < 0) spans.unshift({ start: 0, end: 0 });
  return spans[instance > 0 ? instance - 1 : spans.length + instance] ?? null;
}

/** TEXTBEFORE and TEXTAFTER share their arguments and their search. */
function textAround(before: boolean) {
  return (args: Value[]): Value => {
    const delimiters = delimiterList(args[1]);
    if (isError(delimiters)) return delimiters;
    const rest = [args[0], ...args.slice(2, 5)];
    return scalar([text, optBlank(int, 1), opt(num, 0), opt(num, 0)], (value, instance, mode, end) => {
      if (instance === 0 || Math.abs(instance) > Math.max(value.length, 1)) return ERR.value;
      const span = chosenSpan(value, delimiters, { instance, ignoreCase: mode !== 0, matchEnd: end !== 0 });
      if (!span) return argAt(args, 5) ?? ERR.na;
      return before ? value.slice(0, span.start) : value.slice(span.end);
    })(rest);
  };
}

function split(value: string, delimiters: string[], ignoreCase: boolean, skipEmpty: boolean): string[] {
  const pieces: string[] = [];
  let from = 0;
  for (const span of delimiterSpans(value, delimiters, ignoreCase)) {
    pieces.push(value.slice(from, span.start));
    from = span.end;
  }
  pieces.push(value.slice(from));
  return skipEmpty ? pieces.filter(Boolean) : pieces;
}

function textSplit(args: Value[]): Value {
  const source = text(asMatrix(args[0])[0][0]);
  if (isError(source)) return source;
  const columns = delimiterList(args[1]);
  if (isError(columns)) return columns;
  const rowDelimiters = args.length > 2 ? delimiterList(args[2]) : [];
  if (isError(rowDelimiters)) return rowDelimiters;
  const skipEmpty = opt(bool, false)(argAt(args, 3));
  if (isError(skipEmpty)) return skipEmpty;
  const mode = opt(num, 0)(argAt(args, 4));
  if (isError(mode)) return mode;
  const ignoreCase = mode !== 0;
  const rows = split(source, rowDelimiters, ignoreCase, skipEmpty).map((line) => split(line, columns, ignoreCase, skipEmpty));
  const kept = rows.filter((row) => row.length);
  if (!kept.length) return ERR.calc;
  const width = Math.max(...kept.map((row) => row.length));
  const pad = argAt(args, 5) ?? ERR.na;
  return kept.map((row) => [...row, ...new Array<Scalar>(width - row.length).fill(pad)]) as Matrix;
}

const textOnly = (fn: (value: string) => Scalar) => ({ fn: scalar([text], fn) });

export const TEXT_FUNCTIONS: Record<string, FunctionSpec> = {
  CONCAT: txt("text1, [text2], ...", "Joins text from values and ranges.", { fn: concat }),
  CONCATENATE: txt("text1, [text2], ...", "Joins several text values into one.", { fn: liftScalar((items) => concat(items)) }),
  TEXTJOIN: txt("delimiter, ignore_empty, text1, [text2], ...", "Joins text with a delimiter, optionally skipping empty values.", { fn: textJoin }),
  LEFT: txt("text, [num_chars]", "Returns the first characters of text.", { fn: scalar([text, opt(int, 1)], left) }),
  RIGHT: txt("text, [num_chars]", "Returns the last characters of text.", { fn: scalar([text, opt(int, 1)], right) }),
  MID: txt("text, start_num, num_chars", "Returns characters from the middle of text.", { fn: scalar([text, int, int], mid) }),
  LEN: txt("text", "Returns the number of characters in text.", textOnly((value) => value.length)),
  UPPER: txt("text", "Converts text to uppercase.", textOnly((value) => value.toUpperCase())),
  LOWER: txt("text", "Converts text to lowercase.", textOnly((value) => value.toLowerCase())),
  PROPER: txt("text", "Capitalizes the first letter of each word.", textOnly(proper)),
  TRIM: txt("text", "Removes extra spaces, leaving single spaces between words.", textOnly(trim)),
  CLEAN: txt("text", "Removes non-printing characters.", textOnly(clean)),
  SUBSTITUTE: txt("text, old_text, new_text, [instance_num]", "Replaces matching text, everywhere or at one instance.", { fn: scalar([text, text, text, opt<number | null>(int, null)], substitute) }),
  REPLACE: txt("old_text, start_num, num_chars, new_text", "Replaces characters at a position.", { fn: scalar([text, int, int, text], replace) }),
  FIND: txt("find_text, within_text, [start_num]", "Finds text inside other text, matching case.", { fn: scalar([text, text, opt(int, 1)], find) }),
  SEARCH: txt("find_text, within_text, [start_num]", "Finds text inside other text, ignoring case and allowing wildcards.", { fn: scalar([text, text, opt(int, 1)], search) }),
  TEXT: txt("value, format_text", "Formats a number as text with a number format code.", { fn: liftScalar(textFormat) }),
  VALUE: txt("text", "Converts text that looks like a number into a number.", { fn: liftScalar(([item]) => value(item)) }),
  NUMBERVALUE: txt("text, [decimal_separator], [group_separator]", "Converts text to a number using the given separators.", { fn: scalar([text, opt(text, "."), opt(text, ",")], numberValue) }),
  REPT: txt("text, number_times", "Repeats text a number of times.", { fn: scalar([text, int], rept) }),
  EXACT: txt("text1, text2", "Returns TRUE when two texts are exactly the same, including case.", { fn: scalar([text, text], (a, b) => a === b) }),
  CHAR: txt("number", "Returns the character for a code from 1 to 255.", { fn: scalar([int], char) }),
  CODE: txt("text", "Returns the code of the first character.", textOnly(code)),
  UNICHAR: txt("number", "Returns the Unicode character for a number.", { fn: scalar([int], unichar) }),
  UNICODE: txt("text", "Returns the Unicode number of the first character.", textOnly(unicode)),
  FIXED: txt("number, [decimals], [no_commas]", "Rounds a number and returns it as text.", { fn: scalar([num, opt(num, 2), opt(bool, false)], fixed) }),
  DOLLAR: txt("number, [decimals]", "Formats a number as currency text.", { fn: scalar([num, opt(num, 2)], dollar) }),
  TEXTBEFORE: txt("text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found]", "Returns the text before a delimiter.", { fn: textAround(true) }),
  TEXTAFTER: txt("text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found]", "Returns the text after a delimiter.", { fn: textAround(false) }),
  TEXTSPLIT: txt("text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with]", "Splits text into columns and rows at delimiters.", { array: true, fn: textSplit }),
};
