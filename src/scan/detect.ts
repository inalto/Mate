// Finds the four corners of a light page on a darker surface, the common case of a sheet photographed
// on a desk. Works on a small copy (≤ 256 px long side) so it stays instant on a 12-megapixel photo;
// anything it cannot find confidently returns null and the scan screen falls back to manual corners.
// An edge-based detector could replace detectQuad later without touching its callers.
import { isConvexQuad, orderQuad, quadArea } from "./quad";
import type { Pixels, Point, Quad } from "./types";

export const DETECT_LONG_SIDE = 256;
/** The detected quad must cover at least this share of the frame. */
const MIN_COVER = 0.1;
/** A component covering more than this share of the frame is the background, not a page. */
const FILL_COVER = 0.95;
/** Otsu splits even a flat image; below this gap between class means there is no page to find. */
const MIN_CONTRAST = 30;

/**
 * Box-average down so the long side is at most maxLongSide; the input itself when already small
 * enough. Each output pixel averages the whole block of source pixels it covers, so thin detail
 * is blended instead of aliased.
 */
export function downscale(src: Pixels, maxLongSide: number): Pixels {
  const { width: sw, height: sh, data: s } = src;
  const long = Math.max(sw, sh);
  if (long <= maxLongSide) return src;
  const k = maxLongSide / long;
  const w = Math.max(1, Math.round(sw * k));
  const h = Math.max(1, Math.round(sh * k));
  const xs = spans(sw, w);
  const ys = spans(sh, h);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = ys[y];
    const y1 = ys[y + 1];
    for (let x = 0; x < w; x++) {
      const x0 = xs[x];
      const x1 = xs[x + 1];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += s[i];
          g += s[i + 1];
          b += s[i + 2];
          a += s[i + 3];
        }
      }
      const n = (x1 - x0) * (y1 - y0);
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

/** Source index boundaries of n output cells over a length; every cell at least one source pixel. */
function spans(length: number, n: number): Int32Array {
  const b = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) b[i] = Math.floor((i * length) / n);
  for (let i = 1; i <= n; i++) if (b[i] <= b[i - 1]) b[i] = b[i - 1] + 1;
  b[n] = length;
  return b;
}

export function detectQuad(src: Pixels): Quad | null {
  if (src.width < 4 || src.height < 4) return null;
  const small = downscale(src, DETECT_LONG_SIDE);
  const { width: w, height: h } = small;

  const lum = blur3(luminance(small), w, h);
  const t = otsu(lum);
  if (t < 0) return null;

  const comp = largestComponent(lum, t, w, h);
  if (!comp) return null;

  const hull = convexHull(rowExtremes(comp, w, h));
  if (hull.length < 4) return null;
  const corners = refineCorners(hull, reduceHull(hull));
  if (!corners) return null;

  const sx = src.width / w;
  const sy = src.height / h;
  const quad = orderQuad(corners.map((p) => ({ x: p.x * sx, y: p.y * sy })));
  if (!isConvexQuad(quad)) return null;
  if (quadArea(quad) < MIN_COVER * src.width * src.height) return null;
  return quad;
}

function luminance(p: Pixels): Float32Array {
  const n = p.width * p.height;
  const out = new Float32Array(n);
  const d = p.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return out;
}

/** 3×3 box blur, borders clamped: takes the edge off sensor noise before thresholding. */
function blur3(v: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(v.length);
  for (let y = 0; y < h; y++) {
    const ya = y > 0 ? y - 1 : 0;
    const yb = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xa = x > 0 ? x - 1 : 0;
      const xb = x < w - 1 ? x + 1 : w - 1;
      let s = 0;
      for (const yy of [ya, y, yb]) {
        const r = yy * w;
        s += v[r + xa] + v[r + x] + v[r + xb];
      }
      out[y * w + x] = s / 9;
    }
  }
  return out;
}

/**
 * Otsu's threshold over a 256-bin histogram: pixels strictly above it are "light". Returns -1 when
 * the image has a single level or the two classes are too close (a blank or evenly lit frame).
 */
function otsu(v: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < v.length; i++) hist[Math.min(255, Math.max(0, Math.round(v[i])))]++;
  const total = v.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let w0 = 0;
  let sum0 = 0;
  let best = -1;
  let bestVar = 0;
  let bestGap = 0;
  for (let t = 0; t < 255; t++) {
    w0 += hist[t];
    sum0 += t * hist[t];
    const w1 = total - w0;
    if (w0 === 0 || w1 === 0) continue;
    const m0 = sum0 / w0;
    const m1 = (sumAll - sum0) / w1;
    const between = w0 * w1 * (m0 - m1) * (m0 - m1);
    if (between > bestVar) {
      bestVar = between;
      best = t;
      bestGap = m1 - m0;
    }
  }
  return best >= 0 && bestGap >= MIN_CONTRAST ? best : -1;
}

/**
 * Labels 4-connected light regions with an explicit queue (no recursion, so a full-frame region
 * cannot overflow the stack) and returns the largest one that does not fill the frame, as a mask.
 *
 * "Fills the frame" (the background, not a page): the region touches all four borders of the
 * frame, or covers more than 95 % of it. A page photographed edge to edge is then left to the
 * user's corners, which is the safer failure.
 */
function largestComponent(lum: Float32Array, t: number, w: number, h: number): Uint8Array | null {
  const n = w * h;
  const labels = new Int32Array(n);
  const queue = new Int32Array(n);
  let next = 0;
  let bestLabel = 0;
  let bestCount = 0;
  for (let start = 0; start < n; start++) {
    if (labels[start] !== 0 || lum[start] <= t) continue;
    const label = ++next;
    labels[start] = label;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && labels[i - 1] === 0 && lum[i - 1] > t) (labels[i - 1] = label), (queue[tail++] = i - 1);
      if (x < w - 1 && labels[i + 1] === 0 && lum[i + 1] > t) (labels[i + 1] = label), (queue[tail++] = i + 1);
      if (y > 0 && labels[i - w] === 0 && lum[i - w] > t) (labels[i - w] = label), (queue[tail++] = i - w);
      if (y < h - 1 && labels[i + w] === 0 && lum[i + w] > t) (labels[i + w] = label), (queue[tail++] = i + w);
    }
    const count = tail;
    const touchesAll = minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1;
    const fills = touchesAll || count > FILL_COVER * n;
    if (!fills && count > bestCount) {
      bestCount = count;
      bestLabel = label;
    }
  }
  if (bestLabel === 0) return null;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (labels[i] === bestLabel) mask[i] = 1;
  return mask;
}

/**
 * Only the leftmost and rightmost pixel of each row can be on the hull. Their outer pixel corners
 * (not centres) are used so the hull hugs the region's true outline instead of sitting half a
 * pixel inside it.
 */
function rowExtremes(mask: Uint8Array, w: number, h: number): Point[] {
  const pts: Point[] = [];
  for (let y = 0; y < h; y++) {
    const r = y * w;
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < w; x++) {
      if (mask[r + x]) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    if (lo < 0) continue;
    pts.push({ x: lo, y }, { x: lo, y: y + 1 }, { x: hi + 1, y }, { x: hi + 1, y: y + 1 });
  }
  return pts;
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Andrew's monotone chain; collinear points dropped. */
function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Indices of four hull vertices: repeatedly drop the vertex whose removal loses the least area
 * (the triangle it forms with its neighbours). Near-collinear edge points go first, the page's
 * corners last.
 */
function reduceHull(hull: Point[]): number[] {
  const idx = hull.map((_, i) => i);
  while (idx.length > 4) {
    let worst = 0;
    let worstArea = Infinity;
    for (let k = 0; k < idx.length; k++) {
      const a = hull[idx[(k + idx.length - 1) % idx.length]];
      const b = hull[idx[k]];
      const c = hull[idx[(k + 1) % idx.length]];
      const area = Math.abs(cross(a, b, c));
      if (area < worstArea) {
        worstArea = area;
        worst = k;
      }
    }
    idx.splice(worst, 1);
  }
  return idx;
}

/**
 * Vertex-dropping keeps hull vertices, and a rasterised or slightly rounded corner has none exactly
 * at the true corner, so the kept vertex sits inside it (by several pixels on a sharp corner that
 * the blur eroded). A straight page side shows up as a few long hull edges, the cut corner as short
 * ones: fit a line to each side's long hull edges (weighted by length) and take adjacent lines'
 * intersections as the corners; fall back to the kept vertex when a fit is degenerate or would move
 * it implausibly far.
 */
function refineCorners(hull: Point[], idx: number[]): Point[] | null {
  const n = hull.length;
  const lines: Line[] = [];
  for (let s = 0; s < 4; s++) {
    const i0 = idx[s];
    const i1 = idx[(s + 1) % 4];
    const edges: [Point, Point][] = [];
    let longest = 0;
    for (let i = i0; i !== i1; i = (i + 1) % n) {
      const e: [Point, Point] = [hull[i], hull[(i + 1) % n]];
      edges.push(e);
      longest = Math.max(longest, Math.hypot(e[1].x - e[0].x, e[1].y - e[0].y));
    }
    if (longest < 1e-9) return null;
    lines.push(fitSegments(edges.filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) >= 0.25 * longest)));
  }
  const reach = 0.1 * Math.hypot(...hullSpan(hull));
  return idx.map((vi, s) => {
    const kept = hull[vi];
    const p = intersect(lines[(s + 3) % 4], lines[s]);
    if (!p || Math.hypot(p.x - kept.x, p.y - kept.y) > reach) return kept;
    return p;
  });
}

/** A line as a point on it and a unit direction. */
interface Line {
  p: Point;
  d: Point;
}

/**
 * Total least squares over segments treated as uniform rods: the principal axis of their combined
 * mass through its centroid, so a long edge counts in proportion to its length.
 */
function fitSegments(segs: [Point, Point][]): Line {
  let mass = 0;
  let mx = 0;
  let my = 0;
  for (const [a, b] of segs) {
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    mass += l;
    mx += (l * (a.x + b.x)) / 2;
    my += (l * (a.y + b.y)) / 2;
  }
  mx /= mass;
  my /= mass;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [a, b] of segs) {
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    const cx = (a.x + b.x) / 2 - mx;
    const cy = (a.y + b.y) / 2 - my;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    // A rod's own second moment about its midpoint is l·d·dᵀ/12.
    sxx += l * (cx * cx + (dx * dx) / 12);
    syy += l * (cy * cy + (dy * dy) / 12);
    sxy += l * (cx * cy + (dx * dy) / 12);
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: { x: mx, y: my }, d: { x: Math.cos(theta), y: Math.sin(theta) } };
}

function intersect(l1: Line, l2: Line): Point | null {
  const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
  // Nearly parallel sides (under ~3°) give an unstable intersection.
  if (Math.abs(den) < 0.05) return null;
  const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
  return { x: l1.p.x + t * l1.d.x, y: l1.p.y + t * l1.d.y };
}

function hullSpan(hull: Point[]): [number, number] {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of hull) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return [x1 - x0, y1 - y0];
}
