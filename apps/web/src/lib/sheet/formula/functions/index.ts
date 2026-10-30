/** The spreadsheet function library: one table, merged from category modules. */

import type { FunctionSpec } from "../types";
import { ARRAY_FUNCTIONS } from "./array";
import { DATETIME_FUNCTIONS } from "./datetime";
import { FINANCIAL_FUNCTIONS } from "./financial";
import { INFORMATION_FUNCTIONS } from "./information";
import { LOGICAL_FUNCTIONS } from "./logical";
import { LOOKUP_FUNCTIONS } from "./lookup";
import { MATH_FUNCTIONS } from "./math";
import { STATISTICAL_FUNCTIONS } from "./statistical";
import { TEXT_FUNCTIONS } from "./text";

export const SHEET_FUNCTIONS: Record<string, FunctionSpec> = {
  ...MATH_FUNCTIONS,
  ...STATISTICAL_FUNCTIONS,
  ...LOGICAL_FUNCTIONS,
  ...LOOKUP_FUNCTIONS,
  ...TEXT_FUNCTIONS,
  ...DATETIME_FUNCTIONS,
  ...FINANCIAL_FUNCTIONS,
  ...INFORMATION_FUNCTIONS,
  ...ARRAY_FUNCTIONS,
};

export const SHEET_FUNCTION_NAMES = Object.keys(SHEET_FUNCTIONS).sort();
