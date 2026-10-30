/** Excel formula tokenizer and parser.
 *
 * `tokenizeFormula` keeps every token's source span, so reference rewrites
 * (row/column inserts, fills, sheet renames) edit only the references and
 * leave the author's spacing and casing alone. `parseFormula` builds the AST
 * the evaluator walks. Operator precedence follows Excel, including two
 * quirks: unary minus binds tighter than "^" (-2^2 = 4) and "^" is
 * left-associative (2^3^2 = 64).
 */

import { MAX_SHEET_COLS, MAX_SHEET_ROWS, columnIndex } from "../address";
import { ERROR_CODES, type ErrorCode } from "./values";

export type RefToken = { sheet: string | null; row: number; col: number; rowAbs: boolean; colAbs: boolean };

export type Token = { start: number; end: number } & (
  | { t: "num"; value: number }
  | { t: "str"; value: string }
  | { t: "err"; value: ErrorCode }
  | ({ t: "ref" } & RefToken)
  | { t: "colref"; sheet: string | null; col: number; abs: boolean }
  | { t: "rowref"; sheet: string | null; row: number; abs: boolean }
  | { t: "word"; value: string }
  | { t: "func"; value: string }
  | { t: "struct"; table: string; spec: string }
  | { t: "op"; value: string }
  | { t: "(" | ")" | "," | ";" | "{" | "}" | ":" }
  | { t: "ws" }
);

export class FormulaSyntaxError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

const WORD_START = /[A-Za-z_\\À-￿]/;
const WORD_CHAR = /[A-Za-z0-9_.\\À-￿]/;

function readSheetPrefix(source: string, at: number): { sheet: string; next: number } | null {
  if (source[at] === "'") {
    let index = at + 1;
    let name = "";
    while (index < source.length) {
      if (source[index] === "'") {
        if (source[index + 1] === "'") {
          name += "'";
          index += 2;
          continue;
        }
        break;
      }
      name += source[index];
      index += 1;
    }
    if (source[index] === "'" && source[index + 1] === "!") return { sheet: name, next: index + 2 };
    return null;
  }
  const match = /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*!/.exec(source.slice(at));
  return match ? { sheet: match[0].slice(0, -1), next: at + match[0].length } : null;
}

/** Reads one token starting at `start`, or returns null when the text there is not its kind. */
type Reader = (source: string, start: number, tokens: Token[]) => Token | null;

/** Splits a formula (without the leading "=") into tokens with source spans. */
export function tokenizeFormula(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const token = readToken(source, index, tokens);
    tokens.push(token);
    index = token.end;
  }
  return tokens;
}

function readToken(source: string, start: number, tokens: Token[]): Token {
  for (const read of READERS) {
    const token = read(source, start, tokens);
    if (token) return token;
  }
  throw new FormulaSyntaxError(`Unexpected character "${source[start]}".`, start);
}

function readWhitespace(source: string, start: number): Token | null {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index > start ? { t: "ws", start, end: index } : null;
}

/** "..." with "" standing for one quote. */
function readString(source: string, start: number): Token | null {
  if (source[start] !== '"') return null;
  let value = "";
  let index = start + 1;
  for (;;) {
    if (index >= source.length) throw new FormulaSyntaxError("A text value is missing its closing quote.", start);
    if (source[index] === '"') {
      if (source[index + 1] !== '"') break;
      value += '"';
      index += 2;
      continue;
    }
    value += source[index];
    index += 1;
  }
  return { t: "str", value, start, end: index + 1 };
}

function errorCodeAt(source: string, at: number): ErrorCode | undefined {
  return ERROR_CODES.find((item) => source.slice(at, at + item.length).toUpperCase() === item);
}

function readErrorValue(source: string, start: number): Token | null {
  if (source[start] !== "#") return null;
  const code = errorCodeAt(source, start);
  if (!code) throw new FormulaSyntaxError("Unknown error value.", start);
  return { t: "err", value: code, start, end: start + code.length };
}

/** A cell, whole-column, or whole-row reference, optionally sheet-prefixed.
 * After a sheet prefix nothing else may follow, so this throws there instead
 * of letting a later reader take the text. */
function readReference(source: string, start: number, tokens: Token[]): Token | null {
  const prefix = readSheetPrefix(source, start);
  const sheet = prefix?.sheet ?? null;
  const at = prefix?.next ?? start;
  const rest = source.slice(at);
  const ref = readCellRef(rest, sheet, start, at) ?? readColumnRef(rest, sheet, start, at, tokens) ?? readRowRef(rest, sheet, start, at, tokens);
  if (ref || sheet === null) return ref;
  return readDeletedRef(source, start, at);
}

const CELL_REF = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})(?![A-Za-z0-9_.(!])/;

function readCellRef(rest: string, sheet: string | null, start: number, at: number): Token | null {
  const cell = CELL_REF.exec(rest);
  if (!cell) return null;
  const col = columnIndex(cell[2]);
  const row = Number(cell[4]) - 1;
  if (col >= MAX_SHEET_COLS || row < 0 || row >= MAX_SHEET_ROWS) return null;
  return { t: "ref", sheet, col, row, colAbs: cell[1] === "$", rowAbs: cell[3] === "$", start, end: at + cell[0].length };
}

// Whole columns (A:C) and whole rows (2:5) only exist as one side of a ":".
const COLUMN_PAIR = /^(\$?)([A-Za-z]{1,3})(?=\s*:\s*\$?[A-Za-z]{1,3}(?![A-Za-z0-9_.(]))/;
const COLUMN_TAIL = /^(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_.(])/;
const ROW_PAIR = /^(\$?)([0-9]{1,7})(?=\s*:\s*\$?[0-9]{1,7}(?![0-9.eE]))/;
const ROW_TAIL = /^(\$?)([0-9]{1,7})(?![0-9.eE])/;

/** True when the last two non-space tokens are a `kind` reference and a ":". */
function followsColonAfter(tokens: Token[], kind: "colref" | "rowref"): boolean {
  const solid = tokens.filter((token) => token.t !== "ws");
  return solid.at(-1)?.t === ":" && solid.at(-2)?.t === kind;
}

function readColumnRef(rest: string, sheet: string | null, start: number, at: number, tokens: Token[]): Token | null {
  const match = COLUMN_PAIR.exec(rest) ?? (followsColonAfter(tokens, "colref") ? COLUMN_TAIL.exec(rest) : null);
  if (!match || columnIndex(match[2]) >= MAX_SHEET_COLS) return null;
  return { t: "colref", sheet, col: columnIndex(match[2]), abs: match[1] === "$", start, end: at + match[0].length };
}

function readRowRef(rest: string, sheet: string | null, start: number, at: number, tokens: Token[]): Token | null {
  const match = ROW_PAIR.exec(rest) ?? (followsColonAfter(tokens, "rowref") ? ROW_TAIL.exec(rest) : null);
  if (!match) return null;
  const row = Number(match[2]);
  if (row < 1 || row > MAX_SHEET_ROWS) return null;
  return { t: "rowref", sheet, row: row - 1, abs: match[1] === "$", start, end: at + match[0].length };
}

/** 'Sheet'!#REF! — the sheet prefix belongs to a deleted reference. */
function readDeletedRef(source: string, start: number, at: number): Token {
  const code = source[at] === "#" ? errorCodeAt(source, at) : undefined;
  if (!code) throw new FormulaSyntaxError("A sheet name must be followed by a cell or range.", start);
  return { t: "err", value: code, start, end: at + code.length };
}

const NUMBER = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;

function readNumber(source: string, start: number): Token | null {
  const number = NUMBER.exec(source.slice(start));
  return number ? { t: "num", value: Number(number[0]), start, end: start + number[0].length } : null;
}

/** A name, a function name (followed by "("), or a structured table reference. */
function readWord(source: string, start: number): Token | null {
  if (!WORD_START.test(source[start])) return null;
  let index = start;
  while (index < source.length && WORD_CHAR.test(source[index])) index += 1;
  const value = source.slice(start, index);
  if (source[index] === "[") return readStructured(source, start, index, value);
  let look = index;
  while (look < source.length && /\s/.test(source[look])) look += 1;
  return source[look] === "(" ? { t: "func", value, start, end: index } : { t: "word", value, start, end: index };
}

/** "[@Qty]" inside a table: a table reference that leaves the table name out. */
function readTableShorthand(source: string, start: number): Token | null {
  return source[start] === "[" ? readStructured(source, start, start, "") : null;
}

/** Table[spec], where the spec may nest brackets: Sales[[#This Row],[Qty]]. */
function readStructured(source: string, start: number, specStart: number, table: string): Token {
  let depth = 0;
  let index = specStart;
  while (index < source.length) {
    if (source[index] === "[") depth += 1;
    if (source[index] === "]") depth -= 1;
    index += 1;
    if (depth === 0) break;
  }
  if (depth !== 0) throw new FormulaSyntaxError("A table reference is missing its closing bracket.", start);
  return { t: "struct", table, spec: source.slice(specStart + 1, index - 1), start, end: index };
}

const TWO_CHAR_OPERATORS = ["<>", "<=", ">="];

function readOperator(source: string, start: number): Token | null {
  const two = source.slice(start, start + 2);
  if (TWO_CHAR_OPERATORS.includes(two)) return { t: "op", value: two, start, end: start + 2 };
  const ch = source[start];
  return "+-*/^&=<>%".includes(ch) ? { t: "op", value: ch, start, end: start + 1 } : null;
}

function readPunctuation(source: string, start: number): Token | null {
  const ch = source[start];
  return "(),;{}:".includes(ch) ? { t: ch as "(", start, end: start + 1 } : null;
}

/** Tried in order at each position; the first that reads a token wins. */
const READERS: Reader[] = [readWhitespace, readString, readErrorValue, readReference, readNumber, readWord, readTableShorthand, readOperator, readPunctuation];

/* ------------------------------------------------------------------ AST */

export type FormulaNode =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "err"; code: ErrorCode }
  | { type: "empty" }
  | { type: "ref"; sheet: string | null; row: number; col: number }
  | { type: "range"; sheet: string | null; r1: number; c1: number; r2: number; c2: number }
  | { type: "name"; name: string }
  | { type: "struct"; table: string; spec: string }
  | { type: "call"; name: string; args: FormulaNode[] }
  | { type: "unary"; op: "-" | "+" | "%"; arg: FormulaNode }
  | { type: "binary"; op: string; left: FormulaNode; right: FormulaNode }
  | { type: "array"; rows: FormulaNode[][] };

const BINARY_PRECEDENCE: Record<string, number> = {
  "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1,
  "&": 2,
  "+": 3, "-": 3,
  "*": 4, "/": 4,
  "^": 5,
};
const PREFIX_PRECEDENCE = 6;

/** Function names arrive with Excel's file prefixes when imported. */
export function canonicalFunctionName(name: string): string {
  return name.toUpperCase().replace(/^(_XLFN\.)?(_XLWS\.)?/, "");
}

/** Tokens that stand for themselves, needing nothing after them. */
function literalNode(token: Token): FormulaNode | null {
  switch (token.t) {
    case "num":
      return { type: "num", value: token.value };
    case "str":
      return { type: "str", value: token.value };
    case "err":
      return { type: "err", code: token.value };
    case "word":
      return wordNode(token.value);
    case "struct":
      return { type: "struct", table: token.table, spec: token.spec };
    default:
      return null;
  }
}

function wordNode(value: string): FormulaNode {
  const upper = value.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE") return { type: "bool", value: upper === "TRUE" };
  return { type: "name", name: value };
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens.filter((token) => token.t !== "ws");
  }

  parse(): FormulaNode {
    if (!this.tokens.length) throw new FormulaSyntaxError("The formula is empty.", 0);
    const node = this.expression(0);
    const extra = this.peek();
    if (extra) throw new FormulaSyntaxError("Unexpected text after the end of the formula.", extra.start);
    return node;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) {
      const last = this.tokens.at(-1);
      throw new FormulaSyntaxError("The formula ends too early.", last ? last.end : 0);
    }
    this.index += 1;
    return token;
  }

  private expect(kind: Token["t"], message: string): Token {
    const token = this.peek();
    if (!token || token.t !== kind) throw new FormulaSyntaxError(message, token?.start ?? this.tokens.at(-1)?.end ?? 0);
    this.index += 1;
    return token;
  }

  private expression(minPrecedence: number): FormulaNode {
    let left = this.prefix();
    for (;;) {
      const token = this.peek();
      if (!token || token.t !== "op") break;
      if (token.value === "%") {
        this.index += 1;
        left = { type: "unary", op: "%", arg: left };
        continue;
      }
      const precedence = BINARY_PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.index += 1;
      const right = this.expression(precedence + 1);
      left = { type: "binary", op: token.value, left, right };
    }
    return left;
  }

  private prefix(): FormulaNode {
    const token = this.next();
    const node = literalNode(token) ?? this.reference(token);
    if (node) return node;
    switch (token.t) {
      case "op":
        return this.unary(token);
      case "func":
        return this.call(token.value, token.start);
      case "(": {
        const inner = this.expression(0);
        this.expect(")", "A parenthesis is not closed.");
        return inner;
      }
      case "{":
        return this.array();
      default:
        throw new FormulaSyntaxError(`Unexpected "${token.t}".`, token.start);
    }
  }

  private unary(token: Extract<Token, { t: "op" }>): FormulaNode {
    if (token.value === "-" || token.value === "+") {
      return { type: "unary", op: token.value, arg: this.expression(PREFIX_PRECEDENCE) };
    }
    throw new FormulaSyntaxError(`"${token.value}" needs a value before it.`, token.start);
  }

  /** A cell, a cell range (A1:B2), or a whole-column or whole-row range; null for other tokens. */
  private reference(token: Token): FormulaNode | null {
    switch (token.t) {
      case "ref":
        return this.cellRange(token);
      case "colref": {
        this.expect(":", "A column range needs a second column, like A:C.");
        const end = this.expect("colref", "A column range needs a second column, like A:C.") as Extract<Token, { t: "colref" }>;
        return { type: "range", sheet: token.sheet, r1: 0, c1: Math.min(token.col, end.col), r2: MAX_SHEET_ROWS - 1, c2: Math.max(token.col, end.col) };
      }
      case "rowref": {
        this.expect(":", "A row range needs a second row, like 2:5.");
        const end = this.expect("rowref", "A row range needs a second row, like 2:5.") as Extract<Token, { t: "rowref" }>;
        return { type: "range", sheet: token.sheet, r1: Math.min(token.row, end.row), c1: 0, r2: Math.max(token.row, end.row), c2: MAX_SHEET_COLS - 1 };
      }
      default:
        return null;
    }
  }

  private cellRange(token: Extract<Token, { t: "ref" }>): FormulaNode {
    if (this.peek()?.t !== ":" || this.peek(1)?.t !== "ref") return { type: "ref", sheet: token.sheet, row: token.row, col: token.col };
    this.index += 1;
    const end = this.next() as Extract<Token, { t: "ref" }>;
    return {
      type: "range",
      sheet: token.sheet,
      r1: Math.min(token.row, end.row),
      c1: Math.min(token.col, end.col),
      r2: Math.max(token.row, end.row),
      c2: Math.max(token.col, end.col),
    };
  }

  private call(name: string, start: number): FormulaNode {
    this.expect("(", "A function needs an opening parenthesis.");
    const args: FormulaNode[] = [];
    if (this.peek()?.t === ")") this.index += 1;
    else this.callArguments(name, start, args);
    return { type: "call", name: canonicalFunctionName(name), args };
  }

  /** Arguments up to the closing parenthesis; a missing one is an empty argument, as in IF(,1,). */
  private callArguments(name: string, start: number, args: FormulaNode[]): void {
    for (;;) {
      args.push(this.argument(name, start));
      const separator = this.next();
      if (separator.t === ")") return;
      if (separator.t !== ",") throw new FormulaSyntaxError(`Expected "," or ")" in ${name.toUpperCase()}.`, separator.start);
      if (this.peek()?.t === ")") {
        args.push({ type: "empty" });
        this.index += 1;
        return;
      }
    }
  }

  private argument(name: string, start: number): FormulaNode {
    const token = this.peek();
    if (!token) throw new FormulaSyntaxError(`${name.toUpperCase()} is missing a closing parenthesis.`, start);
    return token.t === "," || token.t === ")" ? { type: "empty" } : this.expression(0);
  }

  private array(): FormulaNode {
    const rows: FormulaNode[][] = [[]];
    for (;;) {
      const token = this.next();
      if (token.t === "}") break;
      if (token.t === ",") continue;
      if (token.t === ";") {
        rows.push([]);
        continue;
      }
      this.index -= 1;
      const item = this.expression(PREFIX_PRECEDENCE);
      if (!["num", "str", "bool", "err", "unary"].includes(item.type)) {
        throw new FormulaSyntaxError("Array constants can hold only numbers, text, and TRUE/FALSE.", token.start);
      }
      rows[rows.length - 1].push(item);
    }
    const width = rows[0].length;
    if (!width || rows.some((row) => row.length !== width)) {
      throw new FormulaSyntaxError("Every row of an array constant needs the same number of items.", 0);
    }
    return { type: "array", rows };
  }
}

export type ParsedFormula = { ok: true; ast: FormulaNode } | { ok: false; error: string; position: number };

const PARSE_CACHE = new Map<string, ParsedFormula>();
const PARSE_CACHE_LIMIT = 20_000;

/** Parses formula text (with or without "="); results are memoized by text. */
export function parseFormula(formula: string): ParsedFormula {
  const source = formula.startsWith("=") ? formula.slice(1) : formula;
  const cached = PARSE_CACHE.get(source);
  if (cached) return cached;
  let result: ParsedFormula;
  try {
    result = { ok: true, ast: new Parser(tokenizeFormula(source)).parse() };
  } catch (error) {
    if (!(error instanceof FormulaSyntaxError)) throw error;
    result = { ok: false, error: error.message, position: error.position };
  }
  if (PARSE_CACHE.size >= PARSE_CACHE_LIMIT) PARSE_CACHE.clear();
  PARSE_CACHE.set(source, result);
  return result;
}

/** Every function name a formula calls, upper-cased. */
export function formulaFunctionNames(node: FormulaNode, into = new Set<string>()): Set<string> {
  switch (node.type) {
    case "call":
      into.add(node.name);
      node.args.forEach((arg) => formulaFunctionNames(arg, into));
      break;
    case "unary":
      formulaFunctionNames(node.arg, into);
      break;
    case "binary":
      formulaFunctionNames(node.left, into);
      formulaFunctionNames(node.right, into);
      break;
    case "array":
      node.rows.forEach((row) => row.forEach((item) => formulaFunctionNames(item, into)));
      break;
    default:
      break;
  }
  return into;
}
