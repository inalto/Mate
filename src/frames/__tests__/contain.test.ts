import { describe, expect, it } from "vitest";
import type { Element } from "../../model/types";
import { hitTest } from "../../canvas/toolInteractions";
import { lassoSelect } from "../../tools/lasso";
import { SpatialIndex } from "../../tools/spatialIndex";
import { compareZ, renderOrder, reorder } from "../../tools/zorder";
import "../../renderers/builtins";
import { frameChildren, frameOf, frameTitleRect, framesInOrder, nextFrameTitle, presetFrameRect, withFrameChildren } from "../contain";

const STAMP = "2026-01-01T00:00:00.000Z";

const frame = (id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): Element => ({
  id,
  pageId: "pg",
  type: "frame",
  points: [{ x, y, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: 1,
  isHighlighter: false,
  boxWidth: w,
  boxHeight: h,
  content: { title: id, order: 0, ...extra },
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
});

const stroke = (id: string, x: number, y: number, extra: Partial<Element> = {}): Element => ({
  id,
  pageId: "pg",
  type: "stroke",
  points: [
    { x, y, pressure: 0.5, timestamp: 0 },
    { x: x + 10, y: y + 10, pressure: 0.5, timestamp: 1 },
  ],
  color: "#000000",
  width: 2,
  isHighlighter: false,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
  ...extra,
});

describe("frame containment", () => {
  it("frameOf_picks_the_smallest_containing_frame", () => {
    const big = frame("big", 0, 0, 1000, 1000);
    const small = frame("small", 100, 100, 200, 200);
    const frames = [big, small];
    expect(frameOf(stroke("in-small", 150, 150), frames)?.id).toBe("small");
    expect(frameOf(stroke("in-big", 600, 600), frames)?.id).toBe("big");
    expect(frameOf(stroke("outside", 2000, 2000), frames)).toBeNull();
  });

  it("nested_frames_are_children_of_the_outer_frame", () => {
    const outer = frame("outer", 0, 0, 1000, 1000);
    const inner = frame("inner", 100, 100, 300, 300);
    const a = stroke("a", 150, 150); // in inner
    const b = stroke("b", 700, 700); // in outer only
    const c = stroke("c", 3000, 0); // nowhere
    const all = [outer, inner, a, b, c];
    expect(frameOf(inner, [outer, inner])?.id).toBe("outer");
    expect(frameOf(outer, [outer, inner])).toBeNull();
    expect(frameChildren(outer, all).map((e) => e.id).sort()).toEqual(["a", "b", "inner"]);
    expect(frameChildren(inner, all).map((e) => e.id)).toEqual(["a"]);
    expect(withFrameChildren([outer], all).map((e) => e.id)).toEqual(["outer", "inner", "a", "b"]);
  });

  it("an_element_belongs_by_its_bounds_centre", () => {
    const f = frame("f", 0, 0, 100, 100);
    // Sticks out to the right, but its centre (95, 55) is inside.
    const s = stroke("s", 90, 50);
    expect(frameOf(s, [f])?.id).toBe("f");
    expect(frameOf(stroke("t", 120, 50), [f])).toBeNull();
  });

  it("equal_frames_keep_the_children_nearest_their_centre", () => {
    const a = frame("a", 0, 0, 200, 200);
    const b = frame("b", 20, 20, 200, 200);
    expect(frameOf(stroke("near-a", 40, 40), [a, b])?.id).toBe("a");
    expect(frameOf(stroke("near-b", 160, 160), [a, b])?.id).toBe("b");
  });

  it("next_title_and_presentation_order", () => {
    expect(nextFrameTitle([stroke("s", 0, 0)])).toBe("Frame 1");
    const f1 = frame("f1", 0, 0, 10, 10, { order: 2 });
    const f2 = { ...frame("f2", 0, 0, 10, 10, { order: 1 }), createdAt: "2026-01-02T00:00:00.000Z" };
    const f3 = frame("f3", 0, 0, 10, 10, { order: 1 });
    expect(nextFrameTitle([f1, f2])).toBe("Frame 3");
    expect(framesInOrder([f1, f2, f3]).map((f) => f.id)).toEqual(["f3", "f2", "f1"]);
  });

  it("presets_are_nudged_when_a_same_size_frame_is_there", () => {
    const r = presetFrameRect([], { x: 640, y: 360 }, 1280, 720);
    expect(r).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    const r2 = presetFrameRect([frame("f", 0, 0, 1280, 720)], { x: 640, y: 360 }, 1280, 720);
    expect(r2).toEqual({ x: 24, y: 24, width: 1280, height: 720 });
    // Another size does not count.
    expect(presetFrameRect([frame("g", 0, 0, 800, 800)], { x: 640, y: 360 }, 1280, 720).x).toBe(0);
  });

  it("title_rect_sits_above_or_inside_and_hides_when_narrow", () => {
    const f = frame("Title", 100, 100, 400, 300);
    const above = frameTitleRect(f, 1);
    expect(above.y + above.height).toBeLessThan(100);
    expect(above.x).toBe(100);
    const inside = frameTitleRect(f, 1, true);
    expect(inside.y).toBeGreaterThan(100);
    // 400 units at zoom 0.1 is 40 screen px: no title.
    expect(frameTitleRect(f, 0.1).width).toBe(0);
  });
});

describe("frame z-order", () => {
  const pdf: Element = { ...stroke("pdf", 0, 0), type: "image", imageUrl: "a", content: { pdfSourceKey: "k", zIndex: -1_000_000 } };

  it("sorts_pdf_then_frames_then_the_rest", () => {
    const f = frame("f", 0, 0, 100, 100, { zIndex: 50 });
    const s = stroke("s", 0, 0, { content: { zIndex: -5 } });
    expect(renderOrder([s, f, pdf]).map((e) => e.id)).toEqual(["pdf", "f", "s"]);
    expect(compareZ(f, s)).toBeLessThan(0);
  });

  it("front_and_back_reorder_frames_among_frames_only", () => {
    const f1 = frame("f1", 0, 0, 100, 100, { zIndex: 1 });
    const f2 = frame("f2", 0, 0, 100, 100, { zIndex: 2 });
    const s = stroke("s", 0, 0, { content: { zIndex: 10 } });
    const changed = reorder([f1, f2, s], new Set(["f1"]), "front");
    expect(changed.map((e) => e.id)).toEqual(["f1"]);
    const all = [changed[0], f2, s];
    expect(renderOrder(all).map((e) => e.id)).toEqual(["f2", "f1", "s"]);
    // A stroke sent to the back stays above every frame.
    const back = reorder(all, new Set(["s"]), "back");
    expect(renderOrder([changed[0], f2, ...back]).map((e) => e.id)).toEqual(["f2", "f1", "s"]);
  });
});

describe("frame hit test and lasso", () => {
  const f = frame("f", 0, 0, 400, 300);
  const elements = new Map([[f.id, f]]);
  const index = SpatialIndex.from(elements.values());

  it("hit_test_ignores_the_interior", () => {
    const tol = 8; // zoom 1
    expect(hitTest(index, elements, { x: 200, y: 150 }, tol)).toBeNull();
    expect(hitTest(index, elements, { x: 3, y: 150 }, tol)).toBe("f");
    expect(hitTest(index, elements, { x: 200, y: 297 }, tol)).toBe("f");
    // On the title above the top-left corner.
    expect(hitTest(index, elements, { x: 6, y: -12 }, tol)).toBe("f");
  });

  it("children_inside_win_over_the_frame_border", () => {
    const s = stroke("s", 0, 100);
    const els = new Map<string, Element>([
      [f.id, f],
      [s.id, s],
    ]);
    expect(hitTest(SpatialIndex.from(els.values()), els, { x: 2, y: 102 }, 8)).toBe("s");
  });

  it("lasso_picks_a_frame_only_when_it_encloses_it", () => {
    const around = [
      { x: -20, y: -20 },
      { x: 420, y: -20 },
      { x: 420, y: 320 },
      { x: -20, y: 320 },
    ];
    expect(lassoSelect(elements, index, around)).toEqual(["f"]);
    const half = [
      { x: -20, y: -20 },
      { x: 250, y: -20 },
      { x: 250, y: 320 },
      { x: -20, y: 320 },
    ];
    expect(lassoSelect(elements, index, half)).toEqual([]);
    // An anticlockwise ("touch") loop crossing it does not pick it either.
    expect(lassoSelect(elements, index, [...half].reverse(), "touch")).toEqual([]);
  });
});
