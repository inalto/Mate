// Shape renderer: canvas, SVG and bounds for `type: "shape"` elements, from the pure outline in
// shapes/geometry. Fill (`fillColor` at `content.fillOpacity`) is painted under the stroke (`color`
// at `width`, round joins); line caps follow the shaft: arrow heads and dots are filled with the
// stroke colour, bars stroked. Ink colours remap in
// dark themes like strokes do. A closed shape's label (shapes/label) is wrapped into the inner
// rect, vertically centred, clipped to the outline on canvas and rotated with the shape.
import { esc, n } from "../export/svgUtil";
import { mapInkColor } from "../ink/theme";
import type { Vec2 } from "../canvas/camera";
import type { Element } from "../model/types";
import { contentMeta } from "../tools/spatialIndex";
import { fillOpacityOf, hasFill, isClosedShape, isFilledCap, shapeBounds, shapeElementOutline, shapeRectOf } from "../shapes/geometry";
import { LABEL_LINE_HEIGHT, labelLines, labelMeasure, SHAPE_LABEL_FONT, shapeInnerRect, shapeLabelOf, type ShapeLabel } from "../shapes/label";
import type { ShapeRect } from "../shapes/geometry";
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

/** Label colour: unsafe values fall back to the (safe) stroke colour; remapped like ink. */
const labelColor = (el: Element, label: ShapeLabel, o: RenderOptions): string =>
  mapInkColor(safeColor(label.color, safeColor(el.color, FALLBACK_INK)), o.theme);

interface LabelLayout {
  /** Anchor x of every line (per alignment). */
  x: number;
  /** Middle y of the first line. */
  y: number;
  /** Line spacing. */
  step: number;
}

/** Lines stacked `LABEL_LINE_HEIGHT × fontSize` apart, the block centred vertically in `inner`. */
function layoutLabel(label: ShapeLabel, inner: ShapeRect, count: number): LabelLayout {
  const step = label.fontSize * LABEL_LINE_HEIGHT;
  const x = label.align === "left" ? inner.x : label.align === "right" ? inner.x + inner.width : inner.x + inner.width / 2;
  return { x, y: inner.y + inner.height / 2 - (count * step) / 2 + step / 2, step };
}

const blank = (lines: string[]): boolean => lines.every((l) => l === "");

/** Rotation and centre the label turns about (the box centre, like the outline). */
function labelTurn(el: Element): { rot: number; cx: number; cy: number } {
  const r = shapeRectOf(el);
  return { rot: contentMeta(el).rotation ?? 0, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}

function drawLabel(ctx: CanvasRenderingContext2D, el: Element, outline: Vec2[], o: RenderOptions): void {
  const label = shapeLabelOf(el);
  const inner = shapeInnerRect(el);
  if (!label || !inner) return;
  ctx.save();
  ctx.font = `${label.fontSize}px ${SHAPE_LABEL_FONT}`;
  const lines = labelLines(el, (s) => ctx.measureText(s).width);
  if (blank(lines)) {
    ctx.restore();
    return;
  }
  // Overflow clips to the (already rotated) outline.
  trace(ctx, outline, true);
  ctx.clip();
  const { rot, cx, cy } = labelTurn(el);
  if (rot) {
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.translate(-cx, -cy);
  }
  ctx.fillStyle = labelColor(el, label, o);
  ctx.textAlign = label.align;
  ctx.textBaseline = "middle";
  const { x, y, step } = layoutLabel(label, inner, lines.length);
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * step));
  ctx.restore();
}

const SVG_ANCHOR: Record<ShapeLabel["align"], string> = { left: "start", center: "middle", right: "end" };

function labelSvg(el: Element, o: RenderOptions): string {
  const label = shapeLabelOf(el);
  const inner = shapeInnerRect(el);
  if (!label || !inner) return "";
  const lines = labelLines(el, labelMeasure(label.fontSize));
  if (blank(lines)) return "";
  const { x, y, step } = layoutLabel(label, inner, lines.length);
  const { rot, cx, cy } = labelTurn(el);
  const transform = rot ? ` transform="rotate(${n((rot * 180) / Math.PI)} ${n(cx)} ${n(cy)})"` : "";
  // Empty lines carry a no-break space so their tspan still advances by `dy`.
  const spans = lines.map((line, i) => `<tspan x="${n(x)}" dy="${i === 0 ? 0 : n(step)}">${line === "" ? "&#160;" : esc(line)}</tspan>`).join("");
  return (
    `<text y="${n(y)}" font-family="${esc(SHAPE_LABEL_FONT)}" font-size="${n(label.fontSize)}" fill="${esc(labelColor(el, label, o))}" ` +
    `text-anchor="${SVG_ANCHOR[label.align]}" dominant-baseline="middle"${transform}>${spans}</text>`
  );
}

function trace(ctx: CanvasRenderingContext2D, poly: Vec2[], closed: boolean): void {
  ctx.beginPath();
  poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  if (closed) ctx.closePath();
}

function draw(ctx: CanvasRenderingContext2D, el: Element, o: RenderOptions): void {
  const [main, ...caps] = shapeElementOutline(el);
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
  for (const cap of caps) {
    const filled = isFilledCap(cap);
    trace(ctx, cap, filled);
    if (filled) {
      ctx.fillStyle = p.stroke;
      ctx.fill();
    }
    ctx.stroke();
  }
  ctx.restore();
  if (closed) drawLabel(ctx, el, main, o);
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
    return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(Math.abs(r.width) / 2)}" ry="${n(Math.abs(r.height) / 2)}"${transform} ${fillAttrs} ${strokeAttrs}/>` + labelSvg(el, o);
  }
  if (!isClosedShape(type)) {
    const [[a, b], ...caps] = outline;
    const line = `<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" ${strokeAttrs}/>`;
    return (
      line +
      caps
        .map((cap) =>
          isFilledCap(cap) ? `<path d="${pathD(cap, true)}" fill="${stroke}" ${strokeAttrs}/>` : `<path d="${pathD(cap, false)}" fill="none" ${strokeAttrs}/>`,
        )
        .join("")
    );
  }
  return `<path d="${pathD(outline[0], true)}" ${fillAttrs} ${strokeAttrs}/>` + labelSvg(el, o);
}

registerRenderer("shape", { draw, svg, bounds: shapeBounds });
