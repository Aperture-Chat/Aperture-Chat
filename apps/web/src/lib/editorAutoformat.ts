/**
 * Markdown-style autoformat for the Drafts document canvas, the way Word's
 * AutoFormat-as-you-type works: typing "# " at the start of a paragraph makes
 * it a title, "- " starts a bulleted list, "**bold**" becomes bold, and so on.
 * Each rule is only a trigger; the formatting itself goes through the same
 * editor commands the toolbar uses, so undo, exports, and the sanitizer see
 * ordinary markup.
 */

export type BlockAutoformat = {
  command: "formatBlock" | "insertUnorderedList" | "insertOrderedList";
  value?: string;
  label: string;
};

const BLOCK_RULES: Array<{ marker: RegExp; format: BlockAutoformat }> = [
  { marker: /^#$/, format: { command: "formatBlock", value: "h1", label: "Title" } },
  { marker: /^##$/, format: { command: "formatBlock", value: "h2", label: "Heading" } },
  { marker: /^###$/, format: { command: "formatBlock", value: "h3", label: "Subheading" } },
  { marker: /^[-*•+]$/, format: { command: "insertUnorderedList", label: "Bulleted list" } },
  { marker: /^1[.)]$/, format: { command: "insertOrderedList", label: "Numbered list" } },
  { marker: /^>$/, format: { command: "formatBlock", value: "blockquote", label: "Quote" } },
];

/** The block format for `textBeforeCaret` when it is exactly a Markdown block
 * marker followed by the space just typed (contenteditable often turns that
 * space into a no-break space). */
export function matchBlockAutoformat(textBeforeCaret: string): BlockAutoformat | null {
  if (!/[  ]$/.test(textBeforeCaret)) return null;
  const marker = textBeforeCaret.slice(0, -1);
  return BLOCK_RULES.find((rule) => rule.marker.test(marker))?.format ?? null;
}

/** "---", "***" or "___" alone in a paragraph becomes a divider on Enter. */
export function isDividerMarker(blockText: string) {
  return /^(-{3,}|\*{3,}|_{3,})$/.test(blockText.replace(/ /g, " ").trim());
}

export type InlineAutoformat = {
  /** Offset in the text node where the opening marker starts. */
  start: number;
  /** The text between the markers. */
  content: string;
  kind: "bold" | "italic" | "code" | "strike";
};

const INLINE_RULES: Array<{ pattern: RegExp; kind: InlineAutoformat["kind"] }> = [
  { pattern: /(^|[\s(["'])\*\*([^*\s](?:[^*\n]*[^*\s])?)\*\*$/, kind: "bold" },
  { pattern: /(^|[\s(["'])__([^_\s](?:[^_\n]*[^_\s])?)__$/, kind: "bold" },
  { pattern: /(^|[\s(["'])\*([^*\s](?:[^*\n]*[^*\s])?)\*$/, kind: "italic" },
  { pattern: /(^|[\s(["'])_([^_\s](?:[^_\n]*[^_\s])?)_$/, kind: "italic" },
  { pattern: /(^|[\s(["'])~~([^~\s](?:[^~\n]*[^~\s])?)~~$/, kind: "strike" },
  { pattern: /(^|[\s(["'])`([^`\n]+)`$/, kind: "code" },
];

/** Matches a closed inline Markdown span ending exactly at the caret. */
export function matchInlineAutoformat(textBeforeCaret: string): InlineAutoformat | null {
  for (const rule of INLINE_RULES) {
    const match = rule.pattern.exec(textBeforeCaret);
    if (!match) continue;
    return {
      start: match.index + match[1].length,
      content: match[2],
      kind: rule.kind,
    };
  }
  return null;
}
