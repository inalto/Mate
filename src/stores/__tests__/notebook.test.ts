import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bookshelf, NotebookTree, Unit } from "../../model/types";

vi.mock("../../ipc/notebook", () => ({
  getNotebookTree: vi.fn(async () => ({ bookshelves: [], units: [], sections: [], pages: [] })),
  upsertBookshelf: vi.fn(async () => {}),
  upsertUnit: vi.fn(async () => {}),
  upsertSection: vi.fn(async () => {}),
  upsertPage: vi.fn(async () => {}),
  softDeleteEntity: vi.fn(async () => {}),
  restoreEntity: vi.fn(async () => {}),
  listTrash: vi.fn(async () => []),
  purgeEntity: vi.fn(async () => {}),
  purgeTrashOlderThan: vi.fn(async () => 0),
}));
vi.mock("../../ipc/settings", () => ({
  getSettings: vi.fn(),
  setSettings: vi.fn(async () => {}),
}));

import * as ipc from "../../ipc/notebook";
import { useNotebookStore } from "../notebook";

const unit = (id: string, updatedAt: string, extra: Partial<Unit> = {}): Unit => ({
  id,
  title: id,
  isFavourite: false,
  isExpanded: true,
  orderIndex: 0,
  createdAt: updatedAt,
  updatedAt,
  version: 0,
  ...extra,
});
const shelf = (id: string, order: number): Bookshelf => ({
  id,
  title: id,
  order,
  isExpanded: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  version: 0,
});
const setTree = (tree: Partial<NotebookTree>) =>
  useNotebookStore.setState({
    tree: { bookshelves: [], units: [], sections: [], pages: [], ...tree },
    loaded: true,
  });

beforeEach(() => {
  vi.clearAllMocks();
  setTree({});
});

describe("notebook store", () => {
  it("createUnit_seeds_section_and_page", async () => {
    const u = await useNotebookStore.getState().createUnit("Physics");
    const { tree } = useNotebookStore.getState();
    expect(u.title).toBe("Physics");
    expect(tree.units).toHaveLength(1);
    expect(tree.sections).toHaveLength(1);
    expect(tree.sections[0].title).toBe("Notes");
    expect(tree.sections[0].unitId).toBe(u.id);
    expect(tree.pages).toHaveLength(1);
    expect(tree.pages[0].title).toBe("Page 1");
    expect(tree.pages[0].sectionId).toBe(tree.sections[0].id);
    expect(ipc.upsertUnit).toHaveBeenCalledTimes(1);
    expect(ipc.upsertSection).toHaveBeenCalledTimes(1);
    expect(ipc.upsertPage).toHaveBeenCalledTimes(1);
  });

  it("unitsByRecent_sorts_by_updated_at_desc", () => {
    setTree({
      units: [
        unit("old", "2026-01-01T00:00:00Z"),
        unit("new", "2026-03-01T00:00:00Z"),
        unit("mid", "2026-02-01T00:00:00Z"),
      ],
    });
    expect(useNotebookStore.getState().unitsByRecent().map((u) => u.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("unitsByShelf_groups_unshelved_last", () => {
    setTree({
      bookshelves: [shelf("s2", 1), shelf("s1", 0)],
      units: [
        unit("loose", "2026-01-01T00:00:00Z"),
        unit("a", "2026-01-01T00:00:00Z", { bookshelfId: "s1" }),
        unit("b", "2026-01-01T00:00:00Z", { bookshelfId: "s2" }),
      ],
    });
    const groups = useNotebookStore.getState().unitsByShelf();
    expect(groups.map((g) => g.shelf?.id ?? null)).toEqual(["s1", "s2", null]);
    expect(groups[2].units.map((u) => u.id)).toEqual(["loose"]);
  });

  it("unitsByRecent_rolls_up_page_activity", () => {
    setTree({
      units: [unit("a", "2026-03-01T00:00:00Z"), unit("b", "2026-01-01T00:00:00Z")],
      sections: [
        {
          id: "sb",
          unitId: "b",
          title: "Notes",
          color: "#4a5d4e",
          orderIndex: 0,
          isExpanded: true,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          version: 0,
        },
      ],
      pages: [
        {
          id: "p",
          sectionId: "sb",
          title: "P",
          isExpanded: true,
          isFavourite: false,
          depth: 0,
          mode: "canvas",
          backgroundConfig: { type: "ruled", spacing: 40, dotRadius: 1.5 },
          thumbnailVersion: 0,
          orderIndex: 0,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-06-01T00:00:00Z",
          version: 0,
        },
      ],
    });
    expect(useNotebookStore.getState().unitsByRecent().map((u) => u.id)).toEqual(["b", "a"]);
  });

  it("createBookshelf_uses_shelf_count_as_order", async () => {
    setTree({ bookshelves: [shelf("s1", 0)] });
    const b = await useNotebookStore.getState().createBookshelf("Science");
    expect(b.order).toBe(1);
    expect(ipc.upsertBookshelf).toHaveBeenCalledTimes(1);
    expect(useNotebookStore.getState().tree.bookshelves).toHaveLength(2);
  });
});
