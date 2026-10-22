import type { Point, RawPoint } from "./types";

/** Pressure `NaN`/`undefined`/`≤0` → 0.5 (pointer without pressure); otherwise clamped to 0..1. */
export function normalizePoint(raw: RawPoint): Point {
  const p = raw.pressure;
  const pressure = p === undefined || Number.isNaN(p) || p <= 0 ? 0.5 : Math.min(1, p);
  const out: Point = { x: raw.x, y: raw.y, pressure, timestamp: raw.timestamp };
  if (raw.tiltX !== undefined) out.tiltX = raw.tiltX;
  if (raw.tiltY !== undefined) out.tiltY = raw.tiltY;
  return out;
}
