// Drag to reorder from a handle: the drag starts only on a handle (so a finger that scrolls a list never
// starts one), after a few pixels of movement, and it ends on release, cancel, Escape or lost capture.
import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from "react";

export type ListId = number | "hidden";
export interface DragFrom {
  row: ListId;
  index: number;
}
export interface DropTarget {
  row: ListId;
  index: number;
}
export interface ListRects {
  row: ListId;
  /** The rectangles of the rendered items, top to bottom. */
  rects: { top: number; bottom: number }[];
  /** The area that accepts a drop; defaults to the span of the items. An empty list needs it. */
  box?: { top: number; bottom: number };
}

/** Pure: the drop slot for a pointer at clientY among the lists' item rectangles. */
export function dropTargetAt(lists: ListRects[], y: number): DropTarget | null {
  for (const { row, rects, box } of lists) {
    const top = box?.top ?? rects[0]?.top;
    const bottom = box?.bottom ?? rects[rects.length - 1]?.bottom;
    if (top === undefined || bottom === undefined || y < top || y > bottom) continue;
    const below = rects.findIndex((r) => y < (r.top + r.bottom) / 2);
    return { row, index: below === -1 ? rects.length : below };
  }
  return null;
}

const START_DISTANCE = 4;
const EDGE = 32;
const SCROLL_STEP = 8;

interface Session {
  pointerId: number;
  from: DragFrom;
  handle: HTMLElement;
  x: number;
  y: number;
  active: boolean;
  frame: number;
}

export function useDragReorder(opts: {
  onDrop(from: DragFrom, to: DropTarget): void;
  /** The lists' item rectangles, read at pointer-move time. */
  measure(): ListRects[];
  /** The element that scrolls the lists, if any. */
  scroller?(): HTMLElement | null;
}): {
  handleProps(row: ListId, index: number): HTMLAttributes<HTMLElement>;
  dragging: DragFrom | null;
  target: DropTarget | null;
} {
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  const session = useRef<Session | null>(null);
  const targetRef = useRef<DropTarget | null>(null);
  const [dragging, setDragging] = useState<DragFrom | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const teardown = useRef<(() => void) | null>(null);

  const aim = useCallback(() => {
    const s = session.current;
    if (!s) return;
    const next = dropTargetAt(optsRef.current.measure(), s.y);
    const prev = targetRef.current;
    if (prev?.row === next?.row && prev?.index === next?.index) return;
    targetRef.current = next;
    setTarget(next);
  }, []);

  const end = useCallback(() => {
    teardown.current?.();
    teardown.current = null;
    const s = session.current;
    session.current = null;
    if (s) {
      cancelAnimationFrame(s.frame);
      try {
        s.handle.releasePointerCapture(s.pointerId);
      } catch {
        // not captured, or the WebView does not support it
      }
    }
    targetRef.current = null;
    setDragging(null);
    setTarget(null);
  }, []);

  // One animation frame at a time while a drag is active; `end` cancels the pending frame.
  const startScrolling = useCallback(
    (s: Session) => {
      const tick = () => {
        const box = optsRef.current.scroller?.();
        if (box) {
          const r = box.getBoundingClientRect();
          const before = box.scrollTop;
          if (s.y < r.top + EDGE) box.scrollTop -= SCROLL_STEP;
          else if (s.y > r.bottom - EDGE) box.scrollTop += SCROLL_STEP;
          if (box.scrollTop !== before) aim();
        }
        s.frame = requestAnimationFrame(tick);
      };
      s.frame = requestAnimationFrame(tick);
    },
    [aim],
  );

  const onPointerDown = useCallback(
    (from: DragFrom, e: ReactPointerEvent<HTMLElement>) => {
      if (session.current || (e.pointerType === "mouse" && e.button !== 0)) return;
      const s: Session = {
        pointerId: e.pointerId,
        from,
        handle: e.currentTarget,
        x: e.clientX,
        y: e.clientY,
        active: false,
        frame: 0,
      };
      session.current = s;

      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== s.pointerId) return;
        if (!s.active) {
          if (Math.hypot(ev.clientX - s.x, ev.clientY - s.y) < START_DISTANCE) return;
          s.active = true;
          try {
            s.handle.setPointerCapture(s.pointerId);
          } catch {
            // jsdom and some WebViews throw; the document listeners still follow the pointer
          }
          setDragging(s.from);
          startScrolling(s);
        }
        s.y = ev.clientY;
        aim();
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== s.pointerId) return;
        const to = s.active ? targetRef.current : null;
        end();
        if (to) optsRef.current.onDrop(s.from, to);
      };
      const abort = (ev: PointerEvent) => {
        if (ev.pointerId === s.pointerId) end();
      };
      const key = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !s.active) return;
        ev.preventDefault();
        ev.stopPropagation();
        end();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", abort);
      document.addEventListener("lostpointercapture", abort);
      document.addEventListener("keydown", key);
      teardown.current = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.removeEventListener("pointercancel", abort);
        document.removeEventListener("lostpointercapture", abort);
        document.removeEventListener("keydown", key);
      };
    },
    [aim, end, startScrolling],
  );

  useEffect(() => end, [end]);

  const handleProps = useCallback(
    (row: ListId, index: number): HTMLAttributes<HTMLElement> => ({
      onPointerDown: (e) => onPointerDown({ row, index }, e),
    }),
    [onPointerDown],
  );

  return { handleProps, dragging, target };
}
