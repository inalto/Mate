// Vector page export. Same region and background pattern as the raster export; each element is
// emitted by its type's renderer (renderers/registry), in z-order.
import { buildBackgroundPattern, type BackgroundPage, type Rect } from "../canvas/background";
import { PAGE_BORDER_RADIUS, PAGE_GAP } from "../model/constants";
import type { Element, Page } from "../model/types";
import { getEmbeddedKatexCss } from "../math/katexCss";
import { elementSvg } from "../renderers/registry";
import { useSettingsStore } from "../stores/settings";
import { renderOrder } from "../tools/zorder";
import { exportRegion, pageElements, surfaceFor, type ExportOptions } from "./scene";
import { circle, esc, n } from "./svgUtil";

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
  const svgStyles = new Set<string>();
  const ropts = { theme: opts.theme, zoomBucket: opts.scale, svgStyles };
  const ink = renderOrder(list)
    .map((el) => elementSvg(el, ropts))
    .join("");
  // katex.css (fonts embedded) once for every math box: it applies across the SVG document.
  const defs = svgStyles.has("katex") ? `<defs><style><![CDATA[${getEmbeddedKatexCss()}]]></style></defs>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(region.width * opts.scale)}" height="${n(region.height * opts.scale)}" ` +
    `viewBox="${n(region.x)} ${n(region.y)} ${n(region.width)} ${n(region.height)}">` +
    defs +
    backgroundSvg(page, region, sheet, opts) +
    ink +
    `</svg>`
  );
}
