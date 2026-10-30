/** Fills one sheet's CellGrid. Writes go in a fixed order so later sources
 * win: empty cells where a styled row crosses a styled column, then the
 * author's cells, then spilled and pivot results, then table header names
 * (Excel requires header cells to hold exactly the table's column names). */

import { cellKey, columnIndex, forEachCellInRange, parseCellKey, type CellRange } from "../address";
import { isError } from "../formula/values";
import type { PivotOutput } from "../pivot";
import { SHEET_ACCENTS } from "../palette";
import type { CellStyle, SheetPivot } from "../sheetModel";
import { effectiveStyle } from "../sheetOps";
import { CellGrid, formulaCellXml, valueCellXml } from "./cells";
import { overlapsAny, rangeText, type ExportContext, type SheetPlan } from "./context";
import { tableAt } from "../recalc";
import { prepareFormula, type PreparedFormula } from "./formulaText";
import { plainText } from "./xml";

type Spill = { anchorRow: number; anchorCol: number; range: CellRange; dynamic: boolean };

/** Accent 1 lightened 80% toward white: the pivot header band. */
export const PIVOT_HEADER_FILL = lighten(SHEET_ACCENTS[1], 0.8);

function lighten(color: string, amount: number): string {
  const channels = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
  return `#${channels.map((value) => Math.round(value + (255 - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function styleAt(ctx: ExportContext, plan: SheetPlan, row: number, col: number, overlay?: CellStyle): number {
  const base = effectiveStyle(plan.sheet, row, col);
  return ctx.styles.cellXf(overlay ? { ...base, ...overlay } : base);
}

function writeCrossings(ctx: ExportContext, plan: SheetPlan, grid: CellGrid): void {
  const { rows: rowProps = {}, cols: colProps = {} } = plan.sheet;
  const rows = Object.entries(rowProps).filter(([, row]) => row.s).map(([key]) => Number(key) - 1);
  const cols = Object.entries(colProps).filter(([, col]) => col.s).map(([key]) => columnIndex(key));
  for (const row of rows) {
    for (const col of cols) grid.set(row, col, valueCellXml(ctx, row, col, null, styleAt(ctx, plan, row, col)));
  }
}

/** The dynamic-array extent for a formula, or null to write it plainly.
 * Excel cannot hold an array formula inside a table or merged cells. */
function arrayExtent(ctx: ExportContext, plan: SheetPlan, row: number, col: number, formula: PreparedFormula, spill: CellRange | null): string | null {
  const blocked = (range: CellRange) => overlapsAny(range, plan.tables) || overlapsAny(range, plan.merges);
  if (spill) {
    if (!blocked(spill)) return rangeText(spill);
    ctx.log.add(`The spilled result of ${plan.sheet.name}!${cellKey(row, col)} overlaps a table or merged cells, so it exports as values.`);
    return null;
  }
  return formula.mayArray && !blocked({ r1: row, c1: col, r2: row, c2: col }) ? cellKey(row, col) : null;
}

function writeFormula(ctx: ExportContext, plan: SheetPlan, grid: CellGrid, row: number, col: number, source: string): Spill | null {
  const style = styleAt(ctx, plan, row, col);
  const clean = plainText(source);
  if (clean !== source) ctx.log.count("illegalChars");
  const formula = prepareFormula(clean, tableAt(plan.sheet.tables, row, col)?.name);
  if (!formula) {
    ctx.log.count("badFormula");
    grid.set(row, col, valueCellXml(ctx, row, col, `=${source}`, style));
    return null;
  }
  const value = ctx.engine.value(plan.sheet.id, row, col);
  const spill = ctx.engine.spillRange(plan.sheet.id, row, col);
  const arrayRef = arrayExtent(ctx, plan, row, col, formula, spill);
  if (arrayRef) ctx.dynamicArrays = true;
  grid.set(row, col, formulaCellXml({ row, col, text: formula.text, value, style, arrayRef }));
  return spill ? { anchorRow: row, anchorCol: col, range: spill, dynamic: arrayRef !== null } : null;
}

function writeModelCells(ctx: ExportContext, plan: SheetPlan, grid: CellGrid): Spill[] {
  const spills: Spill[] = [];
  for (const [address, cell] of Object.entries(plan.sheet.cells)) {
    const point = parseCellKey(address);
    if (!point) continue;
    if (cell.f) {
      const spill = writeFormula(ctx, plan, grid, point.row, point.col, cell.f);
      if (spill) spills.push(spill);
    } else {
      grid.set(point.row, point.col, valueCellXml(ctx, point.row, point.col, cell.v ?? null, styleAt(ctx, plan, point.row, point.col)));
    }
  }
  return spills;
}

/** Spilled values are cached results of the anchor's dynamic array, or plain
 * values when the spill could not be written as one. */
function writeSpill(ctx: ExportContext, plan: SheetPlan, grid: CellGrid, spill: Spill): void {
  forEachCellInRange(spill.range, (row, col) => {
    if (row === spill.anchorRow && col === spill.anchorCol) return;
    const value = ctx.engine.value(plan.sheet.id, row, col);
    const style = styleAt(ctx, plan, row, col);
    grid.set(row, col, valueCellXml(ctx, row, col, value, style, spill.dynamic));
  });
}

function pivotOverlay(output: PivotOutput, row: number): CellStyle | undefined {
  if (row < output.headerRows) return { bold: true, fill: PIVOT_HEADER_FILL };
  if (output.totalRow && row === output.values.length - 1) return { bold: true, border: { top: { style: "thin", color: SHEET_ACCENTS[1] } } };
  return undefined;
}

function writePivot(ctx: ExportContext, plan: SheetPlan, grid: CellGrid, pivot: SheetPivot): void {
  const { range, output } = ctx.engine.pivotResult(plan.sheet.id, pivot.id);
  if (!output || isError(output) || !range) {
    ctx.log.add(`Pivot table "${pivot.name}" on ${plan.sheet.name} could not be computed and was left out.`);
    return;
  }
  ctx.log.add("Pivot tables export as values.");
  output.values.forEach((line, r) => {
    const overlay = pivotOverlay(output, r);
    line.forEach((value, c) => {
      const row = range.r1 + r;
      const col = range.c1 + c;
      grid.set(row, col, valueCellXml(ctx, row, col, value, styleAt(ctx, plan, row, col, overlay)));
    });
  });
}

function writeTableHeaders(ctx: ExportContext, plan: SheetPlan, grid: CellGrid): void {
  for (const table of plan.tables) {
    table.columns.forEach((name, index) => {
      const col = table.range.c1 + index;
      grid.set(table.range.r1, col, valueCellXml(ctx, table.range.r1, col, name, styleAt(ctx, plan, table.range.r1, col)));
    });
  }
}

export function buildSheetData(ctx: ExportContext, plan: SheetPlan): CellGrid {
  const grid = new CellGrid();
  writeCrossings(ctx, plan, grid);
  for (const spill of writeModelCells(ctx, plan, grid)) writeSpill(ctx, plan, grid, spill);
  const { pivots = [] } = plan.sheet;
  for (const pivot of pivots) writePivot(ctx, plan, grid, pivot);
  writeTableHeaders(ctx, plan, grid);
  return grid;
}
