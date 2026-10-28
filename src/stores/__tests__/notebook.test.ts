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
  moveBookshelf: vi.fn(async () => {}),
}));
vi.mock("../../ipc/settings", () => ({
  getSettings: vi.fn(),
  patchSettings: vi.fn(async () => {}),
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
const shelf = (id: string, order: number, parentId?: string): Bookshelf => ({
  id,
  title: id,
  order,
  isExpanded: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  version: 0,
  parentId,
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

  it("unitsInFolder_lists_a_folder_and_unfiled_books_at_the_root", () => {
    setTree({
      bookshelves: [shelf("s2", 1), shelf("s1", 0)],
      units: [
        unit("loose", "2026-01-01T00:00:00Z"),
        unit("a", "2026-01-01T00:00:00Z", { bookshelfId: "s1" }),
        unit("b", "2026-01-01T00:00:00Z", { bookshelfId: "s2" }),
        unit("orphan", "2026-01-01T00:00:00Z", { bookshelfId: "gone" }),
      ],
    });
    const s = useNotebookStore.getState();
    expect(s.unitsInFolder("s1").map((u) => u.id)).toEqual(["a"]);
    expect(s.unitsInFolder(null).map((u) => u.id)).toEqual(["loose", "orphan"]);
  });

  it("childFolders_lists_direct_children_in_order", () => {
    setTree({
      bookshelves: [shelf("b", 2), shelf("a", 1), shelf("a1", 3, "a"), shelf("a0", 0, "a"), shelf("lost", 4, "gone")],
    });
    const s = useNotebookStore.getState();
    // A folder whose parent is not in the tree shows at the root rather than vanishing.
    expect(s.childFolders(null).map((b) => b.id)).toEqual(["a", "b", "lost"]);
    expect(s.childFolders("a").map((b) => b.id)).toEqual(["a0", "a1"]);
    expect(s.childFolders("b")).toEqual([]);
  });

  it("folderPath_runs_from_the_root_to_the_folder", () => {
    setTree({ bookshelves: [shelf("a", 0), shelf("b", 1, "a"), shelf("c", 2, "b")] });
    const s = useNotebookStore.getState();
    expect(s.folderPath("c").map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(s.folderPath("a").map((b) => b.id)).toEqual(["a"]);
    expect(s.folderPath(null)).toEqual([]);
    expect(s.folderPath("missing")).toEqual([]);
  });

  it("folderPath_survives_a_corrupt_cycle", () => {
    setTree({ bookshelves: [shelf("a", 0, "b"), shelf("b", 1, "a")] });
    expect(useNotebookStore.getState().folderPath("a").map((b) => b.id)).toEqual(["b", "a"]);
  });

  it("folderSubtree_holds_the_folder_and_every_subfolder", () => {
    setTree({ bookshelves: [shelf("a", 0), shelf("b", 1, "a"), shelf("c", 2, "b"), shelf("d", 3)] });
    expect([...useNotebookStore.getState().folderSubtree("a")].sort()).toEqual(["a", "b", "c"]);
  });

  it("createBookshelf_creates_inside_a_parent", async () => {
    setTree({ bookshelves: [shelf("s1", 0)] });
    const b = await useNotebookStore.getState().createBookshelf("Physics", "s1");
    expect(b.parentId).toBe("s1");
    expect(vi.mocked(ipc.upsertBookshelf).mock.calls[0][0].parentId).toBe("s1");
    expect(useNotebookStore.getState().childFolders("s1").map((x) => x.title)).toEqual(["Physics"]);
  });

  it("moveBookshelf_moves_through_the_backend_and_updates_the_tree", async () => {
    setTree({ bookshelves: [shelf("a", 0), shelf("b", 1)] });
    await useNotebookStore.getState().moveBookshelf("b", "a");
    expect(ipc.moveBookshelf).toHaveBeenCalledWith("b", "a");
    expect(useNotebookStore.getState().childFolders("a").map((x) => x.id)).toEqual(["b"]);
    await useNotebookStore.getState().moveBookshelf("b", null);
    expect(ipc.moveBookshelf).toHaveBeenLastCalledWith("b", null);
    expect(useNotebookStore.getState().childFolders(null).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("moveBookshelf_reports_a_cycle_readably_and_keeps_the_tree", async () => {
    setTree({ bookshelves: [shelf("a", 0), shelf("b", 1, "a")] });
    vi.mocked(ipc.moveBookshelf).mockRejectedValueOnce("Cannot move a folder into itself");
    await expect(useNotebookStore.getState().moveBookshelf("a", "b")).rejects.toThrow(
      "Cannot move a folder into itself",
    );
    expect(useNotebookStore.getState().folderPath("b").map((x) => x.id)).toEqual(["a", "b"]);
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
