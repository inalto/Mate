import { describe, expect, it, vi } from "vitest";
import type { Camera } from "../../canvas/camera";
import type { Point } from "../../model/types";
import { drawLengthReadout, guideFor, guidedLength, projectOnLine, snapGuidedLength } from "../guide";
import { edgeLine, type Line, type RulerPose } from "../pose";

const cam: Camera = { x: 30, y: -20, z: 2 };
const flat: RulerPose = { x: 100, y: 200, angle: 0 };
const tilted: RulerPose = { x: 100, y: 200, angle: 30 };
/** World point `px` screen px from the centreline of `pose` (positive = edge 1 side), `along` units along it. */
const at = (pose: RulerPose, c: Camera, px: number, along = 0) => {
  const a = (pose.angle * Math.PI) / 180;
  const d = { x: Math.cos(a), y: -Math.sin(a) };
  const n = { x: -Math.sin(a), y: -Math.cos(a) };
  return { x: pose.x + d.x * along + (n.x * px) / c.z, y: pose.y + d.y * along + (n.y * px) / c.z };
};
const on = (pose: RulerPose) => ({ on: true, pose });
const horizontal: Line = { a: { x: 0, y: 50 }, dir: { x: 1, y: 0 } };
const pt = (x: number, y: number, pressure = 0.5, timestamp = 0): Point => ({ x, y, pressure, timestamp });
/** Points from x = 0 to x = `to` on the horizontal line, 1 unit apart. */
const run = (to: number): Point[] => {
  const n = Math.abs(to);
  return Array.from({ length: n + 1 }, (_, i) => pt(Math.sign(to) * i, 50, 0.3 + i / 100, i));
};

describe("guideFor", () => {
  it("is null with the ruler off or without a pose", () => {
    expect(guideFor({ on: false, pose: flat }, cam, at(flat, cam, 65))).toBeNull();
    expect(guideFor({ on: true, pose: null }, cam, at(flat, cam, 65))).toBeNull();
  });

  it("is null on the body and 20 px outside an edge", () => {
    expect(guideFor(on(flat), cam, at(flat, cam, 0))).toBeNull();
    expect(guideFor(on(flat), cam, at(flat, cam, 40))).toBeNull();
    expect(guideFor(on(flat), cam, at(flat, cam, 75))).toBeNull();
    expect(guideFor(on(flat), cam, at(flat, cam, -75))).toBeNull();
  });

  it("returns the nearer edge's line 10 px outside it and 5 px inside it", () => {
    for (const pose of [flat, tilted]) {
      expect(guideFor(on(pose), cam, at(pose, cam, 65, 30))).toEqual(edgeLine(pose, cam, 1));
      expect(guideFor(on(pose), cam, at(pose, cam, 50, -30))).toEqual(edgeLine(pose, cam, 1));
      expect(guideFor(on(pose), cam, at(pose, cam, -65))).toEqual(edgeLine(pose, cam, -1));
      expect(guideFor(on(pose), cam, at(pose, cam, -50))).toEqual(edgeLine(pose, cam, -1));
    }
  });
});

describe("projectOnLine", () => {
  it("moves the point onto the line and keeps pressure and timestamp", () => {
    const q = projectOnLine({ x: 12, y: 80, pressure: 0.7, timestamp: 42, tiltX: 5 }, horizontal);
    expect(q).toEqual({ x: 12, y: 50, pressure: 0.7, timestamp: 42, tiltX: 5 });
    const line = edgeLine(tilted, cam, -1);
    const r = projectOnLine(pt(300, 10), line);
    const off = (r.x - line.a.x) * -line.dir.y + (r.y - line.a.y) * line.dir.x;
    expect(Math.abs(off)).toBeLessThan(1e-9);
  });
});

describe("guidedLength", () => {
  it("is signed, first point to last, along the line", () => {
    expect(guidedLength(run(23), horizontal)).toBe(23);
    expect(guidedLength(run(-7), horizontal)).toBe(-7);
    expect(guidedLength([pt(1, 50)], horizontal)).toBe(0);
  });
});

describe("snapGuidedLength", () => {
  const length = (pts: Point[]) => guidedLength(pts, horizontal);

  it("rounds 23 down to 20 and 27 up to 30", () => {
    const down = snapGuidedLength(run(23), horizontal, 10);
    expect(length(down)).toBeCloseTo(20, 9);
    expect(down.every((p) => p.x <= 20 + 1e-9)).toBe(true);
    expect(down[down.length - 1].pressure).toBe(run(23)[23].pressure);
    expect(length(snapGuidedLength(run(27), horizontal, 10))).toBeCloseTo(30, 9);
  });

  it("never snaps to zero: a 3-unit stroke becomes one step", () => {
    expect(length(snapGuidedLength(run(3), horizontal, 10))).toBeCloseTo(10, 9);
  });

  it("keeps the direction of a stroke drawn backwards", () => {
    const back = snapGuidedLength(run(-23), horizontal, 10);
    expect(length(back)).toBeCloseTo(-20, 9);
    expect(length(snapGuidedLength(run(-3), horizontal, 10))).toBeCloseTo(-10, 9);
  });

  it("keeps the points on the line", () => {
    const line = edgeLine(tilted, cam, 1);
    const pts = Array.from({ length: 24 }, (_, i) => ({ ...line.a, x: line.a.x + line.dir.x * i, y: line.a.y + line.dir.y * i, pressure: 0.5, timestamp: i }));
    const out = snapGuidedLength(pts, line, 10);
    expect(guidedLength(out, line)).toBeCloseTo(20, 9);
    for (const p of out) expect(Math.abs((p.x - line.a.x) * -line.dir.y + (p.y - line.a.y) * line.dir.x)).toBeLessThan(1e-9);
  });

  it("leaves the points alone with step 0", () => {
    const pts = run(23);
    expect(snapGuidedLength(pts, horizontal, 0)).toBe(pts);
  });
});

describe("drawLengthReadout", () => {
  it("draws the text centred on the point given, on a plate", () => {
    const calls: string[] = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      measureText: (s: string) => ({ width: s.length * 7 }),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      fill: () => calls.push("fill"),
      fillText: (t: string, x: number, y: number) => calls.push(`text ${t} ${x} ${y}`),
    } as unknown as CanvasRenderingContext2D;
    drawLengthReadout(ctx, { x: 40, y: 60 }, "12.5 cm", 2);
    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(calls).toEqual(["fill", "text 12.5 cm 40 60"]);
  });
});
