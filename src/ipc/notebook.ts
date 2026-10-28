import { invoke } from "@tauri-apps/api/core";
import type {
  Bookshelf,
  EntityKind,
  NotebookTree,
  Page,
  Section,
  TrashItem,
  Unit,
} from "../model/types";

export const getNotebookTree = (): Promise<NotebookTree> =>
  invoke("get_notebook_tree");

export const upsertBookshelf = (b: Bookshelf): Promise<void> =>
  invoke("upsert_bookshelf", { b });

/** Moves a folder; `parentId` null is the Library root. Rejects a move into itself or a subfolder. */
export const moveBookshelf = (id: string, parentId: string | null): Promise<void> =>
  invoke("move_bookshelf", { id, parentId });

export const upsertUnit = (u: Unit): Promise<void> =>
  invoke("upsert_unit", { u });

export const upsertSection = (s: Section): Promise<void> =>
  invoke("upsert_section", { s });

export const upsertPage = (p: Page): Promise<void> =>
  invoke("upsert_page", { p });

export const softDeleteEntity = (kind: EntityKind, id: string): Promise<void> =>
  invoke("soft_delete_entity", { kind, id });

export const restoreEntity = (kind: EntityKind, id: string): Promise<void> =>
  invoke("restore_entity", { kind, id });

export const listTrash = (): Promise<TrashItem[]> => invoke("list_trash");

export const purgeEntity = (kind: EntityKind, id: string): Promise<void> =>
  invoke("purge_entity", { kind, id });

export const purgeTrashOlderThan = (days: number): Promise<number> =>
  invoke("purge_trash_older_than", { days });
