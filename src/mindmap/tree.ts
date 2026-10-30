// Mind-map tree (pure): immutable operations on a `MindNode` tree. Every operation returns a new
// tree that shares untouched subtrees with the input; an operation that does not apply (unknown
// id, refused move) returns the input tree itself.

export interface MindNode {
  id: string;
  text: string;
  children: MindNode[];
  collapsed?: boolean;
  /** Branch colour override (`#rrggbb`, light-paper variant). */
  color?: string;
}

/** A fresh node id (`crypto.randomUUID`, Math.random fallback where it is missing). */
export function newNodeId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newNode(text: string): MindNode {
  return { id: newNodeId(), text, children: [] };
}

/** Pre-order visit of every node (collapsed subtrees included). */
export function walk(
  root: MindNode,
  visit: (node: MindNode, depth: number, parent: MindNode | null) => void,
): void {
  const go = (node: MindNode, depth: number, parent: MindNode | null) => {
    visit(node, depth, parent);
    for (const child of node.children) go(child, depth + 1, node);
  };
  go(root, 0, null);
}

export function findNode(root: MindNode, id: string): MindNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

export function parentOf(root: MindNode, id: string): MindNode | null {
  for (const child of root.children) {
    if (child.id === id) return root;
    const hit = parentOf(child, id);
    if (hit) return hit;
  }
  return null;
}

/** `root` with the node `id` replaced by `fn(node)`; the same tree when `id` is absent. */
function mapNode(root: MindNode, id: string, fn: (node: MindNode) => MindNode): MindNode {
  if (root.id === id) return fn(root);
  let changed = false;
  const children = root.children.map((child) => {
    const next = mapNode(child, id, fn);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

/** Insert `node` under `parentId` at `index` (default: last; clamped). */
export function addChild(root: MindNode, parentId: string, node: MindNode, index?: number): MindNode {
  return mapNode(root, parentId, (parent) => {
    const children = parent.children.slice();
    const at = index === undefined ? children.length : Math.max(0, Math.min(children.length, index));
    children.splice(at, 0, node);
    return { ...parent, children };
  });
}

/** Insert `node` next to `id` (after it, or before with `before`). The root has no siblings. */
export function addSibling(root: MindNode, id: string, node: MindNode, before = false): MindNode {
  const parent = parentOf(root, id);
  if (!parent) return root;
  const at = parent.children.findIndex((c) => c.id === id);
  return addChild(root, parent.id, node, before ? at : at + 1);
}

/** Remove `id` and its subtree. The root is never removed. */
export function removeNode(root: MindNode, id: string): MindNode {
  const parent = parentOf(root, id);
  if (!parent) return root;
  return mapNode(root, parent.id, (p) => ({ ...p, children: p.children.filter((c) => c.id !== id) }));
}

/**
 * Move `id` (with its subtree) to the end of `newParentId`'s children. Refused (same tree) for the
 * root, unknown ids, and a target inside the moved subtree (the node itself or a descendant).
 */
export function moveNode(root: MindNode, id: string, newParentId: string): MindNode {
  const node = findNode(root, id);
  if (!node || node === root) return root;
  if (findNode(node, newParentId)) return root;
  if (!findNode(root, newParentId)) return root;
  return addChild(removeNode(root, id), newParentId, node);
}

export function setText(root: MindNode, id: string, text: string): MindNode {
  return mapNode(root, id, (node) => (node.text === text ? node : { ...node, text }));
}

export function toggleCollapsed(root: MindNode, id: string): MindNode {
  return mapNode(root, id, (node) => {
    const next = { ...node };
    if (node.collapsed) delete next.collapsed;
    else next.collapsed = true;
    return next;
  });
}
