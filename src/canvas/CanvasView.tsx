// Canvas editor surface: a static layer (background + committed elements via SnapshotCache) under an
// interaction layer (live stroke, tool overlays). Camera math lives in camera.ts/gestures.ts, the
// stroke pipeline in strokeCommit.ts, eraser/lasso/selection in toolInteractions.ts; this file wires
// DOM events, the editor store and rendering together.
import { useEffect, useRef } from "react";
import { renderStroke } from "../ink/render";
import type { ThemeName } from "../ink/types";
import { elementsQueue } from "../ipc/elementsQueue";
import { LIMITS } from "../model/constants";
import type { Element, Point, Settings } from "../model/types";
import { clampToPage, isInkTool, sheetStack, useEditorStore, type EditorStore } from "../stores/editor";
import { renderOrder } from "../tools/zorder";
import { useSettingsStore } from "../stores/settings";
import { paintBackground, type SurfaceColors } from "./background";
import { worldToScreen, type Camera, type Vec2 } from "./camera";
import { applyWheel, dragPan, pinchCamera, SNAP_BACK_MS, type PinchStart } from "./gestures";
import { createPointerAdapter, type PalmRejection } from "./input";
import { SnapshotCache, type SnapshotContext } from "./snapshot";
import { createStrokeBuilder, strokeElement, type StrokeBuilder } from "./strokeCommit";
import { createToolController, pointerTool } from "./toolInteractions";

/** Quiet period after the last camera change before the snapshot is re-rasterised. */
const RASTER_DEBOUNCE_MS = 150;

const nextFrame = (cb: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(cb);
  else setTimeout(cb, 16);
};

function surfaceColors(): SurfaceColors {
  const cs = getComputedStyle(document.documentElement);
  return {
    paper: cs.getPropertyValue("--canvas-page").trim() || "#ffffff",
    desk: cs.getPropertyValue("--canvas-desk").trim() || "#eef0f2",
  };
}

const asCtx = (ctx: SnapshotContext) => ctx as unknown as CanvasRenderingContext2D;

/** Imperative renderer + input wiring for one mounted page. Returns a handle for React effects. */
function createEngine(
  store: EditorStore,
  pageId: string,
  host: HTMLDivElement,
  staticCanvas: HTMLCanvasElement,
  liveCanvas: HTMLCanvasElement,
  getSettings: () => Settings,
) {
  const st = store.getState;
  const clamp = (c: Camera) => clampToPage(c, st());
  const cache = new SnapshotCache(200);
  const sctx = staticCanvas.getContext("2d");
  const lctx = liveCanvas.getContext("2d");
  const theme = (): ThemeName => getSettings().theme;
  let dpr = window.devicePixelRatio || 1;
  let colors = surfaceColors();
  let staticQueued = false;
  let liveQueued = false;
  let rasterTimer: ReturnType<typeof setTimeout> | null = null;
  let snapTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Pointer interaction state.
  let mode: "none" | "draw" | "pan" | "tool" = "none";
  let builder: StrokeBuilder | null = null;
  let liveEl: Element | null = null;
  let lastPan: Vec2 = { x: 0, y: 0 };
  let pinchStart: PinchStart | null = null;
  /** True while our own commit updates the store (the element is already in the snapshot). */
  let committing = false;
  let sheetCount = 0;

  const ready = () => {
    const s = st();
    return s.loadedPageId === pageId && s.page !== null ? s : null;
  };

  const paintScene = (ctx: SnapshotContext, el?: Element) => {
    const s = st();
    if (!s.page) return;
    if (!el) {
      const stack = sheetStack(s);
      sheetCount = stack.count;
      const bgPage = { mode: s.page.mode, width: stack.width, height: stack.height, count: stack.count };
      paintBackground(ctx, s.page.backgroundConfig, cache.worldClip(), bgPage, theme(), colors);
    } else if (el.type === "stroke" && !tools.hidden.has(el.id)) {
      renderStroke(asCtx(ctx), el, theme(), s.camera.z);
    }
  };

  const rasterNow = () => {
    if (rasterTimer !== null) clearTimeout(rasterTimer);
    rasterTimer = null;
    const s = ready();
    if (!s) return;
    cache.ensure(s.viewport, s.camera, dpr);
    // Only what the bitmap can show: the clip is the viewport plus the snapshot margin, and index
    // bounds include stroke width. Pans within the margin blit; leaving it re-rasterises.
    const visible: Element[] = [];
    for (const id of store.spatialIndex().query(cache.worldClip())) {
      const el = s.elements.get(id);
      if (el) visible.push(el);
    }
    cache.rasterAll(renderOrder(visible), paintScene);
  };

  const drawStatic = () => {
    staticQueued = false;
    const s = ready();
    if (disposed || !s || !sctx) return;
    if (cache.ensure(s.viewport, s.camera, dpr)) {
      if (!cache.hasContent) rasterNow();
      else {
        if (rasterTimer !== null) clearTimeout(rasterTimer);
        rasterTimer = setTimeout(() => {
          rasterNow();
          requestStatic();
        }, RASTER_DEBOUNCE_MS);
      }
    }
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.fillStyle = s.page!.mode === "page" ? colors.desk : colors.paper;
    sctx.fillRect(0, 0, staticCanvas.width, staticCanvas.height);
    cache.blitTo(sctx, s.camera);
  };
  const requestStatic = () => {
    if (staticQueued) return;
    staticQueued = true;
    nextFrame(drawStatic);
  };

  const drawLive = () => {
    liveQueued = false;
    if (disposed || !lctx) return;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    const c = st().camera;
    if (liveEl) {
      lctx.setTransform(dpr * c.z, 0, 0, dpr * c.z, dpr * c.x, dpr * c.y);
      renderStroke(lctx, liveEl, theme(), c.z);
    }
    if (tools.draw(lctx, c, dpr)) requestLive(); // marching ants animate while selected
  };
  const requestLive = () => {
    if (liveQueued) return;
    liveQueued = true;
    nextFrame(drawLive);
  };
  const setLive = (points: Point[] | null) => {
    const s = st();
    liveEl = points && points.length > 0 ? strokeElement(points, { pageId, preset: s.preset }, "live", "") : null;
    requestLive();
  };

  const tools = createToolController({
    store,
    el: liveCanvas,
    requestLive,
    invalidate: () => {
      cache.invalidate();
      requestStatic();
    },
    renderElement: (ctx, el) => {
      if (el.type === "stroke") renderStroke(ctx, el, theme(), st().camera.z);
    },
    getSettings,
  });

  const resize = () => {
    const r = host.getBoundingClientRect();
    const width = Math.max(1, Math.round(r.width));
    const height = Math.max(1, Math.round(r.height));
    dpr = window.devicePixelRatio || 1;
    for (const c of [staticCanvas, liveCanvas]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
    }
    st().setViewport({ width, height });
    requestStatic();
    requestLive();
  };

  const commit = (el: Element) => {
    cache.append((ctx) => renderStroke(asCtx(ctx), el, theme(), st().camera.z));
    committing = true;
    try {
      st().addElement(el);
    } finally {
      committing = false;
    }
    requestStatic();
  };

  const adapter = createPointerAdapter(
    liveCanvas,
    {
      onDown(p, info) {
        const s = ready();
        if (!s) return;
        const { tool, temp } = pointerTool(s.tool, s.panHold, info, getSettings());
        if (temp) s.pushTempTool(temp);
        if (tool === "pan") {
          mode = "pan";
          lastPan = worldToScreen(s.camera, p);
          return;
        }
        if (!isInkTool(tool)) {
          mode = tool === "none" ? "none" : "tool";
          if (mode === "tool") tools.down(p, tool);
          return;
        }
        if (s.elements.size >= LIMITS.MAX_ELEMENTS_PER_PAGE) {
          mode = "none";
          return;
        }
        const set = getSettings();
        mode = "draw";
        builder = createStrokeBuilder({
          pageId,
          preset: s.preset,
          zoom: s.camera.z,
          stabilization: set.strokeStabilization,
          nibFlatness: set.fountainPenNibFlatness,
        });
        setLive(builder.push([p]));
      },
      onMove(points, predicted) {
        if (mode === "pan") {
          const s = st();
          const scr = worldToScreen(s.camera, points[points.length - 1]);
          s.setCamera(dragPan(s.camera, scr.x - lastPan.x, scr.y - lastPan.y, clamp));
          lastPan = scr;
        } else if (mode === "draw" && builder) {
          builder.push(points);
          setLive(builder.preview(predicted));
        } else if (mode === "tool") tools.move(points);
      },
      onUp(p) {
        if (mode === "draw" && builder) {
          builder.push([p]);
          const pts = builder.finish();
          if (pts.length > 0) commit(strokeElement(pts, { pageId, preset: st().preset }));
        } else if (mode === "tool") tools.up();
        builder = null;
        mode = "none";
        st().popTempTool();
        setLive(null);
      },
      onCancel() {
        if (mode === "tool") tools.cancel();
        st().popTempTool();
        builder = null;
        mode = "none";
        setLive(null);
      },
      onPan(dx, dy) {
        const s = st();
        s.setCamera(dragPan(s.camera, dx, dy, clamp));
      },
      onPinch(g) {
        const s = st();
        if (g.phase === "start") pinchStart = { camera: s.camera, mid: g.mid, dist: g.dist };
        else if (g.phase === "end") pinchStart = null;
        else if (pinchStart) s.setCamera(clamp(pinchCamera(pinchStart, g.mid, g.dist)));
      },
    },
    {
      get palmRejection() {
        return getSettings().palmRejection as PalmRejection;
      },
      get drawWithFinger() {
        return getSettings().drawWithFinger;
      },
      get pinchToZoom() {
        return getSettings().pinchToZoom;
      },
      getCamera: () => st().camera,
    },
  );

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const s = ready();
    if (!s) return;
    const r = host.getBoundingClientRect();
    const focus = { x: e.clientX - r.left, y: e.clientY - r.top };
    s.setCamera(applyWheel(s.camera, e, focus, getSettings().scrollBehavior, clamp));
    if (snapTimer !== null) clearTimeout(snapTimer);
    snapTimer = setTimeout(() => st().setCamera(clamp(st().camera)), SNAP_BACK_MS);
  };

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.elements !== prev.elements || s.page !== prev.page || s.loadedPageId !== prev.loadedPageId) {
      const own = committing && s.page === prev.page;
      // A commit that adds a page-mode sheet also needs a fresh background.
      if (!own || (s.page?.mode === "page" && sheetStack(s).count !== sheetCount)) cache.invalidate();
      requestStatic();
    }
    if (s.camera !== prev.camera || s.viewport !== prev.viewport) {
      requestStatic();
      requestLive();
    }
    if (s.selection !== prev.selection || s.tool !== prev.tool || s.tempTool !== prev.tempTool) requestLive();
    if (s.panHold !== prev.panHold) host.classList.toggle("is-panning", s.panHold);
    if (s.tool !== prev.tool) host.dataset.tool = s.tool;
  });
  host.dataset.tool = st().tool;

  host.addEventListener("wheel", onWheel, { passive: false });
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(host);
  else window.addEventListener("resize", resize);
  resize();
  void st().loadPage(pageId);

  return {
    /** Theme or token change: re-read colours and re-rasterise. */
    restyle() {
      colors = surfaceColors();
      cache.invalidate();
      requestStatic();
      requestLive();
    },
    dispose() {
      disposed = true;
      adapter();
      tools.dispose();
      unsubscribe();
      ro?.disconnect();
      window.removeEventListener("resize", resize);
      host.removeEventListener("wheel", onWheel);
      if (rasterTimer !== null) clearTimeout(rasterTimer);
      if (snapTimer !== null) clearTimeout(snapTimer);
      void elementsQueue.flushAll();
    },
    stats: cache.stats,
  };
}

export default function CanvasView({ pageId, store = useEditorStore }: { pageId: string; store?: EditorStore }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ReturnType<typeof createEngine> | null>(null);
  const theme = useSettingsStore((s) => s.settings.theme);

  useEffect(() => {
    const host = hostRef.current;
    const sc = staticRef.current;
    const lc = liveRef.current;
    if (!host || !sc || !lc) return;
    const engine = createEngine(store, pageId, host, sc, lc, () => useSettingsStore.getState().settings);
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [pageId, store]);

  useEffect(() => {
    engineRef.current?.restyle();
  }, [theme]);

  return (
    <div ref={hostRef} className="canvas-view" data-testid="canvas-view">
      <canvas ref={staticRef} className="canvas-layer" />
      <canvas ref={liveRef} className="canvas-layer canvas-live" />
    </div>
  );
}
