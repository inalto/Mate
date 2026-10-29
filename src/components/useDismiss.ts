import { useEffect, useRef, type RefObject } from "react";
import { useChromeStore } from "../stores/chrome";
import { isInsidePortal } from "./DockPopover";
import { useModal } from "./useModal";

/** Close on pointer-down outside `ref` or Escape while `open`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  useModal(open);
  const cb = useRef(onClose);
  useEffect(() => {
    cb.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !isInsidePortal(ref.current, t)) cb.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cb.current();
    };
    // A dialog opening on top (modal count rises above ours) closes the popover beneath it.
    const base = useChromeStore.getState().modalDepth;
    const unsub = useChromeStore.subscribe((s) => {
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
  }, [open, ref]);
}
