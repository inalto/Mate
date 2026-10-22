import { afterEach, describe, expect, it, vi } from "vitest";
import type { Element, Page } from "../../model/types";
import { contentOf, type TableContent, type TextBoxContent } from "../../model/content";
import { el } from "../../tools/__tests__/fixtures";
import { paintScene } from "../../export/scene";
import { renderToSvg } from "../../export/renderToSvg";
import { BoxSnapshotCache, boxSnapshots } from "../boxSnapshot";
import { boxedRenderer } from "../builtins";
import { drawElement, elementSvg, registerRenderer, rendererFor } from "../registry";

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

const box = (id: string, over: Partial<Element> = {}): Element =>
  el(id, [[10, 20]], { type: "text-box", boxWidth: 100, boxHeight: 50, width: 1, ...over });

/** Records every method call made on a fake 2D context. */
function recordingCtx() {
  const calls: { name: string; args: unknown[] }[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      calls.push({ name: `set:${key}`, args: [value] });
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, names: () => calls.map((c) => c.name) };
}

const opts = { theme: "light" as const, background: "transparent" as const, pageFrame: false, zoomBucket: 1 };

describe("renderer registry", () => {
  afterEach(() => boxSnapshots.clear());

  it("registry_dispatches_by_type", () => {
    const draw = vi.fn();
    const svg = vi.fn(() => "<g id='slide'/>");
    const unregister = registerRenderer("slide", { draw, svg });
    const { ctx } = recordingCtx();
    const slide = el("s", [[0, 0]], { type: "slide" });
    const ropts = { theme: "light" as const, zoomBucket: 2 };
    drawElement(ctx, slide, ropts);
    expect(draw).toHaveBeenCalledTimes(1);
    const [gotCtx, gotEl, gotOpts] = draw.mock.calls[0];
    expect(gotCtx === ctx && gotEl === slide && gotOpts === ropts).toBe(true);
    expect(elementSvg(slide, ropts)).toBe("<g id='slide'/>");
    unregister();
    expect(rendererFor("slide")).toBeUndefined();
    // Unregistered types are skipped silently.
    expect(() => drawElement(ctx, slide, ropts)).not.toThrow();
    expect(elementSvg(slide, ropts)).toBe("");
    // Built-ins: strokes and every boxed type have renderers once the scene is loaded.
    for (const t of ["stroke", "text-box", "table", "codespace", "graph", "image"] as const) {
      expect(rendererFor(t)).toBeDefined();
    }
  });

  it("scene_draws_boxed_from_snapshot_when_present", () => {
    const b = box("b");
    const bitmap = { width: 100, height: 50 } as unknown as HTMLCanvasElement;
    boxSnapshots.set("b", b.updatedAt, bitmap);
    const r1 = recordingCtx();
    paintScene(r1.ctx, page, [b], { x: 0, y: 0, width: 500, height: 500 }, { mode: "canvas", width: 500, height: 500 }, opts);
    expect(r1.calls.find((c) => c.name === "drawImage")?.args).toEqual([bitmap, 10, 20, 100, 50]);
    expect(r1.names()).not.toContain("strokeRect");

    // A snapshot of an older revision is ignored: the placeholder frame is drawn instead.
    const edited = { ...b, updatedAt: "2026-02-01T00:00:00.000Z" };
    const r2 = recordingCtx();
    paintScene(r2.ctx, page, [edited], { x: 0, y: 0, width: 500, height: 500 }, { mode: "canvas", width: 500, height: 500 }, opts);
    expect(r2.names()).not.toContain("drawImage");
    expect(r2.calls.find((c) => c.name === "strokeRect")?.args).toEqual([10, 20, 100, 50]);
    expect(r2.calls).toContainEqual({ name: "set:strokeStyle", args: ["#9aa0a6"] });
    expect(r2.names()).not.toContain("fillRect");
  });

  it("svg_export_includes_boxed_placeholder", () => {
    // Text boxes, tables and code blocks export as <foreignObject> (see overlay/__tests__/textSnapshot) and graphs as
    // vector (renderers/__tests__/graph); the shared boxed renderer exports a placeholder without a snapshot.
    expect(boxedRenderer.svg(box("b", { type: "graph" }), { ...opts, zoomBucket: 1 })).toContain(
      '<rect x="10" y="20" width="100" height="50" fill="none" stroke="#9aa0a6"',
    );
    const svg = renderToSvg([box("b", { type: "graph" }), el("s", [[0, 0], [50, 50]])], page, { ...opts, scale: 1 });
    expect(svg).toContain('<g transform="translate(10 20)">');
    expect(svg).toContain("<path");
  });
});

describe("BoxSnapshotCache", () => {
  it("keys_by_id_and_revision", () => {
    const cache = new BoxSnapshotCache();
    const b = box("b");
    const close = vi.fn();
    const bmp = { close } as unknown as ImageBitmap;
    const seen = vi.fn();
    const unsub = cache.subscribe(seen);
    expect(cache.get(b)).toBeNull();
    cache.set("b", b.updatedAt, bmp);
    expect(cache.get(b)).toBe(bmp);
    expect(cache.get({ ...b, updatedAt: "later" })).toBeNull();
    cache.invalidate("b");
    expect(close).toHaveBeenCalled();
    expect(cache.get(b)).toBeNull();
    expect(seen).toHaveBeenCalledTimes(2);
    unsub();
    cache.set("b", b.updatedAt, bmp);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe("contentOf", () => {
  it("never_throws_on_odd_content", () => {
    for (const content of [undefined, null, "x", 3, [1, 2], true]) {
      expect(contentOf<TextBoxContent>(box("b", { content }))).toEqual({});
    }
    const t = box("t", { type: "table", content: { subtype: "table", tableData: { rows: [["a"]] } } });
    expect(contentOf<TableContent>(t).tableData?.rows).toEqual([["a"]]);
  });
});
