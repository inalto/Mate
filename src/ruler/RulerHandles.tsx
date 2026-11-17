// The ruler's two rotate handles, 48 px in from each end of its visible part. Dragging one turns
// the ruler about its anchor (or about the middle of the visible part when the anchor is off the
// pane), snapped unless Shift is held; arrow keys turn it from the keyboard. View state only.
import { useEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { screenToWorld, worldToScreen, type Camera, type Vec2, type Viewport } from "../canvas/camera";
import type { EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";
import { angleDelta, screenAngle } from "./drag";
import { rotatePose, snapRulerAngle, visibleSpan, type RulerPose } from "./pose";

const HANDLE_INSET_PX = 48;
const SHORT_SPAN_PX = 160;
/** Closer than this to the pivot the pointer's direction is too unsteady to follow. */
const DEAD_ZONE_PX = 6;

const mid = (s: [Vec2, Vec2]): Vec2 => ({ x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 });

/** Handle centres on the centreline: 48 px in from each end, or at 1/4 and 3/4 of a short span. */
function handleSpots(span: [Vec2, Vec2]): [Vec2, Vec2] {
  const len = Math.hypot(span[1].x - span[0].x, span[1].y - span[0].y);
  const t = len < SHORT_SPAN_PX ? 0.25 : HANDLE_INSET_PX / len;
  const lerp = (k: number): Vec2 => ({ x: span[0].x + (span[1].x - span[0].x) * k, y: span[0].y + (span[1].y - span[0].y) * k });
  return [lerp(t), lerp(1 - t)];
}

/** The rotation pivot in pane px: the anchor when it is inside the pane, else the middle of the span. */
function pivotOf(pose: RulerPose, camera: Camera, viewport: Viewport): Vec2 | null {
  const a = worldToScreen(camera, pose);
  if (a.x >= 0 && a.x <= viewport.width && a.y >= 0 && a.y <= viewport.height) return a;
  const span = visibleSpan(pose, camera, viewport);
  return span ? mid(span) : null;
}

const angleStep = (): number => useSettingsStore.getState().settings.rulerAngleSnap;

interface HandleDrag {
  id: number;
  target: Element;
  pivot: Vec2;
  pivotWorld: Vec2;
  last: number;
  raw: number;
}

export default function RulerHandles({
  store,
  span,
  toLocal,
}: {
  store: EditorStore;
  span: [Vec2, Vec2];
  toLocal(e: { clientX: number; clientY: number }): Vec2;
}) {
  const { t } = useTranslation();
  const dragRef = useRef<HandleDrag | null>(null);

  const end = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    try {
      d.target.releasePointerCapture(d.id);
    } catch {
      /* stale pointer id or no capture support */
    }
  };

  // A guided stroke freezes the ruler: a turn in progress ends.
  useEffect(() => {
    const unsub = store.subscribe((s) => {
      if (s.rulerGuiding) end();
    });
    return () => {
      unsub();
      end();
    };
  }, [store]);

  const turnTo = (pose: RulerPose, pivotWorld: Vec2, angle: number) => {
    const delta = angleDelta(pose.angle, angle);
    if (delta !== 0) store.getState().setRulerPose(rotatePose(pose, pivotWorld, delta));
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const s = store.getState();
    if (s.rulerGuiding || dragRef.current || !s.ruler.pose) return;
    const pivot = pivotOf(s.ruler.pose, s.camera, s.viewport);
    if (!pivot) return;
    e.preventDefault();
    const p = toLocal(e);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom or a stale pointer id */
    }
    dragRef.current = {
      id: e.pointerId,
      target: e.currentTarget,
      pivot,
      pivotWorld: screenToWorld(s.camera, pivot),
      last: screenAngle(pivot, p),
      raw: s.ruler.pose.angle,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    e.stopPropagation();
    const pose = store.getState().ruler.pose;
    const p = toLocal(e);
    if (!pose || Math.hypot(p.x - d.pivot.x, p.y - d.pivot.y) < DEAD_ZONE_PX) return;
    const a = screenAngle(d.pivot, p);
    d.raw += angleDelta(d.last, a);
    d.last = a;
    turnTo(pose, d.pivotWorld, e.shiftKey ? d.raw : snapRulerAngle(d.raw, angleStep()));
  };

  const onPointerEnd = (e: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.id === e.pointerId) end();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const s = store.getState();
    const pose = s.ruler.pose;
    const pivot = pose && pivotOf(pose, s.camera, s.viewport);
    if (!pose || !pivot) return;
    const snap = angleStep();
    const step = e.shiftKey ? 0.1 : snap > 0 ? snap : 1;
    s.setRulerPose(rotatePose(pose, screenToWorld(s.camera, pivot), dir * step));
  };

  return (
    <>
      {handleSpots(span).map((p, i) => (
        <button
          key={i}
          type="button"
          className="ruler-handle"
          aria-label={t("ruler.rotate")}
          style={{ left: `${p.x}px`, top: `${p.y}px` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onPointerEnd}
          onKeyDown={onKeyDown}
        />
      ))}
    </>
  );
}
