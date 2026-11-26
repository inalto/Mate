import { beforeAll, describe, expect, it } from "vitest";
import { renderToPdf, type PdfDeps, type PdfExportOptions } from "../../export/renderToPdf";
import { DEFAULT_DOMAIN, graphElement, type GraphData, type GraphExpression } from "../../graph/data";
import { loadEngine } from "../../graph/engine";
import { buildPlotScene } from "../../graph/plot";
import type { Element, Page } from "../../model/types";
import "../builtins";
import { drawPlotScene, plotSceneSvg } from "../graph";

const box = { w: 400, h: 400 };
const expr = (patch: Partial<GraphExpression>): GraphExpression => ({ id: "e", latex: "", color: "#C62828", visible: true, ...patch });
const data = (e: GraphExpression): GraphData => ({ kind: "2d-function", expressions: [e], domain: { ...DEFAULT_DOMAIN }, grid: false });

const step = expr({
  latex: "x^2",
  pieces: [
    { latex: "x^2", max: 1 },
    { latex: "3-x", min: 1, max: 2, maxClosed: true },
  ],
});

function recorder() {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : (...args: unknown[]) => calls.push(`${String(k)}(${args.map((a) => (Array.isArray(a) ? `[${a}]` : typeof a === "number" ? +a.toFixed(1) : a)).join(",")})`)),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("graph scene: pieces and study items", () => {
  beforeAll(async () => {
    await loadEngine();
  });

  it("a_plain_expression_has_no_extra_items", () => {
    const s = buildPlotScene(data(expr({ latex: "x^2" })), box, "light");
    expect([s.markers, s.guides, s.fills]).toEqual([[], [], []]);
    expect(s.curves.every((c) => !c.dashed)).toBe(true);
  });

  it("piece_ends_are_dots_hollow_when_open", () => {
    const s = buildPlotScene(data(step), box, "light");
    // (1, 1) open, (1, 2) and (2, 1) closed; box y is flipped: y = 1 at 180, y = 2 at 160.
    expect(s.markers.map((m) => [Math.round(m.x), Math.round(m.y), m.filled])).toEqual([
      [220, 180, false],
      [220, 160, true],
      [240, 180, true],
    ]);
    // Two branches that never join across x = 1.
    expect(s.curves).toHaveLength(2);
    const round = (p?: { x: number; y: number }) => p && { x: Math.round(p.x * 1e6) / 1e6, y: Math.round(p.y * 1e6) / 1e6 };
    expect(round(s.curves[0].polyline.at(-1))).toEqual({ x: 220, y: 180 });
    expect(round(s.curves[1].polyline[0])).toEqual({ x: 220, y: 160 });
  });

  it("an_invalid_piece_plots_nothing_for_that_function", () => {
    const s = buildPlotScene(data(expr({ latex: "x", pieces: [{ latex: "x", max: 0 }, { latex: "r = \\theta" }] })), box, "light");
    expect(s.curves).toEqual([]);
  });

  it("study_flags_add_dots_labels_asymptotes_derivative_and_area", () => {
    const e = expr({ latex: "x^3-3x", study: { zeros: true, intercept: true, extrema: true, inflections: true, derivative: true, area: { from: 0, to: 1 } } });
    const s = buildPlotScene(data(e), box, "light");
    expect(s.markers.filter((m) => m.filled)).toHaveLength(3 + 1 + 2); // zeros, intercept, extrema
    expect(s.markers.filter((m) => !m.filled)).toHaveLength(1); // the inflection
    expect(s.labels.map((l) => l.text)).toEqual(expect.arrayContaining(["(−1, 2)", "(1, −2)", "(0, 0)"]));
    expect(s.curves.some((c) => c.dashed)).toBe(true);
    expect(s.fills).toHaveLength(1);
    expect(s.fills[0].polygon[0]).toEqual({ x: 200, y: 200 });

    const hyp = buildPlotScene(data(expr({ latex: "1/x", study: { asymptotes: true } })), box, "light");
    // x = 0 and y = 0 (the same line at −∞ and +∞ is drawn once).
    expect(hyp.guides.map((g) => [g.a.x, g.b.x, g.a.y, g.b.y])).toEqual([
      [200, 200, 400, 0],
      [0, 400, 200, 200],
    ]);
  });

  it("canvas_and_svg_draw_the_new_items", () => {
    const e = { ...step, study: { asymptotes: true, derivative: true, area: { from: -1, to: 0 } } };
    const s = buildPlotScene(data(e), box, "light");
    const { ctx, calls } = recorder();
    drawPlotScene(ctx, s);
    expect(calls.filter((c) => c.startsWith("arc("))).toHaveLength(3);
    expect(calls).toContain("setLineDash([5,4])");
    expect(calls.filter((c) => c === "fill()").length).toBeGreaterThanOrEqual(4); // the area and the dots
    const svg = plotSceneSvg(s);
    expect(svg.match(/<circle /g)).toHaveLength(3);
    expect(svg).toContain('stroke-dasharray="5 4"');
    expect(svg).toContain('fill-opacity="0.18"');
  });

  it("the_pdf_export_draws_them_too", async () => {
    const el: Element = graphElement("p", "g", "t", { x: 0, y: 0 }, "#000000");
    const withStudy = { ...el, content: { subtype: "graph", graphData: data({ ...step, study: { asymptotes: true, derivative: true } }) } } as Element;
    const page = {
      id: "p",
      sectionId: "s",
      title: "T",
      isExpanded: false,
      isFavourite: false,
      depth: 0,
      mode: "canvas",
      backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
      thumbnailVersion: 0,
      orderIndex: 0,
      createdAt: "t",
      updatedAt: "t",
      version: 0,
    } as Page;
    const deps: PdfDeps = { readPdfBytes: async () => new Uint8Array(), rasterize: () => null, rasterPdfPages: async () => new Map() };
    const opts: PdfExportOptions = { theme: "light", background: "plain", pages: "all", searchable: false, compress: false };
    const text = new TextDecoder("latin1").decode(await renderToPdf([withStudy], page, opts, deps));
    expect(text).toContain("[3.75 3.] 0. d"); // the derivative's dash pattern (5 4 at 0.75 pt a unit)
    expect(text).toMatch(/ c\n/); // the dots' Bézier circles
  });
});
