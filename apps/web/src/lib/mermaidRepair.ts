/** Source-level fixes that keep model-written Mermaid on screen as a real
 * diagram, in Aperture's palette.
 *
 * Two layers:
 * - normalizeMermaidSource runs on every render. It removes theme overrides
 *   (`%%{init}%%`, front-matter config) and snaps classDef/style colors to the
 *   shared diagram palette so every figure looks like one designed set.
 * - repairMermaidSyntax runs only after Mermaid rejects a source. It fixes
 *   the slips models make most (unquoted labels with parentheses, `->` or `→`
 *   arrows, ids with spaces, `end` as a node, `//` comments) so the reader
 *   gets the real diagram instead of a simplified fallback drawing.
 *
 * Stored message text is never rewritten; only the rendered copy is.
 */

import { diagramPalette, diagramToneForColor, type DiagramPalette } from "./diagramTheme";

const FLOW_HEADER = /^(?:graph|flowchart)\b(?:\s+(?:TB|TD|BT|RL|LR))?/i;
const ANY_HEADER =
  /^(?:graph|flowchart|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|zenuml|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|kanban|architecture(?:-beta)?|radar(?:-beta)?|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|treemap(?:-beta)?)\b/;

/** First line that carries grammar (skips blanks and comments). */
export function mermaidHeaderLine(source: string): string {
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("%%")) return trimmed;
  }
  return "";
}

function isFlowchart(source: string) {
  return FLOW_HEADER.test(mermaidHeaderLine(source));
}

/* ------------------------------------------------------------------ */
/* Always-on normalization                                             */
/* ------------------------------------------------------------------ */

/** Removes invisible characters that break Mermaid's lexer (non-breaking
 * spaces, zero-width joiners, BOMs) — models and copy/paste add them. */
function normalizeWhitespace(source: string) {
  return source
    .replace(/\r\n?/g, "\n")
    .replace(/[   ]/g, " ")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/\t/g, "    ");
}

/** Theme overrides fight the shared palette (a `forest` or `dark` init block
 * in a light chat). Init directives are dropped; front matter keeps only its
 * title, which Mermaid renders as the diagram heading. */
function stripThemeOverrides(source: string) {
  let next = source.replace(/%%\{\s*init\s*:[\s\S]*?\}\s*%%\s*\n?/gi, "");
  const frontMatter = /^\s*---\n([\s\S]*?)\n---\s*\n/.exec(next);
  if (frontMatter) {
    const title = /^title\s*:\s*(.+)$/m.exec(frontMatter[1] ?? "")?.[1]?.trim();
    next = (title ? `---\ntitle: ${title}\n---\n` : "") + next.slice(frontMatter[0].length);
  }
  return next;
}

const COLOR_PROPS = new Set(["fill", "stroke", "color"]);

/** Rewrites one `prop:value,prop:value` style list so its colors come from
 * the palette role the model was reaching for. Non-color properties (dash
 * patterns, widths, font weight) survive. */
function snapStyleList(list: string, palette: DiagramPalette, link = false): string {
  const declarations = list
    .replace(/;+\s*$/, "")
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const props = new Map<string, string>();
  const rest: string[] = [];
  for (const declaration of declarations) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const key = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (COLOR_PROPS.has(key)) props.set(key, value);
    else rest.push(`${key}:${value}`);
  }
  if (!props.size) return list;
  const out: string[] = [];
  if (link) {
    const tone = props.has("stroke") ? diagramToneForColor(props.get("stroke") ?? "") : null;
    const stroke = tone === "ink" || tone === null || tone === "neutral" ? palette.edgeStrong : palette.tones[tone].line;
    out.push(`stroke:${stroke}`);
    if (props.has("color")) out.push(`color:${palette.text}`);
    return [...out, ...rest].join(",");
  }
  const basis = props.get("fill") ?? props.get("stroke") ?? "";
  const tone = diagramToneForColor(basis);
  if (tone === "ink") {
    out.push(`fill:${palette.ink}`, `stroke:${palette.inkBorder}`, `color:${palette.inkText}`);
  } else if (tone) {
    const colors = palette.tones[tone];
    if (props.has("fill")) out.push(`fill:${colors.fill}`);
    out.push(`stroke:${colors.border}`, `color:${colors.text}`);
  } else {
    return list;
  }
  return [...out, ...rest].join(",");
}

function snapPaletteColors(source: string, palette: DiagramPalette) {
  return source
    .split("\n")
    .map((line) => {
      const classDef = /^(\s*classDef\s+[\w,-]+\s+)(.+)$/.exec(line);
      if (classDef) return `${classDef[1]}${snapStyleList(classDef[2], palette)}`;
      const style = /^(\s*style\s+[\w-]+\s+)(.+)$/.exec(line);
      if (style) return `${style[1]}${snapStyleList(style[2], palette)}`;
      const linkStyle = /^(\s*linkStyle\s+[\w,\s]+?\s+)((?:stroke|color|fill)\s*:.+)$/.exec(line);
      if (linkStyle) return `${linkStyle[1]}${snapStyleList(linkStyle[2], palette, true)}`;
      return line;
    })
    .join("\n");
}

/** Safe, render-every-time normalization. Valid Mermaid stays valid. */
export function normalizeMermaidSource(source: string, dark = false): string {
  const cleaned = stripThemeOverrides(normalizeWhitespace(source));
  return snapPaletteColors(cleaned, diagramPalette(dark));
}

/* ------------------------------------------------------------------ */
/* Repairs (only after Mermaid rejected the source)                    */
/* ------------------------------------------------------------------ */

type ShapeDelimiters = { open: string; close: string };

// Longest openers first so `((` wins over `(` and `[[` over `[`.
const SHAPES: ShapeDelimiters[] = [
  { open: "(((", close: ")))" },
  { open: "([", close: "])" },
  { open: "[[", close: "]]" },
  { open: "[(", close: ")]" },
  { open: "((", close: "))" },
  { open: "{{", close: "}}" },
  { open: "[/", close: "/]" },
  { open: "[\\", close: "\\]" },
  { open: "[", close: "]" },
  { open: "(", close: ")" },
  { open: "{", close: "}" },
  { open: ">", close: "]" },
];

const RESERVED_IDS = new Set(["end", "graph", "subgraph", "style", "class", "classdef", "click", "linkstyle", "default"]);

// Text-on-link forms first so `-- of -->` is never read as a `--o` edge.
const LINK_PATTERN =
  /\s*(?:--\s+[^-|>]+?\s+-->|==\s+[^=|>]+?\s+==>|-\.\s+[^.|>]+?\s+\.->|<-->|<==>|<-\.->|-->|---|==>|===|-\.->|-\.-|~~~|--[ox](?=\s))(?:\|[^|]*\|)?\s*/g;

/** Hides label text (quoted strings and bracketed shape contents) behind
 * same-length filler so link detection only sees real statement syntax. */
function maskLabels(line: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  // UTF-16 units, not code points: the mask must stay index-aligned with the
  // original line (emoji labels are surrogate pairs).
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quoted) {
      out += char === '"' ? char : "\u0001";
      if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      out += char;
    } else if (char === "[" || char === "(" || char === "{") {
      depth += 1;
      out += char;
    } else if ((char === "]" || char === ")" || char === "}") && depth > 0) {
      depth -= 1;
      out += char;
    } else {
      out += depth > 0 ? "\u0001" : char;
    }
  }
  return out;
}

/** Applies `rewrite` to the statement syntax of a line, leaving quoted and
 * bracketed label text untouched. */
function outsideLabels(line: string, rewrite: (syntax: string) => string): string {
  const masked = maskLabels(line);
  let out = "";
  let syntax = "";
  for (let index = 0; index < line.length; index += 1) {
    const isLabel = masked[index] === "\u0001" || (masked[index] === '"' && line[index] === '"');
    if (isLabel) {
      out += rewrite(syntax) + line[index];
      syntax = "";
    } else {
      syntax += line[index];
    }
  }
  return out + rewrite(syntax);
}

function quoteLabel(raw: string): string {
  const text = raw.trim();
  if (/^".*"$/s.test(text) && !/^"`/.test(text)) {
    // Already quoted; interior quotes still end the string early.
    const inner = text.slice(1, -1);
    return `"${curlQuotes(inner)}"`;
  }
  if (/^"`[\s\S]*`"$/.test(text)) return text;
  return `"${curlQuotes(text)}"`;
}

function curlQuotes(text: string) {
  let open = true;
  return text.replace(/"/g, () => {
    const mark = open ? "“" : "”";
    open = !open;
    return mark;
  });
}

function slugId(text: string, used: Map<string, string>): string {
  const existing = used.get(text);
  if (existing) return existing;
  let base = text
    .normalize("NFKD")
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 28);
  if (!base || /^\d/.test(base)) base = `n_${base}`;
  if (RESERVED_IDS.has(base.toLowerCase())) base = `${base}_node`;
  let id = base;
  let counter = 2;
  const taken = new Set(used.values());
  while (taken.has(id)) id = `${base}_${counter++}`;
  used.set(text, id);
  return id;
}

/** Rewrites one node reference (`A`, `A[label]`, `User Login`, `end`) into a
 * form Mermaid accepts: quoted labels, safe ids, `:::class` kept. */
function repairNodeToken(token: string, used: Map<string, string>): string {
  const trimmed = token.trim().replace(/;+$/, "");
  if (!trimmed) return token;
  const classSuffix = /(:::[\w-]+)$/.exec(trimmed)?.[1] ?? "";
  const body = classSuffix ? trimmed.slice(0, -classSuffix.length) : trimmed;
  const idMatch = /^([A-Za-z_][\w.-]*)/.exec(body);
  if (idMatch) {
    let id = idMatch[1];
    const after = body.slice(id.length);
    if (RESERVED_IDS.has(id.toLowerCase())) id = `${id}_node`;
    if (!after) return `${id}${classSuffix}`;
    const shape = SHAPES.find((candidate) => after.startsWith(candidate.open) && after.endsWith(candidate.close));
    if (shape) {
      const inner = after.slice(shape.open.length, after.length - shape.close.length);
      return `${id}${shape.open}${quoteLabel(inner)}${shape.close}${classSuffix}`;
    }
    // Words after an id with no shape: the "id" is really a spaced label.
    if (/^\s+[^\s]/.test(after) && !/[[\](){}<>]/.test(after)) {
      return `${slugId(body, used)}[${quoteLabel(body)}]${classSuffix}`;
    }
    return `${id}${after}${classSuffix}`;
  }
  // No usable id at all (starts with a digit, quote, or symbol).
  if (!/[[\](){}]/.test(body)) return `${slugId(body, used)}[${quoteLabel(body)}]${classSuffix}`;
  return token;
}

function repairEdgeLabel(link: string): string {
  return link.replace(/\|([^|"]*)\|/, (_match, label: string) =>
    /[()[\]{}<>#;:]/.test(label) ? `|${quoteLabel(label)}|` : `|${label}|`,
  );
}

function repairFlowLine(line: string, used: Map<string, string>): string {
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  let trimmed = line.trim();
  if (!trimmed) return line;
  if (trimmed.startsWith("//")) return `${indent}%% ${trimmed.slice(2).trim()}`;
  if (trimmed.startsWith("%%")) return line;
  if (FLOW_HEADER.test(trimmed)) return `${indent}${trimmed.replace(/;\s*$/, "")}`;
  if (/^(?:classDef|class|style|linkStyle|click|direction)\b/.test(trimmed)) return line;
  if (/^end\s*;?$/.test(trimmed)) return `${indent}end`;
  const subgraph = /^subgraph\s+(.+)$/.exec(trimmed);
  if (subgraph) {
    const rest = subgraph[1].trim();
    if (/^[\w-]+\s*\[.*\]$/.test(rest) || /^[\w-]+$/.test(rest)) return line;
    return `${indent}subgraph ${slugId(rest, used)}[${quoteLabel(rest.replace(/^"|"$/g, ""))}]`;
  }
  // Trailing `// comment` and arrow spellings Mermaid flowcharts do not
  // accept — fixed only in statement syntax, never inside a label.
  trimmed = outsideLabels(trimmed, (syntax) =>
    syntax
      .replace(/\s+\/\/\s.*$/, "")
      .replace(/\s*(?:→|⟶|➔|➜|➝|⇒|⟹|➞)\s*/g, " --> ")
      .replace(/(^|[^-=.<>])->(?!>)/g, "$1 --> ")
      .replace(/<->/g, " <--> ")
      .replace(/(^|[^=<])=>(?!>)/g, "$1 ==> "),
  );
  const parts: string[] = [];
  const masked = maskLabels(trimmed);
  let cursor = 0;
  for (const match of masked.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    parts.push(trimmed.slice(cursor, start));
    parts.push(repairEdgeLabel(trimmed.slice(start, start + match[0].length).trim()));
    cursor = start + match[0].length;
  }
  parts.push(trimmed.slice(cursor));
  if (parts.length === 1) return `${indent}${repairNodeToken(parts[0], used)}`;
  const rebuilt = parts.map((part, index) =>
    index % 2 === 1
      ? part
      : part
          .split(/\s+&\s+/)
          .map((node) => repairNodeToken(node, used))
          .join(" & "),
  );
  return `${indent}${rebuilt.join(" ")}`;
}

function balanceSubgraphs(lines: string[]): string[] {
  let open = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^subgraph\b/.test(trimmed)) open += 1;
    else if (/^end\s*;?$/.test(trimmed)) open = Math.max(0, open - 1);
  }
  return open > 0 ? [...lines, ...Array.from({ length: open }, () => "end")] : lines;
}

function repairFlowchart(source: string): string {
  const used = new Map<string, string>();
  const lines = source.split("\n").map((line) => repairFlowLine(line, used));
  return balanceSubgraphs(lines).join("\n");
}

function repairPie(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const slice = /^(\s*)("?)([^":]+?)\2\s*:\s*([^\n]+)$/.exec(line);
      if (!slice || /^\s*(?:pie|title)\b/i.test(line)) return line;
      const value = Number(slice[4].replace(/[,$%\s]/g, "").replace(/[^\d.-]/g, ""));
      if (!Number.isFinite(value) || value < 0) return line;
      return `${slice[1]}"${slice[3].trim().replace(/"/g, "'")}" : ${value}`;
    })
    .join("\n");
}

function repairXyChart(source: string): string {
  return source
    .replace(/^(\s*)xychart\b(?!-beta)/m, "$1xychart-beta")
    .split("\n")
    .map((line) => {
      const axis = /^(\s*x-axis\s*(?:"[^"]*"\s*)?)\[(.*)\]\s*$/.exec(line);
      if (axis) {
        const items = axis[2]
          .split(",")
          .map((item) => item.trim().replace(/^"|"$/g, ""))
          .filter(Boolean)
          .map((item) => `"${item.replace(/"/g, "'")}"`);
        return `${axis[1]}[${items.join(", ")}]`;
      }
      const series = /^(\s*(?:bar|line)\s*(?:"[^"]*"\s*)?)\[(.*)\]\s*$/.exec(line);
      if (series) {
        const values = series[2].split(",").map((value) => value.replace(/[,$%\s]/g, "").replace(/[^\d.eE+-]/g, ""));
        return `${series[1]}[${values.join(", ")}]`;
      }
      return line;
    })
    .join("\n");
}

/** Best-effort syntax repair for a source Mermaid rejected. Returns the input
 * unchanged when no repair applies. */
export function repairMermaidSyntax(source: string): string {
  let next = source;
  const header = mermaidHeaderLine(next);
  // Edges with no header at all: models sometimes drop the first line.
  if (!ANY_HEADER.test(header) && /(?:-->|---|==>|→)/.test(next)) next = `flowchart TD\n${next}`;
  if (isFlowchart(next)) return repairFlowchart(next);
  if (/^pie\b/i.test(mermaidHeaderLine(next))) return repairPie(next);
  if (/^xychart\b/i.test(mermaidHeaderLine(next))) return repairXyChart(next);
  return next
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? line.replace("//", "%%") : line))
    .join("\n");
}
