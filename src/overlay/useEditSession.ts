// Edit-session plumbing shared by the table and code editors (the text-box editor has its own,
// richer one): the commit runs once when the session ends (store.endEdit / selection change via
// bindEditSession, an unmount, or a pointer press outside the box), and persists through
// `store.updateElements` as a single history entry; nothing is recorded when nothing changed.
import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";

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
      if (store.getState().editingId === id) store.getState().endEdit();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [id, rootRef, store]);
}
