/** Copy, cut, and paste for the spreadsheet editor.
 *
 * Copies carry two forms: the workbook's own cells (formulas, styles, notes)
 * for pasting inside Aperture, and plain TSV + an HTML table for pasting into
 * Excel, Google Sheets, Word, or email. Pastes from outside read the HTML
 * table Excel and Sheets put on the clipboard, falling back to TSV text.
 */

import { type CellRange, cellKey, rangeContains } from "./address";
import { type BlockMove, adjustFormulaForBlockMove, shiftFormula } from "./formula/references";
import { escapeHtml } from "./html";
import { type Scalar, isError } from "./formula/values";
import { cellFromInput, getCell, updateSheet, writeCells } from "./sheetOps";
import { type CellStyle, type Sheet, type SheetCell, type Workbook, isHexColor } from "./sheetModel";

export type ClipBlock = {
  rows: number;
  cols: number;
  cells: (SheetCell | null)[][];
  /** Computed values at copy time, for "paste values" of formula cells. */
  values?: Scalar[][];
  /** Where the block was copied from, so formulas shift relative to it. */
  origin: { sheetId: string; range: CellRange } | null;
  cut: boolean;
};

export type PasteMode = "all" | "values" | "formats" | "formulas" | "transpose";

export function copyBlock(sheet: Sheet, range: CellRange, cut = false, valueOf?: (row: number, col: number) => Scalar): ClipBlock {
  const cells: (SheetCell | null)[][] = [];
  const values: Scalar[][] = [];
  for (let row = range.r1; row <= range.r2; row += 1) {
    const line: (SheetCell | null)[] = [];
    const valueLine: Scalar[] = [];
    for (let col = range.c1; col <= range.c2; col += 1) {
      const cell = getCell(sheet, row, col);
      line.push(cell ? structuredClone(cell) : null);
      valueLine.push(valueOf ? valueOf(row, col) : (cell?.v ?? null));
    }
    cells.push(line);
    values.push(valueLine);
  }
  return { rows: range.r2 - range.r1 + 1, cols: range.c2 - range.c1 + 1, cells, values, origin: { sheetId: sheet.id, range }, cut };
}

/** TSV of the displayed text, the format every spreadsheet app pastes. */
export function blockToTsv(texts: string[][]): string {
  return texts
    .map((line) => line.map((text) => (/[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)).join("\t"))
    .join("\r\n");
}

function styleCss(style: CellStyle | undefined): string {
  if (!style) return "";
  return [...emphasisCss(style), ...colorAndLayoutCss(style)].join(";");
}

function emphasisCss(style: CellStyle): string[] {
  const parts: string[] = [];
  if (style.bold) parts.push("font-weight:700");
  if (style.italic) parts.push("font-style:italic");
  const decorations = [style.underline && "underline", style.strike && "line-through"].filter(Boolean);
  if (decorations.length) parts.push(`text-decoration:${decorations.join(" ")}`);
  return parts;
}

function colorAndLayoutCss(style: CellStyle): string[] {
  const parts: string[] = [];
  if (style.color) parts.push(`color:${style.color}`);
  if (style.fill) parts.push(`background:${style.fill}`);
  if (style.align) parts.push(`text-align:${style.align}`);
  if (style.size) parts.push(`font-size:${style.size}pt`);
  return parts;
}

/** An HTML table with the visible formatting, for rich pastes elsewhere. */
export function blockToHtml(texts: string[][], styles: (CellStyle | undefined)[][]): string {
  const rows = texts.map((line, r) => `<tr>${line.map((text, c) => {
    const css = styleCss(styles[r]?.[c]);
    return `<td${css ? ` style="${css}"` : ""}>${escapeHtml(text)}</td>`;
  }).join("")}</tr>`);
  return `<table><tbody>${rows.join("")}</tbody></table>`;
}

type TsvState = { rows: string[][]; row: string[]; field: string; quoted: boolean };

/** Parses TSV text (quoted fields may hold tabs and newlines). */
export function parseTsv(text: string): string[][] {
  const state: TsvState = { rows: [], row: [], field: "", quoted: false };
  const body = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  for (let index = 0; index < body.length; index += 1) {
    if (state.quoted) index = readQuotedChar(state, body, index);
    else readPlainChar(state, body[index]);
  }
  endTsvRow(state);
  return state.rows;
}

/** Inside quotes, "" is one quote and a lone " closes the field; returns the last index read. */
function readQuotedChar(state: TsvState, body: string, index: number): number {
  const ch = body[index];
  if (ch !== '"') state.field += ch;
  else if (body[index + 1] === '"') {
    state.field += '"';
    return index + 1;
  } else state.quoted = false;
  return index;
}

function readPlainChar(state: TsvState, ch: string): void {
  if (ch === '"' && state.field === "") state.quoted = true;
  else if (ch === "\t") endTsvField(state);
  else if (ch === "\n") endTsvRow(state);
  else state.field += ch;
}

function endTsvField(state: TsvState): void {
  state.row.push(state.field);
  state.field = "";
}

function endTsvRow(state: TsvState): void {
  endTsvField(state);
  state.rows.push(state.row);
  state.row = [];
}

function cssColor(value: string | null): string | undefined {
  if (!value) return undefined;
  const hex = value.trim().toLowerCase();
  if (isHexColor(hex)) return hex;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(hex);
  if (!rgb) return undefined;
  return `#${[rgb[1], rgb[2], rgb[3]].map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
}

/** Reads the first HTML table on the clipboard (Excel, Sheets, Word, web). */
export function parseHtmlTable(html: string): { texts: string[][]; styles: (CellStyle | undefined)[][] } | null {
  if (typeof DOMParser === "undefined" || !/<table/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;
  const texts: string[][] = [];
  const styles: (CellStyle | undefined)[][] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const line = htmlRow(tr);
    texts.push(line.texts);
    styles.push(line.styles);
  }
  return texts.length ? { texts, styles } : null;
}

/** One table row; a cell spanning columns is followed by blanks for the columns it covers. */
function htmlRow(tr: Element): { texts: string[]; styles: (CellStyle | undefined)[] } {
  const texts: string[] = [];
  const styles: (CellStyle | undefined)[] = [];
  for (const td of Array.from(tr.querySelectorAll("td,th"))) {
    const element = td as HTMLElement;
    texts.push(htmlCellText(element));
    styles.push(htmlCellStyle(element));
    const span = Math.max(1, Number(td.getAttribute("colspan") ?? 1));
    for (let extra = 1; extra < span && extra < 50; extra += 1) {
      texts.push("");
      styles.push(undefined);
    }
  }
  return { texts, styles };
}

function htmlCellText(element: HTMLElement): string {
  return (element.innerText ?? element.textContent ?? "").replace(/ /g, " ").trim();
}

function htmlCellStyle(element: HTMLElement): CellStyle | undefined {
  const css = element.style;
  const style: CellStyle = {
    ...(htmlCellBold(element) ? { bold: true } : {}),
    ...(css.fontStyle === "italic" || element.querySelector("i,em") ? { italic: true } : {}),
    ...htmlCellColors(css),
  };
  return Object.keys(style).length ? style : undefined;
}

function htmlCellBold(element: HTMLElement): boolean {
  const weight = element.style.fontWeight;
  return weight === "bold" || Number(weight) >= 600 || element.tagName === "TH" || Boolean(element.querySelector("b,strong"));
}

/** Text and fill colors, leaving out the black text and white fill every cell has by default. */
function htmlCellColors(css: CSSStyleDeclaration): CellStyle {
  const color = cssColor(css.color);
  const fill = cssColor(css.backgroundColor || css.background);
  return { ...(color && color !== "#000000" ? { color } : {}), ...(fill && fill !== "#ffffff" ? { fill } : {}) };
}

/** A clip block from text that came from outside the workbook. */
export function externalBlock(texts: string[][], styles?: (CellStyle | undefined)[][]): ClipBlock {
  const cols = Math.max(1, ...texts.map((line) => line.length));
  const cells = texts.map((line, r) => Array.from({ length: cols }, (_, c) => {
    const cell = cellFromInput(styles?.[r]?.[c] ? { s: styles[r][c] } : undefined, line[c] ?? "");
    return cell;
  }));
  return { rows: texts.length, cols, cells, origin: null, cut: false };
}

function transposeBlock(block: ClipBlock): ClipBlock {
  const cells = Array.from({ length: block.cols }, (_, c) => Array.from({ length: block.rows }, (_, r) => block.cells[r][c]));
  const values = block.values && Array.from({ length: block.cols }, (_, c) => Array.from({ length: block.rows }, (_, r) => block.values![r][c]));
  return { ...block, rows: block.cols, cols: block.rows, cells, values, origin: null };
}

type CellUpdate = { row: number; col: number; cell: SheetCell | null };
/** Where one block cell lands: the sheet cell, its place in the block, and its value at copy time. */
type Landing = { row: number; col: number; r: number; c: number; computed: Scalar };

/** A selection that is a whole multiple of the block repeats it; anything else pastes it once. */
function tileCount(selected: number, size: number): number {
  return selected % size === 0 ? selected / size : 1;
}

/** Pastes a block with its top-left at (row, col). A selection that is an
 * exact multiple of the block tiles it, as Excel does. Returns the range that
 * was written. */
export function pasteBlock(
  workbook: Workbook,
  sheetId: string,
  at: CellRange,
  block: ClipBlock,
  mode: PasteMode = "all",
): { workbook: Workbook; range: CellRange } {
  const move = blockMove(workbook, sheetId, at, block, mode);
  const source = move ? relocateMovedFormulas(block, move) : mode === "transpose" ? transposeBlock(block) : block;
  // A move lands once, at the top-left of the selection; a copy tiles to fill it.
  const tileRows = move ? 1 : tileCount(at.r2 - at.r1 + 1, source.rows);
  const tileCols = move ? 1 : tileCount(at.c2 - at.c1 + 1, source.cols);
  const range = { r1: at.r1, c1: at.c1, r2: at.r1 + source.rows * tileRows - 1, c2: at.c1 + source.cols * tileCols - 1 };
  const moved = move ? moveOutOfOrigin(workbook, block.origin!, move) : workbook;
  const next = updateSheet(moved, sheetId, (sheet) => {
    const updates: CellUpdate[] = [];
    for (let tr = 0; tr < tileRows; tr += 1) {
      for (let tc = 0; tc < tileCols; tc += 1) {
        tileUpdates(updates, sheet, source, { row: range.r1 + tr * source.rows, col: range.c1 + tc * source.cols }, mode, block.cut);
      }
    }
    return writeCells(sheet, updates);
  });
  return { workbook: next, range };
}

/** Cut + paste of everything is a move (Excel's); pasting a cut block as
 * values, formats, or transposed copies it instead. */
function blockMove(workbook: Workbook, sheetId: string, at: CellRange, block: ClipBlock, mode: PasteMode): BlockMove | null {
  const origin = block.origin;
  if (!block.cut || !origin || mode !== "all") return null;
  const from = workbook.sheets.find((sheet) => sheet.id === origin.sheetId);
  const to = workbook.sheets.find((sheet) => sheet.id === sheetId);
  if (!from || !to) return null;
  return { fromSheet: from.name, toSheet: to.name, source: origin.range, dRow: at.r1 - origin.range.r1, dCol: at.c1 - origin.range.c1 };
}

/** The moved cells' own formulas: references into the block follow it, and
 * references to other cells keep pointing where they did. */
function relocateMovedFormulas(block: ClipBlock, move: BlockMove): ClipBlock {
  const cells = block.cells.map((row) => row.map((cell) => (cell?.f ? { ...cell, f: adjustFormulaForBlockMove(cell.f, move.fromSheet, move, move.toSheet) } : cell)));
  return { ...block, cells };
}

/** Clears the source, then re-points every formula in the workbook that
 * referenced the moved block. */
function moveOutOfOrigin(workbook: Workbook, origin: NonNullable<ClipBlock["origin"]>, move: BlockMove): Workbook {
  const cleared = updateSheet(workbook, origin.sheetId, (sheet) => clearCells(sheet, origin.range));
  return { ...cleared, sheets: cleared.sheets.map((sheet) => repointMovedFormulas(sheet, move)) };
}

function clearCells(sheet: Sheet, range: CellRange): Sheet {
  const updates: CellUpdate[] = [];
  for (let row = range.r1; row <= range.r2; row += 1) {
    for (let col = range.c1; col <= range.c2; col += 1) updates.push({ row, col, cell: null });
  }
  return writeCells(sheet, updates);
}

function repointMovedFormulas(sheet: Sheet, move: BlockMove): Sheet {
  const cells: Record<string, SheetCell> = {};
  for (const [address, cell] of Object.entries(sheet.cells)) {
    cells[address] = cell.f ? { ...cell, f: adjustFormulaForBlockMove(cell.f, sheet.name, move) } : cell;
  }
  return { ...sheet, cells };
}

/** Updates for one copy of the block with its top-left at `top`. */
function tileUpdates(updates: CellUpdate[], sheet: Sheet, source: ClipBlock, top: { row: number; col: number }, mode: PasteMode, cut: boolean): void {
  for (let r = 0; r < source.rows; r += 1) {
    for (let c = 0; c < source.cols; c += 1) {
      const row = top.row + r;
      const col = top.col + c;
      const computed = source.values?.[r]?.[c] ?? null;
      updates.push({ row, col, cell: pastedCell(source.cells[r][c], sheet.cells[cellKey(row, col)], mode, cut, source.origin, { row, col, r, c, computed }) });
    }
  }
}

function pastedCell(incoming: SheetCell | null, existing: SheetCell | undefined, mode: PasteMode, cut: boolean, origin: ClipBlock["origin"], at: Landing): SheetCell | null {
  if (mode === "formats") return withFormatOf(incoming, existing);
  const keepsTargetFormat = mode === "values" || mode === "formulas";
  if (!incoming) return keepsTargetFormat ? targetFormat(existing) : null;
  return shiftedIntoPlace(pastedContent(incoming, existing, mode, at.computed), origin, cut, at);
}

/** "Paste formats": the target keeps its contents and takes the copied style (or none). */
function withFormatOf(incoming: SheetCell | null, existing: SheetCell | undefined): SheetCell {
  const next = { ...(existing ?? {}) };
  if (incoming?.s) next.s = incoming.s;
  else delete next.s;
  return next;
}

function targetFormat(existing: SheetCell | undefined): SheetCell | null {
  return existing?.s ? { s: existing.s } : null;
}

function pastedContent(incoming: SheetCell, existing: SheetCell | undefined, mode: PasteMode, computed: Scalar): SheetCell {
  if (mode === "values") return withLiteral(targetFormat(existing) ?? {}, incoming.f !== undefined ? computed : incoming.v);
  if (mode === "formulas") return { ...(targetFormat(existing) ?? {}), ...formulaOrLiteral(incoming) };
  return { ...incoming };
}

/** Formula cells paste their computed value; blanks and errors paste nothing. */
function withLiteral(next: SheetCell, value: Scalar | undefined): SheetCell {
  return value !== null && value !== undefined && !isError(value) ? { ...next, v: value } : next;
}

function formulaOrLiteral(incoming: SheetCell): SheetCell {
  if (incoming.f !== undefined) return { f: incoming.f };
  return incoming.v !== undefined ? { v: incoming.v } : {};
}

/** A copied (not cut) formula shifts by how far it moved from where it was copied. */
function shiftedIntoPlace(next: SheetCell, origin: ClipBlock["origin"], cut: boolean, at: Landing): SheetCell {
  if (!next.f || !origin || cut) return next;
  return { ...next, f: shiftFormula(next.f, at.row - (origin.range.r1 + at.r), at.col - (origin.range.c1 + at.c)) };
}

/** True when (row, col) sits inside the block that was cut (for marching ants). */
export function inCutArea(block: ClipBlock | null, sheetId: string, row: number, col: number): boolean {
  return Boolean(block?.cut && block.origin?.sheetId === sheetId && rangeContains(block.origin.range, row, col));
}
