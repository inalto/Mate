// Strokes along the ruler's edge (pure apart from the context the readout draws on). A press in an
// edge band takes that edge's line as its guide; every point of the stroke is projected onto it, the
// finished stroke may snap its length to a step of the scale, and a small label shows the length.
import type { Camera, Vec2 } from "../canvas/camera";
import { edgeLine, zoneAt, type Line, type RulerPose } from "./pose";

/** The edge line when `world` is in an edge band of a ruler that is on, else null. */
export function guideFor(ruler: { on: boolean; pose: RulerPose | null }, camera: Camera, world: Vec2): Line | null {
  if (!ruler.on || !ruler.pose) return null;
  const zone = zoneAt(ruler.pose, camera, world);
  return zone === 1 || zone === -1 ? edgeLine(ruler.pose, camera, zone) : null;
}

/** Position of `p` along `line` from its anchor (page units). */
const along = (p: Vec2, line: Line): number => (p.x - line.a.x) * line.dir.x + (p.y - line.a.y) * line.dir.y;

/**
 * `p` moved onto `line` (x and y replaced, everything else kept). `line.dir` must be a unit vector.
 */
export function projectOnLine<P extends Vec2>(p: P, line: Line): P {
  const t = along(p, line);
  return { ...p, x: line.a.x + line.dir.x * t, y: line.a.y + line.dir.y * t };
}

/** Signed length along `line` from the first point to the last (page units); 0 for fewer than two. */
export function guidedLength(points: readonly Vec2[], line: Line): number {
  if (points.length < 2) return 0;
  return along(points[points.length - 1], line) - along(points[0], line);
}

/** The nearest whole number of `step`s to `length`, at least one, with its sign (0 counts as forwards). */
const snappedLength = (length: number, step: number): number =>
  (length < 0 ? -1 : 1) * Math.max(1, Math.round(Math.abs(length) / step)) * step;

/** `p` slid along `line` so that it lies `length` from `from` (both measured along the line). */
const slideTo = <P extends Vec2>(p: P, from: Vec2, length: number, line: Line): P => {
  const d = along(from, line) + length - along(p, line);
  return { ...p, x: p.x + line.dir.x * d, y: p.y + line.dir.y * d };
};

/**
 * The last point slid along `line` to `length` (signed) from the first; points beyond the new end
 * are pulled back onto it (the last point marks it). Fewer than two points are returned unchanged.
 */
export function withGuidedLength<P extends Vec2>(points: P[], line: Line, length: number): P[] {
  if (points.length < 2) return points;
  const sign = length < 0 ? -1 : 1;
  const target = Math.abs(length);
  const t0 = along(points[0], line);
  const out: P[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    if (sign * (along(p, line) - t0) < target) out.push(p);
  }
  out.push(slideTo(points[points.length - 1], points[0], length, line));
  return out;
}

/**
 * The last point moved along `line` to the nearest multiple of `step` from the first (at least one
 * step, in the direction drawn); points beyond the new end are pulled back onto it. Step 0 (or fewer
 * than two points) returns the points unchanged.
 */
export function snapGuidedLength<P extends Vec2>(points: P[], line: Line, step: number): P[] {
  if (!(step > 0) || points.length < 2) return points;
  return withGuidedLength(points, line, snappedLength(guidedLength(points, line), step));
}

/** How a guided stroke's length snaps. */
export interface GuidedSnap {
  /** The length snap step (page units); 0 when off. */
  step: number;
  /** Shorter than this (page units) the stroke is a still press or a stroke across the ruler: no snap. */
  minLength: number;
  /** Whether the snapped end may be used (page mode: it must stay on the stroke's sheet). */
  fits?: (end: Vec2) => boolean;
}

/**
 * The signed length a guided stroke through `points` ends with: the snapped length when the snap
 * applies (on, the stroke at least `minLength` long, its snapped end fitting), else the length drawn.
 * The commit and the live readout both go through this, so they never disagree.
 */
export function finalGuidedLength(points: readonly Vec2[], line: Line, snap: GuidedSnap): number {
  const drawn = guidedLength(points, line);
  if (!(snap.step > 0) || points.length < 2 || Math.abs(drawn) < snap.minLength) return drawn;
  const length = snappedLength(drawn, snap.step);
  if (snap.fits && !snap.fits(slideTo(points[points.length - 1], points[0], length, line))) return drawn;
  return length;
}

/** A guided stroke's finished points, with its last point at `finalGuidedLength`. */
export function finishGuided<P extends Vec2>(points: P[], line: Line, snap: GuidedSnap): P[] {
  const length = finalGuidedLength(points, line, snap);
  return length === guidedLength(points, line) ? points : withGuidedLength(points, line, length);
}

const READOUT_FONT = "12px sans-serif";
const READOUT_PAD_X = 6;
const READOUT_HEIGHT = 20;
const READOUT_RADIUS = 6;
const READOUT_PLATE_ALPHA = 0.85;
const FALLBACK = { plate: "#ffffff", ink: "#163a63" };

export interface ReadoutColors {
  plate: string;
  ink: string;
}

/** The readout's colours from the theme tokens (the ruler's ink on the surface colour); re-read on a theme change. */
export function readoutColors(): ReadoutColors {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return FALLBACK;
  const cs = getComputedStyle(document.documentElement);
  return {
    plate: cs.getPropertyValue("--color-surface-1").trim() || FALLBACK.plate,
    ink: cs.getPropertyValue("--ruler-ink").trim() || FALLBACK.ink,
  };
}

/** A small rounded label centred on `at` (screen px) reading `text`. */
export function drawLengthReadout(ctx: CanvasRenderingContext2D, at: Vec2, text: string, dpr: number, colors: ReadoutColors): void {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = READOUT_FONT;
  const w = ctx.measureText(text).width + 2 * READOUT_PAD_X;
  const h = READOUT_HEIGHT;
  const x = at.x - w / 2;
  const y = at.y - h / 2;
  const r = Math.min(READOUT_RADIUS, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.globalAlpha = READOUT_PLATE_ALPHA;
  ctx.fillStyle = colors.plate;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = colors.ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, at.x, at.y);
  ctx.restore();
}
