import type { Point } from "./types";

/**
 * Exponential stroke stabiliser (spec 03 §2):
 *   l = (s/100)*6 / zoom;  d = |p − prev|
 *   u = 1 − exp(−d/l);     c = 1 − exp(−d/(0.7·l))
 *   out.xy = prev.xy + u·(p.xy − prev.xy)
 *   out.pressure = prev.pressure + c·(p.pressure − prev.pressure)
 * The first point passes through; strength 0 is the identity. `prev` is the previous output.
 */
export function createStabilizer(strength: number, zoom: number): (p: Point) => Point {
  if (strength === 0) return (p) => p;
  const l = ((strength / 100) * 6) / zoom;
  let prev: Point | null = null;
  return (p) => {
    if (prev === null) {
      prev = { ...p };
      return prev;
    }
    const d = Math.hypot(p.x - prev.x, p.y - prev.y);
    const u = 1 - Math.exp(-d / l);
    const c = 1 - Math.exp(-d / (0.7 * l));
    const out: Point = {
      ...p,
      x: prev.x + u * (p.x - prev.x),
      y: prev.y + u * (p.y - prev.y),
      pressure: prev.pressure + c * (p.pressure - prev.pressure),
    };
    prev = out;
    return out;
  };
}
