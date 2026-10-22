// Adaptive curve sampling (pure). A curve is sampled evenly, then intervals whose midpoint strays
// from the chord are halved, breadth first, until they are straight to within ~1/1000 of the view
// or the sample budget is spent. The result is split into branches at non-finite values and at
// jumps (asymptotes): neighbours more than one view range apart whose midpoint does not lie between
// them (a continuous curve's would). Bounded work: at most `max` points and `2·max` evaluations.

export interface Point2 {
  x: number;
  y: number;
}

export interface SampleOptions {
  /** Even samples before refinement (default 256). */
  initial?: number;
  /** Hard cap on samples (default 2048). */
  max?: number;
  /** Visible y span: the scale of the straightness test and of jump detection. */
  yRange: number;
  /** Visible x span (parametric curves; defaults to `yRange`). */
  xRange?: number;
  /** Polled before each evaluation: once true, sampling stops (no more evaluations, no refinement). */
  stop?: () => boolean;
}

interface Sample extends Point2 {
  t: number;
}

const TOLERANCE = 1e-3;
const MAX_PASSES = 24;

const finite = (p: Point2): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
const between = (v: number, a: number, b: number): boolean => v >= Math.min(a, b) && v <= Math.max(a, b);

/** Branches of the curve (fx(t), fy(t)) for t in [t0, t1]; only finite points. Never throws. */
export function sampleParametric(fx: (t: number) => number, fy: (t: number) => number, t0: number, t1: number, opts: SampleOptions): Point2[][] {
  const max = Math.max(2, Math.floor(opts.max ?? 2048));
  const initial = Math.max(2, Math.min(max, Math.floor(opts.initial ?? 256)));
  const yRange = Math.abs(opts.yRange) || 1;
  const xRange = Math.abs(opts.xRange ?? opts.yRange) || 1;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 === t1) return [];

  const stop = opts.stop ?? (() => false);
  let stopped = false;
  const halted = (): boolean => (stopped ||= stop());
  const at = (t: number): Sample => {
    if (halted()) return { t, x: NaN, y: NaN };
    let x = NaN;
    let y = NaN;
    try {
      x = fx(t);
      y = fy(t);
    } catch {
      // A failing evaluator is a gap.
    }
    return { t, x: typeof x === "number" ? x : NaN, y: typeof y === "number" ? y : NaN };
  };

  // pts[i]..pts[i+1] is interval i; `mids[i]` caches its evaluated midpoint, `settled[i]` stops refining.
  let pts: Sample[] = [];
  for (let i = 0; i < initial; i++) pts.push(at(t0 + ((t1 - t0) * i) / (initial - 1)));
  let mids: (Sample | null)[] = new Array(pts.length - 1).fill(null);
  let settled: boolean[] = new Array(pts.length - 1).fill(false);

  const deviates = (a: Sample, m: Sample, b: Sample): boolean => {
    const fa = finite(a);
    const fb = finite(b);
    if (!fa && !fb) return false;
    if (fa !== fb) return true; // narrow down where the curve starts or stops
    if (!finite(m)) return true;
    const ex = Math.abs(m.x - (a.x + b.x) / 2) / xRange;
    const ey = Math.abs(m.y - (a.y + b.y) / 2) / yRange;
    return Math.max(ex, ey) > TOLERANCE;
  };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let count = pts.length;
    let inserted = false;
    const nextPts: Sample[] = [pts[0]];
    const nextMids: (Sample | null)[] = [];
    const nextSettled: boolean[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!settled[i] && count < max && !halted()) {
        const m = mids[i] ?? at((a.t + b.t) / 2);
        if (!(stopped && !finite(m)) && deviates(a, m, b)) {
          nextPts.push(m, b);
          nextMids.push(null, null);
          nextSettled.push(false, false);
          count++;
          inserted = true;
          continue;
        }
        mids[i] = m;
        settled[i] = true;
      }
      nextPts.push(b);
      nextMids.push(mids[i]);
      nextSettled.push(settled[i]);
    }
    pts = nextPts;
    mids = nextMids;
    settled = nextSettled;
    if (!inserted) break;
  }

  // Split into branches.
  const branches: Point2[][] = [];
  let cur: Point2[] = [];
  const flush = () => {
    if (cur.length >= 2) branches.push(cur);
    cur = [];
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!finite(p)) {
      flush();
      continue;
    }
    if (cur.length > 0) {
      const a = pts[i - 1];
      const jumpX = Math.abs(p.x - a.x) > xRange;
      const jumpY = Math.abs(p.y - a.y) > yRange;
      if (jumpX || jumpY) {
        const m = mids[i - 1] ?? (halted() ? null : at((a.t + p.t) / 2));
        const continuous = m === null || (finite(m) && (!jumpX || between(m.x, a.x, p.x)) && (!jumpY || between(m.y, a.y, p.y)));
        if (!continuous) flush();
      }
    }
    cur.push({ x: p.x, y: p.y });
  }
  flush();
  return branches;
}

/** Branches of y = fn(x) for x in [from, to]; only finite points. Never throws. */
export function sampleCurve(fn: (x: number) => number, from: number, to: number, opts: SampleOptions): Point2[][] {
  return sampleParametric((x) => x, fn, from, to, { ...opts, xRange: opts.xRange ?? Math.abs(to - from) });
}
