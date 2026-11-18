// Pointer input adapter (spec 03 §2): drawing pointers (pen, mouse, permitted touch) go to
// onDown/onMove/onUp in world coordinates; other touches become pan/pinch gestures.
import type { FingerAction, Point } from "../model/types";
import { screenToWorld, type Camera, type Vec2 } from "./camera";

export type { FingerAction };

/**
 * settings.palmRejection. Rules for a touch contact (pen and mouse are never rejected):
 * - "off": every touch is accepted, the 45 px definite-palm check included (draws per
 *   settings.fingerAction, else pans/pinches).
 * - "standard" ("low" is the legacy name): rejected when its radius exceeds 45 px (a definite
 *   palm); when a stylus was seen (down, move or hover) in the last 2 s, a contact whose diameter
 *   exceeds 40 px never draws, and with fingerAction "auto"/"pan" no touch draws then.
 * - "high": as standard, with a 20 px diameter threshold.
 * Without a recent stylus the 20/40 px thresholds do not apply: a fingertip (25–50 px) draws.
 * A touch that may not draw because of a recent stylus is held back, never dropped: it pans once it
 * has moved `HELD_PAN_SLOP_PX`, forms a gesture with a second finger, and is dropped for good only
 * when the pen goes down (it was the hand settling before the next stroke).
 * A touch that lands while a pen/mouse stroke is open is always rejected (resting hand).
 */
export type PalmRejection = "off" | "standard" | "low" | "high";

export interface PointerInfo {
  pointerType: string;
  buttons: number;
  /** Pen barrel button held (bit 2). */
  isBarrel: boolean;
  /** Pen eraser end (bit 32 or pointerType "eraser"). */
  isEraserEnd: boolean;
  shiftKey: boolean;
}

export interface PinchGesture {
  phase: "start" | "move" | "end";
  /** Midpoint between the two contacts, element-relative screen px. */
  mid: Vec2;
  /** Distance between the two contacts in screen px. */
  dist: number;
}

export interface PanInfo {
  /** Contacts down (the delta is averaged over them). */
  fingers: number;
  /** Event timeStamp (ms). */
  timeStamp: number;
}

export interface PanEndInfo {
  /** A gesture touch ended in pointercancel (the system took the contact): never a swipe. */
  cancelled: boolean;
  /** Event timeStamp (ms) of the last lift. */
  timeStamp: number;
  /** A pen/mouse pointer was drawing at some point during the gesture (a resting palm). */
  drewMeanwhile: boolean;
  /** Most contacts down at once during the gesture. */
  fingers: number;
  /** Furthest any contact moved from where it landed (screen px). */
  travel: number;
}

export interface PointerHandlers {
  onDown(p: Point, info: PointerInfo): void;
  /** Coalesced points since the last move (world units) and predicted points (live draw only). */
  onMove(points: Point[], predicted: Point[]): void;
  onUp(p: Point): void;
  onCancel(): void;
  /** First gesture touch landed (element-relative screen px, event timeStamp ms). */
  onPanStart?(at: Vec2, timeStamp: number): void;
  /** One-finger pan for touches that may not draw (screen px deltas). */
  onPan?(dx: number, dy: number, info: PanInfo): void;
  /** Last gesture touch lifted or cancelled. */
  onPanEnd?(info: PanEndInfo): void;
  onPinch?(g: PinchGesture): void;
}

export interface PointerAdapterOptions {
  palmRejection: PalmRejection;
  fingerAction: FingerAction;
  getCamera(): Camera;
  /** Two-finger pinch zoom (default true); when off two fingers pan. */
  pinchToZoom?: boolean;
}

export const BUTTON_TIP = 1;
export const BUTTON_BARREL = 2;
export const BUTTON_ERASER = 32;
export const STYLUS_SEEN_WINDOW_MS = 2000;
export const DEFINITE_PALM_RADIUS = 45;
/** How far (screen px) a finger held back after the pen must move before it pans the page. */
export const HELD_PAN_SLOP_PX = 10;

/** When a stylus was last seen by any surface (event timeStamp, ms): the canvas adapters and the
 * ruler share it, so a palm on the ruler is judged against the pen that just wrote on the page. */
let sharedStylusAt = -Infinity;

/** Notes that a stylus was seen (down, move, hover or up) at `now` (event timeStamp, ms). */
export function noteStylusSeen(now: number): void {
  sharedStylusAt = now;
}

/** When a stylus was last seen anywhere (event timeStamp, ms); −Infinity if never. */
export function stylusSeenAt(): number {
  return sharedStylusAt;
}

export function pointerInfo(e: PointerEvent): PointerInfo {
  const pen = e.pointerType === "pen" || e.pointerType === "eraser";
  return {
    pointerType: e.pointerType,
    buttons: e.buttons,
    isBarrel: pen && (e.buttons & BUTTON_BARREL) !== 0,
    isEraserEnd: e.pointerType === "eraser" || (pen && (e.buttons & BUTTON_ERASER) !== 0),
    shiftKey: e.shiftKey,
  };
}

/** Palm test for a touch contact: diameter above 20 px (high) / 40 px (standard), or radius > 45 px. */
export function isPalmContact(e: Pick<PointerEvent, "width" | "height">, mode: PalmRejection): boolean {
  if (mode === "off") return false;
  const diameter = Math.max(e.width || 0, e.height || 0);
  if (diameter / 2 > DEFINITE_PALM_RADIUS) return true;
  return diameter > (mode === "high" ? 20 : 40);
}

const contactRadius = (e: Pick<PointerEvent, "width" | "height">) => Math.max(e.width || 0, e.height || 0) / 2;

/**
 * May a single touch contact draw? Never with "pan" or for a definite palm (radius > 45 px, unless
 * palm rejection is off); with "auto" only when no stylus was seen in the last
 * `STYLUS_SEEN_WINDOW_MS`. The 20/40 px palm thresholds apply only when a stylus was seen recently.
 */
export function fingerMayDraw(
  e: Pick<PointerEvent, "width" | "height">,
  mode: PalmRejection,
  fingerAction: FingerAction,
  lastStylusAt: number,
  now: number,
): boolean {
  if (fingerAction === "pan") return false;
  const stylusRecent = now - lastStylusAt < STYLUS_SEEN_WINDOW_MS;
  if (fingerAction === "auto" && stylusRecent) return false;
  if (mode === "off") return true;
  if (contactRadius(e) > DEFINITE_PALM_RADIUS) return false;
  return !stylusRecent || !isPalmContact(e, mode);
}

/** Why a touch contact is ignored as a drawing/pan start: "palm" (a definite palm: dropped for
 * good), "stylus" (a contact right after the pen that may not draw, because fingers do not draw
 * then or because it is palm-sized: held back, it counts as a gesture once it moves or a second
 * finger lands, and is dropped if the pen goes down first), or null (accepted). A fingertip is
 * 25–50 px across, so size alone cannot tell it from a palm's edge: only the pen coming down can. */
export function touchRejected(
  e: Pick<PointerEvent, "width" | "height">,
  mode: PalmRejection,
  fingerAction: FingerAction,
  stylusRecent: boolean,
): "palm" | "stylus" | null {
  if (mode === "off") return null;
  if (contactRadius(e) > DEFINITE_PALM_RADIUS) return "palm";
  if (!stylusRecent) return null;
  return fingerAction !== "draw" || isPalmContact(e, mode) ? "stylus" : null;
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
  /** Contacts that landed right after the pen, held back until they move or a second finger lands:
   * where each one landed and where it is now. */
  const pending = new Map<number, { from: Vec2; at: Vec2 }>();
  let pinching = false;
  /** Current gesture: a touch was cancelled / a pen or mouse stroke was open at some point. */
  let panCancelled = false;
  let drewMeanwhile = false;
  /** Current gesture: where each contact landed, the most down at once, the furthest one moved. */
  const landed = new Map<number, Vec2>();
  let maxFingers = 0;
  let travel = 0;

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

  const addGestureTouchAt = (id: number, at: Vec2, timeStamp: number) => {
    if (touches.size === 0) {
      panCancelled = false;
      drewMeanwhile = drawId !== null && drawType !== "touch";
      landed.clear();
      maxFingers = 0;
      travel = 0;
      handlers.onPanStart?.(at, timeStamp);
    }
    touches.set(id, at);
    landed.set(id, at);
    maxFingers = Math.max(maxFingers, touches.size);
    capture(id);
    if (touches.size === 2 && pinchEnabled()) {
      pinching = true;
      handlers.onPinch!({ ...pinchState()!, phase: "start" });
    }
  };
  const addGestureTouch = (e: PointerEvent) => addGestureTouchAt(e.pointerId, local(e), e.timeStamp);

  const isStylus = (e: PointerEvent) => e.pointerType === "pen" || e.pointerType === "eraser";
  /** This adapter's own record, mirrored into the shared one the ruler reads. */
  const seeStylus = (now: number) => {
    lastStylusAt = now;
    noteStylusSeen(now);
  };

  const onDown = (e: PointerEvent) => {
    const t = e.pointerType;
    if (isStylus(e)) seeStylus(e.timeStamp);
    if (t === "touch") {
      if (drawId !== null && drawType !== "touch") {
        // Touch during a pen/mouse stroke is a resting hand: reject the whole contact.
        rejected.add(e.pointerId);
        return;
      }
      const stylusRecent = e.timeStamp - lastStylusAt < STYLUS_SEEN_WINDOW_MS;
      const why = touchRejected(e, opts.palmRejection, opts.fingerAction, stylusRecent);
      if (why === "palm") {
        rejected.add(e.pointerId);
        return;
      }
      // A finger held back after the pen promotes with the next one even once the window has passed.
      if (why === "stylus" || pending.size > 0) {
        if (touches.size > 0) {
          addGestureTouch(e); // a further finger joins the running gesture
          return;
        }
        const first = pending.entries().next().value as [number, { at: Vec2 }] | undefined;
        if (first) {
          // Two fingers right after the pen: the held-back one and this one form a gesture.
          pending.delete(first[0]);
          addGestureTouchAt(first[0], first[1].at, e.timeStamp);
          addGestureTouch(e);
        } else {
          const at = local(e);
          pending.set(e.pointerId, { from: at, at });
          capture(e.pointerId);
        }
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
      if (
        drawId === null &&
        touches.size === 0 &&
        fingerMayDraw(e, opts.palmRejection, opts.fingerAction, lastStylusAt, e.timeStamp)
      ) {
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
    // Contacts held back before the pen went down are a resting hand: drop them for good.
    for (const id of pending.keys()) rejected.add(id);
    pending.clear();
    // A pen writing while a touch pans: that touch is a resting hand, so the pan is no swipe.
    if (touches.size > 0) drewMeanwhile = true;
    drawId = e.pointerId;
    drawType = t;
    capture(e.pointerId);
    e.preventDefault();
    handlers.onDown(toPoint(e, el.getBoundingClientRect()), pointerInfo(e));
  };

  const onMove = (e: PointerEvent) => {
    if (isStylus(e)) seeStylus(e.timeStamp); // hover counts as "stylus seen"
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
    const held = pending.get(e.pointerId);
    if (held) {
      held.at = local(e);
      // A held-back finger that travels is panning, not a hand settling (which the pen going down
      // would have dropped): the pan starts here, so the page does not jump by the slop.
      const moved = Math.hypot(held.at.x - held.from.x, held.at.y - held.from.y) > HELD_PAN_SLOP_PX;
      if (moved && opts.fingerAction !== "draw") {
        pending.delete(e.pointerId);
        addGestureTouchAt(e.pointerId, held.at, e.timeStamp);
      }
      return;
    }
    const prev = touches.get(e.pointerId);
    if (!prev) return;
    const next = local(e);
    touches.set(e.pointerId, next);
    const from = landed.get(e.pointerId);
    if (from) travel = Math.max(travel, Math.hypot(next.x - from.x, next.y - from.y));
    if (pinching) {
      const g = pinchState();
      if (g) handlers.onPinch!(g);
    } else {
      // One finger (or two with pinch disabled): pan by this contact's delta, averaged over contacts.
      handlers.onPan?.((next.x - prev.x) / touches.size, (next.y - prev.y) / touches.size, {
        fingers: touches.size,
        timeStamp: e.timeStamp,
      });
    }
  };

  function end(e: PointerEvent, cancelled: boolean) {
    if (isStylus(e)) seeStylus(e.timeStamp);
    rejected.delete(e.pointerId);
    if (pending.delete(e.pointerId)) {
      release(e.pointerId);
      return;
    }
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
    if (cancelled) panCancelled = true;
    if (touches.size === 0) {
      if (drawId !== null && drawType !== "touch") drewMeanwhile = true;
      handlers.onPanEnd?.({ cancelled: panCancelled, timeStamp: e.timeStamp, drewMeanwhile, fingers: maxFingers, travel });
    }
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
  /**
   * Touch events are only cancelled, never read (pointer events carry the input). Cancelling them
   * keeps the system's own tap gestures off the drawing surface: on iPadOS a quick double tap of
   * the pen otherwise selects nearby page text and raises the Copy menu, which takes the pen away
   * from the stroke. A cancelled touch no longer moves focus, so a field focused elsewhere is
   * blurred by hand, and a text selection left on the page is dropped.
   */
  const onTouch = (e: TouchEvent) => {
    if (e.cancelable) e.preventDefault();
    if (e.type !== "touchstart") return;
    const doc = el.ownerDocument;
    const active = doc.activeElement;
    if (active instanceof HTMLElement && active !== doc.body && !el.contains(active)) active.blur();
    const sel = doc.getSelection?.();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
  };
  const touchOpts = { passive: false } as const;

  el.addEventListener("touchstart", onTouch, touchOpts);
  el.addEventListener("touchend", onTouch, touchOpts);
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancelEv);
  el.addEventListener("lostpointercapture", onLostCapture);
  el.addEventListener("contextmenu", onContext);
  return () => {
    cancelDraw();
    for (const id of touches.keys()) release(id);
    for (const id of pending.keys()) release(id);
    touches.clear();
    pending.clear();
    rejected.clear();
    expectedRelease.clear();
    pinching = false;
    el.removeEventListener("touchstart", onTouch);
    el.removeEventListener("touchend", onTouch);
    el.removeEventListener("lostpointercapture", onLostCapture);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancelEv);
    el.removeEventListener("contextmenu", onContext);
  };
}
