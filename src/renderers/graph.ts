// Graph renderer: draws a graph element's PlotScene (graph/plot) straight to the canvas and as
// vector SVG (`<line>`, `<polyline>`, `<polygon>`, `<circle>`, `<text>`), so a graph is vector everywhere and never uses a
// bitmap snapshot. Scenes are cached per element object and theme (elements are immutable: an
// edit is a new object). Until the lazy math engine has loaded, a graph shows its axes and a
// "Loading…" label; once it loads, `boxSnapshots.notify` asks the canvas to re-raster those graphs.
// Registered for "graph" on import (see ./builtins).
import { esc, n } from "../export/svgUtil";
import { graphDataOf } from "../graph/data";
import { loadEngine } from "../graph/engine";
import { buildPlotScene, type PlotScene, type Text } from "../graph/plot";
import type { ThemeName } from "../ink/types";
import type { Element } from "../model/types";
import { FONT_STACKS } from "../text/style";
import { boxRect, contentMeta } from "../tools/spatialIndex";
import { rotatedSvg } from "./boxDraw";
import { boxSnapshots } from "./boxSnapshot";
import { registerRenderer } from "./registry";

export const GRAPH_FONT = `11px ${FONT_STACKS.mono}`;
const GRID_WIDTH = 1;
const AXIS_WIDTH = 1.25;
const CURVE_WIDTH = 2;
/** A derivative's curve: thinner and dashed. */
export const DASHED_CURVE_WIDTH = 1.5;
export const CURVE_DASH = [5, 4] as const;
export const GUIDE_WIDTH = 1.25;
export const GUIDE_DASH = [6, 4] as const;
/** Opacity of a shaded area. */
export const FILL_OPACITY = 0.18;
export const MARKER_RADIUS = 3.5;

const scenes = new WeakMap<Element, Map<ThemeName, PlotScene>>();
/** Graphs drawn while the engine was loading: re-rastered once it has. */
const waiting = new Set<string>();

function redrawWhenLoaded(id: string): void {
  if (waiting.has(id)) return;
  waiting.add(id);
  if (waiting.size > 1) return;
  void loadEngine()
    .then(() => {
      const ids = [...waiting];
      waiting.clear();
      for (const g of ids) boxSnapshots.notify(g);
    })
    .catch(() => waiting.clear());
}

/** The plot scene of graph `el` in `theme` (cached). */
export function graphScene(el: Element, theme: ThemeName): PlotScene {
  let byTheme = scenes.get(el);
  if (!byTheme) scenes.set(el, (byTheme = new Map()));
  let scene = byTheme.get(theme);
  if (!scene) {
    const r = boxRect(el);
    scene = buildPlotScene(graphDataOf(el), { w: r.width, h: r.height }, theme);
    if (scene.pending) redrawWhenLoaded(el.id);
    else byTheme.set(theme, scene);
  }
  return scene;
}

const CANVAS_ALIGN = { left: "left", center: "center", right: "right" } as const;
const CANVAS_BASELINE = { top: "top", middle: "middle", bottom: "bottom" } as const;

/** Draw `scene` in box-local units (origin at the box's top-left), clipped to the box. */
export function drawPlotScene(ctx: CanvasRenderingContext2D, scene: PlotScene): void {
  const { w, h, colors } = scene;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, w, h);
  ctx.lineCap = "butt";
  const strokeLines = (lines: PlotScene["grid"], color: string, width: number) => {
    if (lines.length === 0) return;
    ctx.beginPath();
    for (const l of lines) {
      ctx.moveTo(l.a.x, l.a.y);
      ctx.lineTo(l.b.x, l.b.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  strokeLines(scene.grid, colors.grid, GRID_WIDTH);
  strokeLines(scene.axes, colors.axis, AXIS_WIDTH);
  for (const f of scene.fills) {
    ctx.beginPath();
    f.polygon.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.globalAlpha = FILL_OPACITY;
    ctx.fillStyle = f.color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  for (const g of scene.guides) {
    ctx.beginPath();
    ctx.moveTo(g.a.x, g.a.y);
    ctx.lineTo(g.b.x, g.b.y);
    ctx.setLineDash([...GUIDE_DASH]);
    ctx.strokeStyle = g.color;
    ctx.lineWidth = GUIDE_WIDTH;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const c of scene.curves) {
    ctx.beginPath();
    c.polyline.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = c.color;
    ctx.lineWidth = c.dashed ? DASHED_CURVE_WIDTH : CURVE_WIDTH;
    if (c.dashed) ctx.setLineDash([...CURVE_DASH]);
    ctx.stroke();
    if (c.dashed) ctx.setLineDash([]);
  }
  for (const m of scene.markers) {
    ctx.beginPath();
    ctx.arc(m.x, m.y, MARKER_RADIUS, 0, 2 * Math.PI);
    ctx.fillStyle = m.filled ? m.color : colors.background;
    ctx.fill();
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.font = GRAPH_FONT;
  ctx.fillStyle = colors.text;
  for (const t of scene.labels) {
    ctx.textAlign = CANVAS_ALIGN[t.align];
    ctx.textBaseline = CANVAS_BASELINE[t.baseline];
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, el: Element, theme: ThemeName): void {
  const r = boxRect(el);
  if (r.width <= 0 || r.height <= 0) return;
  const rot = contentMeta(el).rotation ?? 0;
  ctx.save();
  if (rot) {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.translate(-cx, -cy);
  }
  ctx.translate(r.x, r.y);
  drawPlotScene(ctx, graphScene(el, theme));
  ctx.restore();
}

const SVG_ANCHOR = { left: "start", center: "middle", right: "end" } as const;
const SVG_BASELINE = { top: "hanging", middle: "central", bottom: "text-after-edge" } as const;

const linesSvg = (lines: PlotScene["grid"], color: string, width: number): string =>
  lines.map((l) => `<line x1="${n(l.a.x)}" y1="${n(l.a.y)}" x2="${n(l.b.x)}" y2="${n(l.b.y)}" stroke="${esc(color)}" stroke-width="${n(width)}"/>`).join("");

const textSvg = (t: Text, color: string): string =>
  `<text x="${n(t.x)}" y="${n(t.y)}" fill="${esc(color)}" font-family="${esc(FONT_STACKS.mono)}" font-size="11" text-anchor="${SVG_ANCHOR[t.align]}" dominant-baseline="${SVG_BASELINE[t.baseline]}">${esc(t.text)}</text>`;

const pointsSvg = (pts: PlotScene["curves"][number]["polyline"]): string => pts.map((p) => `${n(p.x)},${n(p.y)}`).join(" ");

/** SVG of `scene` in box-local units. */
export function plotSceneSvg(scene: PlotScene): string {
  const { w, h, colors } = scene;
  return (
    `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" fill="${esc(colors.background)}"/>` +
    linesSvg(scene.grid, colors.grid, GRID_WIDTH) +
    linesSvg(scene.axes, colors.axis, AXIS_WIDTH) +
    scene.fills.map((f) => `<polygon fill="${esc(f.color)}" fill-opacity="${FILL_OPACITY}" stroke="none" points="${pointsSvg(f.polygon)}"/>`).join("") +
    scene.guides
      .map(
        (g) =>
          `<line x1="${n(g.a.x)}" y1="${n(g.a.y)}" x2="${n(g.b.x)}" y2="${n(g.b.y)}" stroke="${esc(g.color)}" stroke-width="${GUIDE_WIDTH}" stroke-dasharray="${GUIDE_DASH.join(" ")}"/>`,
      )
      .join("") +
    scene.curves
      .map(
        (c) =>
          `<polyline fill="none" stroke="${esc(c.color)}" stroke-width="${c.dashed ? DASHED_CURVE_WIDTH : CURVE_WIDTH}"${c.dashed ? ` stroke-dasharray="${CURVE_DASH.join(" ")}"` : ""} stroke-linejoin="round" stroke-linecap="round" points="${pointsSvg(c.polyline)}"/>`,
      )
      .join("") +
    scene.markers
      .map(
        (m) =>
          `<circle cx="${n(m.x)}" cy="${n(m.y)}" r="${MARKER_RADIUS}" fill="${esc(m.filled ? m.color : colors.background)}" stroke="${esc(m.color)}" stroke-width="1.5"/>`,
      )
      .join("") +
    scene.labels.map((t) => textSvg(t, colors.text)).join("")
  );
}

function svg(el: Element, theme: ThemeName): string {
  const r = boxRect(el);
  if (r.width <= 0 || r.height <= 0) return "";
  return rotatedSvg(el, `<g transform="translate(${n(r.x)} ${n(r.y)})">${plotSceneSvg(graphScene(el, theme))}</g>`);
}

registerRenderer("graph", {
  draw: (ctx, el, o) => draw(ctx, el, o.theme),
  svg: (el, o) => svg(el, o.theme),
});
