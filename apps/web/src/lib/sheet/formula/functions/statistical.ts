import type { CallContext, FunctionSpec } from "../types";
import { ERR, type Scalar, type SheetError, type Value, asMatrix, isError, isMatrix, mapValue, toNumber } from "../values";
import { areaOf, averageOf, countOf, maxOf, minOf, multiCondition, singleCondition } from "./conditional";
import { normalCdf, normalInverse, normalPdf } from "./distributions";
import { collectNumbers, collectNumbersA, define, finite, largest, numbersFn, smallest, total } from "./helpers";
import { bool, num, opt, scalar } from "./scalar";

const stat = define("Statistical");

/* ------------------------------------------------------------------ basics */

function mean(numbers: number[]): number {
  return total(numbers) / numbers.length;
}

function sumOfSquares(numbers: number[]): number {
  const center = mean(numbers);
  return total(numbers.map((item) => (item - center) ** 2));
}

function variance(sample: boolean) {
  return (numbers: number[]): number | SheetError => {
    const dof = numbers.length - (sample ? 1 : 0);
    return dof < 1 ? ERR.div0 : sumOfSquares(numbers) / dof;
  };
}

function deviation(sample: boolean) {
  const of = variance(sample);
  return (numbers: number[]): number | SheetError => {
    const result = of(numbers);
    return isError(result) ? result : Math.sqrt(result);
  };
}

function sorted(numbers: number[]): number[] {
  return [...numbers].sort((a, b) => a - b);
}

function median(numbers: number[]): number | SheetError {
  if (!numbers.length) return ERR.num;
  const order = sorted(numbers);
  const middle = Math.floor(order.length / 2);
  return order.length % 2 ? order[middle] : (order[middle - 1] + order[middle]) / 2;
}

/** The most frequent number; ties go to the one seen first. */
function mode(numbers: number[]): number | SheetError {
  const counts = new Map<number, number>();
  for (const item of numbers) counts.set(item, (counts.get(item) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 1;
  for (const [item, count] of counts) {
    if (count > bestCount) [best, bestCount] = [item, count];
  }
  return best ?? ERR.na;
}

function averageA(args: Value[], ctx: CallContext): Value {
  const numbers = collectNumbersA(args, ctx);
  if (isError(numbers)) return numbers;
  return numbers.length ? mean(numbers) : ERR.div0;
}

function extremeA(pick: (numbers: number[]) => number) {
  return (args: Value[], ctx: CallContext): Value => {
    const numbers = collectNumbersA(args, ctx);
    if (isError(numbers)) return numbers;
    return numbers.length ? pick(numbers) : 0;
  };
}

function positive(fn: (numbers: number[]) => number) {
  return (numbers: number[]): number | SheetError => (!numbers.length || numbers.some((item) => item <= 0) ? ERR.num : fn(numbers));
}

const geomean = positive((numbers) => Math.exp(mean(numbers.map(Math.log))));
const harmean = positive((numbers) => numbers.length / total(numbers.map((item) => 1 / item)));

function nonEmpty(fn: (numbers: number[]) => number) {
  return (numbers: number[]): number | SheetError => (numbers.length ? fn(numbers) : ERR.num);
}

const avedev = nonEmpty((numbers) => {
  const center = mean(numbers);
  return mean(numbers.map((item) => Math.abs(item - center)));
});

/* ------------------------------------------------------------------ counting */

/** COUNT: numbers in references and arrays; typed arguments that read as
 * numbers, including an omitted one (=COUNT(1,) is 2, as in Excel). */
function isCountable(value: Scalar, fromReference: boolean): boolean {
  if (fromReference) return typeof value === "number";
  return !isError(toNumber(value));
}

function count(args: Value[], ctx: CallContext): Value {
  let n = 0;
  for (const [index, arg] of args.entries()) {
    const fromReference = isMatrix(arg) || ctx.refs[index] !== undefined;
    for (const item of asMatrix(arg).flat()) if (isCountable(item, fromReference)) n += 1;
  }
  return n;
}

/** COUNTA: non-empty cells in references and arrays, and every typed
 * argument, even an omitted one (=COUNTA(1,) is 2, as in Excel). */
function countA(args: Value[], ctx: CallContext): Value {
  let n = 0;
  for (const [index, arg] of args.entries()) {
    const fromReference = isMatrix(arg) || ctx.refs[index] !== undefined;
    n += fromReference ? asMatrix(arg).flat().filter((item) => item !== null).length : 1;
  }
  return n;
}

function countBlank(args: Value[], ctx: CallContext): Value {
  const area = areaOf(args[0], ctx.refs[0]);
  if (isError(area)) return area;
  const cells = area.values.flat();
  return cells.filter((item) => item === null || item === "").length + area.rows * area.cols - cells.length;
}

/* ------------------------------------------------------------------ order */

/** Numbers of one argument, with that argument's reference flag. */
function numbersAt(args: Value[], ctx: CallContext, index: number): number[] | SheetError {
  return collectNumbers([args[index]], { ...ctx, refs: [ctx.refs[index]] });
}

/** (array, k) functions: k lifts, so =LARGE(A1:A9,{1;2;3}) spills. */
function withK(pick: (order: number[], k: number) => number | SheetError) {
  return (args: Value[], ctx: CallContext): Value => {
    const numbers = numbersAt(args, ctx, 0);
    if (isError(numbers)) return numbers;
    const order = sorted(numbers);
    return mapValue(args[1], (item) => {
      const k = toNumber(item);
      return isError(k) ? k : pick(order, k);
    });
  };
}

const large = withK((order, k) => {
  const index = Math.ceil(k);
  return index < 1 || index > order.length ? ERR.num : order[order.length - index];
});

const small = withK((order, k) => {
  const index = Math.ceil(k);
  return index < 1 || index > order.length ? ERR.num : order[index - 1];
});

/** Linear interpolation at a 0-based fractional position of sorted data. */
function interpolate(order: number[], position: number): number {
  const low = Math.floor(position);
  const fraction = position - low;
  return low + 1 < order.length ? order[low] + fraction * (order[low + 1] - order[low]) : order[low];
}

function percentileInc(order: number[], k: number): number | SheetError {
  if (!order.length || k < 0 || k > 1) return ERR.num;
  return interpolate(order, k * (order.length - 1));
}

function percentileExc(order: number[], k: number): number | SheetError {
  const n = order.length;
  if (!n || k * (n + 1) < 1 || k * (n + 1) > n) return ERR.num;
  return interpolate(order, k * (n + 1) - 1);
}

/** QUARTILE: the percentile at a whole quarter; the percentile rejects
 * quarters outside its range (0-4 inclusive, 1-3 exclusive). */
function quartile(percentile: (order: number[], k: number) => number | SheetError) {
  return (order: number[], quart: number): number | SheetError => percentile(order, Math.trunc(quart) / 4);
}

function rank(average: boolean) {
  return (args: Value[], ctx: CallContext): Value => {
    const numbers = numbersAt(args, ctx, 1);
    if (isError(numbers)) return numbers;
    const ascending = args.length > 2 && toNumber(asMatrix(args[2])[0][0]) !== 0;
    return mapValue(args[0], (item) => {
      const x = toNumber(item);
      if (isError(x)) return x;
      const ahead = numbers.filter((other) => (ascending ? other < x : other > x)).length;
      const ties = numbers.filter((other) => other === x).length;
      if (!ties) return ERR.na;
      return average ? ahead + (ties + 1) / 2 : ahead + 1;
    });
  };
}

/** The share of values below x, interpolated between the neighbours when x
 * is not in the data (LibreOffice's algorithm, which matches Excel). The
 * smallest value, and a one-value list, rank 0. */
function percentRank(order: number[], x: number): number {
  const below = order.filter((item) => item < x).length;
  if (order[below] === x) return below === 0 ? 0 : below / (order.length - 1);
  const fraction = (x - order[below - 1]) / (order[below] - order[below - 1]);
  return (below - 1 + fraction) / (order.length - 1);
}

function percentRankInc(args: Value[], ctx: CallContext): Value {
  const numbers = numbersAt(args, ctx, 0);
  if (isError(numbers)) return numbers;
  const order = sorted(numbers);
  return scalar([num, opt(num, 3)], (x, significance) => {
    const digits = Math.trunc(significance);
    if (digits < 1) return ERR.num;
    if (!order.length || x < order[0] || x > order[order.length - 1]) return ERR.na;
    const scale = 10 ** digits;
    return Math.floor(Number((percentRank(order, x) * scale).toPrecision(15))) / scale;
  })(args.slice(1));
}

/* ------------------------------------------------------------------ pairs */

type Pairs = { xs: number[]; ys: number[] };

/** Position-wise pairs of two equally sized arrays; a pair is skipped unless
 * both sides are numbers. */
function numericPairs(left: Value, right: Value): Pairs | SheetError {
  const a = asMatrix(left).flat();
  const b = asMatrix(right).flat();
  if (a.length !== b.length) return ERR.na;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [index, item] of a.entries()) {
    const other = b[index];
    if (isError(item)) return item;
    if (isError(other)) return other;
    if (typeof item === "number" && typeof other === "number") {
      xs.push(item);
      ys.push(other);
    }
  }
  return { xs, ys };
}

type Moments = { n: number; sxx: number; syy: number; sxy: number; meanX: number; meanY: number };

function moments({ xs, ys }: Pairs): Moments {
  const meanX = mean(xs);
  const meanY = mean(ys);
  let [sxx, syy, sxy] = [0, 0, 0];
  for (const [index, x] of xs.entries()) {
    const dx = x - meanX;
    const dy = ys[index] - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  return { n: xs.length, sxx, syy, sxy, meanX, meanY };
}

/** A two-array statistic. CORREL takes (xs, ys); SLOPE, INTERCEPT, and RSQ
 * take (known_ys, known_xs), so `xFirst` is false for them. */
function paired(fn: (m: Moments) => number | SheetError, xFirst = true) {
  return (args: Value[]): Value => {
    const pairs = xFirst ? numericPairs(args[0], args[1]) : numericPairs(args[1], args[0]);
    if (isError(pairs)) return pairs;
    if (!pairs.xs.length) return ERR.div0;
    const result = fn(moments(pairs));
    return isError(result) ? result : finite(result);
  };
}

const correl = (m: Moments) => (m.sxx === 0 || m.syy === 0 ? ERR.div0 : m.sxy / Math.sqrt(m.sxx * m.syy));
const slope = (m: Moments) => (m.sxx === 0 ? ERR.div0 : m.sxy / m.sxx);
const intercept = (m: Moments) => (m.sxx === 0 ? ERR.div0 : m.meanY - (m.sxy / m.sxx) * m.meanX);
const rsq = (m: Moments) => {
  const r = correl(m);
  return isError(r) ? r : r * r;
};

function forecast(args: Value[]): Value {
  const pairs = numericPairs(args[2], args[1]);
  if (isError(pairs)) return pairs;
  const m = moments(pairs);
  if (!m.n || m.sxx === 0) return ERR.div0;
  const b = m.sxy / m.sxx;
  return scalar([num], (x) => m.meanY + b * (x - m.meanX))([args[0]]);
}

/* ------------------------------------------------------------------ normal */

function normDist(x: number, center: number, sd: number, cumulative: boolean): number | SheetError {
  if (sd <= 0) return ERR.num;
  const z = (x - center) / sd;
  return cumulative ? normalCdf(z) : normalPdf(z) / sd;
}

function normInv(p: number, center: number, sd: number): number | SheetError {
  if (p <= 0 || p >= 1 || sd <= 0) return ERR.num;
  return center + sd * normalInverse(p);
}

/* ------------------------------------------------------------------ frequency */

function frequency(args: Value[], ctx: CallContext): Value {
  const values = numbersAt(args, ctx, 0);
  if (isError(values)) return values;
  const bins = numbersAt(args, ctx, 1);
  if (isError(bins)) return bins;
  const order = bins.map((bin, index) => ({ bin, index })).sort((a, b) => a.bin - b.bin);
  const counts = new Array<number>(bins.length + 1).fill(0);
  for (const value of values) {
    const slot = order.find((entry) => value <= entry.bin);
    counts[slot ? slot.index : bins.length] += 1;
  }
  return counts.map((item) => [item]);
}

const sample = { fn: numbersFn(variance(true)) };
const population = { fn: numbersFn(variance(false)) };
const sampleDeviation = { fn: numbersFn(deviation(true)) };
const populationDeviation = { fn: numbersFn(deviation(false)) };
const percentileIncSpec = { fn: withK(percentileInc) };
const quartileIncSpec = { fn: withK(quartile(percentileInc)) };
const rankEq = { fn: rank(false) };
const forecastSpec = { fn: forecast };
const modeSpec = { fn: numbersFn(mode) };

export const STATISTICAL_FUNCTIONS: Record<string, FunctionSpec> = {
  AVERAGE: stat("number1, [number2], ...", "Returns the average of numbers.", { fn: numbersFn((numbers) => (numbers.length ? mean(numbers) : ERR.div0)) }),
  AVERAGEA: stat("value1, [value2], ...", "Returns the average, counting text as 0 and TRUE as 1.", { fn: averageA }),
  AVERAGEIF: stat("range, criteria, [average_range]", "Returns the average of the cells that meet one condition.", { fn: singleCondition(averageOf) }),
  AVERAGEIFS: stat("average_range, criteria_range1, criteria1, [criteria_range2, criteria2], ...", "Returns the average of the cells that meet every condition.", { fn: multiCondition(averageOf) }),
  COUNT: stat("value1, [value2], ...", "Counts the cells that contain numbers.", { fn: count }),
  COUNTA: stat("value1, [value2], ...", "Counts the cells that are not empty.", { fn: countA }),
  COUNTBLANK: stat("range", "Counts the empty cells in a range.", { fn: countBlank }),
  COUNTIF: stat("range, criteria", "Counts the cells that meet one condition.", { fn: singleCondition(countOf, true) }),
  COUNTIFS: stat("criteria_range1, criteria1, [criteria_range2, criteria2], ...", "Counts the cells that meet every condition.", { fn: multiCondition(countOf, true) }),
  MAX: stat("number1, [number2], ...", "Returns the largest number.", { fn: numbersFn((numbers) => (numbers.length ? largest(numbers) : 0)) }),
  MAXA: stat("value1, [value2], ...", "Returns the largest value, counting text as 0 and TRUE as 1.", { fn: extremeA(largest) }),
  MAXIFS: stat("max_range, criteria_range1, criteria1, [criteria_range2, criteria2], ...", "Returns the largest number among cells that meet every condition.", { fn: multiCondition(maxOf) }),
  MIN: stat("number1, [number2], ...", "Returns the smallest number.", { fn: numbersFn((numbers) => (numbers.length ? smallest(numbers) : 0)) }),
  MINA: stat("value1, [value2], ...", "Returns the smallest value, counting text as 0 and TRUE as 1.", { fn: extremeA(smallest) }),
  MINIFS: stat("min_range, criteria_range1, criteria1, [criteria_range2, criteria2], ...", "Returns the smallest number among cells that meet every condition.", { fn: multiCondition(minOf) }),
  MEDIAN: stat("number1, [number2], ...", "Returns the middle number.", { fn: numbersFn(median) }),
  MODE: stat("number1, [number2], ...", "Returns the most frequent number.", modeSpec),
  "MODE.SNGL": stat("number1, [number2], ...", "Returns the most frequent number.", modeSpec),
  STDEV: stat("number1, [number2], ...", "Estimates standard deviation from a sample.", sampleDeviation),
  "STDEV.S": stat("number1, [number2], ...", "Estimates standard deviation from a sample.", sampleDeviation),
  "STDEV.P": stat("number1, [number2], ...", "Returns the standard deviation of a whole population.", populationDeviation),
  STDEVP: stat("number1, [number2], ...", "Returns the standard deviation of a whole population.", populationDeviation),
  VAR: stat("number1, [number2], ...", "Estimates variance from a sample.", sample),
  "VAR.S": stat("number1, [number2], ...", "Estimates variance from a sample.", sample),
  "VAR.P": stat("number1, [number2], ...", "Returns the variance of a whole population.", population),
  VARP: stat("number1, [number2], ...", "Returns the variance of a whole population.", population),
  LARGE: stat("array, k", "Returns the k-th largest number.", { fn: large }),
  SMALL: stat("array, k", "Returns the k-th smallest number.", { fn: small }),
  RANK: stat("number, ref, [order]", "Returns the rank of a number in a list (0 = descending).", rankEq),
  "RANK.EQ": stat("number, ref, [order]", "Returns the rank of a number in a list; ties share the top rank.", rankEq),
  "RANK.AVG": stat("number, ref, [order]", "Returns the rank of a number in a list; ties share the average rank.", { fn: rank(true) }),
  PERCENTILE: stat("array, k", "Returns the k-th percentile, with k from 0 to 1.", percentileIncSpec),
  "PERCENTILE.INC": stat("array, k", "Returns the k-th percentile, with k from 0 to 1.", percentileIncSpec),
  "PERCENTILE.EXC": stat("array, k", "Returns the k-th percentile, with k strictly between 0 and 1.", { fn: withK(percentileExc) }),
  QUARTILE: stat("array, quart", "Returns a quartile (0 to 4) of the data.", quartileIncSpec),
  "QUARTILE.INC": stat("array, quart", "Returns a quartile (0 to 4) of the data.", quartileIncSpec),
  "QUARTILE.EXC": stat("array, quart", "Returns a quartile (1 to 3) of the data, excluding the ends.", { fn: withK(quartile(percentileExc)) }),
  "PERCENTRANK.INC": stat("array, x, [significance]", "Returns the rank of a value as a fraction of the data, from 0 to 1.", { fn: percentRankInc }),
  CORREL: stat("array1, array2", "Returns the correlation coefficient of two data sets.", { fn: paired(correl) }),
  PEARSON: stat("array1, array2", "Returns the Pearson correlation coefficient of two data sets.", { fn: paired(correl) }),
  "COVARIANCE.S": stat("array1, array2", "Returns the sample covariance of two data sets.", { fn: paired((m) => (m.n < 2 ? ERR.div0 : m.sxy / (m.n - 1))) }),
  "COVARIANCE.P": stat("array1, array2", "Returns the population covariance of two data sets.", { fn: paired((m) => m.sxy / m.n) }),
  SLOPE: stat("known_ys, known_xs", "Returns the slope of the linear regression line.", { fn: paired(slope, false) }),
  INTERCEPT: stat("known_ys, known_xs", "Returns where the linear regression line crosses the y-axis.", { fn: paired(intercept, false) }),
  RSQ: stat("known_ys, known_xs", "Returns the square of the correlation coefficient.", { fn: paired(rsq, false) }),
  FORECAST: stat("x, known_ys, known_xs", "Predicts a value along the linear trend.", forecastSpec),
  "FORECAST.LINEAR": stat("x, known_ys, known_xs", "Predicts a value along the linear trend.", forecastSpec),
  GEOMEAN: stat("number1, [number2], ...", "Returns the geometric mean of positive numbers.", { fn: numbersFn(geomean) }),
  HARMEAN: stat("number1, [number2], ...", "Returns the harmonic mean of positive numbers.", { fn: numbersFn(harmean) }),
  AVEDEV: stat("number1, [number2], ...", "Returns the average absolute distance from the mean.", { fn: numbersFn(avedev) }),
  DEVSQ: stat("number1, [number2], ...", "Returns the sum of squared distances from the mean.", { fn: numbersFn(nonEmpty(sumOfSquares)) }),
  STANDARDIZE: stat("x, mean, standard_dev", "Returns how many standard deviations a value is from the mean.", { fn: scalar([num, num, num], (x, center, sd) => (sd <= 0 ? ERR.num : (x - center) / sd)) }),
  "NORM.DIST": stat("x, mean, standard_dev, cumulative", "Returns the normal distribution (cumulative or density).", { fn: scalar([num, num, num, bool], normDist) }),
  "NORM.INV": stat("probability, mean, standard_dev", "Returns the value with a given cumulative normal probability.", { fn: scalar([num, num, num], normInv) }),
  "NORM.S.DIST": stat("z, cumulative", "Returns the standard normal distribution (cumulative or density).", { fn: scalar([num, bool], (z, cumulative) => normDist(z, 0, 1, cumulative)) }),
  "NORM.S.INV": stat("probability", "Returns the z with a given cumulative standard normal probability.", { fn: scalar([num], (p) => normInv(p, 0, 1)) }),
  FREQUENCY: stat("data_array, bins_array", "Counts how many values fall into each bin.", { array: true, fn: frequency }),
};
