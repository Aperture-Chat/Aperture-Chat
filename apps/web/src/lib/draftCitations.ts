import type { ChatCitation } from "./types";

/** Builds the written-out "## Sources" section when a chat reply transfers to
 * Drafts. Prefers the reply's citation metadata; replies that cite inline
 * (markdown links in the body) get their distinct linked sources extracted so
 * the document still carries real written-out citations — source names and
 * full URLs — instead of bare numbered markers. */
export function appendChatCitationsForDraft(content: string, citations: ChatCitation[] = []) {
  const body = plainDraftCitations(content, citations);
  const trimmed = body.trim();
  // A web result the reply only consulted is not one of the draft's sources.
  const sources = citations.filter((citation) => citation.cited !== false);
  const entries = sources.length
    ? sources.map((citation, index) => {
        const label = citation.source_name || citation.source_uri || `Source ${index + 1}`;
        const location = citation.source_uri
          ? ` **${label}** — [${citation.source_uri}](${citation.source_uri})`
          : ` ${label}`;
        const snippet = citation.snippet ? ` — ${citation.snippet}` : "";
        return `${index + 1}.${location}${snippet}`;
      })
    : inlineSourceEntries(trimmed);
  if (!entries.length) return body;
  return `${trimmed}\n\n## Sources\n${entries.join("\n")}`;
}

/** Distinct linked sources from the reply body, in first-appearance order.
 * Images are figures, not citations, so ![alt](url) links are skipped. */
function inlineSourceEntries(markdown: string) {
  const seen = new Set<string>();
  const entries: string[] = [];
  const linkPattern = /(!?)\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(markdown)) !== null) {
    if (match[1] === "!") continue;
    const url = match[3];
    if (seen.has(url)) continue;
    seen.add(url);
    const label = match[2].trim() || url;
    entries.push(`${entries.length + 1}. **${label}** — [${url}](${url})`);
  }
  return entries;
}

/** Chat shows a source behind a [K#] marker, which means nothing in a document. A
 * draft keeps a plain citation instead: it reads the way attorneys cite, it exports
 * and prints as ordinary text, and a later revision cannot renumber it. */

/** One bracket, or brackets side by side: [K1], [K1, K2], [K1-K3], [K1,2], [K1][K2]. */
const MARKER_GROUP = /([ \t]*)(\[K\d+(?:\s*[,;–—-]\s*K?\d+)*\](?:[ \t]*\[K\d+(?:\s*[,;–—-]\s*K?\d+)*\])*)/g;
const MARKER = /\[K(\d+)((?:\s*[,;–—-]\s*K?\d+)*)\]/g;
const PART = /([,;–—-])\s*K?(\d+)/g;
const LONGEST_RANGE = 50;

/** The numbers a group names, in order. A range only says which of the turn's few
 * sources it means, so a stray huge one stops at what could be real. */
function markedNumbers(group: string): number[] {
  const numbers: number[] = [];
  for (const [, first, rest] of group.matchAll(MARKER)) {
    let previous = Number(first);
    numbers.push(previous);
    for (const [, separator, value] of rest.matchAll(PART)) {
      const next = Number(value);
      if (separator === "," || separator === ";") {
        numbers.push(next);
      } else {
        const last = Math.min(next, previous + LONGEST_RANGE);
        for (let number = previous + 1; number <= last; number += 1) numbers.push(number);
      }
      previous = next;
    }
  }
  return numbers;
}

function citedPages(citation: ChatCitation) {
  const { page_start: start, page_end: end } = citation;
  if (!start) return "";
  return end && end !== start ? `, pp. ${start}-${end}` : `, p. ${start}`;
}

/** Quotes and backslashes go, so the name is safe inside a deck's or workbook's JSON. */
function citedName(citation: ChatCitation) {
  return citation.source_name
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[_"\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function plainDraftCitations(text: string, citations: readonly ChatCitation[]): string {
  const byMarker = new Map(citations.filter((citation) => citation.k_index).map((citation) => [citation.k_index, citation]));
  return text.replace(MARKER_GROUP, (_whole, space: string, group: string) => {
    const named = markedNumbers(group).flatMap((number) => {
      const citation = byMarker.get(number);
      return citation ? [`${citedName(citation)}${citedPages(citation)}`] : [];
    });
    return named.length ? `${space}(${[...new Set(named)].join("; ")})` : "";
  });
}
