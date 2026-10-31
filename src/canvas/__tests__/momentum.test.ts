import { describe, expect, it, vi } from "vitest";
import { cameraFlingApply, releaseVelocity, startFling, stepFling, FLING_DECAY, MAX_FRAME_MS } from "../momentum";

describe("momentum", () => {
  it("velocity_from_recent_samples", () =>
    expect(releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 900 }, { x: 0, y: -100, t: 1000 }], 1000)).toEqual({ x: 0, y: -1 }));
  it("velocity_zero_with_one_sample", () =>
    expect(releaseVelocity([{ x: 0, y: 0, t: 990 }], 1000)).toEqual({ x: 0, y: 0 }));
  it("decay_reaches_null", () => {
    let s = { v: { x: 0, y: 1 }, dx: 0, dy: 0 } as ReturnType<typeof stepFling>;
    let n = 0;
    while (s && n < 1000) {
      s = stepFling(s.v, 16);
      n++;
    }
    expect(s).toBeNull();
    expect(n).toBeLessThan(120);
  });
  it("slow_release_does_not_fling", () => {
    const apply = vi.fn(() => true);
    startFling({ x: 0.01, y: 0.01 }, apply, (cb) => {
      cb(0);
      return 0;
    });
    expect(apply).not.toHaveBeenCalled();
  });
  it("fling_runs_until_apply_refuses_or_cancelled", () => {
    const q: ((t: number) => void)[] = [];
    const raf = (cb: (t: number) => void) => (q.push(cb), q.length);
    let ok = true;
    const apply = vi.fn((_dx: number, _dy: number) => ok);
    const cancel = startFling({ x: 0, y: 1 }, apply, raf);
    q.shift()!(0);
    q.shift()!(16);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0][1]).toBeCloseTo(16);
    ok = false;
    q.shift()!(32);
    expect(q.length).toBe(0);
    const apply2 = vi.fn(() => true);
    const c2 = startFling({ x: 0, y: 1 }, apply2, raf);
    c2();
    q.shift()!(0);
    expect(apply2).not.toHaveBeenCalled();
    void cancel;
  });
  it("long_frame_is_capped", () => {
    const q: ((t: number) => void)[] = [];
    const raf = (cb: (t: number) => void) => (q.push(cb), q.length);
    const apply = vi.fn((_dx: number, _dy: number) => true);
    startFling({ x: 0, y: 1 }, apply, raf);
    q.shift()!(0);
    q.shift()!(16);
    q.shift()!(2016);
    const v3 = FLING_DECAY ** 2;
    expect(apply.mock.calls[2][1]).toBeCloseTo(v3 * MAX_FRAME_MS);
  });
  it("fling_stops_when_the_camera_is_replaced_from_outside", () => {
    let camera = { x: 0, y: 0, zoom: 1 };
    const set = vi.fn((c: typeof camera) => {
      camera = c;
    });
    const apply = cameraFlingApply(() => camera, set, (c, dx, dy) => ({ ...c, x: c.x + dx, y: c.y + dy }));
    const q: ((t: number) => void)[] = [];
    startFling({ x: 0, y: 1 }, apply, (cb) => (q.push(cb), q.length));
    q.shift()!(0);
    expect(set).toHaveBeenCalledTimes(1);
    camera = { x: 500, y: 500, zoom: 2 }; // zoom to fit, frame navigation, jump to sheet
    q.shift()!(16);
    expect(set).toHaveBeenCalledTimes(1);
    expect(camera).toEqual({ x: 500, y: 500, zoom: 2 });
    expect(q.length).toBe(0);
  });
  it("fling_stops_when_the_page_is_no_longer_ready", () => {
    let camera = { x: 0, y: 0 };
    let ok = true;
    const set = vi.fn((c: typeof camera) => {
      camera = c;
    });
    const apply = cameraFlingApply(() => camera, set, (c, dx, dy) => ({ x: c.x + dx, y: c.y + dy }), () => ok);
    expect(apply(1, 1)).toBe(true);
    ok = false;
    expect(apply(1, 1)).toBe(false);
    expect(set).toHaveBeenCalledTimes(1);
  });
});
