import type { ToolbarLayout } from "../model/types";

export const ITEM_IDS = [
  "pens",
  "covers",
  "cursor",
  "lasso",
  "eraser",
  "shape",
  "connector",
  "frame",
  "text",
  "note",
  "mindmap",
  "insertSpace",
  "insert",
  "image",
  "media",
  "table",
  "code",
  "equation",
  "graph",
  "dictate",
  "record",
  "straight",
  "ruler",
  "autoShapes",
  "finger",
  "present",
  "paper",
  "zoom",
] as const;

export type ItemId = (typeof ITEM_IDS)[number];
export const SEP = "sep";
export type Slot = ItemId | typeof SEP;

export const REQUIRED: ReadonlySet<ItemId> = new Set<ItemId>(["pens"]);
export const MOBILE_ONLY: ReadonlySet<ItemId> = new Set<ItemId>(["finger"]);
export const MAX_ROWS = 2;

const ID_SET: ReadonlySet<string> = new Set(ITEM_IDS);

function isItem(slot: string): slot is ItemId {
  return ID_SET.has(slot);
}

export function defaultRows(mobile: boolean): Slot[][] {
  const row: Slot[] = [
    "pens", "covers", SEP,
    "cursor", "lasso", "eraser", "shape", "connector", "frame", "text", "note", "mindmap", "insertSpace", SEP,
    "insert", "dictate", "record", SEP,
    "straight", "ruler", "autoShapes",
  ];
  if (mobile) row.push("finger");
  row.push(SEP, "present", "paper");
  if (!mobile) row.push("zoom");
  return [row];
}

/** Drops a leading, trailing or doubled separator. */
function trimSeparators(row: Slot[]): Slot[] {
  const out: Slot[] = [];
  for (const slot of row) {
    if (slot === SEP && (out.length === 0 || out[out.length - 1] === SEP)) continue;
    out.push(slot);
  }
  if (out[out.length - 1] === SEP) out.pop();
  return out;
}

function tidy(rows: Slot[][]): Slot[][] {
  const trimmed = rows.map(trimSeparators);
  return trimmed.length > 1 && trimmed[1].length === 0 ? [trimmed[0]] : trimmed;
}

export function repairLayout(saved: ToolbarLayout | null, mobile: boolean): Slot[][] {
  if (!saved || saved.rows.length === 0) return defaultRows(mobile);
  const seen = new Set<string>();
  let rows: Slot[][] = saved.rows.map((row) => {
    const kept: Slot[] = [];
    for (const slot of row) {
      if (slot === SEP) kept.push(SEP);
      else if (isItem(slot) && !seen.has(slot)) {
        seen.add(slot);
        kept.push(slot);
      }
    }
    return kept;
  });
  if (rows.length > MAX_ROWS) {
    rows = [rows[0], rows.slice(1).flat()];
  }
  const known = new Set(saved.known);
  for (const id of ITEM_IDS) {
    if (!known.has(id) && !seen.has(id)) {
      rows[0].push(id);
      seen.add(id);
    }
  }
  if (!seen.has("pens")) rows[0].unshift("pens");
  return tidy(rows);
}

export interface Resolved {
  rows: Slot[][];
  hidden: ItemId[];
}

export function resolveLayout(saved: ToolbarLayout | null, mobile: boolean): Resolved {
  let rows = repairLayout(saved, mobile);
  if (!mobile) {
    rows = tidy(rows.map((row) => row.filter((slot) => slot === SEP || !MOBILE_ONLY.has(slot))));
  }
  const placed = new Set<string>(rows.flat());
  const hidden = ITEM_IDS.filter((id) => !placed.has(id) && (mobile || !MOBILE_ONLY.has(id)));
  return { rows, hidden };
}

export function toSaved(rows: Slot[][]): ToolbarLayout {
  return { rows: rows.map((row) => [...row]), known: [...ITEM_IDS] };
}

const clone = (rows: Slot[][]): Slot[][] => rows.map((row) => [...row]);
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

export function moveSlot(
  rows: Slot[][],
  from: { row: number; index: number },
  to: { row: number; index: number },
): Slot[][] {
  const src = rows[from.row];
  if (!src || from.index < 0 || from.index >= src.length || !rows[to.row]) return rows;
  const next = clone(rows);
  const [slot] = next[from.row].splice(from.index, 1);
  const dest = next[to.row];
  dest.splice(clamp(to.index, 0, dest.length), 0, slot);
  return next;
}

export function hideItem(rows: Slot[][], id: ItemId): Slot[][] {
  if (REQUIRED.has(id)) return rows;
  return rows.map((row) => row.filter((slot) => slot !== id));
}

export function showItem(rows: Slot[][], id: ItemId, row = 0): Slot[][] {
  if (rows.some((r) => r.includes(id)) || rows.length === 0) return rows;
  const next = clone(rows);
  next[clamp(row, 0, next.length - 1)].push(id);
  return next;
}

export function addSeparator(rows: Slot[][], row: number): Slot[][] {
  if (!rows[row]) return rows;
  const next = clone(rows);
  next[row].push(SEP);
  return next;
}

export function removeSlot(rows: Slot[][], at: { row: number; index: number }): Slot[][] {
  if (rows[at.row]?.[at.index] !== SEP) return rows;
  const next = clone(rows);
  next[at.row].splice(at.index, 1);
  return next;
}

export function setTwoRows(rows: Slot[][], on: boolean): Slot[][] {
  if (on) return rows.length >= 2 ? rows : [...clone(rows), []];
  if (rows.length <= 1) return rows;
  return [rows.flat()];
}
