/**
 * Proofreading checks for a Drafts document, the kind a careful reader runs
 * before a contract or memo goes out: blanks and placeholders still in the
 * text, defined terms that are unused, undefined, or defined twice,
 * cross-references that point nowhere, and numbering that skips or repeats.
 *
 * Nothing here calls a model. Every finding is read straight from the words
 * on the page, so the same document always gives the same report and nothing
 * can be invented. The checks err toward silence: each one runs only when the
 * document shows the convention it checks (numbered sections, quoted
 * definitions, labelled exhibits), because a wrong flag costs a reader's trust.
 *
 * Glossary:
 * - block: one paragraph, heading, list item, or table cell, in page order.
 * - finding: one thing worth a look, tied to the block it was found in.
 * - definition site: the place a term is defined, e.g. (the “Company”).
 * - section id: a section's number as typed, such as 4, 4.2, or IV.
 */

import { documentBlocks } from "./documentBlockEdit";

export type CheckBlock = { text: string; heading: boolean };

/** A block read from the page, with the element to scroll to. */
export type PageBlock = CheckBlock & { element: Element };

export type FindingGroup = "blanks" | "terms" | "references" | "numbering";

export type DocumentFinding = {
  group: FindingGroup;
  /** Index of the block the finding sits in. */
  block: number;
  /** What was found, in the document's own words. */
  title: string;
  /** Why it is worth a look. */
  detail: string;
};

export const FINDING_GROUP_LABELS: Record<FindingGroup, string> = {
  blanks: "Blanks to fill in",
  terms: "Defined terms",
  references: "Cross-references",
  numbering: "Numbering",
};

const GROUP_ORDER: FindingGroup[] = ["blanks", "terms", "references", "numbering"];

/* ------------------------------------------------------------------ */
/* Reading the page                                                    */
/* ------------------------------------------------------------------ */

/** The page's text blocks in reading order, as the editor's block edits see
 * them: page furniture is left out, a blank drawn as a ruled line reads as
 * underscores, and a list item or cell that holds paragraphs is read through
 * them, so no text is read twice. */
export function checkableBlocks(root: Element): PageBlock[] {
  return documentBlocks(root).map(({ element, text }) => ({
    element,
    text,
    heading: /^H[1-6]$/.test(element.tagName),
  }));
}

/* ------------------------------------------------------------------ */
/* Blanks and placeholders                                             */
/* ------------------------------------------------------------------ */

const BRACKETED = /\[([^[\]\n]{1,60})\](?![A-Za-z])/g;
const BLANK_RUN = /_{3,}/g;
/** How many words an excerpt keeps on each side of the first blank. */
const WORDS_BEFORE = 3;
const WORDS_AFTER = 3;

/** Source markers and footnote numbers: [K1], [W2], [12]. */
const MARKER = /^(?:[KWU]\d+(?:\s*[-,]\s*[KWU]?\d+)*|\d+)$/;
const PLACEHOLDER_WORDS = /\b(?:tbd|tbc|insert|to be (?:determined|confirmed|agreed|completed|inserted)|placeholder|fill in|optional|your|xx+)\b/i;
/** Bracketed notes a finished document keeps. */
const KEPT_NOTE = /signature page|intentionally|remainder of/i;
const UNFINISHED_NOTE = /\b(?:TBD|TBC|X{3,})\b|\b(?:[Ll]orem ipsum|to be (?:determined|confirmed|inserted))\b/g;

function isPlaceholder(inner: string): boolean {
  const text = inner.trim();
  if (MARKER.test(text) || KEPT_NOTE.test(text)) return false;
  if (/[●•]/.test(text) || /_{2,}/.test(text) || PLACEHOLDER_WORDS.test(text)) return true;
  return /^[A-Z]/.test(text);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function placeholdersIn(text: string): string[] {
  return unique([...text.matchAll(BRACKETED)].filter((match) => isPlaceholder(match[1])).map((match) => match[0]));
}

/** The words around the first blank, with each blank drawn as four underscores. */
function blankExcerpt(text: string): string {
  const words = text.replace(BLANK_RUN, "____").split(" ");
  const at = words.findIndex((word) => word.includes("____"));
  const kept = words.slice(Math.max(0, at - WORDS_BEFORE), at + WORDS_AFTER + 1).join(" ");
  return `${at > WORDS_BEFORE ? "…" : ""}${kept}${at + WORDS_AFTER + 1 < words.length ? "…" : ""}`;
}

function blankFindings(text: string, block: number): DocumentFinding[] {
  const placeholders = placeholdersIn(text);
  // A blank or note inside a bracketed placeholder is that placeholder, not a second finding.
  const rest = placeholders.reduce((remaining, placeholder) => remaining.split(placeholder).join(" "), text);
  const blanks = [...rest.matchAll(BLANK_RUN)].length;
  const notes = unique(rest.match(UNFINISHED_NOTE) || []);
  return [
    ...(blanks
      ? [{ group: "blanks" as const, block, title: blankExcerpt(rest), detail: `${blanks} ${blanks === 1 ? "blank" : "blanks"} to fill in` }]
      : []),
    ...[...placeholders, ...notes].map((title) => ({
      group: "blanks" as const,
      block,
      title,
      detail: "Placeholder still in the text",
    })),
  ];
}

/* ------------------------------------------------------------------ */
/* Defined terms                                                       */
/* ------------------------------------------------------------------ */

const QUOTED_TERM = /["“]([A-Z][^"“”]{0,60}?)[,.;]?["”]/g;
const PARENTHESIS = /\([^()]{0,200}\)/g;
const MEANS = /["“][A-Z][^"“”]{0,60}?[,.;]?["”]\s+(?:shall\s+)?(?:means?|has the meaning|shall have the meaning|refers to|is defined)\b/g;
const TERM_IN_USE = /\b(?:the|this|such|each|any|said)\s+([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,3})/g;
/** Capitalized words that follow "the" without being defined terms. */
const NOT_A_TERM = new Set([
  "Section", "Article", "Clause", "Paragraph", "Exhibit", "Schedule", "Appendix", "Annex", "Attachment",
  "United", "State", "Commonwealth", "City", "County", "Court", "Internet",
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
]);
/** A document is checked for undefined terms only once it defines this many. */
const MIN_DEFINITIONS = 2;

type DefinitionSite = { term: string; block: number; quoted: string };

function quotedTerms(text: string): Array<{ term: string; quoted: string }> {
  return [...text.matchAll(QUOTED_TERM)].map((match) => ({ term: match[1].trim(), quoted: match[0] }));
}

function definitionsIn(text: string, block: number): DefinitionSite[] {
  const defining = [...(text.match(PARENTHESIS) || []), ...(text.match(MEANS) || [])];
  return defining.flatMap(quotedTerms).map((site) => ({ ...site, block }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUsed(term: string, texts: string[]): boolean {
  const pattern = new RegExp(`(?<![A-Za-z])${escapeRegExp(term)}(?![A-Za-z])`);
  return texts.some((text) => pattern.test(text));
}

function termFinding(term: string, block: number, detail: string): DocumentFinding {
  return { group: "terms", block, title: `“${term}”`, detail };
}

function definedTermFindings(sites: DefinitionSite[], texts: string[]): DocumentFinding[] {
  const first = new Map<string, DefinitionSite>();
  const findings: DocumentFinding[] = [];
  for (const site of sites) {
    if (!first.has(site.term)) {
      first.set(site.term, site);
      if (!isUsed(site.term, texts)) findings.push(termFinding(site.term, site.block, "Defined here, but not used anywhere else"));
    } else if (first.get(site.term)!.block !== site.block) {
      findings.push(termFinding(site.term, site.block, "Defined more than once"));
    }
  }
  return findings;
}

function undefinedTermFindings(blocks: CheckBlock[], defined: Set<string>): DocumentFinding[] {
  const uses = new Map<string, { block: number; count: number }>();
  blocks.forEach((block, index) => {
    if (block.heading) return;
    for (const match of block.text.matchAll(TERM_IN_USE)) {
      const term = match[1];
      if (defined.has(term) || NOT_A_TERM.has(term.split(" ")[0])) continue;
      const seen = uses.get(term) || { block: index, count: 0 };
      uses.set(term, { ...seen, count: seen.count + 1 });
    }
  });
  return [...uses]
    .filter(([, use]) => use.count >= 2)
    .map(([term, use]) => termFinding(term, use.block, "Used like a defined term, but no definition was found"));
}

function termFindings(blocks: CheckBlock[]): DocumentFinding[] {
  const sites = blocks.flatMap((block, index) => definitionsIn(block.text, index));
  // A use is the term anywhere except inside the quotes that define it.
  const texts = blocks.map((block, index) =>
    sites.filter((site) => site.block === index).reduce((text, site) => text.split(site.quoted).join(" "), block.text),
  );
  const defined = new Set(sites.map((site) => site.term));
  return [
    ...definedTermFindings(sites, texts),
    ...(defined.size >= MIN_DEFINITIONS ? undefinedTermFindings(blocks, defined) : []),
  ];
}

/* ------------------------------------------------------------------ */
/* Cross-references                                                    */
/* ------------------------------------------------------------------ */

const SECTION_WORDS = "Sections?|Articles?|Clauses?|Paragraphs?";
const ATTACHMENT_WORDS = "Exhibits?|Schedules?|Appendix|Appendices|Annex(?:es)?|Attachments?";
const SECTION_ID = "\\d+(?:\\.\\d+)*|[IVXLC]+\\b";
const SECTION_LABEL = new RegExp(`^(?:(?:${SECTION_WORDS})\\s+)?(${SECTION_ID})`);
const NUMBER_START = /^(\d+(?:\.\d+)*)[.)]?\s/;
// The id must end where the number ends, or "Section 365 of the Code" would be
// read as a reference to section 36.
const SECTION_REFERENCE = new RegExp(`\\b(${SECTION_WORDS})\\s+(${SECTION_ID})(?!\\d|\\.\\d)(?!\\s+of\\s+(?!this\\b))`, "g");
/** A line that names an attachment: "Exhibit A", "EXHIBIT A - Fees", "Schedule 2: Rates". */
const ATTACHMENT_LABEL = new RegExp(`^(${ATTACHMENT_WORDS})\\s+([A-Z]|\\d+)\\b(?=$|\\s*[:.(–—-])`, "i");
/** A heading may run straight on: "Exhibit A Scope of Services". */
const ATTACHMENT_HEADING = new RegExp(`^(${ATTACHMENT_WORDS})\\s+([A-Z]|\\d+)\\b`, "i");
const ATTACHMENT_REFERENCE = new RegExp(`\\b(${ATTACHMENT_WORDS})\\s+([A-Z]|\\d+)\\b`, "g");
/** A document is checked for section references only once it numbers this many sections. */
const MIN_SECTIONS = 3;

const SINGULAR: Record<string, string> = { appendices: "Appendix", annexes: "Annex" };

/** "Exhibits", "EXHIBIT", and "exhibit" all name an Exhibit. */
function singular(word: string): string {
  const lower = word.toLowerCase();
  return SINGULAR[lower] || `${lower[0].toUpperCase()}${lower.slice(1).replace(/s$/, "")}`;
}

function depth(id: string): number {
  return id.split(".").length;
}

/** The section number a block opens with: "4.2 Fees", "Section 4", "Article IV". */
function sectionId(block: CheckBlock): string | undefined {
  const opening = new RegExp(`^(?:${SECTION_WORDS})\\s`).test(block.text) ? SECTION_LABEL : NUMBER_START;
  return opening.exec(block.text)?.[1];
}

function attachmentLabels(blocks: CheckBlock[]): Map<string, Set<string>> {
  const labels = new Map<string, Set<string>>();
  for (const block of blocks) {
    const match = (block.heading ? ATTACHMENT_HEADING : ATTACHMENT_LABEL).exec(block.text);
    if (!match) continue;
    const kind = singular(match[1]);
    const known = labels.get(kind);
    if (known) known.add(match[2]);
    else labels.set(kind, new Set([match[2]]));
  }
  return labels;
}

function missingSections(text: string, ids: Set<string>, deepest: number): string[] {
  return [...text.matchAll(SECTION_REFERENCE)]
    .filter((match) => depth(match[2]) <= deepest && !ids.has(match[2]))
    .map((match) => `${singular(match[1])} ${match[2]}`);
}

/** References to an attachment the document does not hold. A kind is checked
 * only when the document has attachments of that kind; otherwise they are
 * taken to be separate documents. */
function missingAttachments(text: string, labels: Map<string, Set<string>>): Array<[title: string, kind: string]> {
  return [...text.matchAll(ATTACHMENT_REFERENCE)]
    .map((match) => [singular(match[1]), match[2]] as const)
    .filter(([kind, id]) => labels.has(kind) && !labels.get(kind)!.has(id))
    .map(([kind, id]) => [`${kind} ${id}`, kind.toLowerCase()]);
}

function referenceFindings(blocks: CheckBlock[]): DocumentFinding[] {
  const ids = new Set(blocks.map(sectionId).filter((id): id is string => id !== undefined));
  const deepest = ids.size >= MIN_SECTIONS ? Math.max(...[...ids].map(depth)) : 0;
  const labels = attachmentLabels(blocks);
  return blocks.flatMap((block, index) => [
    ...unique(missingSections(block.text, ids, deepest)).map((title) => ({
      group: "references" as const,
      block: index,
      title,
      detail: "Referred to here, but no section with that number was found",
    })),
    ...unique(missingAttachments(block.text, labels).map(([title, kind]) => `${title}|${kind}`)).map((entry) => {
      const [title, kind] = entry.split("|");
      return {
        group: "references" as const,
        block: index,
        title,
        detail: `Referred to here, but no ${kind} with that label was found`,
      };
    }),
  ]);
}

/* ------------------------------------------------------------------ */
/* Numbering                                                           */
/* ------------------------------------------------------------------ */

const TOP_NUMBER = /^\d+\.\s/;
/** Fewer typed numbers than this is too short a run to judge. */
const MIN_NUMBERED = 3;

function numberingFinding(previous: number, current: number, block: number): DocumentFinding | null {
  if (current === previous) return { group: "numbering", block, title: `${current}.`, detail: `Number ${current} is used twice in a row` };
  if (current > previous + 1) return { group: "numbering", block, title: `${current}.`, detail: `Numbering jumps from ${previous} to ${current}` };
  return null;
}

function numberingFindings(blocks: CheckBlock[]): DocumentFinding[] {
  const numbered = blocks.flatMap((block, index) => {
    return TOP_NUMBER.test(block.text) ? [{ number: Number.parseInt(block.text, 10), block: index }] : [];
  });
  if (numbered.length < MIN_NUMBERED) return [];
  return numbered.slice(1).flatMap((entry, index) => {
    const finding = numberingFinding(numbered[index].number, entry.number, entry.block);
    return finding ? [finding] : [];
  });
}

/* ------------------------------------------------------------------ */
/* The report                                                          */
/* ------------------------------------------------------------------ */

/** Everything worth a look, grouped in a fixed order and in page order within a group. */
export function checkDocument(blocks: CheckBlock[]): DocumentFinding[] {
  const findings = [
    ...blocks.flatMap((block, index) => blankFindings(block.text, index)),
    ...termFindings(blocks),
    ...referenceFindings(blocks),
    ...numberingFindings(blocks),
  ];
  return GROUP_ORDER.flatMap((group) =>
    findings.filter((finding) => finding.group === group).sort((left, right) => left.block - right.block),
  );
}
