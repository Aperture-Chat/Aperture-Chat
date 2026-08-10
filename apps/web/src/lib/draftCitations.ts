import type { ChatCitation } from "./types";

/** Builds the written-out "## Sources" section when a chat reply transfers to
 * Drafts. Prefers the reply's citation metadata; replies that cite inline
 * (markdown links in the body) get their distinct linked sources extracted so
 * the document still carries real written-out citations — source names and
 * full URLs — instead of bare numbered markers. */
export function appendChatCitationsForDraft(content: string, citations: ChatCitation[] = []) {
  const trimmed = content.trim();
  const entries = citations.length
    ? citations.map((citation, index) => {
        const label = citation.source_name || citation.source_uri || `Source ${index + 1}`;
        const location = citation.source_uri
          ? ` **${label}** — [${citation.source_uri}](${citation.source_uri})`
          : ` ${label}`;
        const snippet = citation.snippet ? ` — ${citation.snippet}` : "";
        return `${index + 1}.${location}${snippet}`;
      })
    : inlineSourceEntries(trimmed);
  if (!entries.length) return content;
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
