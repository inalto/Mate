import { describe, expect, it } from "vitest";
import { capsuleRuns } from "../../ink/capsuleRuns";
import { simplifyEpsForZoom } from "../../ink/resample";
import { detectRealPressure, penParams, strokeDiscs } from "../../ink/strokePoints";
import type { Element, Page, PenStyle, Point } from "../../model/types";
import { renderToSvg } from "../renderToSvg";

const STAMP = "2026-01-01T00:00:00.000Z";

const page = (over: Partial<Page> = {}): Page => ({
  id: "p1",
  sectionId: "s1",
  title: "Test",
  isExpanded: false,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex: 0,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
  ...over,
});

const line = (x0: number, y0: number, x1: number, y1: number, n = 30): Point[] =>
  Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, pressure: 0.2 + 0.6 * t, timestamp: i * 8 };
  });

const stroke = (id: string, points: Point[], penStyle: PenStyle, over: Partial<Element> = {}): Element => ({
  id,
  pageId: "p1",
  type: "stroke",
  points,
  color: "#000000",
  width: 4,
  isHighlighter: penStyle === "highlighter",
  penStyle,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
  ...over,
});

const opts = { scale: 1, theme: "light" as const, background: "plain" as const, pageFrame: false };
const count = (svg: string, re: RegExp) => (svg.match(re) ?? []).length;

describe("renderToSvg", () => {
  it("emits_one_path_per_run_with_round_caps", () => {
    // Per-point widths force several capsule runs.
    const pts = line(100, 100, 600, 300).map((p, i) => ({ ...p, width: 2 + i }));
    const svg = renderToSvg([stroke("a", pts, "pen")], page(), opts);
    const runs = capsuleRuns(
      strokeDiscs(pts, penParams("pen", 4, detectRealPressure(pts))),
      simplifyEpsForZoom(1),
    ).filter((r) => r.xy.length > 2);
    expect(runs.length).toBeGreaterThan(1);
    const paths = svg.match(/<path [^>]*>/g) ?? [];
    expect(paths).toHaveLength(runs.length);
    for (const p of paths) {
      expect(p).toContain('stroke-linecap="round"');
      expect(p).toContain('stroke-linejoin="round"');
      expect(p).toContain('fill="none"');
      expect(p).toContain('stroke="#000000"');
      expect(p).toMatch(/stroke-width="[\d.]+"/);
    }
    // One-point strokes become circles.
    const dot = renderToSvg([stroke("d", [{ x: 5, y: 5, pressure: 0.5, timestamp: 0 }], "pen")], page(), opts);
    expect(count(dot, /<circle /g)).toBe(1);
    expect(count(dot, /<path /g)).toBe(0);
  });

  it("highlighter_has_opacity_half", () => {
    const hl = stroke("h", line(0, 0, 300, 0), "highlighter", { color: "#C9A227", width: 20 });
    const light = renderToSvg([hl], page(), opts);
    expect(light).toContain('opacity="0.5"');
    expect(light).toContain("mix-blend-mode:multiply");
    expect(light).toContain('fill="#C9A227"');

    const dark = renderToSvg([hl], page(), { ...opts, theme: "dark" });
    expect(dark).toContain('opacity="0.5"');
    expect(dark).toContain("mix-blend-mode:screen");
    expect(dark).toContain('fill="#FFD84D"');

    const pen = renderToSvg([stroke("p", line(0, 0, 300, 0), "pen")], page(), opts);
    expect(pen).not.toContain("opacity=");
  });

  it("viewBox_covers_content_plus_padding", () => {
    const els = [stroke("a", line(100, 200, 900, 200), "pen"), stroke("b", line(500, 300, 500, 700), "pen")];
    // Bounds: x 98..902, y 198..702 (width 4 → 2 each side); padding 40.
    const svg = renderToSvg(els, page(), { ...opts, scale: 2 });
    expect(svg).toContain('viewBox="58 158 884 584"');
    expect(svg).toContain('width="1768"');
    expect(svg).toContain('height="1168"');
  });

  it("draws background lines unless transparent", () => {
    const ruled = page({ backgroundConfig: { type: "ruled", spacing: 40, dotRadius: 1.5 } });
    const els = [stroke("a", line(100, 200, 900, 600), "pen")];
    const plain = renderToSvg(els, ruled, opts);
    expect(count(plain, /<line /g)).toBeGreaterThan(5);
    expect(plain).toContain('fill="#ffffff"');
    const transparent = renderToSvg(els, ruled, { ...opts, background: "transparent" });
    expect(count(transparent, /<line /g)).toBe(0);
    expect(transparent).not.toContain("<rect");
  });

  it("stacks every sheet with content in page mode", () => {
    const paged = page({ mode: "page", pageWidth: 1080, pageHeight: 1440 });
    const els = [stroke("a", line(100, 100, 200, 1600), "pen")];
    const svg = renderToSvg(els, paged, { ...opts, pageFrame: true });
    // Two sheets of 1440 with a 24 gap.
    expect(svg).toContain('viewBox="0 0 1080 2904"');
    expect(count(svg, /<rect [^>]*rx="12"/g)).toBe(2);
  });
});

describe("SVG export of math boxes", () => {
  it("katex_css_is_embedded_once_in_defs", async () => {
    await import("../../renderers/builtins");
    const { mathElement, mathContent } = await import("../../math/mathBox");
    const { textAttrsOf } = await import("../../text/textBox");
    const box = (id: string, x: number, latex: string): Element => {
      const el = mathElement("p1", id, STAMP, { x, y: 0 }, "#000000");
      return { ...el, content: mathContent({}, latex, textAttrsOf(el)) };
    };
    const svg = renderToSvg([box("m1", 0, "x^2"), box("m2", 300, "\frac{a}{b}")], page(), opts);
    expect(count(svg, /@font-face/g)).toBeGreaterThan(0);
    // The katex stylesheet (its @font-face rules) appears once, in <defs>, not per foreignObject.
    const fontFaces = count(svg, /@font-face/g);
    const single = renderToSvg([box("m1", 0, "x^2")], page(), opts);
    expect(count(single, /@font-face/g)).toBe(fontFaces);
    expect(svg.indexOf("<defs><style><![CDATA[")).toBeGreaterThan(-1);
    expect(svg.indexOf("@font-face")).toBeLessThan(svg.indexOf("<foreignObject"));
    // Each box keeps only its local rule.
    expect(count(svg, /\.katex-display\{margin:0\}/g)).toBe(2);
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  });
});
