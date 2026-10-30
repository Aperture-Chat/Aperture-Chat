/** Rule operands (conditional formats, data validation) as Excel formulas:
 * "=..." is a formula, numbers stay numbers, dates become serials when the
 * rule compares dates, TRUE/FALSE stay logical, and anything else is text. */

import { parseDateText } from "../formula/values";
import { prepareFormula } from "./formulaText";

const quoted = (text: string) => `"${text.replace(/"/g, '""')}"`;

export function operandFormula(value: string, options: { dates?: boolean } = {}): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("=")) {
    const formula = prepareFormula(trimmed.slice(1));
    return formula ? formula.text : quoted(trimmed);
  }
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) return String(Number(trimmed));
  if (options.dates) {
    const serial = parseDateText(trimmed);
    if (serial !== null) return String(serial);
  }
  if (/^(TRUE|FALSE)$/i.test(trimmed)) return trimmed.toUpperCase();
  return quoted(value);
}
