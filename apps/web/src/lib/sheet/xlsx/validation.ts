/** Data validation rules as `<dataValidations>`. The dropdown arrow shows by
 * default; note that OOXML's showDropDown="1" HIDES it, so it is never set. */

import { splitSheetQualifiedRef } from "../address";
import type { SheetValidation } from "../sheetModel";
import { CELL_OPERATOR_NAMES } from "./conditional";
import type { ExportContext } from "./context";
import { absoluteRef } from "./formulaText";
import { operandFormula } from "./operands";
import { attrs, escapeXml, plainText } from "./xml";

/** Excel's limits: an inline list source and an error message. */
const MAX_INLINE_LIST = 255;
const MAX_ERROR_MESSAGE = 225;

function listFormula(ctx: ExportContext, validation: SheetValidation): string {
  if (validation.source) {
    const { sheet, ref } = splitSheetQualifiedRef(validation.source);
    return absoluteRef(sheet, ref);
  }
  const { items = [] } = validation;
  const clean = items.map(plainText);
  const inline = clean.map((item) => item.replace(/"/g, '""')).join(",");
  if (inline.length <= MAX_INLINE_LIST && clean.every((item) => !item.includes(","))) return `"${inline}"`;
  return ctx.lists.reference(clean);
}

function ruleFormulas(ctx: ExportContext, validation: SheetValidation): string[] {
  if (validation.kind === "list") return [listFormula(ctx, validation)];
  const { value = "", value2 = "", op = "between" } = validation;
  const dates = validation.kind === "date";
  const ranged = op === "between" || op === "notBetween";
  return (ranged ? [value, value2] : [value]).map((operand) => operandFormula(operand, { dates }));
}

function message(validation: SheetValidation): string | undefined {
  return validation.message ? plainText(validation.message).slice(0, MAX_ERROR_MESSAGE) : undefined;
}

function validationXml(ctx: ExportContext, validation: SheetValidation): string {
  const { op = "between" } = validation;
  const head = attrs({
    type: validation.kind,
    operator: validation.kind === "list" ? undefined : CELL_OPERATOR_NAMES[op],
    errorStyle: validation.strict ? undefined : "warning",
    allowBlank: true,
    showInputMessage: true,
    showErrorMessage: true,
    error: message(validation),
    sqref: validation.ref,
  });
  const body = ruleFormulas(ctx, validation)
    .map((formula, index) => `<formula${index + 1}>${escapeXml(formula)}</formula${index + 1}>`)
    .join("");
  return `<dataValidation${head}>${body}</dataValidation>`;
}

export function dataValidationsXml(ctx: ExportContext, validations: SheetValidation[] | undefined): string {
  if (!validations?.length) return "";
  return `<dataValidations count="${validations.length}">${validations.map((item) => validationXml(ctx, item)).join("")}</dataValidations>`;
}
