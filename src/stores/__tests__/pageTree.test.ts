import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "../../model/types";

vi.mock("../../ipc/notebook", () => ({ upsertPage: vi.fn(async () => {}) }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []), upsertElements: vi.fn(async () => {}) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
const order = vi.hoisted(() => [] as string[]);
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: {
    flushAll: vi.fn(async () => {
      order.push("flush");
    }),
  },
}));

import * as elementsIpc from "../../ipc/elements";
import { useNotebookStore } from "../notebook";

const page = (id: string, orderIndex: number, extra: Partial<Page> = {}): Page => ({
  id,
  sectionId: "s",
  title: id,
  isExpanded: true,
  isFavourite: false,
  depth: 0,
  mode: "canvas",
  backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
  thumbnailVersion: 0,
  orderIndex,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  version: 0,
  ...extra,
});
const get = (id: string) => useNotebookStore.getState().tree.pages.find((p) => p.id === id)!;

describe("page tree operations", () => {
  beforeEach(() => {
    useNotebookStore.setState({
      loaded: true,
      tree: {
        bookshelves: [],
        units: [],
        sections: [],
        pages: [page("a", 0), page("b", 1), page("b1", 0, { parentId: "b", depth: 1 }), page("c", 2)],
      },
    });
  });

  it("movePage_swaps_with_neighbour", async () => {
    await useNotebookStore.getState().movePage("b", -1);
    expect([get("a").orderIndex, get("b").orderIndex]).toEqual([1, 0]);
    await useNotebookStore.getState().movePage("b", -1); // already first: no-op
    expect(get("b").orderIndex).toBe(0);
  });

  it("demote_nests_under_previous_sibling_with_descendants", async () => {
    await useNotebookStore.getState().indentPage("b", 1);
    expect(get("b").parentId).toBe("a");
    expect(get("b").depth).toBe(1);
    expect(get("b1").depth).toBe(2);
    expect(get("b1").parentId).toBe("b");
  });

  it("promote_moves_after_former_parent", async () => {
    await useNotebookStore.getState().indentPage("b1", -1);
    expect(get("b1").parentId).toBeUndefined();
    expect(get("b1").depth).toBe(0);
    const top = useNotebookStore.getState().tree.pages.filter((p) => !p.parentId).sort((x, y) => x.orderIndex - y.orderIndex);
    expect(top.map((p) => p.id)).toEqual(["a", "b", "b1", "c"]);
  });

  it("duplicatePage_flushes_pending_writes_first", async () => {
    order.length = 0;
    vi.mocked(elementsIpc.loadElements).mockImplementationOnce(async () => {
      order.push("load");
      return [];
    });
    await useNotebookStore.getState().duplicatePage("a");
    expect(order).toEqual(["flush", "load"]);
  });
});
