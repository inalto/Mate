// SVG form of one committed stroke: pen/pencil strokes become one stroked <path> per capsule run,
// fountain-pen/highlighter strokes a filled outline (mirrors render.ts).
import { getStroke } from "perfect-freehand";
import { circle, esc, n, PathData } from "../export/svgUtil";
import { capsuleRuns } from "./capsuleRuns";
import { traceSmoothPolygon } from "./render";
import { simplifyEpsForZoom } from "./resample";
import { detectRealPressure, penParams, strokeDiscs } from "./strokePoints";
import { isDarkTheme, mapInkColor } from "./theme";
import type { Element, ThemeName } from "./types";

export function strokeSvg(el: Element, theme: ThemeName, zoomBucket: number): string {
  const pts = el.points;
  if (pts.length === 0) return "";
  const style = el.penStyle ?? (el.isHighlighter ? "highlighter" : "pen");
  const color = esc(mapInkColor(el.color, theme));
  const shapes: string[] = [];
  if (pts.length === 1) {
    shapes.push(circle(pts[0].x, pts[0].y, Math.max(el.width / 2, 0.4), color));
  } else {
    const params = penParams(style, el.width, detectRealPressure(pts));
    if (params.outline) {
      const poly = getStroke(
        pts.map((p) => [p.x, p.y, p.pressure]),
        { ...params, last: true },
      );
      if (poly.length > 0) {
        const path = new PathData();
        traceSmoothPolygon(path, poly);
        shapes.push(`<path d="${path.d}" fill="${color}"/>`);
      }
    } else {
      for (const run of capsuleRuns(strokeDiscs(pts, params), simplifyEpsForZoom(zoomBucket))) {
        const xy = run.xy;
        if (xy.length === 2) {
          shapes.push(circle(xy[0], xy[1], run.width / 2, color));
          continue;
        }
        let d = `M${n(xy[0])} ${n(xy[1])}`;
        for (let k = 2; k < xy.length; k += 2) d += `L${n(xy[k])} ${n(xy[k + 1])}`;
        shapes.push(
          `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(run.width)}" stroke-linecap="round" stroke-linejoin="round"/>`,
        );
      }
    }
  }
  if (shapes.length === 0) return "";
  if (style !== "highlighter") return shapes.join("");
  const blend = isDarkTheme(theme) ? "screen" : "multiply";
  return `<g opacity="0.5" style="mix-blend-mode:${blend}">${shapes.join("")}</g>`;
}
