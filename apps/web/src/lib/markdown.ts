export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "image"; alt: string; url: string; title?: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
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

    // Fence openers tolerate what models actually emit: longer fences and
    // info strings after the language (```mermaid {init: …}). Only the first
    // token becomes the language; extras never demote a block to prose.
    const fence = /^(`{3,})([^`]*)$/.exec(trimmed);
    if (fence) {
      flushParagraph();
      const language = (fence[2] ?? "").trim().split(/\s+/)[0] ?? "";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^`{3,}\s*$/.test((lines[index] ?? "").trim())) {
        codeLines.push((lines[index] ?? "").replace(/\s+$/g, ""));
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language, text: codeLines.join("\n") });
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

/**
 * Models often wrap a whole requested document in a single ``` fence; rendering
 * that verbatim turns the entire draft into one code block. Strip the fence only
 * when it encloses the complete reply (inner fenced snippets stay untouched).
 */
const MERMAID_LANGUAGE_ALIASES = new Set(["mermaid", "mmd", "mermaidjs", "mermaid-js"]);

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
  const tag = language.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (MERMAID_LANGUAGE_ALIASES.has(tag)) return true;
  if (tag && !["text", "txt", "plaintext", "plain"].includes(tag)) return false;
  return MERMAID_KEYWORD_PATTERN.test(mermaidDiagramSource(text));
}

/** Diagram source with fence artifacts removed — some models repeat the
 * language tag as the first line inside the block. */
export function mermaidDiagramSource(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length && !(lines[start] ?? "").trim()) start += 1;
  if (MERMAID_LANGUAGE_ALIASES.has((lines[start] ?? "").trim().toLowerCase())) start += 1;
  return lines.slice(start).join("\n").trim();
}

const STEWARD_DIAGRAM_LANGUAGES = new Set([
  "aperture-diagram",
  "aperture_diagram",
  "aperturediagram",
  "steward-diagram",
  "steward_diagram",
  "stewarddiagram",
]);

/** True when a fenced block is a Steward structure diagram (JSON card chart). */
export function isStewardDiagramBlock(language: string): boolean {
  return STEWARD_DIAGRAM_LANGUAGES.has(language.trim().toLowerCase().split(/\s+/)[0] ?? "");
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
    const fence = /^(`{3,})([^`]*)$/.exec((lines[index] ?? "").trim());
    if (!fence) {
      index += 1;
      continue;
    }
    const language = (fence[2] ?? "").trim().split(/\s+/)[0] ?? "";
    const bodyStart = index + 1;
    let bodyEnd = bodyStart;
    while (bodyEnd < lines.length && !/^`{3,}\s*$/.test((lines[bodyEnd] ?? "").trim())) bodyEnd += 1;
    const body = lines.slice(bodyStart, bodyEnd).join("\n");
    const matches = isStewardDiagramBlock(language)
      ? body.trim() === wanted
      : isMermaidBlock(language, body) && mermaidDiagramSource(body).trim() === wanted;
    if (matches) {
      const replaced = [...lines.slice(0, bodyStart), nextSource.trim(), ...lines.slice(bodyEnd)];
      // A truncated reply can end mid-fence with no closing line; saving an
      // edit is the moment to close it so the block stays well-formed.
      if (bodyEnd >= lines.length) replaced.push(fence[1]);
      return replaced.join("\n");
    }
    index = bodyEnd + 1;
  }
  return null;
}

export function unwrapFullDocumentFence(source: string): string {
  const trimmed = source.trim();
  const match = /^```[A-Za-z0-9_-]*\n([\s\S]*)\n```$/.exec(trimmed);
  if (!match) return source;
  const inner = match[1];
  return inner.includes("```") ? source : inner;
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
        return `<table class="document-data-table"><thead><tr>${block.headers
          .map((header) => `<th>${inlineMarkdownToHtml(header)}</th>`)
          .join("")}</tr></thead><tbody>${block.rows
          .map((row) => `<tr>${block.headers.map((_, cellIndex) => `<td>${inlineMarkdownToHtml(row[cellIndex] ?? "")}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`;
      }
      if (block.kind === "rule") {
        return '<hr class="document-page-break">';
      }
      if (block.kind === "code") {
        // Diagram blocks become diagram figures: a client pass rasterizes the
        // source into a PNG data-URL <img> (inline SVG would be dropped by the
        // DOCX export and AI-revision walkers). Until — or unless — that render
        // succeeds, the source stays visible as an honest code block.
        if (isStewardDiagramBlock(block.language)) {
          const diagramSource = block.text.trim();
          return (
            `<figure class="document-media-block document-diagram-figure" contenteditable="false"` +
            ` data-diagram-kind="structure" data-diagram-source="${encodeURIComponent(diagramSource)}">` +
            `<pre class="document-code-block document-diagram-source"><code>${escapeHtml(diagramSource)}</code></pre>` +
            `</figure>`
          );
        }
        if (isMermaidBlock(block.language, block.text)) {
          const diagramSource = mermaidDiagramSource(block.text);
          return (
            `<figure class="document-media-block document-diagram-figure" contenteditable="false"` +
            ` data-diagram-source="${encodeURIComponent(diagramSource)}">` +
            `<pre class="document-code-block document-diagram-source"><code>${escapeHtml(diagramSource)}</code></pre>` +
            `</figure>`
          );
        }
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
  if (cursor < lines.length && isTableSeparatorLine((lines[cursor] ?? "").trim())) {
    hasSeparator = true;
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
