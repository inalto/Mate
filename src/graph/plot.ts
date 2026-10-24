// Plot scene (pure): a graph's axes, grid, ticks, tick labels and sampled curves laid out in
// box-local units (origin top-left, y down) for a box of `w`×`h`, clipped to the box. Ticks follow
// a 1-2-5 ladder with at most 11 per axis; axes stay pinned to the box edge when the origin is out
// of view. The canvas and SVG renderers draw a scene as is. Each expression gets a wall-clock
// budget: past it its evaluator answers NaN (the curve is cut short) and the scene carries a
// "too slow" warning for it. Implicit curves (f(x, y) = 0) are traced by marching squares over the
// window (./sample). While the math engine loads, curves are left out (`pending`).
import i18n from "../i18n";
import type { ThemeName } from "../ink/types";
import { mapInkColor } from "../ink/theme";
import type { GraphData } from "./data";
import { parseExpressionSync, type Pending, type ParseResult } from "./expressions";
import { sampleCurve, sampleImplicit, sampleParametric, type Point2 } from "./sample";

export type { Point2 };

export interface Line {
  a: Point2;
  b: Point2;
}

export interface Tick {
  axis: "x" | "y";
  value: number;
  /** Where the tick meets its axis (box-local). */
  pos: Point2;
  label: string;
}

export interface Text extends Point2 {
  text: string;
  align: "left" | "center" | "right";
  baseline: "top" | "middle" | "bottom";
}

export interface PlotColors {
  background: string;
  grid: string;
  axis: string;
  text: string;
}

export interface PlotScene {
  w: number;
  h: number;
  colors: PlotColors;
  /** The two axes, then the tick marks. */
  axes: Line[];
  grid: Line[];
  ticks: Tick[];
  curves: { color: string; polyline: Point2[] }[];
  labels: Text[];
  /** Per-expression problems found while plotting (e.g. "too slow"). */
  warnings: { id: string; message: string }[];
  /** True while the math engine is loading: curves are missing and a "Loading…" label is shown. */
  pending: boolean;
}

export interface PlotOptions {
  /** Expression parser (default parseExpressionSync; tests inject slow evaluators). */
  parse?: (latex: string) => ParseResult | Pending;
  /** Wall-clock budget per expression, ms (default PLOT_BUDGET_MS). */
  budgetMs?: number;
}

/** Time one expression may spend being sampled before its curve is cut short. */
export const PLOT_BUDGET_MS = 50;
export const TOO_SLOW = "too slow";

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Parametric parameter (t) and polar angle (θ) range. */
export const PARAM_RANGE = { from: 0, to: 2 * Math.PI };

const TICK_LEN = 4;
const MAX_TICKS = 11;

const COLORS: Record<ThemeName, PlotColors> = {
  light: { background: "#ffffff", grid: "#e5e7eb", axis: "#4b5563", text: "#4b5563" },
  sepia: { background: "#f7efdb", grid: "#e4d8bb", axis: "#5b4a33", text: "#5b4a33" },
  dark: { background: "#18181b", grid: "#2f2f35", axis: "#a1a1aa", text: "#a1a1aa" },
  "high-contrast": { background: "#000000", grid: "#3a3a3a", axis: "#ffffff", text: "#ffffff" },
};

export const plotColors = (theme: ThemeName): PlotColors => COLORS[theme] ?? COLORS.light;

/** Smallest 1-2-5 step giving at most MAX_TICKS ticks over `range` (positive). */
export function niceStep(range: number): number {
  const raw = Math.abs(range) / (MAX_TICKS - 1);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) {
    const s = m * mag;
    if (s >= raw * (1 - 1e-9)) return s;
  }
  return 10 * mag;
}

/** Tick values of [min, max] at `step`. */
function tickValues(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(min / step - 1e-9);
  for (let i = first; out.length <= MAX_TICKS + 1; i++) {
    const v = i * step;
    if (v > max + step * 1e-9) break;
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

/** `v` printed with as many decimals as `step` needs. */
export function formatTick(v: number, step: number): string {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e6 || abs < 1e-4) {
    const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(step / abs) + 1e-9)));
    return v.toExponential(digits).replace("e+", "e");
  }
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step) + 1e-9)));
  const s = v.toFixed(decimals);
  return s === "-0" ? "0" : s;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** `poly` clipped to [0,w]×[0,h] (Liang–Barsky per segment); the visible runs. */
export function clipPolyline(poly: Point2[], w: number, h: number): Point2[][] {
  const out: Point2[][] = [];
  let run: Point2[] = [];
  const end = () => {
    if (run.length >= 2) out.push(run);
    run = [];
  };
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;
    let visible = Number.isFinite(dx) && Number.isFinite(dy);
    for (const [p, q] of [
      [-dx, a.x],
      [dx, w - a.x],
      [-dy, a.y],
      [dy, h - a.y],
    ] as const) {
      if (!visible) break;
      if (p === 0) {
        if (q < 0) visible = false;
      } else {
        const r = q / p;
        if (p < 0) {
          if (r > t1) visible = false;
          else if (r > t0) t0 = r;
        } else if (r < t0) visible = false;
        else if (r < t1) t1 = r;
      }
    }
    if (!visible) {
      end();
      continue;
    }
    const pa = { x: clamp(a.x + t0 * dx, 0, w), y: clamp(a.y + t0 * dy, 0, h) };
    const pb = { x: clamp(a.x + t1 * dx, 0, w), y: clamp(a.y + t1 * dy, 0, h) };
    if (run.length === 0 || t0 > 0) {
      end();
      run.push(pa);
    }
    run.push(pb);
    if (t1 < 1) end();
  }
  end();
  return out;
}

/** The scene of `data` in a `box.w`×`box.h` box. Never throws (bad expressions are skipped). */
export function buildPlotScene(data: GraphData, box: { w: number; h: number }, theme: ThemeName, opts: PlotOptions = {}): PlotScene {
  const w = Math.max(1, box.w);
  const h = Math.max(1, box.h);
  const { xMin, xMax, yMin, yMax } = data.domain;
  const xRange = xMax - xMin;
  const yRange = yMax - yMin;
  const sx = (x: number) => ((x - xMin) / xRange) * w;
  const sy = (y: number) => h - ((y - yMin) / yRange) * h;
  const toBox = (p: Point2): Point2 => ({ x: sx(p.x), y: sy(p.y) });

  // Axes, pinned to the box edges when the origin is out of view.
  const ax = clamp(sx(0), 0, w); // the y axis' x
  const ay = clamp(sy(0), 0, h); // the x axis' y
  const axes: Line[] = [
    { a: { x: 0, y: ay }, b: { x: w, y: ay } },
    { a: { x: ax, y: 0 }, b: { x: ax, y: h } },
  ];
  const grid: Line[] = [];
  const ticks: Tick[] = [];
  const labels: Text[] = [];

  const xStep = niceStep(xRange);
  const yStep = niceStep(yRange);
  const labelsBelow = ay <= h - 16;
  const labelsLeft = ax >= 28;
  const originShown = sx(0) >= 0 && sx(0) <= w && sy(0) >= 0 && sy(0) <= h;

  for (const v of tickValues(xMin, xMax, xStep)) {
    const x = clamp(sx(v), 0, w);
    ticks.push({ axis: "x", value: v, pos: { x, y: ay }, label: formatTick(v, xStep) });
    if (data.grid) grid.push({ a: { x, y: 0 }, b: { x, y: h } });
    axes.push({ a: { x, y: clamp(ay - TICK_LEN / 2, 0, h) }, b: { x, y: clamp(ay + TICK_LEN / 2, 0, h) } });
    if (v === 0 && originShown) continue;
    const align = x < 12 ? "left" : x > w - 12 ? "right" : "center";
    labels.push({ x, y: labelsBelow ? clamp(ay + 4, 0, h) : clamp(ay - 4, 0, h), text: formatTick(v, xStep), align, baseline: labelsBelow ? "top" : "bottom" });
  }
  for (const v of tickValues(yMin, yMax, yStep)) {
    const y = clamp(sy(v), 0, h);
    ticks.push({ axis: "y", value: v, pos: { x: ax, y }, label: formatTick(v, yStep) });
    if (data.grid) grid.push({ a: { x: 0, y }, b: { x: w, y } });
    axes.push({ a: { x: clamp(ax - TICK_LEN / 2, 0, w), y }, b: { x: clamp(ax + TICK_LEN / 2, 0, w), y } });
    if (v === 0 && originShown) continue;
    const baseline = y < 8 ? "top" : y > h - 8 ? "bottom" : "middle";
    labels.push({ x: labelsLeft ? clamp(ax - 4, 0, w) : clamp(ax + 4, 0, w), y, text: formatTick(v, yStep), align: labelsLeft ? "right" : "left", baseline });
  }
  if (originShown) labels.push({ x: clamp(ax - 4, 0, w), y: clamp(ay + 4, 0, h), text: "0", align: "right", baseline: "top" });

  const curves: PlotScene["curves"] = [];
  const warnings: PlotScene["warnings"] = [];
  const parse = opts.parse ?? parseExpressionSync;
  const budget = opts.budgetMs ?? PLOT_BUDGET_MS;
  let pending = false;
  for (const e of data.expressions) {
    if (!e.visible || e.latex.trim() === "") continue;
    const p = parse(e.latex);
    if ("pending" in p) {
      pending = true;
      continue;
    }
    if ("error" in p) continue;
    // Past the deadline every evaluator of this expression answers NaN.
    const deadline = now() + budget;
    let late = false;
    const timed =
      (fn: (v: number) => number) =>
      (v: number): number => {
        if (late || now() > deadline) {
          late = true;
          return NaN;
        }
        return fn(v);
      };
    const stop = (): boolean => (late ||= now() > deadline);
    let branches: Point2[][];
    switch (p.kind) {
      case "of-x":
        branches = sampleCurve(timed(p.f), xMin, xMax, { yRange, stop });
        break;
      case "of-y":
        branches = sampleCurve(timed(p.f), yMin, yMax, { yRange: xRange, stop }).map((b) => b.map((q) => ({ x: q.y, y: q.x })));
        break;
      case "polar": {
        // The sampler asks for x then y at the same angle: evaluate r once per angle.
        const r = timed(p.r);
        let lastT = NaN;
        let lastR = NaN;
        const rAt = (t: number): number => (t === lastT ? lastR : ((lastT = t), (lastR = r(t))));
        branches = sampleParametric(
          (t) => rAt(t) * Math.cos(t),
          (t) => rAt(t) * Math.sin(t),
          PARAM_RANGE.from,
          PARAM_RANGE.to,
          { xRange, yRange, stop },
        );
        break;
      }
      case "parametric":
        branches = sampleParametric(timed(p.x), timed(p.y), PARAM_RANGE.from, PARAM_RANGE.to, { xRange, yRange, stop });
        break;
      case "implicit":
        // Marching squares over the window; the deadline is polled before each evaluation.
        branches = sampleImplicit(p.f, data.domain, { stop });
        break;
    }
    if (late) warnings.push({ id: e.id, message: TOO_SLOW });
    const color = mapInkColor(e.color, theme);
    for (const b of branches) for (const polyline of clipPolyline(b.map(toBox), w, h)) curves.push({ color, polyline });
  }
  if (pending) labels.push({ x: Math.min(6, w), y: Math.min(6, h), text: i18n.t("common.loading"), align: "left", baseline: "top" });

  return { w, h, colors: plotColors(theme), axes, grid, ticks, curves, labels, warnings, pending };
}
