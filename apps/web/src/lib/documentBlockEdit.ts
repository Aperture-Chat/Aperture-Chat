/**
 * A change to a whole document, made block by block.
 *
 * The inline AI edit sends a highlight and takes back its replacement, which
 * must match paragraph for paragraph or it replaces everything. Across a whole
 * document that would mean a model reproducing every word of a 40-page agreement
 * perfectly, and one merged paragraph would lose the formatting of all of it.
 * So here each text block has a number, the model names only the blocks it
 * changes, and each one goes through the inline edit's word-level patcher.
 * Anything it does not name is not touched at all, and the size of a reply
 * follows the size of the change, not the size of the document.
 */
import { aiEditScopeLines } from "./aiEditPrompts";
import { INLINE_TEXT_BLOCK_SELECTOR, planFormatPreservingEdit } from "./inlineAiPatch";

/** The API recognizes this kind of edit by this opening line. */
export const DOCUMENT_PATCH_PREFIX = "You are changing an existing document block by block.";

/** Repeated page furniture, which a Word import draws on every page. */
const OUTSIDE_THE_BODY = ".document-page-setup,.document-page-chrome";
/** A blank drawn as a rule holds only spaces, which the model would never see. */
const DRAWN_BLANK = ".document-signature-line,.document-blank";
const BLANK_FOR_THE_MODEL = "____";
const TABLE_CELL = "td,th";
const LIST_PARENT = "ul,ol";
const HEADER = /^@@\s*(?:(after|delete)\s+)?(\d+)\s*$/i;
const END = /^@@\s*end\s*$/i;
const CODE_FENCE = /^```/;

export type DocumentBlock = { id: number; element: Element; text: string };

export type DocumentPatch =
  | { kind: "replace"; id: number; text: string }
  | { kind: "after"; id: number; paragraphs: string[] }
  | { kind: "delete"; id: number };

export type DocumentPatchResult = { changed: number; skipped: number };

/** A reply that cannot be trusted as a complete set of changes. */
export class DocumentPatchError extends Error {}

function blockText(element: Element) {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll("br").forEach((lineBreak) => lineBreak.replaceWith(" "));
  copy.querySelectorAll(DRAWN_BLANK).forEach((blank) => {
    if (!/[^\s_]/.test(blank.textContent ?? "")) blank.replaceWith(BLANK_FOR_THE_MODEL);
  });
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

function isEditable(element: Element, text: string) {
  if (element.closest(OUTSIDE_THE_BODY) || element.querySelector(INLINE_TEXT_BLOCK_SELECTOR)) return false;
  return Boolean(text) || element.matches(TABLE_CELL);
}

/** The document's text blocks in reading order. An empty table cell counts,
 * because it can be a gap to fill. An empty paragraph is only spacing. */
export function documentBlocks(root: Element): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  root.querySelectorAll(INLINE_TEXT_BLOCK_SELECTOR).forEach((element) => {
    const text = blockText(element);
    if (isEditable(element, text)) blocks.push({ id: blocks.length + 1, element, text });
  });
  return blocks;
}

export function documentPatchPrompt({
  documentTitle,
  instruction,
  blocks,
}: {
  documentTitle: string;
  instruction: string;
  blocks: readonly DocumentBlock[];
}) {
  const shown = blocks.map(({ id, text }) => `[${id}] ${text || "(empty table cell)"}`).join("\n");
  return [
    // The API reads the instruction from between its two headings below.
    DOCUMENT_PATCH_PREFIX,
    `The document is titled "${documentTitle}". Apply the user's instruction by changing only the numbered blocks that need it. Make the change itself. Do not describe it.`,
    "",
    "Reply with only the blocks you change, in this exact format, and nothing else:",
    "@@ 12",
    "The complete new text of block 12, repeating every word that stays.",
    "@@ after 12",
    "A new paragraph to add after block 12.",
    "@@ delete 14",
    "@@ end",
    "",
    "Always finish with the line @@ end, even when nothing needs to change. Plain text only: no Markdown, no HTML, no quotes around the text. Never renumber a block.",
    "",
    ...aiEditScopeLines({ instruction, selectedText: shown }),
    "",
    "User instruction:",
    instruction,
    "",
    "Document blocks:",
    shown,
  ].join("\n");
}

function flatText(lines: readonly string[]) {
  return lines.join(" ").replace(/\s+/g, " ").replace(/\*\*/g, "").trim();
}

function paragraphsOf(lines: readonly string[]) {
  return lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((paragraph) => flatText(paragraph.split("\n")))
    .filter(Boolean);
}

function patchFrom(kind: string | undefined, id: number, lines: string[]): DocumentPatch {
  if (kind?.toLowerCase() === "delete") return { kind: "delete", id };
  if (kind?.toLowerCase() === "after") return { kind: "after", id, paragraphs: paragraphsOf(lines) };
  return { kind: "replace", id, text: flatText(lines) };
}

/** Reads a reply. A reply with no end line was cut off, so none of it applies:
 * half of a consistent change is worse than none. */
export function parseDocumentPatch(reply: string): DocumentPatch[] {
  const lines = reply.split("\n").map((line) => line.trimEnd());
  const patches: DocumentPatch[] = [];
  let open: { kind: string | undefined; id: number; lines: string[] } | null = null;
  const close = () => {
    if (open) patches.push(patchFrom(open.kind, open.id, open.lines));
    open = null;
  };
  for (const line of lines) {
    const header = HEADER.exec(line.trim());
    if (END.test(line.trim())) {
      close();
      return patches;
    }
    if (header) {
      close();
      open = { kind: header[1], id: Number(header[2]), lines: [] };
    } else if (open && !CODE_FENCE.test(line.trim())) {
      (open as { lines: string[] }).lines.push(line);
    }
  }
  throw new DocumentPatchError("The reply stopped before it finished, so the document was left unchanged.");
}

type Mark = (content: DocumentFragment) => HTMLElement;
/** Marks new words. `order` numbers the changes, so each can be told apart. */
type OrderedMark = (content: DocumentFragment, order: number) => HTMLElement;

function markedText(text: string, wrap: Mark) {
  const content = document.createDocumentFragment();
  content.append(text);
  return wrap(content);
}

function escapedParagraph(text: string) {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  return paragraph.outerHTML;
}

function replaceBlock(block: DocumentBlock, text: string, wrap: Mark) {
  if (block.text === flatText([text])) return false;
  const plan = planFormatPreservingEdit(block.element, null, escapedParagraph(text));
  if (plan) {
    plan.apply(wrap);
    return plan.changes > 0;
  }
  // Nothing maps word for word: a rewrite, or a cell that was empty. The block
  // keeps its element, so it keeps its place and its style.
  block.element.replaceChildren(markedText(text, wrap));
  return true;
}

function appendAfter(block: DocumentBlock, paragraphs: readonly string[], wrap: Mark, lastAdded: Map<number, Element>) {
  if (block.element.matches(TABLE_CELL)) {
    block.element.append(" ", markedText(paragraphs.join(" "), wrap));
    return;
  }
  for (const paragraph of paragraphs) {
    const added = block.element.cloneNode(false) as Element;
    added.removeAttribute("id");
    added.append(markedText(paragraph, wrap));
    (lastAdded.get(block.id) ?? block.element).after(added);
    lastAdded.set(block.id, added);
  }
}

function removeBlock(block: DocumentBlock) {
  if (block.element.matches(TABLE_CELL)) {
    block.element.replaceChildren();
    return;
  }
  const parent = block.element.parentElement;
  block.element.remove();
  if (parent?.matches(LIST_PARENT) && !parent.children.length) parent.remove();
}

/** Writes a reply into the document. Numbers refer to `blocks` as they were
 * listed, so a removal never shifts what a later change means. */
export function applyDocumentPatch(
  blocks: readonly DocumentBlock[],
  patches: readonly DocumentPatch[],
  wrap: OrderedMark,
): DocumentPatchResult {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const lastAdded = new Map<number, Element>();
  const result: DocumentPatchResult = { changed: 0, skipped: 0 };
  patches.forEach((patch, order) => {
    const block = byId.get(patch.id);
    const wrapThis: Mark = (content) => wrap(content, order);
    if (!block) {
      result.skipped += 1;
    } else if (patch.kind === "replace") {
      if (replaceBlock(block, patch.text, wrapThis)) result.changed += 1;
    } else if (patch.kind === "after") {
      appendAfter(block, patch.paragraphs, wrapThis, lastAdded);
      result.changed += 1;
    } else {
      removeBlock(block);
      result.changed += 1;
    }
  });
  return result;
}
