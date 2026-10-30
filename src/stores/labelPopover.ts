// Label popover state: which connector (in which pane's editor store) has its label being edited.
// The popover anchors itself at the label pill (or the route's midpoint) in pane screen space, so it
// follows pan and zoom. Closes on Enter (commit), Escape, or a pointer-down outside it.
import { create } from "zustand";
import type { EditorStore } from "./editor";

export interface LabelPopoverTarget {
  editor: EditorStore;
  id: string;
}

interface LabelPopoverState {
  target: LabelPopoverTarget | null;
}

export const useLabelPopoverStore = create<LabelPopoverState>(() => ({ target: null }));

/** Open the label popover for connector `id` of `editor`. */
export function openLabelPopover(editor: EditorStore, id: string): void {
  useLabelPopoverStore.setState({ target: { editor, id } });
}

export function closeLabelPopover(): void {
  if (useLabelPopoverStore.getState().target) useLabelPopoverStore.setState({ target: null });
}
