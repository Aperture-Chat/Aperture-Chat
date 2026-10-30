/** xl/worksheets/sheetN.xml. CT_Worksheet is a strict sequence and Excel
 * repairs a file whose children are out of order, so the parts are always
 * emitted as: sheetPr, dimension, sheetViews, sheetFormatPr, cols, sheetData,
 * autoFilter, mergeCells, conditionalFormatting, dataValidations, pageMargins,
 * drawing, legacyDrawing, tableParts. */

import { cellKey, columnIndex } from "../address";
import { pxToExcelWidth, pxToPoints } from "../palette";
import { DEFAULT_COL_WIDTH, type Sheet } from "../sheetModel";
import type { CellGrid } from "./cells";
import { conditionalFormattingXml } from "./conditional";
import { rangeText, type ExportContext, type SheetPlan } from "./context";
import type { FilterPlan } from "./filter";
import { dataValidationsXml } from "./validation";
import { argb, attrs, NS, XML_HEADER } from "./xml";

/** Pixels -> the file's column width: Excel's character count plus its 5px
 * cell padding, in 1/256ths (ECMA-376 §18.3.1.13). */
export function fileColumnWidth(px: number): number {
  const characters = pxToExcelWidth(px);
  return Math.trunc(((characters * 7 + 5) / 7) * 256) / 256;
}

export type SheetParts = {
  plan: SheetPlan;
  grid: CellGrid;
  filter: FilterPlan | null;
  active: boolean;
  drawingRel?: string;
  legacyDrawingRel?: string;
  tableRels: string[];
};

function sheetPrXml(sheet: Sheet, filter: FilterPlan | null): string {
  const filtered = Boolean(filter?.hiddenRows.size);
  if (!sheet.color && !filtered) return "";
  const tab = sheet.color ? `<tabColor rgb="${argb(sheet.color)}"/>` : "";
  return `<sheetPr${attrs({ filterMode: filtered })}>${tab}</sheetPr>`;
}

function activePane(rows: number, cols: number): string {
  if (rows && cols) return "bottomRight";
  return rows ? "bottomLeft" : "topRight";
}

function paneXml(freeze: Sheet["freeze"]): string {
  if (!freeze) return "";
  const { rows, cols } = freeze;
  const topLeftCell = cellKey(rows, cols);
  const pane = activePane(rows, cols);
  const split = attrs({ xSplit: cols || undefined, ySplit: rows || undefined, topLeftCell, activePane: pane, state: "frozen" });
  return `<pane${split}/><selection pane="${pane}" activeCell="${topLeftCell}" sqref="${topLeftCell}"/>`;
}

function sheetViewsXml(sheet: Sheet, active: boolean): string {
  const view = attrs({ showGridLines: sheet.gridlines === false ? 0 : undefined, tabSelected: active, workbookViewId: 0 });
  const pane = paneXml(sheet.freeze);
  return `<sheetViews>${pane ? `<sheetView${view}>${pane}</sheetView>` : `<sheetView${view}/>`}</sheetViews>`;
}

function colsXml(ctx: ExportContext, sheet: Sheet): string {
  const { cols: props = {} } = sheet;
  const cols = Object.entries(props)
    .map(([letter, col]) => ({ index: columnIndex(letter), col }))
    .filter(({ index }) => index >= 0)
    .sort((a, b) => a.index - b.index)
    .map(({ index, col }) => {
      const { w = DEFAULT_COL_WIDTH, s } = col;
      const style = ctx.styles.cellXf(s);
      return `<col${attrs({
        min: index + 1,
        max: index + 1,
        width: fileColumnWidth(w),
        style: style || undefined,
        hidden: col.hidden,
        customWidth: col.w !== undefined,
      })}/>`;
    });
  return cols.length ? `<cols>${cols.join("")}</cols>` : "";
}

function rowAttributes(ctx: ExportContext, sheet: Sheet, row: number, filterHidden: boolean): string {
  const props = sheet.rows?.[String(row + 1)];
  const style = ctx.styles.cellXf(props?.s);
  return attrs({
    r: row + 1,
    s: style || undefined,
    customFormat: style !== 0,
    ht: props?.h !== undefined ? pxToPoints(props.h) : undefined,
    customHeight: props?.h !== undefined,
    hidden: Boolean(props?.hidden) || filterHidden,
  });
}

function sheetDataXml(ctx: ExportContext, parts: SheetParts): string {
  const { sheet } = parts.plan;
  const { rows: props = {} } = sheet;
  const hidden = parts.filter ? parts.filter.hiddenRows : new Set<number>();
  const indexes = new Set<number>([...parts.grid.rowIndexes(), ...hidden]);
  for (const key of Object.keys(props)) indexes.add(Number(key) - 1);
  const rows = Array.from(indexes)
    .sort((a, b) => a - b)
    .map((row) => {
      const cells = parts.grid.rowXml(row);
      const head = `<row${rowAttributes(ctx, sheet, row, hidden.has(row))}`;
      return cells ? `${head}>${cells}</row>` : `${head}/>`;
    });
  return `<sheetData>${rows.join("")}</sheetData>`;
}

function mergeCellsXml(parts: SheetParts): string {
  const merges = parts.plan.merges;
  if (!merges.length) return "";
  return `<mergeCells count="${merges.length}">${merges.map((range) => `<mergeCell ref="${rangeText(range)}"/>`).join("")}</mergeCells>`;
}

function objectRefsXml(parts: SheetParts): string {
  const drawing = parts.drawingRel ? `<drawing r:id="${parts.drawingRel}"/>` : "";
  const legacy = parts.legacyDrawingRel ? `<legacyDrawing r:id="${parts.legacyDrawingRel}"/>` : "";
  const tables = parts.tableRels.length
    ? `<tableParts count="${parts.tableRels.length}">${parts.tableRels.map((id) => `<tablePart r:id="${id}"/>`).join("")}</tableParts>`
    : "";
  return drawing + legacy + tables;
}

export function worksheetXml(ctx: ExportContext, parts: SheetParts): string {
  const { sheet } = parts.plan;
  const extent = parts.grid.extent();
  return (
    XML_HEADER +
    `<worksheet xmlns="${NS.main}" xmlns:r="${NS.rel}">` +
    sheetPrXml(sheet, parts.filter) +
    `<dimension ref="${extent ? rangeText(extent) : "A1"}"/>` +
    sheetViewsXml(sheet, parts.active) +
    `<sheetFormatPr${attrs({ defaultColWidth: fileColumnWidth(DEFAULT_COL_WIDTH), defaultRowHeight: 15 })}/>` +
    colsXml(ctx, sheet) +
    sheetDataXml(ctx, parts) +
    (parts.filter ? parts.filter.xml : "") +
    mergeCellsXml(parts) +
    conditionalFormattingXml(ctx, sheet.conditional) +
    dataValidationsXml(ctx, sheet.validations) +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    objectRefsXml(parts) +
    `</worksheet>`
  );
}
