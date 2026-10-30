// Mind-map renderer (spec D4): edges first, then node boxes (rounded rects, or pills for the root
// per style; the minimal style only underlines), their wrapped text centred, and a count badge on
// the outer edge of each collapsed node. SVG emits the same scene (one <path> per edge, one <rect>
// and one <text> per node); the PDF export paints it too (export/renderToPdf). Rotation is ignored.
// `bounds` = the layout bounds (plus badges) padded by 2, from the shared memo (mindmap/cache).
import { esc, n } from "../export/svgUtil";
import type { ThemeName } from "../ink/types";
import type { Vec2 } from "../canvas/camera";
import type { Element } from "../model/types";
import { BADGE_RADIUS, badgeCentre, mindmapBounds, mindmapFont, MINDMAP_FONT, mindmapView } from "../mindmap/cache";
import { LINE_HEIGHT, ROOT_FONT, type NodeBox } from "../mindmap/layout";
import { contrastText, edgePaint, nodePaint, type EdgePaint, type NodePaint } from "../mindmap/styles";
import type { ElementRenderer } from "./registry";

export interface SceneNode {
  box: NodeBox;
  paint: NodePaint;
  lines: string[];
  fontSize: number;
  bold: boolean;
}

export interface SceneBadge {
  centre: Vec2;
  radius: number;
  fill: string;
  text: string;
  label: string;
}

export interface MindmapScene {
  edges: { path: Vec2[]; paint: EdgePaint }[];
  nodes: SceneNode[];
  badges: SceneBadge[];
}

/** Badge label of `count` hidden nodes ("99+" past 99). */
const badgeLabel = (count: number): string => (count > 99 ? "99+" : String(count));

/** What mind map `el` paints in `theme`: edges, nodes and badges, in paint order. */
export function mindmapScene(el: Element, theme: ThemeName): MindmapScene {
  const v = mindmapView(el);
  const style = v.content.style;
  const { nodes } = v.layout;
  const edges = v.layout.edges.map((e) => {
    const to = nodes.get(e.to)!;
    return { path: e.path, paint: edgePaint(style, to.branch, theme, v.colors.get(e.to)) };
  });
  const out: SceneNode[] = [];
  const badges: SceneBadge[] = [];
  for (const box of nodes.values()) {
    const paint = nodePaint(style, box, theme, v.colors.get(box.id));
    const fontSize = v.fontSize.get(box.id) ?? ROOT_FONT;
    out.push({ box, paint, lines: v.lines.get(box.id) ?? [""], fontSize, bold: box.depth === 0 });
    const hidden = v.hidden.get(box.id);
    if (hidden) {
      // The branch colour in every style (soft and filled nodes have it as `stroke`, not `fill`).
      const fill = paint.stroke;
      badges.push({ centre: badgeCentre(box), radius: BADGE_RADIUS, fill, text: contrastText(fill), label: badgeLabel(hidden) });
    }
  }
  return { edges, nodes: out, badges };
}

/** Baseline-centre y of line `i` of `lines` centred in `box` at `fontSize`. */
export function lineY(box: NodeBox, count: number, i: number, fontSize: number): number {
  const step = fontSize * LINE_HEIGHT;
  return box.y + box.height / 2 - (count * step) / 2 + (i + 0.5) * step;
}

/** Corner radius of `box` clamped to its size. */
export const nodeRadius = (box: NodeBox, radius: number): number => Math.max(0, Math.min(radius, box.width / 2, box.height / 2));

function roundRectPath(ctx: CanvasRenderingContext2D, b: NodeBox, rad: number): void {
  const k = nodeRadius(b, rad);
  const { x, y, width: w, height: h } = b;
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.lineTo(x + w - k, y);
  ctx.arc(x + w - k, y + k, k, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - k);
  ctx.arc(x + w - k, y + h - k, k, 0, Math.PI / 2);
  ctx.lineTo(x + k, y + h);
  ctx.arc(x + k, y + h - k, k, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + k);
  ctx.arc(x + k, y + k, k, Math.PI, (3 * Math.PI) / 2);
  ctx.closePath();
}

const pathD = (pts: Vec2[]): string => pts.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)} ${n(p.y)}`).join(" ");

export const mindmapRenderer: ElementRenderer = {
  draw(ctx, el, o) {
    const scene = mindmapScene(el, o.theme);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const e of scene.edges) {
      if (e.path.length < 2) continue;
      ctx.beginPath();
      e.path.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.setLineDash(e.paint.dash ?? []);
      ctx.lineWidth = e.paint.strokeWidth;
      ctx.strokeStyle = e.paint.stroke;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const { box, paint, lines, fontSize } of scene.nodes) {
      if (paint.underline) {
        ctx.beginPath();
        ctx.moveTo(box.x, box.y + box.height);
        ctx.lineTo(box.x + box.width, box.y + box.height);
        ctx.lineWidth = paint.strokeWidth;
        ctx.strokeStyle = paint.stroke;
        ctx.stroke();
      } else {
        roundRectPath(ctx, box, paint.radius);
        if (paint.fill !== "transparent") {
          ctx.fillStyle = paint.fill;
          ctx.fill();
        }
        if (paint.strokeWidth > 0) {
          ctx.setLineDash(paint.dash ?? []);
          ctx.lineWidth = paint.strokeWidth;
          ctx.strokeStyle = paint.stroke;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      ctx.fillStyle = paint.text;
      ctx.font = mindmapFont(fontSize);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const cx = box.x + box.width / 2;
      lines.forEach((line, i) => {
        if (line !== "") ctx.fillText(line, cx, lineY(box, lines.length, i, fontSize));
      });
    }
    for (const b of scene.badges) {
      ctx.beginPath();
      ctx.arc(b.centre.x, b.centre.y, b.radius, 0, Math.PI * 2);
      ctx.fillStyle = b.fill;
      ctx.fill();
      ctx.fillStyle = b.text;
      ctx.font = `600 ${b.radius * 1.2}px ${MINDMAP_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.label, b.centre.x, b.centre.y);
    }
    ctx.restore();
  },
  svg(el, o) {
    const scene = mindmapScene(el, o.theme);
    let out = "";
    for (const e of scene.edges) {
      if (e.path.length < 2) continue;
      const dash = e.paint.dash ? ` stroke-dasharray="${e.paint.dash.map(n).join(" ")}"` : "";
      out += `<path d="${pathD(e.path)}" fill="none" stroke="${esc(e.paint.stroke)}" stroke-width="${n(e.paint.strokeWidth)}" stroke-linecap="round"${dash}/>`;
    }
    for (const { box, paint, lines, fontSize, bold } of scene.nodes) {
      const k = nodeRadius(box, paint.radius);
      const fill = paint.fill === "transparent" ? "none" : esc(paint.fill);
      const outlined = !paint.underline && paint.strokeWidth > 0;
      const stroke = outlined ? ` stroke="${esc(paint.stroke)}" stroke-width="${n(paint.strokeWidth)}"` : ` stroke="none"`;
      const dash = outlined && paint.dash ? ` stroke-dasharray="${paint.dash.map(n).join(" ")}"` : "";
      out += `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" rx="${n(k)}" ry="${n(k)}" fill="${fill}"${stroke}${dash}/>`;
      if (paint.underline) {
        const y = n(box.y + box.height);
        out += `<line x1="${n(box.x)}" y1="${y}" x2="${n(box.x + box.width)}" y2="${y}" stroke="${esc(paint.stroke)}" stroke-width="${n(paint.strokeWidth)}"/>`;
      }
      const cx = n(box.x + box.width / 2);
      const spans = lines.map((line, i) => `<tspan x="${cx}" y="${n(lineY(box, lines.length, i, fontSize))}">${esc(line)}</tspan>`).join("");
      out +=
        `<text text-anchor="middle" dominant-baseline="central" font-size="${n(fontSize)}" font-weight="${bold ? 600 : 400}"` +
        ` font-family="${esc(MINDMAP_FONT)}" fill="${esc(paint.text)}">${spans}</text>`;
    }
    for (const b of scene.badges) {
      out += `<circle cx="${n(b.centre.x)}" cy="${n(b.centre.y)}" r="${n(b.radius)}" fill="${esc(b.fill)}"/>`;
      out +=
        `<text x="${n(b.centre.x)}" y="${n(b.centre.y)}" text-anchor="middle" dominant-baseline="central" font-size="${n(b.radius * 1.2)}"` +
        ` font-weight="600" font-family="${esc(MINDMAP_FONT)}" fill="${esc(b.text)}">${esc(b.label)}</text>`;
    }
    return out;
  },
  bounds: mindmapBounds,
};
