/** Time-value-of-money functions. Signs follow Excel's cash-flow convention:
 * money paid out is negative, money received is positive. */

import type { CallContext, FunctionSpec } from "../types";
import { ERR, type SheetError, type Value, asMatrix, isError } from "../values";
import { argAt, collectNumbers, define } from "./helpers";
import { type Arg, int, num, opt, scalar } from "./scalar";

const fin = define("Financial");

/** Excel reads any non-zero payment type as 1 (payments at period start). */
const when: Arg<number> = (value) => {
  const number = opt(num, 0)(value);
  return isError(number) ? number : number !== 0 ? 1 : 0;
};
const zero = opt(num, 0);

/** The terms of the time-value equation pv*growth + payments + fv = 0. */
function growth(rate: number, nper: number): number {
  return (1 + rate) ** nper;
}

function payments(rate: number, nper: number, pmt: number, type: number): number {
  return rate === 0 ? pmt * nper : (pmt * (1 + rate * type) * (growth(rate, nper) - 1)) / rate;
}

export function fvOf(rate: number, nper: number, pmt: number, pv: number, type: number): number {
  return -(pv * growth(rate, nper) + payments(rate, nper, pmt, type));
}

export function pmtOf(rate: number, nper: number, pv: number, fv: number, type: number): number {
  if (rate === 0) return -(pv + fv) / nper;
  const g = growth(rate, nper);
  return -(rate * (fv + pv * g)) / ((1 + rate * type) * (g - 1));
}

function pvOf(rate: number, nper: number, pmt: number, fv: number, type: number): number {
  return -(fv + payments(rate, nper, pmt, type)) / growth(rate, nper);
}

function nperOf(rate: number, pmt: number, pv: number, fv: number, type: number): number | SheetError {
  // A zero payment divides by zero and a non-positive ratio has no logarithm;
  // both give Infinity or NaN, which finite() reports as #NUM!.
  if (rate === 0) return -(pv + fv) / pmt;
  const adjusted = pmt * (1 + rate * type);
  return Math.log((adjusted - fv * rate) / (adjusted + pv * rate)) / Math.log(1 + rate);
}

function ipmtOf(rate: number, per: number, nper: number, pv: number, fv: number, type: number): number | SheetError {
  if (per < 1 || per > nper) return ERR.num;
  const payment = pmtOf(rate, nper, pv, fv, type);
  if (per === 1) return type ? 0 : -pv * rate;
  const balance = type ? fvOf(rate, per - 2, payment, pv, 1) - payment : fvOf(rate, per - 1, payment, pv, 0);
  return balance * rate;
}

function ppmtOf(rate: number, per: number, nper: number, pv: number, fv: number, type: number): number | SheetError {
  const interest = ipmtOf(rate, per, nper, pv, fv, type);
  return isError(interest) ? interest : pmtOf(rate, nper, pv, fv, type) - interest;
}

/* ------------------------------------------------------------------ solving */

type Curve = (rate: number) => { value: number; slope: number };

/** Newton's method from `guess`; #NUM! when it leaves (-1, inf) or stalls. */
function solve(curve: Curve, guess: number): number | SheetError {
  let rate = guess;
  for (let step = 0; step < 100; step += 1) {
    const { value, slope } = curve(rate);
    const next = rate - value / slope;
    if (!Number.isFinite(next) || next <= -1) return ERR.num;
    if (Math.abs(next - rate) < 1e-12 * Math.max(1, Math.abs(rate))) return next;
    rate = next;
  }
  return ERR.num;
}

function rateCurve(nper: number, pmt: number, pv: number, fv: number, type: number): Curve {
  return (rate) => {
    if (Math.abs(rate) < 1e-12) return { value: pv + pmt * nper + fv, slope: pv * nper + pmt * ((nper * (nper - 1)) / 2 + type * nper) };
    const growth = (1 + rate) ** nper;
    const dGrowth = nper * (1 + rate) ** (nper - 1);
    const annuity = (growth - 1) / rate;
    const dAnnuity = (dGrowth * rate - (growth - 1)) / (rate * rate);
    return {
      value: pv * growth + pmt * (1 + rate * type) * annuity + fv,
      slope: pv * dGrowth + pmt * (type * annuity + (1 + rate * type) * dAnnuity),
    };
  };
}

/** Discounted cash flows at fractional periods: NPV, IRR, XNPV, XIRR. */
function flowCurve(values: number[], periods: number[]): Curve {
  return (rate) => {
    let value = 0;
    let slope = 0;
    for (const [index, amount] of values.entries()) {
      const discount = (1 + rate) ** periods[index];
      value += amount / discount;
      slope -= (periods[index] * amount) / (discount * (1 + rate));
    }
    return { value, slope };
  };
}

function hasBothSigns(values: number[]): boolean {
  return values.some((item) => item > 0) && values.some((item) => item < 0);
}

function guessAt(args: Value[], index: number): number | SheetError {
  return opt(num, 0.1)(argAt(args, index));
}

function irr(args: Value[], ctx: CallContext): Value {
  const values = collectNumbers([args[0]], { ...ctx, refs: [ctx.refs[0]] });
  if (isError(values)) return values;
  const guess = guessAt(args, 1);
  if (isError(guess)) return guess;
  if (!hasBothSigns(values)) return ERR.num;
  return solve(flowCurve(values, values.map((_, index) => index)), guess);
}

function npv(args: Value[], ctx: CallContext): Value {
  const rate = num(asMatrix(args[0])[0][0]);
  if (isError(rate)) return rate;
  const values = collectNumbers(args.slice(1), { ...ctx, refs: ctx.refs.slice(1) });
  if (isError(values)) return values;
  return flowCurve(values, values.map((_, index) => index + 1))(rate).value;
}

/** Amounts and dates for XNPV and XIRR: equal counts, numbers only. */
function datedFlows(amounts: Value, dates: Value): { values: number[]; periods: number[] } | SheetError {
  const values = asMatrix(amounts).flat();
  const days = asMatrix(dates).flat();
  if (values.length !== days.length) return ERR.num;
  for (const item of [...values, ...days]) {
    if (isError(item)) return item;
    if (typeof item !== "number") return ERR.value;
  }
  const first = Math.floor(days[0] as number);
  const periods = (days as number[]).map((item) => (Math.floor(item) - first) / 365);
  return periods.some((item) => item < 0) ? ERR.num : { values: values as number[], periods };
}

function xnpv(args: Value[]): Value {
  const rate = num(asMatrix(args[0])[0][0]);
  if (isError(rate)) return rate;
  const flows = datedFlows(args[1], args[2]);
  if (isError(flows)) return flows;
  return rate <= -1 ? ERR.num : flowCurve(flows.values, flows.periods)(rate).value;
}

function xirr(args: Value[]): Value {
  const flows = datedFlows(args[0], args[1]);
  if (isError(flows)) return flows;
  const guess = guessAt(args, 2);
  if (isError(guess)) return guess;
  if (!hasBothSigns(flows.values)) return ERR.num;
  return solve(flowCurve(flows.values, flows.periods), guess);
}

/* ------------------------------------------------------------------ depreciation */

function syd(cost: number, salvage: number, life: number, per: number): number | SheetError {
  if (life <= 0 || per <= 0 || per > life) return ERR.num;
  return ((cost - salvage) * (life - per + 1) * 2) / (life * (life + 1));
}

/** Declining balance for one period (LibreOffice's formula, matching Excel). */
function badDepreciation(cost: number, salvage: number, life: number, period: number, factor: number): boolean {
  return cost < 0 || salvage < 0 || life <= 0 || period <= 0 || period > life || factor <= 0;
}

function ddb(cost: number, salvage: number, life: number, period: number, factor: number): number | SheetError {
  if (badDepreciation(cost, salvage, life, period, factor)) return ERR.num;
  const rate = Math.min(factor / life, 1);
  // At a rate of 1, 0 ** 0 is 1, so the first period takes the whole cost.
  const before = cost * (1 - rate) ** (period - 1);
  const after = cost * (1 - rate) ** period;
  return Math.max(before - Math.max(after, salvage), 0);
}

/* ------------------------------------------------------------------ cumulative */

/** CUMIPMT/CUMPRINC's checks; end <= nper with start >= 1 also rules out nper <= 0. */
function badPeriods(rate: number, nper: number, pv: number, start: number, end: number, type: number): boolean {
  return rate <= 0 || pv <= 0 || start < 1 || end < start || end > nper || (type !== 0 && type !== 1);
}

function cumulative(part: typeof ipmtOf) {
  return (rate: number, nper: number, pv: number, start: number, end: number, type: number): number | SheetError => {
    if (badPeriods(rate, nper, pv, start, end, type)) return ERR.num;
    let sum = 0;
    for (let per = start; per <= end; per += 1) sum += part(rate, per, nper, pv, 0, type) as number;
    return sum;
  };
}

function effect(nominal: number, periods: number): number | SheetError {
  return nominal <= 0 || periods < 1 ? ERR.num : (1 + nominal / periods) ** periods - 1;
}

function nominal(effective: number, periods: number): number | SheetError {
  return effective <= 0 || periods < 1 ? ERR.num : periods * ((1 + effective) ** (1 / periods) - 1);
}

export const FINANCIAL_FUNCTIONS: Record<string, FunctionSpec> = {
  PMT: fin("rate, nper, pv, [fv], [type]", "Returns the payment per period for a loan or annuity.", { fn: scalar([num, num, num, zero, when], pmtOf) }),
  IPMT: fin("rate, per, nper, pv, [fv], [type]", "Returns the interest part of one payment.", { fn: scalar([num, num, num, num, zero, when], ipmtOf) }),
  PPMT: fin("rate, per, nper, pv, [fv], [type]", "Returns the principal part of one payment.", { fn: scalar([num, num, num, num, zero, when], ppmtOf) }),
  FV: fin("rate, nper, pmt, [pv], [type]", "Returns the future value of an investment.", { fn: scalar([num, num, num, zero, when], fvOf) }),
  PV: fin("rate, nper, pmt, [fv], [type]", "Returns the present value of an investment.", { fn: scalar([num, num, num, zero, when], pvOf) }),
  NPER: fin("rate, pmt, pv, [fv], [type]", "Returns the number of payment periods.", { fn: scalar([num, num, num, zero, when], nperOf) }),
  RATE: fin("nper, pmt, pv, [fv], [type], [guess]", "Returns the interest rate per period.", { fn: scalar([num, num, num, zero, when, opt(num, 0.1)], (nper, pmt, pv, fv, type, guess) => solve(rateCurve(nper, pmt, pv, fv, type), guess)) }),
  NPV: fin("rate, value1, [value2], ...", "Returns the net present value of periodic cash flows.", { fn: npv }),
  XNPV: fin("rate, values, dates", "Returns the net present value of cash flows on given dates.", { fn: xnpv }),
  IRR: fin("values, [guess]", "Returns the internal rate of return of periodic cash flows.", { fn: irr }),
  XIRR: fin("values, dates, [guess]", "Returns the internal rate of return of cash flows on given dates.", { fn: xirr }),
  SLN: fin("cost, salvage, life", "Returns straight-line depreciation for one period.", { fn: scalar([num, num, num], (cost, salvage, life) => (life === 0 ? ERR.div0 : (cost - salvage) / life)) }),
  SYD: fin("cost, salvage, life, per", "Returns sum-of-years' digits depreciation for a period.", { fn: scalar([num, num, num, num], syd) }),
  DDB: fin("cost, salvage, life, period, [factor]", "Returns double-declining balance depreciation for a period.", { fn: scalar([num, num, num, num, opt(num, 2)], ddb) }),
  CUMIPMT: fin("rate, nper, pv, start_period, end_period, type", "Returns the interest paid between two periods.", { fn: scalar([num, num, num, int, int, int], cumulative(ipmtOf)) }),
  CUMPRINC: fin("rate, nper, pv, start_period, end_period, type", "Returns the principal paid between two periods.", { fn: scalar([num, num, num, int, int, int], cumulative(ppmtOf)) }),
  EFFECT: fin("nominal_rate, npery", "Returns the effective annual interest rate.", { fn: scalar([num, int], effect) }),
  NOMINAL: fin("effect_rate, npery", "Returns the nominal annual interest rate.", { fn: scalar([num, int], nominal) }),
};
