import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Recognition } from "../../model/types";
import { drawTutorMarkers, hitTutorMarker, markerAnchor, markerColors, markerUnits, squigglePoints, tutorMarkers, type MarkerContext, type MarkerSource } from "../overlay";

const bounds = { x: 100, y: 100, width: 200, height: 40 };

function rec(id: string, correct: boolean | null, over: Partial<Recognition> = {}): Recognition {
  return {
    pageId: "pg",
    strokeGroupId: id,
    elementIds: [id + "-e"],
    bounds,
    capturedAt: 1,
    source: "auto",
    userOverride: false,
    provider: "anthropic",
    model: "m",
    createdAt: "",
    updatedAt: "",
    description: "",
    latex: "x=1",
    correct,
    domain: "algebra",
    errorNature: null,
    hint: "Check the sign.",
    explanation: null,
    nextSteps: null,
    focusSpan: null,
    illegible: false,
    transcription: null,
    code: "OK",
    kind: "math",
    ...over,
  };
}

const view = (over: Partial<MarkerSource> = {}): MarkerSource => ({
  recognitions: new Map(),
  inFlight: new Set(),
  unchecked: new Map(),
  regions: new Map(),
  ...over,
});
const on = { ...DEFAULT_SETTINGS, tutorUnderlineErrors: true, correctnessMode: true, tutorShowChecking: true };

function fakeCtx() {
  const calls: string[] = [];
  const styles: string[] = [];
  const ctx = {
    calls,
    styles,
    lineWidth: 1,
    lineCap: "butt" as CanvasLineCap,
    lineJoin: "miter" as CanvasLineJoin,
    set strokeStyle(v: string) {
      styles.push(v);
    },
    get strokeStyle() {
      return styles[styles.length - 1] ?? "";
    },
  } as unknown as MarkerContext & { calls: string[]; styles: string[] };
  for (const m of ["save", "restore", "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "arc", "stroke", "setTransform"] as const) {
    (ctx as unknown as Record<string, unknown>)[m] = () => calls.push(m);
  }
  return ctx;
}

describe("tutor markers", () => {
  it("squiggle_only_when_incorrect_and_enabled", () => {
    const v = view({ recognitions: new Map([["a", rec("a", false)], ["b", rec("b", null)], ["c", rec("c", false, { illegible: true })]]) });
    expect(tutorMarkers(v, on)).toEqual([{ groupId: "a", kind: "squiggle", bounds }]);
    expect(tutorMarkers(v, { ...on, tutorUnderlineErrors: false })).toEqual([]);

    const ctx = fakeCtx();
    drawTutorMarkers(ctx, tutorMarkers(v, on), { x: 0, y: 0, z: 1 }, 1, "light", 0);
    expect(ctx.styles).toContain("#C62828");
    expect(ctx.calls).toContain("quadraticCurveTo");
    const dark = fakeCtx();
    drawTutorMarkers(dark, tutorMarkers(v, on), { x: 0, y: 0, z: 1 }, 1, "dark", 0);
    expect(dark.styles).toContain("#FF3B3B");
  });

  it("tick_only_when_correctness_mode", () => {
    const v = view({ recognitions: new Map([["a", rec("a", true)]]) });
    expect(tutorMarkers(v, on)).toEqual([{ groupId: "a", kind: "tick", bounds }]);
    expect(tutorMarkers(v, { ...on, correctnessMode: false })).toEqual([]);
    // The user's own "Mark as correct" always shows its tick.
    const o = view({ recognitions: new Map([["a", rec("a", true, { userOverride: true })]]) });
    expect(tutorMarkers(o, { ...on, correctnessMode: false })).toEqual([{ groupId: "a", kind: "tick", bounds }]);
    const ctx = fakeCtx();
    drawTutorMarkers(ctx, tutorMarkers(v, on), { x: 0, y: 0, z: 1 }, 1, "light", 0);
    expect(ctx.styles).toContain(markerColors("light").success);
  });

  it("ring_while_in_flight", () => {
    const v = view({
      recognitions: new Map([["a", rec("a", false)]]),
      inFlight: new Set(["a"]),
      regions: new Map([["a", { bounds }]]),
    });
    const ms = tutorMarkers(v, on);
    expect(ms).toEqual([{ groupId: "a", kind: "ring", bounds }]);
    const ctx = fakeCtx();
    expect(drawTutorMarkers(ctx, ms, { x: 0, y: 0, z: 1 }, 1, "light", 123)).toBe(true);
    expect(ctx.calls).toContain("arc");
    // Without "show checking", the last verdict stays and nothing animates.
    const quiet = tutorMarkers(v, { ...on, tutorShowChecking: false });
    expect(quiet.map((m) => m.kind)).toEqual(["squiggle"]);
    expect(drawTutorMarkers(fakeCtx(), quiet, { x: 0, y: 0, z: 1 }, 1, "light", 0)).toBe(false);
  });

  it("unchecked_group_shows_a_muted_dash", () => {
    const v = view({ unchecked: new Map([["a", { kind: "network", reason: "offline" }]]), regions: new Map([["a", { bounds }]]) });
    expect(tutorMarkers(v, on)).toEqual([{ groupId: "a", kind: "unchecked", bounds }]);
    const ctx = fakeCtx();
    drawTutorMarkers(ctx, tutorMarkers(v, on), { x: 0, y: 0, z: 1 }, 1, "light", 0);
    expect(ctx.styles).toEqual([markerColors("light").muted]);
  });

  it("squiggle_is_stable_per_group_and_markers_stay_legible", () => {
    expect(squigglePoints("g1", bounds, 1)).toEqual(squigglePoints("g1", bounds, 1));
    expect(squigglePoints("g1", bounds, 1)).not.toEqual(squigglePoints("g2", bounds, 1));
    for (const q of squigglePoints("g1", bounds, 1)) expect(q.y).toBeGreaterThan(bounds.y + bounds.height);
    // Zoomed far out the marker keeps at least 12 px on screen; zoomed in it is capped.
    expect(markerUnits(0.1) * 0.1).toBeCloseTo(12);
    expect(markerUnits(1)).toBe(16);
    expect(markerUnits(10) * 10).toBeCloseTo(40);
  });

  it("hit_test_finds_tick_and_squiggle", () => {
    const tick = { groupId: "t", kind: "tick" as const, bounds };
    const sq = { groupId: "s", kind: "squiggle" as const, bounds: { x: 100, y: 300, width: 200, height: 40 } };
    const a = markerAnchor(bounds, 1);
    expect(hitTutorMarker([tick, sq], { x: a.x, y: a.y }, 1)?.groupId).toBe("t");
    expect(hitTutorMarker([tick, sq], { x: 200, y: 348 }, 1)?.groupId).toBe("s");
    expect(hitTutorMarker([tick, sq], { x: 200, y: 120 }, 1)).toBeNull();
  });
});
