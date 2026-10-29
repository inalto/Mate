// DOM editors for boxed element types, mounted by OverlayLayer into the `data-editor-for` slot of
// the element being edited. Types without a registered editor get no slot.
import { createElement, lazy, Suspense, type ComponentType } from "react";
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

const editors = new Map<string, BoxEditor>();

const keyOf = (type: ElementType, subtype?: string): string => (subtype ? `${type}:${subtype}` : type);

/**
 * Register the editor for `type` (replacing any previous one); returns an unregister function.
 * With `subtype` (the element's `content.subtype`, e.g. "math" on a text-box) the editor serves only
 * those elements and takes precedence over the type's own.
 */
export function registerEditor(type: ElementType, editor: BoxEditor, opts: { subtype?: string } = {}): () => void {
  const key = keyOf(type, opts.subtype);
  editors.set(key, editor);
  return () => {
    if (editors.get(key) === editor) editors.delete(key);
  };
}

/**
 * An editor whose module is loaded on first use (or `preload`), so its dependencies (Tiptap,
 * CodeMirror, MathLive, the graph UI) stay out of the main chunk. Renders nothing until loaded. The
 * returned component keeps its identity once loaded, so a mounted edit session is never remounted.
 */
export function lazyEditor(load: () => Promise<{ default: BoxEditor }>): BoxEditor & { preload(): Promise<unknown> } {
  let loading: Promise<{ default: BoxEditor }> | null = null;
  const once = () => {
    loading ??= load().catch((err: unknown) => {
      loading = null; // retry on the next use
      throw err;
    });
    return loading;
  };
  const Inner = lazy(once);
  const Lazy = (props: BoxEditorProps) => createElement(Suspense, { fallback: null }, createElement(Inner, props));
  return Object.assign(Lazy, { preload: () => once().catch((err: unknown) => console.error("loading a box editor failed", err)) });
}

/** The editor of `type`, or of its `subtype` when one is registered; else the empty editor. */
export const editorFor = (type: ElementType, subtype?: string): BoxEditor =>
  (subtype ? editors.get(keyOf(type, subtype)) : undefined) ?? editors.get(type) ?? NoEditor;

/** True when `type` has a real editor (the canvas then leaves the edited element to the DOM). */
export const hasEditor = (type: ElementType): boolean => editors.has(type);
