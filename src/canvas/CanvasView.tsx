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
import ZoomIndicator from "./ZoomIndicator";
import LineCapsPopover from "../components/LineCapsPopover";
import { ConnectorLabelPopover } from "../components/LabelPopover";
import { openLineCaps } from "../stores/lineCaps";
import MediaLayer from "../media/MediaLayer";
import { paintBackground, type SurfaceColors } from "./background";
import { screenToWorld, worldToScreen, type Camera, type Vec2 } from "./camera";
import { applyWheel, dragPan, pinchCamera, SNAP_BACK_MS, type PinchStart } from "./gestures";
import { createPointerAdapter, type PalmRejection } from "./input";
import { canSwipeAt, detectSwipe, type SwipeSample } from "./pageSwipe";
import { turnPage } from "../keys/editorCommands";
import { SnapshotCache, type SnapshotContext } from "./snapshot";
import { createInkSnap, drawSnapFlash, dwellSlopFor, inkSnapAllowed, snapShapeElement, SNAP_FLASH_MS, type InkSnap } from "./inkSnap";
import { createStrokeBuilder, strokeElement, type StrokeBuilder } from "./strokeCommit";
import type { RecognizedShape } from "../shapes/recognize";
import { createDismissPress, createToolController, pointerTool } from "./toolInteractions";
import { createTutorInk } from "./tutorInk";
import { consumeDismissDown, paneOfStore } from "../stores/tutor";
import { useAiStatus } from "../tutor/aiStatus";
import { drawTutorMarkers, drawTutorTip, hitTutorMarker } from "../tutor/overlay";
import { useTutorViews } from "../tutor/useTutor";
import { attachDropPaste } from "./dropPaste";
import { createPenInkHaptics } from "./haptics";

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
  let mode: "none" | "draw" | "pan" | "tool" | "marker" = "none";
  /** Select-tool press on a tutor marker: where and with which tool (decided on up or move). */
  let markerPress: { p: Point; tool: "cursor" | "lasso"; points: Point[] } | null = null;
  let builder: StrokeBuilder | null = null;
  let liveEl: Element | null = null;
  /** Ink to shape for the stroke in progress, and the shape it snapped to (shown instead of it). */
  let snap: InkSnap | null = null;
  let snapShape: Element | null = null;
  let flash: { shape: RecognizedShape; until: number } | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPan: Vec2 = { x: 0, y: 0 };
  let pinchStart: PinchStart | null = null;
  /** The current touch pan, for swipe-to-turn: screen samples, camera at its start, and whether it
   * stayed a one-finger pan (a pinch or second finger rules it out). */
  let swipe: { samples: SwipeSample[]; camera: Camera; oneFinger: boolean } | null = null;
  /** True while our own commit updates the store (the element is already in the snapshot). */
  let committing = false;
  let sheetCount = 0;
  /** The pen stroke in progress takes part in tutor gestures (tap / double-tap / hold on ink). */
  let tutorStroke = false;
  /** The pen press that closed the tutor card (its stroke is kept unless it was a bare tap). */
  const dismissPress = createDismissPress();
  /** Group whose "couldn't check" marker the mouse hovers (its label is drawn). */
  let hoverGroup: string | null = null;

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
    const tutorMarkersNow = markersNow();
    const ringTurns = drawTutorMarkers(lctx, tutorMarkersNow, c, dpr, theme(), performance.now());
    const hovered = hoverGroup ? tutorMarkersNow.find((m) => m.groupId === hoverGroup) : undefined;
    if (hovered) drawTutorTip(lctx, hovered, c, dpr);
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
  const { gestures: tutor, markers: markersNow } = createTutorInk({ store, pageId, pane, getSettings });

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

  const penInk = createPenInkHaptics(liveCanvas);
  const onSnap = (r: RecognizedShape) => {
    penInk.click();
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
    penInk.stop();
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
        const dismissing = consumeDismissDown();
        const { tool, temp } = pointerTool(s.tool, s.panHold, info, getSettings());
        // This press closed the tutor card. With a select tool it only dismisses; a pen stroke is
        // kept (ink always wins) and only a bare tap's dot is dropped on pen-up.
        if (dismissing && !isInkTool(tool)) {
          mode = "none";
          return;
        }
        if (temp) s.pushTempTool(temp);
        if (tool === "pan") {
          mode = "pan";
          lastPan = worldToScreen(s.camera, p);
          return;
        }
        if (!isInkTool(tool)) {
          // A press on a tutor marker: a tap opens its card (on up), a drag selects as usual.
          if ((tool === "cursor" || tool === "lasso") && tutor.selectDown(p, worldToScreen(s.camera, p))) {
            mode = "marker";
            markerPress = { p, tool, points: [] };
            return;
          }
          mode = tool === "none" ? "none" : "tool";
          if (mode === "tool") tools.down(p, tool);
          return;
        }
        // No tutor gestures (double-tap, hold, marker tap) for the press that closed the card.
        tutorStroke = !dismissing && s.preset.type !== "highlighter";
        if (dismissing) dismissPress.down(worldToScreen(s.camera, p));
        const abortForAsk = () => {
          // Held still on ink: the stroke becomes "Ask the tutor" (nothing is drawn).
          endStroke();
          builder = null;
          mode = "none";
          setLive(null);
        };
        if (tutorStroke) tutor.inkDown(p, worldToScreen(s.camera, p), abortForAsk);
        if (!s.beginStroke()) {
          // Page full: the editor route shows a toast when limitReached flips.
          tutor.cancel();
          dismissPress.cancel();
          tutorStroke = false;
          mode = "none";
          return;
        }
        const set = getSettings();
        mode = "draw";
        penInk.start(info.pointerType);
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
              slopPx: dwellSlopFor(info.pointerType),
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
          if (dismissPress.active() && points.length > 0) dismissPress.move(worldToScreen(st().camera, points[points.length - 1]));
          if (!snapShape) setLive(builder.preview(predicted));
        } else if (mode === "tool") tools.move(points);
        else if (mode === "marker" && markerPress && points.length > 0) {
          markerPress.points.push(...points);
          if (tutor.selectMove(worldToScreen(st().camera, points[points.length - 1]))) {
            // Dragged off the marker: a normal selection gesture from where it started, replaying
            // every point since the press (the lasso keeps its full outline).
            mode = "tool";
            tools.down(markerPress.p, markerPress.tool);
            tools.move(markerPress.points);
          }
        }
      },
      onUp(p) {
        if (mode === "draw" && builder) {
          builder.push([p]);
          const shape = snap?.up() ?? null;
          const raw = builder.points();
          const pts = builder.finish();
          const stroke = pts.length > 0 ? strokeElement(pts, { pageId, preset: st().preset }) : null;
          // Committed at once, except a tap on a marker's blank area (opens its card) or the second
          // tap of a double-tap on ink (opens Ask); see createTutorGestures.
          if (dismissPress.active()) dismissPress.move(worldToScreen(st().camera, p));
          const dismissed = dismissPress.up();
          const t = dismissed === "discard" ? "discard" : tutorStroke && !shape ? tutor.inkUp(stroke?.id) : "commit";
          if (stroke && t === "commit") {
            if (shape) {
              const el = snapShapeElement(shape, st().preset, pageId, crypto.randomUUID(), new Date().toISOString());
              let added = false;
              commit(el, () => {
                added = st().replaceStrokeWithShape(stroke, el);
              });
              // A straightened line/arrow offers its end caps next to the end point.
              if (added && (el.shapeType === "line" || el.shapeType === "arrow") && getSettings().lineCapsPopover) openLineCaps(store, el.id);
            } else if (!scribbleErased(raw)) commit(stroke);
          }
        } else if (mode === "tool") tools.up();
        else if (mode === "marker") tutor.selectUp();
        markerPress = null;
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
        dismissPress.cancel();
        tutor.cancel();
        tutorStroke = false;
        markerPress = null;
        st().popTempTool();
        endStroke();
        builder = null;
        mode = "none";
        setLive(null);
      },
      onPanStart(at, timeStamp) {
        swipe = { samples: [{ x: at.x, y: at.y, t: timeStamp }], camera: st().camera, oneFinger: true };
      },
      onPan(dx, dy, info) {
        const s = st();
        s.setCamera(dragPan(s.camera, dx, dy, clamp));
        if (!swipe) return;
        if (info.fingers > 1) swipe.oneFinger = false;
        const last = swipe.samples[swipe.samples.length - 1];
        swipe.samples.push({ x: last.x + dx, y: last.y + dy, t: info.timeStamp });
      },
      onPanEnd(end) {
        const g = swipe;
        swipe = null;
        const s = st();
        // A cancelled contact or one that rested while the pen wrote is never a page turn.
        if (!g?.oneFinger || end.cancelled || end.drewMeanwhile || !s.page) return;
        // The lift time closes the gesture: a flick followed by a hold fails the time window.
        const last = g.samples[g.samples.length - 1];
        g.samples.push({ x: last.x, y: last.y, t: end.timeStamp });
        // A leftward swipe (-1) turns to the next page, a rightward one to the previous page.
        const dir = detectSwipe(g.samples);
        if (dir !== null && canSwipeAt(g.camera, s.page, s.viewport, dir, sheetStack(s))) void turnPage(dir === -1 ? 1 : -1);
      },
      onPinch(g) {
        if (swipe) swipe.oneFinger = false;
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
      get fingerAction() {
        return getSettings().fingerAction;
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
    if (s.selection !== prev.selection || s.guides !== prev.guides || s.tool !== prev.tool || s.tempTool !== prev.tempTool) requestLive();
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
  const unsubscribeAiStatus = useAiStatus.subscribe(() => requestLive());
  const unsubscribeSnapshots = boxSnapshots.subscribe(() => {
    cache.invalidate();
    requestStatic();
  });

  host.addEventListener("wheel", onWheel, { passive: false });
  // Mouse hover over a "couldn't check" marker shows its label (pen and touch get the tap instead).
  const onHover = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || e.buttons !== 0) return;
    const r = host.getBoundingClientRect();
    const s = st();
    const m = hitTutorMarker(markersNow(), screenToWorld(s.camera, { x: e.clientX - r.left, y: e.clientY - r.top }), s.camera.z, 0);
    const id = m?.kind === "unchecked" ? m.groupId : null;
    if (id !== hoverGroup) {
      hoverGroup = id;
      requestLive();
    }
  };
  const onHoverLeave = () => {
    if (hoverGroup === null) return;
    hoverGroup = null;
    requestLive();
  };
  host.addEventListener("pointermove", onHover);
  host.addEventListener("pointerleave", onHoverLeave);
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
      penInk.dispose();
      tools.dispose();
      unsubscribe();
      unsubscribeTutor();
      unsubscribeSettings();
      unsubscribeAiStatus();
      unsubscribeSnapshots();
      ro?.disconnect();
      window.removeEventListener("resize", resize);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("pointermove", onHover);
      host.removeEventListener("pointerleave", onHoverLeave);
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
    <>
      <div ref={hostRef} className="canvas-view" data-testid="canvas-view">
        <canvas ref={staticRef} className="canvas-layer" />
        <canvas ref={liveRef} className="canvas-layer canvas-live" />
      </div>
      <MediaLayer store={store} />
      <ZoomIndicator store={store} />
      <LineCapsPopover store={store} />
      <ConnectorLabelPopover store={store} />
    </>
  );
}
