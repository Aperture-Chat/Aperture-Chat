/** Row exports shared by every console: the column shape, CSV text, and the
 * date and name parts of a file name. Excel output lives in tabularExcel.ts so
 * the workbook writer loads only when someone asks for it. */

export type ExportValue = string | number | boolean | null | undefined;

export type ExportColumn<T> = {
  /** The raw field name. CSV keeps it as is; Excel shows it as words. */
  header: string;
  value: (item: T) => ExportValue;
  /** An ISO timestamp, written to Excel as a real date. */
  kind?: "datetime";
};

export type ExportFormat = "xlsx" | "csv";

function csvEscape(value: ExportValue) {
  const text = value === null || value === undefined ? "" : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function rowsToCsv<T>(items: T[], columns: Array<ExportColumn<T>>) {
  const header = columns.map((column) => csvEscape(column.header)).join(",");
  const rows = items.map((item) => columns.map((column) => csvEscape(column.value(item))).join(","));
  return [header, ...rows].join("\r\n");
}

/** The byte-order mark tells Excel the file is UTF-8. */
export function csvBlob<T>(items: T[], columns: Array<ExportColumn<T>>) {
  return new Blob([`﻿${rowsToCsv(items, columns)}`], { type: "text/csv;charset=utf-8" });
}

const SHOUTED_WORDS = new Set(["id", "json", "url", "ip"]);

export function exportHeaderLabel(header: string) {
  return header
    .split("_")
    .map((word, index) => {
      if (SHOUTED_WORDS.has(word)) return word.toUpperCase();
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}

export function exportRangeLabel(fromDate: string, throughDate: string) {
  if (fromDate && throughDate) return `${fromDate}_to_${throughDate}`;
  if (fromDate) return `from_${fromDate}`;
  if (throughDate) return `through_${throughDate}`;
  return "all-dates";
}

export function exportFilenamePart(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "selected-user"
  );
}
