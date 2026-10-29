import { describe, expect, it } from "vitest";
import { renderToLatex } from "../../export/renderToLatex";
import type { Element } from "../../model/types";
import "../builtins";
import { mediaRenderer } from "../media";
import { elementSvg, rendererFor } from "../registry";

const media = (content: unknown, w = 320, h = 56): Element => ({
  id: "m1",
  pageId: "p",
  type: "media",
  points: [{ x: 10, y: 20, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: w,
  height: h,
  isHighlighter: false,
  imageUrl: "asset",
  content,
  createdAt: "",
  updatedAt: "",
  version: 0,
});

const opts = { theme: "light" as const, zoomBucket: 1 };

describe("media renderer", () => {
  it("is registered for media (not replaced by the boxed placeholder)", () => {
    expect(rendererFor("media")).toBe(mediaRenderer);
  });

  it("emits a rounded box, a play glyph and the title in SVG", () => {
    const svg = elementSvg(media({ kind: "audio", title: "Lecture <1>" }), opts);
    expect(svg).toContain('data-media="audio"');
    expect(svg).toMatch(/<rect x="10" y="20" width="320" height="56" rx="[\d.]+"/);
    expect(svg).toContain("<polygon");
    expect(svg).toContain("Lecture &lt;1&gt;");
  });

  it("labels untitled players by kind", () => {
    expect(elementSvg(media({ kind: "video" }, 480, 270), opts)).toContain(">Video</text>");
    expect(elementSvg(media({ kind: "audio" }), opts)).toContain(">Audio</text>");
  });

  it("bounds are the width/height box", () => {
    expect(mediaRenderer.bounds!(media({ kind: "video" }, 480, 270))).toEqual({ x: 10, y: 20, width: 480, height: 270 });
  });

  it("draws on a canvas without throwing", () => {
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_t, k) => (typeof k === "string" && !["fillStyle", "strokeStyle", "lineWidth", "font", "textBaseline"].includes(k) ? (...a: unknown[]) => calls.push(`${k}${a.length}`) : undefined),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    mediaRenderer.draw(ctx, media({ kind: "audio", title: "T" }), opts);
    expect(calls.some((c) => c.startsWith("fillText"))).toBe(true);
    expect(calls.some((c) => c.startsWith("roundRect"))).toBe(true);
  });

  it("is left out of LaTeX export", () => {
    const tex = renderToLatex([media({ kind: "audio", title: "Secret" })]);
    expect(tex).not.toContain("Secret");
    expect(tex).not.toContain("m1");
  });
});
