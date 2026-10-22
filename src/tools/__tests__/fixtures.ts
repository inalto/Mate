import type { Element, Point } from "../../model/types";

export const pt = (x: number, y: number, i = 0): Point => ({ x, y, pressure: 0.5, timestamp: i });

export function el(id: string, xy: [number, number][], opts: Partial<Element> = {}): Element {
  return {
    id,
    pageId: "pg",
    type: "stroke",
    points: xy.map(([x, y], i) => pt(x, y, i)),
    color: "#000000",
    width: 2,
    isHighlighter: false,
    penStyle: "pen",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 0,
    ...opts,
  };
}

export const mapOf = (els: Element[]) => new Map(els.map((e) => [e.id, e]));
