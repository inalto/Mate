// Mind-map hit tests (spec D4): a node box or an edge selects the mind map; `hitMindNode` names the
// node under a point for the overlay. Both read the memoised layout (./cache).
import type { Vec2 } from "../canvas/camera";
import type { Element } from "../model/types";
import { polylineTouches } from "../tools/eraser";
import { mindmapView } from "./cache";

/** Id of the node whose box contains `p` (grown by `tol`), or null. Later nodes win ties. */
export function hitMindNode(el: Element, p: Vec2, tol = 0): string | null {
  if (el.type !== "mindmap") return null;
  let hit: string | null = null;
  for (const b of mindmapView(el).layout.nodes.values()) {
    if (p.x >= b.x - tol && p.x <= b.x + b.width + tol && p.y >= b.y - tol && p.y <= b.y + b.height + tol) hit = b.id;
  }
  return hit;
}

/** True when `p` is on a node box or within `tol` of an edge of mind map `el` (empty space misses). */
export function mindmapHit(el: Element, p: Vec2, tol: number): boolean {
  if (hitMindNode(el, p, tol) !== null) return true;
  return mindmapView(el).layout.edges.some((e) => polylineTouches(e.path, p, tol));
}
