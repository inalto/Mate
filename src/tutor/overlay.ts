// On-ink tutor markers, drawn on the interaction (live) canvas above the ink: a hand-drawn squiggle
// under a wrong group, a small tick to the right of a correct one, a turning ring while a group is
// being checked and a muted dash for a group that couldn't be checked. Ink is never hidden or
// replaced. Pure functions: `tutorMarkers` decides what to show, `drawTutorMarkers` paints it in
// screen space and `hitTutorMarker` finds the marker under a pointer.
import type { ThemeName } from "../ink/types";
import type { GroupBounds, Recognition, Settings } from "../model/types";
import { worldToScreen, type Camera, type Vec2 } from "../canvas/camera";

export type MarkerKind = "squiggle" | "tick" | "ring" | "unchecked";

export interface TutorMarker {
  groupId: string;
  kind: MarkerKind;
  /** The group's bounds, page units. */
  bounds: GroupBounds;
}

/** What `tutorMarkers` reads from a tutor view. */
export interface MarkerSource {
  recognitions: ReadonlyMap<string, Recognition>;
  inFlight: ReadonlySet<string>;
  unchecked: ReadonlyMap<string, unknown>;
  regions: ReadonlyMap<string, { bounds: GroupBounds }>;
}

export type MarkerSettings = Pick<Settings, "tutorUnderlineErrors" | "correctnessMode" | "tutorShowChecking">;

/** Marker size in page units at zoom 1, and its smallest / largest on-screen size (px). */
const MARKER_UNITS = 16;
const MARKER_MIN_PX = 12;
const MARKER_MAX_PX = 40;
/** Gap between the ink and a marker, page units at zoom 1 (at least this many px on screen). */
const GAP_UNITS = 6;
const GAP_MIN_PX = 4;
/** Extra hit area around a marker (screen px). */
const HIT_SLOP_PX = 8;
/** One full turn of the "checking" ring. */
const RING_PERIOD_MS = 1100;

/** Error, success and muted colours for the theme (#C62828 / dark #FF3B3B for errors). */
export function markerColors(theme: ThemeName | string): { error: string; success: string; muted: string } {
  const dark = theme === "dark" || theme === "high-contrast";
  return {
    error: dark ? "#FF3B3B" : "#C62828",
    success: theme === "high-contrast" ? "#7CE38B" : dark ? "#5FBF6A" : theme === "sepia" ? "#3F6B2E" : "#2E7D32",
    muted: dark ? "#8A8A93" : "#9A9AA3",
  };
}

/**
 * The markers to show, one per group at most. A group being checked shows the ring (when
 * `tutorShowChecking`); one that couldn't be checked shows the muted dash; otherwise its verdict:
 * squiggle when wrong (`tutorUnderlineErrors`), tick when right (`correctnessMode`, or always when
 * the user marked it correct). Incomplete or illegible verdicts show nothing.
 */
export function tutorMarkers(view: MarkerSource, s: MarkerSettings): TutorMarker[] {
  const out: TutorMarker[] = [];
  const seen = new Set<string>();
  const boundsOf = (id: string) => view.regions.get(id)?.bounds ?? view.recognitions.get(id)?.bounds;
  for (const id of view.inFlight) {
    const b = boundsOf(id);
    if (!b || !s.tutorShowChecking) continue;
    out.push({ groupId: id, kind: "ring", bounds: b });
    seen.add(id);
  }
  for (const id of view.unchecked.keys()) {
    const b = boundsOf(id);
    if (!b || seen.has(id) || view.inFlight.has(id)) continue;
    out.push({ groupId: id, kind: "unchecked", bounds: b });
    seen.add(id);
  }
  for (const [id, r] of view.recognitions) {
    if (seen.has(id) || r.illegible) continue;
    if (r.correct === false && s.tutorUnderlineErrors) out.push({ groupId: id, kind: "squiggle", bounds: r.bounds });
    else if (r.correct === true && (s.correctnessMode || r.userOverride)) out.push({ groupId: id, kind: "tick", bounds: r.bounds });
  }
  return out;
}

/** Marker size in page units at zoom `z`: scales with zoom, never below / above a screen size. */
export const markerUnits = (z: number): number => Math.min(MARKER_MAX_PX, Math.max(MARKER_MIN_PX, MARKER_UNITS * z)) / z;

const gapUnits = (z: number): number => Math.max(GAP_UNITS, GAP_MIN_PX / z);

/** Centre and radius (page units) of the tick / ring / dash: just right of the bounds, centred. */
export function markerAnchor(b: GroupBounds, z: number): { x: number; y: number; r: number } {
  const size = markerUnits(z);
  return { x: b.x + b.width + gapUnits(z) + size / 2, y: b.y + b.height / 2, r: size / 2 };
}

/** FNV-1a hash of the group id: the squiggle's seed. */
function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small deterministic PRNG in [0, 1). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The squiggle under `b`, in page units: a wave with a hand-drawn wobble seeded by the group id, so
 * it is identical on every frame (no jitter) and differs between groups.
 */
export function squigglePoints(groupId: string, b: GroupBounds, z: number): Vec2[] {
  const amp = Math.max(2.5, 2 / z);
  const wave = Math.max(10, 7 / z);
  const y0 = b.y + b.height + gapUnits(z) * 0.6 + amp;
  const halfWaves = Math.max(2, Math.round(b.width / (wave / 2)));
  const step = b.width / halfWaves;
  const rand = rng(seedOf(groupId));
  const pts: Vec2[] = [{ x: b.x, y: y0 + (rand() - 0.5) * amp * 0.4 }];
  for (let i = 1; i <= halfWaves; i++) {
    const dir = i % 2 === 1 ? 1 : -1;
    const a = amp * (0.7 + rand() * 0.6);
    pts.push({ x: b.x + step * (i - 0.5) + (rand() - 0.5) * step * 0.3, y: y0 + dir * a });
    pts.push({ x: b.x + step * i, y: y0 + (rand() - 0.5) * amp * 0.4 });
  }
  return pts;
}

/**
 * The marker under world point `p` (topmost first), or null. `slopPx` widens the hit area (screen
 * px): select tools use the default, the pen uses 0 (the marker's own area only).
 */
export function hitTutorMarker(markers: readonly TutorMarker[], p: Vec2, z: number, slopPx = HIT_SLOP_PX): TutorMarker | null {
  const slop = slopPx / z;
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];
    if (m.kind === "squiggle") {
      const pts = squigglePoints(m.groupId, m.bounds, z);
      const ys = pts.map((q) => q.y);
      const top = Math.min(...ys) - slop;
      const bottom = Math.max(...ys) + slop;
      if (p.x >= m.bounds.x - slop && p.x <= m.bounds.x + m.bounds.width + slop && p.y >= top && p.y <= bottom) return m;
    } else {
      const a = markerAnchor(m.bounds, z);
      if (Math.hypot(p.x - a.x, p.y - a.y) <= a.r + slop) return m;
    }
  }
  return null;
}

/** The parts of a 2D context the markers use (a real canvas context satisfies it). */
export type MarkerContext = Pick<
  CanvasRenderingContext2D,
  "save" | "restore" | "beginPath" | "moveTo" | "lineTo" | "quadraticCurveTo" | "arc" | "stroke" | "setTransform"
> & {
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
};

/**
 * Paint `markers` on the live layer (ctx is reset to dpr scale, screen px). Returns true while a
 * ring is turning, so the caller keeps requesting frames only then.
 */
export function drawTutorMarkers(ctx: MarkerContext, markers: readonly TutorMarker[], c: Camera, dpr: number, theme: ThemeName | string, now: number): boolean {
  if (markers.length === 0) return false;
  const col = markerColors(theme);
  let animate = false;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const m of markers) {
    const a = markerAnchor(m.bounds, c.z);
    const s = worldToScreen(c, { x: a.x, y: a.y });
    const r = a.r * c.z;
    ctx.beginPath();
    switch (m.kind) {
      case "squiggle": {
        const pts = squigglePoints(m.groupId, m.bounds, c.z).map((q) => worldToScreen(c, q));
        ctx.moveTo(pts[0].x, pts[0].y);
        // Peaks are control points: a smooth, hand-drawn wave.
        for (let i = 1; i + 1 < pts.length; i += 2) ctx.quadraticCurveTo(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
        ctx.lineWidth = Math.max(1.5, Math.min(3, 2 * c.z));
        ctx.strokeStyle = col.error;
        break;
      }
      case "tick":
        ctx.moveTo(s.x - r * 0.7, s.y + r * 0.05);
        ctx.lineTo(s.x - r * 0.2, s.y + r * 0.55);
        ctx.lineTo(s.x + r * 0.75, s.y - r * 0.6);
        ctx.lineWidth = Math.max(2, r * 0.28);
        ctx.strokeStyle = col.success;
        break;
      case "ring": {
        const start = ((now % RING_PERIOD_MS) / RING_PERIOD_MS) * Math.PI * 2;
        ctx.arc(s.x, s.y, r * 0.8, start, start + Math.PI * 1.4);
        ctx.lineWidth = Math.max(1.5, r * 0.2);
        ctx.strokeStyle = col.muted;
        animate = true;
        break;
      }
      case "unchecked":
        ctx.moveTo(s.x - r * 0.45, s.y);
        ctx.lineTo(s.x + r * 0.45, s.y);
        ctx.lineWidth = Math.max(2, r * 0.25);
        ctx.strokeStyle = col.muted;
        break;
    }
    ctx.stroke();
  }
  ctx.restore();
  return animate;
}

/** Hover label for a group that couldn't be checked (mouse only; a tap opens the card instead). */
export const UNCHECKED_TIP = "Couldn't check — tap to retry";

/** The parts of a 2D context the hover label uses. */
export type TipContext = Pick<
  CanvasRenderingContext2D,
  "save" | "restore" | "setTransform" | "fillRect" | "fillText" | "measureText"
> & {
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
};

const TIP_FONT_PX = 12;
const TIP_PAD_PX = 6;
const TIP_H_PX = 20;

/**
 * Draws the hover label next to an unchecked marker (screen space, to the right of the dash) and
 * returns the label's screen rectangle. Only `unchecked` markers have a label.
 */
export function drawTutorTip(ctx: TipContext, m: TutorMarker, c: Camera, dpr: number): { x: number; y: number; width: number; height: number } | null {
  if (m.kind !== "unchecked") return null;
  const a = markerAnchor(m.bounds, c.z);
  const s = worldToScreen(c, { x: a.x, y: a.y });
  const r = a.r * c.z;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `${TIP_FONT_PX}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const width = Math.ceil(ctx.measureText(UNCHECKED_TIP).width) + TIP_PAD_PX * 2;
  const rect = { x: s.x + r + TIP_PAD_PX, y: s.y - TIP_H_PX / 2, width, height: TIP_H_PX };
  ctx.fillStyle = "rgba(40, 40, 46, 0.92)";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillText(UNCHECKED_TIP, rect.x + TIP_PAD_PX, s.y);
  ctx.restore();
  return rect;
}
