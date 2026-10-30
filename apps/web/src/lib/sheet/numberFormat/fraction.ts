/** The closest fraction to a non-negative number whose denominator fits the
 * placeholders, found from the continued-fraction convergents and the last
 * semiconvergent (the standard best-rational-approximation method).
 *
 * The loop always ends: denominators grow at least as fast as Fibonacci
 * numbers, and an exact convergent makes the next term infinite. */

export type Fraction = { num: number; den: number };

export function bestFraction(x: number, maxDen: number): Fraction {
  let [num0, den0, num1, den1] = [0, 1, 1, 0];
  let rest = x;
  for (;;) {
    const whole = Math.floor(rest);
    const den = whole * den1 + den0;
    if (den > maxDen) return closer(x, semiconvergent(num0, den0, num1, den1, maxDen), { num: num1, den: den1 });
    [num0, den0, num1, den1] = [num1, den1, whole * num1 + num0, den];
    rest = 1 / (rest - whole);
  }
}

function semiconvergent(num0: number, den0: number, num1: number, den1: number, maxDen: number): Fraction {
  const steps = Math.floor((maxDen - den0) / den1);
  return { num: num0 + steps * num1, den: den0 + steps * den1 };
}

/** The nearer of two candidates; a tie keeps the convergent, the simpler one. */
function closer(x: number, candidate: Fraction, convergent: Fraction): Fraction {
  return Math.abs(x - candidate.num / candidate.den) < Math.abs(x - convergent.num / convergent.den) ? candidate : convergent;
}
