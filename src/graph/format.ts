// Numbers of the function study as a student reads them (pure): exact-looking values stay clean
// (0, 1, 0.5), simple fractions and multiples of π are recognised, other values keep up to four
// decimals. Intervals and points use the usual notation: [a, b), (−∞, b], (x, y).

/** Nearer than this (relative) to a simple fraction or multiple of π, a value is shown as one. */
const SNAP = 1e-9;
const MAX_DENOMINATOR = 12;
const MAX_PI_DENOMINATOR = 6;
const MINUS = "−";

const near = (v: number, target: number): boolean => Math.abs(v - target) <= SNAP * Math.max(1, Math.abs(target));
const withSign = (negative: boolean, s: string): string => (negative ? MINUS + s : s);

/** p/q (q ≤ max) equal to `v`, smallest q first, or null. */
function fraction(v: number, max: number): [number, number] | null {
  for (let q = 1; q <= max; q++) {
    const p = Math.round(v * q);
    if (p !== 0 && near(v, p / q)) return [p, q];
  }
  return null;
}

function decimal(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6 || abs < 1e-4) return v.toExponential(3).replace(/\.?0+e/, "e").replace("e+", "e").replace("-", MINUS);
  const s = String(Number(abs.toFixed(4)));
  return withSign(v < 0, s);
}

/** `v` for display: 0, integers, simple fractions, multiples of π, else up to 4 decimals; ±∞ as ∞. */
export function formatNumber(v: number): string {
  if (Number.isNaN(v)) return "?";
  if (v === Infinity) return "+∞";
  if (v === -Infinity) return MINUS + "∞";
  if (Math.abs(v) < 1e-12) return "0";
  const neg = v < 0;
  const abs = Math.abs(v);
  if (near(abs, Math.round(abs)) && abs < 1e6) return withSign(neg, String(Math.round(abs)));
  const pi = fraction(abs / Math.PI, MAX_PI_DENOMINATOR);
  if (pi) {
    const [p, q] = pi;
    return withSign(neg, `${p === 1 ? "" : p}π${q === 1 ? "" : `/${q}`}`);
  }
  const fr = fraction(abs, MAX_DENOMINATOR);
  if (fr && fr[1] !== 1 && !decimalIsExact(abs)) return withSign(neg, `${fr[0]}/${fr[1]}`);
  return decimal(v);
}

/** True for values a short decimal writes exactly (0.5, 0.25, 1.75): those read better as decimals. */
const decimalIsExact = (v: number): boolean => near(v, Number(v.toFixed(2)));

export interface Span {
  from: number;
  to: number;
  fromClosed: boolean;
  toClosed: boolean;
}

/** `[a, b)`, `(−∞, b]`… */
export const formatSpan = (s: Span): string =>
  `${s.fromClosed && Number.isFinite(s.from) ? "[" : "("}${formatNumber(s.from)}, ${formatNumber(s.to)}${s.toClosed && Number.isFinite(s.to) ? "]" : ")"}`;

/** Spans joined by ∪, or null when there are none. */
export const formatSpans = (spans: readonly Span[]): string | null => (spans.length === 0 ? null : spans.map(formatSpan).join(" ∪ "));

export const formatPoint = (x: number, y: number): string => `(${formatNumber(x)}, ${formatNumber(y)})`;

/** A typed bound: a number or a simple expression such as `pi/2`, `-3/4`, `2pi`, `sqrt(2)`; null if unreadable. */
export function parseBound(text: string): number | null {
  const s = text.trim().toLowerCase().replace(/−/g, "-").replace(/π/g, "pi").replace(/\s+/g, "");
  if (s === "") return null;
  const atom = String.raw`(?:\d+(?:\.\d*)?|\.\d+)`;
  const term = new RegExp(String.raw`^(-|\+)?(${atom})?(\*)?(pi|e|sqrt\((${atom})\))?(?:/(${atom}))?$`);
  const m = term.exec(s);
  if (!m) return null;
  const [, sign, coef, star, special, root, den] = m;
  if (!coef && !special) return null;
  if (star && (!coef || !special)) return null;
  let v = coef ? Number(coef) : 1;
  if (special === "pi") v *= Math.PI;
  else if (special === "e") v *= Math.E;
  else if (special) v *= Math.sqrt(Number(root));
  if (den) v /= Number(den);
  if (sign === "-") v = -v;
  return Number.isFinite(v) ? v : null;
}
