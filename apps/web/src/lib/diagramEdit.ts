/** Structured editing for Mermaid flowchart sources.
 *
 * The diagram editor lets non-technical readers retitle, reword, delete, and
 * add boxes without touching Mermaid syntax. Edits are surgical text splices
 * against the original source so everything the parser does not model —
 * classDefs, styles, comments, subgraphs, init directives — survives verbatim.
 */

export type DiagramStatement = {
  start: number;
  end: number;
  text: string;
};

export type EditableDiagramNode = {
  id: string;
  /** First label line with markdown bold markers stripped. */
  title: string;
  /** Remaining label lines joined with newlines. */
  detail: string;
  statementIndex: number;
};

export type DiagramEditModel = {
  /** True when the source is a flowchart/graph and box-level editing applies. */
  editable: boolean;
  nodes: EditableDiagramNode[];
};

/** Bracket pairs for flowchart node shapes, longest openers first so `[[` is
 * never misread as `[`. */
const NODE_SHAPES: Array<[string, string]> = [
  ["([", "])"],
  ["[[", "]]"],
  ["[(", ")]"],
  ["((", "))"],
  ["{{", "}}"],
  ["[/", "/]"],
  ["[\\", "\\]"],
  ["[", "]"],
  ["(", ")"],
  ["{", "}"],
  [">", "]"],
];

const STATEMENT_KEYWORDS = new Set([
  "flowchart",
  "graph",
  "subgraph",
  "end",
  "classdef",
  "class",
  "style",
  "linkstyle",
  "click",
  "direction",
  "acctitle",
  "accdescr",
]);

/** Splits a Mermaid source into statements: one per newline, except newlines
 * inside markdown-string labels ("`…`"), which belong to their statement. */
export function splitDiagramStatements(source: string): DiagramStatement[] {
  const statements: DiagramStatement[] = [];
  let start = 0;
  let inQuote = false;
  let quoteIsMarkdown = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inQuote) {
      if (char === '"' && (!quoteIsMarkdown || source[index - 1] === "`")) inQuote = false;
      continue;
    }
    if (char === '"') {
      inQuote = true;
      quoteIsMarkdown = source[index + 1] === "`";
      continue;
    }
    if (char === "\n") {
      statements.push({ start, end: index, text: source.slice(start, index) });
      start = index + 1;
    }
  }
  statements.push({ start, end: source.length, text: source.slice(start) });
  return statements;
}

function statementKeyword(text: string): string {
  return (/^\s*([A-Za-z]+)/.exec(text)?.[1] ?? "").toLowerCase();
}

/** Text with quoted spans blanked out (same length), so operator and token
 * scans never match inside label text. */
function maskQuotedSpans(text: string): string {
  let masked = "";
  let inQuote = false;
  let quoteIsMarkdown = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inQuote) {
      if (char === '"' && (!quoteIsMarkdown || text[index - 1] === "`")) {
        inQuote = false;
        masked += '"';
      } else {
        masked += " ";
      }
      continue;
    }
    if (char === '"') {
      inQuote = true;
      quoteIsMarkdown = text[index + 1] === "`";
    }
    masked += char;
  }
  return masked;
}

function isEdgeStatement(text: string): boolean {
  const masked = maskQuotedSpans(text);
  return /--|-\.|==|~~/.test(masked);
}

type ParsedNodeStatement = {
  id: string;
  opener: string;
  closer: string;
  /** Offsets of the raw label within the statement text. */
  labelStart: number;
  labelEnd: number;
  /** The `:::class` suffix (possibly empty). */
  suffix: string;
};

/** Parses a statement that is purely `id[shape "label"]:::classes`; returns
 * null for headers, edges, keywords, and anything else. */
function parseNodeStatement(text: string): ParsedNodeStatement | null {
  const keyword = statementKeyword(text);
  if (STATEMENT_KEYWORDS.has(keyword) || text.trim().startsWith("%%")) return null;
  if (isEdgeStatement(text)) return null;
  const head = /^\s*([A-Za-z][A-Za-z0-9_-]*)/.exec(text);
  if (!head) return null;
  const openerAt = head[0].length;
  const shape = NODE_SHAPES.find(([opener]) => text.startsWith(opener, openerAt));
  if (!shape) return null;
  const [opener, closer] = shape;
  const tail = text.slice(openerAt + opener.length);
  const closerAt = tail.lastIndexOf(closer);
  if (closerAt < 0) return null;
  const suffix = tail.slice(closerAt + closer.length);
  if (!/^(?::::[A-Za-z0-9_,-]+)?\s*$/.test(suffix)) return null;
  return {
    id: head[1],
    opener,
    closer,
    labelStart: openerAt + opener.length,
    labelEnd: openerAt + opener.length + closerAt,
    suffix,
  };
}

function decodeLabel(raw: string): { title: string; detail: string } {
  let text = raw.trim();
  const quoted = text.startsWith('"') && text.endsWith('"') && text.length >= 2;
  if (quoted) text = text.slice(1, -1);
  const markdown = text.startsWith("`") && text.endsWith("`") && text.length >= 2;
  if (markdown) text = text.slice(1, -1);
  const lines = text
    .replace(/<br\s*\/?>/gi, "\n")
    .split("\n")
    .map((line) => line.trim());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const title = (lines.shift() ?? "").replace(/^\*\*(.*)\*\*$/, "$1");
  return { title, detail: lines.join("\n") };
}

/** Label text that cannot terminate the quoted/markdown string early. */
function sanitizeLabelLine(line: string): string {
  return line.replace(/`/g, "'").replace(/"/g, "'").trim();
}

function encodeLabel(title: string, detail: string): string {
  const titleLine = sanitizeLabelLine(title) || "Untitled";
  const detailLines = detail
    .split("\n")
    .map(sanitizeLabelLine)
    .filter((line) => line !== "");
  if (detailLines.length === 0) return `"${titleLine}"`;
  return `"\`**${titleLine}**\n${detailLines.join("\n")}\`"`;
}

export function parseDiagramModel(source: string): DiagramEditModel {
  const statements = splitDiagramStatements(source);
  const kind = statements.map((statement) => statementKeyword(statement.text)).find((word) => word !== "");
  const editable = kind === "flowchart" || kind === "graph";
  if (!editable) return { editable: false, nodes: [] };
  const nodes: EditableDiagramNode[] = [];
  const seen = new Set<string>();
  statements.forEach((statement, statementIndex) => {
    const parsed = parseNodeStatement(statement.text);
    if (!parsed || seen.has(parsed.id)) return;
    seen.add(parsed.id);
    const { title, detail } = decodeLabel(statement.text.slice(parsed.labelStart, parsed.labelEnd));
    nodes.push({ id: parsed.id, title, detail, statementIndex });
  });
  return { editable, nodes };
}

function spliceStatement(source: string, statement: DiagramStatement, replacement: string | null): string {
  if (replacement !== null) {
    return source.slice(0, statement.start) + replacement + source.slice(statement.end);
  }
  // Removing a statement swallows its trailing newline so no blank line stays.
  const end = source[statement.end] === "\n" ? statement.end + 1 : statement.end;
  return source.slice(0, statement.start) + source.slice(end);
}

/** Rewrites one node's label; returns null when the node is not found. */
export function updateDiagramNodeText(source: string, nodeId: string, title: string, detail: string): string | null {
  const statements = splitDiagramStatements(source);
  for (const statement of statements) {
    const parsed = parseNodeStatement(statement.text);
    if (!parsed || parsed.id !== nodeId) continue;
    const next =
      statement.text.slice(0, parsed.labelStart) + encodeLabel(title, detail) + statement.text.slice(parsed.labelEnd);
    return spliceStatement(source, statement, next);
  }
  return null;
}

function referencesNode(maskedText: string, nodeId: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])${nodeId}([^A-Za-z0-9_-]|$)`).test(maskedText);
}

/** Deletes a node: its definition, every edge touching it, its `style`/`click`
 * lines, and its entry in `class` lists. */
export function removeDiagramNode(source: string, nodeId: string): string {
  const statements = splitDiagramStatements(source);
  let result = source;
  for (let index = statements.length - 1; index >= 0; index--) {
    const statement = statements[index];
    const keyword = statementKeyword(statement.text);
    const masked = maskQuotedSpans(statement.text);
    if (parseNodeStatement(statement.text)?.id === nodeId) {
      result = spliceStatement(result, statement, null);
      continue;
    }
    if (isEdgeStatement(statement.text) && !STATEMENT_KEYWORDS.has(keyword) && referencesNode(masked, nodeId)) {
      result = spliceStatement(result, statement, null);
      continue;
    }
    if ((keyword === "style" || keyword === "click") && referencesNode(masked, nodeId)) {
      result = spliceStatement(result, statement, null);
      continue;
    }
    if (keyword === "class") {
      const match = /^(\s*class\s+)([A-Za-z0-9_,\s-]+?)(\s+[A-Za-z0-9_-]+\s*)$/.exec(statement.text);
      if (!match) continue;
      const ids = match[2].split(",").map((token) => token.trim()).filter((token) => token !== "");
      if (!ids.includes(nodeId)) continue;
      const remaining = ids.filter((token) => token !== nodeId);
      result = spliceStatement(
        result,
        statement,
        remaining.length > 0 ? `${match[1]}${remaining.join(",")}${match[3].replace(/\s*$/, "")}` : null,
      );
    }
  }
  return result;
}

function existingTokens(source: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of maskQuotedSpans(source).matchAll(/[A-Za-z][A-Za-z0-9_-]*/g)) tokens.add(match[0]);
  return tokens;
}

/** Appends a new box (optionally linked from an existing one) and returns the
 * updated source plus the generated node id. */
export function addDiagramNode(
  source: string,
  title: string,
  detail: string,
  connectFromId?: string,
): { source: string; id: string } {
  const tokens = existingTokens(source);
  let counter = 1;
  let id = `BOX${counter}`;
  while (tokens.has(id)) {
    counter += 1;
    id = `BOX${counter}`;
  }
  const lines = [`  ${id}[${encodeLabel(title, detail)}]`];
  if (connectFromId) lines.push(`  ${connectFromId} --> ${id}`);
  const base = source.replace(/\s*$/, "");
  return { source: `${base}\n${lines.join("\n")}\n`, id };
}
