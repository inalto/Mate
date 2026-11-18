import { afterEach, describe, expect, it, vi } from "vitest";
import { openScan, useScanStore } from "../open";

afterEach(() => useScanStore.getState().close());

describe("scan store", () => {
  it("starts closed", () => {
    expect(useScanStore.getState().request).toBeNull();
  });

  it("openScan holds the request until close", () => {
    const onDone = vi.fn();
    const source = new Blob(["x"], { type: "image/png" });
    openScan({ source, onDone });
    expect(useScanStore.getState().request).toEqual({ source, onDone });
    useScanStore.getState().close();
    expect(useScanStore.getState().request).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a second request replaces the first", () => {
    openScan({ source: "webcam", onDone: vi.fn() });
    const source = new Blob(["y"]);
    openScan({ source, onDone: vi.fn() });
    expect(useScanStore.getState().request?.source).toBe(source);
  });
});
