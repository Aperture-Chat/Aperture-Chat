/** Reads a chart's series out of its source range with Excel's layout rules:
 * the first column holds category labels and the first row holds series
 * names (or the transpose with seriesBy "rows"). A numeric first column on a
 * scatter chart is the x axis. */

import { type CellRange, parseRangeRef, splitSheetQualifiedRef } from "./address";
import { type Scalar, isError } from "./formula/values";
import { formatCellValue, isDateFormat } from "./numberFormat";
import { seriesColor } from "./palette";
import type { WorkbookEngine } from "./recalc";
import type { Sheet, SheetChart, Workbook } from "./sheetModel";
import { sheetByName } from "./sheetModel";
import { effectiveStyle } from "./sheetOps";

export type ChartSeries = { name: string; values: (number | null)[]; color: string; format?: string };
export type ChartData = {
  categories: string[];
  /** Numeric x values (scatter charts with a numeric first column). */
  xValues: (number | null)[] | null;
  series: ChartSeries[];
  /** Number format of the first value cell, for axis labels. */
  valueFormat?: string;
};

export function chartSourceRange(chart: SheetChart, host: Sheet, workbook: Workbook): { sheet: Sheet; range: CellRange } | null {
  const { sheet: name, ref } = splitSheetQualifiedRef(chart.source);
  const sheet = name ? sheetByName(workbook, name) : host;
  const range = parseRangeRef(ref);
  return sheet && range ? { sheet, range } : null;
}

function asNumber(value: Scalar): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asLabel(value: Scalar, format: string | undefined): string {
  if (value === null || isError(value)) return "";
  return formatCellValue(value, format).text;
}

export function readChartData(chart: SheetChart, host: Sheet, workbook: Workbook, engine: WorkbookEngine): ChartData | null {
  const source = chartSourceRange(chart, host, workbook);
  if (!source) return null;
  const used = engine.usedRange(source.sheet.id);
  const range = used ? { ...source.range, r2: Math.min(source.range.r2, Math.max(used.r2, source.range.r1)), c2: Math.min(source.range.c2, Math.max(used.c2, source.range.c1)) } : source.range;
  const grid: Scalar[][] = [];
  const formats: (string | undefined)[][] = [];
  for (let row = range.r1; row <= range.r2; row += 1) {
    const line: Scalar[] = [];
    const formatLine: (string | undefined)[] = [];
    for (let col = range.c1; col <= range.c2; col += 1) {
      line.push(engine.value(source.sheet.id, row, col));
      formatLine.push(effectiveStyle(source.sheet, row, col)?.format);
    }
    grid.push(line);
    formats.push(formatLine);
  }
  const byRows = chart.seriesBy === "rows";
  const matrix = byRows ? grid[0].map((_, c) => grid.map((line) => line[c])) : grid;
  const fmt = byRows ? formats[0].map((_, c) => formats.map((line) => line[c])) : formats;
  if (!matrix.length || !matrix[0].length) return null;
  const width = matrix[0].length;
  const headerRow = matrix[0].slice(1).some((value) => typeof value === "string") || (width === 1 && typeof matrix[0][0] === "string");
  const body = headerRow ? matrix.slice(1) : matrix;
  const bodyFormats = headerRow ? fmt.slice(1) : fmt;
  const firstColumnNumeric = body.every((line) => line[0] === null || typeof line[0] === "number");
  // Excel's rule: the first column is category labels when it holds text or
  // dates, or when the top-left cell is empty (so years like 2026 still label).
  const firstColumnDated = body.some((line, index) => typeof line[0] === "number" && isDateFormat(bodyFormats[index]?.[0]));
  const blankCorner = headerRow && (matrix[0][0] === null || matrix[0][0] === "");
  const hasCategories = width > 1 && (chart.type === "scatter" || !firstColumnNumeric || firstColumnDated || blankCorner);
  const firstSeries = hasCategories ? 1 : 0;
  const categories = body.map((line, index) => (hasCategories ? asLabel(line[0], bodyFormats[index]?.[0]) : String(index + 1)));
  const xValues = chart.type === "scatter" && hasCategories && firstColumnNumeric ? body.map((line) => asNumber(line[0])) : null;
  const series: ChartSeries[] = [];
  for (let col = firstSeries; col < width; col += 1) {
    const values = body.map((line) => asNumber(line[col]));
    // Text columns (names, regions) inside a charted table are not series.
    if (values.every((value) => value === null)) continue;
    const name = headerRow ? asLabel(matrix[0][col], undefined) || `Series ${series.length + 1}` : `Series ${series.length + 1}`;
    series.push({
      name,
      values,
      color: seriesColor(series.length),
      format: bodyFormats.find((line) => line[col])?.[col],
    });
  }
  if (!series.length) return null;
  return { categories, xValues, series, valueFormat: series[0].format };
}

/** Rounded axis ticks covering [min, max] ("nice numbers"). */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    if (min === 0) return [0, 1];
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  const span = max - min;
  const raw = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => span / candidate <= target + 0.5) ?? 10 * magnitude;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 0.5 && ticks.length < 30; value += step) ticks.push(Number(value.toPrecision(12)));
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)));
  return ticks;
}
