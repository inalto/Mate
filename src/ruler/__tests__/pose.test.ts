import { describe, expect, it } from "vitest";
import { screenToWorld, worldToScreen, type Camera, type Vec2 } from "../../canvas/camera";
import {
  alongUnits,
  angleStep,
  bodySpan,
  defaultPose,
  edgeLine,
  normalizeAngle,
  offsetPx,
  readoutAngle,
  rotatePose,
  rulerDir,
  rulerShown,
  snapRulerAngle,
  translatePose,
  visibleSpan,
  withReadout,
  zoneAt,
  type RulerPose,
} from "../pose";

const VIEW = { width: 800, height: 600 };
const cam = (z: number): Camera => ({ x: 30, y: -20, z });
const flat: RulerPose = { x: 100, y: 200, angle: 0 };
/** World point `px` screen px from the centreline of `pose` (positive = edge 1 side). */
const at = (pose: RulerPose, c: Camera, px: number, along = 0): Vec2 => {
  const a = (pose.angle * Math.PI) / 180;
  const d = { x: Math.cos(a), y: -Math.sin(a) };
  const n = { x: -Math.sin(a), y: -Math.cos(a) };
  return { x: pose.x + d.x * along + (n.x * px) / c.z, y: pose.y + d.y * along + (n.y * px) / c.z };
};

describe("angles", () => {
  it("normalizes into [0, 360)", () => {
    expect(normalizeAngle(-10)).toBe(350);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(725)).toBe(5);
  });

  it("reads out modulo 180", () => {
    expect(readoutAngle({ ...flat, angle: 190 })).toBe(10);
    expect(readoutAngle({ ...flat, angle: 0 })).toBe(0);
    expect(readoutAngle({ ...flat, angle: 179 })).toBe(179);
  });

  it("snaps within the magnet only", () => {
    expect(snapRulerAngle(16.9, 15)).toBe(15);
    expect(snapRulerAngle(17.1, 15)).toBe(17.1);
    expect(snapRulerAngle(44.4, 1)).toBe(44);
    expect(snapRulerAngle(0.4, 1)).toBe(0);
    expect(snapRulerAngle(33.3, 0)).toBe(33.3);
    expect(snapRulerAngle(359, 15)).toBe(0);
  });

  it("turns by the snap step, 1° when the snap is off, 0.1° when fine", () => {
    expect(angleStep(15, false)).toBe(15);
    expect(angleStep(0, false)).toBe(1);
    expect(angleStep(15, true)).toBe(0.1);
    expect(angleStep(0, true)).toBe(0.1);
  });

  it("never snaps by more than half a step", () => {
    expect(snapRulerAngle(1.4, 1)).toBe(1); // magnet is 0.5 here, so every value snaps
    expect(snapRulerAngle(2.4, 5)).toBe(2.4); // magnet is 2
    expect(snapRulerAngle(3.1, 5)).toBe(5);
  });
});

describe("direction and offset", () => {
  it("points up the screen at 90 degrees", () => {
    const d = rulerDir({ ...flat, angle: 90 });
    expect(d.x).toBeCloseTo(0);
    expect(d.y).toBeCloseTo(-1);
    expect(rulerDir(flat)).toEqual({ x: 1, y: -0 });
  });

  it("doubles the offset in px when the zoom doubles", () => {
    const w = { x: 140, y: 150 };
    const a = offsetPx(flat, cam(1), w);
    const b = offsetPx(flat, cam(2), w);
    expect(a).toBeCloseTo(50);
    expect(b).toBeCloseTo(2 * a);
  });

  it("is positive on the left-hand (screen up) side", () => {
    expect(offsetPx(flat, cam(1), { x: 100, y: 190 })).toBeCloseTo(10);
    expect(offsetPx(flat, cam(1), { x: 100, y: 210 })).toBeCloseTo(-10);
    const turned = { ...flat, angle: 90 };
    expect(offsetPx(turned, cam(1), { x: 90, y: 200 })).toBeCloseTo(10);
  });

  it("measures along the ruler in page units", () => {
    expect(alongUnits(flat, { x: 130, y: 500 })).toBeCloseTo(30);
    expect(alongUnits({ ...flat, angle: 90 }, { x: 100, y: 170 })).toBeCloseTo(30);
  });
});

describe("zones", () => {
  for (const z of [0.5, 1, 3]) {
    it(`classifies at zoom ${z}`, () => {
      const c = cam(z);
      for (const angle of [0, 33, 135]) {
        const p = { ...flat, angle };
        expect(zoneAt(p, c, at(p, c, 0))).toBe("body");
        expect(zoneAt(p, c, at(p, c, 40))).toBe("body");
        expect(zoneAt(p, c, at(p, c, 50))).toBe(1);
        expect(zoneAt(p, c, at(p, c, 70))).toBe(1);
        expect(zoneAt(p, c, at(p, c, 72))).toBeNull();
        expect(zoneAt(p, c, at(p, c, -50))).toBe(-1);
        expect(zoneAt(p, c, at(p, c, -70))).toBe(-1);
        expect(zoneAt(p, c, at(p, c, -72))).toBeNull();
      }
    });
  }
});

describe("edgeLine", () => {
  for (const z of [0.5, 1, 3]) {
    it(`lies 55 screen px from the centreline at zoom ${z}`, () => {
      const c = cam(z);
      const p = { ...flat, angle: 37 };
      for (const side of [1, -1] as const) {
        const e = edgeLine(p, c, side);
        const dir = rulerDir(p);
        expect(e.dir.x).toBeCloseTo(dir.x);
        expect(e.dir.y).toBeCloseTo(dir.y);
        expect(offsetPx(p, c, e.a)).toBeCloseTo(side * 55);
        // A second point along the edge keeps the same offset (parallel).
        const b = { x: e.a.x + e.dir.x * 300, y: e.a.y + e.dir.y * 300 };
        expect(offsetPx(p, c, b)).toBeCloseTo(side * 55);
      }
    });
  }
});

describe("visibleSpan", () => {
  it("spans the pane width at its middle height for the default pose", () => {
    const c = cam(1.5);
    const span = visibleSpan(defaultPose(c, VIEW), c, VIEW)!;
    expect(span).not.toBeNull();
    expect(span[0].x).toBeCloseTo(0);
    expect(span[1].x).toBeCloseTo(800);
    expect(span[0].y).toBeCloseTo(300);
    expect(span[1].y).toBeCloseTo(300);
  });

  it("is null when the line misses the pane", () => {
    const c = cam(1);
    const p = translatePose(defaultPose(c, VIEW), 0, -5000);
    expect(visibleSpan(p, c, VIEW)).toBeNull();
    expect(visibleSpan(defaultPose(c, VIEW), c, { width: 0, height: 0 })).toBeNull();
  });

  it("orders the crossings along the direction", () => {
    const c = cam(1);
    const p = { ...defaultPose(c, VIEW), angle: 180 };
    const span = visibleSpan(p, c, VIEW)!;
    // Direction points left, so the first point is the one further right.
    expect(span[0].x).toBeCloseTo(800);
    expect(span[1].x).toBeCloseTo(0);
  });

  it("clips a diagonal against the rectangle", () => {
    const c: Camera = { x: 0, y: 0, z: 1 };
    const span = visibleSpan({ x: 400, y: 300, angle: 45 }, c, VIEW)!;
    // Direction (1, -1) in screen: leaves the top at x = 700, enters the bottom at x = 100.
    expect(span[0].x).toBeCloseTo(100);
    expect(span[0].y).toBeCloseTo(600);
    expect(span[1].x).toBeCloseTo(700);
    expect(span[1].y).toBeCloseTo(0);
  });
});

describe("bodySpan and rulerShown", () => {
  const c: Camera = { x: 0, y: 0, z: 1 };
  it("clips the centreline against the pane grown by half the ruler's width", () => {
    const span = bodySpan({ x: 400, y: 300, angle: 0 }, c, VIEW)!;
    expect(span[0]).toEqual({ x: -55, y: 300 });
    expect(span[1]).toEqual({ x: 855, y: 300 });
  });

  it("is there while part of the body can show, though the centreline is off the pane", () => {
    for (const y of [-20, -54, 620, 654]) {
      const p = { x: 400, y, angle: 0 };
      expect(visibleSpan(p, c, VIEW)).toBeNull();
      expect(bodySpan(p, c, VIEW)).not.toBeNull();
      expect(rulerShown(p, c, VIEW)).toBe(true);
    }
    for (const y of [-56, -80, 656, 5000]) {
      expect(bodySpan({ x: 400, y, angle: 0 }, c, VIEW)).toBeNull();
      expect(rulerShown({ x: 400, y, angle: 0 }, c, VIEW)).toBe(false);
    }
    expect(rulerShown({ x: 840, y: 300, angle: 90 }, c, VIEW)).toBe(true);
    expect(rulerShown({ x: 860, y: 300, angle: 90 }, c, VIEW)).toBe(false);
    expect(rulerShown({ x: 400, y: 300, angle: 0 }, c, { width: 0, height: 0 })).toBe(false);
  });
});

describe("defaultPose", () => {
  it("is horizontal with the anchor at the pane centre", () => {
    const c = cam(2);
    const p = defaultPose(c, VIEW);
    expect(p.angle).toBe(0);
    const s = worldToScreen(c, p);
    expect(s.x).toBeCloseTo(400);
    expect(s.y).toBeCloseTo(300);
    expect(screenToWorld(c, { x: 400, y: 300 })).toEqual({ x: p.x, y: p.y });
  });
});

describe("moving", () => {
  it("translates the anchor", () => {
    expect(translatePose({ x: 1, y: 2, angle: 30 }, 5, -3)).toEqual({ x: 6, y: -1, angle: 30 });
  });

  it("rotates about the anchor without moving it", () => {
    const r = rotatePose({ x: 10, y: 20, angle: 30 }, { x: 10, y: 20 }, 45);
    expect(r.x).toBeCloseTo(10);
    expect(r.y).toBeCloseTo(20);
    expect(r.angle).toBeCloseTo(75);
  });

  it("rotates about another point on a circle, counter-clockwise as seen", () => {
    const r = rotatePose({ x: 110, y: 0, angle: 0 }, { x: 10, y: 0 }, 90);
    // The anchor was 100 right of the pivot; a quarter turn CCW puts it 100 above (y negative).
    expect(r.x).toBeCloseTo(10);
    expect(r.y).toBeCloseTo(-100);
    expect(r.angle).toBeCloseTo(90);
    const r2 = rotatePose({ x: 50, y: 70, angle: 350 }, { x: 0, y: 0 }, 30);
    expect(Math.hypot(r2.x, r2.y)).toBeCloseTo(Math.hypot(50, 70));
    expect(r2.angle).toBeCloseTo(20);
  });

  it("rotates to the nearer of deg and deg + 180", () => {
    const pivot = { x: 0, y: 0 };
    expect(withReadout({ x: 0, y: 0, angle: 170 }, 10, pivot).angle).toBeCloseTo(190);
    expect(withReadout({ x: 0, y: 0, angle: 20 }, 10, pivot).angle).toBeCloseTo(10);
    expect(withReadout({ x: 0, y: 0, angle: 350 }, 10, pivot).angle).toBeCloseTo(10);
  });
});
