import { afterEach, describe, expect, it, vi } from "vitest";
import { animateCamera, fitBounds, type Camera } from "../camera";

describe("fitBounds", () => {
  it("fits_the_bounds_inside_the_margin_and_centres_them", () => {
    // 1000x500 in a 1096x596 viewport with a 48 px margin: exactly zoom 1, offset by the margin.
    expect(fitBounds({ x: 0, y: 0, width: 1000, height: 500 }, { width: 1096, height: 596 })).toEqual({ x: 48, y: 48, z: 1 });
  });

  it("uses_the_tighter_axis_and_centres_the_other", () => {
    // 200x100 at (100, 100) in 496x496, margin 48: room 400x400, zoom min(2, 4) = 2; centre (200, 150).
    const c = fitBounds({ x: 100, y: 100, width: 200, height: 100 }, { width: 496, height: 496 });
    expect(c).toEqual({ x: 248 - 400, y: 248 - 300, z: 2 });
  });

  it("honours_a_custom_margin_and_clamps_zoom", () => {
    expect(fitBounds({ x: 0, y: 0, width: 1000, height: 1000 }, { width: 1000, height: 1000 }, 0).z).toBe(1);
    expect(fitBounds({ x: 0, y: 0, width: 1, height: 1 }, { width: 1000, height: 1000 }).z).toBe(10);
    expect(fitBounds({ x: 0, y: 0, width: 1e6, height: 1e6 }, { width: 1000, height: 1000 }).z).toBe(0.1);
  });

  it("centres_an_empty_rect_at_zoom_1", () => {
    expect(fitBounds({ x: 50, y: 50, width: 0, height: 0 }, { width: 200, height: 100 })).toEqual({ x: 50, y: 0, z: 1 });
  });
});

describe("animateCamera", () => {
  afterEach(() => vi.unstubAllGlobals());

  const fakeStore = () => {
    let camera: Camera = { x: 0, y: 0, z: 1 };
    return {
      getState: () => ({ camera, setCamera: (c: Camera) => (camera = c) }),
      get camera() {
        return camera;
      },
    };
  };

  it("sets_the_target_immediately_without_requestAnimationFrame", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const store = fakeStore();
    animateCamera(store, { x: 10, y: 20, z: 2 });
    expect(store.camera).toEqual({ x: 10, y: 20, z: 2 });
  });

  it("tweens_to_the_target_and_a_new_call_cancels_the_running_tween", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const store = fakeStore();
    animateCamera(store, { x: 100, y: 0, z: 1 }, 200);
    frames.shift()!(100);
    expect(store.camera.x).toBeGreaterThan(0);
    expect(store.camera.x).toBeLessThan(100);
    // A second tween takes over; the first one's pending frame no longer moves the camera.
    animateCamera(store, { x: -50, y: 0, z: 1 }, 200);
    const stale = frames.shift()!;
    const mid = store.camera.x;
    stale(150);
    expect(store.camera.x).toBe(mid);
    for (const f of frames.splice(0)) f(1000);
    expect(store.camera).toEqual({ x: -50, y: 0, z: 1 });
    now.mockRestore();
  });
});
