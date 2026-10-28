/**
 * Prompt, reply, and review helpers for the AI edit on a chat code block.
 *
 * The reader highlights part of a finished code block and tells the model
 * what to change. The model sees the whole block with the selection marked,
 * replies with replacement code only, and the reply is applied to exactly
 * the selected range once the reader accepts the line diff.
 */
import type { ChatWireMessage } from "./api/chat";
import type { AiEditAction } from "./aiEditPrompts";

/** Half-open character range [start, end) into the block's code. */
export type CodeSelection = { start: number; end: number };

/** The API recognizes this opening line as a code edit, not a chat turn, so
 * the embedded code is never mined for memories or reply-length rules. */
export const CODE_INLINE_EDIT_PREFIX = "You are editing a highlighted selection in a code block.";

/** Nearest code kept on each side of the selection, so a huge file stays a
 * focused request. */
const CONTEXT_CHARS = 12_000;
/** Largest line-by-line comparison worth computing for the review. */
const MAX_DIFF_CELLS = 250_000;
const LABEL_TEXT_MAX = 60;

const SYSTEM_PROMPT = [
  "You edit one highlighted selection inside a code block.",
  "Reply with only the replacement code for the selection: no explanation, no Markdown fences, no line numbers.",
  "The replacement goes exactly where the selection was, so the code before and after it must stay valid.",
  "Keep the language, indentation style, and every part the instruction does not ask you to change.",
].join(" ");

export const CODE_SELECTION_ACTIONS: AiEditAction[] = [
  {
    id: "fix",
    label: "Fix bugs",
    group: "improve",
    keywords: "bug error broken repair",
    instruction: "Find and fix bugs in the selected code. Keep its behavior otherwise unchanged.",
  },
  {
    id: "simplify",
    label: "Simplify",
    group: "improve",
    keywords: "clean refactor tidy shorter",
    instruction: "Simplify and clean up the selected code without changing what it does.",
  },
  {
    id: "comment",
    label: "Add comments",
    group: "improve",
    keywords: "explain document docs",
    instruction: "Add concise comments that explain intent where the code is not obvious. Do not change the code itself.",
  },
  {
    id: "errors",
    label: "Add error handling",
    group: "improve",
    keywords: "exception validate try catch",
    instruction: "Add sensible error handling and input checks to the selected code.",
  },
  {
    id: "names",
    label: "Use clearer names",
    group: "improve",
    keywords: "rename variable identifier",
    instruction:
      "Rename local variables and helpers in the selection to clear, descriptive names. Keep every name the rest of the code depends on unchanged.",
  },
  {
    id: "types",
    label: "Add types",
    group: "transform",
    keywords: "type hints annotations typing",
    instruction: "Add type annotations or type hints in the idiom of this language.",
  },
  {
    id: "modernize",
    label: "Modernize syntax",
    group: "transform",
    keywords: "idiomatic update modern",
    instruction: "Rewrite the selection with current idiomatic syntax for this language, keeping the same behavior.",
  },
];

function fenced(text: string) {
  return `<<<\n${text}${text && !text.endsWith("\n") ? "\n" : ""}>>>`;
}

export function codeEditMessages(input: {
  code: string;
  language: string;
  selection: CodeSelection;
  instruction: string;
}): ChatWireMessage[] {
  const { code, language, selection, instruction } = input;
  const before = code.slice(Math.max(0, selection.start - CONTEXT_CHARS), selection.start);
  const after = code.slice(selection.end, selection.end + CONTEXT_CHARS);
  const user = [
    CODE_INLINE_EDIT_PREFIX,
    `Language: ${language.trim() || "unknown"}`,
    "",
    `User instruction:\n${instruction.trim()}`,
    "",
    `Code before the selection:\n${fenced(before)}`,
    "",
    `Selected code (replace exactly this):\n${fenced(code.slice(selection.start, selection.end))}`,
    "",
    `Code after the selection:\n${fenced(after)}`,
  ].join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/** Continues the conversation behind the suggestion on screen. */
export function codeEditRefineMessages(
  messages: ChatWireMessage[],
  previousReply: string,
  instruction: string,
): ChatWireMessage[] {
  return [
    ...messages,
    { role: "assistant", content: previousReply },
    {
      role: "user",
      content: `${CODE_INLINE_EDIT_PREFIX}\nRevise your replacement code: ${instruction.trim()}\nReply with only the full replacement code for the selection.`,
    },
  ];
}

/** The body of the reply's first fenced block, or the whole reply. */
function unfenced(reply: string): string {
  const match = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?[ \t]*\1[ \t]*$/m.exec(reply);
  return match ? match[2]! : reply;
}

function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "").replace(/^[ \t]+$/, "");
}

/** The first of the shallowest indents among the non-blank lines. */
function minIndent(text: string): string {
  const indents = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => /^[ \t]*/.exec(line)![0]);
  if (!indents.length) return "";
  const width = Math.min(...indents.map((indent) => indent.length));
  return indents.find((indent) => indent.length === width)!;
}

/** Cleans a model reply into code that drops into the selection: fences and
 * lead-in sentences removed, the selection's indentation restored when the
 * model wrote the block flush left, and its trailing line break kept. */
export function codeReplacementFromReply(reply: string, selected: string): string | null {
  let code = trimBlankLines(unfenced(reply));
  if (!code.trim()) return null;
  const indent = minIndent(selected);
  if (indent && !minIndent(code)) {
    code = code
      .split("\n")
      .map((line) => (line.trim() ? indent + line : line))
      .join("\n");
  }
  return selected.endsWith("\n") ? `${code}\n` : code;
}

export function applyCodeReplacement(code: string, selection: CodeSelection, replacement: string): string {
  return code.slice(0, selection.start) + replacement + code.slice(selection.end);
}

function lineIndexAt(code: string, offset: number): number {
  return code.slice(0, offset).split("\n").length - 1;
}

/** Zero-based first and last line the selection covers. A selection that
 * ends right after a line break does not reach into the next line. */
export function codeSelectionLines(code: string, selection: CodeSelection): { first: number; last: number } {
  const first = lineIndexAt(code, selection.start);
  const endsAfterBreak = code[selection.end - 1] === "\n";
  const last = lineIndexAt(code, endsAfterBreak ? selection.end - 1 : selection.end);
  return { first, last: Math.max(first, last) };
}

/** “text” for a short selection inside one line, otherwise its line range. */
export function codeSelectionLabel(code: string, selection: CodeSelection): string {
  const text = code.slice(selection.start, selection.end);
  const { first, last } = codeSelectionLines(code, selection);
  if (first === last && !text.includes("\n")) {
    const trimmed = text.trim();
    return `“${trimmed.length > LABEL_TEXT_MAX ? `${trimmed.slice(0, LABEL_TEXT_MAX)}…` : trimmed}”`;
  }
  return first === last ? `Line ${first + 1}` : `Lines ${first + 1}–${last + 1}`;
}

export type CodeDiffRow =
  | { kind: "same"; text: string; before: number; after: number }
  | { kind: "remove"; text: string; before: number }
  | { kind: "add"; text: string; after: number };

/** Every line removed, then every line added; `from` numbers the first. */
function wholesaleDiff(before: string[], after: string[], fromBefore = 0, fromAfter = 0): CodeDiffRow[] {
  return [
    ...before.map((text, index): CodeDiffRow => ({ kind: "remove", text, before: fromBefore + index })),
    ...after.map((text, index): CodeDiffRow => ({ kind: "add", text, after: fromAfter + index })),
  ];
}

/** Longest-common-subsequence table: lengths[i][j] covers before[i..] and after[j..]. */
function commonLengths(before: string[], after: string[]): number[][] {
  const lengths = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        before[i] === after[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  return lengths;
}

/** Line diff for reviewing a suggestion, removals before additions. */
export function codeLineDiff(beforeText: string, afterText: string): CodeDiffRow[] {
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  if (before.length * after.length > MAX_DIFF_CELLS) return wholesaleDiff(before, after);
  const lengths = commonLengths(before, after);
  const rows: CodeDiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      rows.push({ kind: "same", text: before[i]!, before: i++, after: j++ });
    } else if (lengths[i + 1]![j] === lengths[i]![j]) {
      // Dropping this line keeps the longest common run: it was removed.
      rows.push({ kind: "remove", text: before[i]!, before: i++ });
    } else {
      rows.push({ kind: "add", text: after[j]!, after: j++ });
    }
  }
  return rows.concat(wholesaleDiff(before.slice(i), after.slice(j), i, j));
}
