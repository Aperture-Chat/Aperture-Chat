/**
 * Editor keystrokes for an inline code block: Tab indents, Shift+Tab
 * outdents, Enter keeps the indentation. Each returns one text replacement so
 * the editor can apply it as a single, undoable insertion.
 */

/** Replace value[start, end) with `text`, then select [selectStart, selectEnd). */
export type TextEdit = { start: number; end: number; text: string; selectStart: number; selectEnd: number };

const OPENERS = /[{[(:]$/;
const CLOSER_OF: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

/** One indent level as the code already writes it: a tab, or its narrowest
 * space indent. Code with no indentation gets its language's convention. */
export function codeIndentUnit(code: string, language: string): string {
  const indents = code
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => /^[ \t]*/.exec(line)![0])
    .filter(Boolean);
  const tabbed = indents.filter((indent) => indent.startsWith("\t")).length;
  if (tabbed > indents.length - tabbed) return "\t";
  const widths = indents.filter((indent) => !indent.startsWith("\t")).map((indent) => indent.length);
  const narrowest = Math.min(...widths);
  if (Number.isFinite(narrowest) && narrowest >= 2 && narrowest <= 8) return " ".repeat(narrowest);
  return /^py(thon)?$/i.test(language.trim()) ? "    " : "  ";
}

function lineStartOf(value: string, offset: number) {
  return value.lastIndexOf("\n", offset - 1) + 1;
}

/** The whole lines a selection touches. A selection ending just after a line
 * break leaves the next line alone. */
function touchedLines(value: string, start: number, end: number) {
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const lineEnd = value.indexOf("\n", last);
  return { from: lineStartOf(value, start), to: lineEnd === -1 ? value.length : lineEnd };
}

export function indentEdit(value: string, start: number, end: number, unit: string): TextEdit {
  if (start === end) return { start, end, text: unit, selectStart: start + unit.length, selectEnd: start + unit.length };
  const { from, to } = touchedLines(value, start, end);
  const text = value
    .slice(from, to)
    .split("\n")
    .map((line) => (line ? unit + line : line))
    .join("\n");
  return { start: from, end: to, text, selectStart: from, selectEnd: from + text.length };
}

function outdentLine(line: string, unit: string): string {
  if (line.startsWith("\t")) return line.slice(1);
  const spaces = /^ */.exec(line)![0].length;
  return line.slice(Math.min(spaces, unit === "\t" ? 4 : unit.length));
}

export function outdentEdit(value: string, start: number, end: number, unit: string): TextEdit | null {
  const { from, to } = touchedLines(value, start, end);
  const block = value.slice(from, to);
  const text = block
    .split("\n")
    .map((line) => outdentLine(line, unit))
    .join("\n");
  if (text === block) return null;
  if (start !== end) return { start: from, end: to, text, selectStart: from, selectEnd: from + text.length };
  const caret = Math.max(from, start - (block.length - text.length));
  return { start: from, end: to, text, selectStart: caret, selectEnd: caret };
}

/** Enter: a new line at the current indentation, one level deeper after an
 * opening bracket or colon, and a bracket pair split around the caret. */
export function lineBreakEdit(value: string, start: number, end: number, unit: string): TextEdit {
  const lineStart = lineStartOf(value, start);
  const indent = /^[ \t]*/.exec(value.slice(lineStart, start))![0];
  const before = value.slice(lineStart, start).trimEnd();
  const opener = OPENERS.test(before) ? before.at(-1)! : "";
  const inner = `\n${indent}${opener ? unit : ""}`;
  const closer = CLOSER_OF[opener];
  const text = closer && value[end] === closer ? `${inner}\n${indent}` : inner;
  return { start, end, text, selectStart: start + inner.length, selectEnd: start + inner.length };
}
