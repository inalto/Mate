import { describe, expect, it } from "vitest";
import { fitImage } from "../fit";

const viewport = { x: 100, y: 200, width: 1000, height: 500 };

describe("fitImage", () => {
  it("pasted_image_fits_viewport: scales a large image down to 80 % of the viewport, keeping aspect", () => {
    const r = fitImage({ width: 4000, height: 1000 }, viewport);
    expect(r.width).toBeCloseTo(800);
    expect(r.height).toBeCloseTo(200);
    // centred on the viewport centre
    expect(r.x + r.width / 2).toBeCloseTo(600);
    expect(r.y + r.height / 2).toBeCloseTo(450);
  });

  it("limits by the height when that is tighter", () => {
    const r = fitImage({ width: 1000, height: 2000 }, viewport);
    expect(r.height).toBeCloseTo(400);
    expect(r.width).toBeCloseTo(200);
  });

  it("keeps a small image at its natural size (never upscales)", () => {
    const r = fitImage({ width: 100, height: 50 }, viewport);
    expect([r.width, r.height]).toEqual([100, 50]);
  });

  it("centres on a drop point when given", () => {
    const r = fitImage({ width: 100, height: 50 }, viewport, { x: 300, y: 300 });
    expect([r.x, r.y]).toEqual([250, 275]);
  });

  it("falls back to a default size for zero-sized images", () => {
    const r = fitImage({ width: 0, height: 0 }, viewport);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });
});
