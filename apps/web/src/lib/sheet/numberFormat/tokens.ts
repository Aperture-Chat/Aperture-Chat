/** Excel format codes as tokens.
 *
 * Glossary:
 * - section: one of up to four ";"-separated parts of a code, for positive,
 *   negative, zero, and text values (or for values meeting a condition).
 * - placeholder: a digit slot. "0" always shows a digit, "#" shows only
 *   significant digits, and "?" shows a space in place of an insignificant one.
 * - literal: text shown as written: quoted text, a "\x" escape, or a plain symbol.
 * - spacing: "_x", a space as wide as x. fill: "*x", x repeated to fill the cell.
 * - scaling: commas after the last placeholder, each dividing by 1,000.
 *
 * Every token keeps its source span so callers such as adjustDecimals can
 * rewrite a code without disturbing anything else in it.
 */

export type DigitChar = "0" | "#" | "?";
export type CompareOp = "<" | "<=" | ">" | ">=" | "=" | "<>";
export type DateChar = "y" | "m" | "d" | "h" | "s";
export type ElapsedUnit = "h" | "m" | "s";
export type Condition = { op: CompareOp; limit: number };

export type TokenBody =
  | { kind: "literal"; text: string }
  | { kind: "space"; width: string }
  | { kind: "fill"; ch: string }
  | { kind: "currency"; symbol: string }
  | { kind: "color"; hex: string }
  | ({ kind: "condition" } & Condition)
  | { kind: "elapsed"; unit: ElapsedUnit; width: number }
  | { kind: "general" }
  | { kind: "text" }
  | { kind: "digit"; ch: DigitChar }
  | { kind: "point" }
  | { kind: "comma" }
  | { kind: "percent" }
  | { kind: "exponent"; sign: "+" | "-" }
  | { kind: "slash" }
  | { kind: "date"; ch: DateChar; width: number }
  | { kind: "ampm"; am: string; pm: string };

export type Token = TokenBody & { start: number; end: number };
export type TokenOf<K extends TokenBody["kind"]> = Extract<Token, { kind: K }>;

type Read = { body: TokenBody | null; next: number };
type Reader = (code: string, index: number) => Read;

export function tokenizeFormat(code: string): Token[][] {
  const sections: Token[][] = [[]];
  let index = 0;
  while (index < code.length) {
    if (code[index] === ";") {
      sections.push([]);
      index += 1;
      continue;
    }
    const { body, next } = readToken(code, index);
    if (body) sections[sections.length - 1].push({ ...body, start: index, end: next });
    index = next;
  }
  return sections;
}

function readToken(code: string, index: number): Read {
  const reader = READERS.get(code[index]) ?? (/[a-z]/i.test(code[index]) ? readWord : readSymbol);
  return reader(code, index);
}

const literal = (text: string): TokenBody => ({ kind: "literal", text });
const single = (body: TokenBody): Reader => (_code, index) => ({ body, next: index + 1 });
const readSymbol: Reader = (code, index) => ({ body: literal(code[index]), next: index + 1 });

const READERS = new Map<string, Reader>([
  ['"', readQuoted],
  ["\\", (code, index) => ({ body: index + 1 < code.length ? literal(code[index + 1]) : null, next: index + 2 })],
  ["_", (code, index) => ({ body: { kind: "space", width: code[index + 1] ?? "" }, next: index + 2 })],
  ["*", (code, index) => ({ body: { kind: "fill", ch: code[index + 1] ?? "" }, next: index + 2 })],
  ["[", readBracket],
  ["@", single({ kind: "text" })],
  ["0", single({ kind: "digit", ch: "0" })],
  ["#", single({ kind: "digit", ch: "#" })],
  ["?", single({ kind: "digit", ch: "?" })],
  [".", single({ kind: "point" })],
  [",", single({ kind: "comma" })],
  ["%", single({ kind: "percent" })],
  ["/", single({ kind: "slash" })],
]);

function readQuoted(code: string, index: number): Read {
  const close = code.indexOf('"', index + 1);
  const end = close === -1 ? code.length : close;
  return { body: literal(code.slice(index + 1, end)), next: end + 1 };
}

/* ------------------------------------------------------------------ words */

const WORD_READERS: Array<(code: string, index: number) => Read | null> = [readGeneral, readAmPm, readExponent, readDateRun];

function readWord(code: string, index: number): Read {
  for (const reader of WORD_READERS) {
    const read = reader(code, index);
    if (read) return read;
  }
  return readSymbol(code, index);
}

function readGeneral(code: string, index: number): Read | null {
  return code.slice(index, index + 7).toLowerCase() === "general" ? { body: { kind: "general" }, next: index + 7 } : null;
}

function readAmPm(code: string, index: number): Read | null {
  if (code.slice(index, index + 5).toUpperCase() === "AM/PM") return { body: { kind: "ampm", am: "AM", pm: "PM" }, next: index + 5 };
  if (code.slice(index, index + 3).toUpperCase() !== "A/P") return null;
  return { body: { kind: "ampm", am: code[index], pm: code[index + 2] }, next: index + 3 };
}

function readExponent(code: string, index: number): Read | null {
  const sign = code[index + 1];
  if (code[index].toUpperCase() !== "E" || (sign !== "+" && sign !== "-")) return null;
  return { body: { kind: "exponent", sign }, next: index + 2 };
}

function readDateRun(code: string, index: number): Read | null {
  const ch = code[index].toLowerCase();
  if (!isDateChar(ch)) return null;
  let next = index;
  while (next < code.length && code[next].toLowerCase() === ch) next += 1;
  return { body: { kind: "date", ch, width: next - index }, next };
}

function isDateChar(ch: string): ch is DateChar {
  return ch === "y" || ch === "m" || ch === "d" || ch === "h" || ch === "s";
}

/* ------------------------------------------------------------------ brackets */

function readBracket(code: string, index: number): Read {
  const close = code.indexOf("]", index);
  if (close === -1) return readSymbol(code, index);
  return { body: bracketToken(code.slice(index + 1, close)), next: close + 1 };
}

/** A color, a condition, an elapsed-time unit, or a locale and currency tag.
 * Anything else ([DBNum1], [ENG], ...) changes nothing in en-US and is dropped. */
function bracketToken(inner: string): TokenBody | null {
  return colorToken(inner) ?? conditionToken(inner) ?? elapsedToken(inner) ?? currencyToken(inner);
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  blue: "#0000ff",
  cyan: "#00ffff",
  green: "#00ff00",
  magenta: "#ff00ff",
  red: "#ff0000",
  white: "#ffffff",
  yellow: "#ffff00",
};

/** Excel's default 56-color palette, addressed as [Color1]..[Color56]. */
const PALETTE = (
  "000000 ffffff ff0000 00ff00 0000ff ffff00 ff00ff 00ffff 800000 008000 000080 808000 800080 008080 c0c0c0 808080 " +
  "9999ff 993366 ffffcc ccffff 660066 ff8080 0066cc ccccff 000080 ff00ff ffff00 00ffff 800080 800000 008080 0000ff " +
  "00ccff ccffff ccffcc ffff99 99ccff ff99cc cc99ff ffcc99 3366ff 33cccc 99cc00 ffcc00 ff9900 ff6600 666699 969696 " +
  "003366 339966 003300 333300 993300 993366 333399 333333"
).split(" ");

function colorToken(inner: string): TokenBody | null {
  const named = NAMED_COLORS[inner.toLowerCase()];
  if (named) return { kind: "color", hex: named };
  const indexed = /^color\s*(\d{1,2})$/i.exec(inner);
  const hex = indexed ? PALETTE[Number(indexed[1]) - 1] : undefined;
  return hex ? { kind: "color", hex: `#${hex}` } : null;
}

function conditionToken(inner: string): TokenBody | null {
  const match = /^(<>|<=|>=|<|>|=)\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i.exec(inner.trim());
  return match ? { kind: "condition", op: match[1] as CompareOp, limit: Number(match[2]) } : null;
}

function elapsedToken(inner: string): TokenBody | null {
  if (!/^(h+|m+|s+)$/i.test(inner)) return null;
  return { kind: "elapsed", unit: inner[0].toLowerCase() as ElapsedUnit, width: inner.length };
}

/** "[$€-x-euro2]" shows "€"; "[$-409]" only names a locale and shows nothing. */
function currencyToken(inner: string): TokenBody | null {
  if (!inner.startsWith("$")) return null;
  const symbol = inner.slice(1).split("-")[0];
  return symbol ? { kind: "currency", symbol } : null;
}

/* ------------------------------------------------------------------ sections */

export type SectionPlan = { numeric: Token[][]; text: Token[] | null };

/** Splits a code into the sections that format numbers and the one that
 * formats text: the fourth section, or a last section that contains "@". */
export function planSections(sections: Token[][]): SectionPlan {
  const used = sections.slice(0, 4);
  const last = used[used.length - 1];
  const textLast = used.length === 4 || last.some((token) => token.kind === "text");
  return textLast ? { numeric: used.slice(0, -1), text: last } : { numeric: used, text: null };
}

export type SectionHead = { color?: string; condition?: Condition; tokens: Token[] };

/** Pulls a section's first color and condition out of its tokens. */
export function sectionHead(tokens: Token[]): SectionHead {
  const color = tokens.find((token): token is TokenOf<"color"> => token.kind === "color");
  const condition = tokens.find((token): token is TokenOf<"condition"> => token.kind === "condition");
  return {
    ...(color ? { color: color.hex } : {}),
    ...(condition ? { condition: { op: condition.op, limit: condition.limit } } : {}),
    tokens: tokens.filter((token) => token.kind !== "color" && token.kind !== "condition"),
  };
}

/** Day, month, year, hour, minute, second, elapsed time, or AM/PM. */
export function isDateToken(token: Token): boolean {
  return token.kind === "date" || token.kind === "elapsed" || token.kind === "ampm";
}

export function isDateSection(tokens: Token[]): boolean {
  return tokens.some(isDateToken);
}

type FixedTextKind = Exclude<TokenBody["kind"], "literal" | "space" | "currency" | "digit" | "exponent">;

const FIXED_TEXT: Record<FixedTextKind, string> = {
  point: ".",
  comma: ",",
  percent: "%",
  slash: "/",
  fill: "",
  color: "",
  condition: "",
  elapsed: "",
  general: "",
  text: "",
  date: "",
  ampm: "",
};

/** What a token shows when it has no special meaning where it stands. */
export function plainText(token: Token): string {
  if (token.kind === "literal") return token.text;
  if (token.kind === "space") return " ";
  if (token.kind === "currency") return token.symbol;
  if (token.kind === "digit") return token.ch;
  if (token.kind === "exponent") return `E${token.sign}`;
  return FIXED_TEXT[token.kind];
}

/** The code, or null when it means General (absent, blank, or "General"). */
export function customCode(code: string | undefined): string | null {
  return !code || code.trim().toLowerCase() === "general" ? null : code;
}
