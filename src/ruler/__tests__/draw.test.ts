// The ruler painter, against a recording context (jsdom has no canvas): one filled body, the ticks
// of each edge's system as one path per edge, a bounded number of segments when zoomed out, and
// nothing at all when the ruler is out of view.
import { describe, expect, it } from "vitest";
import type { Camera, Viewport } from "../../canvas/camera";
import type { RulerUnits } from "../../model/types";
import { drawRuler, type RulerColors } from "../draw";
import type { RulerPose } from "../pose";

type Call = [string, ...unknown[]];

/** Records calls and the drawing state; each `stroke` notes how many segments its path holds. */
function stubCtx() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {
    lineWidth: 1,
    fillStyle: "#000",
    strokeStyle: "#000",
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    lineCap: "butt",
  };
  const stack: Record<string, unknown>[] = [];
  let segments = 0;
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const ctx: Record<string, unknown> = {
    save: () => {
      stack.push({ ...state });
      calls.push(["save"]);
    },
    restore: () => {
      Object.assign(state, stack.pop());
      calls.push(["restore"]);
    },
    beginPath: () => {
      segments = 0;
      calls.push(["beginPath"]);
    },
    moveTo: (...a: unknown[]) => {
      segments++;
      calls.push(["moveTo", ...a]);
    },
    lineTo: rec("lineTo"),
    rect: rec("rect"),
    closePath: rec("closePath"),
    setTransform: rec("setTransform"),
    translate: rec("translate"),
    rotate: rec("rotate"),
    clearRect: rec("clearRect"),
    fillRect: (...a: unknown[]) => calls.push(["fillRect", state.fillStyle, ...a]),
    fillText: (...a: unknown[]) => calls.push(["fillText", state.fillStyle, state.font, ...a]),
    stroke: () => calls.push(["stroke", state.strokeStyle, state.lineWidth, segments]),
    fill: () => calls.push(["fill", state.fillStyle]),
  };
  for (const key of Object.keys(state)) {
    Object.defineProperty(ctx, key, {
      get: () => state[key],
      set: (v) => {
        state[key] = v;
      },
    });
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const colors: RulerColors = { body: "rgba(120, 170, 230, 0.35)", edge: "#3a6ea5", ink: "#1d3557" };
const viewport: Viewport = { width: 1000, height: 700 };
const at = (z: number): Camera => ({ x: 0, y: 0, z });
/** Anchor in the middle of the pane at camera (0, 0, z). */
const pose = (z: number, angle = 0): RulerPose => ({ x: 500 / z, y: 350 / z, angle });

function paint(p: RulerPose, camera: Camera, units: RulerUnits) {
  const { ctx, calls } = stubCtx();
  drawRuler(ctx, p, camera, viewport, units, colors, 2);
  return calls;
}

/** Tick strokes: ink at 1 px (the zero mark is thicker), in drawing order: edge +1, then edge −1. */
const tickStrokes = (calls: Call[]) =>
  calls.filter((c) => c[0] === "stroke" && c[1] === colors.ink && c[2] === 1).map((c) => c[3] as number);

describe("drawRuler", () => {
  it("fills the body once in the body colour", () => {
    const calls = paint(pose(1), at(1), "both");
    const bodies = calls.filter((c) => (c[0] === "fill" || c[0] === "fillRect") && c[1] === colors.body);
    expect(bodies).toHaveLength(1);
  });

  it("keeps its state to itself: one save, one restore", () => {
    const calls = paint(pose(1, 30), at(1), "both");
    expect(calls.filter((c) => c[0] === "save")).toHaveLength(1);
    expect(calls.filter((c) => c[0] === "restore")).toHaveLength(1);
    expect(calls[0][0]).toBe("save");
    expect(calls[calls.length - 1][0]).toBe("restore");
  });

  it("with both systems, the edges carry different ticks (mm against sixteenths)", () => {
    const strokes = tickStrokes(paint(pose(1), at(1), "both"));
    expect(strokes).toHaveLength(2);
    expect(strokes[0]).toBeGreaterThan(0);
    expect(strokes[1]).toBeGreaterThan(0);
    expect(strokes[0]).not.toBe(strokes[1]);
  });

  it("with metric only, both edges carry the same ticks", () => {
    const strokes = tickStrokes(paint(pose(1), at(1), "metric"));
    expect(strokes).toHaveLength(2);
    expect(strokes[0]).toBeGreaterThan(0);
    expect(strokes[0]).toBe(strokes[1]);
  });

  it("draws fewer than 400 tick segments at zoom 0.1", () => {
    for (const angle of [0, 30, 90, 200]) {
      const strokes = tickStrokes(paint(pose(0.1, angle), at(0.1), "both"));
      const total = strokes.reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThan(400);
    }
  });

  it("labels in 11 px sans-serif and the ink colour", () => {
    const labels = paint(pose(1), at(1), "both").filter((c) => c[0] === "fillText");
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      expect(l[1]).toBe(colors.ink);
      expect(l[2]).toBe("11px sans-serif");
    }
  });

  it("keeps the labels apart when zoomed out", () => {
    for (const z of [0.1, 0.3, 1, 4]) {
      const labels = paint(pose(z), at(z), "both").filter((c) => c[0] === "fillText");
      expect(labels.length).toBeGreaterThan(0);
      for (const v of new Set(labels.map((l) => l[5]))) {
        const us = labels.filter((l) => l[5] === v).map((l) => l[4] as number).sort((a, b) => a - b);
        for (let i = 1; i < us.length; i++) expect(us[i] - us[i - 1]).toBeGreaterThanOrEqual(28 - 1e-9);
      }
    }
  });

  it("turns the labels half a turn when the ruler points leftwards", () => {
    const halfTurns = (angle: number) => paint(pose(1, angle), at(1), "both").filter((c) => c[0] === "rotate" && c[1] === Math.PI).length;
    expect(halfTurns(0)).toBe(0);
    expect(halfTurns(90)).toBe(0);
    expect(halfTurns(91)).toBe(1);
    expect(halfTurns(270)).toBe(1);
    expect(halfTurns(271)).toBe(0);
  });

  it("draws the zero mark across the whole width", () => {
    const calls = paint(pose(1), at(1), "both");
    const zero = calls.filter((c) => c[0] === "stroke" && c[1] === colors.ink && c[2] !== 1);
    expect(zero).toHaveLength(1);
  });

  it("draws nothing when the ruler is out of view", () => {
    const calls = paint({ x: 5000, y: 5000, angle: 0 }, at(1), "both");
    expect(calls).toEqual([]);
  });

  it("paints the body while its centreline is 20 px above the pane, and nothing at 80 px", () => {
    const near = paint({ x: 500, y: -20, angle: 0 }, at(1), "both");
    expect(near.filter((c) => (c[0] === "fill" || c[0] === "fillRect") && c[1] === colors.body)).toHaveLength(1);
    expect(paint({ x: 500, y: -80, angle: 0 }, at(1), "both")).toEqual([]);
    // Also beside the pane, turned upright.
    expect(paint({ x: 1040, y: 350, angle: 90 }, at(1), "both").length).toBeGreaterThan(0);
    expect(paint({ x: 1080, y: 350, angle: 90 }, at(1), "both")).toEqual([]);
  });
});
