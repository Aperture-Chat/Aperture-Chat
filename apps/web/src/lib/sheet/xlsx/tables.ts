/** Excel tables (xl/tables/tableN.xml) and the merge/overlap rules around
 * them. Excel repairs a file whose tables overlap, whose merges cross a table,
 * or whose header cells differ from the table's column names, so those are
 * settled here before any cell is written. */

import { cellKey, parseRangeRef, type CellRange } from "../address";
import { isError } from "../formula/values";
import { tableRanges } from "../recalc";
import type { Sheet, SheetTable, TableTone } from "../sheetModel";
import { overlapsAny, rangeText, type ExportContext, type TablePlan } from "./context";
import { prepareFormula } from "./formulaText";
import { attrs, escapeXml, NS, plainText, XML_HEADER } from "./xml";

const STYLE_BASE: Record<TableTone, { prefix: string; offset: number }> = {
  light: { prefix: "TableStyleLight", offset: 8 },
  medium: { prefix: "TableStyleMedium", offset: 1 },
  dark: { prefix: "TableStyleDark", offset: 1 },
};

/** Light 9-14, Medium 2-7, and Dark 2-7 are the accent 1-6 variants. */
export function tableStyleName(table: Pick<SheetTable, "tone" | "accent">): string {
  const base = STYLE_BASE[table.tone];
  return `${base.prefix}${base.offset + table.accent}`;
}

function headerText(ctx: ExportContext, sheet: Sheet, row: number, col: number): string {
  const value = ctx.engine.value(sheet.id, row, col);
  if (value === null || isError(value)) return "";
  const text = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
  return plainText(text).replace(/[\n\t]+/g, " ").trim().slice(0, 255);
}

/** Excel names a blank header "ColumnN" and a repeated one "Name2". */
function uniqueColumnNames(raw: string[]): { names: string[]; renamed: string[] } {
  const taken = new Set<string>();
  const renamed: string[] = [];
  const names = raw.map((text, index) => {
    let name = text || `Column${index + 1}`;
    if (taken.has(name.toLowerCase())) {
      let n = 2;
      while (taken.has(`${name}${n}`.toLowerCase())) n += 1;
      renamed.push(text);
      name = `${name}${n}`;
    }
    taken.add(name.toLowerCase());
    return name;
  });
  return { names, renamed };
}

function planTable(ctx: ExportContext, sheet: Sheet, table: SheetTable, range: CellRange): TablePlan {
  const raw: string[] = [];
  for (let col = range.c1; col <= range.c2; col += 1) raw.push(headerText(ctx, sheet, range.r1, col));
  const { names, renamed } = uniqueColumnNames(raw);
  for (const name of renamed) ctx.log.add(`Table "${table.name}" repeats the column name "${name}"; Excel needs unique names, so it was numbered.`);
  return { name: table.name, range, columns: names };
}

/** Tables that can be written, in order; a table overlapping an earlier one is left out. */
export function planTables(ctx: ExportContext, sheet: Sheet): { plans: TablePlan[]; specs: SheetTable[] } {
  const plans: TablePlan[] = [];
  const specs: SheetTable[] = [];
  const { tables = [] } = sheet;
  for (const table of tables) {
    const range = parseRangeRef(table.ref);
    if (!range) continue;
    if (overlapsAny(range, plans)) {
      ctx.log.add(`Table "${table.name}" on ${sheet.name} overlaps another table and was left out.`);
      continue;
    }
    plans.push(planTable(ctx, sheet, table, range));
    specs.push(table);
  }
  return { plans, specs };
}

/** Merges that Excel accepts: no overlap with each other or with a table. */
export function planMerges(ctx: ExportContext, sheet: Sheet, tables: TablePlan[]): CellRange[] {
  const kept: CellRange[] = [];
  const { merges = [] } = sheet;
  for (const ref of merges) {
    const range = parseRangeRef(ref);
    if (!range) continue;
    if (overlapsAny(range, tables)) {
      ctx.log.add(`Merged cells ${ref} on ${sheet.name} overlap a table and were unmerged.`);
    } else if (overlapsAny(range, kept)) {
      ctx.log.add(`Merged cells ${ref} on ${sheet.name} overlap other merged cells and were unmerged.`);
    } else {
      kept.push(range);
    }
  }
  return kept;
}

function totalsAttributes(sheet: Sheet, row: number, col: number, table: string): { attributes: string; body: string } {
  const cell = sheet.cells[cellKey(row, col)];
  if (cell?.f) {
    const formula = prepareFormula(cell.f, table);
    if (formula) return { attributes: ` totalsRowFunction="custom"`, body: `<totalsRowFormula>${escapeXml(formula.text)}</totalsRowFormula>` };
  }
  if (typeof cell?.v === "string") return { attributes: attrs({ totalsRowLabel: plainText(cell.v) }), body: "" };
  return { attributes: "", body: "" };
}

function columnXml(sheet: Sheet, plan: TablePlan, spec: SheetTable, index: number): string {
  const name = attrs({ id: index + 1, name: plan.columns[index] });
  const totals = spec.totals ? totalsAttributes(sheet, plan.range.r2, plan.range.c1 + index, spec.name) : { attributes: "", body: "" };
  return totals.body ? `<tableColumn${name}${totals.attributes}>${totals.body}</tableColumn>` : `<tableColumn${name}${totals.attributes}/>`;
}

export function tableXml(sheet: Sheet, plan: TablePlan, spec: SheetTable, id: number): string {
  const { range } = plan;
  const ranges = tableRanges(spec)!;
  const head = attrs({
    id,
    name: spec.name,
    displayName: spec.name,
    ref: rangeText(range),
    totalsRowCount: spec.totals ? 1 : undefined,
    totalsRowShown: spec.totals ? undefined : 0,
  });
  const filter = spec.filterButtons ? `<autoFilter ref="${rangeText({ ...range, r2: ranges.data.r2 })}"/>` : "";
  const columns = plan.columns.map((_, index) => columnXml(sheet, plan, spec, index)).join("");
  const style = attrs({
    name: tableStyleName(spec),
    showFirstColumn: spec.firstColumn ? 1 : 0,
    showLastColumn: 0,
    showRowStripes: spec.banded ? 1 : 0,
    showColumnStripes: 0,
  });
  return (
    XML_HEADER +
    `<table xmlns="${NS.main}"${head}>${filter}` +
    `<tableColumns count="${plan.columns.length}">${columns}</tableColumns>` +
    `<tableStyleInfo${style}/></table>`
  );
}
