// Non-ink tool interaction on the canvas: eraser (cursor circle + drag), lasso (freehand polygon),
// selection drag-move and corner-handle scaling, click/double-click on boxed elements (select /
// open the editor), shape tool (drag a box, Shift constrains, live preview), text tool (click adds or
// edits a text box). Geometry is pure; `createToolController` wires it
// to the editor store and draws on the interaction (live) layer.
import type { Element, Settings } from "../model/types";
import type { EditorStore, TempTool, ToolId } from "../stores/editor";
import { shapeElement, shapeFromDrag, shapeHit, shapeStyleOf } from "../shapes/geometry";
import { polylineTouches } from "../tools/eraser";
import { lassoSelect, scaleElements, selectionBounds, translateElements } from "../tools/lasso";
import { elementBounds, isBoxed, type Rect, type SpatialIndex } from "../tools/spatialIndex";
import { renderOrder } from "../tools/zorder";
import { isPdfPlacement } from "../model/content";
import { worldToScreen, type Camera, type Vec2 } from "./camera";
import type { PointerInfo } from "./input";

export type Corner = "nw" | "ne" | "sw" | "se";
export type PointerTool = ToolId | "pan" | "none";

/** Corner handle half-size and hit slop (screen px). */
export const HANDLE_PX = 5;
const HIT_SLOP_PX = 8;
const MIN_SCALE = 0.05;
const LASSO_STEP_PX = 3;
/** A shape drag shorter than this (screen px) is a click and adds nothing. */
const MIN_SHAPE_DRAG_PX = 3;
/** Second click within this time (ms) and distance (screen px) on the same element is a double-click. */
export const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 8;

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

export function cornerPoint(b: Rect, c: Corner): Vec2 {
  return { x: c[1] === "w" ? b.x : b.x + b.width, y: c[0] === "n" ? b.y : b.y + b.height };
}

const OPPOSITE: Record<Corner, Corner> = { nw: "se", ne: "sw", sw: "ne", se: "nw" };

/** Corner handle under world point `p` (hit radius in screen px at zoom `z`). */
export function hitHandle(b: Rect, p: Vec2, z: number, slopPx = HIT_SLOP_PX): Corner | null {
  const r = slopPx / z;
  for (const c of CORNERS) {
    const q = cornerPoint(b, c);
    if (Math.abs(p.x - q.x) <= r && Math.abs(p.y - q.y) <= r) return c;
  }
  return null;
}

export const rectContains = (b: Rect, p: Vec2, pad = 0): boolean =>
  p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad;

/** Scale about the opposite corner so the dragged corner follows `p`; `uniform` keeps aspect. */
export function scaleFromDrag(b: Rect, corner: Corner, p: Vec2, uniform: boolean): { origin: Vec2; sx: number; sy: number } {
  const origin = cornerPoint(b, OPPOSITE[corner]);
  const start = cornerPoint(b, corner);
  const factor = (cur: number, s: number, o: number) => {
    if (s === o) return 1;
    const f = (cur - o) / (s - o);
    return Math.abs(f) < MIN_SCALE ? (f < 0 ? -MIN_SCALE : MIN_SCALE) : f;
  };
  let sx = factor(p.x, start.x, origin.x);
  let sy = factor(p.y, start.y, origin.y);
  if (uniform) sx = sy = Math.abs(sx) > Math.abs(sy) ? sx : sy;
  return { origin, sx, sy };
}

/** Topmost element under `p` (strokes by distance, shapes by outline or interior, others by bounds). */
export function hitTest(index: SpatialIndex, elements: ReadonlyMap<string, Element>, p: Vec2, tol: number): string | null {
  const ids = index.query({ x: p.x - tol, y: p.y - tol, width: 2 * tol, height: 2 * tol });
  const hits = renderOrder(ids.map((id) => elements.get(id)).filter((e): e is Element => !!e && !isPdfPlacement(e))).filter((el) =>
    el.type === "stroke"
      ? polylineTouches(el.points, p, el.width / 2 + tol)
      : el.type === "shape"
        ? shapeHit(el, p, tol)
        : rectContains(elementBounds(el), p, tol),
  );
  return hits.length > 0 ? hits[hits.length - 1].id : null;
}

export interface Tap {
  id: string;
  t: number;
  /** Screen px. */
  x: number;
  y: number;
}

/** True when `next` completes a double-click/tap started by `prev` (same element, quick, close). */
export const isDoubleTap = (prev: Tap | null, next: Tap): boolean =>
  !!prev && prev.id === next.id && next.t - prev.t <= DOUBLE_TAP_MS && Math.hypot(next.x - prev.x, next.y - prev.y) <= DOUBLE_TAP_PX;

/** The selection is a single boxed element: the DOM overlay (BoxFrame) frames it, not the canvas. */
export function framedByOverlay(elements: ReadonlyMap<string, Element>, selection: ReadonlySet<string>): boolean {
  if (selection.size !== 1) return false;
  const el = elements.get(selection.values().next().value!);
  return !!el && isBoxed(el);
}

/** Tool for a pointer-down: space/middle button pan, pen eraser end / barrel actions, else the tool. */
export function pointerTool(tool: ToolId, panHold: boolean, info: PointerInfo, cfg: Settings): { tool: PointerTool; temp: TempTool | null } {
  if (panHold || (info.buttons & 4) !== 0) return { tool: "pan", temp: null };
  const action = info.isEraserEnd ? cfg.penEraserButtonAction : info.isBarrel ? cfg.penBarrelButtonAction : null;
  if (action === null) return { tool, temp: null };
  const temp = (["eraser", "cursor", "lasso", "pan", "none"].includes(action) ? action : "none") as TempTool;
  return { tool: temp, temp };
}

type Gesture =
  | { kind: "idle" }
  | { kind: "erase"; last: Vec2 }
  | { kind: "lasso"; points: Vec2[] }
  | { kind: "shape"; start: Vec2; end: Vec2 }
  | { kind: "move"; start: Vec2; delta: Vec2; orig: Element[]; lifted: boolean }
  | { kind: "scale"; corner: Corner; bounds: Rect; orig: Element[]; t: { origin: Vec2; sx: number; sy: number } };

export interface ToolDeps {
  /** The editor instance (pane) this controller drives. */
  store: EditorStore;
  el: HTMLElement;
  requestLive(): void;
  /** Re-rasterise the static layer (the hidden set changed). */
  invalidate(): void;
  renderElement(ctx: CanvasRenderingContext2D, el: Element): void;
  getSettings(): Settings;
  /** Clock for double-click detection (ms; default performance.now). */
  now?(): number;
}

export function createToolController(deps: ToolDeps) {
  const st = deps.store.getState;
  /** Elements drawn on the live layer while being transformed (hidden from the snapshot). */
  const hidden = new Set<string>();
  let g: Gesture = { kind: "idle" };
  let preview: Element[] = [];
  let hover: Vec2 | null = null; // screen px
  let shift = false;
  let lastTap: Tap | null = null;
  const now = deps.now ?? (() => performance.now());

  /** Double-click on a boxed element opens its editor; returns true when it did. */
  const tapEdit = (p: Vec2): boolean => {
    const s = st();
    const id = hitTest(deps.store.spatialIndex(), s.elements, p, HIT_SLOP_PX / s.camera.z);
    const el = id ? s.elements.get(id) : undefined;
    if (!id || !el || !isBoxed(el)) {
      lastTap = null;
      return false;
    }
    const scr = worldToScreen(s.camera, p);
    const tap: Tap = { id, t: now(), x: scr.x, y: scr.y };
    if (isDoubleTap(lastTap, tap)) {
      lastTap = null;
      s.beginEdit(id);
      return true;
    }
    lastTap = tap;
    return false;
  };

  const lift = (els: Element[]) => {
    for (const e of els) hidden.add(e.id);
    deps.invalidate();
  };
  const drop = () => {
    preview = [];
    if (hidden.size === 0) return;
    hidden.clear();
    deps.invalidate();
  };

  /** The shape being dragged, as an element (for the live preview). */
  const shapePreview = (start: Vec2, end: Vec2): Element[] => {
    const style = shapeStyleOf(deps.getSettings());
    const drag = shapeFromDrag(style.shapeType, start, end, shift);
    return [shapeElement(style, drag, st().pageId ?? "", "shape-preview", "")];
  };

  const eraseAlong = (from: Vec2, to: Vec2) => {
    const s = st();
    const step = Math.max(0.5, deps.getSettings().defaultEraserWidth / 4 / s.camera.z);
    const n = Math.min(200, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
    for (let i = 1; i <= n; i++) st().eraser({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
  };

  const down = (p: Vec2, tool: PointerTool) => {
    const s = st();
    if (tool === "eraser") {
      g = { kind: "erase", last: p };
      s.eraser(p);
    } else if (tool === "shape") {
      g = { kind: "shape", start: p, end: p };
      preview = [];
    } else if (tool === "text") {
      // Text tool: a text box under the pointer opens for editing; empty canvas gets a new box.
      const hit = hitTest(deps.store.spatialIndex(), s.elements, p, HIT_SLOP_PX / s.camera.z);
      if (hit && s.elements.get(hit)?.type === "text-box") s.beginEdit(hit);
      else s.addTextBox(p);
      g = { kind: "idle" };
    } else if ((tool === "cursor" || tool === "lasso") && tapEdit(p)) {
      g = { kind: "idle" };
    } else if (tool === "cursor" || tool === "lasso") {
      const b = selectionBounds(s.elements, s.selection);
      const corner = b ? hitHandle(b, p, s.camera.z) : null;
      const orig = [...s.selection].map((id) => s.elements.get(id)!).filter(Boolean);
      if (b && corner) {
        g = { kind: "scale", corner, bounds: b, orig, t: { origin: p, sx: 1, sy: 1 } };
        preview = orig;
        lift(orig);
      } else if (b && rectContains(b, p, HIT_SLOP_PX / s.camera.z)) {
        g = { kind: "move", start: p, delta: { x: 0, y: 0 }, orig, lifted: false };
      } else {
        const hit = hitTest(deps.store.spatialIndex(), s.elements, p, HIT_SLOP_PX / s.camera.z);
        if (hit) {
          s.select([hit]);
          g = { kind: "move", start: p, delta: { x: 0, y: 0 }, orig: [st().elements.get(hit)!], lifted: false };
        } else {
          s.select([]);
          g = { kind: "lasso", points: [p] };
        }
      }
    }
    deps.requestLive();
  };

  const move = (points: Vec2[]) => {
    const p = points[points.length - 1];
    if (!p) return;
    const z = st().camera.z;
    switch (g.kind) {
      case "erase":
        for (const q of points) {
          eraseAlong(g.last, q);
          g.last = q;
        }
        break;
      case "lasso":
        for (const q of points) {
          const last = g.points[g.points.length - 1];
          if (Math.hypot(q.x - last.x, q.y - last.y) * z >= LASSO_STEP_PX) g.points.push(q);
        }
        break;
      case "shape":
        g.end = p;
        preview = shapePreview(g.start, g.end);
        break;
      case "move":
        g.delta = { x: p.x - g.start.x, y: p.y - g.start.y };
        if (!g.lifted && (g.delta.x !== 0 || g.delta.y !== 0)) {
          g.lifted = true;
          lift(g.orig);
        }
        preview = translateElements(g.orig, g.delta.x, g.delta.y);
        break;
      case "scale":
        g.t = scaleFromDrag(g.bounds, g.corner, p, shift);
        preview = scaleElements(g.orig, g.t.origin, g.t.sx, g.t.sy);
        break;
    }
    deps.requestLive();
  };

  const up = () => {
    const s = st();
    switch (g.kind) {
      case "erase":
        s.endEraser();
        break;
      case "shape": {
        drop();
        const style = shapeStyleOf(deps.getSettings());
        const drag = shapeFromDrag(style.shapeType, g.start, g.end, shift);
        if (Math.hypot(drag.boxWidth, drag.boxHeight) * s.camera.z >= MIN_SHAPE_DRAG_PX) s.addShape(style, drag);
        break;
      }
      case "lasso":
        if (g.points.length >= 3) s.select(lassoSelect(s.elements, deps.store.spatialIndex(), g.points));
        break;
      case "move":
        drop();
        s.moveSelection(g.delta.x, g.delta.y);
        break;
      case "scale":
        drop();
        s.scaleSelection(g.t.origin, g.t.sx, g.t.sy);
        break;
    }
    g = { kind: "idle" };
    deps.requestLive();
  };

  const cancel = () => {
    if (g.kind === "erase") st().endEraser();
    g = { kind: "idle" };
    drop();
    deps.requestLive();
  };

  /** Draw tool overlays on the live layer (cleared, device px). Returns true to animate. */
  const draw = (ctx: CanvasRenderingContext2D, c: Camera, dpr: number): boolean => {
    const s = st();
    if (preview.length > 0) {
      ctx.setTransform(dpr * c.z, 0, 0, dpr * c.z, dpr * c.x, dpr * c.y);
      for (const el of preview) deps.renderElement(ctx, el);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let animate = false;
    if (g.kind === "lasso" && g.points.length > 1) {
      ctx.save();
      ctx.beginPath();
      g.points.forEach((q, i) => {
        const v = worldToScreen(c, q);
        if (i === 0) ctx.moveTo(v.x, v.y);
        else ctx.lineTo(v.x, v.y);
      });
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#4a5d4e";
      ctx.stroke();
      ctx.restore();
    } else if (s.selection.size > 0 && !framedByOverlay(s.elements, s.selection)) {
      const b = selectionBounds(preview.length > 0 ? new Map(preview.map((e) => [e.id, e])) : s.elements, s.selection);
      if (b) {
        drawSelectionBounds(ctx, b, c);
        animate = true;
      }
    }
    if (hover && (s.tempTool ?? s.tool) === "eraser") {
      ctx.save();
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, deps.getSettings().defaultEraserWidth / 2, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    return animate;
  };

  const local = (e: PointerEvent): Vec2 => {
    const r = deps.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onHover = (e: PointerEvent) => {
    hover = local(e);
    const s = st();
    if ((s.tempTool ?? s.tool) === "eraser") deps.requestLive();
  };
  const onLeave = () => {
    hover = null;
    deps.requestLive();
  };
  const onKey = (e: KeyboardEvent) => {
    if (shift === e.shiftKey) return;
    shift = e.shiftKey;
    if (g.kind === "shape" && preview.length > 0) {
      preview = shapePreview(g.start, g.end);
      deps.requestLive();
    }
  };
  deps.el.addEventListener("pointermove", onHover);
  deps.el.addEventListener("pointerleave", onLeave);
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);

  return {
    hidden: hidden as ReadonlySet<string>,
    down,
    move,
    up,
    cancel,
    draw,
    dispose() {
      deps.el.removeEventListener("pointermove", onHover);
      deps.el.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    },
  };
}

/** Marching-ants rectangle plus corner handles, in screen space (ctx at dpr scale). */
export function drawSelectionBounds(ctx: CanvasRenderingContext2D, b: Rect, c: Camera): void {
  const a = worldToScreen(c, { x: b.x, y: b.y });
  const w = b.width * c.z;
  const h = b.height * c.z;
  const phase = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 60;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "#ffffff";
  ctx.lineDashOffset = -phase;
  ctx.strokeRect(a.x + 0.5, a.y + 0.5, w, h);
  ctx.strokeStyle = "#1a1d1b";
  ctx.lineDashOffset = -phase + 4;
  ctx.strokeRect(a.x + 0.5, a.y + 0.5, w, h);
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#4a5d4e";
  for (const k of CORNERS) {
    const q = cornerPoint({ x: a.x, y: a.y, width: w, height: h }, k);
    ctx.fillRect(q.x - HANDLE_PX, q.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2);
    ctx.strokeRect(q.x - HANDLE_PX + 0.5, q.y - HANDLE_PX + 0.5, HANDLE_PX * 2, HANDLE_PX * 2);
  }
  ctx.restore();
}
