import type { ChatCitation } from "./types";

/** What a citation may suggest once the server has answered. `PUT
 * /api/chat/threads/{id}` stores citations unsanitized, so neither is trusted:
 * `passage` only ever selects text inside the server's own excerpt, `pageHint`
 * only positions a document the server already allowed, and neither is sent. */
export type OpeningHints = { passage?: string | null; pageHint?: number | null };

/** What the viewer needs to open a document. The ids go to the server, which
 * authorizes each one on its own. */
export type DocumentRequest = OpeningHints &
  ({ kind: "document"; configId: string; documentId: string; chunkId: string | null } | { kind: "chunk"; chunkId: string });

export type CitationDestination =
  | { kind: "viewer"; request: DocumentRequest }
  | { kind: "link"; href: string; host: string }
  | { kind: "none" };

/** Live-site passages are fetched per question and never stored. */
const LIVE_CHUNK_PREFIX = "live-";

function storedId(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** The host of an http(s) address; null for every other scheme. */
export function citationWebHost(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function citationLink(citation: ChatCitation): CitationDestination {
  const host = citationWebHost(citation.source_uri);
  return host ? { kind: "link", href: citation.source_uri, host } : { kind: "none" };
}

function openingHints(citation: ChatCitation): Required<OpeningHints> {
  const page = citation.page_start;
  return {
    passage: storedId(citation.passage),
    pageHint: typeof page === "number" && Number.isInteger(page) && page >= 1 ? page : null,
  };
}

function viewerRequest(citation: ChatCitation): DocumentRequest | null {
  const chunkId = storedId(citation.chunk_id);
  if (chunkId?.startsWith(LIVE_CHUNK_PREFIX)) return null;
  const configId = storedId(citation.knowledge_config_id);
  const documentId = storedId(citation.document_id);
  if (configId && documentId) return { kind: "document", configId, documentId, chunkId, ...openingHints(citation) };
  // An old citation from a crawled page has no ids to look up, but it does
  // have the page itself, which is what it has always opened.
  return chunkId && citation.source_type !== "web" ? { kind: "chunk", chunkId, ...openingHints(citation) } : null;
}

/** Where activating a citation goes. */
export function citationDestination(citation: ChatCitation): CitationDestination {
  const request = viewerRequest(citation);
  return request ? { kind: "viewer", request } : citationLink(citation);
}

/** `Page 40`, `Pages 40–42`, `Slide 3`, or `Sheet: Q3`, built only from what
 * the citation reports. Null when it reports no position. */
export function citationLocationLabel(citation: ChatCitation): string | null {
  const start = citation.page_start ?? citation.page_end ?? null;
  const end = citation.page_end ?? start;
  if (start !== null && end !== start) return `Pages ${start}–${end}`;
  if (citation.locator) return citation.locator;
  return start !== null ? `Page ${start}` : null;
}

// -------------------------------------------------------------- reply markers

export type MarkerLetter = "K" | "W" | "U";

/** One number or range in a bracket. A range stays as bounds, so a hallucinated
 * `[K1-K999999]` costs nothing. */
export type MarkerEntry = { letter: MarkerLetter; first: number; last: number };

/** What a bracket means for one reply: the citations it reaches, and the
 * entries whose letter this reply never used, which stay as written. An entry
 * in neither list named a number that does not exist. */
export type BracketPlan = {
  matched: Array<{ label: string; citation: ChatCitation }>;
  foreign: MarkerEntry[];
};

// The same grammar as services/api/app/core/citation_use.py, proved against it
// by tests/fixtures/citation_marker_forms.json. The whole bracket must read as
// markers, plus an optional page, slide, or file name, so "[W2 form
// instructions]" stays prose. Case-insensitive words are spelled out: inline
// regex flags would throw at load on browsers that lack them.
const anyCase = (word: string) =>
  word.replace(/\\.|[a-z]/g, (part) => (part.length > 1 ? part : `[${part}${part.toUpperCase()}]`));

const LABEL = "[KWUＫＷＵКΚ]";
const RANGE_JOIN = String.raw`(?:\s*[-–—〜～]\s*|\s+to\s+)`;
const ENTRY = String.raw`${LABEL}\s*\d{1,6}(?:${RANGE_JOIN}(?:${LABEL}\s*)?\d{1,6})?`;
const WORD_JOIN = "(?:and|y|et|und|и)";
const SEPARATOR = String.raw`(?:\s*[,;/&，；、،]\s*(?:${WORD_JOIN}\s+)?|\s+${WORD_JOIN}\s+|\s*和\s*|\s+)`;
const PREFIX = String.raw`(?:(?:${anyCase("sources?")}|${anyCase(String.raw`refs?\.?`)}|${anyCase("references?")})(?:\s*:\s*|\s+))?`;
const BODY = String.raw`[^\[\]［］【】\n]`;
// A page word needs its page or sheet after it, so "[K1 sheet]" stays prose.
const PAGE_WORD = [
  anyCase(String.raw`pp?\.`),
  anyCase(String.raw`pg\.`),
  anyCase(String.raw`s\.`),
  String.raw`${anyCase("pages?")}\b`,
  String.raw`${anyCase("slides?")}\b`,
  String.raw`${anyCase("sheets?")}\b`,
  String.raw`${anyCase("seiten?")}\b`,
  String.raw`${anyCase("p")}[áaÁA]${anyCase("ginas?")}\b`,
].join("|");
const PAGE = String.raw`(?:(?:${PAGE_WORD})\s*(?::\s*)?(?=[\dA-ZÀ-ÖØ-ÞА-Я])|第)${BODY}{0,60}`;
const FILE_TYPE = ["pdf", "docx?", "pptx?", "xlsx?", "csv", "txt", "md", "rtf", "odt", "html?"].map(anyCase).join("|");
const FILE_NAME = String.raw`${BODY}{1,80}?\.(?:${FILE_TYPE})\b${BODY}{0,60}`;
const PUNCTUATED = String.raw`\s*[,;:]\s*|\s*[(（]\s*`;
// A file name needs punctuation before it, so "[K1 statement.pdf]" stays prose.
const LOCATOR = String.raw`(?:(?:${PUNCTUATED}|\s*[-–—]\s*|\s+)${PAGE}|(?:${PUNCTUATED})${FILE_NAME})?`;
const MARKER_BRACKET = new RegExp(
  String.raw`^\\?[\[［【]\^?\s*${PREFIX}(${ENTRY}(?:${SEPARATOR}${ENTRY})*)${LOCATOR}\s*(?:[.,;]\s*)?\\?[\]］】]$`,
);
const MARKER_ENTRY = new RegExp(String.raw`([KWU])\s*(\d+)(?:${RANGE_JOIN}(?:\1\s*)?(\d+))?`, "g");
const FOLDED_LABELS: Record<string, MarkerLetter> = { Ｋ: "K", К: "K", Κ: "K", Ｗ: "W", Ｕ: "U" };

const INDEX_FIELD = { K: "k_index", W: "w_index", U: "u_index" } as const;

/** The entries in one whole bracket, delimiters included. None when it is prose. */
export function parseMarkerBracket(bracket: string): MarkerEntry[] {
  const entries = MARKER_BRACKET.exec(bracket)?.[1] ?? "";
  const folded = entries.replace(/[ＫКΚＷＵ]/g, (label) => FOLDED_LABELS[label]);
  return Array.from(folded.matchAll(MARKER_ENTRY), (match) => {
    const first = Number(match[2]);
    const last = Number(match[3] ?? match[2]);
    return { letter: match[1] as MarkerLetter, first: Math.min(first, last), last: Math.max(first, last) };
  });
}

export function markerEntryLabel({ letter, first, last }: MarkerEntry): string {
  return first === last ? `${letter}${first}` : `${letter}${first}–${letter}${last}`;
}

function citationIndex(citation: ChatCitation, letter: MarkerLetter): number | null {
  return citation[INDEX_FIELD[letter]] ?? null;
}

/** Sorts a bracket's entries against one reply's own citations. */
export function planMarkerBracket(entries: readonly MarkerEntry[], citations: readonly ChatCitation[]): BracketPlan {
  const plan: BracketPlan = { matched: [], foreign: [] };
  for (const entry of entries) {
    const { letter, first, last } = entry;
    const numbered = citations
      .map((citation) => ({ citation, index: citationIndex(citation, letter) }))
      .filter((item): item is { citation: ChatCitation; index: number } => item.index !== null);
    if (numbered.length === 0) {
      plan.foreign.push(entry);
      continue;
    }
    const reached = numbered.filter(({ index }) => index >= first && index <= last).sort((a, b) => a.index - b.index);
    plan.matched.push(...reached.map(({ citation, index }) => ({ label: `${letter}${index}`, citation })));
  }
  // `[K1, K1-K2]` names K1 twice and gets one key for it.
  plan.matched = [...new Map(plan.matched.map((item) => [item.label, item])).values()];
  return plan;
}
