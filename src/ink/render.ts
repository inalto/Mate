import { getStroke } from "perfect-freehand";
import { capsuleRuns } from "./capsuleRuns";
import { simplifyEpsForZoom } from "./resample";
import { detectRealPressure, penParams, strokeDiscs } from "./strokePoints";
import { isDarkTheme, mapInkColor } from "./theme";
import type { Element, PenStyle, ThemeName } from "./types";

/** The subset of path-building calls shared by `Path2D` and `CanvasRenderingContext2D`. */
interface PathSink {
  moveTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  closePath(): void;
}

/** Closed polygon with quadratic midpoint smoothing: M p0, Q p_i mid(p_i, p_{i+1}) …, Z. */
function traceSmoothPolygon(sink: PathSink, poly: number[][]): void {
  const n = poly.length;
  sink.moveTo(poly[0][0], poly[0][1]);
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    sink.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  sink.closePath();
}

function styleOf(el: Element): PenStyle {
  return el.penStyle ?? (el.isHighlighter ? "highlighter" : "pen");
}

/**
 * Draw one committed stroke in world units (the caller has already applied the camera transform).
 * pen/pencil → capsule runs; fountain-pen/highlighter → perfect-freehand outline fill.
 * `zoomBucket` sets the capsule-run width tolerance via `simplifyEpsForZoom`; points are rendered
 * as stored (already resampled and simplified on commit).
 */
export function renderStroke(
  ctx: CanvasRenderingContext2D,
  el: Element,
  theme: ThemeName,
  zoomBucket: number,
): void {
  const pts = el.points;
  if (pts.length === 0) return;
  const style = styleOf(el);
  const color = mapInkColor(el.color, theme);

  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (style === "highlighter") {
    ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = isDarkTheme(theme) ? "screen" : "multiply";
  }

  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, Math.max(el.width / 2, 0.4), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const params = penParams(style, el.width, detectRealPressure(pts));
  if (params.outline) {
    const poly = getStroke(
      pts.map((p) => [p.x, p.y, p.pressure]),
      { ...params, last: true },
    );
    if (poly.length > 0) {
      if (typeof Path2D !== "undefined") {
        const path = new Path2D();
        traceSmoothPolygon(path, poly);
        ctx.fill(path);
      } else {
        ctx.beginPath();
        traceSmoothPolygon(ctx, poly);
        ctx.fill();
      }
    }
  } else {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const runs = capsuleRuns(strokeDiscs(pts, params), simplifyEpsForZoom(zoomBucket));
    let i = 0;
    while (i < runs.length) {
      const width = runs[i].width;
      const first = runs[i].xy;
      if (first.length === 2) {
        ctx.beginPath();
        ctx.arc(first[0], first[1], width / 2, 0, Math.PI * 2);
        ctx.fill();
        i++;
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(first[0], first[1]);
      // Merge following runs of equal width into the same path; each continues from the shared joint.
      do {
        const xy = runs[i].xy;
        for (let k = 2; k < xy.length; k += 2) ctx.lineTo(xy[k], xy[k + 1]);
        i++;
      } while (i < runs.length && runs[i].width === width && runs[i].xy.length > 2);
      ctx.lineWidth = width;
      ctx.stroke();
    }
  }
  ctx.restore();
}
