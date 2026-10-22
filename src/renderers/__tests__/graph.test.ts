import { beforeAll, describe, expect, it } from "vitest";
import { defaultGraphData, GRAPH_PALETTE, graphElement, type GraphData } from "../../graph/data";
import { loadEngine } from "../../graph/engine";
import type { Element } from "../../model/types";
import "../builtins";
import { drawElement, elementSvg } from "../registry";

type Call = [string, ...unknown[]];

/** Recording CanvasRenderingContext2D stand-in (jsdom has no canvas). */
function stubCtx() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {
    lineWidth: 1,
    fillStyle: "#000",
    strokeStyle: "#000",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    lineJoin: "miter",
    lineCap: "butt",
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
    rect: rec("rect"),
    clip: rec("clip"),
    translate: rec("translate"),
    rotate: rec("rotate"),
    drawImage: rec("drawImage"),
    fillRect: (...a: unknown[]) => calls.push(["fillRect", state.fillStyle, ...a]),
    fillText: (text: string, x: number, y: number) => calls.push(["fillText", text, x, y, state.font, state.fillStyle]),
    stroke: () => calls.push(["stroke", state.lineWidth, state.strokeStyle]),
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

const STAMP = "2026-01-01T00:00:00.000Z";

function graph(latex: string[], extra: Partial<GraphData> = {}): Element {
  const el = graphElement("pg", "g1", STAMP, { x: 100, y: 50 }, "#000000");
  const graphData: GraphData = {
    ...defaultGraphData(),
    expressions: latex.map((l, i) => ({ id: `e${i}`, latex: l, color: GRAPH_PALETTE[i], visible: true })),
    ...extra,
  };
  return { ...el, content: { subtype: "graph", graphData } };
}

const opts = { theme: "light" as const, zoomBucket: 1 };

describe("graph renderer", () => {
  beforeAll(async () => {
    await loadEngine();
  });

  it("draws_the_plot_directly_in_its_box", () => {
    const { ctx, calls } = stubCtx();
    drawElement(ctx, graph(["\\sin(x)"]), opts);
    expect(calls.some((c) => c[0] === "drawImage")).toBe(false); // vector, never a snapshot
    expect(calls).toContainEqual(["translate", 100, 50]);
    expect(calls).toContainEqual(["fillRect", "#ffffff", 0, 0, 480, 360]);
    expect(calls.filter((c) => c[0] === "stroke" && c[1] === 2 && c[2] === GRAPH_PALETTE[0]).length).toBeGreaterThanOrEqual(1);
    const texts = calls.filter((c) => c[0] === "fillText");
    expect(texts.map((c) => c[1])).toContain("4");
    expect(String(texts[0][4])).toMatch(/^11px .*Mono/);
    expect(calls[0]).toEqual(["save"]);
    expect(calls[calls.length - 1]).toEqual(["restore"]);
  });

  it("dark_theme_uses_dark_paper_and_remapped_colours", () => {
    const { ctx, calls } = stubCtx();
    drawElement(ctx, graph(["x"]), { ...opts, theme: "dark" });
    expect(calls.find((c) => c[0] === "fillRect")![1]).toBe("#18181b");
    expect(calls.some((c) => c[0] === "stroke" && c[2] === "#FF3B3B")).toBe(true);
  });

  it("svg_is_vector_lines_polylines_and_text", () => {
    const svg = elementSvg(graph(["x^2"], { grid: true }), opts);
    expect(svg).toMatch(/^<g transform="translate\(100 50\)">/);
    expect(svg).toContain("<line ");
    expect(svg).toContain(`<polyline fill="none" stroke="${GRAPH_PALETTE[0]}" stroke-width="2"`);
    expect(svg).toContain(">4</text>");
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("foreignObject");
  });

  it("bad_or_empty_content_still_renders_axes", () => {
    const el = { ...graph([]), content: { subtype: "graph", graphData: "junk" } } as unknown as Element;
    const svg = elementSvg(el, opts);
    expect(svg).toContain("<line ");
    expect(svg).not.toContain("<polyline");
  });
});
