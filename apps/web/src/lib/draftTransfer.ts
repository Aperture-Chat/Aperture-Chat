/**
 * Chat reply → Drafts. Transfer to Drafts asks which editor the reply should
 * open in (a document, a slide deck, or a spreadsheet) and suggests one from
 * what was asked for and what the reply holds. The spreadsheet route turns
 * the reply's markdown tables into a workbook: one sheet per table, a bold
 * frozen header row, and values typed as if entered by hand.
 */
import { detectDraftHandoff, type DraftHandoffKind } from "./draftHandoff";
import { parseMarkdownBlocks, type MarkdownBlock, type MarkdownTable } from "./markdown";
import { cellKey, columnLabel } from "./sheet/address";
import type { MeasureText } from "./sheet/autofit";
import { parseCellInput } from "./sheet/numberFormat";
import {
  DEFAULT_ROW_HEIGHT,
  SHEET_SCHEMA_VERSION,
  nextObjectId,
  parseWorkbook,
  uniqueSheetName,
  type CellStyle,
  type Sheet,
  type SheetCell,
  type SheetColumn,
  type SheetRow,
  type Workbook,
} from "./sheet/sheetModel";

export type DraftTransferFormat = DraftHandoffKind;

/* ------------------------------------------------------------------ */
/* Which editor fits                                                   */
/* ------------------------------------------------------------------ */

const SLIDE_LABEL = /^(?:slide\s*\d+\b|title slide\b|closing slide\b)/i;
const BOLD_LINE = /^\*\*(.+?)\*\*/;

function slideHeadings(blocks: MarkdownBlock[]): number {
  return blocks.filter((block) => {
    if (block.kind === "heading") return SLIDE_LABEL.test(plainCellText(block.text));
    if (block.kind !== "paragraph") return false;
    const bold = BOLD_LINE.exec(block.lines.join("\n").trim());
    return Boolean(bold && SLIDE_LABEL.test(bold[1]!.trim()));
  }).length;
}

function blockText(block: MarkdownBlock): string {
  switch (block.kind) {
    case "heading":
      return block.text;
    case "list":
      return block.items.join(" ");
    case "paragraph":
    case "quote":
      return block.lines.join(" ");
    case "code":
      return block.text;
    case "math":
      return block.source;
    default:
      return "";
  }
}

function tableText(table: MarkdownTable): string {
  return [table.headers, ...table.rows].flat().map(plainCellText).join(" ");
}

/** The editor a reply most likely belongs in. A request that named a
 * document, deck, or spreadsheet decides; otherwise slides ("Slide 1: …",
 * twice or more) read as a deck, and a reply that is mostly table reads as a
 * spreadsheet. Everything else is a document. */
export function suggestDraftFormat(content: string, request?: string | null): DraftTransferFormat {
  const asked = request ? detectDraftHandoff(request) : null;
  if (asked) return asked;
  const blocks = parseMarkdownBlocks(content);
  if (slideHeadings(blocks) >= 2) return "deck";
  let table = 0;
  let other = 0;
  for (const block of blocks) {
    if (block.kind === "table") table += tableText(block).length;
    else other += plainCellText(blockText(block)).length;
  }
  return table > 0 && table >= other ? "spreadsheet" : "document";
}

export function transferTableCount(content: string): number {
  return parseMarkdownBlocks(content).filter((block) => block.kind === "table").length;
}

/* ------------------------------------------------------------------ */
/* Tables → workbook                                                   */
/* ------------------------------------------------------------------ */

/** What a spreadsheet cell should hold for an inline-markdown cell: the
 * words a reader sees, without markers, link targets, or citation tags. */
export function plainCellText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)\s]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/api\/)[^)\s]*\)/g, "$1")
    .replace(/\s*\[[KU][1-9][0-9]?\]/g, "")
    .replace(/\\\((.+?)\\\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, "$1$2")
    .replace(/(^|\W)_([^_\s][^_]*?)_(?!\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

const WRAP_AFTER_CHARS = 40;
const MIN_COL_WIDTH = 64;
const MAX_COL_WIDTH = 320;
const ALIGNS: Record<string, CellStyle["align"]> = { left: "left", center: "center", right: "right" };

type TitledTable = { title: string | null; table: MarkdownTable };

function titledTables(blocks: MarkdownBlock[]): TitledTable[] {
  const found: TitledTable[] = [];
  let heading: string | null = null;
  for (const block of blocks) {
    if (block.kind === "heading") heading = plainCellText(block.text) || null;
    if (block.kind === "table") found.push({ title: heading, table: block });
  }
  return found;
}

/** A value typed the way the spreadsheet types what a person enters;
 * formula-looking text stays text, so nothing in a reply runs as a formula. */
function typedCell(text: string, style: CellStyle): SheetCell | undefined {
  const parsed = parseCellInput(text);
  if (parsed.kind === "empty") return undefined;
  const format = parsed.kind === "value" ? parsed.format : undefined;
  const value = parsed.kind === "value" ? parsed.value : text;
  const merged: CellStyle = { ...style, ...(format ? { format } : {}) };
  return Object.keys(merged).length ? { v: value, s: merged } : { v: value };
}

function columnWidth(texts: string[]): number {
  const longest = Math.max(...texts.map((text) => text.length));
  return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(longest * 7 + 16)));
}

/** Top-aligned like the chat table, so a tall row reads from its top. */
function bodyStyle(text: string, align: CellStyle["align"]): CellStyle {
  return {
    valign: "top",
    ...(align ? { align } : {}),
    ...(text.length > WRAP_AFTER_CHARS ? { wrap: true } : {}),
  };
}

/** Line height at the sheet's default 10pt, as the grid's AutoFit uses. */
const LINE_HEIGHT = ((10 * 4) / 3) * 1.2;
/** A cell's text room: its width less 4px of padding each side. */
const CELL_PADDING = 8;

/** Lines a paragraph takes when its words wrap greedily into `room`, as the
 * grid lays wrapped text out (a word that does not fit starts a new line). */
function wrappedLines(text: string, room: number, style: CellStyle, measure: MeasureText): number {
  const space = measure(" ", style);
  let lines = 1;
  let width = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const wordWidth = measure(word, style);
    const next = width ? width + space + wordWidth : wordWidth;
    lines += width && next > room ? 1 : 0;
    width = width && next > room ? wordWidth : next;
  }
  return lines;
}

/** Each row tall enough for its wrapped cells; rows that fit the default
 * height are left out. */
function rowHeights(cells: Record<string, SheetCell>, rowCount: number, widths: number[], measure: MeasureText): Record<string, SheetRow> {
  const rows: Record<string, SheetRow> = {};
  for (let row = 0; row < rowCount; row += 1) {
    const lines = widths.map((width, col) => {
      const cell = cells[cellKey(row, col)];
      return cell?.s?.wrap ? wrappedLines(String(cell.v), width - CELL_PADDING, cell.s, measure) : 1;
    });
    const height = Math.ceil(Math.max(...lines) * LINE_HEIGHT + CELL_PADDING);
    if (height > DEFAULT_ROW_HEIGHT) rows[String(row + 1)] = { h: height };
  }
  return rows;
}

/** A cell bold from end to end in the reply ("**Texas**"). */
const WHOLE_BOLD = /^\*\*[^*]+\*\*$/;

/** One cell of the sheet from one markdown cell: header cells stay text and
 * bold; body values are typed, and stay bold when the reply showed them so. */
function tableCell(markdown: string, header: boolean, align: CellStyle["align"]): SheetCell | undefined {
  const text = plainCellText(markdown);
  const style: CellStyle = { ...(header || WHOLE_BOLD.test(markdown.trim()) ? { bold: true } : {}), ...bodyStyle(text, align) };
  if (!header) return typedCell(text, style);
  return text ? { v: text, s: style } : undefined;
}

function tableSheet(table: MarkdownTable, name: string, id: string, measure: MeasureText): Sheet {
  const source = [table.headers, ...table.rows].map((row) => table.headers.map((_, col) => row[col] ?? ""));
  const cells: Record<string, SheetCell> = {};
  source.forEach((row, rowIndex) =>
    row.forEach((markdown, col) => {
      const cell = tableCell(markdown, rowIndex === 0, ALIGNS[table.aligns[col] ?? ""]);
      if (cell) cells[cellKey(rowIndex, col)] = cell;
    }),
  );
  const grid = source.map((row) => row.map(plainCellText));
  const widths = table.headers.map((_, col) => columnWidth(grid.map((row) => row[col] ?? "")));
  const cols: Record<string, SheetColumn> = {};
  widths.forEach((w, col) => {
    cols[columnLabel(col)] = { w };
  });
  const rows = rowHeights(cells, grid.length, widths, measure);
  return { id, name, cells, cols, rows, freeze: { rows: 1, cols: 0 } };
}

type SheetLine = { text: string; bold: boolean };
const plainLine = (text: string): SheetLine => ({ text: plainCellText(text), bold: false });
const rawLine = (text: string): SheetLine => ({ text, bold: false });

/** Each block's lines as they go down column A; rules and tables add none. */
const BLOCK_LINES: { [Kind in MarkdownBlock["kind"]]: (block: Extract<MarkdownBlock, { kind: Kind }>) => SheetLine[] } = {
  heading: (block) => [{ text: plainCellText(block.text), bold: true }],
  list: (block) => block.items.map(plainLine),
  paragraph: (block) => block.lines.map(plainLine),
  quote: (block) => block.lines.map(plainLine),
  code: (block) => block.text.split("\n").map(rawLine),
  math: (block) => [rawLine(block.source)],
  image: (block) => [rawLine(block.alt || block.title || "")],
  table: () => [],
  rule: () => [],
};

function blockLines(block: MarkdownBlock): SheetLine[] {
  return (BLOCK_LINES[block.kind] as (value: MarkdownBlock) => SheetLine[])(block);
}

const LINES_COL_WIDTH = MAX_COL_WIDTH * 2;

/** A reply with no table: its lines down column A, headings in bold. */
function linesSheet(blocks: MarkdownBlock[], id: string, measure: MeasureText): Sheet {
  const lines = blocks.flatMap(blockLines).filter((line) => line.text.trim());
  const cells: Record<string, SheetCell> = {};
  lines.forEach((line, row) => {
    const cell = line.bold ? { v: line.text, s: { bold: true } } : typedCell(line.text, bodyStyle(line.text, undefined));
    if (cell) cells[cellKey(row, 0)] = cell;
  });
  const rows = rowHeights(cells, lines.length, [LINES_COL_WIDTH], measure);
  return { id, name: "Sheet1", cells, cols: { A: { w: lines.length ? LINES_COL_WIDTH : MIN_COL_WIDTH } }, rows };
}

/** "History" is reserved by Excel as a sheet name. */
function sheetBaseName(title: string | null, index: number): string {
  const base = title ?? `Table ${index + 1}`;
  return base.trim().toLowerCase() === "history" ? `${base.trim()} table` : base;
}

/** Without a canvas to measure with, an average glyph width (what the grid
 * itself falls back to). */
const averageGlyphs: MeasureText = (text) => text.length * 7;

/** The reply as a workbook ready for the spreadsheet editor. `measure` is
 * the text width the grid draws with, so wrapped rows fit their text. */
export function workbookFromMarkdown(content: string, measure: MeasureText = averageGlyphs): { workbook: Workbook; tables: number } {
  const blocks = parseMarkdownBlocks(content);
  const found = titledTables(blocks);
  const sheets: Sheet[] = [];
  found.forEach(({ title, table }, index) => {
    sheets.push(tableSheet(table, uniqueSheetName(sheetBaseName(title, index), sheets), nextObjectId("sheet", sheets), measure));
  });
  if (!sheets.length) sheets.push(linesSheet(blocks, nextObjectId("sheet", sheets), measure));
  const parsed = parseWorkbook({ schema: SHEET_SCHEMA_VERSION, sheets });
  if (!parsed.ok) throw new Error(parsed.error);
  return { workbook: parsed.workbook, tables: found.length };
}
