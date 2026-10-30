import { describe, expect, it, vi } from "vitest";
import type { Element, Page } from "../../model/types";

const io = vi.hoisted(() => ({ els: [] as Element[], written: [] as Element[] }));
vi.mock("../../ipc/notebook", () => ({
  getNotebookTree: vi.fn(async () => ({ bookshelves: [], units: [], sections: [], pages: [] })),
  upsertPage: vi.fn(async () => {}),
}));
vi.mock("../../ipc/elements", () => ({
  loadElements: vi.fn(async () => io.els),
  upsertElements: vi.fn(async (els: Element[]) => void io.written.push(...els)),
}));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: { flushAll: vi.fn(async () => {}) } }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { useNotebookStore } from "../notebook";

const STAMP = "2026-01-01T00:00:00.000Z";
const box = (id: string, x: number): Element => ({
  id,
  pageId: "p1",
  type: "text-box",
  points: [{ x, y: 0, pressure: 0.5, timestamp: 0 }],
  color: "#000000",
  width: 1,
  isHighlighter: false,
  boxWidth: 100,
  boxHeight: 50,
  content: { contentHtml: "", rawContent: "", textAttributes: {} },
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 0,
});
const connector = (id: string, source: string, target: string): Element => ({
  ...box(id, 0),
  type: "connector",
  boxWidth: undefined,
  boxHeight: undefined,
  points: [
    { x: 100, y: 25, pressure: 0.5, timestamp: 0 },
    { x: 400, y: 25, pressure: 0.5, timestamp: 1 },
  ],
  content: { mode: "straight", source: { id: source, side: "right" }, target: { id: target, side: "left" }, route: [] },
});

describe("duplicatePage", () => {
  it("binds_copied_connectors_to_the_copies_and_frees_ends_whose_element_is_not_copied", async () => {
    const page: Page = {
      id: "p1",
      sectionId: "s1",
      title: "T",
      isExpanded: false,
      isFavourite: false,
      depth: 0,
      mode: "canvas",
      backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
      thumbnailVersion: 0,
      orderIndex: 0,
      createdAt: STAMP,
      updatedAt: STAMP,
      version: 0,
    };
    useNotebookStore.setState({ tree: { bookshelves: [], units: [], sections: [], pages: [page] }, loaded: true });
    // The bound connector comes before its elements; the other names an element of no page.
    io.els = [connector("c", "a", "b"), box("a", 0), box("b", 400), connector("d", "a", "gone")];
    io.written = [];
    const copy = await useNotebookStore.getState().duplicatePage("p1");
    expect(copy).not.toBeNull();
    const byOld = new Map(io.els.map((e, i) => [e.id, io.written[i]]));
    expect(io.written.every((e) => e.pageId === copy!.id && !io.els.some((o) => o.id === e.id))).toBe(true);
    const c = byOld.get("c")!.content as { source?: { id: string; side: string }; target?: { id: string; side: string } };
    expect(c.source).toEqual({ id: byOld.get("a")!.id, side: "right" });
    expect(c.target).toEqual({ id: byOld.get("b")!.id, side: "left" });
    const d = byOld.get("d")!;
    const dc = d.content as { source?: { id: string }; target?: unknown };
    expect(dc.source?.id).toBe(byOld.get("a")!.id);
    expect(dc.target).toBeUndefined();
    // The freed end keeps its point.
    expect(d.points[1]).toMatchObject({ x: 400, y: 25 });
  });
});
