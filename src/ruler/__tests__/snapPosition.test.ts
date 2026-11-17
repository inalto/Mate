import { describe, expect, it } from "vitest";
import type { Rect } from "../../tools/spatialIndex";
import { snapRulerPosition, type PositionTargets } from "../snapPosition";

const camera = { x: 0, y: 0, z: 1 };
const viewport = { width: 800, height: 600 };
const none = () => null;
/** A background with a single horizontal line at y = 400 (and no vertical ones). */
const lineAt400: PositionTargets["lineNear"] = (axis) => (axis === "y" ? 400 : null);
const targets = (lineNear: PositionTargets["lineNear"], rects: Rect[] = []): PositionTargets => ({ lineNear, rects, viewport });

describe("snapRulerPosition", () => {
  // At 0° the edges are 55 px above (edge 1) and below (edge −1) the centreline.
  it("moves a horizontal ruler so its lower edge lies on a line 5 px away", () => {
    const r = snapRulerPosition({ x: 400, y: 340, angle: 0 }, camera, targets(lineAt400), 8);
    expect(r.pose).toEqual({ x: 400, y: 345, angle: 0 });
    expect(r.guide).toEqual({ axis: "y", at: 400, from: 0, to: 800 });
  });

  it("spans the visible width of the view in page units for a background line", () => {
    const cam = { x: -100, y: 0, z: 2 };
    // Edge −1 at y + 27.5; 2 px on screen from 400 is 1 page unit.
    const r = snapRulerPosition({ x: 400, y: 371.5, angle: 0 }, cam, targets(lineAt400), 8);
    expect(r.pose.y).toBeCloseTo(372.5, 9);
    expect(r.guide).toEqual({ axis: "y", at: 400, from: 50, to: 450 });
  });

  it("does not move when the nearest line is 12 px away", () => {
    const pose = { x: 400, y: 333, angle: 0 };
    const r = snapRulerPosition(pose, camera, targets(lineAt400), 8);
    expect(r.pose).toEqual(pose);
    expect(r.guide).toBeNull();
  });

  it("scales the threshold with the zoom", () => {
    // 8 screen px at zoom 2 are 4 page units: 5 units away is too far.
    const pose = { x: 400, y: 367.5, angle: 0 };
    expect(snapRulerPosition(pose, { x: 0, y: 0, z: 2 }, targets(lineAt400), 8).guide).toBeNull();
  });

  it("prefers an element's centre over a line that is further", () => {
    const rect = { x: 100, y: 390, width: 200, height: 12 };
    const r = snapRulerPosition({ x: 400, y: 340, angle: 0 }, camera, targets(lineAt400, [rect]), 8);
    expect(r.pose).toEqual({ x: 400, y: 341, angle: 0 });
    expect(r.guide).toEqual({ axis: "y", at: 396, from: 100, to: 300 });
  });

  it("prefers an element over a background line at the same distance", () => {
    const rect = { x: 100, y: 400, width: 50, height: 30 };
    const r = snapRulerPosition({ x: 400, y: 340, angle: 0 }, camera, targets(lineAt400, [rect]), 8);
    expect(r.pose.y).toBe(345);
    expect(r.guide).toEqual({ axis: "y", at: 400, from: 100, to: 150 });
  });

  it("snaps the upper edge too, and treats 180° as horizontal", () => {
    const lineAt200: PositionTargets["lineNear"] = (axis) => (axis === "y" ? 200 : null);
    const r = snapRulerPosition({ x: 400, y: 258, angle: 180 }, camera, targets(lineAt200), 8);
    // At 180° edge 1 is below: the edge at 258 − 55 = 203 is edge −1.
    expect(r.pose.y).toBeCloseTo(255, 9);
    expect(r.pose.angle).toBe(180);
    expect(r.guide?.at).toBe(200);
    const nearly = snapRulerPosition({ x: 400, y: 258, angle: 180 - 1e-9 }, camera, targets(lineAt200), 8);
    expect(nearly.guide?.at).toBe(200);
  });

  it("never moves a ruler at 30°", () => {
    const pose = { x: 400, y: 340, angle: 30 };
    const rect = { x: 0, y: 0, width: 800, height: 600 };
    const r = snapRulerPosition(pose, camera, targets(() => 400, [rect]), 8);
    expect(r.pose).toEqual(pose);
    expect(r.guide).toBeNull();
  });

  it("snaps an edge of a vertical ruler to an element's left side", () => {
    // At 90° edge 1 is at x − 55 and edge −1 at x + 55.
    const rect = { x: 500, y: 100, width: 80, height: 60 };
    const r = snapRulerPosition({ x: 440, y: 300, angle: 90 }, camera, targets(none, [rect]), 8);
    expect(r.pose.x).toBeCloseTo(445, 9);
    expect(r.pose.y).toBeCloseTo(300, 9);
    expect(r.pose.angle).toBe(90);
    expect(r.guide?.axis).toBe("x");
    expect(r.guide?.at).toBe(500);
    expect(r.guide?.from).toBe(100);
    expect(r.guide?.to).toBe(160);
  });

  it("asks the background for vertical lines when the ruler is vertical", () => {
    const asked: string[] = [];
    const lineNear: PositionTargets["lineNear"] = (axis, v) => {
      asked.push(axis);
      return axis === "x" ? Math.round(v / 100) * 100 : null;
    };
    const r = snapRulerPosition({ x: 252, y: 300, angle: 270 }, camera, targets(lineNear), 8);
    expect(asked.every((a) => a === "x")).toBe(true);
    expect(r.pose.x).toBeCloseTo(255, 9);
    expect(r.guide).toEqual({ axis: "x", at: 200, from: 0, to: 600 });
  });
});
