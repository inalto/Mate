import { describe, expect, it } from "vitest";
import type { PenPreset, Point } from "../../model/types";
import { commitStroke, createStrokeBuilder, nibFactor, straightenStroke } from "../strokeCommit";

const pen: PenPreset = { id: "p", type: "pen", color: "#C62828", width: 4.11 };
const raw = (n: number, pressure = 0.5): Point[] =>
  Array.from({ length: n }, (_, i) => ({ x: i * 5, y: Math.sin(i / 3) * 20, pressure, timestamp: i * 8 }));
const opts = (preset: PenPreset) => ({ pageId: "pg", preset, zoom: 1, stabilization: 35, nibFlatness: 35 });

describe("strokeCommit", () => {
  it("straight_builder_keeps_first_and_last_only", () => {
    const pt = (x: number, y: number): Point => ({ x, y, pressure: 0.5, timestamp: 0 });
    const b = createStrokeBuilder({ ...opts(pen), straight: true, stabilization: 0 });
    b.push([pt(0, 0), pt(40, 90), pt(100, 10), pt(200, 200)]);
    expect(b.points().map((p) => [p.x, p.y])).toEqual([[0, 0], [200, 200]]);
    expect(b.finish().map((p) => [p.x, p.y])).toEqual([[0, 0], [200, 200]]);
    expect(b.preview([pt(300, 300)]).map((p) => [p.x, p.y])).toEqual([[0, 0], [300, 300]]);
  });

  it("straight_line_ends_where_the_pen_lifted_despite_stabilization", () => {
    const pt = (x: number, y: number): Point => ({ x, y, pressure: 0.5, timestamp: 0 });
    const b = createStrokeBuilder({ ...opts(pen), straight: true, stabilization: 80, clampRect: { x: 0, y: 0, width: 150, height: 1000 } });
    // Small final steps: the stabiliser lags behind them; the last one is also past the sheet edge.
    b.push([pt(0, 0), pt(140, 0), pt(141, 1), pt(142, 2), pt(160, 3)]);
    expect(b.points().map((p) => [p.x, p.y])).toEqual([[0, 0], [150, 3]]);
    expect(b.finish().map((p) => [p.x, p.y])).toEqual([[0, 0], [150, 3]]);
  });

  it("straighten_stroke_handles_short_inputs", () => {
    const a: Point = { x: 1, y: 1, pressure: 0.5, timestamp: 0 };
    expect(straightenStroke([])).toEqual([]);
    expect(straightenStroke([a])).toEqual([a]);
  });

  it("builds_a_stroke_element_from_the_preset", () => {
    const el = commitStroke(raw(30), opts(pen))!;
    expect(el).toMatchObject({ pageId: "pg", type: "stroke", color: "#C62828", width: 4.11, isHighlighter: false, penStyle: "pen", version: 0 });
    expect(el.points.length).toBeGreaterThan(1);
    expect(el.createdAt).toBe(el.updatedAt);
    const hl = commitStroke(raw(10), opts({ ...pen, type: "highlighter" }))!;
    expect(hl.isHighlighter).toBe(true);
  });

  it("missing_pressure_is_normalised", () => {
    const el = commitStroke(raw(10, 0), opts(pen))!;
    expect(el.points.every((p) => p.pressure === 0.5)).toBe(true);
  });

  it("fountain_pen_nib_modulates_pressure", () => {
    expect(nibFactor(Math.PI / 4, 35)).toBeCloseTo(0.65, 10); // along the nib: (1 − f)
    expect(nibFactor(-Math.PI / 4, 35)).toBeCloseTo(1, 10); // across the nib
    expect(nibFactor(Math.PI / 4, 100)).toBeCloseTo(0.1, 10); // flatness capped at 0.9
    const b = createStrokeBuilder(opts({ ...pen, type: "fountain-pen" }));
    const pts = b.push(raw(20));
    expect(new Set(pts.map((p) => p.pressure.toFixed(3))).size).toBeGreaterThan(1);
  });

  it("preview_does_not_retain_predicted_points", () => {
    const b = createStrokeBuilder(opts(pen));
    b.push(raw(5));
    expect(b.preview(raw(3))).toHaveLength(8);
    expect(b.points()).toHaveLength(5);
  });

  it("clamp_rect_keeps_points_on_the_sheet", () => {
    const pt = (x: number, y: number): Point => ({ x, y, pressure: 0.5, timestamp: 0 });
    const b = createStrokeBuilder({ ...opts(pen), stabilization: 0, clampRect: { x: 0, y: 0, width: 1080, height: 1528 } });
    b.push([pt(-20, 10), pt(500, 1600), pt(1100, 700)]);
    expect(b.points().map((p) => [p.x, p.y])).toEqual([[0, 10], [500, 1528], [1080, 700]]);
    expect(b.preview([pt(2000, -5)]).at(-1)).toMatchObject({ x: 1080, y: 0 });
  });
});
