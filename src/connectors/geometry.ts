// Connector geometry read from the element alone (pure): its cached route, caps, label pill,
// bounds and hit test. Never looks at other elements, so exports and thumbnails are self-contained.
import type { Vec2 } from "../canvas/camera";
import { CONNECTOR_CAPS, contentOf, type ConnectorContent, type LineCap, type LineCaps } from "../model/content";
import type { Element } from "../model/types";
import { arrowHeadLength, barCapLength, capOutline, dotCapRadius } from "../shapes/geometry";
import type { Rect } from "../tools/spatialIndex";
import { CONNECTOR_MODES, pointAt, type ConnectorMode } from "./route";

export const DEFAULT_CONNECTOR_MODE: ConnectorMode = "curve";
export const DEFAULT_CONNECTOR_CAPS: LineCaps = { start: "none", end: "arrow" };
/** Label text size (page units) and the pill around it. */
export const CONNECTOR_LABEL_SIZE = 14;
export const CONNECTOR_LABEL_FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const LABEL_PAD_X = 8;
const LABEL_PAD_Y = 4;

const isVec = (v: unknown): v is Vec2 =>
  v !== null && typeof v === "object" && Number.isFinite((v as Vec2).x) && Number.isFinite((v as Vec2).y);

const asCap = (v: unknown, fallback: LineCap): LineCap => ((CONNECTOR_CAPS as readonly unknown[]).includes(v) ? (v as LineCap) : fallback);

/** Mode of a connector (unknown values read as the default). */
export function connectorMode(el: Pick<Element, "content">): ConnectorMode {
  const m = contentOf<ConnectorContent>(el).mode;
  return (CONNECTOR_MODES as readonly unknown[]).includes(m) ? (m as ConnectorMode) : DEFAULT_CONNECTOR_MODE;
}

/** Caps of a connector (missing or unknown values read as the defaults). */
export function connectorCaps(el: Pick<Element, "content">): LineCaps {
  const c = contentOf<ConnectorContent>(el).caps;
  if (c === null || typeof c !== "object") return { ...DEFAULT_CONNECTOR_CAPS };
  return { start: asCap(c.start, DEFAULT_CONNECTOR_CAPS.start), end: asCap(c.end, DEFAULT_CONNECTOR_CAPS.end) };
}

/** The cached route when it is a valid polyline (≥ 2 points), else null. */
export function storedRoute(el: Pick<Element, "content">): Vec2[] | null {
  const r = contentOf<ConnectorContent>(el).route;
  return Array.isArray(r) && r.length >= 2 && r.every(isVec) ? r : null;
}

/** The cached route, else the straight segment between the endpoints. */
export function connectorRoute(el: Pick<Element, "content" | "points">): Vec2[] {
  const r = storedRoute(el);
  if (r) return r;
  const a = el.points[0];
  if (!a) return [];
  const b = el.points[1] ?? a;
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: b.y },
  ];
}

/** The label when it has visible text (t clamped to 0..1), else null. */
export function connectorLabel(el: Pick<Element, "content">): { text: string; t: number } | null {
  const l = contentOf<ConnectorContent>(el).label;
  if (!l || typeof l !== "object" || typeof l.text !== "string" || l.text.trim() === "") return null;
  const t = Number.isFinite(l.t) ? Math.max(0, Math.min(1, l.t)) : 0.5;
  return { text: l.text, t };
}

/** Estimated advance of `text` at `size` (wide glyphs count double): no DOM, so bounds work anywhere. */
export function estimateTextWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 1 : 0.6;
  return w * size;
}

/** The label pill (page units) centred on the route at the label's `t`, or null without a label. */
export function labelPill(el: Pick<Element, "content" | "points">): (Rect & { centre: Vec2; text: string }) | null {
  const label = connectorLabel(el);
  if (!label) return null;
  const centre = pointAt(connectorRoute(el), label.t);
  const height = CONNECTOR_LABEL_SIZE + 2 * LABEL_PAD_Y;
  const width = Math.max(height, estimateTextWidth(label.text, CONNECTOR_LABEL_SIZE) + 2 * LABEL_PAD_X);
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height, centre, text: label.text };
}

/** Unit direction pointing out of the route at its start (`atEnd` false) or end. */
function endDir(route: readonly Vec2[], atEnd: boolean): Vec2 {
  const at = atEnd ? route[route.length - 1] : route[0];
  for (let i = 1; i < route.length; i++) {
    const q = atEnd ? route[route.length - 1 - i] : route[i];
    const d = Math.hypot(at.x - q.x, at.y - q.y);
    if (d > 1e-9) return { x: (at.x - q.x) / d, y: (at.y - q.y) / d };
  }
  return { x: 0, y: 0 };
}

/** Cap outlines (start, then end) along the route tangent; caps of kind "none" are left out. */
export function connectorCapOutlines(el: Element): Vec2[][] {
  const route = connectorRoute(el);
  if (route.length < 2) return [];
  const caps = connectorCaps(el);
  const head = arrowHeadLength(el.width);
  return [
    capOutline(caps.start, route[0], endDir(route, false), el.width, head),
    capOutline(caps.end, route[route.length - 1], endDir(route, true), el.width, head),
  ].filter((p) => p.length > 0);
}

/** Furthest a cap reaches from its end point. */
function capReach(el: Element): number {
  const caps = connectorCaps(el);
  const reach = (c: LineCap) =>
    c === "arrow" || c === "diamond" ? arrowHeadLength(el.width) : c === "dot" ? dotCapRadius(el.width) : c === "bar" ? barCapLength(el.width) / 2 : 0;
  return Math.max(reach(caps.start), reach(caps.end));
}

/** Route bounding box padded by half the width and the caps, united with the label pill. */
export function connectorBounds(el: Element): Rect {
  const route = connectorRoute(el);
  if (route.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of route) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const padBy = el.width / 2 + capReach(el);
  minX -= padBy;
  minY -= padBy;
  maxX += padBy;
  maxY += padBy;
  const pill = labelPill(el);
  if (pill) {
    minX = Math.min(minX, pill.x);
    minY = Math.min(minY, pill.y);
    maxX = Math.max(maxX, pill.x + pill.width);
    maxY = Math.max(maxY, pill.y + pill.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function segDist2(a: Vec2, b: Vec2, c: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2)) : 0;
  return (a.x + t * dx - c.x) ** 2 + (a.y + t * dy - c.y) ** 2;
}

/** True when `p` lies within `width/2 + tol` of the route, or inside the label pill (grown by `tol`). */
export function connectorHit(el: Element, p: Vec2, tol: number): boolean {
  const route = connectorRoute(el);
  const r2 = (el.width / 2 + tol) ** 2;
  for (let i = 0; i + 1 < route.length; i++) if (segDist2(route[i], route[i + 1], p) <= r2) return true;
  const pill = labelPill(el);
  return !!pill && p.x >= pill.x - tol && p.x <= pill.x + pill.width + tol && p.y >= pill.y - tol && p.y <= pill.y + pill.height + tol;
}
