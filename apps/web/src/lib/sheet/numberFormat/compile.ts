/** Compiles a format code into section renderers and picks the section for
 * a number: by sign (positive; negative; zero) or by [condition]. */

import { compileDateBody, renderDateBody } from "./dateBody";
import { formatGeneral } from "./general";
import { compileNumberBody, renderNumberBody } from "./numberBody";
import { type CompareOp, type Condition, type Token, isDateSection, planSections, plainText, sectionHead, tokenizeFormat } from "./tokens";

export type NumberSection = { color?: string; condition?: Condition; render: (value: number) => string };
export type TextSection = { color?: string; render: (text: string) => string };
export type CompiledFormat = { numeric: NumberSection[]; text: TextSection | null; conditional: boolean };

export function compileFormat(code: string): CompiledFormat {
  const plan = planSections(tokenizeFormat(code));
  const numeric = plan.numeric.map(compileNumberSection);
  return {
    numeric,
    text: plan.text ? compileTextSection(plan.text) : null,
    conditional: numeric.slice(0, 2).some((section) => section.condition),
  };
}

function compileNumberSection(tokens: Token[]): NumberSection {
  const { tokens: body, ...head } = sectionHead(tokens);
  return { ...head, render: numberRenderer(body) };
}

function numberRenderer(tokens: Token[]): (value: number) => string {
  if (isDateSection(tokens)) {
    const body = compileDateBody(tokens);
    return (value) => renderDateBody(body, value);
  }
  if (tokens.some((token) => token.kind === "general")) {
    const fill = template(tokens, "general");
    return (value) => `${value < 0 ? "-" : ""}${fill(formatGeneral(Math.abs(value)))}`;
  }
  const body = compileNumberBody(tokens);
  return (value) => renderNumberBody(body, value);
}

function compileTextSection(tokens: Token[]): TextSection {
  const { tokens: body, color } = sectionHead(tokens);
  return { ...(color ? { color } : {}), render: template(body, "text") };
}

/** Literal text around a hole that takes the value ("General" or "@"). */
function template(tokens: Token[], hole: "general" | "text"): (value: string) => string {
  const parts = tokens.map((token) => (token.kind === hole ? null : plainText(token)));
  return (value) => parts.map((part) => part ?? value).join("");
}

/* ------------------------------------------------------------------ choosing */

export type Choice = { section: NumberSection; value: number } | null;

/** The section for `value` and the value it shows: a negative section shows
 * the magnitude, as its own literals carry the sign. Null when no section
 * takes the number. Call only with at least one number section. */
export function chooseSection(format: CompiledFormat, value: number): Choice {
  if (format.conditional) return chooseByCondition(format.numeric, value);
  const [first, second, third] = format.numeric;
  if (value < 0 && second) return { section: second, value: -value };
  if (value === 0 && third) return { section: third, value };
  return { section: first, value };
}

/** Conditions on the first two sections are tried in order; otherwise the
 * first section without a condition takes the number. A section that only
 * ever receives negatives shows the magnitude. */
function chooseByCondition(sections: NumberSection[], value: number): Choice {
  const [section] = [
    ...sections.slice(0, 2).filter((candidate) => candidate.condition && meets(value, candidate.condition)),
    ...sections.slice(0, 3).filter((candidate) => !candidate.condition),
  ];
  if (!section) return null;
  return { section, value: takesOnlyNegatives(sections, section) ? Math.abs(value) : value };
}

const COMPARE: Record<CompareOp, (value: number, limit: number) => boolean> = {
  "<": (value, limit) => value < limit,
  "<=": (value, limit) => value <= limit,
  ">": (value, limit) => value > limit,
  ">=": (value, limit) => value >= limit,
  "=": (value, limit) => value === limit,
  "<>": (value, limit) => value !== limit,
};

function meets(value: number, condition: Condition): boolean {
  return COMPARE[condition.op](value, condition.limit);
}

/** A section whose condition admits no positive number, or the second section
 * after a first that takes everything from zero (or below) upward. */
function takesOnlyNegatives(sections: NumberSection[], section: NumberSection): boolean {
  if (section.condition) return isNegativeCondition(section.condition);
  const first = sections[0].condition;
  return section === sections[1] && first !== undefined && (first.op === ">" || first.op === ">=") && first.limit <= 0;
}

function isNegativeCondition({ op, limit }: Condition): boolean {
  return (op === "<" || op === "<=" || op === "=") && limit <= 0;
}
