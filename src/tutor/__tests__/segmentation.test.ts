import { describe, expect, it } from "vitest";
import type { Element } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";
import { beyondMergeReach, DEFAULT_SEGMENTATION, regionIdOf, segmentPage } from "../segmentation";

const T0 = Date.parse("2026-10-23T10:00:00.000Z");

/** A zig-zag "glyph" of `n` points spanning w x h from (x, y), committed at `t` ms after T0. */
function glyph(id: string, x: number, y: number, t: number, opts: Partial<Element> = {}, w = 24, h = 30, n = 8): Element {
  const xy: [number, number][] = [];
  for (let i = 0; i < n; i++) xy.push([x + (w * i) / (n - 1), i % 2 === 0 ? y : y + h]);
  return el(id, xy, { createdAt: new Date(T0 + t).toISOString(), ...opts });
}

const ids = (r: { elementIds: string[] }) => [...r.elementIds].sort();

describe("segmentPage", () => {
  it("clusters_two_lines_separately", () => {
    const line1 = [glyph("a1", 0, 100, 0), glyph("a2", 40, 100, 300), glyph("a3", 80, 100, 600)];
    const line2 = [glyph("b1", 0, 260, 2000), glyph("b2", 40, 260, 2300)];
    const regions = segmentPage([...line2, ...line1]);
    expect(regions).toHaveLength(2);
    expect(ids(regions[0])).toEqual(["a1", "a2", "a3"]);
    expect(ids(regions[1])).toEqual(["b1", "b2"]);
    expect(regions[0].type).toBe("math");
    expect(regions[0].baselineY).toBeCloseTo(regions[0].bounds.y + regions[0].bounds.height);
  });

  it("merges_nearby_strokes_on_a_line", () => {
    // Written seconds apart (no temporal pull) but close on the same baseline.
    const strokes = [glyph("x", 0, 100, 0), glyph("plus", 50, 100, 3000), glyph("two", 100, 100, 6000)];
    const regions = segmentPage(strokes);
    expect(regions).toHaveLength(1);
    expect(ids(regions[0])).toEqual(["plus", "two", "x"]);
    expect(regions[0].bounds.x).toBeLessThanOrEqual(0);
    expect(regions[0].bounds.x + regions[0].bounds.width).toBeGreaterThanOrEqual(124);
  });

  it("keeps_far_strokes_on_a_line_apart", () => {
    const regions = segmentPage([glyph("l", 0, 100, 0), glyph("r", 600, 100, 3000)]);
    expect(regions).toHaveLength(2);
  });

  it("never_merges_strokes_beyond_max_time_gap", () => {
    const regions = segmentPage([glyph("old", 0, 100, 0), glyph("new", 40, 100, DEFAULT_SEGMENTATION.maxTimeGapMs + 100)]);
    expect(regions).toHaveLength(2);
  });

  it("region_id_is_stable_for_same_members", () => {
    const a = [glyph("a1", 0, 100, 0), glyph("a2", 40, 100, 300)];
    const r1 = segmentPage(a);
    const r2 = segmentPage([...a].reverse());
    expect(r1[0].regionId).toBe(r2[0].regionId);
    expect(r1[0].regionId).toBe(regionIdOf(["a2", "a1"]));
    expect(r1[0].regionId).toMatch(/^[0-9a-f]+$/);
    const r3 = segmentPage([...a, glyph("a3", 80, 100, 600)]);
    expect(r3[0].regionId).not.toBe(r1[0].regionId);
  });

  it("minimum_ink_filters_dots", () => {
    const dot = el("dot", [[500, 500], [501, 501]], { createdAt: new Date(T0).toISOString() });
    const tiny = glyph("tiny", 900, 900, 0, {}, 6, 6, 8); // < 15 units
    const few = el("few", [[0, 0], [60, 0]], { createdAt: new Date(T0).toISOString() }); // 2 points
    expect(segmentPage([dot, tiny, few])).toEqual([]);
    // A dot next to real ink is kept as part of that region.
    const withDot = segmentPage([glyph("g", 480, 470, 0), dot]);
    expect(withDot).toHaveLength(1);
    expect(ids(withDot[0])).toEqual(["dot", "g"]);
  });

  it("ignores_highlighter_shapes_and_boxes", () => {
    const hl = glyph("hl", 0, 100, 0, { isHighlighter: true, penStyle: "highlighter" });
    const shape = glyph("sh", 40, 100, 0, { type: "shape", shapeType: "line" });
    const box = el("box", [[0, 100]], { type: "text-box", boxWidth: 200, boxHeight: 80 });
    const deleted = glyph("del", 80, 100, 0, { deletedAt: "2026-10-23T10:00:00.000Z" });
    expect(segmentPage([hl, shape, box, deleted])).toEqual([]);
  });

  it("segments_5000_overlapping_strokes_under_1s", () => {
    // Dense shading / cross-outs: 5000 strokes piled into a 300 x 120 patch, plus a separate glyph.
    let seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    const strokes: Element[] = [];
    for (let i = 0; i < 5000; i++) strokes.push(glyph(`s${i}`, rnd() * 280, 100 + rnd() * 90, i * 2));
    strokes.push(glyph("far", 3000, 3000, 0));
    const start = performance.now();
    const regions = segmentPage(strokes);
    const elapsed = performance.now() - start;
    expect(regions).toHaveLength(2);
    expect(regions[0].elementIds).toHaveLength(5000);
    expect(elapsed).toBeLessThan(1000);
  });

  it("beyond_merge_reach_uses_gaps_and_adaptive_threshold", () => {
    const r = (x: number, y: number, w = 30, h = 30) => ({ bounds: { x, y, width: w, height: h }, baselineY: y + h });
    // dx gap 60 on the same row: 60*0.5 = 30 <= 40*1.3*bonus -> within reach.
    expect(beyondMergeReach(r(0, 0), r(90, 0))).toBe(false);
    // dx gap 300 -> 150 > reach.
    expect(beyondMergeReach(r(0, 0), r(330, 0))).toBe(true);
    // Vertical gap beyond lineYThreshold -> separate lines.
    expect(beyondMergeReach(r(0, 0), r(0, 30 + DEFAULT_SEGMENTATION.lineYThreshold + 1))).toBe(true);
  });
});
