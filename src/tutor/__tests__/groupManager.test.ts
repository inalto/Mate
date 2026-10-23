import { beforeEach, describe, expect, it } from "vitest";
import { createGroupManager, type GroupManager } from "../groupManager";
import type { Region } from "../types";

/** Fake clock + timer queue (no real timers). */
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

const region = (id: string, elementIds: string[], x: number, y = 100, w = 100, h = 30): Region => ({
  regionId: id,
  type: "math",
  elementIds,
  bounds: { x, y, width: w, height: h },
  baselineY: y + h,
});

let clock: ReturnType<typeof fakeClock>;
let fired: [string, string][];
let invalidated: string[];
let gm: GroupManager;

beforeEach(() => {
  clock = fakeClock();
  fired = [];
  invalidated = [];
  gm = createGroupManager({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFire: (g, reason) => fired.push([g.regionId, reason]),
    onInvalidate: (id) => invalidated.push(id),
  });
});

/** One stroke: pen down, `ms` of drawing, pen up. */
function stroke(ms = 100) {
  gm.notePenDown();
  clock.advance(ms);
  gm.notePenUp();
}

describe("group manager", () => {
  it("settle_waits_for_pen_up", () => {
    stroke();
    gm.setRegions([region("A", ["s1"], 0)]);
    clock.advance(1100);
    expect(fired).toEqual([]);
    // Another stroke starts before settle: nothing fires while the pen is down.
    gm.notePenDown();
    clock.advance(5000);
    expect(fired).toEqual([]);
    gm.notePenUp();
    gm.setRegions([region("A2", ["s1", "s2"], 0)]);
    clock.advance(1199);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([["A2", "settle"]]);
    // Clean regions never re-fire until dirtied.
    clock.advance(10_000);
    gm.setRegions([region("A2", ["s1", "s2"], 0)]);
    clock.advance(10_000);
    expect(fired).toEqual([["A2", "settle"]]);
    stroke();
    gm.noteElementsChanged(["s2"]);
    clock.advance(1200);
    expect(fired).toEqual([
      ["A2", "settle"],
      ["A2", "settle"],
    ]);
  });

  it("settle_delay_counts_from_last_pen_up", () => {
    stroke();
    clock.advance(1000);
    gm.setRegions([region("A", ["s1"], 0)]); // re-segmentation ran late
    clock.advance(199);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([["A", "settle"]]);
  });

  it("settle_held_while_in_flight", () => {
    stroke();
    gm.setRegions([region("A", ["s1"], 0)]);
    clock.advance(1200);
    expect(fired).toEqual([["A", "settle"]]);
    gm.markInFlight("A", true);
    stroke();
    gm.noteElementsChanged(["s1"]);
    clock.advance(1200);
    expect(fired).toHaveLength(1);
    clock.advance(1000);
    expect(fired).toHaveLength(1);
    gm.markInFlight("A", false);
    expect(fired).toHaveLength(1); // retried on the 200 ms cadence, not synchronously
    clock.advance(200);
    expect(fired).toEqual([
      ["A", "settle"],
      ["A", "settle"],
    ]);
  });

  it("watchdog_fires_at_15s", () => {
    stroke();
    gm.setRegions([region("A", ["s1"], 0)]);
    gm.notePenDown(); // pen never lifts
    clock.advance(14_999);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([["A", "watchdog"]]);
    clock.advance(30_000);
    expect(fired).toEqual([["A", "watchdog"]]);
  });

  it("early_fire_when_sibling_out_of_reach", () => {
    stroke();
    gm.setRegions([region("A", ["s1"], 0)]);
    stroke();
    clock.advance(100);
    // B is written far to the right of A: A is done, fire it now.
    gm.setRegions([region("A", ["s1"], 0), region("B", ["s2"], 800)]);
    expect(fired).toEqual([["A", "early"]]);
    clock.advance(1200);
    expect(fired).toEqual([
      ["A", "early"],
      ["B", "settle"],
    ]);
  });

  it("no_early_fire_for_sibling_within_reach", () => {
    stroke();
    gm.setRegions([region("A", ["s1"], 0)]);
    stroke();
    gm.setRegions([region("A", ["s1"], 0), region("B", ["s2"], 130)]);
    expect(fired).toEqual([]);
  });

  it("neighbour_within_reach_is_redirtied", () => {
    stroke();
    gm.setRegions([region("A", ["s1"], 0)]);
    clock.advance(1200);
    expect(fired).toEqual([["A", "settle"]]);
    // B lands within reach of the clean A (e.g. written later): A is rechecked with the new context.
    stroke();
    gm.setRegions([region("A", ["s1"], 0), region("B", ["s2"], 130)]);
    clock.advance(1200);
    expect(fired.slice(1).sort()).toEqual([
      ["A", "settle"],
      ["B", "settle"],
    ]);
    // Editing B rechecks A too.
    fired = [];
    stroke();
    gm.noteElementsChanged(["s2"]);
    clock.advance(1200);
    expect(fired.sort()).toEqual([
      ["A", "settle"],
      ["B", "settle"],
    ]);
    // A far region is not rechecked.
    fired = [];
    stroke();
    gm.setRegions([region("A", ["s1"], 0), region("B", ["s2"], 130), region("F", ["s9"], 2000)]);
    clock.advance(1200);
    expect(fired).toEqual([["F", "settle"]]);
  });

  it("recheck_does_not_cascade", () => {
    stroke();
    // A–B and B–C are within reach; A–C is not.
    gm.setRegions([region("A", ["a"], 0), region("B", ["b"], 130), region("C", ["c"], 260)]);
    clock.advance(1200);
    fired = [];
    stroke();
    gm.noteElementsChanged(["c"]);
    clock.advance(1200);
    expect(fired.sort()).toEqual([
      ["B", "settle"],
      ["C", "settle"],
    ]);
  });

  it("removed_element_invalidates_region", () => {
    stroke();
    gm.setRegions([region("A", ["s1", "s2"], 0), region("B", ["s3"], 0, 400)]);
    clock.advance(1200);
    fired = [];
    gm.noteElementsChanged({ added: [], updated: [], removed: ["s2"] });
    expect(invalidated).toEqual(["A"]);
    clock.advance(5000);
    expect(fired).toEqual([]);
    // A region replaced by re-segmentation is invalidated too.
    gm.setRegions([region("A1", ["s1"], 0)]);
    expect(invalidated).toEqual(["A", "B"]);
  });

  it("dispose_cancels_timers", () => {
    stroke();
    gm.setRegions([region("A", ["s1"], 0)]);
    gm.dispose();
    clock.advance(20_000);
    expect(fired).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});
