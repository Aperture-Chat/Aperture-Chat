/** Excel stores functions added after Excel 2007 with a file prefix
 * ("_xlfn.XLOOKUP", "_xlfn._xlws.FILTER"). Without it Excel shows #NAME?.
 * The parser strips these prefixes on import; the .xlsx writer adds them. */

const XLWS = new Set(["FILTER", "SORT"]);

const XLFN = new Set([
  "AGGREGATE", "ARRAYTOTEXT", "BETA.DIST", "BETA.INV", "BINOM.DIST", "BINOM.INV", "BYCOL", "BYROW",
  "CEILING.MATH", "CEILING.PRECISE", "CHISQ.DIST", "CHISQ.DIST.RT", "CHISQ.INV", "CHISQ.INV.RT", "CHISQ.TEST",
  "CHOOSECOLS", "CHOOSEROWS", "CONCAT", "CONFIDENCE.NORM", "CONFIDENCE.T", "COVARIANCE.P", "COVARIANCE.S",
  "DAYS", "DROP", "EXPAND", "EXPON.DIST", "F.DIST", "F.DIST.RT", "F.INV", "F.INV.RT", "F.TEST", "FLOOR.MATH",
  "FLOOR.PRECISE", "FORECAST.ETS", "FORECAST.LINEAR", "GAMMA", "GAMMA.DIST", "GAMMA.INV", "GAMMALN.PRECISE",
  "HSTACK", "HYPGEOM.DIST", "IFNA", "IFS", "ISFORMULA", "ISOMITTED", "ISOWEEKNUM", "LAMBDA", "LET",
  "LOGNORM.DIST", "LOGNORM.INV", "MAKEARRAY", "MAP", "MAXIFS", "MINIFS", "MODE.MULT", "MODE.SNGL",
  "NETWORKDAYS.INTL", "NORM.DIST", "NORM.INV", "NORM.S.DIST", "NORM.S.INV", "NUMBERVALUE", "PERCENTILE.EXC",
  "PERCENTILE.INC", "PERCENTRANK.EXC", "PERCENTRANK.INC", "POISSON.DIST", "QUARTILE.EXC", "QUARTILE.INC",
  "RANDARRAY", "RANK.AVG", "RANK.EQ", "REDUCE", "SCAN", "SEQUENCE", "SHEET", "SHEETS", "SORTBY", "STDEV.P",
  "STDEV.S", "SWITCH", "T.DIST", "T.DIST.2T", "T.DIST.RT", "T.INV", "T.INV.2T", "T.TEST", "TAKE", "TEXTAFTER",
  "TEXTBEFORE", "TEXTJOIN", "TEXTSPLIT", "TOCOL", "TOROW", "UNICHAR", "UNICODE", "UNIQUE", "VALUETOTEXT",
  "VAR.P", "VAR.S", "VSTACK", "WEIBULL.DIST", "WORKDAY.INTL", "WRAPCOLS", "WRAPROWS", "XLOOKUP", "XMATCH",
  "XOR", "Z.TEST",
]);

/** The name as Excel writes it inside an .xlsx file. */
export function excelFileFunctionName(name: string): string {
  const upper = name.toUpperCase();
  if (XLWS.has(upper)) return `_xlfn._xlws.${upper}`;
  if (XLFN.has(upper)) return `_xlfn.${upper}`;
  return upper;
}

export function needsFilePrefix(name: string): boolean {
  const upper = name.toUpperCase();
  return XLWS.has(upper) || XLFN.has(upper);
}
