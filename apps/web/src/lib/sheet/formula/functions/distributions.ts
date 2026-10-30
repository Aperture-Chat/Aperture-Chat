/** The standard normal distribution to full double precision: NORM.DIST,
 * NORM.INV, and their standard (S) forms build on these. */

const SQRT_PI = Math.sqrt(Math.PI);
const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** erf(x) for small |x| from a series with only positive terms (no cancellation). */
function erfSeries(x: number): number {
  let term = x;
  let sum = x;
  for (let n = 1; n < 200 && Math.abs(term) > 1e-17 * Math.abs(sum); n += 1) {
    term *= (2 * x * x) / (2 * n + 1);
    sum += term;
  }
  return ((2 / SQRT_PI) * Math.exp(-x * x)) * sum;
}

/** erfc(x) for x >= 2.5 from its continued fraction (modified Lentz). */
function erfcFraction(x: number): number {
  const tiny = 1e-300;
  let f = x;
  let c = x;
  let d = 0;
  for (let n = 1; n < 500; n += 1) {
    const a = n / 2;
    d = x + a * d || tiny;
    c = x + a / c || tiny;
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x * x) / SQRT_PI / f;
}

export function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  return x < 2.5 ? 1 - erfSeries(x) : erfcFraction(x);
}

export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

export function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT_2PI;
}

const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

function polynomial(coefficients: number[], x: number): number {
  return coefficients.reduce((acc, coefficient) => acc * x + coefficient, 0);
}

/** Acklam's rational approximation (about 1e-9). */
function roughInverse(p: number): number {
  const low = 0.02425;
  if (p < low || p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(Math.min(p, 1 - p)));
    const x = polynomial(C, q) / (polynomial(D, q) * q + 1);
    return p < low ? x : -x;
  }
  const q = p - 0.5;
  const r = q * q;
  return (polynomial(A, r) * q) / (polynomial(B, r) * r + 1);
}

/** The z with normalCdf(z) = p, polished by Halley steps; p must be in (0, 1). */
export function normalInverse(p: number): number {
  let x = roughInverse(p);
  for (let step = 0; step < 2; step += 1) {
    const e = normalCdf(x) - p;
    const u = e * SQRT_2PI * Math.exp((x * x) / 2);
    x -= u / (1 + (x * u) / 2);
  }
  return x;
}
