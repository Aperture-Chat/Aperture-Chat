/** Pivot table computation: groups a source range by row and column fields
 * and aggregates value fields, in Excel's tabular layout. The output is a
 * plain grid of values that the recalculation engine places at the pivot's
 * anchor cell; the editor and the .xlsx export read layout hints from it. */

import { type Matrix, type Scalar, compareScalars, isError, sheetError, type SheetError } from "./formula/values";
import type { PivotAggregate, PivotValueField, SheetPivot } from "./sheetModel";

export const MAX_PIVOT_OUTPUT_ROWS = 5_000;
export const MAX_PIVOT_OUTPUT_COLS = 200;
export const PIVOT_BLANK_LABEL = "(blank)";
export const PIVOT_TOTAL_LABEL = "Grand Total";

export type PivotOutput = {
  values: Matrix;
  /** Rows at the top that hold field names and column labels. */
  headerRows: number;
  /** Columns at the left that hold row labels. */
  labelCols: number;
  /** The last row is the grand total row. */
  totalRow: boolean;
  /** The trailing value columns are grand totals. */
  totalCols: number;
  /** Number format for each output column's values (from the source field;
   * counts stay unformatted), so a pivot of currency shows currency. */
  columnFormats: (string | undefined)[];
};

const AGG_LABEL: Record<PivotAggregate, string> = {
  sum: "Sum of",
  count: "Count of",
  average: "Average of",
  min: "Min of",
  max: "Max of",
  countDistinct: "Distinct count of",
};

export function pivotValueLabel(value: PivotValueField): string {
  return value.label?.trim() || `${AGG_LABEL[value.agg]} ${value.field}`;
}

type Bucket = { numbers: number[]; count: number; distinct: Set<string> };

function newBucket(): Bucket {
  return { numbers: [], count: 0, distinct: new Set() };
}

function addToBucket(bucket: Bucket, value: Scalar): void {
  if (value === null || value === "" || isError(value)) return;
  bucket.count += 1;
  bucket.distinct.add(typeof value === "string" ? value.toLowerCase() : String(value));
  if (typeof value === "number") bucket.numbers.push(value);
}

function finish(bucket: Bucket | undefined, agg: PivotAggregate): Scalar {
  if (!bucket) return null;
  switch (agg) {
    case "count":
      return nonZeroOrNull(bucket.count);
    case "countDistinct":
      return nonZeroOrNull(bucket.distinct.size);
    case "sum":
      return sumOrZero(bucket);
    case "average":
      return bucket.numbers.length ? total(bucket.numbers) / bucket.numbers.length : null;
    case "min":
      return extreme(bucket.numbers, Math.min);
    case "max":
      return extreme(bucket.numbers, Math.max);
  }
}

function nonZeroOrNull(count: number): number | null {
  return count || null;
}

function total(numbers: number[]): number {
  return numbers.reduce((sum, item) => sum + item, 0);
}

/** Numbers add up; a bucket of only text sums to 0, and an empty one is blank. */
function sumOrZero(bucket: Bucket): number | null {
  if (bucket.numbers.length) return total(bucket.numbers);
  return bucket.count ? 0 : null;
}

function extreme(numbers: number[], pick: (...items: number[]) => number): number | null {
  return numbers.length ? pick(...numbers) : null;
}

function label(value: Scalar): string {
  if (value === null || value === "") return PIVOT_BLANK_LABEL;
  if (isError(value)) return value.code;
  return typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
}

/** Group keys keep the first raw value seen so numbers sort numerically. */
type Group = { key: string; parts: Scalar[] };

function compareGroups(a: Group, b: Group): number {
  for (let index = 0; index < a.parts.length; index += 1) {
    const x = a.parts[index];
    const y = b.parts[index];
    const blankX = x === null || x === "";
    const blankY = y === null || y === "";
    if (blankX !== blankY) return blankX ? 1 : -1;
    const order = compareScalars(x, y);
    if (order) return order;
  }
  return 0;
}

export function pivotSourceFields(source: Matrix): string[] {
  return (source[0] ?? []).map((cell) => (cell === null || isError(cell) ? "" : String(cell).trim()));
}

/** Field positions in the source, resolved once from the pivot's spec. */
type PivotFields = {
  headers: string[];
  rowIdx: number[];
  colIdx: number[];
  values: PivotValueField[];
  valueIdx: number[];
  filters: { index: number; allowed: Set<string> }[];
};

/** Aggregation buckets per cell, per row group, per column group, and overall. */
type PivotTally = {
  rowGroups: Map<string, Group>;
  colGroups: Map<string, Group>;
  cells: Map<string, Bucket[]>;
  rowTotals: Map<string, Bucket[]>;
  colTotals: Map<string, Bucket[]>;
  grand: Bucket[];
};

type PivotLayout = {
  rows: Group[];
  cols: Group[];
  valueCount: number;
  showRightTotals: boolean;
  labelCols: number;
  headerRows: number;
  totalRow: boolean;
  width: number;
  height: number;
};

type FieldFormat = (fieldIndex: number) => string | undefined;

export function computePivot(spec: SheetPivot, source: Matrix, fieldFormat: FieldFormat = () => undefined): PivotOutput | SheetError {
  const fields = resolveFields(spec, source);
  if (isError(fields)) return fields;
  const tally = tallyRecords(fields, source);
  const layout = layoutPivot(spec, fields, tally);
  if (layout.height > MAX_PIVOT_OUTPUT_ROWS || layout.width > MAX_PIVOT_OUTPUT_COLS) {
    return sheetError("#CALC!", "The pivot table has too many groups. Add a filter or use fewer fields.");
  }
  const grid: Matrix = Array.from({ length: layout.height }, () => Array.from({ length: layout.width }, () => null as Scalar));
  writeHeader(grid, spec, fields, layout);
  layout.rows.forEach((group, rowSlot) => writeGroupRow(grid[layout.headerRows + rowSlot], group, fields, layout, tally));
  if (layout.totalRow) writeTotalRow(grid[layout.height - 1], fields, layout, tally);
  return {
    values: grid,
    headerRows: layout.headerRows,
    labelCols: layout.labelCols,
    totalRow: layout.totalRow,
    totalCols: layout.showRightTotals ? layout.valueCount : 0,
    columnFormats: Array.from({ length: layout.width }, (_, col) => columnFormat(fields, layout, fieldFormat, col)),
  };
}

function resolveFields(spec: SheetPivot, source: Matrix): PivotFields | SheetError {
  const headers = pivotSourceFields(source);
  const fieldIndex = (name: string) => headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
  const missing = [...spec.rows, ...spec.columns, ...spec.values.map((value) => value.field), ...spec.filters.map((filter) => filter.field)]
    .find((name) => fieldIndex(name) < 0);
  if (missing) return sheetError("#REF!", `The pivot source has no column named "${missing}".`);
  if (!spec.values.length && !spec.rows.length && !spec.columns.length) {
    return sheetError("#CALC!", "Add a row, column, or value field to build the pivot table.");
  }
  return {
    headers,
    rowIdx: spec.rows.map(fieldIndex),
    colIdx: spec.columns.map(fieldIndex),
    values: spec.values,
    valueIdx: spec.values.map((value) => fieldIndex(value.field)),
    filters: spec.filters.map((filter) => ({ index: fieldIndex(filter.field), allowed: new Set(filter.include.map((item) => item.toLowerCase())) })),
  };
}

function tallyRecords(fields: PivotFields, source: Matrix): PivotTally {
  const tally: PivotTally = { rowGroups: new Map(), colGroups: new Map(), cells: new Map(), rowTotals: new Map(), colTotals: new Map(), grand: fields.values.map(newBucket) };
  for (const record of source.slice(1)) {
    if (recordCounts(fields, record)) tallyRecord(fields, tally, record);
  }
  return tally;
}

/** Blank records never count; filtered ones count only when every filter includes them. */
function recordCounts(fields: PivotFields, record: Scalar[]): boolean {
  if (record.every((cell) => cell === null || cell === "")) return false;
  return fields.filters.every((filter) => filter.allowed.has(label(record[filter.index] ?? null).toLowerCase()));
}

function tallyRecord(fields: PivotFields, tally: PivotTally, record: Scalar[]): void {
  const rowKey = groupKey(tally.rowGroups, fields.rowIdx.map((index) => record[index] ?? null));
  const colKey = groupKey(tally.colGroups, fields.colIdx.map((index) => record[index] ?? null));
  const targets = [
    bucketsFor(tally.cells, `${rowKey}\u0001${colKey}`, fields.values),
    bucketsFor(tally.rowTotals, rowKey, fields.values),
    bucketsFor(tally.colTotals, colKey, fields.values),
    tally.grand,
  ];
  fields.valueIdx.forEach((index, slot) => {
    const value = record[index] ?? null;
    for (const buckets of targets) addToBucket(buckets[slot], value);
  });
}

/** The case-insensitive key of a group, registering the group on first sight. */
function groupKey(groups: Map<string, Group>, parts: Scalar[]): string {
  const key = parts.map(label).join("\u0000").toLowerCase();
  if (!groups.has(key)) groups.set(key, { key, parts });
  return key;
}

function bucketsFor(map: Map<string, Bucket[]>, id: string, values: PivotValueField[]): Bucket[] {
  let list = map.get(id);
  if (!list) {
    list = values.map(newBucket);
    map.set(id, list);
  }
  return list;
}

function layoutPivot(spec: SheetPivot, fields: PivotFields, tally: PivotTally): PivotLayout {
  const hasCols = fields.colIdx.length > 0;
  const valueCount = Math.max(1, fields.values.length);
  const cols = hasCols ? Array.from(tally.colGroups.values()).sort(compareGroups) : [];
  const showRightTotals = hasCols && spec.columnTotals && fields.values.length > 0;
  const labelCols = Math.max(1, fields.rowIdx.length);
  const headerRows = hasCols ? (fields.values.length > 1 ? 2 : 1) + 1 : 1;
  const totalRow = spec.rowTotals && fields.values.length > 0;
  const rows = Array.from(tally.rowGroups.values()).sort(compareGroups);
  return {
    rows,
    cols,
    valueCount,
    showRightTotals,
    labelCols,
    headerRows,
    totalRow,
    width: labelCols + valueColumns(fields, cols.length, valueCount, showRightTotals),
    height: headerRows + rows.length + (totalRow ? 1 : 0),
  };
}

function valueColumns(fields: PivotFields, colGroups: number, valueCount: number, showRightTotals: boolean): number {
  const dataCols = (fields.colIdx.length ? colGroups : 1) * valueCount;
  return (fields.values.length ? dataCols : 0) + (showRightTotals ? valueCount : 0);
}

function rightTotalsStart(layout: PivotLayout): number {
  return layout.labelCols + layout.cols.length * layout.valueCount;
}

/** Header block. With column fields Excel shows the field caption above the
 * column labels; the row field names sit on the last header row. */
function writeHeader(grid: Matrix, spec: SheetPivot, fields: PivotFields, layout: PivotLayout): void {
  const lastHeader = layout.headerRows - 1;
  fields.rowIdx.forEach((index, slot) => {
    grid[lastHeader][slot] = fields.headers[index];
  });
  if (!fields.rowIdx.length) grid[lastHeader][0] = fields.values.length ? "" : null;
  if (fields.colIdx.length) writeColumnHeader(grid, spec, fields, layout);
  else fields.values.forEach((value, slot) => { grid[lastHeader][layout.labelCols + slot] = pivotValueLabel(value); });
}

function writeColumnHeader(grid: Matrix, spec: SheetPivot, fields: PivotFields, layout: PivotLayout): void {
  grid[0][layout.labelCols] = spec.columns.join(" / ");
  layout.cols.forEach((group, colSlot) => {
    const base = layout.labelCols + colSlot * layout.valueCount;
    grid[1][base] = group.parts.map(label).join(" / ");
    writeValueCaptions(grid, base, fields.values, "");
  });
  if (layout.showRightTotals) {
    const base = rightTotalsStart(layout);
    grid[1][base] = PIVOT_TOTAL_LABEL;
    writeValueCaptions(grid, base, fields.values, "Total ");
  }
  if (fields.values.length === 1) grid[0][0] = pivotValueLabel(fields.values[0]);
}

/** Several value fields get a caption row of their own under each column label. */
function writeValueCaptions(grid: Matrix, base: number, values: PivotValueField[], prefix: string): void {
  if (values.length > 1) values.forEach((value, slot) => { grid[2][base + slot] = `${prefix}${pivotValueLabel(value)}`; });
}

function writeGroupRow(line: Scalar[], group: Group, fields: PivotFields, layout: PivotLayout, tally: PivotTally): void {
  group.parts.forEach((part, slot) => { line[slot] = part === null || part === "" ? PIVOT_BLANK_LABEL : part; });
  if (!fields.rowIdx.length) line[0] = PIVOT_TOTAL_LABEL;
  if (!fields.colIdx.length) {
    writeValues(line, layout.labelCols, fields.values, tally.rowTotals.get(group.key));
    return;
  }
  layout.cols.forEach((colGroup, colSlot) => {
    writeValues(line, layout.labelCols + colSlot * layout.valueCount, fields.values, tally.cells.get(`${group.key}\u0001${colGroup.key}`));
  });
  if (layout.showRightTotals) writeValues(line, rightTotalsStart(layout), fields.values, tally.rowTotals.get(group.key));
}

function writeTotalRow(line: Scalar[], fields: PivotFields, layout: PivotLayout, tally: PivotTally): void {
  line[0] = PIVOT_TOTAL_LABEL;
  if (!fields.colIdx.length) {
    writeValues(line, layout.labelCols, fields.values, tally.grand);
    return;
  }
  layout.cols.forEach((colGroup, colSlot) => {
    writeValues(line, layout.labelCols + colSlot * layout.valueCount, fields.values, tally.colTotals.get(colGroup.key));
  });
  if (layout.showRightTotals) writeValues(line, rightTotalsStart(layout), fields.values, tally.grand);
}

function writeValues(line: Scalar[], start: number, values: PivotValueField[], buckets: Bucket[] | undefined): void {
  values.forEach((value, slot) => { line[start + slot] = finish(buckets?.[slot], value.agg); });
}

/** Label columns take their row field's format; value columns their source
 * field's, except counts, which stay unformatted. */
function columnFormat(fields: PivotFields, layout: PivotLayout, fieldFormat: FieldFormat, col: number): string | undefined {
  if (col < layout.labelCols || !fields.values.length) return fields.rowIdx.length && col < layout.labelCols ? fieldFormat(fields.rowIdx[col]) : undefined;
  const slot = (col - layout.labelCols) % layout.valueCount;
  const value = fields.values[slot];
  if (!value || value.agg === "count" || value.agg === "countDistinct") return undefined;
  return fieldFormat(fields.valueIdx[slot]);
}
