// Definite integral and area of a function of x (pure, numeric): composite Simpson on each piece's
// run, split at the zeros so the area (the integral of |f|) is exact up to Simpson's error. An
// interval where f is not defined throughout, or that crosses a pole, is refused rather than
// guessed. Bounded in time like the study; never throws.
import type { Evaluator } from "./expressions";
import { bisectRoot, blowsUp, goldenMax, guarded, OutOfTime, sign, timeNow } from "./numeric";
import { runsOf, type PiecewiseFn } from "./pieces";

export type IntegralResult = { value: number; area: number } | { error: "domain" | "pole" | "slow" };

const SCAN = 400;
const SIMPSON = 1024;
export const INTEGRAL_BUDGET_MS = 120;

function simpson(g: Evaluator, a: number, b: number, n = SIMPSON): number {
  const h = (b - a) / n;
  let s = g(a) + g(b);
  for (let i = 1; i < n; i++) s += g(a + i * h) * (i % 2 === 1 ? 4 : 2);
  return (s * h) / 3;
}

/** ∫ from a to b of `fn` and the area between its curve and the x axis there. */
export function integrate(fn: PiecewiseFn, a: number, b: number, opts: { budgetMs?: number; now?: () => number } = {}): IntegralResult {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { error: "domain" };
  if (a === b) return { value: 0, area: 0 };
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const now = opts.now ?? timeNow;
  const deadline = now() + (opts.budgetMs ?? INTEGRAL_BUDGET_MS);
  const span = hi - lo;
  try {
    const runs = runsOf(fn, lo, hi);
    const covered = runs.reduce((s, r) => s + (r.b - r.a), 0);
    if (runs.length === 0 || Math.abs(covered - span) > span * 1e-12) return { error: "domain" };
    let value = 0;
    let area = 0;
    for (const run of runs) {
      const g = guarded(fn.pieces[run.piece].f, deadline, now);
      const xs: number[] = [];
      const vs: number[] = [];
      for (let i = 0; i <= SCAN; i++) {
        const x = i === SCAN ? run.b : run.a + ((run.b - run.a) * i) / SCAN;
        const v = g(x);
        if (!Number.isFinite(v)) return { error: blowsUp(g, x, i === 0 ? 1 : -1, span) ? "pole" : "domain" };
        xs.push(x);
        vs.push(v);
      }
      const cuts: number[] = [];
      for (let i = 0; i < SCAN; i++) {
        if (vs[i] * vs[i + 1] < 0) {
          const r = bisectRoot(g, xs[i], xs[i + 1]);
          if (Math.abs(g(r)) > Math.min(Math.abs(vs[i]), Math.abs(vs[i + 1]))) return { error: "pole" };
          cuts.push(r);
        }
        if (i > 0 && sign(vs[i - 1]) === sign(vs[i]) && sign(vs[i]) === sign(vs[i + 1])) {
          const m = Math.abs(vs[i]);
          if (m > Math.abs(vs[i - 1]) && m > Math.abs(vs[i + 1])) {
            const x = goldenMax((t) => Math.abs(g(t)), xs[i - 1], xs[i + 1]);
            if (blowsUp(g, x, -1, span) && blowsUp(g, x, 1, span)) return { error: "pole" };
          }
        }
      }
      const pts = [run.a, ...cuts, run.b];
      for (let k = 0; k + 1 < pts.length; k++) {
        const part = simpson(g, pts[k], pts[k + 1]);
        if (!Number.isFinite(part)) return { error: "domain" };
        value += part;
        area += Math.abs(part);
      }
    }
    return { value: a < b ? value : -value, area };
  } catch (err) {
    return { error: err instanceof OutOfTime ? "slow" : "domain" };
  }
}
