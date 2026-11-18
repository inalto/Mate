import { useEffect, type RefObject } from "react";

/** Marks a scrolling strip with `data-fade-start` / `data-fade-end` while content is hidden past that edge. */
export function useScrollFade(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const vertical = el.closest(".toolbar")?.getAttribute("aria-orientation") === "vertical";
      const pos = vertical ? el.scrollTop : el.scrollLeft;
      const view = vertical ? el.clientHeight : el.clientWidth;
      const total = vertical ? el.scrollHeight : el.scrollWidth;
      el.toggleAttribute("data-fade-start", pos > 1);
      el.toggleAttribute("data-fade-end", pos + view < total - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [ref]);
}
