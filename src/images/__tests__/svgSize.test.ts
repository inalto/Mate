import { afterEach, describe, expect, it } from "vitest";
import { configureAssetBytes, intrinsicSize, svgIntrinsicSize, type DecodedImage } from "../load";

const enc = (s: string) => new TextEncoder().encode(s);
const img = (w: number, h: number) => ({ naturalWidth: w, naturalHeight: h, width: w, height: h }) as unknown as DecodedImage;

afterEach(() => configureAssetBytes());

describe("SVG natural size", () => {
  it("uses explicit px width/height, else the viewBox aspect at 400 px, else 400×300", () => {
    expect(svgIntrinsicSize('<svg width="120" height="80px" viewBox="0 0 10 10"/>')).toEqual({ width: 120, height: 80 });
    expect(svgIntrinsicSize('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">')).toEqual({ width: 400, height: 200 });
    expect(svgIntrinsicSize("<svg viewBox='0,0,50,100'></svg>")).toEqual({ width: 400, height: 800 });
    expect(svgIntrinsicSize('<svg width="100%" viewBox="0 0 4 3"></svg>')).toEqual({ width: 400, height: 300 });
    expect(svgIntrinsicSize('<svg height="60" viewBox="0 0 4 3"></svg>')).toEqual({ width: 80, height: 60 });
    expect(svgIntrinsicSize("<svg xmlns='x'><rect/></svg>")).toEqual({ width: 400, height: 300 });
    expect(svgIntrinsicSize("<svgx/>")).toBeNull();
    expect(svgIntrinsicSize("not svg")).toBeNull();
  });

  it("converts absolute units at 96 dpi", () => {
    expect(svgIntrinsicSize('<svg width="210mm" height="297mm"/>')).toEqual({ width: (210 * 96) / 25.4, height: (297 * 96) / 25.4 });
    expect(svgIntrinsicSize('<svg width="2in" height="1.5IN"/>')).toEqual({ width: 192, height: 144 });
    expect(svgIntrinsicSize('<svg width="72pt" height="2.54cm"/>')).toEqual({ width: 96, height: 96 });
    expect(svgIntrinsicSize('<svg width="6pc" height="10"/>')).toEqual({ width: 96, height: 10 });
    // Relative units are not lengths the markup can be sized from.
    expect(svgIntrinsicSize('<svg width="10em" height="5em" viewBox="0 0 2 1"/>')).toEqual({ width: 400, height: 200 });
  });

  it("keeps the decoded size when the markup declares none", async () => {
    // Only one dimension and no viewBox: nothing to size from, the browser's size stands.
    configureAssetBytes(async () => enc('<svg width="5cm"><rect/></svg>'));
    expect(await intrinsicSize("e", img(189, 150), "image/svg+xml")).toEqual({ width: 189, height: 150 });
    configureAssetBytes(async () => enc("<svg xmlns='x'><rect/></svg>"));
    expect(await intrinsicSize("f", img(300, 150), "image/svg+xml")).toEqual({ width: 300, height: 150 });
    // ... and 400×300 only when the decoded size is 0×0 too.
    expect(await intrinsicSize("g", img(0, 0), "image/svg+xml")).toEqual({ width: 400, height: 300 });
    // Absolute units win over the decoded size.
    configureAssetBytes(async () => enc('<svg width="1in" height="0.5in"><rect/></svg>'));
    expect(await intrinsicSize("h", img(300, 150), "image/svg+xml")).toEqual({ width: 96, height: 48 });
  });

  it("intrinsicSize falls back to the markup when the decoded SVG reports 0×0", async () => {
    configureAssetBytes(async () => enc('<svg viewBox="0 0 300 150"><circle r="1"/></svg>'));
    expect(await intrinsicSize("a", img(0, 0), "image/svg+xml")).toEqual({ width: 400, height: 200 });
    // A browser's made-up 300×150 for a viewBox-only SVG is replaced by the viewBox aspect too.
    configureAssetBytes(async () => enc('<svg viewBox="0 0 100 100"/>'));
    expect(await intrinsicSize("b", img(300, 150), "image/svg+xml")).toEqual({ width: 400, height: 400 });
  });

  it("keeps decoded sizes of raster images and survives unreadable assets", async () => {
    configureAssetBytes(async () => {
      throw new Error("gone");
    });
    expect(await intrinsicSize("c", img(64, 32), "image/png")).toEqual({ width: 64, height: 32 });
    expect(await intrinsicSize("d", img(0, 0), "image/svg+xml")).toEqual({ width: 400, height: 300 });
  });
});
