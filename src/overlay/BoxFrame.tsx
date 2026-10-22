// Selection frame of one boxed element in the overlay layer (page units; the layer carries the camera
// transform): an outline, edge strips that move the selection by dragging, and — when it is the only
// selected element — 8 resize handles. The drag shows a draft frame and commits once on release.
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { withBoxRect } from "../tools/lasso";
import { boxRect, contentMeta, type Rect } from "../tools/spatialIndex";
import { boxStyle, resizeBox, type Handle } from "./boxGeometry";

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const EDGES = ["top", "right", "bottom", "left"] as const;

interface Drag {
  pointerId: number;
  start: { x: number; y: number };
  handle: Handle | null;
  from: Rect;
}

/** `el` after a resize to `r`, stamped as a new revision (its box snapshot is stale). */
const resized = (el: Element, r: Rect): Element => ({ ...withBoxRect(el, r), updatedAt: new Date().toISOString() });

export default function BoxFrame({ el, store, zoom, handles }: { el: Element; store: EditorStore; zoom: number; handles: boolean }) {
  const drag = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const rotation = contentMeta(el).rotation ?? 0;
  const rect = draft ?? boxRect(el);

  const onDown = (handle: Handle | null) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { pointerId: e.pointerId, start: { x: e.clientX, y: e.clientY }, handle, from: boxRect(el) };
  };

  /** Rect for the pointer at (clientX, clientY), in page units. */
  const target = (d: Drag, e: ReactPointerEvent<HTMLDivElement>): Rect => {
    const dx = (e.clientX - d.start.x) / zoom;
    const dy = (e.clientY - d.start.y) / zoom;
    if (!d.handle) return { ...d.from, x: d.from.x + dx, y: d.from.y + dy };
    // Handles act in the box's own (unrotated) frame.
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    const keepAspect = el.type === "image" || e.shiftKey;
    return resizeBox(d.from, d.handle, dx * cos - dy * sin, dx * sin + dy * cos, keepAspect);
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    setDraft(target(d, e));
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setDraft(null);
    const r = target(d, e);
    const s = store.getState();
    if (!d.handle) {
      s.moveSelection(r.x - d.from.x, r.y - d.from.y);
    } else if (r.x !== d.from.x || r.y !== d.from.y || r.width !== d.from.width || r.height !== d.from.height) {
      const cur = s.elements.get(el.id);
      if (cur) s.updateElements([resized(cur, r)]);
    }
  };

  const onCancel = () => {
    drag.current = null;
    setDraft(null);
  };

  const grip = (handle: Handle | null) => ({
    onPointerDown: onDown(handle),
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onCancel,
  });

  return (
    <div className="box-frame" data-box-frame={el.id} style={boxStyle(rect, rotation)}>
      {EDGES.map((edge) => (
        <div key={edge} className={`box-frame-edge ${edge}`} {...grip(null)} />
      ))}
      {handles && HANDLES.map((h) => <div key={h} className={`box-frame-handle ${h}`} data-handle={h} {...grip(h)} />)}
    </div>
  );
}
