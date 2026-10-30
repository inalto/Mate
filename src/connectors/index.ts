// Connectors: rerouting a connector from the elements its ends are bound to. `routeConnector` is the
// one place a connector's `points` (absolute endpoints) and cached `content.route` are derived.
import type { Vec2 } from "../canvas/camera";
import { contentOf, isAttachable, type ConnectorContent, type ConnectorEnd, type Side } from "../model/content";
import type { Element, Point } from "../model/types";
import { anchorPoint, attachBounds, resolveSide, SIDES } from "./anchors";
import { connectorMode, storedRoute } from "./geometry";
import { routePath } from "./route";

export { anchorPoint, anchors, nearestAnchor, resolveSide, SIDES } from "./anchors";
export { connectorBounds, connectorCaps, connectorHit, connectorLabel, connectorMode, connectorRoute, labelPill } from "./geometry";
export { nearestT, pointAt, routePath } from "./route";

export const isConnector = (el: Pick<Element, "type">): boolean => el.type === "connector";

const isEnd = (v: unknown): v is ConnectorEnd =>
  v !== null && typeof v === "object" && typeof (v as ConnectorEnd).id === "string";

/** The bound ends of a connector (source then target), ignoring malformed ones. */
export function connectorEnds(el: Pick<Element, "type" | "content">): { source?: ConnectorEnd; target?: ConnectorEnd } {
  if (el.type !== "connector") return {};
  const c = contentOf<ConnectorContent>(el);
  return { ...(isEnd(c.source) ? { source: c.source } : {}), ...(isEnd(c.target) ? { target: c.target } : {}) };
}

/** Ids of the elements a connector is bound to (deduplicated). */
export function boundIds(el: Pick<Element, "type" | "content">): string[] {
  const { source, target } = connectorEnds(el);
  const ids = [source?.id, target?.id].filter((x): x is string => !!x);
  return [...new Set(ids)];
}

const centreOf = (el: Element): Vec2 => {
  const b = attachBounds(el);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

const toPoint = (base: Point | undefined, v: Vec2, i: number): Point => ({ pressure: 0.5, timestamp: i, ...base, x: v.x, y: v.y });

const EPS = 1e-6;
const near = (a: Vec2, b: Vec2): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const sameRoute = (a: readonly Vec2[], b: readonly Vec2[]): boolean => a.length === b.length && a.every((p, i) => near(p, b[i]));

/**
 * `el` with fresh `points` and `content.route`: each bound end sits on its element's anchor (an
 * "auto" side faces the other end, re-evaluated every time), each free end keeps its point. An end
 * bound to a missing, non-attachable or self element is treated as free. Returns the same object
 * when nothing changed (and for non-connectors).
 */
export function routeConnector(el: Element, resolve: (id: string) => Element | undefined): Element {
  if (el.type !== "connector") return el;
  const c = contentOf<ConnectorContent>(el);
  const { source, target } = connectorEnds(el);
  const bound = (end: ConnectorEnd | undefined): Element | null => {
    if (!end || end.id === el.id) return null;
    const b = resolve(end.id);
    return b && isAttachable(b) && b.points.length > 0 ? b : null;
  };
  const src = bound(source);
  const tgt = bound(target);
  const p0 = el.points[0] ?? { x: 0, y: 0, pressure: 0.5, timestamp: 0 };
  const p1 = el.points[1] ?? p0;
  // A fixed side is known up front; an "auto" side aims at the other end's fixed anchor, else its centre.
  const fixed = (b: Element | null, end: ConnectorEnd | undefined): { side: Side; at: Vec2 } | null =>
    b && end && (SIDES as readonly string[]).includes(end.side) ? { side: end.side as Side, at: anchorPoint(b, end.side as Side) } : null;
  const fs = fixed(src, source);
  const ft = fixed(tgt, target);
  const aimFor = (b: Element | null, f: { at: Vec2 } | null, free: Vec2): Vec2 => f?.at ?? (b ? centreOf(b) : free);
  const sideOf = (b: Element | null, f: { side: Side } | null, towards: Vec2): Side | null => f?.side ?? (b ? resolveSide(b, towards) : null);
  const startSide = sideOf(src, fs, aimFor(tgt, ft, p1));
  const endSide = sideOf(tgt, ft, aimFor(src, fs, p0));
  const start = src && startSide ? anchorPoint(src, startSide) : { x: p0.x, y: p0.y };
  const end = tgt && endSide ? anchorPoint(tgt, endSide) : { x: p1.x, y: p1.y };
  const avoid = [src, tgt].filter((b): b is Element => !!b).map(attachBounds);
  const route = routePath(connectorMode(el), start, startSide, end, endSide, avoid);
  const cached = storedRoute(el);
  if (el.points.length >= 2 && cached && near(p0, start) && near(p1, end) && sameRoute(cached, route)) return el;
  return {
    ...el,
    points: [toPoint(el.points[0], start, 0), toPoint(el.points[1], end, 1)],
    content: { ...c, route },
  };
}
