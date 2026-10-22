import { describe, expect, it } from "vitest";
import type { Point } from "../../model/types";
import { recognizeShape, SNAP_MIN_SCORE } from "../recognize";

/** Deterministic PRNG (mulberry32) so the synthetic strokes are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pts = (xy: Array<[number, number]>, jitter = 0, seed = 1): Point[] => {
  const r = rng(seed);
  return xy.map(([x, y], i) => ({
    x: x + (r() - 0.5) * 2 * jitter,
    y: y + (r() - 0.5) * 2 * jitter,
    pressure: 0.5,
    timestamp: i * 8,
  }));
};

/** Points every `step` units along a polyline. */
function trace(corners: Array<[number, number]>, step = 4): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(corners[corners.length - 1]);
  return out;
}

function arc(cx: number, cy: number, rx: number, ry: number, fromDeg: number, toDeg: number, n = 72): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / n) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

describe("recognizeShape", () => {
  it("recognizes_rectangle", () => {
    // Starts mid-way along the top edge and stops just short of the start.
    const r = recognizeShape(
      pts(trace([[150, 50], [250, 50], [250, 170], [50, 170], [50, 50], [140, 50]]), 1.5),
    );
    expect(r).not.toBeNull();
    expect(r!.type).toBe("rectangle");
    expect(r!.score).toBeGreaterThan(SNAP_MIN_SCORE);
    expect(Math.abs(r!.rotation)).toBeLessThan(0.1);
    expect(r!.rect.x).toBeCloseTo(50, -1);
    expect(r!.rect.y).toBeCloseTo(50, -1);
    expect(r!.rect.width).toBeCloseTo(200, -1);
    expect(r!.rect.height).toBeCloseTo(120, -1);
  });

  it("recognizes_rotated_rectangle_triangle_and_ellipse", () => {
    const rot = (deg: number, xy: Array<[number, number]>): Array<[number, number]> => {
      const a = (deg * Math.PI) / 180;
      return xy.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);
    };
    const rr = recognizeShape(pts(rot(20, trace([[0, 0], [160, 0], [160, 90], [0, 90], [0, 4]])), 1));
    expect(rr?.type).toBe("rectangle");
    expect(Math.abs(Math.abs(rr!.rotation) - (20 * Math.PI) / 180)).toBeLessThan(0.08);

    const tri = recognizeShape(pts(trace([[100, 0], [200, 160], [0, 160], [96, 6]]), 1.5, 3));
    expect(tri?.type).toBe("triangle");

    const ell = recognizeShape(pts(arc(0, 0, 150, 60, 0, 345), 1.5, 4));
    expect(ell?.type).toBe("ellipse");
  });

  it("recognizes_circle", () => {
    const r = recognizeShape(pts(arc(200, 200, 80, 80, 10, 355), 2, 2));
    expect(r).not.toBeNull();
    expect(r!.type).toBe("circle");
    expect(r!.score).toBeGreaterThan(SNAP_MIN_SCORE);
    expect(r!.rect.width).toBeCloseTo(160, -1);
    expect(r!.rect.height).toBeCloseTo(r!.rect.width, 5);
    expect(r!.rect.x + r!.rect.width / 2).toBeCloseTo(200, -1);
    expect(r!.rect.y + r!.rect.height / 2).toBeCloseTo(200, -1);
  });

  it("recognizes_line_and_arrow", () => {
    const line = recognizeShape(pts(trace([[0, 0], [200, 50]]), 1, 5));
    expect(line?.type).toBe("line");
    expect(Math.abs(line!.rect.x)).toBeLessThan(2);
    expect(Math.abs(line!.rect.y)).toBeLessThan(2);
    expect(line!.rect.width).toBeCloseTo(200, -1);
    expect(line!.rect.height).toBeCloseTo(50, -1);
    expect(line!.rotation).toBe(0);

    // Shaft, then a chevron at the far end drawn without lifting: B→W1→B→W2.
    const arrow = recognizeShape(pts(trace([[0, 0], [200, 0], [172, -22], [200, 0], [172, 22]]), 1, 6));
    expect(arrow?.type).toBe("arrow");
    // The arrow points from the tail (0,0) to the tip (200,0).
    expect(arrow!.rect.x).toBeCloseTo(0, -1);
    expect(arrow!.rect.x + arrow!.rect.width).toBeCloseTo(200, -1);
    expect(Math.abs(arrow!.rect.height)).toBeLessThan(10);

    // Chevron drawn first, then the shaft: tip at the start.
    const rev = recognizeShape(pts(trace([[28, -22], [0, 0], [28, 22], [0, 0], [200, 0]]), 1, 7));
    expect(rev?.type).toBe("arrow");
    expect(rev!.rect.x).toBeCloseTo(200, -1);
    expect(rev!.rect.x + rev!.rect.width).toBeCloseTo(0, -1);
  });

  it("rejects_random_scrawl", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed * 7919);
      const xy: Array<[number, number]> = [[0, 0]];
      let a = 0;
      for (let i = 0; i < 80; i++) {
        a += (r() - 0.5) * 2.4;
        const [x, y] = xy[xy.length - 1];
        xy.push([x + 12 * Math.cos(a), y + 12 * Math.sin(a)]);
      }
      expect(recognizeShape(pts(xy, 0.5, seed)), `seed ${seed}`).toBeNull();
    }
  });

  it("rejects_too_small_or_too_few_points", () => {
    expect(recognizeShape(pts([[0, 0], [5, 0], [5, 5]]))).toBeNull();
    expect(recognizeShape(pts(trace([[0, 0], [10, 0], [10, 10], [0, 10], [0, 1]], 1)))).toBeNull();
  });
});
