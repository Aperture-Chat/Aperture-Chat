/** Display text for a cell value under an Excel number format. Every grid
 * cell, TEXT(), CSV export, and the status bar go through here, so compiled
 * codes are cached. */

import { type Scalar, isError } from "../formula/values";
import { type CompiledFormat, chooseSection, compileFormat } from "./compile";
import { OVERFLOW } from "./dateBody";
import { formatGeneral } from "./general";
import { customCode } from "./tokens";

export type FormattedValue = { text: string; color?: string; align: "left" | "right" | "center" };

const CACHE_LIMIT = 1_000;
const cache = new Map<string, CompiledFormat>();

export function compiledFormat(code: string): CompiledFormat {
  let compiled = cache.get(code);
  if (!compiled) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    compiled = compileFormat(code);
    cache.set(code, compiled);
  }
  return compiled;
}

export function formatCellValue(value: Scalar, format?: string): FormattedValue {
  if (value === null) return { text: "", align: "left" };
  if (isError(value)) return { text: value.code, align: "center" };
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE", align: "center" };
  if (typeof value === "number") return formatNumber(value, format);
  return formatText(value, format);
}

function formatNumber(value: number, format: string | undefined): FormattedValue {
  if (!Number.isFinite(value)) return { text: "#NUM!", align: "center" };
  const code = customCode(format);
  const compiled = code === null ? null : compiledFormat(code);
  if (!compiled?.numeric.length) return { text: formatGeneral(value), align: "right" };
  const choice = chooseSection(compiled, value);
  if (!choice) return { text: OVERFLOW, align: "right" };
  return colored(choice.section.render(choice.value), choice.section.color, "right");
}

function formatText(value: string, format: string | undefined): FormattedValue {
  const code = customCode(format);
  const section = code === null ? null : compiledFormat(code).text;
  if (!section) return { text: value, align: "left" };
  return colored(section.render(value), section.color, "left");
}

function colored(text: string, color: string | undefined, align: FormattedValue["align"]): FormattedValue {
  return color ? { text, color, align } : { text, align };
}
