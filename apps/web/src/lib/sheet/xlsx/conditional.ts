/** Conditional formats as `<conditionalFormatting>` blocks. Formulas inside
 * rules are relative to the top-left cell of the rule's range, as Excel
 * evaluates them; priorities are unique per sheet in rule order. */

import { cellKey, parseRangeRef } from "../address";
import type { CellOperator, ConditionalRule, TextOperator } from "../sheetModel";
import type { ExportContext } from "./context";
import { operandFormula } from "./operands";
import { argb, attrs, escapeXml } from "./xml";

export const CELL_OPERATOR_NAMES: Record<CellOperator, string> = {
  gt: "greaterThan",
  gte: "greaterThanOrEqual",
  lt: "lessThan",
  lte: "lessThanOrEqual",
  eq: "equal",
  neq: "notEqual",
  between: "between",
  notBetween: "notBetween",
};

const quoted = (text: string) => `"${text.replace(/"/g, '""')}"`;

const TEXT_RULES: Record<TextOperator, { type: string; operator: string; formula: (cell: string, text: string) => string }> = {
  contains: { type: "containsText", operator: "containsText", formula: (cell, text) => `NOT(ISERROR(SEARCH(${text},${cell})))` },
  notContains: { type: "notContainsText", operator: "notContains", formula: (cell, text) => `ISERROR(SEARCH(${text},${cell}))` },
  begins: { type: "beginsWith", operator: "beginsWith", formula: (cell, text) => `LEFT(${cell},LEN(${text}))=${text}` },
  ends: { type: "endsWith", operator: "endsWith", formula: (cell, text) => `RIGHT(${cell},LEN(${text}))=${text}` },
};

const formulas = (...items: string[]) => items.map((item) => `<formula>${escapeXml(item)}</formula>`).join("");

type RuleXml = { attributes: Record<string, string | number | boolean | undefined>; body: string };

function scaleRule(rule: Extract<ConditionalRule, { type: "scale" }>): RuleXml {
  const stops = rule.mid ? [rule.min, rule.mid, rule.max] : [rule.min, rule.max];
  const cfvo = rule.mid ? `<cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/>` : `<cfvo type="min"/><cfvo type="max"/>`;
  return { attributes: { type: "colorScale" }, body: `<colorScale>${cfvo}${stops.map((color) => `<color rgb="${argb(color)}"/>`).join("")}</colorScale>` };
}

type StyledRule = Exclude<ConditionalRule, { type: "scale" | "bar" }>;
type StyledType = StyledRule["type"];
type RuleOf<T extends StyledType> = Extract<StyledRule, { type: T }>;
type StyledBuilder<T extends StyledType> = (rule: RuleOf<T>, topLeft: string) => RuleXml;

function cellRule(rule: RuleOf<"cell">): RuleXml {
  const ranged = rule.op === "between" || rule.op === "notBetween";
  const { value, value2 = "" } = rule;
  const operands = ranged ? [value, value2] : [value];
  return { attributes: { type: "cellIs", operator: CELL_OPERATOR_NAMES[rule.op] }, body: formulas(...operands.map((value) => operandFormula(value))) };
}

function textRule(rule: RuleOf<"text">, topLeft: string): RuleXml {
  const spec = TEXT_RULES[rule.op];
  return { attributes: { type: spec.type, operator: spec.operator, text: rule.text }, body: formulas(spec.formula(topLeft, quoted(rule.text))) };
}

function rankRule(rule: RuleOf<"top" | "bottom">): RuleXml {
  const rank = rule.percent ? Math.min(rule.count, 100) : rule.count;
  return { attributes: { type: "top10", percent: rule.percent, bottom: rule.type === "bottom", rank }, body: "" };
}

const fixed = (attributes: RuleXml["attributes"]) => (): RuleXml => ({ attributes, body: "" });

const STYLED_RULES: { [T in StyledType]: StyledBuilder<T> } = {
  cell: cellRule,
  text: textRule,
  top: rankRule,
  bottom: rankRule,
  duplicate: fixed({ type: "duplicateValues" }),
  unique: fixed({ type: "uniqueValues" }),
  above: fixed({ type: "aboveAverage" }),
  below: fixed({ type: "aboveAverage", aboveAverage: 0 }),
  blank: (_, topLeft) => ({ attributes: { type: "containsBlanks" }, body: formulas(`LEN(TRIM(${topLeft}))=0`) }),
  notBlank: (_, topLeft) => ({ attributes: { type: "notContainsBlanks" }, body: formulas(`LEN(TRIM(${topLeft}))>0`) }),
  formula: (rule) => ({ attributes: { type: "expression" }, body: formulas(operandFormula(`=${rule.formula}`)) }),
};

function styledRule(ctx: ExportContext, rule: StyledRule, topLeft: string): RuleXml {
  const build = STYLED_RULES[rule.type] as StyledBuilder<StyledType>;
  const { attributes, body } = build(rule, topLeft);
  return { attributes: { type: attributes.type, dxfId: ctx.styles.dxf(rule.style), ...attributes }, body };
}

function ruleXml(ctx: ExportContext, rule: ConditionalRule, topLeft: string): RuleXml {
  if (rule.type === "scale") return scaleRule(rule);
  if (rule.type === "bar") return { attributes: { type: "dataBar" }, body: `<dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="${argb(rule.color)}"/></dataBar>` };
  return styledRule(ctx, rule, topLeft);
}

export function conditionalFormattingXml(ctx: ExportContext, rules: ConditionalRule[] = []): string {
  return rules
    .map((rule, index) => {
      const range = parseRangeRef(rule.ref);
      if (!range) return "";
      const { attributes, body } = ruleXml(ctx, rule, cellKey(range.r1, range.c1));
      const open = `<cfRule${attrs({ ...attributes, priority: index + 1 })}`;
      return `<conditionalFormatting sqref="${rule.ref}">${body ? `${open}>${body}</cfRule>` : `${open}/>`}</conditionalFormatting>`;
    })
    .join("");
}
