import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToSvg } from "../../export/renderToSvg";
import { paintScene } from "../../export/scene";
import type { TextBoxContent } from "../../model/content";
import type { Element, Page } from "../../model/types";
import { boxSnapshots } from "../../renderers/boxSnapshot";
import "../../renderers/builtins";
import { drawElement } from "../../renderers/registry";
import { textBoxForeignObject } from "../../text/foreignObject";
import { el } from "../../tools/__tests__/fixtures";
import { setHtmlRasterizer, type HtmlRasterizer } from "../htmlToBitmap";
import { clearTextSnapshots, prepareTextSnapshots, renderTextSnapshot, snapshotScale, textSnapshotFor } from "../snapshot";

const STAMP = "2026-01-01T00:00:00.000Z";
const page: Page = {
  id: "pg",
  sectionId: "s1",
  title: "T",
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
};

const content = (html: string): TextBoxContent => ({
  contentHtml: html,
  rawContent: "",
  textAttributes: { fontFamily: "serif", fontSize: 20, color: "#C62828", align: "center" },
});
const tb = (id: string, html = "<p>Hi <b>there</b></p>", over: Partial<Element> = {}): Element =>
  el(id, [[10, 20]], { type: "text-box", boxWidth: 100, boxHeight: 30, width: 1, content: content(html), ...over });

function recordingCtx() {
  const calls: { name: string; args: unknown[] }[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, names: () => calls.map((c) => c.name) };
}

/** Stub rasterizer: records requests and returns a fake bitmap of the requested size. */
function stubRasterizer() {
  const calls: { svg: string; width: number; height: number }[] = [];
  const fn: HtmlRasterizer = vi.fn(async (svg: string, width: number, height: number) => {
    calls.push({ svg, width, height });
    return { width, height, tag: `bmp${calls.length}` } as unknown as HTMLCanvasElement;
  });
  return { fn, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("text box rendering", () => {
  let stub: ReturnType<typeof stubRasterizer>;
  beforeEach(() => {
    stub = stubRasterizer();
    setHtmlRasterizer(stub.fn);
  });
  afterEach(() => {
    setHtmlRasterizer(null);
    clearTextSnapshots();
    boxSnapshots.clear();
  });

  it("foreign_object_carries_sanitised_html_and_box_style", () => {
    const fo = textBoxForeignObject(content('<p>a<script>x()</script><img src=x onerror="y()"><br>b</p>'), { x: 5, y: 6, width: 100, height: 30 }, "#123456");
    expect(fo).toMatch(/^<foreignObject x="5" y="6" width="100" height="30">/);
    expect(fo).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(fo).toContain("<p>a<br />b</p>");
    expect(fo).toMatch(/font-family: &quot;STIX Two Text&quot;, Georgia, serif;|font-family: "STIX Two Text", Georgia, serif;/);
    expect(fo).toContain("font-size: 20px;");
    expect(fo).toContain("color: #123456;");
    expect(fo).toContain("text-align: center;");
    expect(fo).not.toMatch(/script|onerror|<img/);
  });

  it("renders_snapshot_through_the_rasterizer_at_scale", async () => {
    const b = tb("b");
    await renderTextSnapshot(b, "light", 2);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({ width: 200, height: 60 });
    expect(stub.calls[0].svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="200" height="60" viewBox="0 0 100 30">/);
    expect(stub.calls[0].svg).toContain("Hi <b>there</b>");
    expect(boxSnapshots.get(b)).toMatchObject({ width: 200, tag: "bmp1" });
  });

  it("canvas_draw_requests_snapshot_then_draws_it", async () => {
    const b = tb("b");
    const r1 = recordingCtx();
    drawElement(r1.ctx, b, { theme: "light", zoomBucket: 1 });
    expect(r1.names()).toContain("strokeRect"); // placeholder until the bitmap exists
    await settle();
    expect(stub.calls).toHaveLength(1);
    const r2 = recordingCtx();
    drawElement(r2.ctx, b, { theme: "light", zoomBucket: 1 });
    expect(r2.calls.find((c) => c.name === "drawImage")?.args.slice(1)).toEqual([10, 20, 100, 30]);
    expect(stub.calls).toHaveLength(1); // no re-render at the same scale

    // Zooming in asks for a sharper bitmap (power-of-two buckets); the old one is drawn meanwhile.
    const r3 = recordingCtx();
    drawElement(r3.ctx, b, { theme: "light", zoomBucket: 3, pixelRatio: 1 });
    expect(r3.names()).toContain("drawImage");
    await settle();
    expect(stub.calls[1]).toMatchObject({ width: 400, height: 120 });
  });

  it("moving_a_box_reuses_its_bitmap", async () => {
    const b = tb("b");
    await renderTextSnapshot(b, "light", 1);
    const moved = { ...b, points: [{ ...b.points[0], x: 300 }], updatedAt: "2026-03-01T00:00:00.000Z" };
    const r = recordingCtx();
    drawElement(r.ctx, moved, { theme: "light", zoomBucket: 1 });
    expect(r.calls.find((c) => c.name === "drawImage")?.args.slice(1)).toEqual([300, 20, 100, 30]);
    await settle();
    expect(stub.calls).toHaveLength(1);
    // Edited text is a new appearance: rendered again.
    drawElement(recordingCtx().ctx, tb("b", "<p>new</p>"), { theme: "light", zoomBucket: 1 });
    await settle();
    expect(stub.calls).toHaveLength(2);
  });

  it("dark_theme_maps_the_text_colour", async () => {
    const b = tb("b", "<p>x</p>", { content: { ...content("<p>x</p>"), textAttributes: { fontFamily: "sans", fontSize: 20, color: "#000000", align: "left" } } });
    await renderTextSnapshot(b, "light", 1);
    await renderTextSnapshot(b, "dark", 1);
    expect(stub.calls[0].svg).toContain("color: #000000;");
    expect(stub.calls[1].svg).not.toContain("color: #000000;");
  });

  it("failed_renders_keep_the_placeholder_without_retrying", async () => {
    setHtmlRasterizer(vi.fn(async () => Promise.reject(new Error("no foreignObject"))));
    const b = tb("b");
    drawElement(recordingCtx().ctx, b, { theme: "light", zoomBucket: 1 });
    await settle();
    const r = recordingCtx();
    drawElement(r.ctx, b, { theme: "light", zoomBucket: 1 });
    await settle();
    expect(r.names()).toContain("strokeRect");
    expect(r.names()).not.toContain("drawImage");
  });

  it("png_export_and_thumbnails_wait_for_snapshots", async () => {
    const b = tb("b");
    await prepareTextSnapshots([b, el("ink", [[0, 0], [5, 5]])], "light", 2);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].width).toBe(200);
    const r = recordingCtx();
    paintScene(r.ctx, page, [b], { x: 0, y: 0, width: 500, height: 500 }, { mode: "canvas", width: 500, height: 500 }, {
      theme: "light",
      background: "transparent",
      pageFrame: false,
      zoomBucket: 2,
    });
    expect(r.names()).toContain("drawImage");
    expect(r.names()).not.toContain("strokeRect");
    await settle();
    expect(stub.calls).toHaveLength(1);
    // A rasterizer that never answers does not hang the export.
    setHtmlRasterizer(() => new Promise(() => {}));
    await expect(prepareTextSnapshots([tb("c", "<p>c</p>")], "light", 1, { timeoutMs: 10 })).resolves.toBeInstanceOf(Map);
  });

  it("export_awaits_all_text_snapshots", async () => {
    vi.useFakeTimers();
    try {
      // A slow render (5 s) is awaited in full when no timeout is given.
      setHtmlRasterizer(
        (_svg, width, height) =>
          new Promise((resolve) => setTimeout(() => resolve({ width, height, tag: "slow" } as unknown as HTMLCanvasElement), 5000)),
      );
      const b = tb("b");
      let result: Map<string, unknown> | undefined;
      void prepareTextSnapshots([b], "light", 1).then((m) => (result = m));
      await vi.advanceTimersByTimeAsync(3500);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2000);
      expect(result?.get("b|light")).toMatchObject({ tag: "slow" });
    } finally {
      vi.useRealTimers();
    }
    // A render that fails rejects the export instead of leaving a placeholder.
    setHtmlRasterizer(vi.fn(async () => Promise.reject(new Error("no foreignObject"))));
    await expect(prepareTextSnapshots([tb("c", "<p>c</p>")], "light", 1)).rejects.toThrow(/c/);
  });

  it("export_with_more_than_400_boxes_succeeds", async () => {
    // More boxes than the remembered-bitmap cache holds (400): the export keeps every bitmap itself.
    const boxes = Array.from({ length: 450 }, (_, i) => tb(`b${i}`, `<p>${i}</p>`));
    const map = await prepareTextSnapshots(boxes, "light", 1);
    expect(map.size).toBe(450);
    expect(map.get("b0|light")).toBeTruthy();
    expect(map.get("b449|light")).toBeTruthy();
    expect(stub.calls).toHaveLength(450);
  });

  it("export_never_uses_other_theme_bitmap", async () => {
    const b = tb("b");
    // The canvas published a dark bitmap; the light export has none of its own.
    drawElement(recordingCtx().ctx, b, { theme: "dark", zoomBucket: 1 });
    await settle();
    expect(boxSnapshots.get(b)).not.toBeNull();
    expect(() => drawElement(recordingCtx().ctx, b, { theme: "light", zoomBucket: 1, textBitmaps: new Map() })).toThrow(/b/);
    const light = await prepareTextSnapshots([b], "light", 1);
    const r = recordingCtx();
    drawElement(r.ctx, b, { theme: "light", zoomBucket: 1, textBitmaps: light });
    expect(r.calls.find((c) => c.name === "drawImage")?.args[0]).toBe(light.get("b|light"));
    expect(r.calls.find((c) => c.name === "drawImage")?.args[0]).not.toBe(boxSnapshots.get(b));
  });

  it("thumbnail_render_does_not_publish_or_evict_canvas_snapshot", async () => {
    const b = tb("b", "<p>x</p>", { content: { ...content("<p>x</p>"), textAttributes: { fontFamily: "sans", fontSize: 20, color: "#000000", align: "left" } } });
    // The canvas (dark theme) renders and publishes its bitmap.
    drawElement(recordingCtx().ctx, b, { theme: "dark", zoomBucket: 1 });
    await settle();
    const dark = boxSnapshots.get(b);
    expect(dark).not.toBeNull();
    // A light thumbnail render keeps its own bitmap and leaves the element's snapshot alone.
    await prepareTextSnapshots([b], "light", 1);
    expect(stub.calls).toHaveLength(2);
    expect(boxSnapshots.get(b)).toBe(dark);
    expect(textSnapshotFor(b, "dark")?.bitmap).toBe(dark);
    expect(textSnapshotFor(b, "light")?.bitmap).not.toBe(dark);
    // Both themes now draw without new renders.
    const r = recordingCtx();
    drawElement(r.ctx, b, { theme: "dark", zoomBucket: 1 });
    expect(r.calls.find((c) => c.name === "drawImage")?.args[0]).toBe(dark);
    await prepareTextSnapshots([b], "light", 1);
    await settle();
    expect(stub.calls).toHaveLength(2);
  });

  it("svg_export_embeds_foreign_object", () => {
    const b = tb("b", '<p>safe<script>alert(1)</script></p>', { content: { ...content('<p>safe<script>alert(1)</script></p>'), rotation: Math.PI / 2 } });
    const svg = renderToSvg([b], page, { scale: 1, theme: "light", background: "transparent", pageFrame: false });
    expect(svg).toContain('<foreignObject x="10" y="20" width="100" height="30">');
    expect(svg).toContain("<p>safe</p>");
    expect(svg).toContain('transform="rotate(90 60 35)"');
    expect(svg).not.toContain("script");
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  });

  it("snapshot_scale_buckets_and_caps", () => {
    expect(snapshotScale(1, 100, 30)).toBe(1);
    expect(snapshotScale(1.2, 100, 30)).toBe(2);
    expect(snapshotScale(3, 100, 30)).toBe(4);
    expect(snapshotScale(0.3, 100, 30)).toBe(1);
    expect(snapshotScale(100, 100, 30)).toBe(8);
    expect(snapshotScale(8, 2000, 30)).toBe(2); // ≤ 4096 device px per side
  });
});

describe("table and code snapshots", () => {
  beforeEach(() => clearTextSnapshots());
  afterEach(() => setHtmlRasterizer(null));

  it("renders_tables_and_codespaces_through_the_html_pipeline", async () => {
    const r = stubRasterizer();
    setHtmlRasterizer(r.fn);
    const t = el("t", [[0, 0]], { type: "table", boxWidth: 200, boxHeight: 100, content: { subtype: "table", tableData: { rows: [["x<y"]] } } });
    const c = el("c", [[0, 0]], { type: "codespace", boxWidth: 200, boxHeight: 100, content: { subtype: "codespace", code: "a && b", language: "plain" } });
    await prepareTextSnapshots([t, c], "light", 1);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0].svg).toContain("x&lt;y");
    expect(r.calls[1].svg).toContain("a &amp;&amp; b");
    expect(textSnapshotFor(t, "light")).not.toBeNull();
  });
});
