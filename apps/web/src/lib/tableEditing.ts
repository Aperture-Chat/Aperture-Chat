/**
 * Editing a markdown table in a finished chat reply: pure operations on the
 * table's data, plus reading an edited cell back into inline markdown. The
 * reply keeps the table as markdown, so every edit is a new MarkdownTable
 * that `replaceMarkdownTable` writes back in place.
 */
import type { MarkdownTable } from "./markdown";

/** A cell address. Row -1 is the header row. */
export type TableCell = { row: number; col: number };
export type TableMove = "next" | "previous" | "down" | "up";

const NEW_COLUMN_HEADER = "New column";

export function tableCellText(table: MarkdownTable, cell: TableCell): string {
  return (cell.row < 0 ? table.headers[cell.col] : table.rows[cell.row]?.[cell.col]) ?? "";
}

export function setTableCell(table: MarkdownTable, cell: TableCell, text: string): MarkdownTable {
  if (cell.row < 0) {
    return { ...table, headers: table.headers.map((header, col) => (col === cell.col ? text : header)) };
  }
  return {
    ...table,
    rows: table.rows.map((row, index) =>
      index === cell.row ? row.map((value, col) => (col === cell.col ? text : value)) : row,
    ),
  };
}

/** A blank row below `afterRow`; below the header (-1) means first. */
export function insertTableRow(table: MarkdownTable, afterRow: number): MarkdownTable {
  const at = Math.max(0, afterRow + 1);
  const blank = table.headers.map(() => "");
  return { ...table, rows: [...table.rows.slice(0, at), blank, ...table.rows.slice(at)] };
}

export function deleteTableRow(table: MarkdownTable, row: number): MarkdownTable {
  return { ...table, rows: table.rows.filter((_, index) => index !== row) };
}

/** A body row can go while one other row remains; the header row stays. */
export function canDeleteRow(table: MarkdownTable, cell: TableCell): boolean {
  return cell.row >= 0 && table.rows.length > 1;
}

function insertAt<T>(items: T[], at: number, item: T): T[] {
  return [...items.slice(0, at), item, ...items.slice(at)];
}

export function insertTableColumn(table: MarkdownTable, afterCol: number): MarkdownTable {
  const at = afterCol + 1;
  return {
    headers: insertAt(table.headers, at, NEW_COLUMN_HEADER),
    rows: table.rows.map((row) => insertAt(row, at, "")),
    aligns: insertAt(table.aligns, at, null),
  };
}

export function deleteTableColumn(table: MarkdownTable, col: number): MarkdownTable {
  const keep = <T,>(_: T, index: number) => index !== col;
  return {
    headers: table.headers.filter(keep),
    rows: table.rows.map((row) => row.filter(keep)),
    aligns: table.aligns.filter(keep),
  };
}

/** Markdown needs two columns to read a table, so the last two stay. */
export function canDeleteColumn(table: MarkdownTable): boolean {
  return table.headers.length > 2;
}

/** Where Tab, Shift+Tab, Enter, and Shift+Enter go from `cell`, or null at
 * the table's edge. Tab runs along a row and wraps to the next one. */
export function moveTableCell(table: MarkdownTable, cell: TableCell, move: TableMove): TableCell | null {
  const width = table.headers.length;
  const lastRow = table.rows.length - 1;
  if (move === "down") return cell.row < lastRow ? { row: cell.row + 1, col: cell.col } : null;
  if (move === "up") return cell.row > -1 ? { row: cell.row - 1, col: cell.col } : null;
  const flat = (cell.row + 1) * width + cell.col + (move === "next" ? 1 : -1);
  if (flat < 0 || flat > (lastRow + 1) * width + width - 1) return null;
  return { row: Math.floor(flat / width) - 1, col: flat % width };
}

/* ------------------------------------------------------------------ */
/* Edited cell → inline markdown                                       */
/* ------------------------------------------------------------------ */

const SAFE_HREF = /^(https?:\/\/[^\s)]+|\/api\/[^\s)]+)$/;

/** Wraps text in a marker with any edge spaces moved outside it, since
 * "** bold**" is not bold in markdown. Empty formatting disappears. */
function wrapped(marker: string, inner: string): string {
  const core = inner.trim();
  if (!core) return inner.replace(/\S/g, "");
  const lead = inner.startsWith(" ") ? " " : "";
  const trail = inner.endsWith(" ") ? " " : "";
  return `${lead}${marker}${core}${marker}${trail}`;
}

const spaced = (_: Element, inner: string) => ` ${inner} `;

/** How each element the cell can hold reads back as markdown; any other
 * element keeps only its text. */
const ELEMENT_MARKDOWN: Record<string, (element: Element, inner: string) => string> = {
  STRONG: (_, inner) => wrapped("**", inner),
  B: (_, inner) => wrapped("**", inner),
  EM: (_, inner) => wrapped("*", inner),
  I: (_, inner) => wrapped("*", inner),
  CODE: (_, inner) => (inner.trim() ? `\`${inner.trim()}\`` : ""),
  A: (element, inner) => {
    const href = element.getAttribute("href") ?? "";
    return SAFE_HREF.test(href) && inner.trim() ? `[${inner.trim()}](${href})` : inner;
  },
  IMG: (element) => {
    const src = element.getAttribute("src") ?? "";
    return SAFE_HREF.test(src) ? `![${element.getAttribute("alt") ?? ""}](${src})` : "";
  },
  BR: spaced,
  DIV: spaced,
  P: spaced,
  LI: spaced,
};

function nodeMarkdown(node: Node): string {
  if (node instanceof Text) return node.data.replace(/\u00a0/g, " ");
  if (!(node instanceof Element)) return "";
  const inner = Array.from(node.childNodes, nodeMarkdown).join("");
  const read = ELEMENT_MARKDOWN[node.tagName];
  return read ? read(node, inner) : inner;
}

/** The inline markdown an edited table cell now holds: one line, the
 * formatting the cell can show (bold, italics, code, links), nothing else. */
export function inlineHtmlToMarkdown(root: Node): string {
  return Array.from(root.childNodes, nodeMarkdown).join("").replace(/\s+/g, " ").trim();
}
