/**
 * Catalog and prompt helpers for the Drafts AI edit composer.
 *
 * The composer offers one-click actions (improve, shorten, tone, translate…)
 * alongside a free-form instruction. Every action is only an instruction
 * string: the request, review, and apply flow is the same whichever one the
 * writer picks, so a preset never behaves differently from typing it.
 */

export type AiEditActionGroup = "improve" | "transform" | "write" | "slide";

export type AiEditAction = {
  id: string;
  label: string;
  group: AiEditActionGroup;
  instruction: string;
  /** Extra words the filter matches, so "grammar" finds "Fix spelling". */
  keywords?: string;
};

export type AiEditChip = { id: string; label: string; instruction: string };

export type AiEditChipGroup = { id: string; label: string; chips: AiEditChip[] };

export const AI_EDIT_GROUP_LABELS: Record<AiEditActionGroup, string> = {
  improve: "Edit",
  transform: "Transform",
  write: "Write at cursor",
  slide: "This slide",
};

/** Actions for highlighted document text. */
export const DOCUMENT_SELECTION_ACTIONS: AiEditAction[] = [
  {
    id: "improve",
    label: "Improve writing",
    group: "improve",
    keywords: "better clearer polish",
    instruction:
      "Improve the writing: make it clearer, more fluent, and more precise. Keep the meaning, every fact, and roughly the same length.",
  },
  {
    id: "grammar",
    label: "Fix spelling & grammar",
    group: "improve",
    keywords: "typo proofread punctuation",
    instruction:
      "Fix spelling, grammar, and punctuation only. Keep the wording, tone, and formatting otherwise unchanged.",
  },
  {
    id: "shorter",
    label: "Make shorter",
    group: "improve",
    keywords: "shorten concise tighten trim",
    instruction:
      "Make it noticeably shorter and tighter, about half the length, without losing any key fact.",
  },
  {
    id: "longer",
    label: "Make longer",
    group: "improve",
    keywords: "expand elaborate detail",
    instruction:
      "Expand it with useful detail, explanation, or examples, about twice the length, in the same voice. Do not invent facts, figures, names, or dates.",
  },
  {
    id: "simplify",
    label: "Simplify language",
    group: "improve",
    keywords: "plain simple easy readable",
    instruction:
      "Rewrite it in plain language a general reader understands on the first read: short sentences, everyday words, no jargon.",
  },
  {
    id: "bullets",
    label: "Turn into a bulleted list",
    group: "transform",
    keywords: "list points",
    instruction: "Turn it into a concise bulleted list of its key points.",
  },
  {
    id: "table",
    label: "Turn into a table",
    group: "transform",
    keywords: "grid columns rows",
    instruction:
      "Organize the information as a table with a header row. Keep every fact and do not add new ones.",
  },
  {
    id: "summarize",
    label: "Summarize",
    group: "transform",
    keywords: "summary tldr gist",
    instruction: "Replace it with a short summary of its key points, in one or two sentences.",
  },
  {
    id: "active",
    label: "Use active voice",
    group: "transform",
    keywords: "passive direct",
    instruction: "Rewrite passive constructions in the active voice. Keep the meaning and facts.",
  },
];

/** Actions for a collapsed caret: the reply is new text inserted there. */
export const DOCUMENT_WRITE_ACTIONS: AiEditAction[] = [
  {
    id: "continue",
    label: "Continue writing",
    group: "write",
    keywords: "next more keep going",
    instruction:
      "Continue writing from the cursor in the same voice and style. Write the next one to three paragraphs that naturally follow the text before the cursor.",
  },
  {
    id: "summary",
    label: "Summarize the document",
    group: "write",
    keywords: "summary executive",
    instruction:
      "Write a concise summary (three to five sentences) of the document's content, to insert at the cursor.",
  },
  {
    id: "actions",
    label: "List action items",
    group: "write",
    keywords: "todo tasks next steps",
    instruction:
      "Extract the action items and next steps the document implies, as a bulleted list. Only include items the document supports.",
  },
  {
    id: "conclusion",
    label: "Write a conclusion",
    group: "write",
    keywords: "ending wrap up close",
    instruction: "Write a short concluding paragraph that ties the document together.",
  },
  {
    id: "brainstorm",
    label: "Brainstorm ideas",
    group: "write",
    keywords: "ideas list options",
    instruction:
      "Brainstorm five to eight ideas relevant to the surrounding section, as a bulleted list with a short phrase each.",
  },
  {
    id: "outline",
    label: "Draft an outline",
    group: "write",
    keywords: "structure sections headings",
    instruction:
      "Draft an outline for the rest of this document as headings with one-line descriptions, using real heading and list elements.",
  },
];

export const AI_TONE_CHIPS: AiEditChip[] = [
  "Professional",
  "Friendly",
  "Confident",
  "Direct",
  "Persuasive",
  "Empathetic",
].map((tone) => ({
  id: `tone-${tone.toLowerCase()}`,
  label: tone,
  instruction: `Rewrite it in a ${tone.toLowerCase()} tone. Keep the meaning, the facts, and roughly the same length.`,
}));

export const AI_TRANSLATE_CHIPS: AiEditChip[] = [
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Chinese (Simplified)",
  "Japanese",
  "Korean",
  "Arabic",
  "Hindi",
].map((language) => ({
  id: `translate-${language.toLowerCase().replace(/[^a-z]+/g, "-")}`,
  label: language,
  instruction: `Translate it into ${language}. Keep the formatting, names, and numbers unchanged.`,
}));

export const DOCUMENT_SELECTION_CHIP_GROUPS: AiEditChipGroup[] = [
  { id: "tone", label: "Tone", chips: AI_TONE_CHIPS },
  { id: "translate", label: "Translate", chips: AI_TRANSLATE_CHIPS },
];

/** Whole-slide actions. The reply is structured slide JSON, so these can
 * change the layout, the notes, or split one slide into two. */
export const SLIDE_ACTIONS: AiEditAction[] = [
  {
    id: "slide-improve",
    label: "Improve this slide",
    group: "slide",
    keywords: "better polish clearer",
    instruction:
      "Improve this slide: a sharper title, tighter parallel bullets, and clearer wording. Keep every fact.",
  },
  {
    id: "slide-punchier",
    label: "Make it punchier",
    group: "slide",
    keywords: "bold impact energy",
    instruction:
      "Make this slide punchier: a bold, specific title and short, high-impact bullets that start with strong verbs.",
  },
  {
    id: "slide-shorter",
    label: "Cut the text in half",
    group: "slide",
    keywords: "shorten concise less text",
    instruction:
      "Cut the on-slide text roughly in half. Keep the essential points and move any detail that matters into the speaker notes.",
  },
  {
    id: "slide-notes",
    label: "Write speaker notes",
    group: "slide",
    keywords: "notes script talk track",
    instruction:
      "Write natural speaker notes for this slide (80 to 150 words) that expand on the on-slide text. Leave the on-slide text unchanged.",
  },
  {
    id: "slide-layout",
    label: "Pick a better layout",
    group: "slide",
    keywords: "design layout redesign",
    instruction:
      "Choose the layout that presents this content best (for example two columns for a comparison, a quote for a key statement) and restructure the content to fit it.",
  },
  {
    id: "slide-split",
    label: "Split into two slides",
    group: "slide",
    keywords: "divide break up too much",
    instruction:
      "This slide holds too much. Split it into two focused slides that together keep all of the content.",
  },
  {
    id: "slide-grammar",
    label: "Fix spelling & grammar",
    group: "slide",
    keywords: "typo proofread",
    instruction:
      "Fix spelling, grammar, and punctuation on this slide and in its notes. Change nothing else.",
  },
];

export const SLIDE_CHIP_GROUPS: AiEditChipGroup[] = [
  { id: "tone", label: "Tone", chips: AI_TONE_CHIPS },
  {
    id: "translate",
    label: "Translate",
    chips: AI_TRANSLATE_CHIPS.map((chip) => ({
      ...chip,
      instruction: `${chip.instruction.replace("it into", "the slide text and the speaker notes into")}`,
    })),
  },
];

/** Case-insensitive match across label, keywords, and group name. */
export function aiActionMatches(
  item: { label: string; keywords?: string },
  query: string,
  groupLabel = "",
) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${item.label} ${item.keywords ?? ""} ${groupLabel}`.toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

/** Text immediately before and after a range inside `root`, trimmed to word
 * boundaries, so the model sees the surrounding sentences it must fit. */
export function textAroundRange(
  root: HTMLElement,
  range: Range,
  { before = 1500, after = 600 }: { before?: number; after?: number } = {},
) {
  try {
    const head = document.createRange();
    head.selectNodeContents(root);
    head.setEnd(range.startContainer, range.startOffset);
    const tail = document.createRange();
    tail.selectNodeContents(root);
    tail.setStart(range.endContainer, range.endOffset);
    const clip = (value: string, limit: number, fromEnd: boolean) => {
      const clean = value.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (clean.length <= limit) return clean;
      const cut = fromEnd ? clean.slice(clean.length - limit) : clean.slice(0, limit);
      return fromEnd ? `…${cut.replace(/^\S*\s/, "")}` : `${cut.replace(/\s\S*$/, "")}…`;
    };
    return {
      before: clip(blockAwareText(head), before, true),
      after: clip(blockAwareText(tail), after, false),
    };
  } catch {
    return { before: "", after: "" };
  }
}

const BLOCK_TAGS = /^(P|H[1-6]|LI|BLOCKQUOTE|PRE|TR|DIV|SECTION|FIGURE|TABLE|UL|OL)$/;

/** Range text with paragraph breaks kept, since `Range.toString()` runs
 * adjacent paragraphs together into one line. */
function blockAwareText(range: Range) {
  const holder = document.createElement("div");
  holder.appendChild(range.cloneContents());
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      parts.push("\n");
      return;
    }
    const block = BLOCK_TAGS.test(node.tagName);
    if (block) parts.push("\n");
    node.childNodes.forEach(walk);
    if (block) parts.push("\n");
  };
  holder.childNodes.forEach(walk);
  return parts.join("").replace(/\n\s*\n+/g, "\n\n");
}

/** Prompt for writing new content at a collapsed caret. */
export function aiWriteAtCursorPrompt({
  documentTitle,
  instruction,
  before,
  after,
  structureHint,
  formatRules,
}: {
  documentTitle: string;
  instruction: string;
  before: string;
  after: string;
  structureHint: string;
  formatRules: string;
}) {
  return [
    `You are writing new content inside the draft titled "${documentTitle}".`,
    "Write only the new content to insert at the cursor. Do not repeat text that is already in the document, and do not add labels, quotes, or explanations.",
    "Match the document's voice, terminology, and formatting conventions. Do not invent facts, figures, names, or dates the document does not support.",
    "",
    formatRules,
    "",
    "User instruction:",
    instruction,
    "",
    "Where the cursor sits:",
    structureHint,
    "",
    "Document text before the cursor:",
    before || "(the cursor is at the start of the document)",
    "",
    "Document text after the cursor:",
    after || "(the cursor is at the end of the document)",
  ].join("\n");
}

/** Follow-up turn when the writer refines a suggestion they are reviewing. */
export function aiRefineMessage(instruction: string) {
  return [
    "Revise your last reply according to this follow-up instruction:",
    instruction,
    "",
    "Return only the full revised replacement, in the same format rules as before. No labels or explanations.",
    "Keep the original passage's formatting unless this follow-up asks to change it.",
  ].join("\n");
}

/** What an instruction asks of a passage beyond its words. An edit keeps the
 * passage's formatting unless the writer asked for a different look or shape,
 * so "fill in the blanks" never needs "and don't change the formatting". */
export type AiEditIntent = {
  /** A different look: bold, fonts, colors, alignment, links. */
  restyle: boolean;
  /** A different shape: a list, a table, headings, more paragraphs. */
  restructure: boolean;
  /** Fill in blanks or placeholders. */
  fillBlanks: boolean;
  /** Invent sample values rather than use real ones. */
  sampleData: boolean;
};

export const NO_AI_EDIT_INTENT: AiEditIntent = {
  restyle: false,
  restructure: false,
  fillBlanks: false,
  sampleData: false,
};

/** "Keep the formatting", "don't change the style": asks for preservation,
 * so the words in it must not read as a formatting request. */
const KEEP_FORMAT_PHRASES = [
  /\b(?:keep|keeping|preserve|preserving|maintain|maintaining|retain|retaining|leave|leaving|respect|match|matching|same)\b[^.;!?\n]{0,40}?\b(?:format(?:ting|s)?|styles?|styling|fonts?|layout|structure|markup|look)\b/gi,
  /\b(?:don'?t|do not|never|without|no|not)\b[^.;!?\n]{0,40}?\b(?:format(?:ting|s)?|styles?|styling|fonts?|layout|structure|markup)\b/gi,
];

const RESTYLE_PATTERNS = [
  /\b(?:bold(?:ed|en|er)?|un-?bold|embolden|italic(?:s|i[sz]e[sd]?)?|underlin(?:e|ed|es|ing)|strike[- ]?through|strike (?:it|them|out)|highlight(?:s|ing)?|colou?r(?:s|ed)?|fonts?|typeface|font[- ]size|text size|re-?format\w*|restyle\w*|format(?:ting)?|align\w*|justif(?:y|ied)|indent\w*|superscript|subscript|small caps|hyperlink\w*)\b/i,
  /\bcent(?:er|re)(?:ed|ing)?\s+(?:it|this|them|the|align\w*)\b/i,
  /\b(?:add|insert|include|remove)\s+(?:a\s+|the\s+)?links?\b/i,
];

const RESTRUCTURE_PATTERNS = [
  /\b(?:turn|convert|make|change|rewrite|break|split|put|lay|organi[sz]e|restructure|present|format)\b[^.;!?\n]{0,30}?\b(?:into|as|in|to)\b[^.;!?\n]{0,30}?\b(?:lists?|bullet(?:s|ed)?|bullet points|numbered|checklist|tables?|columns?|headings?|sections|paragraphs|outline|steps|rows)\b/i,
  /\b(?:add|insert|create|include|use)\b[^.;!?\n]{0,20}?\b(?:bullets?|bullet points|bulleted list|numbered list|table|headings?|subheadings?|columns?|line breaks?)\b/i,
  /\b(?:split|merge|combine|separate|break up|restructure|reorgani[sz]e)\b/i,
  /\b(?:one|two|three|four|five|six|\d+)\s+(?:bullets?|paragraphs|sections|columns|rows|items|steps)\b/i,
  /\bsignature block\b/i,
];

const FILL_PATTERNS = [
  /\b(?:fill(?:s|ed|ing)?|complete|populate|plug)\b[^.;!?\n]{0,40}?\b(?:in|out|blanks?|lines?|fields?|placeholders?|gaps?|spaces?|form|template|details)\b/i,
  /\b(?:blanks?|placeholders?|fill-ins?)\b/i,
];

const SAMPLE_PATTERNS = [
  /\b(?:fake|dummy|sample|example|mock|fictional|fictitious|made[- ]up|placeholder|test|realistic|random)\s+(?:data|values?|details|info(?:rmation)?|names?|text|entries|content|numbers?|figures?)\b/i,
  /\bmake (?:something|things|it|them|names?|values?) up\b/i,
  /\binvent\b/i,
];

export function aiEditIntent(instruction: string): AiEditIntent {
  const asked = KEEP_FORMAT_PHRASES.reduce((text, phrase) => text.replace(phrase, " "), instruction);
  const any = (patterns: RegExp[], text: string) => patterns.some((pattern) => pattern.test(text));
  return {
    restyle: any(RESTYLE_PATTERNS, asked),
    restructure: any(RESTRUCTURE_PATTERNS, asked),
    fillBlanks: any(FILL_PATTERNS, instruction),
    sampleData: any(SAMPLE_PATTERNS, instruction),
  };
}

/** A refinement adds to what the edit already asked for. */
export function mergeAiEditIntent(left: AiEditIntent, right: AiEditIntent): AiEditIntent {
  return {
    restyle: left.restyle || right.restyle,
    restructure: left.restructure || right.restructure,
    fillBlanks: left.fillBlanks || right.fillBlanks,
    sampleData: left.sampleData || right.sampleData,
  };
}

/** True when the edit only changes words, so the highlight's formatting is
 * kept exactly and the reply's words are written into it. */
export function aiEditKeepsFormatting(intent: AiEditIntent) {
  return !intent.restyle && !intent.restructure;
}

/** Underscore blanks, ruled lines, or bracketed placeholders like [Client Name]. */
export function hasFillInBlanks(text: string, html = "") {
  return /_{3,}/.test(text) || /document-(?:blank|signature-line)/.test(html) || /\[[^\]\n]{2,40}\]/.test(text);
}

/** The scope contract for an edit of highlighted text: change what was asked,
 * keep everything else (wording, spacing, and formatting) as it is. */
export function aiEditScopeLines({
  instruction,
  selectedText,
  selectedHtml = "",
}: {
  instruction: string;
  selectedText: string;
  selectedHtml?: string;
}) {
  const intent = aiEditIntent(instruction);
  const lines = [
    "Scope rules:",
    "- Change only what the instruction asks for. Words, numbers, punctuation, capitalization, and spacing it does not mention stay exactly as they are.",
    "- Keep the existing formatting (bold, italics, underline, fonts, sizes, colors, alignment, tab stops, and fill-in blanks) unless the instruction explicitly asks to change it.",
  ];
  if (aiEditKeepsFormatting(intent)) {
    lines.push("- This instruction asks for no formatting or layout change, so the formatting must come back exactly as it is.");
  }
  if (selectedHtml && !intent.restructure) {
    lines.push(
      "- The highlighted passage's markup is shown below. Return that same markup with the requested change made: every tag, class, and inline style stays around the text it already wraps, and only the text inside changes.",
    );
  }
  if (intent.fillBlanks || (intent.sampleData && hasFillInBlanks(selectedText, selectedHtml))) {
    lines.push(
      '- Fill each blank or placeholder (a run of underscores, a <span class="document-blank">, a ruled <span class="document-signature-line">, or a bracketed placeholder such as [Client Name]) with a value that fits the sentence around it. Put the value where the blank was, inside the blank\'s own element, and leave every other character as it is.',
    );
  }
  if (intent.sampleData) {
    lines.push(
      "- Invent realistic but clearly fictional values (names, places, dates, amounts) and keep them consistent: the same party, place, or project has the same name everywhere it appears.",
    );
  }
  return lines;
}

/** Sentence-level context block appended to the highlighted-passage prompt. */
export function aiSelectionContextLines(before: string, after: string) {
  const lines: string[] = [];
  if (before) lines.push("", "Text just before the highlight (context only, do not return it):", before);
  if (after) lines.push("", "Text just after the highlight (context only, do not return it):", after);
  return lines;
}

/** Word counts for the review summary line. */
export function wordTotal(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
