import { describe, expect, it } from "vitest";
import type { Element, Page, ShapeType } from "../../model/types";
import { renderToSvg } from "../../export/renderToSvg";
import { elementBounds } from "../../tools/spatialIndex";
import "../builtins";
import { drawElement, elementSvg } from "../registry";
import { SHAPE_LABEL_FONT, withShapeLabel } from "../../shapes/label";

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
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
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
    clip: rec("clip"),
    translate: rec("translate"),
    rotate: rec("rotate"),
    fillText: (text: string, x: number, y: number) =>
      calls.push(["fillText", text, x, y, state.fillStyle, state.font, state.textAlign, state.textBaseline]),
    // 7 px per character.
    measureText: (s: string) => ({ width: s.length * 7 }),
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

  it("canvas_caps_fill_dots_and_stroke_bars", () => {
    const ln = shape("line", [
      [0, 0],
      [100, 0],
    ], { color: "#1565C0", content: { fillOpacity: 1, caps: { start: "bar", end: "dot" } } });
    const { ctx, calls } = stubCtx();
    drawElement(ctx, ln, opts);
    // One fill (the dot); strokes for the shaft, the bar and the dot's rim.
    expect(calls.filter((c) => c[0] === "fill")).toEqual([["fill", "#1565C0", 1]]);
    expect(calls.filter((c) => c[0] === "stroke")).toHaveLength(3);
  });

  it("svg_draws_cap_paths", () => {
    const ln = shape("line", [
      [0, 0],
      [100, 0],
    ], { content: { fillOpacity: 1, caps: { start: "arrow", end: "bar" } } });
    const svg = elementSvg(ln, opts);
    expect(svg).toContain('<line x1="0" y1="0" x2="100" y2="0"');
    expect(svg).toMatch(/<path d="M0 0L[^"]+Z" fill="#000000"/);
    expect(svg).toMatch(/<path d="M100 [^"]+L100 [^"Z]+" fill="none"/);
    const dot = elementSvg({ ...ln, content: { fillOpacity: 1, caps: { start: "none", end: "dot" } } }, opts);
    expect((dot.match(/<path /g) ?? []).length).toBe(1);
    expect(dot).toMatch(/fill="#000000"/);
    // A plain line has no cap paths; a legacy arrow keeps its head.
    expect(elementSvg({ ...ln, content: { fillOpacity: 1 } }, opts)).not.toContain("<path");
    const legacy = elementSvg({ ...ln, shapeType: "arrow", content: { fillOpacity: 1 } }, opts);
    expect((legacy.match(/<path /g) ?? []).length).toBe(1);
    expect(legacy).toMatch(/<path d="M100 0L[^"]+Z" fill="#000000"/);
  });

  it("unsafe_colours_fall_back", () => {
    const bad = "red; background: url(http://x/)";
    const svg = elementSvg(shape("rectangle", [[0, 0], [10, 10]], { color: bad, fillColor: "url(#x)" }), { theme: "light", zoomBucket: 1 });
    expect(svg).not.toContain("url(");
    expect(svg).toContain('stroke="#000000"');
    expect(svg).toContain('fill="none"');
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
    // Unsafe colours never reach the markup (black stroke instead).
    const odd = elementSvg({ ...rect, color: '"><x' }, opts);
    expect(odd).not.toContain("&lt;x");
    expect(odd).toContain('stroke="#000000"');
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

describe("shape labels", () => {
  // Rectangle 0,0 → 100,50, stroke 3: inner rect 9,9 82×32 (11 characters at 7 px).
  const labelled = withShapeLabel(rect, { text: "one two three", fontSize: 10, color: "#1565C0", align: "center" });

  it("canvas_draws_wrapped_lines_centred_and_clipped", () => {
    const { ctx, calls } = stubCtx();
    drawElement(ctx, labelled, opts);
    const texts = calls.filter((c) => c[0] === "fillText");
    // Two lines, 12.5 apart, vertically centred on y 25, horizontally on x 50.
    expect(texts).toEqual([
      ["fillText", "one two", 50, 18.75, "#1565C0", `10px ${SHAPE_LABEL_FONT}`, "center", "middle"],
      ["fillText", "three", 50, 31.25, "#1565C0", `10px ${SHAPE_LABEL_FONT}`, "center", "middle"],
    ]);
    const clip = calls.findIndex((c) => c[0] === "clip");
    expect(clip).toBeGreaterThan(calls.findIndex((c) => c[0] === "stroke"));
    expect(clip).toBeLessThan(calls.findIndex((c) => c[0] === "fillText"));
    expect(calls.filter((c) => c[0] === "rotate")).toEqual([]);
    expect(calls[calls.length - 1]).toEqual(["restore"]);
  });

  it("canvas_aligns_left_and_right_to_the_inner_rect", () => {
    for (const [align, x] of [
      ["left", 9],
      ["right", 91],
    ] as const) {
      const { ctx, calls } = stubCtx();
      drawElement(ctx, withShapeLabel(rect, { text: "hi", fontSize: 10, color: "#1565C0", align }), opts);
      expect(calls.filter((c) => c[0] === "fillText")).toEqual([["fillText", "hi", x, 25, "#1565C0", `10px ${SHAPE_LABEL_FONT}`, align, "middle"]]);
    }
  });

  it("canvas_rotates_the_label_about_the_box_centre", () => {
    const { ctx, calls } = stubCtx();
    drawElement(ctx, { ...labelled, content: { ...(labelled.content as object), rotation: 0.5 } }, opts);
    expect(calls.filter((c) => c[0] === "rotate")).toEqual([["rotate", 0.5]]);
    expect(calls.filter((c) => c[0] === "translate")).toEqual([
      ["translate", 50, 25],
      ["translate", -50, -25],
    ]);
  });

  it("label_colour_remaps_in_dark_theme_and_unsafe_falls_back_to_the_stroke", () => {
    const dark = stubCtx();
    drawElement(dark.ctx, withShapeLabel(rect, { text: "x", fontSize: 10, color: "#000000", align: "center" }), { ...opts, theme: "dark" });
    expect(dark.calls.find((c) => c[0] === "fillText")?.[4]).toBe("#FFFFFF");
    const bad = elementSvg(withShapeLabel({ ...rect, color: "#1565C0" }, { text: "x", fontSize: 10, color: "url(#x)", align: "center" }), opts);
    expect(bad).not.toContain("url(");
    expect(bad).toMatch(/<text [^>]*fill="#1565C0"/);
  });

  it("empty_label_draws_nothing", () => {
    const { ctx, calls } = stubCtx();
    drawElement(ctx, withShapeLabel(rect, { text: "", fontSize: 10, color: "#1565C0", align: "center" }), opts);
    expect(calls.filter((c) => c[0] === "fillText" || c[0] === "clip")).toEqual([]);
    expect(elementSvg(withShapeLabel(rect, { text: " ", fontSize: 10, color: "#1565C0", align: "center" }), opts)).not.toContain("<text");
  });

  it("svg_emits_one_tspan_per_line", () => {
    // No canvas in jsdom: SVG measures 0.55 × font size per character (14 characters fit in 82).
    const svg = elementSvg(withShapeLabel(rect, { text: "alpha beta gamma delta", fontSize: 10, color: "#1565C0", align: "center" }), opts);
    expect(svg).toMatch(/^<path /);
    expect((svg.match(/<tspan /g) ?? []).length).toBe(2);
    expect(svg).toContain('<tspan x="50" dy="0">alpha beta</tspan><tspan x="50" dy="12.5">gamma delta</tspan>');
    expect(svg).toContain('y="18.75"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('dominant-baseline="middle"');
    expect(svg).toContain('font-size="10"');
    expect(svg).toContain('fill="#1565C0"');
  });

  it("svg_escapes_text_keeps_empty_lines_and_rotates", () => {
    const el = withShapeLabel(
      { ...rect, content: { fillOpacity: 1, rotation: Math.PI / 2 } },
      { text: "a<b\n\n&c", fontSize: 10, color: "#1565C0", align: "left" },
    );
    const svg = elementSvg(el, opts);
    expect(svg).toContain("a&lt;b");
    expect(svg).toContain("&amp;c");
    expect((svg.match(/<tspan /g) ?? []).length).toBe(3);
    expect(svg).toContain('text-anchor="start"');
    expect(svg).toMatch(/<text [^>]*transform="rotate\(90 50 25\)"/);
  });

  it("lines_and_arrows_ignore_a_stored_label", () => {
    const ln = { ...rect, shapeType: "line" as const, content: { fillOpacity: 1, label: { text: "x", fontSize: 10, color: "#000", align: "center" } } };
    expect(elementSvg(ln, opts)).not.toContain("<text");
  });
});
