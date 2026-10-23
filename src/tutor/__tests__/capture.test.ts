import { describe, expect, it } from "vitest";
import { el } from "../../tools/__tests__/fixtures";
import { captureGeometry, captureGroupImage, CAPTURE_PADDING, type CaptureCanvas } from "../capture";
import type { Region } from "../types";

function region(ids: string[], x: number, y: number, width: number, height: number): Region {
  return { regionId: "r1", type: "math", elementIds: ids, bounds: { x, y, width, height }, baselineY: y + height };
}

interface Call {
  name: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
}

/** A canvas whose 2D context records every call and the colour in effect. */
function fakeCanvas(log: { calls: Call[]; size?: [number, number] }) {
  return (w: number, h: number): CaptureCanvas => {
    log.size = [w, h];
    const state: Record<string, unknown> = { fillStyle: "#000", strokeStyle: "#000" };
    const ctx = new Proxy(state, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return (...args: unknown[]) => {
          log.calls.push({ name: prop, args, fillStyle: target.fillStyle, strokeStyle: target.strokeStyle });
        };
      },
      set(target, prop: string, value) {
        target[prop] = value;
        return true;
      },
    });
    return {
      width: w,
      height: h,
      getContext: () => ctx as unknown as CanvasRenderingContext2D,
      encodePng: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    };
  };
}

describe("captureGeometry", () => {
  it("capture_scales_to_target_area", () => {
    const g = captureGeometry({ x: 100, y: 200, width: 100, height: 50 });
    // Padding of 24 units on every side.
    expect(g.bounds).toEqual({ x: 76, y: 176, width: 148, height: 98 });
    const area = g.width * g.height;
    expect(area).toBeGreaterThan(72_000 * 0.97);
    expect(area).toBeLessThan(72_000 * 1.05);
    expect(g.width / g.height).toBeCloseTo(148 / 98, 1);

    // A tiny dot is upscaled at most 8x.
    const tiny = captureGeometry({ x: 0, y: 0, width: 1, height: 1 }, { padding: 0 });
    expect(tiny.scale).toBe(8);
    expect(tiny.width).toBe(8);

    // A very long line is capped at 2048 px on its long side.
    const long = captureGeometry({ x: 0, y: 0, width: 20_000, height: 40 });
    expect(Math.max(long.width, long.height)).toBeLessThanOrEqual(2048);
    expect(long.width).toBe(2048);

    expect(CAPTURE_PADDING).toBe(24);
  });
});

describe("captureGroupImage", () => {
  it("draws only the group's ink on white, in light colours", async () => {
    const a = el("a", [[110, 210], [150, 240], [190, 220]], { color: "#FFFFFF" });
    const b = el("b", [[120, 215], [160, 245]], { color: "#6AA9FF" });
    const other = el("other", [[130, 220], [170, 230]], { color: "#C62828" });
    const log: { calls: Call[]; size?: [number, number] } = { calls: [] };
    const out = await captureGroupImage([a, b, other], region(["a", "b"], 110, 210, 80, 35), {
      createCanvas: fakeCanvas(log),
    });
    expect(out.png).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(out.bounds).toEqual({ x: 86, y: 186, width: 128, height: 83 });
    expect(log.size).toEqual([out.width, out.height]);

    const first = log.calls.find((c) => c.name === "fillRect")!;
    expect(first.fillStyle).toBe("#FFFFFF");
    const inkColours = new Set(log.calls.filter((c) => c.name === "stroke" || c.name === "fill").map((c) => c.strokeStyle));
    // White ink (drawn in dark mode) becomes black; dark-palette blue maps back to its light colour.
    expect(inkColours).toEqual(new Set(["#000000", "#1565C0"]));
    expect([...inkColours]).not.toContain("#C62828");
  });

  it("rejects a group without ink", async () => {
    await expect(captureGroupImage([], region(["x"], 0, 0, 10, 10), { createCanvas: fakeCanvas({ calls: [] }) })).rejects.toThrow();
  });
});
