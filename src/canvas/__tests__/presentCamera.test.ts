import { describe, expect, it } from "vitest";
import type { Element } from "../../model/types";
import { frameCamera } from "../presentCamera";
import { worldToScreen } from "../camera";

const frame = (x: number, y: number, w: number, h: number): Element => ({
  id: "f",
  pageId: "pg",
  type: "frame",
  points: [{ x, y, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: 1,
  isHighlighter: false,
  boxWidth: w,
  boxHeight: h,
  content: { title: "F", order: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 0,
});

describe("frameCamera", () => {
  const vp = { width: 1000, height: 600 };

  it("fit_shows_the_whole_frame_with_a_24px_margin_centred", () => {
    const c = frameCamera(frame(100, 200, 1280, 720), vp, false);
    // Width bound: (1000 - 48) / 1280; height bound (600 - 48) / 720 is larger.
    expect(c.z).toBeCloseTo(952 / 1280);
    const tl = worldToScreen(c, { x: 100, y: 200 });
    const br = worldToScreen(c, { x: 1380, y: 920 });
    expect(tl.x).toBeCloseTo(24);
    expect(br.x).toBeCloseTo(976);
    expect((tl.y + br.y) / 2).toBeCloseTo(300);
    expect(tl.y).toBeGreaterThanOrEqual(24);
  });

  it("fill_covers_the_viewport_and_crops_the_overflow", () => {
    const c = frameCamera(frame(0, 0, 800, 800), vp, true);
    // The frame covers the whole viewport: z = max(1000 / 800, 600 / 800).
    expect(c.z).toBeCloseTo(1.25);
    const tl = worldToScreen(c, { x: 0, y: 0 });
    const br = worldToScreen(c, { x: 800, y: 800 });
    expect(tl.x).toBeCloseTo(0);
    expect(br.x).toBeCloseTo(1000);
    expect(tl.y).toBeLessThan(0);
    expect(br.y).toBeGreaterThan(600);
    expect((tl.y + br.y) / 2).toBeCloseTo(300);
  });

  it("fit_and_fill_differ_only_in_zoom_for_the_same_centre", () => {
    const f = frame(-50, 40, 400, 300);
    const a = frameCamera(f, vp, false);
    const b = frameCamera(f, vp, true);
    expect(b.z).toBeGreaterThan(a.z);
    const ca = worldToScreen(a, { x: 150, y: 190 });
    const cb = worldToScreen(b, { x: 150, y: 190 });
    expect(ca.x).toBeCloseTo(500);
    expect(cb.x).toBeCloseTo(500);
    expect(ca.y).toBeCloseTo(300);
    expect(cb.y).toBeCloseTo(300);
  });

  it("honours_a_custom_margin", () => {
    const c = frameCamera(frame(0, 0, 1000, 100), vp, false, 0);
    expect(c.z).toBeCloseTo(1);
  });
});
