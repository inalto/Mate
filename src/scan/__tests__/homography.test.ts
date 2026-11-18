import { describe, expect, it } from "vitest";
import { applyHomography, invertMat3, solveHomography } from "../homography";
import type { Mat3, Quad } from "../types";

const unit: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

function mul(a: Mat3, b: Mat3): number[] {
  const out: number[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
      out.push(s);
    }
  return out;
}

describe("solveHomography", () => {
  it("identity: maps a quad onto itself", () => {
    const h = solveHomography(unit, unit)!;
    expect(h).not.toBeNull();
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(h[i]).toBeCloseTo(v, 9));
  });

  it("translate and scale", () => {
    const dst: Quad = [
      { x: 10, y: 20 },
      { x: 14, y: 20 },
      { x: 14, y: 26 },
      { x: 10, y: 26 },
    ];
    const h = solveHomography(unit, dst)!;
    const p = applyHomography(h, { x: 0.5, y: 0.5 });
    expect(p.x).toBeCloseTo(12, 9);
    expect(p.y).toBeCloseTo(23, 9);
  });

  it("maps four arbitrary pairs within 1e-6", () => {
    const src: Quad = [
      { x: 3, y: 5 },
      { x: 210, y: -4 },
      { x: 190, y: 160 },
      { x: -8, y: 140 },
    ];
    const dst: Quad = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 200 },
      { x: 0, y: 200 },
    ];
    const h = solveHomography(src, dst)!;
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(h, src[i]);
      expect(Math.abs(p.x - dst[i].x)).toBeLessThan(1e-6);
      expect(Math.abs(p.y - dst[i].y)).toBeLessThan(1e-6);
    }
  });

  it("returns null when three source points are collinear", () => {
    const src: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
    ];
    expect(solveHomography(src, unit)).toBeNull();
  });
});

describe("invertMat3", () => {
  it("inverse times H is the identity", () => {
    const src: Quad = [
      { x: 3, y: 5 },
      { x: 210, y: -4 },
      { x: 190, y: 160 },
      { x: -8, y: 140 },
    ];
    const h = solveHomography(src, unit)!;
    const inv = invertMat3(h)!;
    const prod = mul(inv, h);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(prod[i]).toBeCloseTo(v, 9));
  });

  it("returns null for a singular matrix", () => {
    expect(invertMat3([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeNull();
  });
});
