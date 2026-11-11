// Edit-session plumbing shared by the table and code editors (the text-box editor has its own,
// richer one): the commit runs once when the session ends (store.endEdit / selection change via
// bindEditSession, an unmount, or a pointer press outside the box), and persists through
// `store.updateElements` as a single history entry; nothing is recorded when nothing changed.
import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { editorForPane } from "../stores/focusedEditor";

/**
 * End the edit session of every pane. Each editor's commit runs synchronously inside `endEdit`
 * (the store's closeEdit), so the edited element is already in elementsQueue when this returns:
 * call it before flushing the queue (window close) or reading the elements (export).
 */
export function endAllEdits(): void {
  for (const i of [0, 1] as const) {
    try {
      editorForPane(i).getState().endEdit();
    } catch (err) {
      console.error("ending the edit session failed", err);
    }
  }
}

/**
 * A pointer press outside the editor of element `id` (the caller checked that): the edit session
 * ends. A press on the page itself also deselects the element, so no frame or handles stay behind
 * (a finger that only pans, or a pen with an ink tool, never reaches the select tool that would
 * clear it); a press on other chrome (toolbar, selection bar, the frame) keeps it selected.
 */
export function endEditOnOutsidePress(store: EditorStore, id: string, target: EventTarget | null): void {
  if (store.getState().editingId !== id) return;
  store.getState().endEdit();
  if (!(target instanceof globalThis.Element) || !target.closest(".canvas-view")) return;
  const s = store.getState();
  if (s.selection.size === 1 && s.selection.has(id)) s.select([]);
}

/**
 * `change(cur)` returns the edited element, or `cur`/null when nothing changed. `rootRef` is the
 * editor's DOM root (presses inside its `.box-editor` slot keep editing).
 */
export function useEditSession(id: string, store: EditorStore, rootRef: RefObject<HTMLElement | null>, change: (cur: Element) => Element | null): void {
  const changeRef = useRef(change);
  useEffect(() => {
    changeRef.current = change;
  });

  const done = useRef(false);
  const commit = useCallback(() => {
    if (done.current) return;
    done.current = true;
    const s = store.getState();
    const cur = s.elements.get(id);
    if (!cur) return;
    const next = changeRef.current(cur);
    if (next && next !== cur) s.updateElements([{ ...next, updatedAt: new Date().toISOString() }]);
  }, [id, store]);

  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    const unbind = store.getState().bindEditSession(commit);
    return () => {
      alive.current = false;
      unbind();
      queueMicrotask(() => {
        if (!alive.current) commit();
      });
    };
  }, [commit, store]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const slot = rootRef.current?.closest(".box-editor") ?? rootRef.current;
      if (slot && e.target instanceof Node && slot.contains(e.target)) return;
      endEditOnOutsidePress(store, id, e.target);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [id, rootRef, store]);
}
