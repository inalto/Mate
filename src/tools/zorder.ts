// Z-order (pure): render order is content.zIndex ascending, then createdAt, then id.
import type { Element } from "../model/types";
import { contentMeta, withMeta } from "./spatialIndex";

export type ZOp = "forward" | "backward" | "front" | "back";

export const zOf = (el: Element): number => contentMeta(el).zIndex ?? 0;

export function compareZ(a: Element, b: Element): number {
  return zOf(a) - zOf(b) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function renderOrder(els: Iterable<Element>): Element[] {
  return [...els].sort(compareZ);
}

/** Highest zIndex in use (0 when none). */
export function topZ(els: Iterable<Element>): number {
  let m = 0;
  for (const el of els) m = Math.max(m, zOf(el));
  return m;
}

/** Apply `op` to the selected ids; returns only the elements whose zIndex changes. */
export function reorder(all: Iterable<Element>, ids: ReadonlySet<string>, op: ZOp): Element[] {
  const order = renderOrder(all);
  const selected = order.filter((e) => ids.has(e.id));
  if (selected.length === 0) return [];
  if (op === "front" || op === "back") {
    const base = op === "front" ? zOf(order[order.length - 1]) + 1 : zOf(order[0]) - selected.length;
    return selected.map((el, k) => withMeta(el, { zIndex: base + k })).filter((el, k) => el !== selected[k]);
  }
  // One step: swap each selected element with its non-selected neighbour, then renumber.
  if (op === "forward") {
    for (let i = order.length - 2; i >= 0; i--) {
      if (ids.has(order[i].id) && !ids.has(order[i + 1].id)) [order[i], order[i + 1]] = [order[i + 1], order[i]];
    }
  } else {
    for (let i = 1; i < order.length; i++) {
      if (ids.has(order[i].id) && !ids.has(order[i - 1].id)) [order[i], order[i - 1]] = [order[i - 1], order[i]];
    }
  }
  const changed: Element[] = [];
  order.forEach((el, i) => {
    if (zOf(el) === i) return;
    const next = withMeta(el, { zIndex: i });
    if (next !== el) changed.push(next);
  });
  return changed;
}
