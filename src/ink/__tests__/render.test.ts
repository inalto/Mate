import { describe, expect, it } from "vitest";
import { renderStroke } from "../render";
import type { Point } from "../types";
import type { Element } from "../../model/types";

type Call = [string, ...unknown[]];

/** Minimal CanvasRenderingContext2D stand-in that records calls and state (jsdom has no canvas). */
function stubCtx() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineCap: "butt",
    lineJoin: "miter",
  };
  const stack: Record<string, unknown>[] = [];
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
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    quadraticCurveTo: rec("quadraticCurveTo"),
    closePath: rec("closePath"),
    arc: rec("arc"),
    stroke: () => calls.push(["stroke", state.lineWidth, state.strokeStyle, state.lineCap, state.lineJoin]),
    fill: () => calls.push(["fill", state.fillStyle, state.globalAlpha, state.globalCompositeOperation]),
  };
  for (const key of Object.keys(state)) {
    Object.defineProperty(ctx, key, {
      get: () => state[key],
      set: (v) => {
        state[key] = v;
      },
    });
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, state };
}

const pt = (x: number, y: number): Point => ({ x, y, pressure: 0.5, timestamp: 0 });

function el(points: Point[], extra: Partial<Element> = {}): Element {
  return {
    id: "e1",
    pageId: "p1",
    type: "stroke",
    points,
    color: "#000000",
    width: 4,
    isHighlighter: false,
    penStyle: "pen",
    createdAt: "",
    updatedAt: "",
    version: 1,
    ...extra,
  };
}

describe("renderStroke", () => {
  it("pen_draws_one_capsule_run", () => {
    const { ctx, calls, state } = stubCtx();
    renderStroke(ctx, el([pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0)]), "light", 1);
    expect(calls.filter((c) => c[0] === "stroke")).toEqual([["stroke", 4, "#000000", "round", "round"]]);
    expect(calls.filter((c) => c[0] === "moveTo")).toEqual([["moveTo", 0, 0]]);
    const lines = calls.filter((c) => c[0] === "lineTo");
    expect(lines[lines.length - 1]).toEqual(["lineTo", 30, 0]);
    expect(state.lineWidth).toBe(1); // state restored
  });

  it("dark_theme_maps_colour", () => {
    const { ctx, calls } = stubCtx();
    renderStroke(ctx, el([pt(0, 0), pt(10, 0)], { color: "#C62828" }), "dark", 1);
    expect(calls.find((c) => c[0] === "stroke")?.[2]).toBe("#FF3B3B");
  });

  it("single_point_is_filled_arc", () => {
    const { ctx, calls } = stubCtx();
    renderStroke(ctx, el([pt(7, 8)], { width: 0.4 }), "light", 1);
    expect(calls.find((c) => c[0] === "arc")).toEqual(["arc", 7, 8, 0.4, 0, Math.PI * 2]);
    expect(calls.filter((c) => c[0] === "fill")).toHaveLength(1);
    expect(calls.filter((c) => c[0] === "stroke")).toHaveLength(0);
  });

  it("highlighter_outline_blend_and_restore", () => {
    const { ctx, calls, state } = stubCtx();
    const pts = [pt(0, 0), pt(20, 0), pt(40, 5), pt(60, 0)];
    renderStroke(ctx, el(pts, { penStyle: "highlighter", isHighlighter: true, width: 20, color: "#FDE047" }), "light", 1);
    expect(calls.filter((c) => c[0] === "stroke")).toHaveLength(0);
    const fills = calls.filter((c) => c[0] === "fill");
    expect(fills).toEqual([["fill", "#FDE047", 0.5, "multiply"]]);
    expect(calls.filter((c) => c[0] === "quadraticCurveTo").length).toBeGreaterThan(3);
    expect(calls.filter((c) => c[0] === "closePath")).toHaveLength(1);
    expect(state.globalAlpha).toBe(1);
    expect(state.globalCompositeOperation).toBe("source-over");

    const dark = stubCtx();
    renderStroke(dark.ctx, el(pts, { penStyle: "highlighter", isHighlighter: true, width: 20 }), "dark", 1);
    expect(dark.calls.find((c) => c[0] === "fill")?.[3]).toBe("screen");
  });
});
