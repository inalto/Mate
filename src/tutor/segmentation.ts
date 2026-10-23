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
  let dist = Math.hypot(dx * cfg.horizontalWeight, dy * cfg.verticalWeight);
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

function merged(a: Cluster, b: Cluster): Cluster {
  const x = Math.min(a.bounds.x, b.bounds.x);
  const y = Math.min(a.bounds.y, b.bounds.y);
  const r = Math.max(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width);
  const btm = Math.max(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height);
  const timed = a.tStart !== undefined && b.tStart !== undefined;
  return {
    ids: a.ids.concat(b.ids),
    bounds: { x, y, width: r - x, height: btm - y },
    baselineY: btm,
    ...(timed ? { tStart: Math.min(a.tStart!, b.tStart!), tEnd: Math.max(a.tEnd!, b.tEnd!) } : {}),
    points: a.points + b.points,
    path: a.path + b.path,
  };
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
  const bestJ = new Int32Array(n).fill(-1);
  const bestC = new Float64Array(n).fill(Infinity);
  const refresh = (i: number) => {
    bestJ[i] = -1;
    bestC[i] = Infinity;
    const ci = cs[i]!;
    for (let j = 0; j < n; j++) {
      const cj = cs[j];
      if (j === i || !cj) continue;
      const c = mergeCost(ci, cj, cfg);
      if (c < bestC[i]) {
        bestC[i] = c;
        bestJ[i] = j;
      }
    }
  };
  for (let i = 0; i < n; i++) refresh(i);
  // Closest pair first, until nothing is within reach.
  for (;;) {
    let i = -1;
    for (let k = 0; k < n; k++) if (cs[k] && (i < 0 || bestC[k] < bestC[i])) i = k;
    if (i < 0 || !(bestC[i] <= 1)) break;
    const j = bestJ[i];
    cs[i] = merged(cs[i]!, cs[j]!);
    cs[j] = null;
    refresh(i);
    for (let k = 0; k < n; k++) {
      if (k === i || !cs[k]) continue;
      if (bestJ[k] === i || bestJ[k] === j) refresh(k);
      else {
        const c = mergeCost(cs[k]!, cs[i]!, cfg);
        if (c < bestC[k]) {
          bestC[k] = c;
          bestJ[k] = i;
        }
      }
    }
  }
  const regions: Region[] = [];
  for (const c of cs) {
    if (!c || c.ids.length < cfg.minElementsPerRegion || !enoughInk(c)) continue;
    const elementIds = [...c.ids].sort();
    regions.push({ regionId: regionIdOf(elementIds), type: "math", elementIds, bounds: c.bounds, baselineY: c.baselineY });
  }
  return regions.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
}
