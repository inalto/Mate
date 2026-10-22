import { describe, expect, it } from "vitest";
import type { Point } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";
import { SpatialIndex, elementBounds } from "../../tools/spatialIndex";
import { isScribbleGesture, scribbleHits } from "../scribble";

/** Points every `step` units along a polyline, `msPerUnit` apart in time. */
function trace(corners: Array<[number, number]>, msPerUnit: number, step = 3): Point[] {
  const out: Point[] = [];
  let t = 0;
  for (let i = 0; i + 1 < corners.length; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      out.push({ x: ax + ((bx - ax) * k) / n, y: ay + ((by - ay) * k) / n, pressure: 0.5, timestamp: t });
      t += (len / n) * msPerUnit;
    }
  }
  const [x, y] = corners[corners.length - 1];
  out.push({ x, y, pressure: 0.5, timestamp: t });
  return out;
}

/** A back-and-forth scribble whose passes criss-cross (each pass crosses the one before last). */
const crossingScribble = (): Array<[number, number]> => {
  const c: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) {
    const x = (i % 2 === 0 ? 0 : 80) + i * 2;
    const y = i % 2 === 0 ? (i % 4 === 0 ? 0 : 24) : i % 4 === 1 ? 20 : -2;
    c.push([x, y]);
  }
  return c;
};

/** A steep sawtooth drifting monotonically to the right (no self-crossings). */
const sawtooth = (): Array<[number, number]> => {
  const c: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) c.push([i * 6, i % 2 === 0 ? 0 : 50]);
  return c;
};

describe("isScribbleGesture", () => {
  it("zigzag_is_scribble", () => {
    // ~1 px/ms at zoom 1.
    expect(isScribbleGesture(trace(crossingScribble(), 1), 1, "standard").scribble).toBe(true);
    expect(isScribbleGesture(trace(sawtooth(), 1), 1, "standard").scribble).toBe(true);
    // A short sawtooth ("W") is handwriting: fewer than four teeth.
    expect(isScribbleGesture(trace(sawtooth().slice(0, 5), 1), 1, "standard").scribble).toBe(false);
    // Same gesture at zoom 2 in half the world size is the same on screen.
    const half = trace(crossingScribble().map(([x, y]) => [x / 2, y / 2] as [number, number]), 2);
    const r = isScribbleGesture(half, 2, "standard");
    expect(r.scribble).toBe(true);
    expect(r.bbox.width).toBeCloseTo(47, 0);
  });

  it("straight_stroke_is_not_scribble", () => {
    expect(isScribbleGesture(trace([[0, 0], [300, 20]], 1), 1, "standard").scribble).toBe(false);
    // A gentle wave or a loop is handwriting, not a scribble.
    const wave: Array<[number, number]> = [];
    for (let i = 0; i <= 40; i++) wave.push([i * 8, 20 * Math.sin(i / 4)]);
    expect(isScribbleGesture(trace(wave, 1), 1, "standard").scribble).toBe(false);
  });

  it("slow_stroke_is_not_scribble", () => {
    // Same zigzag, drawn at ~0.29 px/ms (under the 0.3 px/ms gate, well inside 3 s).
    expect(isScribbleGesture(trace(crossingScribble(), 3.5), 1, "standard").scribble).toBe(false);
    // Too long in time (> 3 s) is never a scribble either.
    expect(isScribbleGesture(trace(crossingScribble(), 20), 1, "more").scribble).toBe(false);
  });

  it("sensitivity_changes_the_speed_gate", () => {
    // 0.35 px/ms: below "less" (0.4), above "standard" (0.3).
    const pts = trace(crossingScribble(), 1 / 0.35);
    expect(isScribbleGesture(pts, 1, "standard").scribble).toBe(true);
    expect(isScribbleGesture(pts, 1, "less").scribble).toBe(false);
  });
});

describe("scribbleHits", () => {
  it("erases_strokes_and_shapes_it_overlaps_but_never_boxes", () => {
    const under = el("under", [[10, 10], [70, 10]]);
    const far = el("far", [[500, 500], [600, 500]]);
    const box: typeof under = { ...el("box", [[0, 0]]), type: "text-box", boxWidth: 100, boxHeight: 40 };
    const els = new Map([under, far, box].map((e) => [e.id, e]));
    const index = new SpatialIndex();
    for (const e of els.values()) index.insert(e.id, elementBounds(e));
    const hits = scribbleHits(els, index, trace(crossingScribble(), 1), 1);
    expect(hits).toEqual(["under"]);
  });
});
