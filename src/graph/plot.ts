// Plot scene (pure): a graph's axes, grid, ticks, tick labels and sampled curves laid out in
// box-local units (origin top-left, y down) for a box of `w`×`h`, clipped to the box. Ticks follow
// a 1-2-5 ladder with at most 11 per axis; axes stay pinned to the box edge when the origin is out
// of view. The canvas and SVG renderers draw a scene as is.
import type { ThemeName } from "../ink/types";
import { mapInkColor } from "../ink/theme";
import type { GraphData } from "./data";
import { parseExpression } from "./expressions";
import { sampleCurve, sampleParametric, type Point2 } from "./sample";

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
}

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
export function buildPlotScene(data: GraphData, box: { w: number; h: number }, theme: ThemeName): PlotScene {
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
  for (const e of data.expressions) {
    if (!e.visible || e.latex.trim() === "") continue;
    const p = parseExpression(e.latex);
    if ("error" in p) continue;
    let branches: Point2[][];
    switch (p.kind) {
      case "of-x":
        branches = sampleCurve(p.f, xMin, xMax, { yRange });
        break;
      case "of-y":
        branches = sampleCurve(p.f, yMin, yMax, { yRange: xRange }).map((b) => b.map((q) => ({ x: q.y, y: q.x })));
        break;
      case "polar": {
        const r = p.r;
        branches = sampleParametric(
          (t) => r(t) * Math.cos(t),
          (t) => r(t) * Math.sin(t),
          PARAM_RANGE.from,
          PARAM_RANGE.to,
          { xRange, yRange },
        );
        break;
      }
      case "parametric":
        branches = sampleParametric(p.x, p.y, PARAM_RANGE.from, PARAM_RANGE.to, { xRange, yRange });
        break;
    }
    const color = mapInkColor(e.color, theme);
    for (const b of branches) for (const polyline of clipPolyline(b.map(toBox), w, h)) curves.push({ color, polyline });
  }

  return { w, h, colors: plotColors(theme), axes, grid, ticks, curves, labels };
}
