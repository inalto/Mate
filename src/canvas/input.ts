// Pointer input adapter (spec 03 §2): drawing pointers (pen, mouse, permitted touch) go to
// onDown/onMove/onUp in world coordinates; other touches become pan/pinch gestures.
import type { Point } from "../model/types";
import { screenToWorld, type Camera, type Vec2 } from "./camera";

export type PalmRejection = "off" | "low" | "high";

export interface PointerInfo {
  pointerType: string;
  buttons: number;
  /** Pen barrel button held (bit 2). */
  isBarrel: boolean;
  /** Pen eraser end (bit 32 or pointerType "eraser"). */
  isEraserEnd: boolean;
}

export interface PinchGesture {
  phase: "start" | "move" | "end";
  /** Midpoint between the two contacts, element-relative screen px. */
  mid: Vec2;
  /** Distance between the two contacts in screen px. */
  dist: number;
}

export interface PointerHandlers {
  onDown(p: Point, info: PointerInfo): void;
  /** Coalesced points since the last move (world units) and predicted points (live draw only). */
  onMove(points: Point[], predicted: Point[]): void;
  onUp(p: Point): void;
  onCancel(): void;
  /** One-finger pan for touches that may not draw (screen px deltas). */
  onPan?(dx: number, dy: number): void;
  onPanEnd?(): void;
  onPinch?(g: PinchGesture): void;
}

export interface PointerAdapterOptions {
  palmRejection: PalmRejection;
  drawWithFinger: boolean;
  getCamera(): Camera;
  /** Two-finger pinch zoom (default true); when off two fingers pan. */
  pinchToZoom?: boolean;
}

export const BUTTON_TIP = 1;
export const BUTTON_BARREL = 2;
export const BUTTON_ERASER = 32;
export const STYLUS_SEEN_WINDOW_MS = 2000;
const DEFINITE_PALM_RADIUS = 45;

export function pointerInfo(e: PointerEvent): PointerInfo {
  const pen = e.pointerType === "pen" || e.pointerType === "eraser";
  return {
    pointerType: e.pointerType,
    buttons: e.buttons,
    isBarrel: pen && (e.buttons & BUTTON_BARREL) !== 0,
    isEraserEnd: e.pointerType === "eraser" || (pen && (e.buttons & BUTTON_ERASER) !== 0),
  };
}

/** Palm test for a touch contact: diameter above 20 px (high) / 40 px (low), or radius > 45 px. */
export function isPalmContact(e: Pick<PointerEvent, "width" | "height">, mode: PalmRejection): boolean {
  if (mode === "off") return false;
  const diameter = Math.max(e.width || 0, e.height || 0);
  if (diameter / 2 > DEFINITE_PALM_RADIUS) return true;
  return diameter > (mode === "high" ? 20 : 40);
}

/** Attach the adapter to `el`; returns a disposer. Options are read at event time. */
export function createPointerAdapter(
  el: HTMLElement,
  handlers: PointerHandlers,
  opts: PointerAdapterOptions,
): () => void {
  let drawId: number | null = null;
  let drawType = "";
  let drawLast: Vec2 = { x: 0, y: 0 };
  let lastStylusAt = -Infinity;
  const rejected = new Set<number>();
  /** Pointers whose capture we released ourselves; their (async) lostpointercapture is ignored. */
  const expectedRelease = new Set<number>();
  const touches = new Map<number, Vec2>();
  let pinching = false;

  const local = (e: PointerEvent): Vec2 => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toPoint = (e: PointerEvent, rect: DOMRect): Point => {
    const w = screenToWorld(opts.getCamera(), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    const p: Point = { x: w.x, y: w.y, pressure: e.pressure, timestamp: e.timeStamp };
    if (e.pointerType === "pen" && (e.tiltX || e.tiltY)) {
      p.tiltX = e.tiltX;
      p.tiltY = e.tiltY;
    }
    return p;
  };
  const capture = (id: number) => {
    try {
      el.setPointerCapture?.(id);
    } catch {
      /* pointer already gone */
    }
  };
  const release = (id: number) => {
    try {
      if (el.hasPointerCapture?.(id)) {
        el.releasePointerCapture(id);
        expectedRelease.add(id);
      }
    } catch {
      /* ignore */
    }
  };

  const pinchState = (): PinchGesture | null => {
    if (touches.size < 2) return null;
    const [a, b] = [...touches.values()];
    return {
      phase: "move",
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  };
  const pinchEnabled = () => opts.pinchToZoom !== false && !!handlers.onPinch;

  const cancelDraw = () => {
    if (drawId === null) return;
    release(drawId);
    drawId = null;
    handlers.onCancel();
  };

  const addGestureTouch = (e: PointerEvent) => {
    touches.set(e.pointerId, local(e));
    capture(e.pointerId);
    if (touches.size === 2 && pinchEnabled()) {
      pinching = true;
      handlers.onPinch!({ ...pinchState()!, phase: "start" });
    }
  };

  const isStylus = (e: PointerEvent) => e.pointerType === "pen" || e.pointerType === "eraser";

  const onDown = (e: PointerEvent) => {
    const t = e.pointerType;
    if (isStylus(e)) lastStylusAt = e.timeStamp;
    if (t === "touch") {
      if (drawId !== null && drawType !== "touch") {
        // Touch during a pen/mouse stroke is a resting hand: reject the whole contact.
        rejected.add(e.pointerId);
        return;
      }
      const palm =
        isPalmContact(e, opts.palmRejection) ||
        (opts.palmRejection !== "off" && e.timeStamp - lastStylusAt < STYLUS_SEEN_WINDOW_MS);
      if (palm) {
        rejected.add(e.pointerId);
        return;
      }
      if (drawId !== null && drawType === "touch") {
        // A second finger: the stroke becomes a two-finger gesture.
        const first = drawId;
        cancelDraw();
        touches.set(first, drawLast);
        addGestureTouch(e);
        return;
      }
      if (opts.drawWithFinger && drawId === null && touches.size === 0) {
        drawId = e.pointerId;
        drawType = t;
        drawLast = local(e);
        capture(e.pointerId);
        handlers.onDown(toPoint(e, el.getBoundingClientRect()), pointerInfo(e));
        return;
      }
      if (drawId === null) addGestureTouch(e);
      return;
    }
    // Pen / mouse: one drawing pointer at a time; right mouse button is ignored.
    if (t === "mouse" && e.button === 2) return;
    // A new pen/mouse down while a stroke is open means its up/cancel was lost (or it was a
    // finger stroke, which the pen overrides): cancel the stale stroke and start fresh.
    if (drawId !== null) cancelDraw();
    drawId = e.pointerId;
    drawType = t;
    capture(e.pointerId);
    e.preventDefault();
    handlers.onDown(toPoint(e, el.getBoundingClientRect()), pointerInfo(e));
  };

  const onMove = (e: PointerEvent) => {
    if (isStylus(e)) lastStylusAt = e.timeStamp; // hover counts as "stylus seen"
    if (e.pointerId === drawId && drawType !== "touch" && e.buttons === 0) {
      end(e, false); // buttons released without a pointerup reaching us
      return;
    }
    if (e.pointerId === drawId) {
      drawLast = local(e);
      const rect = el.getBoundingClientRect();
      const co = e.getCoalescedEvents?.() ?? [];
      const pr = e.getPredictedEvents?.() ?? [];
      const pts = (co.length > 0 ? co : [e]).map((x) => toPoint(x, rect));
      handlers.onMove(pts, pr.map((x) => toPoint(x, rect)));
      return;
    }
    const prev = touches.get(e.pointerId);
    if (!prev) return;
    const next = local(e);
    touches.set(e.pointerId, next);
    if (pinching) {
      const g = pinchState();
      if (g) handlers.onPinch!(g);
    } else {
      // One finger (or two with pinch disabled): pan by this contact's delta, averaged over contacts.
      handlers.onPan?.((next.x - prev.x) / touches.size, (next.y - prev.y) / touches.size);
    }
  };

  function end(e: PointerEvent, cancelled: boolean) {
    if (isStylus(e)) lastStylusAt = e.timeStamp;
    rejected.delete(e.pointerId);
    if (e.pointerId === drawId) {
      release(e.pointerId);
      drawId = null;
      if (cancelled) handlers.onCancel();
      else handlers.onUp(toPoint(e, el.getBoundingClientRect()));
      return;
    }
    if (!touches.has(e.pointerId)) return;
    release(e.pointerId);
    if (pinching) {
      const g = pinchState();
      if (g) handlers.onPinch!({ ...g, phase: "end" });
      pinching = false;
    }
    touches.delete(e.pointerId);
    if (touches.size === 0) handlers.onPanEnd?.();
  }
  const onUp = (e: PointerEvent) => end(e, false);
  const onCancelEv = (e: PointerEvent) => end(e, true);
  /** Capture lost without an up/cancel (focus change, alt-tab) cancels the open stroke. Releases we
   * made ourselves (finger → pinch, restart, normal up) and non-drawing pointers are ignored. */
  const onLostCapture = (e: PointerEvent) => {
    if (expectedRelease.delete(e.pointerId)) return;
    if (e.pointerId === drawId) end(e, true);
  };
  const onContext = (e: Event) => e.preventDefault();

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancelEv);
  el.addEventListener("lostpointercapture", onLostCapture);
  el.addEventListener("contextmenu", onContext);
  return () => {
    cancelDraw();
    for (const id of touches.keys()) release(id);
    touches.clear();
    rejected.clear();
    expectedRelease.clear();
    pinching = false;
    el.removeEventListener("lostpointercapture", onLostCapture);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancelEv);
    el.removeEventListener("contextmenu", onContext);
  };
}
