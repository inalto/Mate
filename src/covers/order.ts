import type { Rect } from "../tools/spatialIndex";

/** Two covers share a row when their vertical ranges overlap by at least this part of the shorter height. */
const ROW_OVERLAP = 0.5;

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The ids of `covers` as a page is read: rows top to bottom, each row left to right. Covers are
 * taken by their top; one joins the current row when it overlaps the row's first cover vertically
 * by at least half of the shorter of the two heights (a tall box beside two short lines stays with
 * the first of them). Equal positions fall back to id order, so the order is the same every time.
 */
export function readingOrder(covers: readonly { id: string; bounds: Rect }[]): string[] {
  const sorted = [...covers].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x || byId(a, b));
  const rows: (typeof sorted)[] = [];
  for (const c of sorted) {
    const row = rows[rows.length - 1];
    const first = row?.[0].bounds;
    const b = c.bounds;
    const overlap = first ? Math.min(first.y + first.height, b.y + b.height) - Math.max(first.y, b.y) : -1;
    if (row && first && overlap >= ROW_OVERLAP * Math.min(first.height, b.height)) row.push(c);
    else rows.push([c]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || byId(a, b)).map((c) => c.id));
}
