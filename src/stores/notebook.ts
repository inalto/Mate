import { create } from "zustand";
import type {
  Bookshelf,
  EntityKind,
  NotebookTree,
  Page,
  Section,
  TrashItem,
  Unit,
} from "../model/types";
import i18n from "../i18n";
import * as ipc from "../ipc/notebook";
import { loadElements, upsertElements } from "../ipc/elements";
import { elementsQueue } from "../ipc/elementsQueue";
import { gcAssets } from "../ipc/assets";
import { useSettingsStore } from "./settings";
import { sheetSizeFor } from "../canvas/camera";

/** The backend's message when a folder would move into itself or one of its subfolders. */
export const FOLDER_CYCLE = "Cannot move a folder into itself";

interface NotebookState {
  tree: NotebookTree;
  loaded: boolean;
  trashItems: TrashItem[];
  load: () => Promise<void>;
  loadTrash: () => Promise<void>;
  /** Create a folder, inside `parentId` when given (else at the Library root). */
  createBookshelf: (title: string, parentId?: string) => Promise<Bookshelf>;
  /** Move a folder into `parentId` (null: the root). Rejects, readably, a move into itself. */
  moveBookshelf: (id: string, parentId: string | null) => Promise<void>;
  createUnit: (title: string, bookshelfId?: string) => Promise<Unit>;
  createSection: (unitId: string, title: string) => Promise<Section>;
  /** Create a page with mode/background from settings; `overrides` replace those defaults. */
  createPage: (sectionId: string, title: string, parentId?: string, overrides?: Partial<Page>) => Promise<Page>;
  rename: (kind: EntityKind, id: string, title: string) => Promise<void>;
  setColor: (kind: EntityKind, id: string, color: string) => Promise<void>;
  toggleFavourite: (kind: EntityKind, id: string) => Promise<void>;
  /** Adopt a page's new thumbnail version locally (the backend already bumped it). */
  setThumbnailVersion: (pageId: string, version: number) => void;
  /** Persist an edited page record (settings dialog, icon). */
  updatePage: (page: Page) => Promise<void>;
  /** Move a page one place up/down among its siblings. */
  movePage: (id: string, dir: -1 | 1) => Promise<void>;
  /** Demote (+1: become a child of the previous sibling) or promote (-1: become a sibling of the parent). */
  indentPage: (id: string, dir: -1 | 1) => Promise<void>;
  /** Copy a page and its elements; the copy follows the original. Resolves to the copy. */
  duplicatePage: (id: string) => Promise<Page | null>;
  moveUnitToBookshelf: (unitId: string, bookshelfId: string | null) => Promise<void>;
  reorder: (kind: EntityKind, parentId: string | null, orderedIds: string[]) => Promise<void>;
  trash: (kind: EntityKind, id: string) => Promise<void>;
  restore: (kind: EntityKind, id: string) => Promise<void>;
  /** Delete permanently, then remove assets nothing references any more. */
  purge: (kind: EntityKind, id: string) => Promise<void>;
  /** Delete every trash item permanently, then collect unreferenced assets once. */
  emptyTrash: () => Promise<void>;
  unitsByRecent: () => Unit[];
  unitsAZ: () => Unit[];
  /** Direct subfolders of `parentId` (null: top level, including folders whose parent is gone). */
  childFolders: (parentId: string | null) => Bookshelf[];
  /** Folders from the root down to `id` (inclusive); empty for the root or an unknown id. */
  folderPath: (id: string | null) => Bookshelf[];
  /** `id` and every folder below it. */
  folderSubtree: (id: string) => Set<string>;
  /** Books in folder `id`; null gives the unfiled ones (no folder, or a folder that is gone). */
  unitsInFolder: (id: string | null) => Unit[];
  recentPages: (n: number) => Page[];
  favouritePages: () => Page[];
}

interface Changes {
  title?: string;
  color?: string;
  toggleFavourite?: boolean;
}

/** Remove asset files (images, PDFs) that no element references after a purge; never fails. */
export async function collectAssets(): Promise<void> {
  try {
    await gcAssets();
  } catch (err) {
    console.warn("asset gc failed", err);
  }
}

const emptyTree = (): NotebookTree => ({ bookshelves: [], units: [], sections: [], pages: [] });
const now = () => new Date().toISOString();
const byDateDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

const upsertById = <T extends { id: string }>(list: T[], item: T): T[] =>
  list.some((x) => x.id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item];

export const useNotebookStore = create<NotebookState>((set, get) => {
  const tree = () => get().tree;
  const setTree = (p: Partial<NotebookTree>) => set({ tree: { ...get().tree, ...p } });

  const saveUnit = async (u: Unit) => {
    await ipc.upsertUnit(u);
    setTree({ units: upsertById(tree().units, u) });
  };
  const saveSection = async (s: Section) => {
    await ipc.upsertSection(s);
    setTree({ sections: upsertById(tree().sections, s) });
  };
  const savePage = async (p: Page) => {
    await ipc.upsertPage(p);
    setTree({ pages: upsertById(tree().pages, p) });
  };
  const saveShelf = async (b: Bookshelf) => {
    await ipc.upsertBookshelf(b);
    setTree({ bookshelves: upsertById(tree().bookshelves, b) });
  };

  /** Apply changes to an entity of any kind, persist it, and update the tree. */
  const patch = async (kind: EntityKind, id: string, c: Changes) => {
    const t = tree();
    const updatedAt = now();
    const fav = (current: boolean) => (c.toggleFavourite ? !current : current);
    if (kind === "unit") {
      const e = t.units.find((x) => x.id === id);
      if (!e) return;
      await saveUnit({
        ...e,
        title: c.title ?? e.title,
        color: c.color ?? e.color,
        isFavourite: fav(e.isFavourite),
        updatedAt,
      });
    } else if (kind === "section") {
      const e = t.sections.find((x) => x.id === id);
      if (!e) return;
      await saveSection({ ...e, title: c.title ?? e.title, color: c.color ?? e.color, updatedAt });
    } else if (kind === "page") {
      const e = t.pages.find((x) => x.id === id);
      if (!e) return;
      await savePage({
        ...e,
        title: c.title ?? e.title,
        isFavourite: fav(e.isFavourite),
        updatedAt,
      });
    } else {
      const e = t.bookshelves.find((x) => x.id === id);
      if (!e) return;
      await saveShelf({ ...e, title: c.title ?? e.title, color: c.color ?? e.color, updatedAt });
    }
  };

  /** Pages with the same section and parent as `page`, in display order (includes `page`). */
  const siblingsOf = (page: Page): Page[] =>
    tree()
      .pages.filter((p) => p.sectionId === page.sectionId && p.parentId === page.parentId)
      .sort((a, b) => a.orderIndex - b.orderIndex);

  /** Latest activity of a unit: the unit itself or any of its pages. */
  const unitActivity = (u: Unit): string => {
    const { sections, pages } = tree();
    const sectionIds = new Set(sections.filter((s) => s.unitId === u.id).map((s) => s.id));
    let latest = u.updatedAt;
    for (const p of pages) {
      if (sectionIds.has(p.sectionId) && p.updatedAt > latest) latest = p.updatedAt;
    }
    return latest;
  };

  return {
    tree: emptyTree(),
    loaded: false,
    trashItems: [],

    load: async () => {
      set({ tree: await ipc.getNotebookTree(), loaded: true });
    },
    loadTrash: async () => {
      set({ trashItems: await ipc.listTrash() });
    },

    createBookshelf: async (title, parentId) => {
      const stamp = now();
      const shelf: Bookshelf = {
        id: crypto.randomUUID(),
        title,
        order: tree().bookshelves.length,
        isExpanded: true,
        createdAt: stamp,
        updatedAt: stamp,
        version: 0,
        parentId,
      };
      await saveShelf(shelf);
      return shelf;
    },

    moveBookshelf: async (id, parentId) => {
      try {
        await ipc.moveBookshelf(id, parentId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(message === FOLDER_CYCLE ? i18n.t("library.folderCycle") : message);
      }
      const b = tree().bookshelves.find((x) => x.id === id);
      if (b) {
        setTree({
          bookshelves: upsertById(tree().bookshelves, { ...b, parentId: parentId ?? undefined, updatedAt: now() }),
        });
      }
    },

    createUnit: async (title, bookshelfId) => {
      const stamp = now();
      const unit: Unit = {
        id: crypto.randomUUID(),
        title,
        isFavourite: false,
        bookshelfId,
        isExpanded: true,
        orderIndex: tree().units.length,
        createdAt: stamp,
        updatedAt: stamp,
        version: 0,
      };
      await saveUnit(unit);
      const section = await get().createSection(unit.id, i18n.t("common.firstSection"));
      await get().createPage(section.id, i18n.t("common.pageName", { n: 1 }));
      return unit;
    },

    createSection: async (unitId, title) => {
      const stamp = now();
      const section: Section = {
        id: crypto.randomUUID(),
        unitId,
        title,
        color: "#4a5d4e",
        orderIndex: tree().sections.filter((s) => s.unitId === unitId).length,
        isExpanded: true,
        createdAt: stamp,
        updatedAt: stamp,
        version: 0,
      };
      await saveSection(section);
      return section;
    },

    createPage: async (sectionId, title, parentId, overrides) => {
      const { settings } = useSettingsStore.getState();
      const stamp = now();
      const siblings = tree().pages.filter(
        (p) => p.sectionId === sectionId && p.parentId === parentId,
      );
      const parent = parentId ? tree().pages.find((p) => p.id === parentId) : undefined;
      const page: Page = {
        id: crypto.randomUUID(),
        sectionId,
        parentId,
        title,
        isExpanded: true,
        isFavourite: false,
        depth: parent ? parent.depth + 1 : 0,
        mode: settings.defaultPageMode,
        backgroundConfig: { type: settings.defaultBackground, spacing: 40, dotRadius: 1.5 },
        thumbnailVersion: 0,
        orderIndex: siblings.length,
        createdAt: stamp,
        updatedAt: stamp,
        version: 0,
        ...overrides,
      };
      // Paper pages get their sheet from the default aspect/orientation at creation, so changing
      // the defaults later never reshapes existing pages.
      if (page.mode === "page" && page.pageWidth === undefined && page.pageHeight === undefined) {
        const size = sheetSizeFor(settings.defaultPageAspectRatio, settings.defaultPageOrientation);
        page.pageWidth = size.width;
        page.pageHeight = size.height;
      }
      await savePage(page);
      return page;
    },

    rename: (kind, id, title) => patch(kind, id, { title }),
    setColor: (kind, id, color) => patch(kind, id, { color }),
    toggleFavourite: (kind, id) => patch(kind, id, { toggleFavourite: true }),

    setThumbnailVersion: (pageId, version) => {
      const page = tree().pages.find((p) => p.id === pageId);
      if (!page || page.thumbnailVersion >= version) return; // never regress (out-of-order saves)
      setTree({ pages: upsertById(tree().pages, { ...page, thumbnailVersion: version }) });
    },

    updatePage: (page) => savePage({ ...page, updatedAt: now() }),

    movePage: async (id, dir) => {
      const page = tree().pages.find((p) => p.id === id);
      if (!page) return;
      const ids = siblingsOf(page).map((p) => p.id);
      const i = ids.indexOf(id);
      const j = i + dir;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await get().reorder("page", page.parentId ?? null, ids);
    },

    indentPage: async (id, dir) => {
      const page = tree().pages.find((p) => p.id === id);
      if (!page) return;
      const sibs = siblingsOf(page);
      let parentId: string | undefined;
      let depth: number;
      let before: Page[]; // new siblings, in order, with the page inserted below
      if (dir === 1) {
        const prev = sibs[sibs.findIndex((p) => p.id === id) - 1];
        if (!prev) return;
        parentId = prev.id;
        depth = prev.depth + 1;
        before = siblingsOf({ ...page, parentId });
      } else {
        const parent = tree().pages.find((p) => p.id === page.parentId);
        if (!parent) return;
        parentId = parent.parentId;
        depth = parent.depth;
        before = siblingsOf({ ...page, parentId });
        before.splice(before.findIndex((p) => p.id === parent.id) + 1, 0, page);
      }
      const delta = depth - page.depth;
      const moved = new Map<string, Page>([[id, { ...page, parentId, depth, updatedAt: now() }]]);
      // Descendants keep their parents but shift depth with the page.
      for (let grew = true; grew; ) {
        grew = false;
        for (const p of tree().pages) {
          if (!moved.has(p.id) && p.parentId && moved.has(p.parentId)) {
            moved.set(p.id, { ...p, depth: p.depth + delta, updatedAt: now() });
            grew = true;
          }
        }
      }
      const order = dir === 1 ? [...before.filter((p) => p.id !== id), page] : before;
      order.forEach((p, index) => {
        const m = moved.get(p.id) ?? p;
        if (m.orderIndex !== index || moved.has(p.id)) moved.set(p.id, { ...m, orderIndex: index });
      });
      for (const p of moved.values()) await savePage(p);
    },

    duplicatePage: async (id) => {
      // Strokes drawn just before duplicating may still sit in the write-behind queue.
      await elementsQueue.flushAll();
      const src = tree().pages.find((p) => p.id === id);
      if (!src) return null;
      const stamp = now();
      const copy: Page = {
        ...src,
        id: crypto.randomUUID(),
        title: `${src.title} copy`,
        thumbnailVersion: 0,
        orderIndex: src.orderIndex + 1,
        createdAt: stamp,
        updatedAt: stamp,
        version: 0,
      };
      const later = siblingsOf(src).filter((p) => p.orderIndex > src.orderIndex);
      for (const p of later) await savePage({ ...p, orderIndex: p.orderIndex + 1 });
      await savePage(copy);
      const els = await loadElements(src.id);
      if (els.length > 0) {
        await upsertElements(
          els.map((e) => ({ ...e, id: crypto.randomUUID(), pageId: copy.id, createdAt: stamp, updatedAt: stamp, version: 0 })),
        );
      }
      return copy;
    },

    moveUnitToBookshelf: async (unitId, bookshelfId) => {
      const u = tree().units.find((x) => x.id === unitId);
      if (!u) return;
      await saveUnit({ ...u, bookshelfId: bookshelfId ?? undefined, updatedAt: now() });
    },

    reorder: async (kind, _parentId, orderedIds) => {
      const t = tree();
      for (const [index, id] of orderedIds.entries()) {
        if (kind === "unit") {
          const e = t.units.find((x) => x.id === id);
          if (e && e.orderIndex !== index) await saveUnit({ ...e, orderIndex: index });
        } else if (kind === "section") {
          const e = t.sections.find((x) => x.id === id);
          if (e && e.orderIndex !== index) await saveSection({ ...e, orderIndex: index });
        } else if (kind === "page") {
          const e = t.pages.find((x) => x.id === id);
          if (e && e.orderIndex !== index) await savePage({ ...e, orderIndex: index });
        } else {
          const e = t.bookshelves.find((x) => x.id === id);
          if (e && e.order !== index) await saveShelf({ ...e, order: index });
        }
      }
    },

    trash: async (kind, id) => {
      await ipc.softDeleteEntity(kind, id);
      await get().load();
      await get().loadTrash();
    },
    restore: async (kind, id) => {
      await ipc.restoreEntity(kind, id);
      await get().load();
      await get().loadTrash();
    },
    purge: async (kind, id) => {
      await ipc.purgeEntity(kind, id);
      await get().loadTrash();
      await collectAssets();
    },
    emptyTrash: async () => {
      for (const item of get().trashItems) await ipc.purgeEntity(item.kind, item.id);
      await get().loadTrash();
      await collectAssets();
    },

    unitsByRecent: () =>
      [...tree().units].sort((a, b) => byDateDesc(unitActivity(a), unitActivity(b))),
    unitsAZ: () =>
      [...tree().units].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
      ),
    childFolders: (parentId) => {
      const { bookshelves } = tree();
      const known = new Set(bookshelves.map((b) => b.id));
      return bookshelves
        .filter((b) =>
          parentId === null ? !b.parentId || !known.has(b.parentId) : b.parentId === parentId,
        )
        .sort((a, b) => a.order - b.order);
    },
    folderPath: (id) => {
      const byId = new Map(tree().bookshelves.map((b) => [b.id, b]));
      const path: Bookshelf[] = [];
      const seen = new Set<string>();
      // `seen` guards against a cycle in stale or corrupt data; the backend refuses new ones.
      for (let b = id ? byId.get(id) : undefined; b && !seen.has(b.id); b = b.parentId ? byId.get(b.parentId) : undefined) {
        seen.add(b.id);
        path.unshift(b);
      }
      return path;
    },
    folderSubtree: (id) => {
      const out = new Set([id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const b of tree().bookshelves) {
          if (b.parentId && out.has(b.parentId) && !out.has(b.id)) {
            out.add(b.id);
            grew = true;
          }
        }
      }
      return out;
    },
    unitsInFolder: (id) => {
      const { bookshelves, units } = tree();
      const known = new Set(bookshelves.map((b) => b.id));
      return units
        .filter((u) =>
          id === null ? !u.bookshelfId || !known.has(u.bookshelfId) : u.bookshelfId === id,
        )
        .sort((a, b) => a.orderIndex - b.orderIndex);
    },
    recentPages: (n) =>
      [...tree().pages].sort((a, b) => byDateDesc(a.updatedAt, b.updatedAt)).slice(0, n),
    favouritePages: () => tree().pages.filter((p) => p.isFavourite),
  };
});
