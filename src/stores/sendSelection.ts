// "Send to another page": the selection is copied (fresh ids) onto another page of any notebook,
// on a row of its own under what that page already holds (so each thing sent lands below the last),
// and with `move` removed from this page as one undoable step.
import { remapConnectorEnds } from "../connectors";
import { sheetSize } from "../canvas/camera";
import { rowBelowDelta } from "../canvas/pageBounds";
import { loadElements, upsertElements } from "../ipc/elements";
import { elementsQueue } from "../ipc/elementsQueue";
import { isLocked, isPdfPlacement } from "../model/content";
import type { Element, NotebookTree, Page } from "../model/types";
import { translateElements } from "../tools/lasso";
import { bottomOf, keepInStack, unionBounds, type EditorStore } from "./editor";
import { useNotebookStore } from "./notebook";
import { useSettingsStore } from "./settings";
import { editorForPane } from "./focusedEditor";

/** A page that can receive a selection, with where it lives ("Book › Section"). */
export interface SendTarget {
  page: Page;
  path: string;
}

/** Every live page except `currentId`, in notebook order (book, section, page). */
export function sendTargets(tree: NotebookTree, currentId: string | null): SendTarget[] {
  const gone = (x: object) => !!(x as { deletedAt?: string }).deletedAt;
  const units = new Map(tree.units.filter((u) => !gone(u)).map((u) => [u.id, u]));
  const sections = new Map(tree.sections.filter((s) => !gone(s) && units.has(s.unitId)).map((s) => [s.id, s]));
  return tree.pages
    .filter((p) => !p.deletedAt && p.id !== currentId && sections.has(p.sectionId))
    .map((page) => {
      const section = sections.get(page.sectionId)!;
      const unit = units.get(section.unitId)!;
      return { page, path: `${unit.title} \u203a ${section.title}`, key: [unit.orderIndex, unit.id, section.orderIndex, section.id, page.orderIndex] as const };
    })
    .sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) {
        if (a.key[i] === b.key[i]) continue;
        return a.key[i] < b.key[i] ? -1 : 1;
      }
      return 0;
    })
    .map(({ page, path }) => ({ page, path }));
}

/** The copies of `src` for page `pageId`: fresh ids, connectors re-bound among the copies, unlocked. */
export function copiesForPage(src: readonly Element[], pageId: string, now: string): Element[] {
  const ids = new Map(src.map((e) => [e.id, crypto.randomUUID()]));
  return src.map((e) => remapConnectorEnds({ ...e, id: ids.get(e.id)!, pageId, createdAt: now, updatedAt: now, version: 0 }, ids));
}

/**
 * `copies` moved, as a block, onto a row of their own under `existing` (the target page's elements),
 * horizontal position kept; on a paper page they also stay within the sheet width.
 */
export function placeBelow(copies: Element[], existing: readonly Element[], page: Page | undefined, defaultAspect = "a4"): Element[] {
  const b = unionBounds(copies);
  if (!b) return copies;
  const contentBottom = bottomOf(existing.filter((e) => !e.deletedAt));
  const paper = page?.mode === "page" ? page : null;
  const dy = rowBelowDelta(b, contentBottom, paper ? sheetSize(paper, defaultAspect) : undefined);
  const moved = translateElements(copies, 0, dy);
  return paper ? keepInStack(moved, { page: paper, contentBottom }) : moved;
}

/**
 * Send the selection of `store` to page `targetId`; with `move` it leaves this page (locked
 * elements stay). PDF page placements never travel. Returns how many elements were sent.
 */
export async function sendSelectionToPage(store: EditorStore, targetId: string, move: boolean): Promise<number> {
  const s = store.getState();
  if (!s.pageId || targetId === s.pageId) return 0;
  const src = [...s.selection]
    .map((id) => s.elements.get(id))
    .filter((e): e is Element => !!e && !isPdfPlacement(e) && !(move && isLocked(e)));
  if (src.length === 0) return 0;
  // Edits still in the write-behind queue reach the database before the copies do.
  await elementsQueue.flushAll();
  const page = useNotebookStore.getState().tree.pages.find((p) => p.id === targetId);
  const copies = placeBelow(
    copiesForPage(src, targetId, new Date().toISOString()),
    await loadElements(targetId),
    page,
    useSettingsStore.getState().settings.defaultPageAspectRatio,
  );
  await upsertElements(copies);
  // A pane that shows the target page picks the new elements up.
  for (const i of [0, 1] as const) {
    const other = editorForPane(i);
    if (other !== store && other.getState().pageId === targetId) void other.getState().loadPage(targetId);
  }
  if (move) store.getState().removeElements(src.map((e) => e.id), "Send to page");
  return copies.length;
}
