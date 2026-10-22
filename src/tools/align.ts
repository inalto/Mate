// Align and distribute (pure): move elements so their bounds line up / are evenly spaced.
import type { Element } from "../model/types";
import { translateElements } from "./lasso";
import { elementBounds, type Rect } from "./spatialIndex";

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";

const union = (rs: Rect[]) => {
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.width));
  const y1 = Math.max(...rs.map((r) => r.y + r.height));
  return { x0, y0, x1, y1 };
};

/** Each element moved so its bounds align to the selection's edge or centre; order preserved. */
export function alignElements(els: readonly Element[], mode: AlignMode): Element[] {
  if (els.length < 2) return [...els];
  const rs = els.map(elementBounds);
  const u = union(rs);
  return els.map((el, i) => {
    const r = rs[i];
    let dx = 0;
    let dy = 0;
    if (mode === "left") dx = u.x0 - r.x;
    else if (mode === "right") dx = u.x1 - (r.x + r.width);
    else if (mode === "center") dx = (u.x0 + u.x1) / 2 - (r.x + r.width / 2);
    else if (mode === "top") dy = u.y0 - r.y;
    else if (mode === "bottom") dy = u.y1 - (r.y + r.height);
    else dy = (u.y0 + u.y1) / 2 - (r.y + r.height / 2);
    return dx === 0 && dy === 0 ? el : translateElements([el], dx, dy)[0];
  });
}

/** Equal gaps between bounds along `axis`; the two outermost elements stay put. Order preserved. */
export function distributeElements(els: readonly Element[], axis: DistributeAxis): Element[] {
  if (els.length < 3) return [...els];
  const h = axis === "horizontal";
  const rs = els.map(elementBounds);
  const pos = (r: Rect) => (h ? r.x : r.y);
  const size = (r: Rect) => (h ? r.width : r.height);
  const order = rs.map((_, i) => i).sort((a, b) => pos(rs[a]) - pos(rs[b]));
  const first = rs[order[0]];
  const last = order.map((i) => rs[i]).reduce((m, r) => (pos(r) + size(r) > pos(m) + size(m) ? r : m));
  const span = pos(last) + size(last) - pos(first);
  const gap = (span - order.reduce((n, i) => n + size(rs[i]), 0)) / (order.length - 1);
  const out = [...els];
  let cursor = pos(first);
  for (const i of order) {
    const d = cursor - pos(rs[i]);
    if (d !== 0) out[i] = translateElements([els[i]], h ? d : 0, h ? 0 : d)[0];
    cursor += size(rs[i]) + gap;
  }
  return out;
}
