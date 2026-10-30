// Mind-map editing session (spec D5): which node of which pane's mind map has its text editor open
// (`useMindEdit`, read by OverlayLayer to mount MindNodeEditor), and the tree edits shared by the
// overlay buttons, the toolbar and the mind-map keys (add a child or a sibling and start editing it).
import { create } from "zustand";
import { isLocked, mindmapOf } from "../model/content";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { mindmapView } from "./cache";
import type { MindmapStyle } from "./styles";
import { addChild, addSibling, findNode, newNode, parentOf, toggleCollapsed, type MindNode } from "./tree";

interface MindEditState {
  store: EditorStore | null;
  elementId: string;
  nodeId: string;
  /** Text the session starts with instead of the stored one (the key that started it), or null. */
  initial: string | null;
  /** Number of the editing session (a fresh one per `beginMindNodeEdit`), part of its merge key. */
  session: number;
}

export const useMindEdit = create<MindEditState>(() => ({ store: null, elementId: "", nodeId: "", initial: null, session: 0 }));

/** Merge key of one editing session's typing (one history entry per session, never shared by two). */
export const mindTextKey = (elementId: string, nodeId: string, session: number): string => `mindmap:${elementId}:${nodeId}:${session}`;

/** The mind map `id` of `store` when it can be edited (exists, unlocked, not presenting). */
function editableMap(store: EditorStore, id: string): Element | null {
  const s = store.getState();
  const el = s.elements.get(id);
  return el && el.type === "mindmap" && !isLocked(el) && !s.presenting ? el : null;
}

/**
 * Open the text editor on node `nodeId` of mind map `elementId` (and focus that node). With
 * `initial` the text is replaced by it (a printable key that started the editing). False when the
 * map cannot be edited or the node is missing.
 */
export function beginMindNodeEdit(store: EditorStore, elementId: string, nodeId: string, initial: string | null = null): boolean {
  const el = editableMap(store, elementId);
  const c = el ? mindmapOf(el) : null;
  if (!c || !findNode(c.root, nodeId)) return false;
  if (store.getState().editingId !== null) store.getState().endEdit();
  store.getState().focusMindNode(elementId, nodeId);
  useMindEdit.setState((m) => ({ store, elementId, nodeId, initial, session: m.session + 1 }));
  return true;
}

/** Close the node editor (of `store`, when given). */
export function endMindNodeEdit(store?: EditorStore): void {
  const cur = useMindEdit.getState();
  if (!cur.store || (store && cur.store !== store)) return;
  useMindEdit.setState({ store: null, elementId: "", nodeId: "", initial: null }); // `session` keeps counting
}

/** The store whose mind-map overlay holds a node press or drag (the mind-map keys leave Escape to it). */
let dragStore: EditorStore | null = null;

/** Mark (or, with null, clear) the node press or drag of `store`'s mind-map overlay. */
export function setMindDrag(store: EditorStore | null): void {
  dragStore = store;
}

/** True while `store`'s mind-map overlay holds a node press or drag. */
export const isMindDragging = (store: EditorStore): boolean => dragStore === store;

/** True while `store` has a node editor open. */
export const isMindNodeEditing = (store: EditorStore): boolean => useMindEdit.getState().store === store;

/**
 * Add an empty child under `nodeId` (expanding it when collapsed), focus it and start editing it.
 * The new node's id, or null when refused.
 */
export function addMindChild(store: EditorStore, elementId: string, nodeId: string): string | null {
  if (!editableMap(store, elementId)) return null;
  const node = newNode("");
  const ok = store.getState().editMindmap(
    elementId,
    (root) => {
      const parent = findNode(root, nodeId);
      if (!parent) return root;
      return addChild(parent.collapsed ? toggleCollapsed(root, nodeId) : root, nodeId, node);
    },
    "Add topic",
  );
  if (!ok) return null;
  beginMindNodeEdit(store, elementId, node.id);
  return node.id;
}

/**
 * Add an empty sibling after (or `before`) `nodeId`, focus it and start editing it. The root has
 * no siblings: there the new node is a child. The new node's id, or null when refused.
 */
export function addMindSibling(store: EditorStore, elementId: string, nodeId: string, before = false): string | null {
  const el = editableMap(store, elementId);
  const c = el ? mindmapOf(el) : null;
  if (!c) return null;
  if (c.root.id === nodeId) return addMindChild(store, elementId, nodeId);
  const node = newNode("");
  if (!store.getState().editMindmap(elementId, (root) => addSibling(root, nodeId, node, before), "Add topic")) return null;
  beginMindNodeEdit(store, elementId, node.id);
  return node.id;
}

/** Add a mind map at the view centre in `style` and open its root's editor; the new id, or null. */
export function addMindmapAndEdit(store: EditorStore, style: MindmapStyle = 1): string | null {
  const id = store.getState().addMindmap(undefined, style);
  const f = store.getState().mindmapFocus;
  if (id && f?.elementId === id) beginMindNodeEdit(store, id, f.nodeId);
  return id;
}

/** The node that takes the focus when `id` is removed: the previous sibling, else the next, else the parent. */
export function focusAfterRemove(root: MindNode, id: string): string | null {
  const parent = parentOf(root, id);
  if (!parent) return null;
  const i = parent.children.findIndex((c) => c.id === id);
  return parent.children[i - 1]?.id ?? parent.children[i + 1]?.id ?? parent.id;
}

export type MindDirection = "left" | "right" | "up" | "down";

/**
 * The node the focus moves to from `id` of mind map `el` with an arrow key, or null. Left/right
 * follow the layout side: outward goes to the child nearest in height (none when collapsed), inward
 * to the parent; from the root, each side's nearest first-level node. Up/down step through the
 * siblings on the same side, in height order.
 */
export function mindNeighbour(el: Element, id: string, dir: MindDirection): string | null {
  const c = mindmapOf(el);
  if (!c) return null;
  const { nodes } = mindmapView(el).layout;
  const box = nodes.get(id);
  const node = findNode(c.root, id);
  if (!box || !node) return null;
  const midY = (b: { y: number; height: number }) => b.y + b.height / 2;
  const nearest = (ids: string[]): string | null => {
    let best: string | null = null;
    let dist = Infinity;
    for (const k of ids) {
      const b = nodes.get(k);
      if (!b) continue;
      const d = Math.abs(midY(b) - midY(box));
      if (d < dist) {
        dist = d;
        best = k;
      }
    }
    return best;
  };
  const shown = (n: MindNode) => (n.collapsed ? [] : n.children.map((k) => k.id).filter((k) => nodes.has(k)));
  if (dir === "left" || dir === "right") {
    if (node === c.root) return nearest(shown(node).filter((k) => nodes.get(k)!.side === dir));
    if (dir === box.side) return nearest(shown(node));
    return parentOf(c.root, id)?.id ?? null;
  }
  const parent = parentOf(c.root, id);
  if (!parent) return null;
  const row = shown(parent)
    .filter((k) => nodes.get(k)!.side === box.side)
    .sort((a, b) => nodes.get(a)!.y - nodes.get(b)!.y);
  const at = row.indexOf(id);
  return row[at + (dir === "up" ? -1 : 1)] ?? null;
}
