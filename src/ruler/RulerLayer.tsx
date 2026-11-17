// The ruler of one pane: a pane-sized canvas that lets pointers through, a transparent hit strip
// over the body (the body less the rim along each edge) that moves and turns the ruler, two rotate
// handles and, at the middle of the visible part of the ruler, its angle readout. Nothing while the
// ruler is off or the pane presents. Session-only view state: nothing here touches the page or its
// history; only the ruler's pose, the smart guide of its position snap and, for a plain wheel, the
// camera change.
import { useEffect, useRef } from "react";
import type { PointerEvent } from "react";
import { screenToWorld, type Vec2 } from "../canvas/camera";
import { backgroundLineNear, type BackgroundPage } from "../canvas/background";
import { applyWheel, SNAP_BACK_MS, wheelDeltaScale } from "../canvas/gestures";
import { DEFINITE_PALM_RADIUS, noteStylusSeen } from "../canvas/input";
import { guideCandidates, GUIDE_SNAP_PX } from "../canvas/toolInteractions";
import { isCover } from "../covers/cover";
import type { Element as PageElement } from "../model/types";
import { clampToPage, sheetStack, type EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";
import type { Guide } from "../tools/smartGuides";
import { createRulerDrag, type RulerDrag } from "./drag";
import { drawRuler, type RulerColors } from "./draw";
import { angleStep, bodySpan, RULER_RIM_PX, RULER_WIDTH_PX, rotatePose, visibleSpan, type RulerPose } from "./pose";
import RulerAngle from "./RulerAngle";
import RulerHandles from "./RulerHandles";
import { positionSnapApplies, snapRulerPosition, type PositionTargets } from "./snapPosition";
import "./ruler.css";

const FALLBACK: RulerColors = { body: "rgba(110, 168, 230, 0.35)", edge: "#3d6fa8", ink: "#1c3c63" };
const HIT_HEIGHT_PX = RULER_WIDTH_PX - 2 * RULER_RIM_PX;
/** A lone finger on the body moves the ruler only once it has travelled this far (screen px). */
const TOUCH_SLOP_PX = 6;
/** Alt+wheel turns one step per this much wheel delta (screen px), so a trackpad swipe does not spin it. */
const WHEEL_STEP_PX = 100;
/** The Alt+wheel delta is summed while events keep coming within this long (ms) in one direction. */
const WHEEL_IDLE_MS = 200;

const isStylus = (e: { pointerType: string }) => e.pointerType === "pen" || e.pointerType === "eraser";

/** Elements the position snap aims at: no handwriting (it would jump between every stroke's sides). */
const snapsTo = (el: PageElement) => el.type !== "stroke" || isCover(el);

/** The ruler's colours from the theme tokens (re-read when the theme changes). */
function rulerColors(): RulerColors {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    body: read("--ruler-body", FALLBACK.body),
    edge: read("--ruler-edge", FALLBACK.edge),
    ink: read("--ruler-ink", FALLBACK.ink),
  };
}

const mid = (s: [Vec2, Vec2]): Vec2 => ({ x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 });

export default function RulerLayer({ store }: { store: EditorStore }) {
  const pose = store((s) => (s.ruler.on && s.presenting === null ? s.ruler.pose : null));
  if (!pose) return null;
  return <RulerView store={store} pose={pose} />;
}

function RulerView({ store, pose }: { store: EditorStore; pose: RulerPose }) {
  const camera = store((s) => s.camera);
  const viewport = store((s) => s.viewport);
  const units = useSettingsStore((s) => s.settings.rulerUnits);
  const theme = useSettingsStore((s) => s.settings.theme);
  const layerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitRef = useRef<HTMLDivElement>(null);
  const colorsRef = useRef<RulerColors | null>(null);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<RulerDrag | null>(null);
  const capturedRef = useRef(new Set<number>());
  const guideShownRef = useRef(false);
  /** Lone fingers still inside their slop: where each landed and where it is now (pane px). */
  const slopRef = useRef(new Map<number, { landed: Vec2; last: Vec2 }>());
  /** The position snap's targets, gathered once per drag at its first one-pointer move. */
  const targetsRef = useRef<PositionTargets | null>(null);

  if (!dragRef.current) {
    dragRef.current = createRulerDrag({
      pose: () => store.getState().ruler.pose ?? pose,
      camera: () => store.getState().camera,
      angleStep: () => useSettingsStore.getState().settings.rulerAngleSnap,
    });
  }

  /** Client coordinates to pane px (the frame the camera uses). */
  const toLocal = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = layerRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  // The theme attribute is set before this effect runs: read the tokens again.
  useEffect(() => {
    colorsRef.current = rulerColors();
  }, [theme]);

  // One redraw per frame, whatever changed in between.
  useEffect(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(viewport.width * dpr));
      const h = Math.max(1, Math.round(viewport.height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      drawRuler(ctx, pose, camera, viewport, units, colorsRef.current ?? rulerColors(), dpr);
    });
  }, [pose, camera, viewport, units, theme]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
    [],
  );

  /** Shows the position snap's guide, or none; the store is touched only when that changes. */
  const showGuide = (guide: Guide | null) => {
    if (!guide && !guideShownRef.current) return;
    guideShownRef.current = guide !== null;
    store.getState().setGuides(guide ? [guide] : []);
  };

  /** Ends the drag of every pointer on the strip. */
  const releaseAll = () => {
    showGuide(null);
    const drag = dragRef.current;
    for (const id of capturedRef.current) {
      drag?.up(id);
      try {
        hitRef.current?.releasePointerCapture(id);
      } catch {
        /* stale pointer id or no capture support */
      }
    }
    capturedRef.current.clear();
    slopRef.current.clear();
    targetsRef.current = null;
  };

  // A guided stroke freezes the ruler: a drag in progress ends.
  useEffect(() => {
    const unsub = store.subscribe((s) => {
      if (s.rulerGuiding) releaseAll();
    });
    return () => {
      unsub();
      releaseAll();
    };
    // releaseAll reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  // The body (strip and paint) shows while any of it can be in the pane; the handles and the angle
  // readout need the centreline itself in the pane, since they must stay inside it.
  const body = bodySpan(pose, camera, viewport);
  const span = visibleSpan(pose, camera, viewport);
  const hasBody = body !== null;

  // A drag can carry the body off the pane: the strip then unmounts and no pointerup reaches it, so
  // its pointers are released here (touch and pen ids are fresh per contact and would leak).
  // Turning the ruler off, presenting and unmounting are covered by the cleanup above.
  useEffect(() => {
    if (!hasBody) releaseAll();
    // releaseAll reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasBody]);

  // Wheel over the strip, the handles or the angle button: Alt turns the ruler, otherwise the page
  // scrolls or zooms as elsewhere. Native and non-passive so preventDefault holds; the layer itself
  // lets pointers through, so only its controls ever see a wheel. The angle field keeps its own.
  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    let snapTimer: ReturnType<typeof setTimeout> | null = null;
    /** Alt+wheel delta not yet turned into steps, and when the last Alt+wheel event came. */
    let turnAcc = 0;
    let turnAt = -Infinity;
    const onWheel = (e: WheelEvent) => {
      if (e.target instanceof Element && e.target.closest(".ruler-angle-field")) return;
      e.preventDefault();
      e.stopPropagation();
      const s = store.getState();
      const cur = s.ruler.pose;
      if (!cur) return;
      const settings = useSettingsStore.getState().settings;
      if (e.altKey) {
        // A guided stroke freezes the edge at pen-down.
        if (s.rulerGuiding) return;
        // Shift+wheel may arrive as a horizontal delta.
        const d = (e.deltaY !== 0 ? e.deltaY : e.deltaX) * wheelDeltaScale(e.deltaMode);
        if (d === 0) return;
        // Summed while it keeps coming one way; a pause or a change of direction starts afresh.
        if (e.timeStamp - turnAt > WHEEL_IDLE_MS || Math.sign(d) !== Math.sign(turnAcc)) turnAcc = 0;
        turnAt = e.timeStamp;
        turnAcc += d;
        const steps = Math.trunc(turnAcc / WHEEL_STEP_PX);
        if (steps === 0) return;
        turnAcc -= steps * WHEEL_STEP_PX;
        // A mouse notch (a step or more on its own) turns whole steps and leaves no remainder behind.
        if (Math.abs(d) >= WHEEL_STEP_PX) turnAcc = 0;
        const sp = visibleSpan(cur, s.camera, s.viewport) ?? bodySpan(cur, s.camera, s.viewport);
        if (!sp) return;
        const step = angleStep(settings.rulerAngleSnap, e.shiftKey);
        s.setRulerPose(rotatePose(cur, screenToWorld(s.camera, mid(sp)), -steps * step));
        return;
      }
      const clamp = (c: typeof s.camera) => clampToPage(c, store.getState());
      s.setCamera(applyWheel(s.camera, e, toLocal(e), settings.scrollBehavior, clamp));
      // As on the canvas: an overscroll springs back shortly after the last wheel event.
      if (snapTimer !== null) clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        snapTimer = null;
        store.getState().setCamera(clamp(store.getState().camera));
      }, SNAP_BACK_MS);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (snapTimer !== null) clearTimeout(snapTimer);
    };
    // toLocal reads a ref only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (isStylus(e)) noteStylusSeen(e.timeStamp);
    if (store.getState().rulerGuiding) return;
    const touch = e.pointerType === "touch";
    if (touch) {
      // Only a definite palm (radius above 45 px) is ignored, unless palm rejection is off: a finger
      // moving the ruler while the pen is in the other hand, or right after writing, is the normal
      // gesture, so the smaller palm thresholds and the "stylus seen" window do not apply here; the
      // slop absorbs small accidental contacts.
      const radius = Math.max(e.width || 0, e.height || 0) / 2;
      if (useSettingsStore.getState().settings.palmRejection !== "off" && radius > DEFINITE_PALM_RADIUS) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    const drag = dragRef.current;
    const at = toLocal(e);
    if (!drag?.down(e.pointerId, at)) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom or a stale pointer id */
    }
    capturedRef.current.add(e.pointerId);
    targetsRef.current = null;
    if (drag.count() > 1) {
      // A second pointer: a finger still inside its slop takes part from where it is now.
      for (const [id, s] of slopRef.current) if (id !== e.pointerId) drag.down(id, s.last);
      slopRef.current.clear();
    } else if (touch) {
      slopRef.current.set(e.pointerId, { landed: at, last: at });
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (isStylus(e)) noteStylusSeen(e.timeStamp);
    if (!capturedRef.current.has(e.pointerId)) return;
    e.stopPropagation();
    const drag = dragRef.current;
    if (!drag) return;
    const at = toLocal(e);
    const slop = slopRef.current.get(e.pointerId);
    if (slop) {
      slop.last = at;
      if (Math.hypot(at.x - slop.landed.x, at.y - slop.landed.y) < TOUCH_SLOP_PX) return;
      // Past the slop: the ruler follows from here on, without catching up the distance so far.
      slopRef.current.delete(e.pointerId);
      drag.down(e.pointerId, at);
      return;
    }
    const next = drag.move(e.pointerId, at);
    if (!next) return;
    // One pointer only, at 0° or 90°, and not while Shift is held. The drag keeps its own unsnapped
    // pose, so the snap lets go as soon as the edge is past the threshold.
    if (drag.count() === 1 && !e.shiftKey && positionSnapApplies(next)) {
      targetsRef.current ??= positionTargets();
      const snapped = snapRulerPosition(next, store.getState().camera, targetsRef.current, GUIDE_SNAP_PX);
      store.getState().setRulerPose(snapped.pose);
      showGuide(snapped.guide);
      return;
    }
    showGuide(null);
    store.getState().setRulerPose(next);
  };

  /**
   * Background lines while snapToGrid is on, element sides and centres while smartGuides is on.
   * Handwriting is left out (covers are kept): over notes the ruler would jump between every
   * stroke's top, middle and bottom.
   */
  const positionTargets = (): PositionTargets => {
    const s = store.getState();
    const settings = useSettingsStore.getState().settings;
    const page = s.page;
    let lineNear: PositionTargets["lineNear"] = () => null;
    if (settings.snapToGrid && page) {
      const stack = sheetStack(s);
      const bgPage: BackgroundPage = { mode: page.mode, width: stack.width, height: stack.height, count: stack.count };
      lineNear = (axis, v) => backgroundLineNear(page.backgroundConfig, bgPage, axis, v);
    }
    return { lineNear, rects: settings.smartGuides ? guideCandidates(store, new Set(), snapsTo) : [], viewport: s.viewport };
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (!capturedRef.current.delete(e.pointerId)) return;
    dragRef.current?.up(e.pointerId);
    slopRef.current.delete(e.pointerId);
    targetsRef.current = null;
    if (capturedRef.current.size === 0) showGuide(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const centre = body ? mid(body) : null;
  // Past the body's span by twice the pane's diagonal on the whole, so the body is grabbable wherever
  // it shows at every angle; the layer clips the rest.
  const hitLength = body
    ? Math.hypot(body[1].x - body[0].x, body[1].y - body[0].y) + 2 * Math.hypot(viewport.width, viewport.height)
    : 0;
  return (
    <div ref={layerRef} className="ruler-layer">
      <canvas
        ref={canvasRef}
        className="ruler-canvas"
        style={{ width: `${viewport.width}px`, height: `${viewport.height}px`, pointerEvents: "none" }}
      />
      {centre && (
        <div
          ref={hitRef}
          className="ruler-hit"
          aria-hidden="true"
          style={{
            left: `${centre.x - hitLength / 2}px`,
            top: `${centre.y - HIT_HEIGHT_PX / 2}px`,
            width: `${hitLength}px`,
            height: `${HIT_HEIGHT_PX}px`,
            transform: `rotate(${-pose.angle}deg)`,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onPointerEnd}
        />
      )}
      {span && (
        <>
          <RulerHandles store={store} span={span} toLocal={toLocal} />
          <RulerAngle store={store} pose={pose} at={mid(span)} viewport={viewport} />
        </>
      )}
    </div>
  );
}
