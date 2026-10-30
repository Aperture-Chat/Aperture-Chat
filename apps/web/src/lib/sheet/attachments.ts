/** Reads spreadsheet-shaped attachments (CSV, TSV, Excel) into compact,
 * model-readable text, so the spreadsheet assistant works from the actual
 * rows instead of the short text preview the server keeps for chat files. */

import { workbookFromDelimited } from "./csv";
import { computeWorkbook } from "./recalc";
import { describeSheet } from "./sheetAi";
import type { Workbook } from "./sheetModel";
import { importXlsxWorkbook } from "./xlsxImport";

const MAX_ATTACHMENT_TEXT = 24_000;
const MAX_ATTACHMENT_BYTES = 12_000_000;

export function isTabularFile(name: string): boolean {
  return /\.(csv|tsv|xlsx|xlsm)$/i.test(name);
}

/** Opens a CSV, TSV, or .xlsx file as a workbook (for "Open in editor"). */
export async function workbookFromFile(file: File): Promise<{ workbook: Workbook; warnings: string[] }> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} is larger than 12 MB.`);
  if (/\.(xlsx|xlsm)$/i.test(file.name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return importXlsxWorkbook(bytes);
  }
  if (/\.xls$/i.test(file.name)) throw new Error("Old .xls files are not supported. Save it as .xlsx in Excel first.");
  const text = await file.text();
  const stem = file.name.replace(/\.[^.]+$/, "").slice(0, 31) || "Data";
  return workbookFromDelimited(stem, text);
}

/** The attachment's sheets as text for the assistant prompt, or null when
 * the file is not tabular or cannot be read. */
export async function tabularAttachmentText(file: File): Promise<string | null> {
  if (!isTabularFile(file.name)) return null;
  try {
    const { workbook } = await workbookFromFile(file);
    const engine = computeWorkbook(workbook);
    const budget = Math.floor(MAX_ATTACHMENT_TEXT / Math.max(1, workbook.sheets.length));
    const parts = workbook.sheets.map((sheet) => describeSheet(sheet, engine, Math.max(2000, budget)));
    return `Attached file "${file.name}":\n${parts.join("\n\n")}`.slice(0, MAX_ATTACHMENT_TEXT);
  } catch {
    return null;
  }
}
