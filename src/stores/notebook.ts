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
import * as ipc from "../ipc/notebook";
import { useSettingsStore } from "./settings";

export interface ShelfGroup {
  shelf: Bookshelf | null;
  units: Unit[];
}

interface NotebookState {
  tree: NotebookTree;
  loaded: boolean;
  trashItems: TrashItem[];
  load: () => Promise<void>;
  loadTrash: () => Promise<void>;
  createUnit: (title: string, bookshelfId?: string) => Promise<Unit>;
  createSection: (unitId: string, title: string) => Promise<Section>;
  createPage: (sectionId: string, title: string, parentId?: string) => Promise<Page>;
  rename: (kind: EntityKind, id: string, title: string) => Promise<void>;
  setColor: (kind: EntityKind, id: string, color: string) => Promise<void>;
  toggleFavourite: (kind: EntityKind, id: string) => Promise<void>;
  moveUnitToBookshelf: (unitId: string, bookshelfId: string | null) => Promise<void>;
  reorder: (kind: EntityKind, parentId: string | null, orderedIds: string[]) => Promise<void>;
  trash: (kind: EntityKind, id: string) => Promise<void>;
  restore: (kind: EntityKind, id: string) => Promise<void>;
  purge: (kind: EntityKind, id: string) => Promise<void>;
  unitsByRecent: () => Unit[];
  unitsAZ: () => Unit[];
  unitsByShelf: () => ShelfGroup[];
  recentPages: (n: number) => Page[];
  favouritePages: () => Page[];
}

interface Changes {
  title?: string;
  color?: string;
  toggleFavourite?: boolean;
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
      const section = await get().createSection(unit.id, "Notes");
      await get().createPage(section.id, "Page 1");
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

    createPage: async (sectionId, title, parentId) => {
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
      };
      await savePage(page);
      return page;
    },

    rename: (kind, id, title) => patch(kind, id, { title }),
    setColor: (kind, id, color) => patch(kind, id, { color }),
    toggleFavourite: (kind, id) => patch(kind, id, { toggleFavourite: true }),

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
    },

    unitsByRecent: () =>
      [...tree().units].sort((a, b) => byDateDesc(unitActivity(a), unitActivity(b))),
    unitsAZ: () =>
      [...tree().units].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
      ),
    unitsByShelf: () => {
      const { bookshelves, units } = tree();
      const groups: ShelfGroup[] = [...bookshelves]
        .sort((a, b) => a.order - b.order)
        .map((shelf) => ({
          shelf,
          units: units
            .filter((u) => u.bookshelfId === shelf.id)
            .sort((a, b) => a.orderIndex - b.orderIndex),
        }));
      const known = new Set(bookshelves.map((b) => b.id));
      const loose = units
        .filter((u) => !u.bookshelfId || !known.has(u.bookshelfId))
        .sort((a, b) => a.orderIndex - b.orderIndex);
      if (loose.length > 0) groups.push({ shelf: null, units: loose });
      return groups;
    },
    recentPages: (n) =>
      [...tree().pages].sort((a, b) => byDateDesc(a.updatedAt, b.updatedAt)).slice(0, n),
    favouritePages: () => tree().pages.filter((p) => p.isFavourite),
  };
});
