// Vector page export. Same region and background pattern as the raster export; pen/pencil strokes
// become one stroked <path> per capsule run, fountain-pen/highlighter strokes a filled outline.
import { getStroke } from "perfect-freehand";
import { buildBackgroundPattern, type BackgroundPage, type Rect } from "../canvas/background";
import { capsuleRuns } from "../ink/capsuleRuns";
import { traceSmoothPolygon } from "../ink/render";
import { simplifyEpsForZoom } from "../ink/resample";
import { detectRealPressure, penParams, strokeDiscs } from "../ink/strokePoints";
import { isDarkTheme, mapInkColor } from "../ink/theme";
import type { ThemeName } from "../ink/types";
import { PAGE_BORDER_RADIUS, PAGE_GAP } from "../model/constants";
import type { Element, Page } from "../model/types";
import { useSettingsStore } from "../stores/settings";
import { renderOrder } from "../tools/zorder";
import { exportRegion, pageElements, surfaceFor, type ExportOptions } from "./scene";

/** Number with at most two decimals. */
const n = (v: number): string => String(Math.round(v * 100) / 100);

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Collects path commands as SVG `d` data. */
class PathData {
  d = "";
  moveTo(x: number, y: number) {
    this.d += `M${n(x)} ${n(y)}`;
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    this.d += `Q${n(cx)} ${n(cy)} ${n(x)} ${n(y)}`;
  }
  closePath() {
    this.d += "Z";
  }
}

const circle = (x: number, y: number, r: number, fill: string) =>
  `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${fill}"/>`;

function strokeSvg(el: Element, theme: ThemeName, zoomBucket: number): string {
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

function backgroundSvg(page: Page, region: Rect, sheet: BackgroundPage, opts: ExportOptions): string {
  if (opts.background === "transparent") return "";
  const surface = surfaceFor(opts.theme);
  const out: string[] = [];
  const rect = (r: Rect, fill: string, rx?: number) =>
    `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}"${rx ? ` rx="${rx}"` : ""} fill="${fill}"/>`;
  if (sheet.mode === "page" && opts.pageFrame) {
    out.push(rect(region, surface.desk));
    const stride = sheet.height + PAGE_GAP;
    for (let i = 0; i < (sheet.count ?? 1); i++) {
      out.push(rect({ x: 0, y: i * stride, width: sheet.width, height: sheet.height }, surface.paper, PAGE_BORDER_RADIUS));
    }
  } else {
    out.push(rect(region, surface.paper));
  }
  const { lines, dots } = buildBackgroundPattern(page.backgroundConfig, region, sheet, opts.theme);
  for (const l of lines) {
    out.push(
      `<line x1="${n(l.x1)}" y1="${n(l.y1)}" x2="${n(l.x2)}" y2="${n(l.y2)}" stroke="${esc(l.color)}" stroke-width="${n(l.width)}"/>`,
    );
  }
  for (const d of dots) out.push(circle(d.x, d.y, d.r, esc(d.color)));
  return out.join("");
}

export function renderToSvg(elements: Iterable<Element>, page: Page, opts: ExportOptions): string {
  const aspect = useSettingsStore.getState().settings.defaultPageAspectRatio;
  const list = pageElements(page, elements);
  const { region, sheet } = exportRegion(page, list, aspect);
  const ink = renderOrder(list)
    .filter((el) => el.type === "stroke")
    .map((el) => strokeSvg(el, opts.theme, opts.scale))
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(region.width * opts.scale)}" height="${n(region.height * opts.scale)}" ` +
    `viewBox="${n(region.x)} ${n(region.y)} ${n(region.width)} ${n(region.height)}">` +
    backgroundSvg(page, region, sheet, opts) +
    ink +
    `</svg>`
  );
}
