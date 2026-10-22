// Ink-to-shape while drawing: a dwell timer runs while the pen is down; when the pen has held still
// (≤ 2 screen px since the dwell started) for `dwellMs`, the stroke so far is recognised and, on a
// match, snaps to a shape (the caller previews it and commits it on pen-up). With snap-on-release,
// a stroke lifted without a hold is recognised too. The highlighter never snaps.
import type { Element, PenPreset, Point, Settings } from "../model/types";
import { shapeElement, shapeFromDrag, shapeOutline } from "../shapes/geometry";
import { recognizeShape, type RecognizedShape } from "../shapes/recognize";
import type { Camera } from "./camera";

/** Pen movement (screen px) that restarts the dwell. */
export const DWELL_SLOP_PX = 2;
/** How long the snapped outline flashes on the interaction layer (ms). */
export const SNAP_FLASH_MS = 150;

export interface InkSnapOptions {
  dwellMs: number;
  snapsOnRelease: boolean;
  zoom: number;
  /** The stroke's processed points so far. */
  points(): readonly Point[];
  /** Called once when a hold snaps the stroke. */
  onSnap(shape: RecognizedShape): void;
}

export interface InkSnap {
  down(p: Point): void;
  move(p: Point): void;
  /** Pen-up: the shape to commit instead of the stroke, or null to commit the stroke. */
  up(): RecognizedShape | null;
  cancel(): void;
  snapped(): RecognizedShape | null;
}

/** Ink-to-shape applies to this ink type under these settings. */
export const inkSnapAllowed = (type: PenPreset["type"], cfg: Pick<Settings, "inkToShape">): boolean =>
  cfg.inkToShape && type !== "highlighter";

export function createInkSnap(opts: InkSnapOptions): InkSnap {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let anchor: Point | null = null;
  let result: RecognizedShape | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = (p: Point) => {
    clear();
    anchor = p;
    timer = setTimeout(() => {
      timer = null;
      const r = recognizeShape(opts.points());
      if (r) {
        result = r;
        opts.onSnap(r);
      }
    }, opts.dwellMs);
  };

  return {
    down: (p) => arm(p),
    move(p) {
      if (result || !anchor) return;
      if (Math.hypot(p.x - anchor.x, p.y - anchor.y) * opts.zoom > DWELL_SLOP_PX) arm(p);
    },
    up() {
      clear();
      if (!result && opts.snapsOnRelease) result = recognizeShape(opts.points());
      return result;
    },
    cancel() {
      clear();
      result = null;
    },
    snapped: () => result,
  };
}

/** The shape element for a recognised stroke: the stroke's colour and width, no fill. */
export function snapShapeElement(r: RecognizedShape, preset: Pick<PenPreset, "color" | "width">, pageId: string, id: string, now: string): Element {
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
  for (const poly of shapeOutline(r.type, r.rect, r.rotation)) {
    ctx.beginPath();
    poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  }
  ctx.restore();
}
