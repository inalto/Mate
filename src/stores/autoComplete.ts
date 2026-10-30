// Auto-complete popover state: which element (in which pane's editor store) and side it adds from,
// where it opens (`at`: a drop point in page units, or null for next to the side's handle), and the
// free-ended connector drawn from the handle that the chosen element binds (`connectorId`). Closes on
// a choice, Escape (a drawn connector stays free-ended) or a pointer-down outside it.
import { create } from "zustand";
import type { Vec2 } from "../canvas/camera";
import type { Side } from "../model/content";
import type { EditorStore } from "./editor";

export interface AutoCompleteTarget {
  editor: EditorStore;
  sourceId: string;
  side: Side;
  at: Vec2 | null;
  connectorId?: string;
}

interface AutoCompleteState {
  target: AutoCompleteTarget | null;
}

export const useAutoCompleteStore = create<AutoCompleteState>(() => ({ target: null }));

/** Open the popover for adding from `side` of `sourceId` in `editor`. */
export function openAutoComplete(editor: EditorStore, sourceId: string, side: Side, at: Vec2 | null = null, connectorId?: string): void {
  useAutoCompleteStore.setState({ target: { editor, sourceId, side, at, ...(connectorId ? { connectorId } : {}) } });
}

export function closeAutoComplete(): void {
  if (useAutoCompleteStore.getState().target) useAutoCompleteStore.setState({ target: null });
}
