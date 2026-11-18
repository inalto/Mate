import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScrollFade } from "../useScrollFade";

function Strip({ count, orientation = "horizontal" }: { count: number; orientation?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollFade(ref);
  return (
    <div className="toolbar" aria-orientation={orientation as "horizontal" | "vertical"} data-testid="bar">
      <div ref={ref} className="tb-scroll" data-testid="strip">
        {Array.from({ length: count }, (_, i) => (
          <button key={i} type="button" />
        ))}
      </div>
    </div>
  );
}

/** jsdom does not lay out: the strip's metrics follow its child count (50 px each) in a 100 px box. */
function measure(el: HTMLElement, scroll = { left: 0, top: 0 }) {
  const total = () => el.children.length * 50;
  Object.defineProperty(el, "clientWidth", { configurable: true, value: 100 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 100 });
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: total });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => total() * 2 });
  Object.defineProperty(el, "scrollLeft", { configurable: true, value: scroll.left });
  Object.defineProperty(el, "scrollTop", { configurable: true, value: scroll.top });
}

const flush = () => act(async () => {});

describe("useScrollFade", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("an_item_added_without_any_resize_or_scroll_sets_data_fade_end", async () => {
    const { getByTestId, rerender } = render(<Strip count={1} />);
    const strip = getByTestId("strip");
    measure(strip);
    rerender(<Strip count={2} />); // 100 px of content in a 100 px box: fits
    await flush();
    expect(strip.hasAttribute("data-fade-end")).toBe(false);
    rerender(<Strip count={3} />);
    await flush();
    expect(strip.hasAttribute("data-fade-end")).toBe(true);
    rerender(<Strip count={2} />);
    await flush();
    expect(strip.hasAttribute("data-fade-end")).toBe(false);
  });

  it("a_dock_orientation_change_refreshes_the_flags_and_clears_the_old_axis", async () => {
    const { getByTestId, rerender } = render(<Strip count={3} />);
    const strip = getByTestId("strip");
    // Horizontal: 150 px wide content overflows; vertical: height is 300 px, overflows too, so use scrollTop.
    measure(strip, { left: 0, top: 50 });
    rerender(<Strip count={3} orientation="vertical" />);
    await flush();
    expect(strip.hasAttribute("data-fade-start")).toBe(true);
    rerender(<Strip count={3} orientation="horizontal" />);
    await flush();
    expect(strip.hasAttribute("data-fade-start")).toBe(false);
    expect(strip.hasAttribute("data-fade-end")).toBe(true);
  });

  it("does_not_throw_without_ResizeObserver_or_MutationObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    vi.stubGlobal("MutationObserver", undefined);
    expect(() => render(<Strip count={2} />)).not.toThrow();
  });
});
