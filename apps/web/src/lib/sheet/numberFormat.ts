/** Excel number formats: display text for cell values (the full format-code
 * interpreter), typed-entry parsing, built-in format ids for .xlsx, toolbar
 * presets, decimal adjustment, and format classification. The pieces live in
 * ./numberFormat/; this module is their public face. */

import { dateToSerial, timeToFraction, type Scalar } from "./formula/values";
import { type NumberFormatKind, numberFormatKind } from "./numberFormat/classify";
import { formatCellValue } from "./numberFormat/format";
import { customCode } from "./numberFormat/tokens";

export { type FormattedValue, formatCellValue } from "./numberFormat/format";
export { type ParsedInput, parseCellInput } from "./numberFormat/input";
export { BUILTIN_NUMBER_FORMATS, builtinNumberFormatId } from "./numberFormat/builtins";
export { adjustDecimals } from "./numberFormat/decimals";
export { type NumberFormatKind, isDateFormat, numberFormatKind } from "./numberFormat/classify";

export type NumberFormatPreset = { id: string; label: string; format: string | undefined; example: string };

const SAMPLE_NUMBER = 1234.5;
const SAMPLE_DATE = dateToSerial(2027, 3, 15) + timeToFraction(14, 30, 0);

const PRESETS: Array<Omit<NumberFormatPreset, "example"> & { sample: Scalar }> = [
  { id: "general", label: "General", format: undefined, sample: SAMPLE_NUMBER },
  { id: "number", label: "Number", format: "#,##0.00", sample: SAMPLE_NUMBER },
  { id: "currency", label: "Currency", format: "$#,##0.00", sample: SAMPLE_NUMBER },
  { id: "accounting", label: "Accounting", format: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)', sample: SAMPLE_NUMBER },
  { id: "percent", label: "Percent", format: "0%", sample: 0.1234 },
  { id: "percent-2", label: "Percent (2 decimals)", format: "0.00%", sample: 0.1234 },
  { id: "short-date", label: "Short date", format: "m/d/yyyy", sample: SAMPLE_DATE },
  { id: "long-date", label: "Long date", format: "mmmm d, yyyy", sample: SAMPLE_DATE },
  { id: "time", label: "Time", format: "h:mm AM/PM", sample: SAMPLE_DATE },
  { id: "datetime", label: "Date & time", format: "m/d/yyyy h:mm", sample: SAMPLE_DATE },
  { id: "scientific", label: "Scientific", format: "0.00E+00", sample: SAMPLE_NUMBER },
  { id: "fraction", label: "Fraction", format: "# ?/?", sample: 1.25 },
  { id: "text", label: "Text", format: "@", sample: SAMPLE_NUMBER },
  { id: "whole", label: "Whole number", format: "#,##0", sample: SAMPLE_NUMBER },
];

export const NUMBER_FORMAT_PRESETS: NumberFormatPreset[] = PRESETS.map(({ sample, ...preset }) => ({
  ...preset,
  example: formatCellValue(sample, preset.format).text.trim(),
}));

const KIND_LABELS: Record<NumberFormatKind, string> = {
  general: "General",
  number: "Number",
  currency: "Currency",
  accounting: "Accounting",
  percent: "Percent",
  date: "Date",
  time: "Time",
  datetime: "Date & time",
  scientific: "Scientific",
  fraction: "Fraction",
  text: "Text",
  custom: "Custom",
};

/** The toolbar chip: the preset's name when the code is a preset, otherwise its kind. */
export function numberFormatLabel(format: string | undefined): string {
  const code = customCode(format);
  const preset = NUMBER_FORMAT_PRESETS.find((candidate) => customCode(candidate.format) === code);
  return preset ? preset.label : KIND_LABELS[numberFormatKind(format)];
}
