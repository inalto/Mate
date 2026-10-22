// DOM editors for boxed element types, mounted by OverlayLayer into the `data-editor-for` slot of
// the element being edited. Types without a registered editor get an empty slot.
import type { ComponentType } from "react";
import type { Element, ElementType } from "../model/types";
import type { EditorStore } from "../stores/editor";

export interface BoxEditorProps {
  el: Element;
  /** The pane's editor store (persist through its actions, which go through src/ipc). */
  store: EditorStore;
}

export type BoxEditor = ComponentType<BoxEditorProps>;

/** Default editor: renders nothing. */
export const NoEditor: BoxEditor = () => null;

const editors = new Map<ElementType, BoxEditor>();

/** Register the editor for `type` (replacing any previous one); returns an unregister function. */
export function registerEditor(type: ElementType, editor: BoxEditor): () => void {
  editors.set(type, editor);
  return () => {
    if (editors.get(type) === editor) editors.delete(type);
  };
}

export const editorFor = (type: ElementType): BoxEditor => editors.get(type) ?? NoEditor;

/** True when `type` has a real editor (the canvas then leaves the edited element to the DOM). */
export const hasEditor = (type: ElementType): boolean => editors.has(type);
