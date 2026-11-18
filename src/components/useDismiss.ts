import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useChromeStore } from "../stores/chrome";
import { isInsidePortal, isNestedAnchor } from "./DockPopover";
import { useModal } from "./useModal";

/**
 * Close on pointer-down outside `ref` or Escape while `open`. Pointer-downs inside a popover opened
 * from within this one's popover count as inside.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  // A popover opened from inside another popover is part of it: the outer one already counts as the
  // open modal, and a second count would read to the outer one as a dialog opening on top of it.
  // Unknown (null) until measured, so a popover already open at mount does not count itself first.
  const [nested, setNested] = useState<boolean | null>(null);
  useLayoutEffect(() => setNested(isNestedAnchor(ref.current)), [ref]);
  useModal(open && nested === false);
  const cb = useRef(onClose);
  useEffect(() => {
    cb.current = onClose;
  });
  useEffect(() => {
    if (!open || nested === null) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !isInsidePortal(ref.current, t)) cb.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cb.current();
    };
    // A dialog opening on top (modal count rises above ours) closes the popover beneath it. A nested
    // popover leaves that to the outer one: its closing unmounts this one too.
    const base = useChromeStore.getState().modalDepth;
    const unsub = nested
      ? () => {}
      : useChromeStore.subscribe((s) => {
          if (s.modalDepth <= base) return;
          unsub(); // once: closing writes to this store again
          cb.current();
        });
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      unsub();
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref, nested]);
}
