// Shape renderer: canvas, SVG and bounds for `type: "shape"` elements, from the pure outline in
// shapes/geometry. Fill (`fillColor` at `content.fillOpacity`) is painted under the stroke (`color`
// at `width`, round joins); an arrow's head is filled with the stroke colour. Ink colours remap in
// dark themes like strokes do.
import { esc, n } from "../export/svgUtil";
import { mapInkColor } from "../ink/theme";
import type { Vec2 } from "../canvas/camera";
import type { Element } from "../model/types";
import { contentMeta } from "../tools/spatialIndex";
import { fillOpacityOf, hasFill, isClosedShape, shapeBounds, shapeElementOutline, shapeRectOf } from "../shapes/geometry";
import { FALLBACK_INK } from "../text/boxHtml";
import { isSafeColor, safeColor } from "../text/sanitize";
import { registerRenderer, type RenderOptions } from "./registry";

interface Paint {
  stroke: string;
  /** Fill colour, or null when the shape is not filled. */
  fill: string | null;
  opacity: number;
}

function paintOf(el: Element, o: RenderOptions): Paint {
  const closed = isClosedShape(el.shapeType ?? "rectangle");
  const opacity = fillOpacityOf(el);
  // Stored colours reach SVG/CSS: an unsafe stroke falls back to black, an unsafe fill to none.
  const fill = closed && hasFill(el.fillColor) && isSafeColor(el.fillColor) && opacity > 0 ? mapInkColor(el.fillColor.trim(), o.theme) : null;
  return { stroke: mapInkColor(safeColor(el.color, FALLBACK_INK), o.theme), fill, opacity };
}

function trace(ctx: CanvasRenderingContext2D, poly: Vec2[], closed: boolean): void {
  ctx.beginPath();
  poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  if (closed) ctx.closePath();
}

function draw(ctx: CanvasRenderingContext2D, el: Element, o: RenderOptions): void {
  const [main, head] = shapeElementOutline(el);
  if (!main || main.length === 0) return;
  const p = paintOf(el, o);
  const closed = isClosedShape(el.shapeType ?? "rectangle");
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = el.width;
  ctx.strokeStyle = p.stroke;
  trace(ctx, main, closed);
  if (p.fill) {
    ctx.globalAlpha = p.opacity;
    ctx.fillStyle = p.fill;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.stroke();
  if (head) {
    trace(ctx, head, true);
    ctx.fillStyle = p.stroke;
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

const pathD = (poly: Vec2[], closed: boolean): string => {
  const pts = closed ? poly.slice(0, -1) : poly;
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)} ${n(p.y)}`).join("") + (closed ? "Z" : "");
};

function svg(el: Element, o: RenderOptions): string {
  const outline = shapeElementOutline(el);
  if (outline.length === 0 || outline[0].length === 0) return "";
  const p = paintOf(el, o);
  const stroke = esc(p.stroke);
  const strokeAttrs = `stroke="${stroke}" stroke-width="${n(el.width)}" stroke-linejoin="round" stroke-linecap="round"`;
  const fillAttrs = p.fill ? `fill="${esc(p.fill)}"${p.opacity < 1 ? ` fill-opacity="${n(p.opacity)}"` : ""}` : `fill="none"`;
  const type = el.shapeType ?? "rectangle";
  if (type === "circle" || type === "ellipse") {
    const r = shapeRectOf(el);
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const rot = contentMeta(el).rotation ?? 0;
    const transform = rot ? ` transform="rotate(${n((rot * 180) / Math.PI)} ${n(cx)} ${n(cy)})"` : "";
    return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(Math.abs(r.width) / 2)}" ry="${n(Math.abs(r.height) / 2)}"${transform} ${fillAttrs} ${strokeAttrs}/>`;
  }
  if (!isClosedShape(type)) {
    const [[a, b], head] = outline;
    const line = `<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" ${strokeAttrs}/>`;
    return head ? `${line}<path d="${pathD(head, true)}" fill="${stroke}" ${strokeAttrs}/>` : line;
  }
  return `<path d="${pathD(outline[0], true)}" ${fillAttrs} ${strokeAttrs}/>`;
}

registerRenderer("shape", { draw, svg, bounds: shapeBounds });
