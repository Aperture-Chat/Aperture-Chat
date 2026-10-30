/** Excel's General format as a standard-width cell shows it. Integers below
 * 1e11 show plainly; other numbers keep 10 significant digits; numbers that
 * still reach 1e11 after rounding, and those below 1e-9, switch to scientific
 * with a 6-digit mantissa. */

export function formatGeneral(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e11) return String(value);
  if (Math.abs(value) < 1e-9) return generalScientific(value);
  return generalDecimal(value);
}

function generalDecimal(value: number): string {
  const [mantissa, power] = value.toExponential(9).split("e");
  const exponent = Number(power);
  if (exponent >= 11) return generalScientific(value);
  const sign = mantissa.startsWith("-") ? "-" : "";
  return sign + placePoint(mantissa.replace(/[-.]/g, "").replace(/0+$/, ""), exponent + 1);
}

/** Significant digits with the point after `point` of them. */
function placePoint(digits: string, point: number): string {
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits.padEnd(point, "0");
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

function generalScientific(value: number): string {
  const [mantissa, power] = value.toExponential(5).split("e");
  return `${mantissa.replace(/\.?0+$/, "")}E${power[0]}${power.slice(1).padStart(2, "0")}`;
}
