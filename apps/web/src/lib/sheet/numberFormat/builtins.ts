/** ECMA-376 built-in number formats (Part 1, §18.8.30), as en-US Excel
 * shows them. An .xlsx file stores only the id for these. Ids 5-8 and 41-44
 * are locale-dependent; Excel's en-US currency and accounting codes are used,
 * and ids 14, 15, 17, and 22 use the four-digit years en-US Excel displays. */

import { type Token, customCode, tokenizeFormat } from "./tokens";

export const BUILTIN_NUMBER_FORMATS: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  5: "$#,##0_);($#,##0)",
  6: "$#,##0_);[Red]($#,##0)",
  7: "$#,##0.00_);($#,##0.00)",
  8: "$#,##0.00_);[Red]($#,##0.00)",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "m/d/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  42: '_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  44: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)',
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

/** Codes that mean the same thing compare equal: "$" and "\$" and "\"$\"",
 * "[red]" and "[Red]", and a bare locale tag such as "[$-409]". */
function canonicalCode(code: string): string {
  if (customCode(code) === null) return "General";
  return tokenizeFormat(code)
    .map((section) => section.map(tokenKey).join(""))
    .join(";");
}

/** A token without its source span. */
function tokenKey(token: Token): string {
  return JSON.stringify(token, (key, value: unknown) => (key === "start" || key === "end" ? undefined : value));
}

const BUILTIN_IDS = new Map(Object.entries(BUILTIN_NUMBER_FORMATS).map(([id, code]) => [canonicalCode(code), Number(id)]));

export function builtinNumberFormatId(code: string): number | null {
  return BUILTIN_IDS.get(canonicalCode(code)) ?? null;
}
