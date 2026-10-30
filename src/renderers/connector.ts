// Connector renderer: canvas, SVG and bounds for `type: "connector"` elements, read from the element
// alone (cached `content.route`). The route is stroked (`color` at `width`, round caps and joins,
// dashed when `content.dash` is "dashed"); caps follow the route tangent at each end (arrow heads,
// dots and diamonds filled with the stroke colour, bars stroked); the label is a rounded pill in the
// paper colour with a 1 px border and the text centred on the route at its `t`. Ink colours remap
// in dark themes like shapes do.
import type { Vec2 } from "../canvas/camera";
import {
  CONNECTOR_LABEL_FONT,
  CONNECTOR_LABEL_SIZE,
  connectorBounds,
  connectorCapOutlines,
  connectorRoute,
  labelPill,
} from "../connectors/geometry";
import { esc, n } from "../export/svgUtil";
import { isDarkTheme, mapInkColor } from "../ink/theme";
import type { ThemeName } from "../ink/types";
import { contentOf, type ConnectorContent } from "../model/content";
import type { Element } from "../model/types";
import { isFilledCap } from "../shapes/geometry";
import { FALLBACK_INK } from "../text/boxHtml";
import { safeColor } from "../text/sanitize";
import { registerRenderer, type RenderOptions } from "./registry";

/** Paper behind a label pill (matches the export surfaces). */
export const labelPaper = (theme: ThemeName): string => (isDarkTheme(theme) ? "#18181b" : "#ffffff");

const strokeOf = (el: Element, o: RenderOptions): string => mapInkColor(safeColor(el.color, FALLBACK_INK), o.theme);

/** Dash pattern (page units) of a dashed connector of stroke `width`, else null. */
export function connectorDash(el: Element): [number, number] | null {
  if (contentOf<ConnectorContent>(el).dash !== "dashed") return null;
  const w = Math.max(1, el.width);
  return [4 * w, 3 * w];
}

function trace(ctx: CanvasRenderingContext2D, poly: readonly Vec2[], closed: boolean): void {
  ctx.beginPath();
  poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  if (closed) ctx.closePath();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2);
  ctx.closePath();
}

function draw(ctx: CanvasRenderingContext2D, el: Element, o: RenderOptions): void {
  const route = connectorRoute(el);
  if (route.length < 2) return;
  const stroke = strokeOf(el, o);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = el.width;
  ctx.strokeStyle = stroke;
  const dash = connectorDash(el);
  if (dash) ctx.setLineDash(dash);
  trace(ctx, route, false);
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
  for (const cap of connectorCapOutlines(el)) {
    const filled = isFilledCap(cap);
    trace(ctx, cap, filled);
    if (filled) {
      ctx.fillStyle = stroke;
      ctx.fill();
    }
    ctx.stroke();
  }
  const pill = labelPill(el);
  if (pill) {
    roundRect(ctx, pill.x, pill.y, pill.width, pill.height, pill.height / 2);
    ctx.fillStyle = o.paper ?? labelPaper(o.theme);
    ctx.fill();
    ctx.lineWidth = 1 / o.zoomBucket;
    ctx.stroke();
    ctx.fillStyle = stroke;
    ctx.font = `${CONNECTOR_LABEL_SIZE}px ${CONNECTOR_LABEL_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(pill.text, pill.centre.x, pill.centre.y);
  }
  ctx.restore();
}

const pathD = (poly: readonly Vec2[], closed: boolean): string => {
  const pts = closed ? poly.slice(0, -1) : poly;
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)} ${n(p.y)}`).join("") + (closed ? "Z" : "");
};

function svg(el: Element, o: RenderOptions): string {
  const route = connectorRoute(el);
  if (route.length < 2) return "";
  const stroke = esc(strokeOf(el, o));
  const strokeAttrs = `stroke="${stroke}" stroke-width="${n(el.width)}" stroke-linejoin="round" stroke-linecap="round"`;
  const dash = connectorDash(el);
  const dashAttr = dash ? ` stroke-dasharray="${n(dash[0])} ${n(dash[1])}"` : "";
  let out = `<path d="${pathD(route, false)}" fill="none" ${strokeAttrs}${dashAttr}/>`;
  for (const cap of connectorCapOutlines(el))
    out += isFilledCap(cap) ? `<path d="${pathD(cap, true)}" fill="${stroke}" ${strokeAttrs}/>` : `<path d="${pathD(cap, false)}" fill="none" ${strokeAttrs}/>`;
  const pill = labelPill(el);
  if (pill) {
    const r = pill.height / 2;
    out +=
      `<rect x="${n(pill.x)}" y="${n(pill.y)}" width="${n(pill.width)}" height="${n(pill.height)}" rx="${n(r)}" ry="${n(r)}"` +
      ` fill="${esc(labelPaper(o.theme))}" stroke="${stroke}" stroke-width="${n(1 / o.zoomBucket)}"/>` +
      `<text x="${n(pill.centre.x)}" y="${n(pill.centre.y)}" text-anchor="middle" dominant-baseline="central"` +
      ` font-size="${n(CONNECTOR_LABEL_SIZE)}" font-family="${esc(CONNECTOR_LABEL_FONT)}" fill="${stroke}">${esc(pill.text)}</text>`;
  }
  return out;
}

registerRenderer("connector", { draw, svg, bounds: connectorBounds });
