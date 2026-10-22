import { describe, expect, it, vi } from "vitest";
import { GRAPH_PALETTE, graphElement } from "../../graph/data";
import { loadEngine } from "../../graph/engine";
import type { Element } from "../../model/types";
import { boxSnapshots } from "../boxSnapshot";
import "../builtins";
import { elementSvg } from "../registry";

const STAMP = "2026-01-01T00:00:00.000Z";
const opts = { theme: "light" as const, zoomBucket: 1 };

function graph(): Element {
  const el = graphElement("pg", "g-lazy", STAMP, { x: 0, y: 0 }, "#000000");
  return {
    ...el,
    content: {
      subtype: "graph",
      graphData: { kind: "2d-function", expressions: [{ id: "e", latex: "x", color: GRAPH_PALETTE[0], visible: true }], domain: { xMin: -10, xMax: 10, yMin: -10, yMax: 10 }, grid: true },
    },
  };
}

describe("graph renderer before the engine loads", () => {
  it("shows_loading_then_re_rasters_when_the_engine_arrives", async () => {
    const seen = vi.fn();
    const unsub = boxSnapshots.subscribe(seen);
    const g = graph();
    const before = elementSvg(g, opts);
    expect(before).toContain(">Loading…</text>");
    expect(before).toContain("<line ");
    expect(before).not.toContain("<polyline");
    await loadEngine();
    await Promise.resolve();
    expect(seen).toHaveBeenCalledWith("g-lazy");
    const after = elementSvg(g, opts); // the pending scene was not cached
    expect(after).toContain("<polyline");
    expect(after).not.toContain("Loading…");
    unsub();
  });
});
