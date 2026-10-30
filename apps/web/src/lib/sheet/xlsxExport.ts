/** Real .xlsx (SpreadsheetML OOXML) export for spreadsheet drafts.
 *
 * Built the same way the .docx and .pptx exports are: a STORED zip
 * (ooxmlZip.ts) of hand-written XML parts. The workbook is recalculated
 * first so every formula carries a cached value, and the file asks Excel to
 * recalculate on open (fullCalcOnLoad). Formulas, tables, charts,
 * conditional formats, validations, notes, filters, and dynamic arrays
 * export natively; pivot tables export as styled values. Anything that had
 * to change to keep Excel from repairing the file is reported in `warnings`.
 */

import { buildZip } from "../ooxmlZip";
import { computeWorkbook } from "./recalc";
import type { Sheet, Workbook } from "./sheetModel";
import { chartXml, drawingXml, type PlacedChart } from "./xlsx/charts";
import { commentsXml, notesVml, sheetNotes, vmlBlockCount } from "./xlsx/comments";
import { createContext, rangeText, type ExportContext, type SheetPlan } from "./xlsx/context";
import { planFilter } from "./xlsx/filter";
import { buildSheetData } from "./xlsx/sheetData";
import { absoluteRef } from "./xlsx/formulaText";
import {
  APP_PROPS,
  CONTENT_TYPES,
  contentTypesXml,
  corePropsXml,
  DYNAMIC_ARRAY_METADATA,
  Relationships,
  ROOT_RELS,
  workbookXml,
  type FilterDatabase,
  type Part,
  type WorkbookSheetEntry,
} from "./xlsx/packageParts";
import { planMerges, planTables, tableXml } from "./xlsx/tables";
import { themeXml } from "./xlsx/theme";
import { worksheetXml } from "./xlsx/worksheet";

export const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type XlsxExportResult = { bytes: Uint8Array; warnings: string[] };

type Counters = { table: number; chart: number; drawing: number; comments: number; vmlBlock: number };

type SheetResult = { parts: Part[]; filter: FilterDatabase | null };

function tableParts(plan: SheetPlan, specs: NonNullable<Sheet["tables"]>, rels: Relationships, counters: Counters): { parts: Part[]; relIds: string[] } {
  const parts: Part[] = [];
  const relIds = plan.tables.map((table, index) => {
    counters.table += 1;
    const name = `xl/tables/table${counters.table}.xml`;
    parts.push({ name, xml: tableXml(plan.sheet, table, specs[index], counters.table), contentType: CONTENT_TYPES.table });
    return rels.add("table", `../tables/table${counters.table}.xml`);
  });
  return { parts, relIds };
}

function chartParts(ctx: ExportContext, sheet: Sheet, rels: Relationships, counters: Counters): { parts: Part[]; relId?: string } {
  const drawingRels = new Relationships();
  const parts: Part[] = [];
  const placed: PlacedChart[] = [];
  const { charts = [] } = sheet;
  for (const chart of charts) {
    const written = chartXml(ctx, sheet, chart);
    if (!written) continue;
    counters.chart += 1;
    parts.push({ name: `xl/charts/chart${counters.chart}.xml`, xml: written.xml, contentType: CONTENT_TYPES.chart });
    placed.push({ chart, at: written.at, relId: drawingRels.add("chart", `../charts/chart${counters.chart}.xml`), frameId: placed.length + 1 });
  }
  if (!placed.length) return { parts };
  counters.drawing += 1;
  const n = counters.drawing;
  parts.push({ name: `xl/drawings/drawing${n}.xml`, xml: drawingXml(placed), contentType: CONTENT_TYPES.drawing });
  parts.push({ name: `xl/drawings/_rels/drawing${n}.xml.rels`, xml: drawingRels.xml() });
  return { parts, relId: rels.add("drawing", `../drawings/drawing${n}.xml`) };
}

function noteParts(sheet: Sheet, rels: Relationships, counters: Counters): { parts: Part[]; relId?: string } {
  const notes = sheetNotes(sheet);
  if (!notes.length) return { parts: [] };
  counters.comments += 1;
  const n = counters.comments;
  const vml = notesVml(notes, counters.vmlBlock);
  counters.vmlBlock += vmlBlockCount(notes);
  rels.add("comments", `../comments${n}.xml`);
  return {
    parts: [
      { name: `xl/comments${n}.xml`, xml: commentsXml(notes), contentType: CONTENT_TYPES.comments },
      { name: `xl/drawings/vmlDrawing${n}.vml`, xml: vml },
    ],
    relId: rels.add("vmlDrawing", `../drawings/vmlDrawing${n}.vml`),
  };
}

function exportSheet(ctx: ExportContext, sheet: Sheet, index: number, active: boolean, counters: Counters): SheetResult {
  const { plans, specs } = planTables(ctx, sheet);
  const plan: SheetPlan = { sheet, index, tables: plans, merges: planMerges(ctx, sheet, plans) };
  const filter = planFilter(ctx, plan);
  const grid = buildSheetData(ctx, plan);
  const rels = new Relationships();
  const charts = chartParts(ctx, sheet, rels, counters);
  const notes = noteParts(sheet, rels, counters);
  const tables = tableParts(plan, specs, rels, counters);
  const xml = worksheetXml(ctx, { plan, grid, filter, active, drawingRel: charts.relId, legacyDrawingRel: notes.relId, tableRels: tables.relIds });
  const parts: Part[] = [{ name: `xl/worksheets/sheet${index + 1}.xml`, xml, contentType: CONTENT_TYPES.worksheet }];
  if (rels.size) parts.push({ name: `xl/worksheets/_rels/sheet${index + 1}.xml.rels`, xml: rels.xml() });
  parts.push(...charts.parts, ...notes.parts, ...tables.parts);
  return { parts, filter: filter ? { sheetIndex: index, ref: absoluteRef(sheet.name, rangeText(filter.range)) } : null };
}

/** Builds a genuine .xlsx for the workbook. */
export function buildXlsxWorkbook(workbook: Workbook, options: { title?: string; now?: Date } = {}): XlsxExportResult {
  const { now = new Date(), title = "Workbook" } = options;
  const ctx = createContext(workbook, computeWorkbook(workbook, { now }));
  const counters: Counters = { table: 0, chart: 0, drawing: 0, comments: 0, vmlBlock: 1 };
  const activeTab = Math.max(0, workbook.sheets.findIndex((sheet) => !sheet.hidden));
  const workbookRels = new Relationships();
  const entries: WorkbookSheetEntry[] = [];
  const filters: FilterDatabase[] = [];
  const parts: Part[] = [];
  workbook.sheets.forEach((sheet, index) => {
    const result = exportSheet(ctx, sheet, index, index === activeTab, counters);
    parts.push(...result.parts);
    if (result.filter) filters.push(result.filter);
    entries.push({ name: sheet.name, hidden: Boolean(sheet.hidden), relId: workbookRels.add("worksheet", `worksheets/sheet${index + 1}.xml`) });
  });
  if (ctx.lists.used) {
    const n = entries.length + 1;
    parts.push({ name: `xl/worksheets/sheet${n}.xml`, xml: ctx.lists.sheetXml(ctx.strings), contentType: CONTENT_TYPES.worksheet });
    entries.push({ name: ctx.lists.sheetName, hidden: true, relId: workbookRels.add("worksheet", `worksheets/sheet${n}.xml`) });
  }
  workbookRels.add("styles", "styles.xml");
  workbookRels.add("theme", "theme/theme1.xml");
  workbookRels.add("sharedStrings", "sharedStrings.xml");
  if (ctx.dynamicArrays) {
    workbookRels.add("sheetMetadata", "metadata.xml");
    parts.push({ name: "xl/metadata.xml", xml: DYNAMIC_ARRAY_METADATA, contentType: CONTENT_TYPES.metadata });
  }
  parts.push(
    { name: "xl/workbook.xml", xml: workbookXml(ctx, entries, activeTab, filters), contentType: CONTENT_TYPES.workbook },
    { name: "xl/_rels/workbook.xml.rels", xml: workbookRels.xml() },
    { name: "xl/styles.xml", xml: ctx.styles.toXml(), contentType: CONTENT_TYPES.styles },
    { name: "xl/theme/theme1.xml", xml: themeXml(), contentType: CONTENT_TYPES.theme },
    { name: "xl/sharedStrings.xml", xml: ctx.strings.toXml(), contentType: CONTENT_TYPES.sharedStrings },
    { name: "docProps/core.xml", xml: corePropsXml(title, now), contentType: CONTENT_TYPES.core },
    { name: "docProps/app.xml", xml: APP_PROPS, contentType: CONTENT_TYPES.app },
    { name: "_rels/.rels", xml: ROOT_RELS },
  );
  const encoder = new TextEncoder();
  const zipEntries = [{ name: "[Content_Types].xml", xml: contentTypesXml(parts) }, ...parts].map((part) => ({ name: part.name, bytes: encoder.encode(part.xml) }));
  return { bytes: buildZip(zipEntries), warnings: ctx.log.list() };
}

export function xlsxExportFilename(title: string): string {
  const base = title.trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "workbook";
  return `${base}.xlsx`;
}
