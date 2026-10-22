// Stroke pipeline (pure): raw pointer points → normalise → stabilise → (fountain-pen pressure
// smoothing + nib flatness) → on commit resample (tol 0.08) + simplify (zoom ε) → stroke Element.
import { LIMITS } from "../model/constants";
import type { Element, PenPreset, Point } from "../model/types";
import { normalizePoint } from "../ink/normalize";
import { resampleInkPoints, simplifyEpsForZoom, simplifyPolylineXY } from "../ink/resample";
import { createStabilizer } from "../ink/stabilize";

export interface StrokeOptions {
  pageId: string;
  preset: PenPreset;
  zoom: number;
  /** settings.strokeStabilization, 0–100. */
  stabilization: number;
  /** settings.fountainPenNibFlatness, 0–100. */
  nibFlatness: number;
}

export const NIB_ANGLE = Math.PI / 4;
const REAL_PRESSURE_DELTA = 0.015;

/** Nib flatness pressure factor for travel direction θ: sqrt(sin²(θ−nib) + (1−f)²cos²(θ−nib)). */
export function nibFactor(theta: number, flatness: number): number {
  const f = Math.min(0.9, Math.max(0, flatness / 100));
  const a = theta - NIB_ANGLE;
  const s = Math.sin(a);
  const c = Math.cos(a);
  return Math.sqrt(s * s + (1 - f) * (1 - f) * c * c);
}

export interface StrokeBuilder {
  /** Append coalesced raw points; returns all processed points so far. */
  push(raw: Point[]): Point[];
  /** Processed points plus processed predicted points (not retained). */
  preview(predicted: Point[]): Point[];
  /** Processed points so far. */
  points(): Point[];
  /** Resampled + simplified final points. */
  finish(): Point[];
}

export function createStrokeBuilder(opts: StrokeOptions): StrokeBuilder {
  const fountain = opts.preset.type === "fountain-pen";
  const stab = createStabilizer(opts.stabilization, opts.zoom);
  const out: Point[] = [];
  let realPressure = false;
  // Pressure before nib modulation, for the smoothing recurrence.
  let prevSmoothed: number | null = null;

  const fountainStep = (p: Point, prev: Point | undefined, commit: boolean): Point => {
    let pressure = p.pressure;
    let real = realPressure;
    if (!real && (Math.abs(pressure - 0.5) > REAL_PRESSURE_DELTA || p.tiltX !== undefined)) real = true;
    if (real && prevSmoothed !== null) pressure = 0.35 * pressure + 0.65 * prevSmoothed;
    if (commit) {
      realPressure = real;
      prevSmoothed = pressure;
    }
    if (prev) {
      const theta = Math.atan2(p.y - prev.y, p.x - prev.x);
      pressure *= nibFactor(theta, opts.nibFlatness);
    }
    return { ...p, pressure };
  };

  const process = (raw: Point, commit: boolean, stabilize: (p: Point) => Point): Point => {
    const n = normalizePoint(raw);
    const s = stabilize(n);
    if (!fountain) return s;
    const prev = out[out.length - 1];
    const q = fountainStep(s, prev, commit);
    // The first point takes the nib factor of the first segment once it is known.
    if (commit && out.length === 1 && prev) {
      out[0] = { ...out[0], pressure: out[0].pressure * nibFactor(Math.atan2(q.y - prev.y, q.x - prev.x), opts.nibFlatness) };
    }
    return q;
  };

  return {
    push(raw) {
      for (const r of raw) {
        if (out.length >= LIMITS.MAX_POINTS_PER_STROKE) break;
        out.push(process(r, true, stab));
      }
      return out;
    },
    preview(predicted) {
      if (predicted.length === 0) return out;
      // Predicted points skip the stabiliser (it is stateful) and are never committed.
      return out.concat(predicted.map((r) => process(r, false, (p) => p)));
    },
    points: () => out,
    finish() {
      const resampled = resampleInkPoints(out, 0.08);
      const simplified = simplifyPolylineXY(resampled, simplifyEpsForZoom(opts.zoom));
      return simplified.slice(0, LIMITS.MAX_POINTS_PER_STROKE);
    },
  };
}

/** Build the stroke Element for committed points. */
export function strokeElement(
  points: Point[],
  opts: Pick<StrokeOptions, "pageId" | "preset">,
  id: string = crypto.randomUUID(),
  now: string = new Date().toISOString(),
): Element {
  const { preset } = opts;
  return {
    id,
    pageId: opts.pageId,
    type: "stroke",
    points,
    color: preset.color,
    width: preset.width,
    isHighlighter: preset.type === "highlighter",
    penStyle: preset.type,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

/** Whole pipeline for a finished list of raw points (used by tests and non-live callers). */
export function commitStroke(raw: Point[], opts: StrokeOptions): Element | null {
  const b = createStrokeBuilder(opts);
  b.push(raw);
  const pts = b.finish();
  return pts.length > 0 ? strokeElement(pts, opts) : null;
}
