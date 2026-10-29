// Toolbar popovers render in a portal on <body>: the dock bar scrolls (overflow), which would clip
// absolutely positioned children. Placement is computed from the anchor's rectangle and follows the
// dock side, so a popover always opens away from the docked edge and stays inside the window.
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { isMobile } from "../platform";
import { useSettingsStore } from "../stores/settings";

export type Dock = "top" | "bottom" | "left" | "right";

/** The dock side in effect: left/right fall back to top on mobile, where they are not offered. */
export function useDock(): Dock {
  const dock = useSettingsStore((s) => s.settings.toolbarDock);
  if (dock === "bottom") return "bottom";
  if ((dock === "left" || dock === "right") && !isMobile()) return dock;
  return "top";
}

const GAP = 8;
const MARGIN = 4;

/** Portal content per anchor element, so `useDismiss` treats pointer-downs inside it as inside. */
const portals = new WeakMap<HTMLElement, HTMLElement>();
export function isInsidePortal(anchor: HTMLElement | null, target: Node): boolean {
  const el = anchor ? portals.get(anchor) : undefined;
  return !!el && el.contains(target);
}

/** Where a box of `size` goes next to `a` for `dock`, clamped into `view`. */
export function placePopover(
  dock: Dock,
  a: { left: number; right: number; top: number; bottom: number },
  size: { w: number; h: number },
  view: { w: number; h: number },
): { left: number; top: number } {
  let left = a.left;
  let top = a.top;
  if (dock === "top") top = a.bottom + GAP;
  else if (dock === "bottom") top = a.top - GAP - size.h;
  else if (dock === "left") left = a.right + GAP;
  else left = a.left - GAP - size.w;
  left = Math.max(MARGIN, Math.min(left, view.w - size.w - MARGIN));
  top = Math.max(MARGIN, Math.min(top, view.h - size.h - MARGIN));
  return { left, top };
}

export default function DockPopover({ anchorRef, children }: { anchorRef: RefObject<HTMLElement | null>; children: ReactNode }) {
  const dock = useDock();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const box = ref.current;
    if (!anchor || !box) return;
    portals.set(anchor, box);
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const r = box.getBoundingClientRect();
      setPos(placePopover(dock, a, { w: r.width, h: r.height }, { w: window.innerWidth, h: window.innerHeight }));
    };
    place();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    ro?.observe(box);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      portals.delete(anchor);
      ro?.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, dock]);

  return createPortal(
    <div
      ref={ref}
      className="tb-portal"
      data-dock={dock}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
