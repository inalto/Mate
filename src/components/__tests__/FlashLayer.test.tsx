import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlashStore } from "../../stores/flash";
import FlashLayer, { FLASH_MS, FLASH_WAIT_MS } from "../FlashLayer";

const bounds = { x: 10, y: 20, width: 100, height: 40 };

beforeEach(() => {
  vi.useFakeTimers();
  useFlashStore.setState({ flash: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FlashLayer", () => {
  it("draws the rectangle over the bounds and clears after the timeout", () => {
    render(<FlashLayer pageId="p1" />);
    expect(screen.queryByTestId("flash-rect")).toBeNull();
    act(() => useFlashStore.getState().flashGroup("p1", "g1", bounds));
    const rect = screen.getByTestId("flash-rect");
    expect(rect.style.left).toBe("4px");
    expect(rect.style.width).toBe("112px");
    act(() => void vi.advanceTimersByTime(FLASH_MS + 10));
    expect(useFlashStore.getState().flash).toBeNull();
    expect(screen.queryByTestId("flash-rect")).toBeNull();
  });

  it("ignores a flash for another page", () => {
    render(<FlashLayer pageId="p1" />);
    act(() => useFlashStore.getState().flashGroup("p2", "g1", bounds));
    expect(screen.queryByTestId("flash-rect")).toBeNull();
    act(() => void vi.advanceTimersByTime(FLASH_WAIT_MS + 10));
    expect(useFlashStore.getState().flash).not.toBeNull();
  });

  it("waits for bounds that arrive later, then gives up after 3 s without them", () => {
    render(<FlashLayer pageId="p1" />);
    act(() => useFlashStore.getState().flashGroup("p1", "g1"));
    expect(screen.queryByTestId("flash-rect")).toBeNull();
    act(() => void vi.advanceTimersByTime(2000));
    act(() => useFlashStore.getState().flashGroup("p1", "g1", bounds)); // the palette's re-publish
    expect(screen.getByTestId("flash-rect")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(FLASH_MS + 10));
    expect(useFlashStore.getState().flash).toBeNull();

    act(() => useFlashStore.getState().flashGroup("p1", "g2"));
    act(() => void vi.advanceTimersByTime(FLASH_WAIT_MS + 10));
    expect(useFlashStore.getState().flash).toBeNull();
  });

  it("resolves bounds from the page's recognitions once they are loaded", () => {
    const known = new Map<string, typeof bounds>();
    const { rerender } = render(<FlashLayer pageId="p1" boundsOf={(id) => known.get(id)} />);
    act(() => useFlashStore.getState().flashGroup("p1", "g1"));
    expect(screen.queryByTestId("flash-rect")).toBeNull();
    known.set("g1", bounds); // recognitions finished loading
    rerender(<FlashLayer pageId="p1" boundsOf={(id) => known.get(id)} />);
    expect(screen.getByTestId("flash-rect")).toBeTruthy();
  });
});
