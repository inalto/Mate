import { beforeAll, describe, expect, it } from "vitest";
import { defaultGraphData, GRAPH_PALETTE, type GraphData } from "../data";
import { loadEngine } from "../engine";
import type { ParseResult } from "../expressions";
import { buildPlotScene, formatTick, niceStep, TOO_SLOW } from "../plot";

const box = { w: 480, h: 360 };
const inBox = (p: { x: number; y: number }) => p.x >= -1e-9 && p.x <= box.w + 1e-9 && p.y >= -1e-9 && p.y <= box.h + 1e-9;

function data(latex: string[], domain = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 }): GraphData {
  return {
    ...defaultGraphData(),
    domain,
    expressions: latex.map((l, i) => ({ id: `e${i}`, latex: l, color: GRAPH_PALETTE[i], visible: true })),
  };
}

describe("buildPlotScene", () => {
  beforeAll(async () => {
    await loadEngine();
  });

  it("slow_expression_is_bounded", () => {
    const slow = (x: number) => {
      const until = performance.now() + 1;
      while (performance.now() < until) {
        // busy: 1 ms per evaluation, 2048+ evaluations would take seconds
      }
      return Math.sin(x);
    };
    const parse = (latex: string): ParseResult => (latex === "slow" ? { kind: "of-x", f: slow } : { error: "no" });
    const t0 = performance.now();
    const scene = buildPlotScene(data(["slow"]), box, "light", { parse });
    expect(performance.now() - t0).toBeLessThan(200);
    expect(scene.warnings).toEqual([{ id: "e0", message: TOO_SLOW }]);
    expect(scene.curves.length).toBeGreaterThan(0); // the part sampled in time is still drawn
    expect(buildPlotScene(data(["x"]), box, "light").warnings).toEqual([]);
  });

  it("pending_engine_draws_axes_and_a_loading_label", () => {
    const scene = buildPlotScene(data(["x"]), box, "light", { parse: () => ({ pending: true }) });
    expect(scene.pending).toBe(true);
    expect(scene.curves).toEqual([]);
    expect(scene.axes.length).toBeGreaterThanOrEqual(2);
    expect(scene.labels.map((l) => l.text)).toContain("Loading…");
  });

  it("polar_evaluates_r_once_per_angle", () => {
    let calls = 0;
    const r = () => {
      calls++;
      return 2;
    };
    const parse = (): ParseResult => ({ kind: "polar", r });
    const scene = buildPlotScene(data(["circle"]), box, "light", { parse });
    const points = scene.curves.reduce((n, c) => n + c.polyline.length, 0);
    expect(points).toBeGreaterThan(0);
    // One evaluation per sample (x and y share it), plus at most one cached midpoint per interval.
    expect(calls).toBeLessThan(points * 2);
  });

  it("axes_and_ticks_within_box", () => {
    for (const domain of [
      { xMin: -10, xMax: 10, yMin: -10, yMax: 10 },
      { xMin: 3, xMax: 7, yMin: 2, yMax: 100 }, // origin off-screen: axes pinned to the edge
      { xMin: -0.003, xMax: 0.001, yMin: -1e5, yMax: 2e5 },
    ]) {
      const scene = buildPlotScene(data(["\\sin(x)"], domain), box, "light");
      expect(scene.axes.length).toBeGreaterThanOrEqual(2);
      for (const l of [...scene.axes, ...scene.grid]) {
        expect(inBox(l.a)).toBe(true);
        expect(inBox(l.b)).toBe(true);
      }
      const xs = scene.ticks.filter((t) => t.axis === "x");
      const ys = scene.ticks.filter((t) => t.axis === "y");
      expect(xs.length).toBeGreaterThanOrEqual(2);
      expect(ys.length).toBeGreaterThanOrEqual(2);
      expect(xs.length).toBeLessThanOrEqual(12);
      expect(ys.length).toBeLessThanOrEqual(12);
      for (const t of scene.ticks) expect(inBox(t.pos)).toBe(true);
      for (const t of scene.labels) expect(inBox(t)).toBe(true);
      for (const c of scene.curves) for (const p of c.polyline) expect(inBox(p)).toBe(true);
    }
  });

  it("maps_the_domain_to_the_box", () => {
    const scene = buildPlotScene(data([]), box, "light");
    const yAxis = scene.axes.find((l) => l.a.x === l.b.x)!;
    const xAxis = scene.axes.find((l) => l.a.y === l.b.y)!;
    expect(yAxis.a.x).toBeCloseTo(240);
    expect(xAxis.a.y).toBeCloseTo(180);
    expect(scene.ticks.find((t) => t.axis === "x" && t.label === "4")!.pos.x).toBeCloseTo(240 + 4 * 24);
  });

  it("clips_curves_and_skips_hidden_or_invalid", () => {
    const d = data(["x^2", "\\tan(x)", "\\sqrt{", "x"]);
    d.expressions[3].visible = false;
    const scene = buildPlotScene(d, box, "light");
    const colors = new Set(scene.curves.map((c) => c.color));
    expect(colors).toEqual(new Set([GRAPH_PALETTE[0], GRAPH_PALETTE[1]]));
    expect(scene.curves.filter((c) => c.color === GRAPH_PALETTE[1]).length).toBeGreaterThanOrEqual(7);
  });

  it("grid_toggle_and_dark_colours", () => {
    const d = data(["x"]);
    expect(buildPlotScene({ ...d, grid: false }, box, "light").grid).toEqual([]);
    expect(buildPlotScene(d, box, "light").grid.length).toBeGreaterThan(0);
    const dark = buildPlotScene(d, box, "dark");
    expect(dark.curves[0].color).not.toBe(GRAPH_PALETTE[0]);
    expect(dark.colors.background).not.toBe("#ffffff");
  });

  it("nice_steps_follow_1_2_5", () => {
    expect(niceStep(20)).toBe(2);
    expect(niceStep(4)).toBe(0.5);
    expect(niceStep(98)).toBe(10);
    expect(niceStep(3e5)).toBe(50000);
  });

  it("formats_ticks_to_the_step", () => {
    expect(formatTick(4, 2)).toBe("4");
    expect(formatTick(-1.5, 0.5)).toBe("-1.5");
    expect(formatTick(0.0015, 0.0005)).toBe("0.0015");
    expect(formatTick(2e6, 5e5)).toBe("2.0e6");
  });
});

describe("graph data colours", () => {
  it("unsafe_expression_colours_fall_back_to_the_palette", async () => {
    const { graphDataOf, GRAPH_PALETTE } = await import("../data");
    const g = graphDataOf({
      content: { subtype: "graph", graphData: { expressions: [{ id: "a", latex: "x", color: "red;background:url(x)" }, { id: "b", latex: "x", color: "#ff0000" }] } },
    });
    expect(g.expressions[0].color).toBe(GRAPH_PALETTE[0]);
    expect(g.expressions[1].color).toBe("#ff0000");
  });
});
