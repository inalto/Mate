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

export interface ImplicitOptions {
  /** Grid cells across (default 200). */
  cols?: number;
  /** Grid cells down (default 150). */
  rows?: number;
  /** Polled before each evaluation: once true, every later value is NaN (its cells are skipped). */
  stop?: () => boolean;
}

/** Bisection steps that place a crossing on its edge (and tell a root from a pole). */
const EDGE_STEPS = 4;

/**
 * The curve f(x, y) = 0 over `win` by marching squares: f is evaluated on a cols×rows grid, each
 * edge whose ends differ in sign holds a crossing, and each cell joins its crossings (the saddle
 * case is settled by the cell's mean). A crossing is placed by a few bisection steps then linear
 * interpolation; it is dropped when |f| does not shrink towards it (a sign change through a pole,
 * as in y − tan x, is not a curve). Cells with a non-finite corner are skipped. Segments are
 * stitched into polylines (a closed curve comes back to its first point). Never throws.
 */
export function sampleImplicit(
  f: (x: number, y: number) => number,
  win: { xMin: number; xMax: number; yMin: number; yMax: number },
  opts: ImplicitOptions = {},
): Point2[][] {
  const cols = Math.max(1, Math.floor(opts.cols ?? 200));
  const rows = Math.max(1, Math.floor(opts.rows ?? 150));
  const { xMin, xMax, yMin, yMax } = win;
  if (![xMin, xMax, yMin, yMax].every(Number.isFinite) || xMax <= xMin || yMax <= yMin) return [];
  const dx = (xMax - xMin) / cols;
  const dy = (yMax - yMin) / rows;
  const stop = opts.stop ?? (() => false);
  let stopped = false;
  const at = (x: number, y: number): number => {
    if (stopped || (stopped = stop())) return NaN;
    try {
      const v = f(x, y);
      return typeof v === "number" ? v : NaN;
    } catch {
      return NaN;
    }
  };

  const W = cols + 1;
  const vals = new Float64Array(W * (rows + 1)).fill(NaN);
  for (let j = 0; j <= rows && !stopped; j++) for (let i = 0; i <= cols; i++) vals[j * W + i] = at(xMin + i * dx, yMin + j * dy);
  const inside = (v: number): boolean => v > 0;

  // Crossing on the edge from grid point (i, j) to (i + di, j + dj); keyed by edge, null when dropped.
  const crossings = new Map<number, Point2 | null>();
  const crossing = (i: number, j: number, horizontal: boolean): number => {
    const key = (j * W + i) * 2 + (horizontal ? 0 : 1);
    if (crossings.has(key)) return key;
    let ax = xMin + i * dx;
    let ay = yMin + j * dy;
    let bx = horizontal ? ax + dx : ax;
    let by = horizontal ? ay : ay + dy;
    let va = vals[j * W + i];
    let vb = horizontal ? vals[j * W + i + 1] : vals[(j + 1) * W + i];
    const start = Math.max(Math.abs(va), Math.abs(vb));
    for (let s = 0; s < EDGE_STEPS; s++) {
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const vm = at(mx, my);
      if (!Number.isFinite(vm)) {
        va = NaN;
        break;
      }
      if (inside(vm) === inside(va)) {
        ax = mx;
        ay = my;
        va = vm;
      } else {
        bx = mx;
        by = my;
        vb = vm;
      }
    }
    const root = Number.isFinite(va) && Math.max(Math.abs(va), Math.abs(vb)) < start / 2;
    const t = va / (va - vb);
    crossings.set(key, root && Number.isFinite(t) ? { x: ax + t * (bx - ax), y: ay + t * (by - ay) } : null);
    return key;
  };

  const segments: [number, number][] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = vals[j * W + i]; // bottom left
      const b = vals[j * W + i + 1]; // bottom right
      const c = vals[(j + 1) * W + i + 1]; // top right
      const d = vals[(j + 1) * W + i]; // top left
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) continue;
      const ia = inside(a);
      const ib = inside(b);
      const ic = inside(c);
      const id = inside(d);
      const edges: number[] = [];
      if (ia !== ib) edges.push(crossing(i, j, true)); // bottom
      if (ib !== ic) edges.push(crossing(i + 1, j, false)); // right
      if (id !== ic) edges.push(crossing(i, j + 1, true)); // top
      if (ia !== id) edges.push(crossing(i, j, false)); // left
      if (edges.length === 2) segments.push([edges[0], edges[1]]);
      else if (edges.length === 4) {
        const [bottom, right, top, left] = edges;
        // a and c on one side, b and d on the other: the centre says which pair is joined.
        if (inside((a + b + c + d) / 4) === ia) segments.push([bottom, right], [top, left]);
        else segments.push([left, bottom], [right, top]);
      }
    }
  }

  // Stitch segments whose crossings were kept into polylines.
  const kept = segments.filter(([p, q]) => crossings.get(p) && crossings.get(q));
  const byKey = new Map<number, number[]>();
  kept.forEach(([p, q], s) => {
    for (const k of [p, q]) {
      const list = byKey.get(k);
      if (list) list.push(s);
      else byKey.set(k, [s]);
    }
  });
  const used = new Array<boolean>(kept.length).fill(false);
  const walk = (from: number): number[] => {
    const keys: number[] = [];
    let end = from;
    for (;;) {
      const s = (byKey.get(end) ?? []).find((n) => !used[n]);
      if (s === undefined) return keys;
      used[s] = true;
      const [p, q] = kept[s];
      end = p === end ? q : p;
      keys.push(end);
    }
  };
  const lines: Point2[][] = [];
  for (let s = 0; s < kept.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const [p, q] = kept[s];
    const keys = [...walk(p).reverse(), p, q, ...walk(q)];
    lines.push(keys.map((k) => crossings.get(k)!));
  }
  return lines;
}
