// Numeric building blocks of the function study (pure): root bracketing by bisection, golden-section
// search, a blow-up test that tells a pole from a jump or a steep extremum, central-difference
// derivatives, snapping of a numeric result to a nearby round value, and a time guard.
import type { Evaluator } from "./expressions";

export const sign = (v: number): -1 | 0 | 1 => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** A point where `test` flips between a (test(a) true) and b (false): the last point still true. */
export function bisect(test: (x: number) => boolean, a: number, b: number, steps = 60): number {
  let lo = a;
  let hi = b;
  for (let i = 0; i < steps; i++) {
    const m = (lo + hi) / 2;
    if (m === lo || m === hi) break;
    if (test(m)) lo = m;
    else hi = m;
  }
  return lo;
}

/** A root of g between a and b where g changes sign: the bisection end nearer zero. */
export function bisectRoot(g: Evaluator, a: number, b: number, steps = 60): number {
  const sa = sign(g(a));
  let lo = a;
  let hi = b;
  for (let i = 0; i < steps; i++) {
    const m = (lo + hi) / 2;
    if (m === lo || m === hi) break;
    const v = g(m);
    if (v === 0) return m;
    if (sign(v) === sa) lo = m;
    else hi = m;
  }
  return Math.abs(g(lo)) <= Math.abs(g(hi)) ? lo : hi;
}

const PHI = (Math.sqrt(5) - 1) / 2;

/** The x in [a, b] where `score` is largest (golden section; `score` unimodal there). */
export function goldenMax(score: Evaluator, a: number, b: number, steps = 70): number {
  let lo = a;
  let hi = b;
  let x1 = hi - PHI * (hi - lo);
  let x2 = lo + PHI * (hi - lo);
  let f1 = score(x1);
  let f2 = score(x2);
  for (let i = 0; i < steps && hi - lo > 0; i++) {
    if (!(f1 <= f2)) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - PHI * (hi - lo);
      f1 = score(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + PHI * (hi - lo);
      f2 = score(x2);
    }
  }
  return (lo + hi) / 2;
}

/**
 * True when |g| grows without bound towards x0 from side `dir` (−1: from the left): over decades
 * of distance it keeps growing, and its growth does not die out (it would near a finite limit, a
 * jump or a sharp extremum). Catches 1/x (×10 a decade) and ln x (+2.3 a decade).
 */
export function blowsUp(g: Evaluator, x0: number, dir: -1 | 1, span: number): boolean {
  const vals: number[] = [];
  for (let k = 2; k <= 7; k++) {
    const v = Math.abs(g(x0 + dir * span * 10 ** -k));
    if (v === Infinity) return true;
    if (!Number.isFinite(v)) return false;
    vals.push(v);
  }
  for (let i = 1; i < vals.length; i++) if (!(vals[i] > vals[i - 1])) return false;
  const first = vals[1] - vals[0];
  const last = vals[vals.length - 1] - vals[vals.length - 2];
  return last >= 0.5 * first;
}

/** Sign of g just beside x0 on side `dir`. */
export const sideSign = (g: Evaluator, x0: number, dir: -1 | 1, span: number): -1 | 0 | 1 => sign(g(x0 + dir * span * 1e-7));

/** g′ by central differences with step h. */
export const derivative =
  (g: Evaluator, h: number): Evaluator =>
  (x) =>
    (g(x + h) - g(x - h)) / (2 * h);

/** g″ by central differences with step h. */
export const secondDerivative =
  (g: Evaluator, h: number): Evaluator =>
  (x) =>
    (g(x + h) - 2 * g(x) + g(x - h)) / (h * h);

/** How far (relative to the span) a numeric result may move to a round value. */
const SNAP_RANGE = 1e-7;

/**
 * Round values near `x`, nearest kind first: simple fractions p/q (q ≤ 12) and multiples of π
 * (`exact`: f can be tested there), then x rounded to 10⁻⁹ and 10⁻⁶ of the span (not exact).
 */
export function roundCandidates(x: number, span: number): { c: number; exact: boolean }[] {
  const out: { c: number; exact: boolean }[] = [];
  const push = (c: number, exact: boolean) => {
    if (Number.isFinite(c) && Math.abs(c - x) <= span * SNAP_RANGE && !out.some((o) => o.c === c)) out.push({ c: c === 0 ? 0 : c, exact });
  };
  for (let q = 1; q <= 12; q++) push(Math.round(x * q) / q, true);
  for (const d of [1, 2, 3, 4, 6]) push((Math.round((x / Math.PI) * d) / d) * Math.PI, true);
  for (const k of [1e-9, 1e-6]) {
    const pow = 10 ** Math.floor(Math.log10(span * k));
    push(Math.round(x / pow) * pow, false);
  }
  return out;
}

/** `x` moved to the first round value nearby for which `better(candidate, x)` holds; else `x`. */
export function snap(x: number, span: number, better: (candidate: number, x: number) => boolean): number {
  for (const { c } of roundCandidates(x, span)) if (c === x || better(c, x)) return c;
  return x;
}

/** Thrown by a guarded evaluator once the time budget is spent. */
export class OutOfTime extends Error {}

const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** `g` that never throws, answers NaN for non-numbers, and throws OutOfTime past `deadline`. */
export function guarded(g: Evaluator, deadline: number, now: () => number = clock): Evaluator {
  let n = 0;
  return (x) => {
    if ((++n & 31) === 0 && now() > deadline) throw new OutOfTime();
    try {
      const v = g(x);
      return typeof v === "number" ? v : NaN;
    } catch (err) {
      if (err instanceof OutOfTime) throw err;
      return NaN;
    }
  };
}

export const timeNow = clock;
