import { getStrokePoints, type StrokeOptions } from "perfect-freehand";
import type { Disc, PenRenderParams, PenStyle, Point } from "./types";

/** Real pressure if any tilt is present or any pressure deviates from 0.5 by more than 0.015. */
export function detectRealPressure(points: Point[]): boolean {
  for (const p of points) {
    if ((p.tiltX !== undefined && p.tiltX !== 0) || (p.tiltY !== undefined && p.tiltY !== 0)) return true;
    if (Math.abs(p.pressure - 0.5) > 0.015) return true;
  }
  return false;
}

const linear = (t: number) => t;
const cubic = (t: number) => t * t * t;

/** Per-style perfect-freehand options (spec 03 §1). `size` is the stroke width in page units. */
export function penParams(style: PenStyle, size: number, realPressure: boolean, sharpness = 0.9): PenRenderParams {
  switch (style) {
    case "pen":
      return {
        size,
        thinning: 0,
        smoothing: 0.5,
        streamline: 0,
        simulatePressure: false,
        resampleTolerance: 0.08,
        outline: false,
      };
    case "fountain-pen": {
      const scale = sharpness / 0.9;
      if (realPressure) {
        const taper = 5 * scale;
        return {
          size,
          thinning: 0.7,
          smoothing: 0.6,
          streamline: 0.55,
          simulatePressure: false,
          start: { cap: true, taper, easing: linear },
          end: { cap: true, taper, easing: linear },
          outline: true,
        };
      }
      const taper = 20 * scale;
      return {
        size,
        thinning: 0.65,
        smoothing: 0.75,
        streamline: 0.65,
        simulatePressure: true,
        start: { cap: true, taper, easing: cubic },
        end: { cap: true, taper, easing: cubic },
        outline: true,
      };
    }
    case "highlighter":
      return { size, thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false, outline: true };
    case "pencil":
      return {
        size,
        thinning: 0.1,
        smoothing: 0.9,
        streamline: 0.4,
        simulatePressure: !realPressure,
        outline: false,
      };
  }
}

/**
 * Streamlined discs for the capsule renderer. Centres and pressure come from perfect-freehand's
 * `getStrokePoints`; r = max(minR, size/2 · (thinning === 0 ? 1 : 1 + thinning·(pressure − 0.5))),
 * minR = min(0.4, size/2). A per-point `width` on the input overrides the radius with width/2.
 */
export function strokeDiscs(points: Point[], opts: StrokeOptions): Disc[] {
  if (points.length === 0) return [];
  const size = opts.size ?? 16;
  const thinning = opts.thinning ?? 0.5;
  const minR = Math.min(0.4, size / 2);
  const radius = (pressure: number, width: number | undefined) => {
    if (width !== undefined) return width / 2;
    const r = (size / 2) * (thinning === 0 ? 1 : 1 + thinning * (pressure - 0.5));
    return Math.max(minR, r);
  };
  if (points.length === 1) {
    const p = points[0];
    return [{ x: p.x, y: p.y, r: radius(p.pressure, p.width) }];
  }
  const hasWidth = points.some((p) => p.width !== undefined);
  const sp = getStrokePoints(
    points.map((p) => [p.x, p.y, p.pressure]),
    opts,
  );
  const out: Disc[] = [];
  let j = 0; // monotone nearest-input cursor, only needed for per-point widths
  for (const s of sp) {
    const [x, y] = s.point;
    let width: number | undefined;
    if (hasWidth) {
      const d2 = (k: number) => (points[k].x - x) ** 2 + (points[k].y - y) ** 2;
      while (j + 1 < points.length && d2(j + 1) <= d2(j)) j++;
      width = points[j].width;
    }
    out.push({ x, y, r: radius(s.pressure, width) });
  }
  return out;
}
