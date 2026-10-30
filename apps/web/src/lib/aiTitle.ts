import { splitAssistantThinking } from "./assistantThinking";

/* A model can ignore "no markdown" and answer "## Engagement summary" or
 * "**Title:** NDA checklist". Names are shown as plain text everywhere, so
 * the syntax is removed rather than displayed. Mirrors the API's chat-title
 * cleaner (routes/chat.py _clean_ai_title). */
const BLOCK_MARKER = /^(?:#{1,6}(?:\s+|$)|>\s*|[-*+](?:\s+|$)|\d+[.)](?:\s+|$))/;
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const PAIRED_MARK = /(\*\*|__|~~|`)(\S(?:.*?\S)?)\1/g;
const SINGLE_MARK = /(?<![\w*])([*_])(\S(?:.*?\S)?)\1(?![\w*])/g;
const LABEL = /^(?:chat\s+)?(?:title|name)\s*:\s*/i;
const QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g;
const QUOTES_AND_TICKS = /^["'“”‘’`]+|["'“”‘’`]+$/g;

function stripMarkdown(line: string): string {
  let title = line;
  for (let previous = ""; previous !== title; ) {
    previous = title;
    title = title.replace(BLOCK_MARKER, "").trim();
  }
  return title.replace(LINK, "$1").replace(PAIRED_MARK, "$2").replace(SINGLE_MARK, "$2").replace(LABEL, "");
}

function cleanLine(line: string): string {
  return stripMarkdown(line.trim().replace(QUOTES, ""))
    .replace(QUOTES_AND_TICKS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.。;:,!]+$/, "");
}

/** The first line of a model's naming reply that still has words once its
 * markdown is gone (a bare "##" line is skipped), as a plain-text title. */
export function cleanAiTitle(raw: string): string {
  const { visibleContent } = splitAssistantThinking(raw);
  const [title = ""] = visibleContent.split("\n").map(cleanLine).filter(Boolean);
  return title.slice(0, 160).trim();
}
