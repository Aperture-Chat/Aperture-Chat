/** The workbook palette. Accent slots 1..6 color tables, charts, and pivot
 * headers in the editor, and the .xlsx export writes the same six colors as
 * the file's Office theme accents, so built-in Excel table and chart styles
 * render in these colors when the file is opened in Excel. */

import type { AccentSlot } from "./sheetModel";

export const SHEET_ACCENTS: Record<AccentSlot, string> = {
  1: "#087d8b", // Aperture teal
  2: "#2f6eba", // blue
  3: "#7a5ac8", // violet
  4: "#c9821a", // amber
  5: "#c2475a", // rose
  6: "#3d8b5a", // green
};

export const SHEET_ACCENT_NAMES: Record<AccentSlot, string> = {
  1: "Teal",
  2: "Blue",
  3: "Violet",
  4: "Amber",
  5: "Rose",
  6: "Green",
};

/** Office theme text/background slots written alongside the accents. */
export const SHEET_THEME_BASE = {
  dark1: "#000000",
  light1: "#ffffff",
  dark2: "#213c3f",
  light2: "#efece5",
  hyperlink: "#087d8b",
  followedHyperlink: "#7a5ac8",
} as const;

/** Chart series cycle through the accents in slot order. */
export function seriesColor(index: number): string {
  const slot = ((index % 6) + 1) as AccentSlot;
  return SHEET_ACCENTS[slot];
}

/** Default font for cells in exported workbooks (Excel's own default family,
 * so column widths measure the same in Excel as they were designed). */
export const SHEET_EXPORT_FONT = { name: "Calibri", size: 11 } as const;

/** Excel column width in characters <-> pixels at Calibri 11 (7px digit). */
export function pxToExcelWidth(px: number): number {
  return Math.max(0, Math.round(((px - 5) / 7) * 100) / 100);
}

export function excelWidthToPx(width: number): number {
  return Math.round(width * 7 + 5);
}

/** Row heights: points in the file, CSS pixels in the editor. */
export function pxToPoints(px: number): number {
  return Math.round(px * 0.75 * 100) / 100;
}

export function pointsToPx(points: number): number {
  return Math.round(points / 0.75);
}
