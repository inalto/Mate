// Ink segmentation: agglomerative clustering of a page's pen strokes into regions (lines/groups of
// handwriting) that the tutor recognises as a unit. Pure; bounds come from `elementBounds`.
import type { Element } from "../model/types";
import { elementBounds, type Rect } from "../tools/spatialIndex";
import type { Region } from "./types";

export interface SegmentationConfig {
  /** Base merge reach (world units) before the adaptive height scaling. */
  distanceThreshold: number;
  /** Strokes committed further apart than this never merge. */
  maxTimeGapMs: number;
  /** Clusters whose vertical gap exceeds this are different lines. */
  lineYThreshold: number;
  minElementsPerRegion: number;
  /** Minimum x-overlap fraction for two stacked clusters to be one column (with `columnDetection`). */
  horizontalOverlap: number;
  /** Distance multiplier for strokes drawn within `TEMPORAL_NEAR_MS` of each other. */
  temporalWeight: number;
  horizontalWeight: number;
  verticalWeight: number;
  /** Most recent strokes clustered at most; older ones are left out. */
  maxClusterElements: number;
  /** When on, vertically separated clusters merge only when they share a column. */
  columnDetection: boolean;
}

export const DEFAULT_SEGMENTATION: SegmentationConfig = {
  distanceThreshold: 40,
  maxTimeGapMs: 12000,
  lineYThreshold: 70,
  minElementsPerRegion: 1,
  horizontalOverlap: 0.3,
  temporalWeight: 0.6,
  horizontalWeight: 0.5,
  verticalWeight: 1.2,
  maxClusterElements: 10000,
  columnDetection: false,
};

/** Baselines within this fraction of the taller cluster's height count as aligned. */
export const BASELINE_ALIGN = 0.4;
/** Reach multiplier for aligned baselines. */
export const BASELINE_BONUS = 1.3;
/** Reach multiplier for misaligned baselines. */
export const BASELINE_PENALTY = 0.6;
/** Strokes closer in time than this get `temporalWeight`. */
export const TEMPORAL_NEAR_MS = 500;
/** Same-row (dy = 0) reach multiplier. */
const SAME_ROW_FACTOR = 1.3;
const MAX_REACH = 600;

/** Minimum ink before a region is emitted. */
export const MIN_INK_SIZE = 15;
export const MIN_INK_POINTS = 8;
export const MIN_INK_PATH = 40;

/** Adaptive merge reach: grows with writing size, clamped to [thr, 600]. */
export const adaptive = (h: number, thr: number): number => Math.min(MAX_REACH, Math.max(thr, 0.9 * h));

/** What merge reach needs of a cluster or region; times are optional (absent → no temporal terms). */
export interface ReachShape {
  bounds: Rect;
  baselineY: number;
  tStart?: number;
  tEnd?: number;
}

const gap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));

/**
 * Merge cost: weighted gap distance over the merge reach (≤ 1 → within reach), or Infinity when the
 * two can never merge (time gap, different lines, different columns).
 */
export function mergeCost(a: ReachShape, b: ReachShape, cfg: SegmentationConfig = DEFAULT_SEGMENTATION): number {
  const A = a.bounds;
  const B = b.bounds;
  const dy = gap(A.y, A.y + A.height, B.y, B.y + B.height);
  if (dy > cfg.lineYThreshold) return Infinity;
  const dx = gap(A.x, A.x + A.width, B.x, B.x + B.width);
  const timed = a.tStart !== undefined && a.tEnd !== undefined && b.tStart !== undefined && b.tEnd !== undefined;
  const dt = timed ? gap(a.tStart!, a.tEnd!, b.tStart!, b.tEnd!) : null;
  if (dt !== null && dt > cfg.maxTimeGapMs) return Infinity;
  if (cfg.columnDetection && dy > 0) {
    const overlap = Math.max(0, Math.min(A.x + A.width, B.x + B.width) - Math.max(A.x, B.x));
    const minW = Math.min(A.width, B.width);
    if (minW <= 0 || overlap / minW < cfg.horizontalOverlap) return Infinity;
  }
  const maxHeight = Math.max(A.height, B.height);
  const hx = dx * cfg.horizontalWeight;
  const vy = dy * cfg.verticalWeight;
  let dist = Math.sqrt(hx * hx + vy * vy);
  if (dt !== null && dt <= TEMPORAL_NEAR_MS) dist *= cfg.temporalWeight;
  const aligned = Math.abs(a.baselineY - b.baselineY) <= BASELINE_ALIGN * maxHeight;
  const reach =
    adaptive(maxHeight, cfg.distanceThreshold) * (dy === 0 ? SAME_ROW_FACTOR : 1) * (aligned ? BASELINE_BONUS : BASELINE_PENALTY);
  return dist / reach;
}

/** True when `a` and `b` are too far apart (in space or time) to belong to one region. */
export const beyondMergeReach = (a: ReachShape, b: ReachShape, cfg: SegmentationConfig = DEFAULT_SEGMENTATION): boolean =>
  mergeCost(a, b, cfg) > 1;

function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Stable region id: FNV-1a (two seeds, 16 hex chars) of the sorted member ids. */
export function regionIdOf(elementIds: readonly string[]): string {
  const key = [...elementIds].sort().join("\n");
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return hex(fnv1a(key, 0x811c9dc5)) + hex(fnv1a(key, 0x050c5d1f));
}

/** Stroke elements the tutor reads: pen ink only (no highlighter, shapes, boxes or PDF placements). */
export const isInkStroke = (el: Element): boolean =>
  el.type === "stroke" && !el.isHighlighter && el.penStyle !== "highlighter" && !el.deletedAt && el.points.length > 0;

interface Cluster {
  ids: string[];
  bounds: Rect;
  baselineY: number;
  tStart?: number;
  tEnd?: number;
  points: number;
  path: number;
}

function pathLength(el: Element): number {
  let len = 0;
  const p = el.points;
  for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return len;
}

/** Commit time (createdAt) back-dated by the stroke's own duration; undefined when unparseable. */
function strokeTimes(el: Element): { tStart?: number; tEnd?: number } {
  const end = Date.parse(el.createdAt);
  if (!Number.isFinite(end)) return {};
  const p = el.points;
  const span = Math.max(0, (p[p.length - 1]?.timestamp ?? 0) - (p[0]?.timestamp ?? 0));
  return { tStart: end - (Number.isFinite(span) ? span : 0), tEnd: end };
}

function clusterOf(el: Element): Cluster {
  const b = elementBounds(el);
  return { ids: [el.id], bounds: b, baselineY: b.y + b.height, ...strokeTimes(el), points: el.points.length, path: pathLength(el) };
}

/** Appends `b` to `a` in place (clusters are internal; avoids an O(n) copy per merge). */
function append(a: string[], b: string[]): string[] {
  for (const id of b) a.push(id);
  return a;
}

function merged(a: Cluster, b: Cluster): Cluster {
  const x = Math.min(a.bounds.x, b.bounds.x);
  const y = Math.min(a.bounds.y, b.bounds.y);
  const r = Math.max(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width);
  const btm = Math.max(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height);
  const timed = a.tStart !== undefined && b.tStart !== undefined;
  return {
    ids: append(a.ids, b.ids),
    bounds: { x, y, width: r - x, height: btm - y },
    baselineY: btm,
    ...(timed ? { tStart: Math.min(a.tStart!, b.tStart!), tEnd: Math.max(a.tEnd!, b.tEnd!) } : {}),
    points: a.points + b.points,
    path: a.path + b.path,
  };
}

/**
 * Uniform grid (cell = lineYThreshold) over cluster bounds, for neighbour candidates. A query covers
 * the dy window lineYThreshold (beyond → different lines) and a dx window past which no merge reach
 * can stretch: maxReach / (horizontalWeight · min(1, temporalWeight)), where maxReach uses the
 * tallest cluster so far (reach only grows with height, capped at 600).
 */
class ClusterGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly range: Int32Array;
  private readonly stamp: Int32Array;
  private tick = 0;
  private readonly cell: number;
  private readonly wy: number;
  private maxHeight = 0;

  private readonly cs: (Cluster | null)[];
  private readonly cfg: SegmentationConfig;

  constructor(cs: (Cluster | null)[], cfg: SegmentationConfig) {
    this.cs = cs;
    this.cfg = cfg;
    this.cell = Math.max(1, cfg.lineYThreshold);
    this.wy = cfg.lineYThreshold;
    this.range = new Int32Array(cs.length * 4);
    this.stamp = new Int32Array(cs.length);
    cs.forEach((c, i) => {
      this.maxHeight = Math.max(this.maxHeight, c!.bounds.height);
      const [x0, y0, x1, y1] = this.cellsOf(c!.bounds, 0, 0);
      this.range.set([x0, y0, x1, y1], i * 4);
      this.add(i, x0, y0, x1, y1, Infinity, Infinity, -Infinity, -Infinity);
    });
  }

  private cellsOf(r: Rect, mx: number, my: number): [number, number, number, number] {
    const c = this.cell;
    return [
      Math.floor((r.x - mx) / c),
      Math.floor((r.y - my) / c),
      Math.floor((r.x + r.width + mx) / c),
      Math.floor((r.y + r.height + my) / c),
    ];
  }

  private static key = (cx: number, cy: number) => (cx + 0x100000) * 0x200000 + (cy + 0x100000);

  /** Register `i` in cells of [x0..x1]×[y0..y1] that are outside the old range [ox0..ox1]×[oy0..oy1]. */
  private add(i: number, x0: number, y0: number, x1: number, y1: number, ox0: number, oy0: number, ox1: number, oy1: number) {
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        if (cx >= ox0 && cx <= ox1 && cy >= oy0 && cy <= oy1) continue;
        const k = ClusterGrid.key(cx, cy);
        const list = this.cells.get(k);
        if (list) list.push(i);
        else this.cells.set(k, [i]);
      }
  }

  /** Cluster `i` grew (merge): register it in its new cells. */
  grow(i: number): void {
    const r = this.range;
    const o = i * 4;
    this.maxHeight = Math.max(this.maxHeight, this.cs[i]!.bounds.height);
    const [x0, y0, x1, y1] = this.cellsOf(this.cs[i]!.bounds, 0, 0);
    this.add(i, x0, y0, x1, y1, r[o], r[o + 1], r[o + 2], r[o + 3]);
    r.set([Math.min(x0, r[o]), Math.min(y0, r[o + 1]), Math.max(x1, r[o + 2]), Math.max(y1, r[o + 3])], o);
  }

  /**
   * Visit each live neighbour of `i` once, own cells first (overlapping clusters always share a cell),
   * then the rest of the reach window; `visit` returning true stops the scan. Dead entries are compacted.
   */
  near(i: number, visit: (j: number) => boolean): void {
    const t = ++this.tick;
    this.stamp[i] = t;
    const cfg = this.cfg;
    const b = this.cs[i]!.bounds;
    const maxReach = adaptive(this.maxHeight, cfg.distanceThreshold) * SAME_ROW_FACTOR * Math.max(BASELINE_BONUS, BASELINE_PENALTY);
    const wx = maxReach / (cfg.horizontalWeight * Math.min(1, cfg.temporalWeight));
    const [ox0, oy0, ox1, oy1] = this.cellsOf(b, 0, 0);
    if (this.scanRange(ox0, oy0, ox1, oy1, t, visit)) return;
    const [x0, y0, x1, y1] = this.cellsOf(b, wx, this.wy);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        if (cx >= ox0 && cx <= ox1 && cy >= oy0 && cy <= oy1) continue;
        if (this.scan(cx, cy, t, visit)) return;
      }
  }

  /** Visit each live cluster sharing a cell with `i` (every cluster whose bounds overlap `i`'s, and some more). */
  own(i: number, visit: (j: number) => boolean): void {
    const t = ++this.tick;
    this.stamp[i] = t;
    const [x0, y0, x1, y1] = this.cellsOf(this.cs[i]!.bounds, 0, 0);
    this.scanRange(x0, y0, x1, y1, t, visit);
  }

  private scanRange(x0: number, y0: number, x1: number, y1: number, t: number, visit: (j: number) => boolean): boolean {
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) if (this.scan(cx, cy, t, visit)) return true;
    return false;
  }

  private scan(cx: number, cy: number, t: number, visit: (j: number) => boolean): boolean {
    const list = this.cells.get(ClusterGrid.key(cx, cy));
    if (!list) return false;
    const stamp = this.stamp;
    let w = 0;
    let stop = false;
    for (let r = 0; r < list.length; r++) {
      const j = list[r];
      if (!this.cs[j]) continue;
      list[w++] = j;
      if (stop || stamp[j] === t) continue;
      stamp[j] = t;
      stop = visit(j);
    }
    list.length = w;
    return stop;
  }
}

const enoughInk = (c: Cluster): boolean =>
  Math.max(c.bounds.width, c.bounds.height) >= MIN_INK_SIZE && c.points >= MIN_INK_POINTS && c.path >= MIN_INK_PATH;

/** Segment a page's pen strokes into regions, ordered top-to-bottom then left-to-right. */
export function segmentPage(elements: Iterable<Element>, cfg: SegmentationConfig = DEFAULT_SEGMENTATION): Region[] {
  let strokes = [...elements].filter(isInkStroke);
  if (strokes.length > cfg.maxClusterElements) {
    strokes = strokes
      .map((el) => ({ el, t: strokeTimes(el).tEnd ?? -Infinity }))
      .sort((p, q) => q.t - p.t)
      .slice(0, cfg.maxClusterElements)
      .map((p) => p.el);
  }
  const cs: (Cluster | null)[] = strokes.map(clusterOf);
  const n = cs.length;
  const grid = new ClusterGrid(cs, cfg);
  // Overlapping clusters (cost 0) merge before anything else in closest-pair order, and overlap only
  // grows with merging, so union them to a fixpoint first: dense ink (shading, cross-outs) collapses
  // here in near-linear time instead of one closest pair at a time.
  for (let i = 0; i < n; i++) {
    for (;;) {
      const ci = cs[i];
      if (!ci) break;
      const hits: number[] = [];
      grid.own(i, (j) => {
        if (mergeCost(ci, cs[j]!, cfg) === 0) hits.push(j);
        return false;
      });
      if (hits.length === 0) break;
      for (const j of hits) {
        cs[i] = merged(cs[i]!, cs[j]!);
        cs[j] = null;
      }
      grid.grow(i);
    }
  }
  const bestJ = new Int32Array(n).fill(-1);
  const bestC = new Float64Array(n).fill(Infinity);
  const refresh = (i: number) => {
    bestJ[i] = -1;
    bestC[i] = Infinity;
    const ci = cs[i]!;
    grid.near(i, (j) => {
      const c = mergeCost(ci, cs[j]!, cfg);
      if (c < bestC[i]) {
        bestC[i] = c;
        bestJ[i] = j;
      }
      return c === 0; // nothing beats overlap
    });
  };
  for (let i = 0; i < n; i++) if (cs[i]) refresh(i);
  // Closest pair first, until nothing is within reach.
  for (;;) {
    let i = -1;
    for (let k = 0; k < n; k++) if (cs[k] && (i < 0 || bestC[k] < bestC[i])) i = k;
    if (i < 0 || !(bestC[i] <= 1)) break;
    const j = bestJ[i];
    cs[i] = merged(cs[i]!, cs[j]!);
    cs[j] = null;
    grid.grow(i);
    refresh(i);
    // Only the merged cluster's neighbours can have a changed best pair: j lies inside i's bounds.
    const ci = cs[i]!;
    const stale: number[] = [];
    grid.near(i, (k) => {
      const pointed = bestJ[k] === i || bestJ[k] === j;
      if (bestC[k] === 0) {
        // Overlap with i or j is overlap with their union (time span only widens), so still 0.
        if (pointed) bestJ[k] = i;
        return false;
      }
      const c = mergeCost(cs[k]!, ci, cfg);
      if (pointed ? c <= bestC[k] : c < bestC[k]) {
        bestC[k] = c;
        bestJ[k] = i;
      } else if (pointed) stale.push(k);
      return false;
    });
    for (const k of stale) refresh(k);
  }
  const regions: Region[] = [];
  for (const c of cs) {
    if (!c || c.ids.length < cfg.minElementsPerRegion || !enoughInk(c)) continue;
    const elementIds = [...c.ids].sort();
    regions.push({ regionId: regionIdOf(elementIds), type: "math", elementIds, bounds: c.bounds, baselineY: c.baselineY });
  }
  return regions.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
}
