import {
  looksLikeStructuredDiagramSource,
  looksLikeStructuredSummarySource,
} from "./structuredDiagramSource";
import {
  convertDotToMermaid,
  convertPlantUmlToMermaid,
  convertTextDiagram,
  looksLikeDot,
  looksLikePlantUml,
} from "./textDiagrams";

export type MarkdownColumnAlign = "left" | "center" | "right" | null;

export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "image"; alt: string; url: string; title?: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; headers: string[]; rows: string[][]; aligns: MarkdownColumnAlign[] }
  | { kind: "rule" }
  | { kind: "code"; language: string; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "math"; source: string; math: string };

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };

  while (index < lines.length) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    // Fence openers tolerate what models actually emit: longer fences, tilde
    // fences, and info strings after the language (```mermaid {init: …}).
    // Only the first token becomes the language; extras never demote a block
    // to prose.
    const fence = readFenceOpener(trimmed);
    if (fence) {
      flushParagraph();
      const body = readFenceBody(lines, index + 1, fence);
      blocks.push({ kind: "code", language: fence.language, text: body.lines.join("\n") });
      index = body.nextIndex;
      continue;
    }

    // Display math must be read before tables so |x| bars inside an
    // expression are never mistaken for table cells.
    const math = readMathBlock(lines, index);
    if (math) {
      flushParagraph();
      blocks.push(math.block);
      index = math.nextIndex;
      continue;
    }

    const table = readTable(lines, index);
    if (table) {
      flushParagraph();
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    if (isTableSeparatorLine(trimmed)) {
      flushParagraph();
      index += 1;
      continue;
    }

    if (isRuleLine(trimmed)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    // Root-relative /api/ URLs cover platform-served assets such as generated images.
    const image = /^!\[([^\]]*)\]\((https?:\/\/[^)\s]+|\/api\/[^)\s]+)(?:\s+"([^"]+)")?\)\s*$/.exec(trimmed);
    if (image) {
      flushParagraph();
      blocks.push({ kind: "image", alt: image[1].trim(), url: image[2], title: image[3]?.trim() });
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^\s*>\s?/, "").trimEnd());
        index += 1;
      }
      blocks.push({ kind: "quote", lines: quoteLines });
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const item = (bullet?.[1] ?? ordered?.[1] ?? "").trim();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "list" && last.ordered === isOrdered) {
        last.items.push(item);
      } else {
        blocks.push({ kind: "list", ordered: isOrdered, items: [item] });
      }
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

type FenceOpener = { marker: string; char: "`" | "~"; length: number; language: string };

function readFenceOpener(trimmed: string): FenceOpener | null {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
  if (!match) return null;
  const marker = match[1]!;
  const info = (match[2] ?? "").trim();
  // A backtick fence's info string cannot itself contain backticks.
  if (marker.startsWith("`") && info.includes("`")) return null;
  return {
    marker,
    char: marker[0] as "`" | "~",
    length: marker.length,
    language: info.split(/\s+/)[0] ?? "",
  };
}

function isFenceCloser(trimmed: string, opener: FenceOpener) {
  const match = /^(`{3,}|~{3,})\s*$/.exec(trimmed);
  return Boolean(match && match[1]![0] === opener.char && match[1]!.length >= opener.length);
}

const NESTING_FENCE_LANGUAGES = new Set(["markdown", "md", "mdx"]);

/** Reads a fenced block body. Closers follow CommonMark (same character, at
 * least as long, no info string). A ```markdown fence that wraps a document
 * may hold its own ```mermaid fences: those nest instead of ending the outer
 * block halfway through. */
function readFenceBody(lines: string[], start: number, opener: FenceOpener) {
  const body: string[] = [];
  let index = start;
  const inner: FenceOpener[] = [];
  const nests = NESTING_FENCE_LANGUAGES.has(opener.language.toLowerCase());
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const open = inner[inner.length - 1];
    if (open && isFenceCloser(trimmed, open)) {
      inner.pop();
    } else if (!open && isFenceCloser(trimmed, opener)) {
      break;
    } else if (nests) {
      const nested = readFenceOpener(trimmed);
      if (nested?.language) inner.push(nested);
    }
    body.push(line.replace(/\s+$/g, ""));
    index += 1;
  }
  return { lines: body, nextIndex: index < lines.length ? index + 1 : index };
}

/**
 * Models often wrap a whole requested document in a single ``` fence; rendering
 * that verbatim turns the entire draft into one code block. Strip the fence only
 * when it encloses the complete reply (inner fenced snippets stay untouched).
 */
const MERMAID_LANGUAGE_ALIASES = new Set(["mermaid", "mmd", "mermaidjs", "mermaid-js"]);

// Fence tags that are themselves a Mermaid diagram type (` ```timeline `).
// The header keyword is prepended when the body omitted it.
const MERMAID_TAG_HEADERS: Record<string, string> = {
  timeline: "timeline",
  flowchart: "flowchart",
  sequence: "sequenceDiagram",
  sequencediagram: "sequenceDiagram",
  classdiagram: "classDiagram",
  classdiagramv2: "classDiagram",
  statediagram: "stateDiagram-v2",
  statediagramv2: "stateDiagram-v2",
  erdiagram: "erDiagram",
  journey: "journey",
  gantt: "gantt",
  pie: "pie",
  gitgraph: "gitGraph",
  mindmap: "mindmap",
  quadrantchart: "quadrantChart",
  requirementdiagram: "requirementDiagram",
  zenuml: "zenuml",
  sankey: "sankey-beta",
  "sankey-beta": "sankey-beta",
  xychart: "xychart-beta",
  "xychart-beta": "xychart-beta",
  kanban: "kanban",
  c4context: "C4Context",
  c4container: "C4Container",
};

const DOT_TAGS = new Set(["dot", "graphviz", "gv", "digraph"]);
const PLANTUML_TAGS = new Set(["plantuml", "puml", "uml"]);
// Tags under which models draw diagrams as text (arrow chains, layer lists,
// box art). The content decides; ordinary prose and code stay code.
const TEXT_DIAGRAM_TAGS = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "ascii",
  "asciiart",
  "ascii-art",
  "diagram",
  "drawing",
  "art",
  "flow",
]);

// First-line grammar keywords that identify a Mermaid diagram when a fence
// carries no usable language tag. `graph`/`flowchart` require a direction so
// DOT graphs and prose never false-positive.
const MERMAID_KEYWORD_PATTERN = new RegExp(
  "^(?:graph\\s+(?:TB|TD|BT|RL|LR)\\b|flowchart\\s+(?:TB|TD|BT|RL|LR)\\b|sequenceDiagram\\b|" +
    "classDiagram(?:-v2)?\\b|stateDiagram(?:-v2)?\\b|erDiagram\\b|journey\\b|gantt\\b|pie\\b|" +
    "quadrantChart\\b|requirementDiagram\\b|gitGraph\\b|mindmap\\b|timeline\\b|zenuml\\b|" +
    "sankey(?:-beta)?\\b|xychart-beta\\b|block-beta\\b|packet-beta\\b|kanban\\b|" +
    "architecture-beta\\b|radar(?:-beta)?\\b|C4Context\\b|C4Container\\b|C4Component\\b|C4Dynamic\\b)",
);

/**
 * True when a fenced code block is a Mermaid diagram, whatever model or
 * provider produced it: the mermaid language tag and its aliases count, and
 * untagged/`text` fences count when the content opens with Mermaid grammar.
 * Explicitly tagged non-mermaid blocks (```python …) never match.
 */
export function isMermaidBlock(language: string, text: string): boolean {
  const tag = fenceTag(language);
  if (MERMAID_LANGUAGE_ALIASES.has(tag) || tag in MERMAID_TAG_HEADERS) return true;
  if (!GENERIC_FENCE_TAGS.has(tag) && !TEXT_DIAGRAM_TAGS.has(tag)) return false;
  return MERMAID_KEYWORD_PATTERN.test(mermaidGrammarLine(mermaidDiagramSource(text, language)));
}

function fenceTag(language: string) {
  return language.trim().toLowerCase().split(/\s+/)[0] ?? "";
}

/** First line of real grammar: skips blank lines, `%%` comments and init
 * directives, and a `---` front-matter block. */
function mermaidGrammarLine(source: string): string {
  const lines = source.split("\n");
  let index = 0;
  while (index < lines.length && !(lines[index] ?? "").trim()) index += 1;
  if ((lines[index] ?? "").trim() === "---") {
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() !== "---") index += 1;
    index += 1;
  }
  for (; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed && !trimmed.startsWith("%%")) return trimmed;
  }
  return "";
}

/** A fenced block that renders as a figure: Mermaid source (native or
 * converted from Graphviz, PlantUML, or a text drawing) or a structure-chart
 * spec. `notes` carry prose that accompanied a text drawing. `converted`
 * marks sources Aperture translated, so an edit can retag the fence. */
export type ResolvedDiagram = {
  kind: "mermaid" | "structure";
  source: string;
  notes?: string[];
  converted?: boolean;
};

/**
 * The one decision every surface shares (chat, hover previews, Drafts,
 * diagram editing): is this fenced block a diagram, and what source draws
 * it? Explicitly tagged code (```python, ```sql) is never a diagram.
 */
export function resolveDiagramBlock(language: string, text: string): ResolvedDiagram | null {
  const tag = fenceTag(language);
  if (tag.startsWith("hermes-")) return null;
  if (isStewardDiagramBlock(language, text)) return { kind: "structure", source: text.trim() };
  const generic = GENERIC_FENCE_TAGS.has(tag) || TEXT_DIAGRAM_TAGS.has(tag);
  if (DOT_TAGS.has(tag) || (generic && looksLikeDot(text))) {
    const converted = convertDotToMermaid(text);
    return converted
      ? { kind: "mermaid", source: converted.source, notes: converted.notes, converted: true }
      : { kind: "mermaid", source: text.trim() };
  }
  if (PLANTUML_TAGS.has(tag) || (generic && looksLikePlantUml(text))) {
    const converted = convertPlantUmlToMermaid(text);
    return converted
      ? { kind: "mermaid", source: converted.source, notes: converted.notes, converted: true }
      : { kind: "mermaid", source: text.trim() };
  }
  if (isMermaidBlock(language, text)) return { kind: "mermaid", source: mermaidDiagramSource(text, language) };
  if (TEXT_DIAGRAM_TAGS.has(tag)) {
    const converted = convertTextDiagram(text);
    if (converted) return { kind: "mermaid", source: converted.source, notes: converted.notes, converted: true };
  }
  return null;
}

/** Mermaid plus diagrams in other notations (Graphviz, PlantUML, text
 * drawings) that must render as a visual, never as a Copy/Preview/Edit code
 * panel. */
export function isVisualDiagramBlock(language: string, text: string): boolean {
  return resolveDiagramBlock(language, text)?.kind === "mermaid";
}

/** Fence tags that carry no rendering intent of their own. A model that meant
 * a diagram often labels it with one of these instead of the diagram tag —
 * `yaml` most of all, because JSON is valid YAML — so these are sniffed by
 * content rather than taken at their word. Anything else (```python, ```sql)
 * is trusted and stays a code block. */
const GENERIC_FENCE_TAGS = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "yaml",
  "yml",
  "json",
  "json5",
]);

/** Diagram source with fence artifacts removed — some models repeat the
 * language tag as the first line inside the block. A ` ```timeline ` fence
 * whose body omitted the keyword gets that header prepended so mermaid and
 * the fallback parsers see a complete diagram. */
export function mermaidDiagramSource(text: string, language = ""): string {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length && !(lines[start] ?? "").trim()) start += 1;
  if (MERMAID_LANGUAGE_ALIASES.has((lines[start] ?? "").trim().toLowerCase())) start += 1;
  let body = lines.slice(start).join("\n").trim();
  const tag = language.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const header = MERMAID_TAG_HEADERS[tag];
  if (header && body && !MERMAID_KEYWORD_PATTERN.test(body)) {
    body = `${header}\n${body}`;
  }
  return body;
}

const STEWARD_DIAGRAM_LANGUAGES = new Set([
  "aperture-diagram",
  "aperture_diagram",
  "aperturediagram",
  "steward-diagram",
  "steward_diagram",
  "stewarddiagram",
]);

/**
 * True when a fenced block is a structure diagram (JSON card chart).
 * The dedicated tag counts, and so does a generic-tagged fence whose body is
 * a diagram spec — a model that emits the card data under ```yaml or ```json
 * still meant a diagram. The renderer re-parses and falls back to a code block
 * if the body does not hold up, so sniffing can never fake a diagram.
 */
export function isStewardDiagramBlock(language: string, text?: string): boolean {
  const tag = language.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (STEWARD_DIAGRAM_LANGUAGES.has(tag)) return true;
  if (text === undefined || !GENERIC_FENCE_TAGS.has(tag)) return false;
  return looksLikeStewardDiagramSource(text) || looksLikeStructuredSummarySource(text);
}

export function isDedicatedStewardDiagramLanguage(language: string): boolean {
  const tag = language.trim().toLowerCase().split(/\s+/)[0] ?? "";
  return STEWARD_DIAGRAM_LANGUAGES.has(tag);
}

/** Structural check shared with the JSON/YAML diagram parser. Ordinary data
 * stays code; only a usable `rows` collection of cards becomes a diagram. */
export function looksLikeStewardDiagramSource(text: string): boolean {
  return looksLikeStructuredDiagramSource(text);
}

/** Replaces the body of the fenced diagram block (Mermaid or steward-diagram)
 * whose source matches `previousSource`, preserving the fence lines and
 * everything around them. Fence detection mirrors parseMarkdownBlocks so the
 * block the reader edited is the block that gets replaced. Returns null when
 * no block matches. */
export function replaceDiagramFence(content: string, previousSource: string, nextSource: string): string | null {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const wanted = previousSource.trim();
  let index = 0;
  while (index < lines.length) {
    const fence = readFenceOpener((lines[index] ?? "").trim());
    if (!fence) {
      index += 1;
      continue;
    }
    const bodyStart = index + 1;
    const body = readFenceBody(lines, bodyStart, fence);
    const bodyEnd = bodyStart + body.lines.length;
    const resolved = resolveDiagramBlock(fence.language, body.lines.join("\n"));
    if (resolved && resolved.source.trim() === wanted) {
      // A converted drawing (Graphviz, PlantUML, text) is saved back as the
      // Mermaid the reader edited, so the fence is retagged to match.
      const opener = resolved.converted ? `${fence.marker}mermaid` : lines[index]!;
      const replaced = [...lines.slice(0, index), opener, nextSource.trim(), ...lines.slice(bodyEnd)];
      // A truncated reply can end mid-fence with no closing line; saving an
      // edit is the moment to close it so the block stays well-formed.
      if (bodyEnd >= lines.length) replaced.push(fence.marker);
      return replaced.join("\n");
    }
    index = body.nextIndex;
  }
  return null;
}

export function unwrapFullDocumentFence(source: string): string {
  const trimmed = source.trim();
  const match = /^```([A-Za-z0-9_-]*)\n([\s\S]*)\n```$/.exec(trimmed);
  if (!match) return source;
  const language = match[1] ?? "";
  const inner = match[2];
  // A reply that is only a diagram fence must stay a diagram. Unwrapping
  // ```mermaid / ```timeline would turn the body into prose.
  if (resolveDiagramBlock(language, inner)) return source;
  // Inner fences are fine when the outer one is a ```markdown wrapper (the
  // parser nests them); under any other tag they make the split ambiguous.
  if (inner.includes("```") && !NESTING_FENCE_LANGUAGES.has(language.toLowerCase())) return source;
  return inner;
}

export function markdownToDocumentHtml(source: string): string {
  return parseMarkdownBlocks(unwrapFullDocumentFence(source))
    .map((block, index) => {
      if (block.kind === "heading") {
        const tag = index === 0 && block.level <= 2 ? "h1" : block.level <= 3 ? "h2" : "h3";
        return `<${tag}>${inlineMarkdownToHtml(block.text)}</${tag}>`;
      }
      if (block.kind === "list") {
        const tag = block.ordered ? "ol" : "ul";
        return `<${tag}>${block.items.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join("")}</${tag}>`;
      }
      if (block.kind === "image") {
        const alt = escapeHtml(block.alt || block.title || "Document image");
        const caption = escapeHtml(block.title || block.alt || "Source image");
        return `<figure class="document-image-figure"><img src="${escapeAttribute(imageUrlWithFallback(block.url, block.alt))}" alt="${alt}"><figcaption>${caption}</figcaption></figure>`;
      }
      if (block.kind === "table") {
        const cellStyle = (index: number) => {
          const align = block.aligns[index];
          return align ? ` style="text-align: ${align}"` : "";
        };
        return `<table class="document-data-table"><thead><tr>${block.headers
          .map((header, index) => `<th${cellStyle(index)}>${inlineMarkdownToHtml(header)}</th>`)
          .join("")}</tr></thead><tbody>${block.rows
          .map(
            (row) =>
              `<tr>${block.headers
                .map((_, cellIndex) => `<td${cellStyle(cellIndex)}>${inlineMarkdownToHtml(row[cellIndex] ?? "")}</td>`)
                .join("")}</tr>`,
          )
          .join("")}</tbody></table>`;
      }
      if (block.kind === "rule") {
        return '<hr class="document-page-break">';
      }
      if (block.kind === "code") {
        // Diagram blocks become diagram figures: a client pass rasterizes the
        // source into a PNG data-URL <img> (inline SVG would be dropped by the
        // DOCX export and AI-revision walkers). The figure starts as a visual
        // placeholder — never the mermaid/JSON source — so Transfer to Drafts
        // shows a diagram slot rather than a code block.
        const diagram = resolveDiagramBlock(block.language, block.text);
        if (diagram) return documentDiagramFigureHtml(diagram.kind, diagram.source, diagram.notes);
        return `<pre class="document-code-block"><code>${escapeHtml(block.text)}</code></pre>`;
      }
      if (block.kind === "quote") {
        return `<blockquote>${block.lines.map((line) => inlineMarkdownToHtml(line)).join("<br>")}</blockquote>`;
      }
      if (block.kind === "math") {
        // Document HTML feeds DOCX export and editor walkers, so math stays
        // as its honest delimited source rather than KaTeX-generated markup.
        return `<p>${escapeHtml(block.source)}</p>`;
      }
      return `<p>${block.lines.map((line) => inlineMarkdownToHtml(line)).join("<br>")}</p>`;
    })
    .join("");
}

function documentDiagramFigureHtml(kind: "mermaid" | "structure", diagramSource: string, notes?: string[]) {
  const kindAttr = kind === "structure" ? ` data-diagram-kind="structure"` : "";
  const notesAttr = notes?.length ? ` data-diagram-notes="${encodeURIComponent(notes.join("\n"))}"` : "";
  const label = kind === "structure" ? "Structure diagram" : "Diagram";
  return (
    `<figure class="document-media-block document-diagram-figure" contenteditable="false"` +
    `${kindAttr}${notesAttr} data-diagram-source="${encodeURIComponent(diagramSource)}">` +
    `<div class="document-diagram-pending">${label} will render on this page.</div>` +
    `</figure>`
  );
}

export function markdownToPlainText(source: string): string {
  return parseMarkdownBlocks(source)
    .map((block) => {
      if (block.kind === "heading") return stripInlineMarkdown(block.text);
      if (block.kind === "image") return `[Image: ${stripInlineMarkdown(block.alt || block.title || "Document image")}] ${block.url}`;
      if (block.kind === "list") return block.items.map((item) => stripInlineMarkdown(item)).join("\n");
      if (block.kind === "table") {
        return [block.headers, ...block.rows]
          .map((row) => row.map(stripInlineMarkdown).join(" "))
          .join("\n");
      }
      if (block.kind === "rule") return "";
      if (block.kind === "code") return block.text;
      if (block.kind === "quote") return block.lines.map(stripInlineMarkdown).join("\n");
      if (block.kind === "math") return block.source;
      return block.lines.map(stripInlineMarkdown).join("\n");
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

const HTML_BLOCK_TAG_PATTERN =
  /<\/?(?:address|article|aside|blockquote|br|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)\b[^<>]*>/gi;
const HTML_TAG_PATTERN = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi;
const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&", apos: "'", gt: ">", hellip: "…", ldquo: "“", lsquo: "‘", lt: "<", mdash: "—",
  nbsp: " ", ndash: "–", quot: '"', rdquo: "”", rsquo: "’",
};
// Math output keeps its | bars (|x|, a | b) through the table-pipe cleanup.
const PREVIEW_MATH_BAR = "";

/**
 * One line of reading text for list rows such as Chat Feedback: the words a
 * reader sees in the rendered reply, with no markdown, HTML, or TeX source
 * left behind. Stored previews are often already flattened to a single line,
 * so block markers (headings, rules, table pipes) are also cleaned mid-line.
 * Use markdownToPlainText when the text must keep its honest source.
 */
export function markdownToPreviewText(source: string): string {
  const prose = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(HTML_BLOCK_TAG_PATTERN, " ")
    .replace(HTML_TAG_PATTERN, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, decodeHtmlEntity)
    .replace(
      /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g,
      (_match, display?: string, bracket?: string, inline?: string) => {
        const text = texToPlainText(display ?? bracket ?? inline ?? "").replace(/\|/g, PREVIEW_MATH_BAR);
        // Display math is its own block, so it keeps a word gap on each side.
        return inline === undefined ? ` ${text} ` : text;
      },
    )
    .replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))+(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/\[(?:K[1-9][0-9]?|U[1-9])\]/g, "")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/__([^_]+)__/g, "$1");
  return markdownToPlainText(prose)
    .replace(/(^|\s)#{1,6}(?=\s)/g, "$1")
    .replace(/\s*\|\s*/g, " ")
    .replace(/(^|\s)(?::?-{3,}:?|\*{3,}|_{3,})(?=\s|$)/g, "$1")
    .replace(new RegExp(PREVIEW_MATH_BAR, "g"), "|")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntity(entity: string, name: string) {
  if (name.startsWith("#")) {
    const hex = name[1] === "x" || name[1] === "X";
    const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }
  return HTML_NAMED_ENTITIES[name.toLowerCase()] ?? entity;
}

const TEX_SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ",
  sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ",
  Psi: "Ψ", Omega: "Ω",
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", approx: "≈", neq: "≠", ne: "≠",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", equiv: "≡", sim: "∼", propto: "∝", infty: "∞",
  to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐",
  leftrightarrow: "↔", Leftrightarrow: "⇔", partial: "∂", nabla: "∇", sum: "∑", prod: "∏",
  int: "∫", in: "∈", notin: "∉", subset: "⊂", cup: "∪", cap: "∩", forall: "∀", exists: "∃",
  degree: "°", circ: "∘", ldots: "…", cdots: "⋯", dots: "…", hbar: "ℏ",
};
const SUPERSCRIPT_CHARS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸",
  "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ",
};
const SUBSCRIPT_CHARS: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈",
  "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
};
// Escaped TeX characters sit behind placeholders so brace, alignment, and
// subscript cleanup never eats a literal \{, \&, or \_.
const TEX_ESCAPE_PLACEHOLDERS: Record<string, string> = {
  "{": "", "}": "", "&": "", "_": "",
};

function scriptText(value: string, chars: Record<string, string>, marker: string) {
  const compact = value.replace(/\s+/g, "");
  if (compact && [...compact].every((char) => chars[char])) {
    return [...compact].map((char) => chars[char]).join("");
  }
  return compact.length === 1 ? `${marker}${compact}` : `${marker}(${value.trim()})`;
}

function groupedTex(value: string) {
  return /[\s+\-=/]/.test(value.trim()) ? `(${value.trim()})` : value.trim();
}

/** Readable text for a TeX expression: E=mc^2 → E=mc², \frac{E}{c^2} → E/c². */
function texToPlainText(math: string): string {
  let text = math
    .replace(/\\\\/g, " ")
    .replace(/\\([{}%$&#_])/g, (_match, char: string) => TEX_ESCAPE_PLACEHOLDERS[char] ?? char)
    .replace(/\\\|/g, "‖")
    .replace(/\\(?:left|right)\.|\\(?:left|right|big|Big|bigg|Bigg)\b\s*/g, "")
    .replace(/\\(?:quad|qquad)\b|\\[,;: ]/g, " ")
    .replace(/\\!/g, "");
  // Innermost brace groups first, so nested arguments unwrap outward.
  for (let pass = 0; pass < 6; pass += 1) {
    const before = text;
    text = text
      .replace(/\^\{([^{}]*)\}/g, (_match, value: string) => scriptText(value, SUPERSCRIPT_CHARS, "^"))
      .replace(/_\{([^{}]*)\}/g, (_match, value: string) => scriptText(value, SUBSCRIPT_CHARS, "_"))
      .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, (_match, top: string, bottom: string) =>
        `${groupedTex(top)}/${groupedTex(bottom)}`,
      )
      .replace(/\\sqrt\{([^{}]*)\}/g, (_match, value: string) => `√${groupedTex(value)}`)
      .replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, "$1");
    if (text === before) break;
  }
  text = text
    .replace(/\^([0-9a-zA-Z+-])/g, (_match, value: string) => scriptText(value, SUPERSCRIPT_CHARS, "^"))
    .replace(/_([0-9])/g, (_match, value: string) => scriptText(value, SUBSCRIPT_CHARS, "_"))
    .replace(/\\([a-zA-Z]+)/g, (_match, name: string) => TEX_SYMBOLS[name] ?? name)
    .replace(/[{}]/g, "")
    .replace(/&/g, " ");
  for (const [char, placeholder] of Object.entries(TEX_ESCAPE_PLACEHOLDERS)) {
    text = text.split(placeholder).join(char);
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Display math delimited by $$…$$ or \[…\], on one line or spread across
 * lines until the closing delimiter. Only double-dollar delimiters count —
 * single-dollar text such as $5M is finance prose, never math — and an opener
 * with no closer falls back to the surrounding paragraph untouched. The block
 * keeps the exact original source so a KaTeX parse failure can render it.
 */
function readMathBlock(lines: string[], startIndex: number) {
  const first = (lines[startIndex] ?? "").trim();
  const delimiter = first.startsWith("$$")
    ? { open: "$$", close: "$$" }
    : first.startsWith("\\[")
      ? { open: "\\[", close: "\\]" }
      : null;
  if (!delimiter) return null;

  if (first.length > delimiter.open.length + delimiter.close.length && first.endsWith(delimiter.close)) {
    const math = first.slice(delimiter.open.length, first.length - delimiter.close.length).trim();
    if (!math) return null;
    return { block: { kind: "math" as const, source: first, math }, nextIndex: startIndex + 1 };
  }

  const inner = [first.slice(delimiter.open.length)];
  let cursor = startIndex + 1;
  while (cursor < lines.length) {
    const line = (lines[cursor] ?? "").trimEnd();
    // TeX display math never spans a paragraph break; stopping here keeps a
    // stray opener from swallowing unrelated prose.
    if (!line.trim()) return null;
    if (line.trim().endsWith(delimiter.close)) {
      inner.push(line.slice(0, line.lastIndexOf(delimiter.close)));
      const math = inner.join("\n").trim();
      if (!math) return null;
      const source = lines
        .slice(startIndex, cursor + 1)
        .map((sourceLine) => (sourceLine ?? "").trimEnd())
        .join("\n");
      return { block: { kind: "math" as const, source, math }, nextIndex: cursor + 1 };
    }
    inner.push(line);
    cursor += 1;
  }
  return null;
}

function readTable(lines: string[], startIndex: number) {
  const firstLine = (lines[startIndex] ?? "").trim();
  if (!looksLikeTableRow(firstLine)) return null;

  const firstCells = parseTableRow(firstLine);
  if (firstCells.length < 2) return null;

  let cursor = startIndex + 1;
  let hasSeparator = false;
  let aligns: MarkdownColumnAlign[] = [];
  if (cursor < lines.length && isTableSeparatorLine((lines[cursor] ?? "").trim())) {
    hasSeparator = true;
    aligns = tableAlignsFromSeparator((lines[cursor] ?? "").trim());
    cursor += 1;
  } else if (cursor >= lines.length || !looksLikeTableRow((lines[cursor] ?? "").trim())) {
    return null;
  }

  const rows: string[][] = [];
  while (cursor < lines.length) {
    const rowLine = (lines[cursor] ?? "").trim();
    if (!rowLine) break;
    if (isTableSeparatorLine(rowLine)) {
      cursor += 1;
      continue;
    }
    if (!looksLikeTableRow(rowLine)) break;
    const rowCells = parseTableRow(rowLine);
    if (rowCells.length < 2) break;
    rows.push(rowCells);
    cursor += 1;
  }

  if (!hasSeparator && rows.length === 0) return null;

  const columnCount = Math.max(firstCells.length, ...rows.map((row) => row.length));
  const headers = normalizeCells(firstCells, columnCount).map((cell, cellIndex) => cell || `Column ${cellIndex + 1}`);
  return {
    block: {
      kind: "table" as const,
      headers,
      rows: rows.map((row) => normalizeCells(row, columnCount)),
      aligns: Array.from({ length: columnCount }, (_, index) => aligns[index] ?? null),
    },
    nextIndex: cursor,
  };
}

function looksLikeTableRow(line: string) {
  if (!line.includes("|")) return false;
  if (isTableSeparatorLine(line)) return false;
  return parseTableRow(line).length >= 2;
}

function parseTableRow(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function normalizeCells(cells: string[], columnCount: number) {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? "");
}

function isTableSeparatorLine(line: string) {
  if (!line.includes("|")) return false;
  const cells = parseTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

/** Column alignment from a table's separator row (`---:` right, `:---:`
 * center, `:---`/`---` left). Numeric columns in an invoice or a budget are
 * unreadable ragged-left, and markdown already has the notation for it. */
function tableAlignsFromSeparator(line: string): MarkdownColumnAlign[] {
  return parseTableRow(line).map((cell) => {
    const trimmed = cell.trim();
    const left = trimmed.startsWith(":");
    const right = trimmed.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return null;
  });
}

function isRuleLine(line: string) {
  return /^([-*_])(?:\s*\1){2,}$/.test(line);
}

function inlineMarkdownToHtml(text: string) {
  const protectedLinks: string[] = [];
  const withProtectedLinks = escapeHtml(text)
    .replace(
      /!\[([^\]]*)\]\((https?:\/\/[^)\s]+|\/api\/[^)\s]+)\)/g,
      (_match, alt: string, url: string) => {
        const token = `APERTUREPROTECTEDLINK${protectedLinks.length}TOKEN`;
        protectedLinks.push(
          `<img class="document-inline-image" src="${imageUrlWithFallback(url, alt)}" alt="${alt}">`,
        );
        return token;
      },
    )
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/api\/[^)\s]+)\)/g,
      (_match, label: string, url: string) => {
        const token = `APERTUREPROTECTEDLINK${protectedLinks.length}TOKEN`;
        protectedLinks.push(
          `<a href="${url}" rel="noreferrer" target="_blank">${label}</a>`,
        );
        return token;
      },
    );
  const rendered = withProtectedLinks
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>");
  return protectedLinks.reduce(
    (value, link, index) =>
      value.replace(`APERTUREPROTECTEDLINK${index}TOKEN`, link),
    rendered,
  );
}

function stripInlineMarkdown(text: string) {
  const protectedLinks: string[] = [];
  const withProtectedLinks = text
    .replace(
      /!\[([^\]]*)\]\((https?:\/\/[^)\s]+|\/api\/[^)\s]+)\)/g,
      (_match, alt: string, url: string) => {
        const token = `APERTUREPROTECTEDLINK${protectedLinks.length}TOKEN`;
        protectedLinks.push(`[Image: ${alt || "Image"}] ${url}`);
        return token;
      },
    )
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/api\/[^)\s]+)\)/g,
      (_match, label: string, url: string) => {
        const token = `APERTUREPROTECTEDLINK${protectedLinks.length}TOKEN`;
        protectedLinks.push(`${label} ${url}`);
        return token;
      },
    );
  const stripped = withProtectedLinks
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .trim();
  return protectedLinks.reduce(
    (value, link, index) =>
      value.replace(`APERTUREPROTECTEDLINK${index}TOKEN`, link),
    stripped,
  );
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

export function imageUrlWithFallback(url: string, alt = "") {
  const fallback = imageFallbackUrl(url, alt);
  return fallback ?? url;
}

export function imageFallbackUrl(url: string, alt = "") {
  const haystack = `${url} ${alt}`.toLowerCase();
  const normalizedAlt = alt.trim().toLowerCase();
  if (
    normalizedAlt.startsWith("artemis ii crew portrait") ||
    normalizedAlt.startsWith("artemis 2 crew portrait") ||
    haystack.includes("artemis-ii-crew") ||
    haystack.includes("artemis%202%20crew%20portrait")
  ) {
    return "https://commons.wikimedia.org/wiki/Special:FilePath/Artemis%202%20Crew%20Portrait.jpg";
  }
  if (haystack.includes("reid") && haystack.includes("wiseman")) {
    return "https://commons.wikimedia.org/wiki/Special:FilePath/Reid%20Wiseman%20Artemis%202%20Crew%20Portrait.jpg";
  }
  if (haystack.includes("victor") && haystack.includes("glover")) {
    return "https://commons.wikimedia.org/wiki/Special:FilePath/Victor%20Glover%20Artemis%202%20Crew%20Portrait.jpg";
  }
  if (haystack.includes("christina") && haystack.includes("koch")) {
    return "https://commons.wikimedia.org/wiki/Special:FilePath/Christina%20Koch%20Artemis%202%20Crew%20Portrait.jpg";
  }
  if (haystack.includes("jeremy") && haystack.includes("hansen")) {
    return "https://commons.wikimedia.org/wiki/Special:FilePath/Jeremy%20Hansen%20Artemis%202%20Crew%20Portrait.jpg";
  }
  if (haystack.includes("artemis") && haystack.includes("crew")) {
    return "https://commons.wikimedia.org/wiki/Special:FilePath/Artemis%202%20Crew%20Portrait.jpg";
  }
  return null;
}
