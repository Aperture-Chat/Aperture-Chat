import type { KnowledgeBase, KnowledgeDocument } from "./types";

/** What a composer's symbols do, shared by chat and Drafts so the two cannot
 * drift apart. Nothing here touches React or the page. */

export type ComposerCommandSymbol = "#" | "/" | "$" | "@" | ">";

export type ComposerCommandToken = {
  symbol: ComposerCommandSymbol;
  query: string;
  /** Index of the symbol in the text. */
  start: number;
};

export function detectComposerCommandToken(value: string, caret: number | null): ComposerCommandToken | null {
  if (caret === null) return null;
  const before = value.slice(0, caret);
  const match = /(?:^|\s)([#/$@>])([\w .()&-]{0,60})$/.exec(before);
  if (!match) return null;
  return {
    symbol: match[1] as ComposerCommandSymbol,
    query: match[2],
    start: before.length - match[2].length - 1,
  };
}

/** Sorts command matches so name-prefix hits rank above substring hits. */
export function rankCommandMatches<T>(entries: T[], nameOf: (entry: T) => string, query: string): T[] {
  const q = query.trim().toLowerCase();
  return entries
    .filter((entry) => nameOf(entry).toLowerCase().includes(q))
    .sort((a, b) => {
      const aPrefix = nameOf(a).toLowerCase().startsWith(q) ? 0 : 1;
      const bPrefix = nameOf(b).toLowerCase().startsWith(q) ? 0 : 1;
      return aPrefix - bPrefix || nameOf(a).localeCompare(nameOf(b));
    });
}

/** Bases named by the query, then the bases holding a file it names, so typing
 * a file's name still shows where it lives. */
export function matchingKnowledgeBases(
  bases: KnowledgeBase[],
  matchingFiles: ReadonlyArray<{ base: KnowledgeBase }>,
  query: string,
) {
  const named = rankCommandMatches(bases, (base) => base.name, query);
  const holding = new Set(matchingFiles.map((entry) => entry.base.id));
  return [...named, ...bases.filter((base) => holding.has(base.id) && !named.includes(base))];
}

export type CommandMenuEntry = { id: string; section: string; name: string; detail: string };

export type KnowledgeCommandItem = CommandMenuEntry &
  ({ kind: "knowledge-base"; base: KnowledgeBase } | { kind: "knowledge-file"; doc: KnowledgeDocument; base: KnowledgeBase });

export function knowledgeCommandItems(
  bases: KnowledgeBase[],
  docsByBase: Record<string, KnowledgeDocument[]>,
  query: string,
): KnowledgeCommandItem[] {
  const files = bases.flatMap((base) => (docsByBase[base.id] ?? []).map((doc) => ({ base, doc })));
  const matchingFiles = rankCommandMatches(files, (entry) => entry.doc.name, query);
  return [
    ...matchingKnowledgeBases(bases, matchingFiles, query).map((base) => ({
      kind: "knowledge-base" as const,
      id: `kb-${base.id}`,
      section: "Knowledge bases",
      name: base.name,
      detail: `${base.document_count} files · ${base.source}`,
      base,
    })),
    ...matchingFiles.map((entry) => ({
      kind: "knowledge-file" as const,
      id: `file-${entry.doc.id}`,
      section: "Files in knowledge sources",
      name: entry.doc.name,
      detail: `In ${entry.base.name}`,
      doc: entry.doc,
      base: entry.base,
    })),
  ];
}

export function groupCommandSections<T extends CommandMenuEntry>(items: T[]) {
  const sections: { title: string; items: T[] }[] = [];
  for (const item of items) {
    const section = sections.find((entry) => entry.title === item.section);
    if (section) section.items.push(item);
    else sections.push({ title: item.section, items: [item] });
  }
  return sections;
}

/** The text and caret after a pick. ``tokenStart`` is null when the pick came from
 * somewhere other than a typed symbol, so there is nothing to take out. */
export function applyCommandText(text: string, tokenStart: number | null, caret: number, replacement: string) {
  const start = tokenStart ?? caret;
  const inserted = tokenStart === null ? setApart(text, start, replacement) : replacement;
  const rest = text.slice(caret);
  const closesGap = tokenStart !== null && !inserted && followsSpace(text, start);
  return {
    // A pick that leaves no text would otherwise leave two spaces behind.
    text: text.slice(0, start) + inserted + (closesGap ? rest.replace(/^\s/, "") : rest),
    caret: start + inserted.length,
  };
}

function followsSpace(text: string, index: number) {
  return index === 0 || /\s/.test(text[index - 1]);
}

/** Text placed at the caret must not touch the word before it. */
function setApart(text: string, start: number, replacement: string) {
  return replacement && !followsSpace(text, start) ? ` ${replacement}` : replacement;
}

export type CommandMenuKeyAction =
  | { type: "move"; index: number }
  | { type: "pick"; index: number }
  /** ``keepKey`` lets the key do its usual job, so the list never traps Tab. */
  | { type: "dismiss"; keepKey: boolean };

export function commandMenuKeyAction(
  event: { key: string; shiftKey: boolean },
  count: number,
  index: number,
): CommandMenuKeyAction | null {
  if (event.key === "Tab") {
    return !event.shiftKey && count === 1 ? { type: "pick", index: 0 } : { type: "dismiss", keepKey: true };
  }
  if (event.key === "Escape") return { type: "dismiss", keepKey: false };
  return count > 0 ? listKeyAction(event, count, index) : null;
}

function listKeyAction(event: { key: string; shiftKey: boolean }, count: number, index: number): CommandMenuKeyAction | null {
  if (event.key === "ArrowDown") return { type: "move", index: Math.min(index + 1, count - 1) };
  if (event.key === "ArrowUp") return { type: "move", index: Math.max(index - 1, 0) };
  return event.key === "Enter" && !event.shiftKey ? { type: "pick", index } : null;
}
