// Canvas editor surface: a static layer (background + committed elements via SnapshotCache) under an
// interaction layer (live stroke, tool overlays). Camera math lives in camera.ts/gestures.ts, the
// stroke pipeline in strokeCommit.ts, eraser/lasso/selection in toolInteractions.ts; this file wires
// DOM events, the editor store and rendering together.
import { useEffect, useRef } from "react";
import { renderStroke } from "../ink/render";
import { isScribbleGesture, scribbleHits } from "../ink/scribble";
import type { ThemeName } from "../ink/types";
import { elementsQueue } from "../ipc/elementsQueue";
import type { Element, Point, Settings } from "../model/types";
import { hasEditor } from "../overlay/editorRegistry";
import { boxSnapshots } from "../renderers/boxSnapshot";
import "../renderers/builtins";
import { drawElement } from "../renderers/registry";
import { clampToPage, isInkTool, sheetStack, useEditorStore, type EditorStore } from "../stores/editor";
import { renderOrder } from "../tools/zorder";
import { useSettingsStore } from "../stores/settings";
import { paintBackground, type SurfaceColors } from "./background";
import { worldToScreen, type Camera, type Vec2 } from "./camera";
import { applyWheel, dragPan, pinchCamera, SNAP_BACK_MS, type PinchStart } from "./gestures";
import { createPointerAdapter, type PalmRejection } from "./input";
import { SnapshotCache, type SnapshotContext } from "./snapshot";
import { createInkSnap, drawSnapFlash, inkSnapAllowed, snapShapeElement, SNAP_FLASH_MS, type InkSnap } from "./inkSnap";
import { createStrokeBuilder, strokeElement, type StrokeBuilder } from "./strokeCommit";
import type { RecognizedShape } from "../shapes/recognize";
import { createToolController, createTutorGestures, hitTest, pointerTool } from "./toolInteractions";
import { groupOfElement, paneOfStore, useTutorUi } from "../stores/tutor";
import { drawTutorMarkers, hitTutorMarker, tutorMarkers } from "../tutor/overlay";
import { useTutorViews } from "../tutor/useTutor";
import { attachDropPaste } from "./dropPaste";

/** Ink-to-shape flash colour (the tools' overlay accent). */
const SNAP_FLASH_COLOR = "#4a5d4e";

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
  /** Ink to shape for the stroke in progress, and the shape it snapped to (shown instead of it). */
  let snap: InkSnap | null = null;
  let snapShape: Element | null = null;
  let flash: { shape: RecognizedShape; until: number } | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPan: Vec2 = { x: 0, y: 0 };
  let pinchStart: PinchStart | null = null;
  /** True while our own commit updates the store (the element is already in the snapshot). */
  let committing = false;
  let sheetCount = 0;
  /** The pen stroke in progress takes part in tutor gestures (tap / double-tap / hold on ink). */
  let tutorStroke = false;

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
    } else if (!tools.hidden.has(el.id) && !(el.id === s.editingId && hasEditor(el.type))) {
      drawElement(asCtx(ctx), el, { theme: theme(), zoomBucket: s.camera.z, pixelRatio: dpr });
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
      if (liveEl.type === "shape") drawElement(lctx, liveEl, { theme: theme(), zoomBucket: c.z });
      else renderStroke(lctx, liveEl, theme(), c.z);
    }
    if (flash && performance.now() < flash.until) drawSnapFlash(lctx, flash.shape, c, dpr, SNAP_FLASH_COLOR);
    const antsMove = tools.draw(lctx, c, dpr); // marching ants animate while selected
    // Tutor markers sit above the ink and below the DOM overlay; the ring turns while checking.
    const ringTurns = drawTutorMarkers(lctx, markersNow(), c, dpr, theme(), performance.now());
    if (antsMove || ringTurns) requestLive();
  };
  const requestLive = () => {
    if (liveQueued) return;
    liveQueued = true;
    nextFrame(drawLive);
  };
  const setLive = (points: Point[] | null) => {
    const s = st();
    liveEl = snapShape ?? (points && points.length > 0 ? strokeElement(points, { pageId, preset: s.preset }, "live", "") : null);
    requestLive();
  };

  // Tutor: markers from this pane's tutor view, and the gestures that open the card or Ask.
  const pane = paneOfStore(store);
  const tutorView = () => {
    const v = useTutorViews.getState().views[pane];
    return v.pageId === pageId ? v : null;
  };
  const markersNow = () => {
    const v = tutorView();
    const cfg = getSettings();
    return v && cfg.tutorEnabled ? tutorMarkers(v, cfg) : [];
  };
  const tutor = createTutorGestures({
    markerAt: (p) => hitTutorMarker(markersNow(), p, st().camera.z)?.groupId ?? null,
    groupAt: (p) => {
      const v = tutorView();
      const s = st();
      const id = v ? hitTest(store.spatialIndex(), s.elements, p, 4 / s.camera.z) : null;
      return v && id ? groupOfElement(v, id) : null;
    },
    openCard: (id) => useTutorUi.getState().openCard(pane, id),
    openAsk: (id) => useTutorUi.getState().openCard(pane, id, { ask: true }),
    getSettings,
  });

  const tools = createToolController({
    store,
    el: liveCanvas,
    requestLive,
    invalidate: () => {
      cache.invalidate();
      requestStatic();
    },
    renderElement: (ctx, el) => drawElement(ctx, el, { theme: theme(), zoomBucket: st().camera.z }),
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

  /** Append `el` to the snapshot and add it through `apply` (default: as a new element). */
  const commit = (el: Element, apply: () => void = () => st().addElement(el)) => {
    cache.append((ctx) =>
      el.type === "stroke"
        ? renderStroke(asCtx(ctx), el, theme(), st().camera.z)
        : drawElement(asCtx(ctx), el, { theme: theme(), zoomBucket: st().camera.z }),
    );
    committing = true;
    try {
      apply();
    } finally {
      committing = false;
    }
    requestStatic();
  };

  const onSnap = (r: RecognizedShape) => {
    snapShape = snapShapeElement(r, st().preset, pageId, "live", "");
    flash = { shape: r, until: performance.now() + SNAP_FLASH_MS };
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      flash = null;
      requestLive();
    }, SNAP_FLASH_MS);
    setLive(null);
  };

  /** Scribble to erase: when the finished pen stroke is a scribble over ink, erase that instead. */
  const scribbleErased = (raw: readonly Point[]): boolean => {
    const s = st();
    const cfg = getSettings();
    if (!cfg.scribbleToErase || s.preset.type === "highlighter") return false;
    if (!isScribbleGesture(raw, s.camera.z, cfg.scribbleEraseSensitivity).scribble) return false;
    const hits = scribbleHits(s.elements, store.spatialIndex(), raw, s.camera.z);
    if (hits.length === 0) return false; // over empty paper it is just ink
    s.scribbleErase(hits);
    return true;
  };

  const endStroke = () => {
    snap?.cancel();
    snap = null;
    snapShape = null;
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
          // A tap on a tutor marker opens its card instead of starting a selection.
          if ((tool === "cursor" || tool === "lasso") && tutor.markerDown(p)) {
            mode = "none";
            return;
          }
          mode = tool === "none" ? "none" : "tool";
          if (mode === "tool") tools.down(p, tool);
          return;
        }
        tutorStroke = s.preset.type !== "highlighter";
        const abortForAsk = () => {
          // Held still on ink: the stroke becomes "Ask the tutor" (nothing is drawn).
          endStroke();
          builder = null;
          mode = "none";
          setLive(null);
        };
        if (tutorStroke && tutor.inkDown(p, worldToScreen(s.camera, p), abortForAsk)) {
          // Second tap of a double-tap on ink: Ask is open; no stroke.
          tutorStroke = false;
          mode = "none";
          return;
        }
        if (!s.beginStroke()) {
          // Page full: the editor route shows a toast when limitReached flips.
          tutor.cancel();
          tutorStroke = false;
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
        snap = inkSnapAllowed(s.preset.type, set)
          ? createInkSnap({
              dwellMs: Math.min(2000, Math.max(300, set.inkToShapeDwellMs)),
              snapsOnRelease: set.inkToShapeSnapsOnRelease,
              zoom: s.camera.z,
              points: () => builder?.points() ?? [],
              onSnap,
            })
          : null;
        setLive(builder.push([p]));
        snap?.down(p);
      },
      onMove(points, predicted) {
        if (mode === "pan") {
          const s = st();
          const scr = worldToScreen(s.camera, points[points.length - 1]);
          s.setCamera(dragPan(s.camera, scr.x - lastPan.x, scr.y - lastPan.y, clamp));
          lastPan = scr;
        } else if (mode === "draw" && builder) {
          builder.push(points);
          if (points.length > 0) snap?.move(points[points.length - 1]);
          if (tutorStroke && points.length > 0) tutor.inkMove(worldToScreen(st().camera, points[points.length - 1]));
          if (!snapShape) setLive(builder.preview(predicted));
        } else if (mode === "tool") tools.move(points);
      },
      onUp(p) {
        if (mode === "draw" && builder) {
          builder.push([p]);
          const shape = snap?.up() ?? null;
          const raw = builder.points();
          const pts = builder.finish();
          const stroke = pts.length > 0 ? strokeElement(pts, { pageId, preset: st().preset }) : null;
          // A tap on a marker opens its card (the dot is dropped); a tap on ink waits briefly for
          // a second tap (double-tap opens Ask) and is drawn after all if none comes.
          const late = () => {
            if (stroke && ready() && !scribbleErased(raw)) commit(stroke);
          };
          const t = tutorStroke && !shape ? tutor.inkUp(late) : "commit";
          if (stroke && t === "commit") {
            if (shape) {
              const el = snapShapeElement(shape, st().preset, pageId, crypto.randomUUID(), new Date().toISOString());
              commit(el, () => st().replaceStrokeWithShape(stroke, el));
            } else if (!scribbleErased(raw)) commit(stroke);
          }
        } else if (mode === "tool") tools.up();
        if (tutorStroke) tutor.cancel(); // a snapped shape or an aborted stroke: clear any hold
        tutorStroke = false;
        endStroke();
        builder = null;
        mode = "none";
        st().popTempTool();
        setLive(null);
      },
      onCancel() {
        if (mode === "tool") tools.cancel();
        tutor.cancel();
        tutorStroke = false;
        st().popTempTool();
        endStroke();
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
    if (s.editingId !== prev.editingId) cache.invalidate(); // the edited element is left to its DOM editor
    if (s.elements !== prev.elements || s.page !== prev.page || s.loadedPageId !== prev.loadedPageId || s.editingId !== prev.editingId) {
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
  // Tutor state or marker settings changed: redraw the live layer only (never the snapshot).
  const unsubscribeTutor = useTutorViews.subscribe((s, prev) => {
    if (s.views[pane] !== prev.views[pane]) requestLive();
  });
  const unsubscribeSettings = useSettingsStore.subscribe((s, prev) => {
    if (s.settings !== prev.settings) requestLive();
  });
  const unsubscribeSnapshots = boxSnapshots.subscribe(() => {
    cache.invalidate();
    requestStatic();
  });

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
      tutor.dispose();
      disposed = true;
      adapter();
      tools.dispose();
      unsubscribe();
      unsubscribeTutor();
      unsubscribeSettings();
      unsubscribeSnapshots();
      ro?.disconnect();
      window.removeEventListener("resize", resize);
      host.removeEventListener("wheel", onWheel);
      if (rasterTimer !== null) clearTimeout(rasterTimer);
      if (snapTimer !== null) clearTimeout(snapTimer);
      if (flashTimer !== null) clearTimeout(flashTimer);
      snap?.cancel();
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
  const invertImages = useSettingsStore((s) => s.settings.invertImagesInDarkMode);

  useEffect(() => {
    const host = hostRef.current;
    const sc = staticRef.current;
    const lc = liveRef.current;
    if (!host || !sc || !lc) return;
    const engine = createEngine(store, pageId, host, sc, lc, () => useSettingsStore.getState().settings);
    engineRef.current = engine;
    const detachDropPaste = attachDropPaste(host, store);
    return () => {
      detachDropPaste();
      engine.dispose();
      engineRef.current = null;
    };
  }, [pageId, store]);

  useEffect(() => {
    engineRef.current?.restyle();
  }, [theme, invertImages]);

  return (
    <div ref={hostRef} className="canvas-view" data-testid="canvas-view">
      <canvas ref={staticRef} className="canvas-layer" />
      <canvas ref={liveRef} className="canvas-layer canvas-live" />
    </div>
  );
}
