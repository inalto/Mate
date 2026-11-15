import { describe, expect, it } from "vitest";
import type { Element } from "../../model/types";
import { renderOrder, reorder } from "../zorder";

const el = (id: string, createdAt: string, over: Partial<Element> = {}): Element => ({
  id,
  pageId: "p1",
  type: "stroke",
  points: [{ x: 0, y: 0, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: 4,
  isHighlighter: false,
  penStyle: "pen",
  createdAt,
  updatedAt: createdAt,
  version: 0,
  ...over,
});
const cover = (id: string, createdAt: string, z?: number) =>
  el(id, createdAt, { penStyle: "cover", content: z === undefined ? undefined : { zIndex: z } });
const pen = (id: string, createdAt: string, z?: number) => el(id, createdAt, z === undefined ? {} : { content: { zIndex: z } });

describe("z-order with covers", () => {
  it("puts a cover last even when a later pen stroke has a high zIndex", () => {
    const order = renderOrder([cover("c", "2026-01-01"), pen("p", "2026-01-02", 5)]);
    expect(order.map((e) => e.id)).toEqual(["p", "c"]);
  });

  it("bringing a pen stroke to the front does not move it above a cover", () => {
    const c = cover("c", "2026-01-01");
    const a = pen("a", "2026-01-02");
    const b = pen("b", "2026-01-03");
    const changed = reorder([c, a, b], new Set(["a"]), "front");
    const next = [c, ...[a, b].map((e) => changed.find((x) => x.id === e.id) ?? e)];
    expect(renderOrder(next).map((e) => e.id)).toEqual(["b", "a", "c"]);
    expect(changed.find((x) => x.id === "c")).toBeUndefined();
  });

  it("reorders covers among covers only", () => {
    const c1 = cover("c1", "2026-01-01");
    const c2 = cover("c2", "2026-01-02");
    const a = pen("a", "2026-01-03");
    const changed = reorder([c1, c2, a], new Set(["c1"]), "front");
    expect(changed.map((e) => e.id)).toEqual(["c1"]);
    const next = [c2, a, changed[0]];
    expect(renderOrder(next).map((e) => e.id)).toEqual(["a", "c2", "c1"]);
  });
});
