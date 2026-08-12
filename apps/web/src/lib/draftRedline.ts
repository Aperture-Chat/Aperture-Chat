/**
 * Visual redline support for the Drafts workspace.
 *
 * Compares two saved draft versions as a read-only, screen-only redline. It is
 * deliberately labeled "Visual redline — Not DOCX tracked changes" in the UI:
 * nothing here produces Word revision marks, and nothing here ever mutates,
 * merges, or saves either version.
 *
 * Pipeline:
 *   1. Both stored HTML versions run through a conservative allowlist
 *      sanitizer (the repo intentionally has no dompurify dependency).
 *   2. A block-level structural diff aligns paragraphs, headings, list items,
 *      and table cells; images, diagrams, page breaks, and other non-text
 *      blocks are treated as whole inserted/removed/unchanged units.
 *   3. Word-level LCS diffing runs only inside changed text-block pairs, and
 *      only while the documented `REDLINE_LIMITS` caps hold. When a cap is
 *      exceeded the entire result falls back to block-only mode with an
 *      honest reason — a partial word diff is never presented as complete.
 */

/** Documented guardrails for the redline computation. Exceeding any cap moves
 * the whole comparison to block-only mode with `fallbackReason` set. */
export const REDLINE_LIMITS = {
  /** Word-level diffing is skipped when either sanitized version exceeds this many characters. */
  maxCharsPerVersion: 200_000,
  /** Above this many comparable blocks per version, alignment falls back to positional block comparison. */
  maxBlocksPerVersion: 1_500,
  /** Word-level diffing runs only when at most this many text-block pairs changed. */
  maxChangedTextBlocks: 60,
  /** Word-level diffing runs only when each changed pair's combined text is at most this many characters. */
  maxWordDiffCharsPerBlock: 6_000,
} as const;

export type RedlineBlockKind = "text" | "media";

export type RedlineBlock = {
  kind: RedlineBlockKind;
  /** Human-readable structural label: Paragraph, Heading, List item, Table cell, Image… */
  label: string;
  /** Normalized visible text; empty for media units. */
  text: string;
  /** Extra display detail for media units (image alt/src, diagram source). */
  detail?: string;
  /** Equality key used by the structural diff. */
  signature: string;
};

export type RedlineTokenType = "same" | "ins" | "del";

export type RedlineToken = { type: RedlineTokenType; text: string };

export type RedlineRow =
  | { type: "unchanged"; block: RedlineBlock }
  | { type: "inserted"; block: RedlineBlock }
  | { type: "removed"; block: RedlineBlock }
  | { type: "changed"; base: RedlineBlock; comparison: RedlineBlock; tokens: RedlineToken[] };

export type RedlineDiff = {
  /** "word" when word-level detail is complete; "block-only" after a cap fallback. */
  mode: "word" | "block-only";
  /** Honest explanation when mode is "block-only" because a cap was exceeded. */
  fallbackReason: string | null;
  rows: RedlineRow[];
  stats: { unchanged: number; inserted: number; removed: number; changed: number };
  /** Screen-reader friendly one-sentence summary of the comparison. */
  summary: string;
};

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

/** Tags whose entire subtree is active or opaque content and must be dropped. */
const REMOVE_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "noscript",
  "template",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "textarea",
  "select",
  "option",
  "button",
  "dialog",
  "audio",
  "video",
  "source",
  "track",
  "canvas",
  "svg",
  "math",
  "slot",
  "portal",
]);

/** Structural and inline tags the drafting editor legitimately produces. */
const ALLOWED_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  "figure",
  "figcaption",
  "img",
  "a",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "strike",
  "del",
  "ins",
  "mark",
  "code",
  "pre",
  "blockquote",
  "br",
  "hr",
  "span",
  "div",
  "section",
  "article",
  "sup",
  "sub",
  "small",
  "cite",
  "q",
  "time",
  "dl",
  "dt",
  "dd",
]);

/** Attributes allowed on every element. Event handlers, ids, and
 * contenteditable flags are deliberately not on any allowlist. Inline `style`
 * is not allowlisted wholesale either: it passes through a strict
 * per-declaration filter (see `sanitizeStyleAttribute`) so only the
 * formatting the drafting toolbar legitimately produces survives. */
const GLOBAL_ALLOWED_ATTRIBUTES = new Set([
  "class",
  // Provenance the drafting editor writes on AI-authored runs: when the edit
  // landed and which model produced it. The AI edit trail reads these back,
  // so they have to survive the round trip through storage.
  "data-ai-edit-at",
  "data-ai-edit-by",
]);

/** Strict value patterns for the few CSS properties the drafting toolbar
 * writes (text color, highlight, alignment, font size). Anything with
 * functions like url()/expression(), custom properties, or other CSS is
 * rejected by construction. */
const SAFE_CSS_COLOR_VALUE =
  /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)|[a-z]{3,20})$/i;

const ALLOWED_STYLE_PROPERTIES: Record<string, RegExp> = {
  color: SAFE_CSS_COLOR_VALUE,
  "background-color": SAFE_CSS_COLOR_VALUE,
  "text-align": /^(left|center|right|justify)$/i,
  "font-size": /^\d{1,3}(\.\d+)?(px|pt|em|rem|%)$/i,
  // Plain family names only (optionally quoted, comma-separated fallbacks);
  // no url()/expression() shapes are expressible under this pattern.
  "font-family": /^[a-z0-9 "',\-]{1,120}$/i,
};

/** Filters a raw style attribute down to the allowlisted declarations.
 * Returns an empty string when nothing safe remains. */
export function sanitizeStyleAttribute(value: string): string {
  const kept: string[] = [];
  value.split(";").forEach((declaration) => {
    const separator = declaration.indexOf(":");
    if (separator === -1) return;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const propertyValue = declaration.slice(separator + 1).trim();
    const pattern = ALLOWED_STYLE_PROPERTIES[property];
    if (!pattern || !pattern.test(propertyValue)) return;
    kept.push(`${property}: ${propertyValue.toLowerCase()}`);
  });
  return kept.join("; ");
}

const TAG_ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  img: ["src", "alt", "title", "width", "height"],
  a: ["href", "title", "target", "rel"],
  th: ["colspan", "rowspan"],
  td: ["colspan", "rowspan"],
  col: ["span"],
  colgroup: ["span"],
  time: ["datetime"],
  section: ["data-page-number"],
  figure: ["data-diagram-source"],
};

function isSafeUrl(value: string, { allowDataImage }: { allowDataImage: boolean }) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (trimmed.startsWith("/api/")) return true;
  if (trimmed.startsWith("#")) return true;
  if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp);/i.test(trimmed)) return true;
  return false;
}

function sanitizeAttributes(element: Element, tag: string) {
  const allowed = TAG_ALLOWED_ATTRIBUTES[tag] ?? [];
  Array.from(element.attributes).forEach((attribute) => {
    const name = attribute.name.toLowerCase();
    if (name === "style") {
      const filtered = sanitizeStyleAttribute(attribute.value);
      if (filtered) element.setAttribute("style", filtered);
      else element.removeAttribute(attribute.name);
      return;
    }
    if (name.startsWith("on") || (!GLOBAL_ALLOWED_ATTRIBUTES.has(name) && !allowed.includes(name))) {
      element.removeAttribute(attribute.name);
      return;
    }
    if (name === "href" && !isSafeUrl(attribute.value, { allowDataImage: false })) {
      element.removeAttribute(attribute.name);
      return;
    }
    if (name === "src" && !isSafeUrl(attribute.value, { allowDataImage: true })) {
      element.removeAttribute(attribute.name);
    }
  });
  if (tag === "img" && !element.getAttribute("src")) {
    // A picture without a safe source has nothing honest to show.
    element.remove();
    return;
  }
  if (tag === "a" && element.getAttribute("href")) {
    element.setAttribute("rel", "noreferrer");
  }
}

function sanitizeChildren(parent: ParentNode) {
  Array.from(parent.childNodes).forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) return;
    if (!(child instanceof Element)) {
      // Comments, processing instructions, CDATA: nothing to render.
      child.remove();
      return;
    }
    const tag = child.tagName.toLowerCase();
    if (REMOVE_WITH_CONTENT.has(tag)) {
      child.remove();
      return;
    }
    sanitizeChildren(child);
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown wrapper (font, o:p, custom elements…): keep the readable
      // children, drop the wrapper itself.
      const fragment = child.ownerDocument.createDocumentFragment();
      while (child.firstChild) fragment.appendChild(child.firstChild);
      child.replaceWith(fragment);
      return;
    }
    sanitizeAttributes(child, tag);
  });
}

/**
 * Conservative allowlist sanitizer for stored draft HTML. Strips scripts,
 * event-handler attributes, and unsafe URLs, and filters inline styles down
 * to the formatting declarations the toolbar produces, while preserving the
 * document structure the drafting editor writes. Always run stored HTML
 * through this before rendering it via innerHTML.
 */
export function sanitizeDocumentHtml(html: string): string {
  if (typeof document === "undefined") {
    // No DOM available: fall back to text-only, which is safe by construction.
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitizeChildren(template.content);
  return template.innerHTML;
}

// ---------------------------------------------------------------------------
// Block extraction
// ---------------------------------------------------------------------------

const TEXT_BLOCK_LABELS: Record<string, string> = {
  p: "Paragraph",
  h1: "Heading",
  h2: "Heading",
  h3: "Heading",
  h4: "Heading",
  h5: "Heading",
  h6: "Heading",
  blockquote: "Quote",
  pre: "Code block",
  figcaption: "Caption",
  dt: "Term",
  dd: "Definition",
};

function normalizeBlockText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function pushTextBlock(blocks: RedlineBlock[], label: string, text: string) {
  const normalized = normalizeBlockText(text);
  if (!normalized) return;
  blocks.push({
    kind: "text",
    label,
    text: normalized,
    signature: `text:${label}:${normalized}`,
  });
}

function pushMediaBlock(blocks: RedlineBlock[], label: string, signature: string, detail?: string) {
  blocks.push({ kind: "media", label, text: "", detail, signature });
}

function imageTail(src: string) {
  const withoutQuery = src.split(/[?#]/)[0] ?? src;
  const segments = withoutQuery.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? src;
}

function collectBlocksFromElement(element: Element, blocks: RedlineBlock[]) {
  const tag = element.tagName.toLowerCase();
  if (element.classList.contains("document-page-label")) return;
  if (tag === "section" || tag === "div" || tag === "article") {
    Array.from(element.children).forEach((child) => collectBlocksFromElement(child, blocks));
    return;
  }
  if (TEXT_BLOCK_LABELS[tag]) {
    pushTextBlock(blocks, TEXT_BLOCK_LABELS[tag], element.textContent ?? "");
    return;
  }
  if (tag === "ul" || tag === "ol" || tag === "dl") {
    Array.from(element.children).forEach((child) => {
      const childTag = child.tagName.toLowerCase();
      if (childTag === "li") pushTextBlock(blocks, "List item", child.textContent ?? "");
      else collectBlocksFromElement(child, blocks);
    });
    return;
  }
  if (tag === "table") {
    Array.from(element.querySelectorAll("th, td")).forEach((cell) => {
      pushTextBlock(blocks, "Table cell", cell.textContent ?? "");
    });
    return;
  }
  if (tag === "figure") {
    const diagramSource = element.getAttribute("data-diagram-source");
    const image = element.querySelector("img");
    if (image) {
      const src = image.getAttribute("src") ?? "";
      const alt = normalizeBlockText(image.getAttribute("alt") ?? "");
      pushMediaBlock(blocks, "Image", `media:image:${src}|${alt}`, alt || imageTail(src));
      return;
    }
    if (diagramSource) {
      pushMediaBlock(blocks, "Diagram", `media:diagram:${diagramSource}`, "Mermaid diagram");
      return;
    }
    pushTextBlock(blocks, "Figure", element.textContent ?? "");
    return;
  }
  if (tag === "img") {
    const src = element.getAttribute("src") ?? "";
    const alt = normalizeBlockText(element.getAttribute("alt") ?? "");
    pushMediaBlock(blocks, "Image", `media:image:${src}|${alt}`, alt || imageTail(src));
    return;
  }
  if (tag === "hr") {
    if (element.classList.contains("document-page-break")) {
      pushMediaBlock(blocks, "Page break", "media:page-break");
    } else {
      pushMediaBlock(blocks, "Divider", "media:divider");
    }
    return;
  }
  // Inline leftovers at the top level (span, a, strong…) still carry text.
  pushTextBlock(blocks, "Paragraph", element.textContent ?? "");
}

/**
 * Flattens sanitized draft HTML into comparable blocks: paragraphs, headings,
 * list items, and table cells become text blocks; images, diagrams, dividers,
 * and page breaks become whole media units. Page sections and the on-screen
 * "Page N" labels are traversal chrome, not content.
 */
export function extractRedlineBlocks(sanitizedHtml: string): RedlineBlock[] {
  const blocks: RedlineBlock[] = [];
  if (typeof document === "undefined") {
    pushTextBlock(blocks, "Paragraph", sanitizedHtml);
    return blocks;
  }
  const template = document.createElement("template");
  template.innerHTML = sanitizedHtml;
  template.content.querySelectorAll(".document-page-label").forEach((node) => node.remove());
  Array.from(template.content.children).forEach((child) => collectBlocksFromElement(child, blocks));
  // Loose text nodes at the root still deserve a row.
  Array.from(template.content.childNodes).forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) pushTextBlock(blocks, "Paragraph", node.textContent ?? "");
  });
  return blocks;
}

// ---------------------------------------------------------------------------
// LCS alignment
// ---------------------------------------------------------------------------

type AlignOp = "same" | "removed" | "inserted";

function lcsAlign<T>(a: T[], b: T[], equal: (x: T, y: T) => boolean): AlignOp[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = equal(a[i], b[j])
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: AlignOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (equal(a[i], b[j])) {
      ops.push("same");
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push("removed");
      i += 1;
    } else {
      ops.push("inserted");
      j += 1;
    }
  }
  while (i < n) {
    ops.push("removed");
    i += 1;
  }
  while (j < m) {
    ops.push("inserted");
    j += 1;
  }
  return ops;
}

/** Coarse positional alignment for documents past the block cap: never
 * freezes, at the cost of anchor-quality alignment. Honest because the result
 * is always labeled block-only with the size reason attached. */
function positionalAlign(a: RedlineBlock[], b: RedlineBlock[]): AlignOp[] {
  const ops: AlignOp[] = [];
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a[index].signature === b[index].signature) ops.push("same");
    else {
      ops.push("removed");
      ops.push("inserted");
    }
  }
  for (let index = shared; index < a.length; index += 1) ops.push("removed");
  for (let index = shared; index < b.length; index += 1) ops.push("inserted");
  return ops;
}

// ---------------------------------------------------------------------------
// Word-level diff
// ---------------------------------------------------------------------------

function diffWords(baseText: string, comparisonText: string): RedlineToken[] {
  const baseWords = baseText.split(/\s+/).filter(Boolean);
  const comparisonWords = comparisonText.split(/\s+/).filter(Boolean);
  const ops = lcsAlign(baseWords, comparisonWords, (x, y) => x === y);
  const tokens: RedlineToken[] = [];
  let i = 0;
  let j = 0;
  const push = (type: RedlineTokenType, word: string) => {
    const last = tokens[tokens.length - 1];
    if (last && last.type === type) last.text += ` ${word}`;
    else tokens.push({ type, text: word });
  };
  ops.forEach((op) => {
    if (op === "same") {
      push("same", comparisonWords[j]);
      i += 1;
      j += 1;
    } else if (op === "removed") {
      push("del", baseWords[i]);
      i += 1;
    } else {
      push("ins", comparisonWords[j]);
      j += 1;
    }
  });
  return tokens;
}

// ---------------------------------------------------------------------------
// Row assembly
// ---------------------------------------------------------------------------

type PendingPair = { base: RedlineBlock; comparison: RedlineBlock };

type StagedRow =
  | { type: "unchanged"; block: RedlineBlock }
  | { type: "inserted"; block: RedlineBlock }
  | { type: "removed"; block: RedlineBlock }
  | { type: "pair"; pair: PendingPair };

function stageRows(
  baseBlocks: RedlineBlock[],
  comparisonBlocks: RedlineBlock[],
  ops: AlignOp[],
): StagedRow[] {
  const rows: StagedRow[] = [];
  const pendingRemoved: RedlineBlock[] = [];
  const pendingInserted: RedlineBlock[] = [];
  let i = 0;
  let j = 0;

  const flushPending = () => {
    const total = Math.max(pendingRemoved.length, pendingInserted.length);
    for (let k = 0; k < total; k += 1) {
      const removed = pendingRemoved[k];
      const inserted = pendingInserted[k];
      if (removed && inserted) {
        if (removed.kind === "text" && inserted.kind === "text" && removed.text !== inserted.text) {
          rows.push({ type: "pair", pair: { base: removed, comparison: inserted } });
        } else {
          rows.push({ type: "removed", block: removed });
          rows.push({ type: "inserted", block: inserted });
        }
      } else if (removed) {
        rows.push({ type: "removed", block: removed });
      } else if (inserted) {
        rows.push({ type: "inserted", block: inserted });
      }
    }
    pendingRemoved.length = 0;
    pendingInserted.length = 0;
  };

  ops.forEach((op) => {
    if (op === "same") {
      flushPending();
      rows.push({ type: "unchanged", block: comparisonBlocks[j] });
      i += 1;
      j += 1;
    } else if (op === "removed") {
      pendingRemoved.push(baseBlocks[i]);
      i += 1;
    } else {
      pendingInserted.push(comparisonBlocks[j]);
      j += 1;
    }
  });
  flushPending();
  return rows;
}

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function buildSummary(
  stats: RedlineDiff["stats"],
  mode: RedlineDiff["mode"],
  fallbackReason: string | null,
) {
  if (!stats.inserted && !stats.removed && !stats.changed) {
    return "Visual redline: the selected versions are identical at every compared block.";
  }
  const summaryParts = [
    pluralize(stats.changed, "changed block"),
    pluralize(stats.inserted, "inserted block"),
    pluralize(stats.removed, "removed block"),
    pluralize(stats.unchanged, "unchanged block"),
  ];
  let summary = `Visual redline: ${summaryParts.join(", ")}.`;
  if (mode === "block-only" && fallbackReason) summary += ` ${fallbackReason}`;
  return summary;
}

/**
 * Computes the read-only visual redline between two stored draft versions.
 * Both inputs are sanitized before any comparison; the inputs themselves are
 * never modified and no DOM outside a detached template is touched.
 */
export function computeDraftRedline(baseHtml: string, comparisonHtml: string): RedlineDiff {
  const sanitizedBase = sanitizeDocumentHtml(baseHtml);
  const sanitizedComparison = sanitizeDocumentHtml(comparisonHtml);
  const baseBlocks = extractRedlineBlocks(sanitizedBase);
  const comparisonBlocks = extractRedlineBlocks(sanitizedComparison);

  let fallbackReason: string | null = null;
  if (
    sanitizedBase.length > REDLINE_LIMITS.maxCharsPerVersion ||
    sanitizedComparison.length > REDLINE_LIMITS.maxCharsPerVersion
  ) {
    fallbackReason = `Word-level detail is off because a version exceeds the ${REDLINE_LIMITS.maxCharsPerVersion.toLocaleString()}-character limit; showing block-level changes only.`;
  }

  const pastBlockCap =
    baseBlocks.length > REDLINE_LIMITS.maxBlocksPerVersion ||
    comparisonBlocks.length > REDLINE_LIMITS.maxBlocksPerVersion;
  if (pastBlockCap && !fallbackReason) {
    fallbackReason = `Word-level detail is off because a version exceeds the ${REDLINE_LIMITS.maxBlocksPerVersion.toLocaleString()}-block limit; showing position-based block changes only.`;
  }

  const ops = pastBlockCap
    ? positionalAlign(baseBlocks, comparisonBlocks)
    : lcsAlign(baseBlocks, comparisonBlocks, (x, y) => x.signature === y.signature);
  const staged = stageRows(baseBlocks, comparisonBlocks, ops);

  const pairs = staged.filter((row): row is Extract<StagedRow, { type: "pair" }> => row.type === "pair");
  if (!fallbackReason && pairs.length > REDLINE_LIMITS.maxChangedTextBlocks) {
    fallbackReason = `Word-level detail is off because more than ${REDLINE_LIMITS.maxChangedTextBlocks} blocks changed; showing block-level changes only.`;
  }
  if (
    !fallbackReason &&
    pairs.some(
      (row) =>
        row.pair.base.text.length + row.pair.comparison.text.length >
        REDLINE_LIMITS.maxWordDiffCharsPerBlock,
    )
  ) {
    fallbackReason = `Word-level detail is off because a changed block exceeds the ${REDLINE_LIMITS.maxWordDiffCharsPerBlock.toLocaleString()}-character word-diff limit; showing block-level changes only.`;
  }

  const wordMode = fallbackReason === null;
  const rows: RedlineRow[] = [];
  staged.forEach((row) => {
    if (row.type !== "pair") {
      rows.push(row);
      return;
    }
    if (!wordMode) {
      // Block-only fallback: a changed pair is shown as a full removal plus a
      // full insertion, never as a partial word diff.
      rows.push({ type: "removed", block: row.pair.base });
      rows.push({ type: "inserted", block: row.pair.comparison });
      return;
    }
    rows.push({
      type: "changed",
      base: row.pair.base,
      comparison: row.pair.comparison,
      tokens: diffWords(row.pair.base.text, row.pair.comparison.text),
    });
  });

  const stats = {
    unchanged: rows.filter((row) => row.type === "unchanged").length,
    inserted: rows.filter((row) => row.type === "inserted").length,
    removed: rows.filter((row) => row.type === "removed").length,
    changed: rows.filter((row) => row.type === "changed").length,
  };
  const mode: RedlineDiff["mode"] = wordMode ? "word" : "block-only";
  return {
    mode,
    fallbackReason,
    rows,
    stats,
    summary: buildSummary(stats, mode, fallbackReason),
  };
}
