import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Point } from "../../model/types";
import { createInkSnap, inkSnapAllowed, snapShapeElement } from "../inkSnap";

const rectPath = (): Point[] => {
  const corners: Array<[number, number]> = [[60, 0], [120, 0], [120, 80], [0, 80], [0, 0], [56, 0]];
  const out: Point[] = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 4));
    for (let k = 0; k < n; k++) out.push({ x: ax + ((bx - ax) * k) / n, y: ay + ((by - ay) * k) / n, pressure: 0.5, timestamp: 0 });
  }
  return out;
};

function setup(over: { snapsOnRelease?: boolean; zoom?: number } = {}) {
  const drawn: Point[] = [];
  const onSnap = vi.fn();
  const snap = createInkSnap({
    dwellMs: 750,
    snapsOnRelease: over.snapsOnRelease ?? false,
    zoom: over.zoom ?? 1,
    points: () => drawn,
    onSnap,
  });
  const draw = (pts: Point[]) => {
    for (const p of pts) {
      drawn.push(p);
      if (drawn.length === 1) snap.down(p);
      else snap.move(p);
      vi.advanceTimersByTime(8);
    }
  };
  return { snap, onSnap, draw, drawn };
}

describe("ink snap state machine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holding_still_snaps_after_the_dwell", () => {
    const { snap, onSnap, draw } = setup();
    draw(rectPath());
    expect(onSnap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(740);
    expect(onSnap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(onSnap).toHaveBeenCalledTimes(1);
    expect(onSnap.mock.calls[0][0].type).toBe("rectangle");
    expect(snap.snapped()?.type).toBe("rectangle");
    expect(snap.up()?.type).toBe("rectangle");
  });

  it("movement_over_2px_resets_the_dwell", () => {
    const { onSnap, draw, drawn } = setup({ zoom: 2 });
    draw(rectPath());
    vi.advanceTimersByTime(500);
    const last = drawn[drawn.length - 1];
    // 0.8 world units = 1.6 screen px at zoom 2: jitter, the dwell keeps running.
    draw([{ ...last, x: last.x + 0.8 }]);
    vi.advanceTimersByTime(240);
    expect(onSnap).toHaveBeenCalledTimes(1);

    const second = setup({ zoom: 2 });
    second.draw(rectPath());
    vi.advanceTimersByTime(500);
    const l2 = second.drawn[second.drawn.length - 1];
    // 1.5 world units = 3 screen px: the dwell restarts.
    second.draw([{ ...l2, x: l2.x + 1.5 }]);
    vi.advanceTimersByTime(500);
    expect(second.onSnap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(260);
    expect(second.onSnap).toHaveBeenCalledTimes(1);
  });

  it("release_without_hold_snaps_only_with_snap_on_release", () => {
    const hold = setup();
    hold.draw(rectPath());
    expect(hold.snap.up()).toBeNull();
    vi.advanceTimersByTime(2000);
    expect(hold.onSnap).not.toHaveBeenCalled(); // timer cleared on release

    const release = setup({ snapsOnRelease: true });
    release.draw(rectPath());
    expect(release.snap.up()?.type).toBe("rectangle");
  });

  it("unrecognised_hold_does_not_snap", () => {
    const { snap, onSnap, draw } = setup();
    const scrawl: Point[] = [];
    for (let i = 0; i < 40; i++) scrawl.push({ x: i * 5, y: (i * 37) % 23, pressure: 0.5, timestamp: 0 });
    draw(scrawl);
    vi.advanceTimersByTime(1000);
    expect(onSnap).not.toHaveBeenCalled();
    expect(snap.up()).toBeNull();
  });

  it("highlighter_never_snaps_and_setting_gates", () => {
    expect(inkSnapAllowed("pen", DEFAULT_SETTINGS)).toBe(true);
    expect(inkSnapAllowed("fountain-pen", DEFAULT_SETTINGS)).toBe(true);
    expect(inkSnapAllowed("highlighter", DEFAULT_SETTINGS)).toBe(false);
    expect(inkSnapAllowed("pen", { ...DEFAULT_SETTINGS, inkToShape: false })).toBe(false);
  });

  it("snapped_shape_takes_the_stroke_colour_and_width_with_no_fill", () => {
    const el = snapShapeElement(
      { type: "rectangle", score: 0.9, rect: { x: 0, y: 0, width: 120, height: 80 }, rotation: 0.1 },
      { color: "#1565C0", width: 4.11 },
      "pg",
      "s1",
      "now",
    );
    expect(el).toMatchObject({ id: "s1", type: "shape", shapeType: "rectangle", color: "#1565C0", width: 4.11, fillColor: "transparent", boxWidth: 120, boxHeight: 80 });
    expect(el.content).toMatchObject({ rotation: 0.1 });
  });
});
