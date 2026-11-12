// Ink-to-shape while drawing: a dwell timer runs while the pen is down; when the pen has held still
// (≤ 2 screen px since the dwell started, 8 px for a finger) for `dwellMs`, the stroke so far is
// recognised and, on a match, snaps to a shape (the caller previews it and commits it on pen-up).
// With snap-on-release, a stroke lifted without a hold is recognised too. The highlighter never
// snaps. A line or arrow lands on the horizontal / vertical when it is within a few degrees of it,
// and after a hold snapped it, its end follows the pen until it lifts. Any other shape (or curve)
// a hold snapped is then resized and turned by the pen, about its centre, until the pen lifts.
import type { Element, PenPreset, Point, Settings } from "../model/types";
import { shapeElement, shapeFromDrag, shapeOutline } from "../shapes/geometry";
import { snapLineEnd } from "../shapes/lineSnap";
import { recognizeShape, type RecognizedShape } from "../shapes/recognize";
import type { Camera } from "./camera";

/** Pen movement (screen px) that restarts the dwell. */
export const DWELL_SLOP_PX = 2;
/** Finger movement (screen px) that restarts the dwell: a held fingertip jitters more than a pen. */
export const TOUCH_DWELL_SLOP_PX = 8;
/** How long the snapped outline flashes on the interaction layer (ms). */
export const SNAP_FLASH_MS = 150;

export interface InkSnapOptions {
  dwellMs: number;
  snapsOnRelease: boolean;
  zoom: number;
  /** Movement (screen px) that restarts the dwell; default `DWELL_SLOP_PX`. */
  slopPx?: number;
  /** The stroke's processed points so far. */
  points(): readonly Point[];
  /** Called once when a hold snaps the stroke. */
  onSnap(shape: RecognizedShape): void;
  /** Called when the pen moves the end of a line or arrow it already snapped, or resizes / turns another snapped shape. */
  onAdjust?(shape: RecognizedShape): void;
}

export interface InkSnap {
  down(p: Point): void;
  move(p: Point): void;
  /** Pen-up: the shape to commit instead of the stroke, or null to commit the stroke. */
  up(): RecognizedShape | null;
  cancel(): void;
  snapped(): RecognizedShape | null;
}

/** Dwell slop for a pointer type: wider for touch. */
export const dwellSlopFor = (pointerType: string): number => (pointerType === "touch" ? TOUCH_DWELL_SLOP_PX : DWELL_SLOP_PX);

/** Ink-to-shape applies to this ink type under these settings (any pointer type, touch included). */
export const inkSnapAllowed = (type: PenPreset["type"], cfg: Pick<Settings, "inkToShape">): boolean =>
  cfg.inkToShape && type !== "highlighter";

const isLine = (r: RecognizedShape): boolean => !r.curve && (r.type === "line" || r.type === "arrow");

/** `r` with a line's end at `end` (default: where it is), snapped to the horizontal / vertical. */
export function withLineEnd(r: RecognizedShape, end?: { x: number; y: number }): RecognizedShape {
  if (!isLine(r)) return r;
  const start = { x: r.rect.x, y: r.rect.y };
  const to = snapLineEnd(start, end ?? { x: start.x + r.rect.width, y: start.y + r.rect.height });
  return { ...r, rect: { x: start.x, y: start.y, width: to.x - start.x, height: to.y - start.y } };
}

/** Pen travel (screen px) after a hold snapped a shape before it starts resizing / turning it. */
export const ADJUST_START_PX = 8;
/** Turns smaller than this are ignored, so a resize keeps the shape square to the page. */
export const ADJUST_ROTATE_DEAD = (4 * Math.PI) / 180;
const ADJUST_MIN_SCALE = 0.1;

/**
 * A snapped shape or curve (`base`) resized and turned about its centre by the pen: `grab` is where
 * the pen was when the hold snapped it, `p` where it is now. The pen's distance from the centre
 * sets the size, its direction the turn (after a small dead zone). Lines are not handled here.
 */
export function adjustSnapped(base: RecognizedShape, grab: { x: number; y: number }, p: { x: number; y: number }, zoom: number): RecognizedShape {
  if (Math.hypot(p.x - grab.x, p.y - grab.y) * zoom < ADJUST_START_PX) return base;
  let c: { x: number; y: number };
  if (base.curve) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const q of base.curve) {
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x);
      y1 = Math.max(y1, q.y);
    }
    c = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  } else c = { x: base.rect.x + base.rect.width / 2, y: base.rect.y + base.rect.height / 2 };
  const from = Math.hypot(grab.x - c.x, grab.y - c.y);
  if (from * zoom < 1) return base; // the pen sits on the centre: no direction to read
  const k = Math.max(ADJUST_MIN_SCALE, Math.hypot(p.x - c.x, p.y - c.y) / from);
  let turn = Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(grab.y - c.y, grab.x - c.x);
  if (turn > Math.PI) turn -= 2 * Math.PI;
  if (turn < -Math.PI) turn += 2 * Math.PI;
  turn = Math.abs(turn) <= ADJUST_ROTATE_DEAD ? 0 : turn - Math.sign(turn) * ADJUST_ROTATE_DEAD;
  if (base.curve) {
    const cos = Math.cos(turn) * k;
    const sin = Math.sin(turn) * k;
    const map = (q: { x: number; y: number }) => ({ x: c.x + (q.x - c.x) * cos - (q.y - c.y) * sin, y: c.y + (q.x - c.x) * sin + (q.y - c.y) * cos });
    const curve = base.curve.map(map);
    const a = curve[0];
    const b = curve[curve.length - 1];
    return { ...base, curve, rect: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y } };
  }
  const width = base.rect.width * k;
  const height = base.rect.height * k;
  return { ...base, rect: { x: c.x - width / 2, y: c.y - height / 2, width, height }, rotation: base.rotation + turn };
}

const recognize = (points: readonly Point[]): RecognizedShape | null => {
  const r = recognizeShape(points);
  return r ? withLineEnd(r) : null;
};

export function createInkSnap(opts: InkSnapOptions): InkSnap {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let anchor: Point | null = null;
  let result: RecognizedShape | null = null;
  /** What a hold snapped, and where the pen was then (the shape is resized / turned from these). */
  let held: { base: RecognizedShape; grab: Point } | null = null;
  const slop = opts.slopPx ?? DWELL_SLOP_PX;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = (p: Point) => {
    clear();
    anchor = p;
    timer = setTimeout(() => {
      timer = null;
      const r = recognize(opts.points());
      if (r) {
        result = r;
        held = anchor ? { base: r, grab: anchor } : null;
        opts.onSnap(r);
      }
    }, opts.dwellMs);
  };

  return {
    down: (p) => arm(p),
    move(p) {
      if (result) {
        // A snapped line's end follows the pen for as long as it stays down.
        if (isLine(result)) {
          result = withLineEnd(result, p);
          opts.onAdjust?.(result);
        } else if (held) {
          const next = adjustSnapped(held.base, held.grab, p, opts.zoom);
          if (next !== result) {
            result = next;
            opts.onAdjust?.(result);
          }
        }
        return;
      }
      if (!anchor) return;
      if (Math.hypot(p.x - anchor.x, p.y - anchor.y) * opts.zoom > slop) arm(p);
    },
    up() {
      clear();
      if (!result && opts.snapsOnRelease) result = recognize(opts.points());
      return result;
    },
    cancel() {
      clear();
      result = null;
      held = null;
    },
    snapped: () => result,
  };
}

/**
 * The element for a recognised stroke: a shape with the stroke's colour and width and no fill, or,
 * for a curve, an ink stroke along the fitted curve (even pressure, the preset's ink).
 */
export function snapShapeElement(
  r: RecognizedShape,
  preset: Pick<PenPreset, "color" | "width"> & Partial<Pick<PenPreset, "type">>,
  pageId: string,
  id: string,
  now: string,
): Element {
  if (r.curve) {
    return {
      id,
      pageId,
      type: "stroke",
      points: r.curve.map((p, i) => ({ x: p.x, y: p.y, pressure: 0.5, timestamp: i })),
      color: preset.color,
      width: preset.width,
      isHighlighter: false,
      penStyle: preset.type === "highlighter" || !preset.type ? "pen" : preset.type,
      content: { curve: true },
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
  }
  const { rect } = r;
  const drag = shapeFromDrag(r.type, { x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }, false);
  const el = shapeElement(
    { shapeType: r.type, color: preset.color, fillColor: "transparent", width: preset.width, fillOpacity: 1 },
    drag,
    pageId,
    id,
    now,
  );
  return r.rotation ? { ...el, content: { ...(el.content as object), rotation: r.rotation } } : el;
}

/** Flash the snapped shape's outline on the interaction layer (screen-px line, accent colour). */
export function drawSnapFlash(ctx: CanvasRenderingContext2D, r: RecognizedShape, camera: Camera, dpr: number, color: string): void {
  ctx.save();
  ctx.setTransform(dpr * camera.z, 0, 0, dpr * camera.z, dpr * camera.x, dpr * camera.y);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 6 / camera.z;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const poly of r.curve ? [r.curve] : shapeOutline(r.type, r.rect, r.rotation)) {
    ctx.beginPath();
    poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  }
  ctx.restore();
}
