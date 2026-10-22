import { describe, expect, it } from "vitest";
import type { Element, Page, ShapeType } from "../../model/types";
import { renderToSvg } from "../../export/renderToSvg";
import { elementBounds } from "../../tools/spatialIndex";
import "../builtins";
import { drawElement, elementSvg } from "../registry";

type Call = [string, ...unknown[]];

/** Recording CanvasRenderingContext2D stand-in (jsdom has no canvas). */
function stubCtx() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {
    lineWidth: 1,
    globalAlpha: 1,
    fillStyle: "#000",
    strokeStyle: "#000",
    lineCap: "butt",
    lineJoin: "miter",
  };
  const stack: Record<string, unknown>[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const ctx: Record<string, unknown> = {
    save: () => {
      stack.push({ ...state });
      calls.push(["save"]);
    },
    restore: () => {
      Object.assign(state, stack.pop());
      calls.push(["restore"]);
    },
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    closePath: rec("closePath"),
    stroke: () => calls.push(["stroke", state.lineWidth, state.strokeStyle, state.lineJoin, state.globalAlpha]),
    fill: () => calls.push(["fill", state.fillStyle, state.globalAlpha]),
  };
  for (const key of Object.keys(state)) {
    Object.defineProperty(ctx, key, {
      get: () => state[key],
      set: (v) => {
        state[key] = v;
      },
    });
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const STAMP = "2026-01-01T00:00:00.000Z";

function shape(shapeType: ShapeType, xy: [number, number][], extra: Partial<Element> = {}): Element {
  return {
    id: "s",
    pageId: "pg",
    type: "shape",
    shapeType,
    points: xy.map(([x, y]) => ({ x, y, pressure: 0.5, timestamp: 0 })),
    color: "#000000",
    fillColor: "#C62828",
    width: 3,
    isHighlighter: false,
    boxWidth: Math.abs(xy[1][0] - xy[0][0]),
    boxHeight: Math.abs(xy[1][1] - xy[0][1]),
    content: { fillOpacity: 0.5 },
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 0,
    ...extra,
  };
}

const rect = shape("rectangle", [
  [0, 0],
  [100, 50],
]);
const opts = { theme: "light" as const, zoomBucket: 1 };

const page: Page = {
  id: "pg",
  sectionId: "s1",
  title: "T",
  isExpanded: false,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
};

describe("shape renderer", () => {
  it("canvas_fills_at_opacity_then_strokes", () => {
    const { ctx, calls } = stubCtx();
    drawElement(ctx, rect, opts);
    const paint = calls.filter((c) => c[0] === "fill" || c[0] === "stroke");
    expect(paint).toEqual([
      ["fill", "#C62828", 0.5],
      ["stroke", 3, "#000000", "round", 1],
    ]);
    expect(calls.filter((c) => c[0] === "lineTo")).toHaveLength(4);
    expect(calls[0]).toEqual(["save"]);
    expect(calls[calls.length - 1]).toEqual(["restore"]);
  });

  it("transparent_fill_is_not_painted_and_dark_theme_remaps_ink", () => {
    const { ctx, calls } = stubCtx();
    drawElement(ctx, { ...rect, fillColor: "transparent" }, { ...opts, theme: "dark" });
    expect(calls.filter((c) => c[0] === "fill")).toEqual([]);
    expect(calls.filter((c) => c[0] === "stroke")).toEqual([["stroke", 3, "#FFFFFF", "round", 1]]);
  });

  it("canvas_arrow_fills_its_head_with_the_stroke_colour", () => {
    const arrow = shape("arrow", [
      [0, 0],
      [100, 0],
    ], { color: "#1565C0" });
    const { ctx, calls } = stubCtx();
    drawElement(ctx, arrow, opts);
    expect(calls.filter((c) => c[0] === "fill")).toEqual([["fill", "#1565C0", 1]]);
    expect(calls.filter((c) => c[0] === "stroke").length).toBeGreaterThanOrEqual(1);
  });

  it("shape_svg_has_fill_and_stroke", () => {
    const svg = elementSvg(rect, opts);
    expect(svg).toMatch(/^<path /);
    expect(svg).toContain('fill="#C62828"');
    expect(svg).toContain('fill-opacity="0.5"');
    expect(svg).toContain('stroke="#000000"');
    expect(svg).toContain('stroke-width="3"');
    expect(svg).toContain('d="M0 0L100 0L100 50L0 50Z"');
    // No fill: fill="none".
    expect(elementSvg({ ...rect, fillColor: "transparent" }, opts)).toContain('fill="none"');
    // Ellipses are <ellipse>, lines <line>, arrows a <line> plus a filled head <path>.
    const ell = elementSvg({ ...rect, shapeType: "ellipse" }, opts);
    expect(ell).toContain('<ellipse cx="50" cy="25" rx="50" ry="25"');
    const line = elementSvg({ ...rect, shapeType: "line" }, opts);
    expect(line).toContain('<line x1="0" y1="0" x2="100" y2="50"');
    expect(line).not.toContain("fill=\"#C62828\"");
    const arrow = elementSvg({ ...rect, shapeType: "arrow" }, opts);
    expect(arrow).toContain("<line ");
    expect(arrow).toMatch(/<path d="M100 50L[^"]+Z" fill="#000000"/);
    // Colours are escaped.
    expect(elementSvg({ ...rect, color: '"><x' }, opts)).toContain("&quot;&gt;&lt;x");
  });

  it("rotated_shapes_rotate_in_svg_and_bounds", () => {
    const rot = { ...rect, content: { fillOpacity: 1, rotation: Math.PI / 2 } };
    expect(elementSvg({ ...rot, shapeType: "ellipse" }, opts)).toContain('transform="rotate(90 50 25)"');
    const b = elementBounds(rot);
    expect(b.width).toBeCloseTo(53);
    expect(b.height).toBeCloseTo(103);
  });

  it("page_svg_export_includes_shapes", () => {
    const svg = renderToSvg([rect], page, { scale: 1, theme: "light", background: "transparent", pageFrame: false });
    expect(svg).toContain('fill="#C62828"');
  });
});
