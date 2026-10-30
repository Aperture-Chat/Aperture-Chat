/** Criteria matching for COUNTIF, SUMIF(S), AVERAGEIF(S), MAXIFS, MINIFS and
 * the database-style filters, plus the wildcard matcher MATCH, VLOOKUP,
 * XLOOKUP, and SEARCH share. Excel rules:
 *  - a number or TRUE/FALSE criterion matches equal values ("5" text too);
 *  - text may start with =, <>, <, >, <=, >=; a numeric operand compares
 *    numerically against numbers only, a text operand compares as text;
 *  - "=" and "<>" with text use wildcards (* any run, ? one char, ~ escapes);
 *  - "" or "=" matches blank cells, "<>" matches non-blank cells. */

import { type Scalar, compareScalars, isError, parseDateText, parseNumericText } from "../values";

export function wildcardToRegExp(pattern: string): RegExp {
  return new RegExp(`^${wildcardSource(pattern)}$`, "i");
}

/** The regular-expression source for a wildcard pattern, without anchors
 * (SEARCH finds the pattern anywhere in the text). */
export function wildcardSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index];
    if (ch === "~" && /[*?~]/.test(pattern.charAt(index + 1))) {
      source += `\\${pattern[index + 1]}`;
      index += 1;
    } else if (ch === "*") source += "[\\s\\S]*";
    else if (ch === "?") source += "[\\s\\S]";
    else source += ch.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
  }
  return source;
}

export function hasWildcards(pattern: string): boolean {
  return /(^|[^~])[*?]/.test(pattern);
}

export type Criterion = (value: Scalar) => boolean;

function numericOperand(text: string): number | null {
  return parseNumericText(text) ?? parseDateText(text);
}

type Operator = "=" | "<>" | "<" | ">" | "<=" | ">=";

/** Whether a comparison result (negative, zero, positive) satisfies `op`. */
const SATISFIES: Record<Operator, (order: number) => boolean> = {
  "=": (order) => order === 0,
  "<>": (order) => order !== 0,
  "<": (order) => order < 0,
  ">": (order) => order > 0,
  "<=": (order) => order <= 0,
  ">=": (order) => order >= 0,
};

const isBlank: Criterion = (value) => value === null || value === "";

export function makeCriterion(criteria: Scalar): Criterion {
  if (isError(criteria)) return () => false;
  if (criteria === null) return isBlank;
  if (typeof criteria === "number") return equalsNumber(criteria);
  if (typeof criteria === "boolean") return (value) => value === criteria;
  return textCriterion(criteria);
}

function equalsNumber(target: number): Criterion {
  return (value) => (typeof value === "number" ? value === target : typeof value === "string" && numericOperand(value) === target);
}

function textCriterion(criteria: string): Criterion {
  const match = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(criteria)!;
  return operandCriterion((match[1] || "=") as Operator, match[2]);
}

function operandCriterion(op: Operator, operand: string): Criterion {
  const equality = op === "=" || op === "<>";
  if (operand === "" && equality) return op === "=" ? isBlank : (value) => !isBlank(value);
  const number = numericOperand(operand);
  if (number !== null) return numericCriterion(op, number);
  const upper = operand.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE") return booleanCriterion(op, upper === "TRUE");
  return equality ? wildcardCriterion(op, operand) : orderedTextCriterion(op, operand);
}

/** A numeric operand compares with numbers; = and <> also read numeric text. */
function numericCriterion(op: Operator, number: number): Criterion {
  const equality = op === "=" || op === "<>";
  return (value) => {
    const difference = numericDifference(value, number, equality);
    return difference === null ? op === "<>" : SATISFIES[op](difference);
  };
}

function numericDifference(value: Scalar, number: number, equality: boolean): number | null {
  if (typeof value === "number") return value - number;
  if (!equality || typeof value !== "string") return null;
  const parsed = numericOperand(value);
  return parsed === null ? null : parsed - number;
}

function booleanCriterion(op: Operator, truth: boolean): Criterion {
  return op === "<>" ? (value) => value !== truth : (value) => value === truth;
}

function wildcardCriterion(op: Operator, operand: string): Criterion {
  const regex = wildcardToRegExp(operand);
  const test = (value: Scalar) => typeof value === "string" && regex.test(value);
  return op === "=" ? test : (value) => !test(value);
}

function orderedTextCriterion(op: Operator, operand: string): Criterion {
  return (value) => typeof value === "string" && SATISFIES[op](compareScalars(value, operand));
}
