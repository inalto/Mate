// Frame containment (pure). A frame's children are computed, never stored: an element belongs to
// the smallest frame whose rect contains the centre of its bounds. Frames nest the same way (a
// frame's parent is the smallest strictly larger frame containing its centre; equal sizes break the
// tie by z-order, the lower one being the parent), so `frameChildren` of an outer frame includes the
// inner frames and everything in them. Also the title geometry shared by the renderer, the hit test
// and the rename popover, and the default title of a new frame.
import { contentOf, isPdfPlacement, type FrameContent } from "../model/content";
import type { Element } from "../model/types";
import { boxRect, elementBounds, type Rect } from "../tools/spatialIndex";
import { compareZ } from "../tools/zorder";

/** Title font size (screen px at zoom ≤ 1; page units above it) and its gap to the border. */
export const FRAME_TITLE_SIZE = 14;
export const FRAME_TITLE_GAP = 6;
/** The title hides when the frame is narrower than this on screen (px). */
export const FRAME_TITLE_MIN_PX = 80;
/** Corner radius of the frame rect (page units). */
export const FRAME_RADIUS = 8;
/** Page units above the frame rect that its bounds reserve for the title (the title at zoom 1). */
export const FRAME_TITLE_BAND = FRAME_TITLE_SIZE * 1.4 + FRAME_TITLE_GAP;

export const isFrame = (el: Pick<Element, "type">): boolean => el.type === "frame";

/** The frame's title (trimmed; "" when unset). */
export const frameTitle = (el: Element): string => {
  const t = contentOf<FrameContent>(el).title;
  return typeof t === "string" ? t : "";
};

/** Presentation order of a frame (`content.order`, 0 when unset). */
export const frameOrder = (el: Element): number => {
  const o = contentOf<FrameContent>(el).order;
  return typeof o === "number" && Number.isFinite(o) ? o : 0;
};

const area = (r: Rect): number => r.width * r.height;

const contains = (r: Rect, x: number, y: number): boolean => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;

/** The point that decides which frame `el` belongs to: a frame's rect centre, else its bounds centre. */
function centreOf(el: Element): { x: number; y: number } {
  const b = isFrame(el) ? boxRect(el) : elementBounds(el);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** True when frame `f` may be the parent of frame `el` (strictly larger, or as large and below it). */
function outranks(f: Element, el: Element): boolean {
  const a = area(boxRect(f));
  const b = area(boxRect(el));
  return a > b || (a === b && compareZ(f, el) < 0);
}

/** The smallest frame of `frames` whose rect contains the centre of `el`'s bounds, or null. */
export function frameOf(el: Element, frames: Iterable<Element>): Element | null {
  const c = centreOf(el);
  let best: Element | null = null;
  let bestArea = Infinity;
  let bestDist = Infinity;
  for (const f of frames) {
    if (f.id === el.id || !isFrame(f)) continue;
    const r = boxRect(f);
    if (!contains(r, c.x, c.y)) continue;
    if (isFrame(el) && !outranks(f, el)) continue;
    const a = area(r);
    // Equal sizes (a copy overlapping its original): the frame centred nearer wins, then the upper one.
    const d = Math.hypot(r.x + r.width / 2 - c.x, r.y + r.height / 2 - c.y);
    if (a < bestArea || (a === bestArea && (d < bestDist || (d === bestDist && best && compareZ(f, best) > 0)))) {
      best = f;
      bestArea = a;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Every element inside `frame` (its direct children and, through nested frames, theirs), in the
 * order of `all`. PDF placements never belong to a frame.
 */
export function frameChildren(frame: Element, all: Iterable<Element>): Element[] {
  const els = [...all].filter((e) => !isPdfPlacement(e));
  const frames = els.filter(isFrame);
  const parent = new Map<string, string | null>();
  const parentOf = (el: Element): string | null => {
    let p = parent.get(el.id);
    if (p === undefined) {
      p = frameOf(el, frames)?.id ?? null;
      parent.set(el.id, p);
    }
    return p;
  };
  const byId = new Map(frames.map((f) => [f.id, f]));
  const inside = (el: Element): boolean => {
    // Walk up the frame chain (acyclic: each step goes to a strictly outranking frame).
    for (let p = parentOf(el); p !== null; ) {
      if (p === frame.id) return true;
      const f = byId.get(p);
      if (!f) return false;
      p = parentOf(f);
    }
    return false;
  };
  return els.filter((e) => e.id !== frame.id && inside(e));
}

/**
 * `selected` plus the children of the selected frames, without duplicates (selected first). Use for
 * moves and duplicates; callers filter locked elements themselves.
 */
export function withFrameChildren(selected: readonly Element[], all: Iterable<Element>): Element[] {
  if (!selected.some(isFrame)) return [...selected];
  const list = [...all];
  const out = [...selected];
  const seen = new Set(selected.map((e) => e.id));
  for (const f of selected) {
    if (!isFrame(f)) continue;
    for (const c of frameChildren(f, list)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/** Title scale: screen-constant when zoomed out (≤ 1), page-sized when zoomed in. */
const titleScale = (zoom: number): number => 1 / Math.min(1, Math.max(zoom, 1e-6));

/** True when the frame is too narrow on screen at `zoom` to show its title. */
export const frameTitleHidden = (el: Element, zoom: number): boolean => boxRect(el).width * zoom < FRAME_TITLE_MIN_PX;

/**
 * The title's rect in page units at `zoom`: above the top-left corner, or inside below the top edge
 * when `nested`. Its width is estimated (0.6 em per glyph) and capped at the frame width. Empty
 * (0×0 at the corner) when the title is hidden.
 */
export function frameTitleRect(el: Element, zoom: number, nested = false): Rect {
  const r = boxRect(el);
  if (frameTitleHidden(el, zoom)) return { x: r.x, y: r.y, width: 0, height: 0 };
  const k = titleScale(zoom);
  const size = FRAME_TITLE_SIZE * k;
  const height = size * 1.4;
  const gap = FRAME_TITLE_GAP * k;
  const text = frameTitle(el) || " ";
  let glyphs = 0;
  for (const ch of text) glyphs += ch.charCodeAt(0) > 0x2e80 ? 1 : 0.6;
  const width = Math.min(r.width - (nested ? 2 * gap : 0), Math.max(size * 2, glyphs * size + 2));
  return nested ? { x: r.x + gap, y: r.y + gap, width, height } : { x: r.x, y: r.y - gap - height, width, height };
}

/** "Frame n" for a new frame: n = number of frames + 1 (`format` localises it). */
export function nextFrameTitle(all: Iterable<Element>, format: (n: number) => string = (n) => `Frame ${n}`): string {
  let n = 0;
  for (const el of all) if (isFrame(el)) n++;
  return format(n + 1);
}

/** Frames of `all` in presentation order: `content.order` ascending, then createdAt, then id. */
export function framesInOrder(all: Iterable<Element>): Element[] {
  return [...all]
    .filter(isFrame)
    .sort(
      (a, b) =>
        frameOrder(a) - frameOrder(b) ||
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

// ---- frames per page, for the renderer (which draws one element at a time) ----

const pageFrames = new Map<string, Element[]>();

/** Publish the frames of page `pageId` (the editor store calls this when they change). */
export function setPageFrames(pageId: string, frames: Element[]): void {
  if (frames.length === 0) pageFrames.delete(pageId);
  else pageFrames.set(pageId, frames);
}

/** True when frame `el` sits inside another frame of its page (its title is drawn inside). */
export function isNestedFrame(el: Element): boolean {
  const frames = pageFrames.get(el.pageId);
  if (!frames) return false;
  const live = frames.map((f) => (f.id === el.id ? el : f));
  return frameOf(el, live) !== null;
}

// ---- presets ----

/** Frame presets of the toolbar menu (page units). */
export const FRAME_PRESETS = [
  { key: "preset169", width: 1280, height: 720 },
  { key: "preset43", width: 1024, height: 768 },
  { key: "presetSquare", width: 800, height: 800 },
  { key: "presetA4", width: 794, height: 1123 },
] as const;

/** A preset is nudged by this much (page units, both axes) while a frame of its size sits there. */
export const FRAME_PRESET_NUDGE = 24;

/**
 * Rect of a `width`×`height` preset frame centred on `centre`, moved down-right by 24 until no
 * frame of the same size sits at that spot.
 */
export function presetFrameRect(frames: Iterable<Element>, centre: { x: number; y: number }, width: number, height: number): Rect {
  const same = [...frames].filter(isFrame).map(boxRect).filter((r) => Math.abs(r.width - width) < 0.5 && Math.abs(r.height - height) < 0.5);
  let x = centre.x - width / 2;
  let y = centre.y - height / 2;
  for (let i = 0; i < 1000 && same.some((r) => Math.abs(r.x - x) < 0.5 && Math.abs(r.y - y) < 0.5); i++) {
    x += FRAME_PRESET_NUDGE;
    y += FRAME_PRESET_NUDGE;
  }
  return { x, y, width, height };
}
