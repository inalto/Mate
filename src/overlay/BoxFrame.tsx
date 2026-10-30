// Selection frame of one boxed element in the overlay layer (page units; the layer carries the camera
// transform): an outline, edge strips that move the selection by dragging, and — when it is the only
// selected element — 8 resize handles and a rotate handle 24 px above the top-centre (none for a
// frame: frames ignore rotation). The drag shows
// a draft frame and commits once on release. Moves and (unrotated) resizes snap to smart guides of
// the other elements on screen (published to the store for the live layer); Ctrl/Cmd suspends that,
// Shift locks a move to its dominant axis and snaps rotation to 15°; Escape cancels the drag. A
// locked box shows no handles, only a lock glyph.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { angleLabel, guideCandidates, GUIDE_SNAP_PX, lockedAxis, smartMoveDelta, snapAngle } from "../canvas/toolInteractions";
import { isFrame } from "../frames/contain";
import { isLocked } from "../model/content";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";
import { withBoxRect } from "../tools/lasso";
import { snapResize, type Guide } from "../tools/smartGuides";
import { boxRect, contentMeta, type Rect } from "../tools/spatialIndex";
import { boxStyle, MIN_BOX, resizeBox, type Handle } from "./boxGeometry";

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const EDGES = ["top", "right", "bottom", "left"] as const;

interface Drag {
  pointerId: number;
  start: { x: number; y: number };
  /** A resize handle, "rotate", or null for a move. */
  handle: Handle | "rotate" | null;
  from: Rect;
  /** Rotate: the box centre in client px and the pointer's start angle about it. */
  centre: { x: number; y: number };
  angle0: number;
}

/** Pointer modifiers of a drag event. */
interface Mods {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** `el` after a resize to `r`, stamped as a new revision (its box snapshot is stale). */
const resized = (el: Element, r: Rect): Element => ({ ...withBoxRect(el, r), updatedAt: new Date().toISOString() });

/** `r` with the edges named by `handle` snapped to the smart-guide stops of `others`. */
function snapEdges(r: Rect, handle: Handle, others: readonly Rect[], threshold: number): { rect: Rect; guides: Guide[] } {
  let x0 = r.x;
  let x1 = r.x + r.width;
  let y0 = r.y;
  let y1 = r.y + r.height;
  const guides: Guide[] = [];
  const edge = (axis: "x" | "y", at: number): number => {
    const s = snapResize(axis, at, others, threshold);
    if (s.guide) guides.push(s.guide);
    return s.at;
  };
  if (handle.includes("w")) x0 = Math.min(edge("x", x0), x1 - MIN_BOX);
  if (handle.includes("e")) x1 = Math.max(edge("x", x1), x0 + MIN_BOX);
  if (handle.includes("n")) y0 = Math.min(edge("y", y0), y1 - MIN_BOX);
  if (handle.includes("s")) y1 = Math.max(edge("y", y1), y0 + MIN_BOX);
  return { rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, guides };
}

export default function BoxFrame({ el, store, zoom, handles }: { el: Element; store: EditorStore; zoom: number; handles: boolean }) {
  const { t } = useTranslation();
  const drag = useRef<Drag | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  /** Smart-guide candidates of the drag in progress (read once per drag). */
  const others = useRef<Rect[] | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [draftRotation, setDraftRotation] = useState<number | null>(null);
  const rotation = contentMeta(el).rotation ?? 0;
  const locked = isLocked(el);
  const rect = draft ?? boxRect(el);

  const onDown = (handle: Handle | "rotate" | null) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const r = frameRef.current?.getBoundingClientRect();
    const centre = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
    others.current = null;
    drag.current = {
      pointerId: e.pointerId,
      start: { x: e.clientX, y: e.clientY },
      handle,
      from: boxRect(el),
      centre,
      angle0: Math.atan2(e.clientY - centre.y, e.clientX - centre.x),
    };
    // Published so other chrome (auto-complete arrows) hides while the box moves under it.
    store.setState({ dragging: true });
  };

  const candidates = (): Rect[] => (others.current ??= guideCandidates(store, new Set(store.getState().selection)));
  const snapping = (m: Mods) => !(m.ctrlKey || m.metaKey) && useSettingsStore.getState().settings.smartGuides;

  /** Rotation (radians, absolute) for the pointer at (clientX, clientY). */
  const turned = (d: Drag, e: ReactPointerEvent<HTMLDivElement>): number =>
    snapAngle(rotation + Math.atan2(e.clientY - d.centre.y, e.clientX - d.centre.x) - d.angle0, e.shiftKey);

  /** Rect and guides for the pointer at (clientX, clientY), in page units. */
  const target = (d: Drag, e: ReactPointerEvent<HTMLDivElement>): { rect: Rect; guides: Guide[] } => {
    const dx = (e.clientX - d.start.x) / zoom;
    const dy = (e.clientY - d.start.y) / zoom;
    if (!d.handle || d.handle === "rotate") {
      const lock = e.shiftKey ? lockedAxis({ x: dx, y: dy }) : null;
      const raw = { x: lock === "x" ? 0 : dx, y: lock === "y" ? 0 : dy };
      if (!snapping(e)) return { rect: { ...d.from, x: d.from.x + raw.x, y: d.from.y + raw.y }, guides: [] };
      const r = smartMoveDelta(d.from, raw, candidates(), GUIDE_SNAP_PX / zoom, (q) => q, lock);
      return { rect: { ...d.from, x: d.from.x + r.delta.x, y: d.from.y + r.delta.y }, guides: r.guides };
    }
    // Handles act in the box's own (unrotated) frame.
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    const keepAspect = el.type === "image" || e.shiftKey;
    const r = resizeBox(d.from, d.handle, dx * cos - dy * sin, dx * sin + dy * cos, keepAspect);
    // Edge snapping only for an unrotated box whose sides move freely.
    if (rotation !== 0 || keepAspect || !snapping(e)) return { rect: r, guides: [] };
    return snapEdges(r, d.handle, candidates(), GUIDE_SNAP_PX / zoom);
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.handle === "rotate") {
      setDraftRotation(turned(d, e));
      return;
    }
    const { rect: r, guides } = target(d, e);
    setDraft(r);
    store.getState().setGuides(guides);
  };

  const end = useCallback(() => {
    drag.current = null;
    others.current = null;
    setDraft(null);
    setDraftRotation(null);
    store.getState().setGuides([]);
    if (store.getState().dragging) store.setState({ dragging: false });
  }, [store]);

  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const s = store.getState();
    if (d.handle === "rotate") {
      const by = turned(d, e) - rotation;
      end();
      // One "Rotate" entry, about the box centre (the box keeps its place).
      if (by !== 0) s.rotateSelection({ x: d.from.x + d.from.width / 2, y: d.from.y + d.from.height / 2 }, by);
      return;
    }
    const { rect: r } = target(d, e);
    end();
    if (!d.handle) {
      s.moveSelection(r.x - d.from.x, r.y - d.from.y);
    } else if (r.x !== d.from.x || r.y !== d.from.y || r.width !== d.from.width || r.height !== d.from.height) {
      const cur = s.elements.get(el.id);
      if (cur) s.updateElements([resized(cur, r)]);
    }
  };

  // Ends the drag in progress (if any) without committing: Escape, a lost capture, or unmounting
  // (deselect, undo or delete mid-drag) must not leave the smart guides on the live layer.
  const cancel = () => {
    if (drag.current) end();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drag.current) return;
      e.preventDefault();
      e.stopPropagation(); // the drag is cancelled; the selection stays
      end();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (drag.current) {
        drag.current = null;
        store.getState().setGuides([]);
        store.setState({ dragging: false });
      }
    };
  }, [store, end]);

  const grip = (handle: Handle | "rotate" | null) => ({
    onPointerDown: onDown(handle),
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: end,
    onLostPointerCapture: cancel,
  });

  const shownRotation = draftRotation ?? rotation;
  return (
    <div ref={frameRef} className={locked ? "box-frame locked" : "box-frame"} data-box-frame={el.id} style={boxStyle(rect, shownRotation)}>
      {!locked && EDGES.map((edge) => <div key={edge} className={`box-frame-edge ${edge}`} {...grip(null)} />)}
      {handles && !locked && HANDLES.map((h) => <div key={h} className={`box-frame-handle ${h}`} data-handle={h} {...grip(h)} />)}
      {handles && !locked && !isFrame(el) && (
        <div className="box-frame-rotate" data-rotate-handle="" role="button" aria-label={t("rotate.handle")} title={t("rotate.handle")} {...grip("rotate")} />
      )}
      {draftRotation !== null && (
        <div
          className="box-frame-angle"
          role="status"
          style={{ transform: `translate(-50%, -50%) rotate(${-draftRotation}rad)` }}
          aria-label={t("rotate.angle", { degrees: angleLabel(draftRotation) })}>
          {angleLabel(draftRotation)}
        </div>
      )}
      {locked && (
        <div className="box-frame-lock" data-lock-glyph="" aria-label={t("lock.locked")} title={t("lock.locked")}>
          <svg viewBox="0 0 12 14" width="100%" height="100%" aria-hidden="true">
            <path d="M3 6V4a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <rect x="1" y="6" width="10" height="8" rx="1.5" fill="currentColor" />
          </svg>
        </div>
      )}
    </div>
  );
}
