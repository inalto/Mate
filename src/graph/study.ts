// Function study (pure, numeric): for y = f(x), piecewise included, over the visible window — the
// domain, y-intercept, zeros, sign, vertical asymptotes, behaviour as x → ±∞, monotony with local
// maxima and minima (from a central-difference f′), and concavity with inflection points (from f″).
// The window is sampled on a grid, each piece's run on its own; roots are bracketed by sign changes
// and bisected, a sign change through a pole is told from a root by |f| at the end, and a pole is
// confirmed by |f| growing without bound (./numeric). Bounded in time: past the budget the result
// so far comes back with `partial` set. Never throws.
import type { Span } from "./format";
import type { Evaluator } from "./expressions";
import { bisect, bisectRoot, blowsUp, derivative, goldenMax, guarded, OutOfTime, roundCandidates, secondDerivative, sideSign, sign, snap, timeNow } from "./numeric";
import { evaluate, runsOf, type PiecewiseFn } from "./pieces";

export interface StudyPoint {
  x: number;
  y: number;
}

/** A vertical asymptote x = `x`, with the sign of f's blow-up on each side (0: not on that side). */
export interface VerticalAsymptote {
  x: number;
  left: -1 | 0 | 1;
  right: -1 | 0 | 1;
}

/** How f behaves as x → ±∞. */
export type EndBehaviour =
  | { kind: "limit"; value: number }
  | { kind: "oblique"; m: number; q: number }
  | { kind: "infinite"; sign: -1 | 1 }
  | { kind: "none" }
  | { kind: "undefined" };

export interface StudyResult {
  domain: Span[];
  /** f(0), or null where f is not defined at 0. */
  intercept: number | null;
  zeros: number[];
  positive: Span[];
  negative: Span[];
  vertical: VerticalAsymptote[];
  atMinusInfinity: EndBehaviour;
  atPlusInfinity: EndBehaviour;
  increasing: Span[];
  decreasing: Span[];
  maxima: StudyPoint[];
  minima: StudyPoint[];
  concaveUp: Span[];
  concaveDown: Span[];
  inflections: StudyPoint[];
  /** True when the time budget ran out: later sections are missing or incomplete. */
  partial: boolean;
}

export interface StudyOptions {
  /** Visible y span (the scale of "small"); default the x span. */
  yRange?: number;
  /** Wall-clock budget, ms (default STUDY_BUDGET_MS). */
  budgetMs?: number;
  /** 0: f only; 1: also f′ (monotony, extrema); 2: also f″ (concavity, inflections). Default 2. */
  depth?: 0 | 1 | 2;
  /** Grid samples over the window (default 800). */
  samples?: number;
  now?: () => number;
}

export const STUDY_BUDGET_MS = 120;

const emptyResult = (): StudyResult => ({
  domain: [],
  intercept: null,
  zeros: [],
  positive: [],
  negative: [],
  vertical: [],
  atMinusInfinity: { kind: "undefined" },
  atPlusInfinity: { kind: "undefined" },
  increasing: [],
  decreasing: [],
  maxima: [],
  minima: [],
  concaveUp: [],
  concaveDown: [],
  inflections: [],
  partial: false,
});

/** A stretch where one formula is finite (between domain gaps, piece bounds and poles). */
interface Segment {
  g: Evaluator;
  lo: number;
  hi: number;
  loClosed: boolean;
  hiClosed: boolean;
}

/** Spans joined where they touch at a point both hold. */
function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1];
    if (last && last.to === s.from && (last.toClosed || s.fromClosed)) {
      last.to = s.to;
      last.toClosed = s.toClosed;
    } else out.push({ ...s });
  }
  return out;
}

/** Study of `fn` over [xMin, xMax]. Never throws. */
export function studyFunction(fn: PiecewiseFn, win: { xMin: number; xMax: number }, opts: StudyOptions = {}): StudyResult {
  const res = emptyResult();
  const { xMin, xMax } = win;
  const span = xMax - xMin;
  if (!(span > 0) || !Number.isFinite(span)) return res;
  const now = opts.now ?? timeNow;
  const deadline = now() + (opts.budgetMs ?? STUDY_BUDGET_MS);
  const depth = opts.depth ?? 2;
  const N = Math.max(50, Math.floor(opts.samples ?? 800));
  const yScale = Math.abs(opts.yRange ?? span) || 1;
  const F = guarded((x) => evaluate(fn, x), deadline, now);
  const eps = span * 1e-9;
  const defined = (x: number) => Number.isFinite(F(x));

  try {
    res.intercept = (() => {
      const v = F(0);
      return Number.isFinite(v) ? v : null;
    })();

    // 1. Domain: per run, the stretches where the run's formula is finite; gap edges by bisection.
    const runs = runsOf(fn, xMin, xMax);
    const stretches: (Segment & { xs: number[]; vs: number[] })[] = [];
    const edgeAsymptotes: { x: number; dir: -1 | 1; g: Evaluator }[] = [];
    for (const run of runs) {
      const g = guarded(fn.pieces[run.piece].f, deadline, now);
      const n = Math.max(32, Math.round((N * (run.b - run.a)) / span));
      const xs: number[] = [];
      const vs: number[] = [];
      for (let i = 0; i <= n; i++) {
        const x = i === n ? run.b : run.a + ((run.b - run.a) * i) / n;
        xs.push(x);
        vs.push(g(x));
      }
      let i = 0;
      while (i <= n) {
        if (!Number.isFinite(vs[i])) {
          i++;
          continue;
        }
        const i0 = i;
        while (i + 1 <= n && Number.isFinite(vs[i + 1])) i++;
        const i1 = i;
        i++;
        const fin = (x: number) => Number.isFinite(g(x));
        const start = i0 > 0 ? snapEdge(bisect(fin, xs[i0], xs[i0 - 1]), 1, span, g) : { x: xs[i0], closed: defined(xs[i0]) };
        const end = i1 < n ? snapEdge(bisect(fin, xs[i1], xs[i1 + 1]), -1, span, g) : { x: xs[i1], closed: defined(xs[i1]) };
        const lo = start.x;
        const hi = end.x;
        if (!(hi > lo)) continue;
        // A gap edge inside the run, or a piece bound, where |f| blows up is a vertical asymptote.
        if (i0 > 0 || (run.a > xMin && lo === run.a)) edgeAsymptotes.push({ x: lo, dir: 1, g });
        if (i1 < n || (run.b < xMax && hi === run.b)) edgeAsymptotes.push({ x: hi, dir: -1, g });
        const sub = { xs: xs.slice(i0, i1 + 1), vs: vs.slice(i0, i1 + 1) };
        sub.xs[0] = lo;
        sub.xs[sub.xs.length - 1] = hi;
        // At a piece bound the point belongs to whichever piece holds it.
        const loClosed = i0 > 0 ? start.closed : defined(lo);
        const hiClosed = i1 < n ? end.closed : defined(hi);
        stretches.push({ g, lo, hi, loClosed, hiClosed, ...sub });
      }
    }
    res.domain = merge(stretches.map((s) => ({ from: s.lo, to: s.hi, fromClosed: s.loClosed, toClosed: s.hiClosed })));

    // 2. Zeros, poles and jumps, then the sign between them.
    const vertical = new Map<number, VerticalAsymptote>();
    const addAsymptote = (x: number, left: -1 | 0 | 1, right: -1 | 0 | 1) => {
      for (const [k, a] of vertical) {
        if (Math.abs(k - x) <= span * 1e-7) {
          if (left) a.left = left;
          if (right) a.right = right;
          return;
        }
      }
      vertical.set(x, { x, left, right });
    };
    for (const e of edgeAsymptotes) {
      if (!blowsUp(e.g, e.x, e.dir === 1 ? 1 : -1, span)) continue;
      const s = sideSign(e.g, e.x, e.dir, span);
      addAsymptote(e.x, e.dir === -1 ? s : 0, e.dir === 1 ? s : 0);
    }
    const zeros: number[] = [];
    const addZero = (x: number) => {
      if (x < xMin || x > xMax || zeros.some((z) => Math.abs(z - x) <= eps * 100)) return;
      zeros.push(x);
    };
    const segments: Segment[] = [];
    for (const st of stretches) {
      const { g, xs, vs } = st;
      const cuts: number[] = [];
      for (let i = 0; i < xs.length; i++) {
        if (vs[i] === 0 && (i > 0 && i < xs.length - 1 ? true : F(xs[i]) === 0)) addZero(xs[i]);
        if (i + 1 < xs.length && vs[i] * vs[i + 1] < 0) {
          const r = bisectRoot(g, xs[i], xs[i + 1]);
          const v = Math.abs(g(r));
          if (v <= Math.min(Math.abs(vs[i]), Math.abs(vs[i + 1]))) addZero(snap(r, span, (c, x) => Math.abs(g(c)) <= Math.abs(g(x))));
          else {
            cuts.push(r); // a pole or a jump: no root, and the sign and monotony stop here
            if (blowsUp(g, r, -1, span) && blowsUp(g, r, 1, span)) addAsymptote(snapPole(g, r, span), sideSign(g, r, -1, span), sideSign(g, r, 1, span));
          }
        }
        if (i > 0 && i + 1 < xs.length) {
          const a = Math.abs(vs[i - 1]);
          const m = Math.abs(vs[i]);
          const b = Math.abs(vs[i + 1]);
          const same = sign(vs[i - 1]) === sign(vs[i]) && sign(vs[i]) === sign(vs[i + 1]);
          if (same && m < a && m <= b && m > 0) {
            // |f| dips without a sign change: a double root when it reaches zero.
            const x = goldenMax((t) => -Math.abs(g(t)), xs[i - 1], xs[i + 1]);
            if (Math.abs(g(x)) <= 1e-9 * Math.max(1, yScale)) addZero(snap(x, span, (c, t) => Math.abs(g(c)) <= Math.abs(g(t)) * 1.0001 + 1e-300));
          } else if (same && m > a && m > b) {
            // |f| peaks: a pole without a sign change (1/x², tan² …) when it grows without bound.
            const x = goldenMax((t) => Math.abs(g(t)), xs[i - 1], xs[i + 1]);
            if (blowsUp(g, x, -1, span) && blowsUp(g, x, 1, span)) {
              cuts.push(x);
              addAsymptote(snapPole(g, x, span), sideSign(g, x, -1, span), sideSign(g, x, 1, span));
            }
          }
        }
      }
      // Segments: the stretch cut at its poles and jumps.
      const ends = [st.lo, ...cuts.sort((p, q) => p - q), st.hi];
      for (let k = 0; k + 1 < ends.length; k++) {
        if (!(ends[k + 1] > ends[k])) continue;
        segments.push({ g, lo: ends[k], hi: ends[k + 1], loClosed: k === 0 && st.loClosed, hiClosed: k + 2 === ends.length && st.hiClosed });
      }
    }
    zeros.sort((p, q) => p - q);
    res.zeros = zeros;
    res.vertical = [...vertical.values()].sort((p, q) => p.x - q.x);

    const positive: Span[] = [];
    const negative: Span[] = [];
    for (const s of segments) {
      const inner = zeros.filter((z) => z > s.lo && z < s.hi);
      const pts = [s.lo, ...inner, s.hi];
      for (let k = 0; k + 1 < pts.length; k++) {
        const v = s.g((pts[k] + pts[k + 1]) / 2);
        if (!Number.isFinite(v) || v === 0) continue;
        const closed = (x: number, end: boolean) => end && sign(F(x)) === sign(v);
        const span1 = { from: pts[k], to: pts[k + 1], fromClosed: closed(pts[k], k === 0 && s.loClosed), toClosed: closed(pts[k + 1], k + 2 === pts.length && s.hiClosed) };
        (v > 0 ? positive : negative).push(span1);
      }
    }
    res.positive = merge(positive);
    res.negative = merge(negative);

    // 3. Behaviour far out (beyond the window, where f is defined there).
    res.atMinusInfinity = endBehaviour(F, -1, Math.max(1, Math.abs(xMin), Math.abs(xMax)));
    res.atPlusInfinity = endBehaviour(F, 1, Math.max(1, Math.abs(xMin), Math.abs(xMax)));

    // 4–5. Monotony and extrema from f′, then concavity and inflections from f″.
    if (depth >= 1) {
      const order1 = signStudy(segments, N, span, yScale, 1, F);
      res.increasing = order1.up;
      res.decreasing = order1.down;
      for (const c of order1.turns) (c.from > 0 ? res.maxima : res.minima).push({ x: c.x, y: c.y });
    }
    if (depth >= 2) {
      const order2 = signStudy(segments, N, span, yScale, 2, F);
      res.concaveUp = order2.up;
      res.concaveDown = order2.down;
      res.inflections = order2.turns.map((c) => ({ x: c.x, y: c.y }));
    }
  } catch (err) {
    if (!(err instanceof OutOfTime)) return { ...emptyResult(), partial: true };
    res.partial = true;
  }
  return res;
}

/** A pole moved to a round value nearby where |f| is at least as large. */
const snapPole = (g: Evaluator, x: number, span: number): number =>
  snap(x, span, (c) => !Number.isFinite(g(c)) || Math.abs(g(c)) >= Math.abs(g(x)));

/**
 * A domain edge found by bisection (`x`, where f is still finite) as shown: moved to the nearest
 * round value, and whether f is defined exactly there. At an exact value (0, 1/3, π/2) f is simply
 * tested; at a merely rounded one, the edge counts as closed unless f blows up towards it.
 */
function snapEdge(x: number, dir: -1 | 1, span: number, g: Evaluator): { x: number; closed: boolean } {
  const [first] = roundCandidates(x, span);
  if (first?.exact) return { x: first.c, closed: Number.isFinite(g(first.c)) };
  return { x: first?.c ?? x, closed: !blowsUp(g, x, dir, span) };
}

interface Turn {
  x: number;
  y: number;
  /** Sign of the derivative before the turn. */
  from: -1 | 1;
}

/**
 * Where the `order`-th derivative is positive and negative on each segment, and where it changes
 * sign (extrema for order 1, inflections for order 2), located by bisection on that derivative.
 */
function signStudy(segments: Segment[], N: number, span: number, yScale: number, order: 1 | 2, F: Evaluator): { up: Span[]; down: Span[]; turns: Turn[] } {
  const up: Span[] = [];
  const down: Span[] = [];
  const turns: Turn[] = [];
  for (const s of segments) {
    const len = s.hi - s.lo;
    const M = Math.max(16, Math.round((N * len) / span));
    const h = Math.min((order === 1 ? 1e-6 : 1e-4) * span, len / 4);
    const d = order === 1 ? derivative(s.g, h) : secondDerivative(s.g, h);
    const xs: number[] = [];
    let gMax = yScale;
    for (let j = 0; j < M; j++) {
      const x = s.lo + (len * (j + 0.5)) / M;
      xs.push(x);
      const v = Math.abs(s.g(x));
      if (Number.isFinite(v) && v > gMax) gMax = v;
    }
    // Below this the derivative is rounding noise (a straight line has no concavity).
    const tol = order === 1 ? (1e-8 * gMax) / span : (1e-5 * gMax) / (span * span);
    const signOf = (x: number): -1 | 0 | 1 => {
      const v = d(x);
      return Number.isFinite(v) && Math.abs(v) > tol ? sign(v) : 0;
    };
    const signs = xs.map(signOf);
    const cuts: { x: number; from: -1 | 1 }[] = [];
    let last = -1;
    for (let j = 0; j < M; j++) {
      if (signs[j] === 0) continue;
      if (last >= 0 && signs[j] !== signs[last]) {
        const before = signs[last] as -1 | 1;
        // The raw sign (no noise threshold) places the change precisely.
        const x = bisect((t) => sign(d(t)) === before, xs[last], xs[j], 50);
        cuts.push({ x, from: before });
      }
      last = j;
    }
    const pts = [s.lo, ...cuts.map((c) => c.x), s.hi];
    for (let k = 0; k + 1 < pts.length; k++) {
      const inside = xs.findIndex((x, j) => x > pts[k] && x < pts[k + 1] && signs[j] !== 0);
      if (inside < 0) continue;
      const span1 = { from: pts[k], to: pts[k + 1], fromClosed: k > 0 || s.loClosed, toClosed: k + 2 < pts.length || s.hiClosed };
      (signs[inside] > 0 ? up : down).push(span1);
    }
    for (const c of cuts) {
      const dAt = order === 1 ? derivative(s.g, Math.min(1e-6 * span, len / 4)) : d;
      const x = snap(c.x, span, (cand, t) => Math.abs(dAt(cand)) <= Math.abs(dAt(t)) * 1.0001 + tol);
      const y = F(x);
      if (Number.isFinite(y)) turns.push({ x, y, from: c.from });
    }
  }
  return { up, down, turns };
}

/** f as x → dir·∞, estimated from f at 10², 10³, 10⁴ and 10⁵ times `scale`. */
export function endBehaviour(F: Evaluator, dir: -1 | 1, scale: number): EndBehaviour {
  const X = [2, 3, 4, 5].map((k) => dir * scale * 10 ** k);
  const v = X.map((x) => F(x));
  if (v.some((y) => Number.isNaN(y))) return { kind: "undefined" };
  const inf = v.find((y) => !Number.isFinite(y));
  if (inf !== undefined) return { kind: "infinite", sign: inf > 0 ? 1 : -1 };
  const [, v2, v3, v4] = v;
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-3 * Math.max(1, Math.abs(b));
  /** The limit of a sequence converging geometrically (Aitken), or its last term. */
  const limitOf = (a: number, b: number, c: number): number => {
    const d1 = b - a;
    const d2 = c - b;
    const r = d1 === 0 ? 0 : d2 / d1;
    const L = r > 0 && r < 0.9 ? c + (d2 * r) / (1 - r) : c;
    return Math.abs(L) < 1e-6 ? 0 : L;
  };
  if (close(v3, v4) && close(v2, v3)) return { kind: "limit", value: limitOf(v2, v3, v4) };
  const s = [1, 2, 3].map((i) => (v[i] - v[i - 1]) / (X[i] - X[i - 1]));
  if (Math.abs(s[2] - s[1]) <= 1e-3 * Math.abs(s[2]) && Math.abs(s[2]) > 1e-6) {
    const m = Math.abs(s[2] - Math.round(s[2])) < 1e-6 ? Math.round(s[2]) : s[2];
    const q = v.map((y, i) => y - m * X[i]);
    if (close(q[2], q[3])) return { kind: "oblique", m, q: limitOf(q[1], q[2], q[3]) };
  }
  const grows = v.every((y, i) => i === 0 || (Math.abs(y) > Math.abs(v[i - 1]) && sign(y) === sign(v[i - 1])));
  if (grows && v4 !== 0) return { kind: "infinite", sign: v4 > 0 ? 1 : -1 };
  return { kind: "none" };
}
