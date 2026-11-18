import { useEffect, type RefObject } from "react";

/**
 * Marks a scrolling strip with `data-fade-start` / `data-fade-end` while content is hidden past that edge.
 * Refreshes on scroll, on resize of the strip or its items, when items are added or removed, and when the
 * bar's `aria-orientation` flips (the axis it measures).
 */
export function useScrollFade(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const bar = el.closest(".toolbar");
    const update = () => {
      const vertical = bar?.getAttribute("aria-orientation") === "vertical";
      const pos = vertical ? el.scrollTop : el.scrollLeft;
      const view = vertical ? el.clientHeight : el.clientWidth;
      const total = vertical ? el.scrollHeight : el.scrollWidth;
      el.toggleAttribute("data-fade-start", pos > 1);
      el.toggleAttribute("data-fade-end", pos + view < total - 1);
    };
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const watch = () => {
      ro?.disconnect();
      ro?.observe(el);
      for (const child of Array.from(el.children)) ro?.observe(child);
    };
    const mo =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            if (records.some((r) => r.type === "childList")) watch();
            update();
          });
    mo?.observe(el, { childList: true });
    if (bar) mo?.observe(bar, { attributes: true, attributeFilter: ["aria-orientation"] });
    watch();
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [ref]);
}
