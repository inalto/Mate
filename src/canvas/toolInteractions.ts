// Non-ink tool interaction on the canvas: eraser (cursor circle + drag), lasso (freehand polygon;
// clockwise = select what it encloses, drawn solid; anticlockwise = select what it touches, drawn
// dashed), selection drag-move (smart guides, grid snap, Shift axis lock, Alt+drag copies, Ctrl/Cmd
// suspends snapping), corner-handle scaling and the rotate handle, click/double-click on boxed
// elements (select / open the editor), shape tool (drag a box, Shift constrains, live preview),
// connector tool (drag between elements, ends bind to anchors, live preview), a lone selected
// connector's endpoint handles and label drag, double-click on a connector (label popover), text
// tool (click adds or edits a text box), auto-complete handle drags (a connector from a side of the
// selected element: a tap opens the auto-complete popover, a release on an element binds to it, a
// release in empty space adds a free-ended connector and opens the popover there), frame tool (drag
// a frame, then back to the cursor; a frame is hit only on its border band or title, a double-click
// on its title opens the rename popover). Geometry is pure; `createToolController` wires it
// to the editor store and draws on the interaction (live) layer.
import type { Element, Settings } from "../model/types";
import type { EditorStore, TempTool, ToolId } from "../stores/editor";
import { connectorHit, connectorRoute, DEFAULT_CONNECTOR_CAPS, labelPill } from "../connectors/geometry";
import { anchorPoint, anchors, nearestAnchor, SIDES } from "../connectors/anchors";
import { routeConnector } from "../connectors";
import { CONNECTOR_MODES, nearestT } from "../connectors/route";
import { openLabelPopover } from "../stores/labelPopover";
import { openAutoComplete } from "../stores/autoComplete";
import { FRAME_TITLE_BAND, frameTitleRect, isFrame, isNestedFrame, withFrameChildren } from "../frames/contain";
import { isClosedShape, shapeElement, shapeFromDrag, shapeHit, shapeStyleOf } from "../shapes/geometry";
import { polylineTouches } from "../tools/eraser";
import { lassoMode, lassoSelect, rotateElements, scaleElements, selectionBounds, translateElements } from "../tools/lasso";
import { boxRect, elementBounds, isBoxed, type Rect, type SpatialIndex } from "../tools/spatialIndex";
import { shiftBelow } from "../tools/insertSpace";
import { spaceShift } from "../stores/editor";
import { renderOrder } from "../tools/zorder";
import { contentOf, isAttachable, isLocked, isPdfPlacement, type ConnectorContent, type ConnectorEnd, type Side } from "../model/content";
import { equalSpacing, snapMove, type Guide } from "../tools/smartGuides";
import { screenToWorld, worldToScreen, type Camera, type Vec2 } from "./camera";
import type { PointerInfo } from "./input";
import { gridSpacingOf, snapDelta, snapPoint } from "./snap";

export type Corner = "nw" | "ne" | "sw" | "se";
export type PointerTool = ToolId | "pan" | "none";

/** Corner handle half-size and hit slop (screen px). */
export const HANDLE_PX = 5;
const HIT_SLOP_PX = 8;
const MIN_SCALE = 0.05;
const LASSO_STEP_PX = 3;
/** A shape drag shorter than this (screen px) is a click and adds nothing. */
const MIN_SHAPE_DRAG_PX = 3;
/** A selection move starts once the pointer has travelled this far (screen px); before that the delta stays zero (a tap, or a pen's pressure-only moves, never snaps an element). */
const MOVE_START_PX = 2;
/** Second click within this time (ms) and distance (screen px) on the same element is a double-click. */
export const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 8;
/** Rotate handle: distance above the selection's top-centre and drawn radius (screen px). */
export const ROTATE_OFFSET_PX = 24;
const ROTATE_R_PX = 6;
/** Shift snaps rotation to this step (15°). */
export const ROTATE_STEP = Math.PI / 12;
/** Smart guides snap within this distance (screen px). */
export const GUIDE_SNAP_PX = 8;
/** Smart guide colour (magenta). */
export const GUIDE_COLOR = "#e0218a";
/** A connector end snaps to an anchor within this distance (screen px). */
export const ANCHOR_SNAP_PX = 10;
/** Connector endpoint handle half-size (a 10 px square, screen px); its hit slop is HIT_SLOP_PX. */
export const ENDPOINT_HANDLE_PX = 5;
/** Anchor dot radius and the highlighted (snapped) one's (screen px). */
const ANCHOR_DOT_PX = 3;
const ANCHOR_HOT_PX = 5;
const ACCENT = "#4a5d4e";

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

/** World position of the rotate handle of bounds `b` at zoom `z`. */
export const rotateHandlePoint = (b: Rect, z: number): Vec2 => ({ x: b.x + b.width / 2, y: b.y - ROTATE_OFFSET_PX / z });

/** World point `p` is on the rotate handle of `b` (hit radius ≥ 8 screen px). */
export const hitRotateHandle = (b: Rect, p: Vec2, z: number): boolean => {
  const q = rotateHandlePoint(b, z);
  return Math.hypot(p.x - q.x, p.y - q.y) <= Math.max(HIT_SLOP_PX, ROTATE_R_PX + 4) / z;
};

/** `rad` rounded to the 15° step when `snap` is on. */
export const snapAngle = (rad: number, snap: boolean): number => (snap ? Math.round(rad / ROTATE_STEP) * ROTATE_STEP : rad);

/** Rotation in whole degrees, normalised to -179..180, for the angle badge. */
export const angleLabel = (rad: number): string => {
  let d = Math.round((rad * 180) / Math.PI) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return `${d}°`;
};

/**
 * Smart-guide candidates: the bounds of the elements intersecting the viewport expanded by 25 %
 * (page units), minus `exclude` (the moving ids), locked elements and PDF placements.
 */
export function guideCandidates(store: EditorStore, exclude: ReadonlySet<string>): Rect[] {
  const s = store.getState();
  const { camera: c, viewport: vp } = s;
  const w = vp.width / c.z;
  const h = vp.height / c.z;
  const view = { x: -c.x / c.z - w * 0.125, y: -c.y / c.z - h * 0.125, width: w * 1.25, height: h * 1.25 };
  const out: Rect[] = [];
  for (const id of store.spatialIndex().query(view)) {
    if (exclude.has(id)) continue;
    const el = s.elements.get(id);
    if (el && !isLocked(el) && !isPdfPlacement(el)) out.push(elementBounds(el));
  }
  return out;
}

/** The correction along `axis` that makes the gaps to both neighbours equal, or null. */
function equalGapCorrection(moving: Rect, others: readonly Rect[], threshold: number, axis: "x" | "y"): number | null {
  // Gaps along x are drawn as horizontal guides (axis "y") and vice versa.
  const gs = equalSpacing(moving, others, threshold).filter((g) => g.axis !== axis);
  if (gs.length < 2) return null;
  return (gs[1].to - gs[1].from - (gs[0].to - gs[0].from)) / 2;
}

/**
 * Snapped move delta for a selection with bounds `bounds` dragged by `raw`: per axis a smart-guide
 * match (edges/centres, then equal spacing) wins, else `grid(raw)` (the grid snap, or `raw`). `lock`
 * keeps one axis at 0 (Shift axis lock); that axis is never snapped.
 */
export function smartMoveDelta(
  bounds: Rect,
  raw: Vec2,
  others: readonly Rect[],
  threshold: number,
  grid: (d: Vec2) => Vec2,
  lock: "x" | "y" | null = null,
): { delta: Vec2; guides: Guide[] } {
  const g = grid(raw);
  const moving = { ...bounds, x: bounds.x + raw.x, y: bounds.y + raw.y };
  const r = snapMove(moving, others, threshold);
  const hitX = lock !== "x" && r.guides.some((q) => q.axis === "x");
  const hitY = lock !== "y" && r.guides.some((q) => q.axis === "y");
  let dx = lock === "x" ? 0 : hitX ? raw.x + r.dx : g.x;
  let dy = lock === "y" ? 0 : hitY ? raw.y + r.dy : g.y;
  const at = () => ({ ...bounds, x: bounds.x + dx, y: bounds.y + dy });
  if (!hitX && lock !== "x") {
    const c = equalGapCorrection({ ...at(), x: moving.x }, others, threshold, "x");
    if (c !== null) dx = raw.x + c;
  }
  if (!hitY && lock !== "y") {
    const c = equalGapCorrection({ ...at(), y: moving.y }, others, threshold, "y");
    if (c !== null) dy = raw.y + c;
  }
  const final = at();
  const guides = [...snapMove(final, others, 1e-6).guides, ...equalSpacing(final, others, 1e-6)];
  return { delta: { x: dx, y: dy }, guides };
}

/** Shift axis lock: the axis to hold at 0 (the smaller component of `d`). */
export const lockedAxis = (d: Vec2): "x" | "y" => (Math.abs(d.x) >= Math.abs(d.y) ? "y" : "x");

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

/** A frame's border band (8 screen px at `zoom`, i.e. `8 / zoom` page units) is hit. */
export const FRAME_BAND_PX = 8;

/** World point `p` on the title of frame `el` at `zoom` (never when the title is hidden). */
export function hitFrameTitle(el: Element, p: Vec2, zoom: number): boolean {
  const t = frameTitleRect(el, zoom, isNestedFrame(el));
  return t.width > 0 && rectContains(t, p, 2 / zoom);
}

/** Frame `el` is hit at `p`: on its border band (`tol` either side of the edge) or its title. Never inside. */
export function frameHit(el: Element, p: Vec2, tol: number, zoom: number): boolean {
  const r = boxRect(el);
  if (rectContains(r, p, tol) && !(r.width > 2 * tol && r.height > 2 * tol && rectContains({ x: r.x + tol, y: r.y + tol, width: r.width - 2 * tol, height: r.height - 2 * tol }, p))) return true;
  return hitFrameTitle(el, p, zoom);
}

/**
 * Topmost element under `p` (strokes by distance, shapes by outline or interior, connectors by
 * route or label pill, frames by their border band or title only, others by bounds). `zoom`
 * (default `HIT_SLOP_PX / tol`) sizes a frame's title.
 */
export function hitTest(index: SpatialIndex, elements: ReadonlyMap<string, Element>, p: Vec2, tol: number, zoom = HIT_SLOP_PX / tol): string | null {
  // Reaching down by the title's height finds frames whose title (above their rect) is under `p`.
  const reach = Math.max(FRAME_TITLE_BAND, FRAME_TITLE_BAND / Math.min(1, zoom));
  const ids = index.query({ x: p.x - tol, y: p.y - tol, width: 2 * tol, height: 2 * tol + reach });
  const hits = renderOrder(ids.map((id) => elements.get(id)).filter((e): e is Element => !!e && !isPdfPlacement(e))).filter((el) =>
    el.type === "stroke"
      ? polylineTouches(el.points, p, el.width / 2 + tol)
      : el.type === "shape"
        ? shapeHit(el, p, tol)
        : el.type === "connector"
          ? connectorHit(el, p, tol)
          : el.type === "frame"
            ? frameHit(el, p, tol, zoom)
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

/** The single selected element when it is a connector, else null. */
export function loneConnector(elements: ReadonlyMap<string, Element>, selection: ReadonlySet<string>): Element | null {
  if (selection.size !== 1) return null;
  const el = elements.get(selection.values().next().value!);
  return el && el.type === "connector" ? el : null;
}

/**
 * Topmost element a connector end may bind to under `p` (attachable, not locked, not a PDF
 * placement, not in `exclude`): shapes by outline or interior, others by bounds, within `tol`.
 */
export function attachableAt(index: SpatialIndex, elements: ReadonlyMap<string, Element>, p: Vec2, tol: number, exclude?: string): Element | null {
  const ids = index.query({ x: p.x - tol, y: p.y - tol, width: 2 * tol, height: 2 * tol });
  const hits = renderOrder(
    ids
      .map((id) => elements.get(id))
      .filter((e): e is Element => !!e && e.id !== exclude && isAttachable(e) && !isLocked(e) && !isPdfPlacement(e)),
  ).filter((el) =>
    el.type === "shape" ? shapeHit(el, p, tol) : el.type === "frame" ? frameHit(el, p, Math.max(tol, FRAME_BAND_PX / zoomOf(tol)), zoomOf(tol)) : rectContains(elementBounds(el), p, tol),
  );
  return hits.length > 0 ? hits[hits.length - 1] : null;
}

/** Zoom implied by a `ANCHOR_SNAP_PX / zoom` tolerance. */
const zoomOf = (tol: number): number => ANCHOR_SNAP_PX / tol;

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
  | { kind: "space"; lineY: number; dy: number; lifted: boolean }
  | { kind: "shape"; start: Vec2; end: Vec2 }
  | { kind: "frame"; start: Vec2; end: Vec2 }
  | {
      kind: "connector";
      /** The pointer-down point (the drag length is measured from it) and the source end's point. */
      press: Vec2;
      start: Vec2;
      source: ConnectorEnd | undefined;
      /** Where the free end is (the pointer), its binding, and the element under it. */
      end: Vec2;
      at: EndAt;
      /** Drawn from an auto-complete handle: from this side of this element. */
      auto?: { sourceId: string; side: Side };
    }
  | {
      kind: "endpoint";
      id: string;
      which: "source" | "target";
      orig: Element;
      /** The element the other end is bound to (this end never binds to it as well). */
      other: string | undefined;
      start: Vec2;
      end: Vec2;
      at: EndAt;
    }
  | { kind: "label"; id: string; orig: Element; text: string; t: number; start: Vec2; moved: boolean }
  | {
      kind: "move";
      start: Vec2;
      delta: Vec2;
      /** The unlocked elements being moved. */
      orig: Element[];
      lifted: boolean;
      anchor: Vec2 | null;
      started: boolean;
      /** Their bounds at the start, and the smart-guide candidates (read once, on the first move). */
      bounds: Rect | null;
      others: Rect[] | null;
      /** Alt held at the press: the selection is copied once the drag starts (an Alt+click copies nothing). */
      copy: boolean;
      /** The merge key joining that copy and the move into one "Duplicate" entry. */
      dupKey: string | null;
    }
  | { kind: "scale"; corner: Corner; bounds: Rect; orig: Element[]; t: { origin: Vec2; sx: number; sy: number } }
  | { kind: "rotate"; centre: Vec2; from: number; angle: number; orig: Element[] };

/** A connector end under the pointer: the element it would bind to (`end`), the snapped anchor. */
interface EndAt {
  over: Element | null;
  end: ConnectorEnd | undefined;
  snapped: Side | null;
  /** The end's point when free (grid-snapped when that is on). */
  point: Vec2;
}

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

/** Modifier keys an auto-complete handle copies from its own pointer events. */
export interface DragModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * The auto-complete drag API of a store's tool controller, driven by the handle itself (it captures
 * its own pointer, so no canvas routing applies): world points from the pane's camera.
 */
export interface AutoCompleteDriver {
  beginAutoComplete(p: Vec2, sourceId: string, side: Side): boolean;
  moveAutoComplete(p: Vec2, mods?: DragModifiers): void;
  endAutoComplete(p: Vec2, mods?: DragModifiers): void;
  cancelAutoComplete(): void;
}

const autoCompleteDrivers = new WeakMap<EditorStore, AutoCompleteDriver>();

/** The auto-complete drag API of the tool controller mounted for `store`, if any. */
export function autoCompleteDriverOf(store: EditorStore): AutoCompleteDriver | undefined {
  return autoCompleteDrivers.get(store);
}

export function createToolController(deps: ToolDeps) {
  const st = deps.store.getState;
  /** Elements drawn on the live layer while being transformed (hidden from the snapshot). */
  const hidden = new Set<string>();
  let g: Gesture = { kind: "idle" };
  let preview: Element[] = [];
  let hover: Vec2 | null = null; // screen px
  let shift = false;
  /** Ctrl/Cmd held: snapping is suspended. Alt held: a selection drag copies first. */
  let free = false;
  let alt = false;
  let dupCount = 0;
  let lastTap: Tap | null = null;
  const now = deps.now ?? (() => performance.now());

  /**
   * Double-click on a boxed element opens its editor, on a connector its label popover (never on a
   * locked one); returns true when it did.
   */
  const tapEdit = (p: Vec2): boolean => {
    const s = st();
    const id = hitTest(deps.store.spatialIndex(), s.elements, p, HIT_SLOP_PX / s.camera.z);
    const el = id ? s.elements.get(id) : undefined;
    // A frame opens on its title only (its border band just selects and moves it).
    const frameTitle = !!el && isFrame(el) && hitFrameTitle(el, p, s.camera.z);
    if (!id || !el || (isFrame(el) && !frameTitle) || !(isBoxed(el) || el.type === "connector" || (el.type === "shape" && isClosedShape(el.shapeType ?? "rectangle"))) || isLocked(el)) {
      lastTap = null;
      return false;
    }
    const scr = worldToScreen(s.camera, p);
    const tap: Tap = { id, t: now(), x: scr.x, y: scr.y };
    if (isDoubleTap(lastTap, tap)) {
      lastTap = null;
      if (el.type === "connector" || isFrame(el)) openLabelPopover(deps.store, id);
      else s.beginEdit(id);
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

  /** `p` on the page grid when settings.snapToGrid is on (read live), else `p`. */
  const snap = (p: Vec2): Vec2 => (deps.getSettings().snapToGrid ? snapPoint(p, gridSpacingOf(st().page)) : p);
  /**
   * The point a snapped move aligns to the grid: the minimum x/y over the moved elements' anchor
   * points (a shape's box corner, a box's origin, a stroke's leftmost/topmost sample), so a snapped
   * shape stays snapped when moved.
   */
  const anchorOf = (els: Element[]): Vec2 | null => {
    let x = Infinity;
    let y = Infinity;
    for (const e of els) for (const q of e.points) {
      x = Math.min(x, q.x);
      y = Math.min(y, q.y);
    }
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  };
  /** Move delta, snapped so the moved bounds' top-left lands on the grid when snapToGrid is on. */
  const moveDelta = (anchor: Vec2 | null, d: Vec2): Vec2 =>
    anchor && deps.getSettings().snapToGrid ? snapDelta(anchor, d, gridSpacingOf(st().page)) : d;

  /**
   * The unlocked selected elements (the ones a transform changes); with `children`, plus what the
   * selected frames contain (unlocked, no PDF placements), as moveSelection moves them.
   */
  const movable = (children = true): Element[] => {
    const s = st();
    const sel = [...s.selection].map((id) => s.elements.get(id)).filter((e): e is Element => !!e && !isLocked(e));
    if (!children || !sel.some(isFrame)) return sel;
    const ids = new Set(sel.map((e) => e.id));
    return withFrameChildren(sel, s.elements.values()).filter((e) => ids.has(e.id) || (!isLocked(e) && !isPdfPlacement(e)));
  };

  /** Start a selection move of the selected elements (Alt held: of fresh copies of them, made when the drag starts). */
  const startMove = (p: Vec2): Gesture => {
    const orig = movable();
    return { kind: "move", start: p, delta: { x: 0, y: 0 }, orig, lifted: false, anchor: anchorOf(orig), started: false, bounds: null, others: null, copy: alt, dupKey: null };
  };

  const clearGuides = () => st().setGuides([]);

  /** The shape being dragged, as an element (for the live preview). */
  const shapePreview = (start: Vec2, end: Vec2): Element[] => {
    const style = shapeStyleOf(deps.getSettings());
    const drag = shapeFromDrag(style.shapeType, start, end, shift);
    return [shapeElement(style, drag, st().pageId ?? "", "shape-preview", "")];
  };

  /** The frame being dragged from `start` to `end`, as an element (for the live preview). */
  const framePreview = (start: Vec2, end: Vec2): Element[] => [
    {
      id: "frame-preview",
      pageId: st().pageId ?? "",
      type: "frame",
      points: [{ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), pressure: 0.5, timestamp: 0 }],
      color: "#000000",
      width: 1,
      isHighlighter: false,
      boxWidth: Math.abs(end.x - start.x),
      boxHeight: Math.abs(end.y - start.y),
      content: { title: "", order: 0 },
      createdAt: "",
      updatedAt: "",
      version: 0,
    },
  ];

  /**
   * The connector end under world `p`, ignoring element `exclude`: bound to the attachable element
   * there (to the anchor within ANCHOR_SNAP_PX, else "auto"), else free at `p` (grid-snapped).
   */
  const endAt = (p: Vec2, exclude?: string): EndAt => {
    const s = st();
    const r = ANCHOR_SNAP_PX / s.camera.z;
    const over = attachableAt(deps.store.spatialIndex(), s.elements, p, r, exclude);
    if (!over) return { over: null, end: undefined, snapped: null, point: snap(p) };
    const near = nearestAnchor(over, p, r);
    return { over, end: { id: over.id, side: near?.side ?? "auto" }, snapped: near?.side ?? null, point: near?.point ?? p };
  };

  /** Connector tool style from the settings (read live). */
  const connectorStyle = () => {
    const cfg = deps.getSettings();
    const mode: ConnectorContent["mode"] = CONNECTOR_MODES.includes(cfg.defaultConnectorMode) ? cfg.defaultConnectorMode : "curve";
    const dash: "solid" | "dashed" = cfg.defaultConnectorDash === "dashed" ? "dashed" : "solid";
    return { mode, color: cfg.defaultConnectorColor, width: cfg.defaultConnectorWidth, dash };
  };

  /** Connector `el` rerouted against the page (the live preview). */
  const reroute = (el: Element): Element => {
    const els = st().elements;
    return routeConnector(el, (id) => els.get(id));
  };

  /** The connector being drawn from `start` (bound to `source`) to the end `at`, as an element. */
  const connectorPreview = (start: Vec2, source: ConnectorEnd | undefined, at: EndAt): Element[] => {
    const style = connectorStyle();
    const content: Partial<ConnectorContent> = {
      mode: style.mode,
      caps: { ...DEFAULT_CONNECTOR_CAPS },
      route: [],
      ...(style.dash === "dashed" ? { dash: "dashed" as const } : {}),
      ...(source ? { source } : {}),
      ...(at.end ? { target: at.end } : {}),
    };
    const draft: Element = {
      id: "connector-preview",
      pageId: st().pageId ?? "",
      type: "connector",
      points: [
        { x: start.x, y: start.y, pressure: 0.5, timestamp: 0 },
        { x: at.point.x, y: at.point.y, pressure: 0.5, timestamp: 1 },
      ],
      color: style.color,
      width: style.width,
      isHighlighter: false,
      content,
      createdAt: "",
      updatedAt: "",
      version: 0,
    };
    return [reroute(draft)];
  };

  /** Connector `el` with end `which` moved to `at` (bound or free), rerouted. */
  const withEnd = (el: Element, which: "source" | "target", at: EndAt): Element => {
    const content = { ...contentOf<ConnectorContent>(el) };
    if (at.end) content[which] = at.end;
    else delete content[which];
    const i = which === "source" ? 0 : 1;
    const points = el.points.map((q, k) => (k === i ? { ...q, x: at.point.x, y: at.point.y } : q));
    return reroute({ ...el, points, content });
  };

  /** Endpoint handle of the lone selected (unlocked) connector `el` under world `p`, or null. */
  const endpointAt = (el: Element, p: Vec2): "source" | "target" | null => {
    const r = Math.max(ENDPOINT_HANDLE_PX, HIT_SLOP_PX) / st().camera.z;
    const near = (q: Vec2 | undefined) => !!q && Math.abs(p.x - q.x) <= r && Math.abs(p.y - q.y) <= r;
    // The end drawn on top (the target) wins when both overlap.
    if (near(el.points[1])) return "target";
    if (near(el.points[0])) return "source";
    return null;
  };

  const eraseAlong = (from: Vec2, to: Vec2) => {
    const s = st();
    const step = Math.max(0.5, deps.getSettings().defaultEraserWidth / 4 / s.camera.z);
    const n = Math.min(200, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
    for (let i = 1; i <= n; i++) st().eraser({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
  };

  /** The lone selected connector when it may be edited (not locked), else null. */
  const editableLone = (): Element | null => {
    const s = st();
    const el = loneConnector(s.elements, s.selection);
    return el && !isLocked(el) ? el : null;
  };

  /** Pointer-down on an endpoint handle of the lone selected connector: start dragging that end. */
  const startEndpoint = (p: Vec2): boolean => {
    const el = editableLone();
    const which = el ? endpointAt(el, p) : null;
    if (!el || !which) return false;
    const ends = contentOf<ConnectorContent>(el);
    const other = (which === "source" ? ends.target : ends.source)?.id;
    const at: EndAt = { over: null, end: ends[which], snapped: null, point: p };
    g = { kind: "endpoint", id: el.id, which, orig: el, other, start: p, end: p, at };
    preview = [el];
    lift([el]);
    lastTap = null;
    return true;
  };

  /** Pointer-down on the label pill of the lone selected connector: start sliding the label. */
  const startLabel = (p: Vec2): boolean => {
    const el = editableLone();
    const pill = el ? labelPill(el) : null;
    const label = el ? contentOf<ConnectorContent>(el).label : undefined;
    if (!el || !pill || !label || !rectContains(pill, p, 2 / st().camera.z)) return false;
    g = { kind: "label", id: el.id, orig: el, text: label.text, t: label.t, start: p, moved: false };
    return true;
  };

  /**
   * Start a connector drag from `side` of element `sourceId` (an auto-complete handle was pressed);
   * false when the element is gone or locked.
   */
  const beginAutoComplete = (p: Vec2, sourceId: string, side: Side): boolean => {
    const src = st().elements.get(sourceId);
    if (!src || isLocked(src)) return false;
    const start = anchorPoint(src, side);
    const source: ConnectorEnd = { id: sourceId, side };
    g = { kind: "connector", press: p, start, source, end: p, at: { over: null, end: undefined, snapped: null, point: p }, auto: { sourceId, side } };
    preview = [];
    lastTap = null;
    return true;
  };

  /** Publish whether a drag is in progress (auto-complete handles hide meanwhile). */
  const setDragging = (on: boolean) => {
    if (st().dragging !== on) deps.store.setState({ dragging: on });
  };

  /**
   * A press at `p` moves the selection with bounds `b`: anywhere inside them, except when only frames
   * are selected, which move from their border band or title only (inside, the press reaches the content).
   */
  const onSelection = (b: Rect, p: Vec2): boolean => {
    const s = st();
    const tol = HIT_SLOP_PX / s.camera.z;
    const sel = [...s.selection].map((id) => s.elements.get(id)).filter((e): e is Element => !!e);
    if (sel.length === 0 || !sel.every(isFrame)) return rectContains(b, p, tol);
    return sel.some((f) => frameHit(f, p, tol, s.camera.z));
  };

  const down = (p: Vec2, tool: PointerTool) => {
    const s = st();
    if (tool === "eraser") {
      g = { kind: "erase", last: p };
      s.eraser(p);
    } else if (tool === "insert-space") {
      g = { kind: "space", lineY: p.y, dy: 0, lifted: false };
      preview = [];
    } else if (tool === "shape") {
      const q = snap(p);
      g = { kind: "shape", start: q, end: q };
      preview = [];
    } else if (tool === "frame") {
      const q = snap(p);
      g = { kind: "frame", start: q, end: q };
      preview = [];
    } else if (tool === "connector") {
      const at = endAt(p);
      g = { kind: "connector", press: p, start: at.point, source: at.end, end: p, at: { over: null, end: undefined, snapped: null, point: p } };
      preview = [];
    } else if (tool === "text") {
      // Text tool: a text box under the pointer opens for editing; empty canvas gets a new box.
      const hit = hitTest(deps.store.spatialIndex(), s.elements, p, HIT_SLOP_PX / s.camera.z);
      if (hit && s.elements.get(hit)?.type === "text-box") s.beginEdit(hit);
      else s.addTextBox(snap(p));
      g = { kind: "idle" };
    } else if ((tool === "cursor" || tool === "lasso") && startEndpoint(p)) {
      // A lone connector's endpoint handle: re-bind or free that end.
    } else if ((tool === "cursor" || tool === "lasso") && tapEdit(p)) {
      g = { kind: "idle" };
    } else if ((tool === "cursor" || tool === "lasso") && startLabel(p)) {
      // A lone connector's label pill: slide it along the route.
    } else if (tool === "cursor" || tool === "lasso") {
      const b = selectionBounds(s.elements, s.selection);
      // A lone connector has no bounds box: no corner or rotate handles, and only its route moves it.
      const lone = loneConnector(s.elements, s.selection);
      // Locked elements are never transformed: only the unlocked part of the selection moves.
      const orig = [...s.selection].map((id) => s.elements.get(id)).filter((e): e is Element => !!e && !isLocked(e));
      // A lone frame's handles are the overlay's (BoxFrame): its bounds also span the title, whose corner is no handle.
      const loneFrame = s.selection.size === 1 && orig.length === 1 && isFrame(orig[0]);
      const corner = b && orig.length > 0 && !lone && !loneFrame ? hitHandle(b, p, s.camera.z) : null;
      if (b && orig.length > 0 && !lone && !framedByOverlay(s.elements, s.selection) && hitRotateHandle(b, p, s.camera.z)) {
        const centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        g = { kind: "rotate", centre, from: Math.atan2(p.y - centre.y, p.x - centre.x), angle: 0, orig };
        preview = orig;
        lift(orig);
      } else if (b && corner) {
        g = { kind: "scale", corner, bounds: b, orig, t: { origin: p, sx: 1, sy: 1 } };
        preview = orig;
        lift(orig);
      } else if (b && (lone ? connectorHit(lone, p, HIT_SLOP_PX / s.camera.z) : onSelection(b, p))) {
        g = startMove(p);
      } else {
        const hit = hitTest(deps.store.spatialIndex(), s.elements, p, HIT_SLOP_PX / s.camera.z);
        if (hit) {
          s.select([hit]);
          g = startMove(p);
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
      case "space": {
        const s = st();
        g.dy = spaceShift(s, g.lineY, p.y - g.lineY);
        const all = [...s.elements.values()];
        const shifted = shiftBelow(all, g.lineY, g.dy, { cutImages: s.spaceCutImages });
        const moved = shifted.filter((e, i) => e !== all[i] && !isLocked(all[i])); // as insertSpace commits
        if (g.dy === 0) {
          // Back at the line: show the originals again (nothing is shifted).
          drop();
          g.lifted = false;
          break;
        }
        if (!g.lifted && moved.length > 0) {
          g.lifted = true;
          lift(moved);
        }
        preview = moved;
        break;
      }
      case "shape":
        g.end = snap(p);
        preview = shapePreview(g.start, g.end);
        break;
      case "frame":
        g.end = snap(p);
        preview = framePreview(g.start, g.end);
        break;
      case "connector":
        g.end = p;
        // Never back onto the element the connector starts from.
        g.at = endAt(p, g.source?.id);
        preview = connectorPreview(g.start, g.source, g.at);
        break;
      case "endpoint":
        g.end = p;
        g.at = endAt(p, g.other);
        preview = [withEnd(g.orig, g.which, g.at)];
        break;
      case "label": {
        if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) * z < MOVE_START_PX) break;
        if (!g.moved) lift([g.orig]);
        g.moved = true;
        g.t = nearestT(connectorRoute(g.orig), p);
        preview = [{ ...g.orig, content: { ...contentOf<ConnectorContent>(g.orig), label: { text: g.text, t: g.t } } }];
        break;
      }
      case "move": {
        const raw = { x: p.x - g.start.x, y: p.y - g.start.y };
        if (!g.started && Math.hypot(raw.x, raw.y) * z < MOVE_START_PX) break;
        if (!g.started && g.copy) {
          // Alt+drag: copy in place (copies come out unlocked and selected), then move the copies.
          const key = `alt-duplicate:${++dupCount}`;
          if (st().duplicateSelectionInPlace(key).length > 0) {
            g.dupKey = key;
            // The copies already include the frames' contents.
            g.orig = movable(false);
            g.anchor = anchorOf(g.orig);
          }
        }
        g.started = true;
        const lock = shift ? lockedAxis(raw) : null;
        const hold = (d: Vec2): Vec2 => (lock === "x" ? { x: 0, y: d.y } : lock === "y" ? { x: d.x, y: 0 } : d);
        const held = hold(raw);
        const anchor = g.anchor;
        const grid = (d: Vec2) => hold(moveDelta(anchor, d));
        if (free) {
          // Ctrl/Cmd held: no smart guides, no grid.
          g.delta = held;
          clearGuides();
        } else if (deps.getSettings().smartGuides && g.orig.length > 0) {
          g.bounds ??= selectionBounds(new Map(g.orig.map((e) => [e.id, e])), g.orig.map((e) => e.id));
          // The moving frames' contents are not guides either.
          g.others ??= guideCandidates(deps.store, new Set([...st().selection, ...g.orig.map((e) => e.id)]));
          if (g.bounds) {
            const r = smartMoveDelta(g.bounds, held, g.others, GUIDE_SNAP_PX / z, grid, lock);
            g.delta = r.delta;
            st().setGuides(r.guides);
          } else g.delta = grid(held);
        } else g.delta = grid(held);
        if (!g.lifted && (g.delta.x !== 0 || g.delta.y !== 0)) {
          g.lifted = true;
          lift(g.orig);
        }
        preview = translateElements(g.orig, g.delta.x, g.delta.y);
        break;
      }
      case "scale":
        g.t = scaleFromDrag(g.bounds, g.corner, p, shift);
        preview = scaleElements(g.orig, g.t.origin, g.t.sx, g.t.sy);
        break;
      case "rotate":
        g.angle = snapAngle(Math.atan2(p.y - g.centre.y, p.x - g.centre.x) - g.from, shift);
        preview = rotateElements(g.orig, g.centre, g.angle);
        break;
    }
    const k = g.kind;
    if ((k === "move" && g.started) || k === "scale" || k === "rotate" || k === "connector" || k === "endpoint") setDragging(true);
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
      case "space":
        drop();
        s.insertSpace(g.lineY, g.dy);
        break;
      case "frame": {
        drop();
        const w = Math.abs(g.end.x - g.start.x);
        const h = Math.abs(g.end.y - g.start.y);
        // One frame, then back to the cursor (addFrame switches the tool).
        if (Math.min(w, h) * s.camera.z >= MIN_SHAPE_DRAG_PX) s.addFrame({ x: Math.min(g.start.x, g.end.x), y: Math.min(g.start.y, g.end.y), width: w, height: h });
        break;
      }
      case "connector": {
        drop();
        const dragged = Math.hypot(g.end.x - g.press.x, g.end.y - g.press.y) * s.camera.z >= MIN_SHAPE_DRAG_PX;
        if (g.auto) autoCompleteUp(g.auto, g.start, g.end, g.at, dragged);
        else if (dragged) s.addConnector({ start: g.start, end: g.at.point, source: g.source, target: g.at.end, ...connectorStyle() });
        break;
      }
      case "endpoint":
        drop();
        // One "Connector end" entry on release; a tap on the handle changes nothing.
        if (Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) * s.camera.z >= MIN_SHAPE_DRAG_PX) {
          s.setConnectorEnd(g.id, g.which, g.at.end ?? null, g.at.point);
        }
        break;
      case "label":
        drop();
        if (g.moved) s.setConnectorLabel(g.id, { text: g.text, t: g.t });
        break;
      case "lasso":
        if (g.points.length >= 3) s.select(lassoSelect(s.elements, deps.store.spatialIndex(), g.points, lassoMode(g.points)));
        break;
      case "move":
        drop();
        clearGuides();
        s.moveSelection(g.delta.x, g.delta.y, g.dupKey ? { label: "Duplicate", mergeKey: g.dupKey, children: false } : undefined);
        break;
      case "scale":
        drop();
        s.scaleSelection(g.t.origin, g.t.sx, g.t.sy);
        break;
      case "rotate":
        drop();
        // One "Rotate" entry for the whole drag.
        s.rotateSelection(g.centre, g.angle);
        break;
    }
    g = { kind: "idle" };
    setDragging(false);
    deps.requestLive();
  };

  /**
   * Release of an auto-complete drag: a tap opens the popover next to the handle; on an element it
   * binds a connector to it; inside the source nothing happens; in empty space a free-ended
   * connector is added and the popover opens at the release point.
   */
  const autoCompleteUp = (auto: { sourceId: string; side: Side }, start: Vec2, end: Vec2, at: EndAt, dragged: boolean) => {
    const s = st();
    if (!dragged) {
      openAutoComplete(deps.store, auto.sourceId, auto.side);
      return;
    }
    const source: ConnectorEnd = { id: auto.sourceId, side: auto.side };
    if (at.end) {
      s.addConnector({ start, end: at.point, source, target: at.end, ...connectorStyle() });
      return;
    }
    const src = s.elements.get(auto.sourceId);
    if (!src || rectContains(elementBounds(src), end)) return;
    const id = s.autoCompleteConnector(auto.sourceId, auto.side, start, at.point);
    if (id) openAutoComplete(deps.store, auto.sourceId, auto.side, at.point, id);
  };

  const cancel = () => {
    if (g.kind === "erase") st().endEraser();
    // A cancelled Alt+drag takes its copies back.
    if (g.kind === "move" && g.dupKey) st().undo();
    g = { kind: "idle" };
    drop();
    clearGuides();
    setDragging(false);
    deps.requestLive();
  };

  /** Draw tool overlays on the live layer (cleared, device px). Returns true to animate. */
  const draw = (ctx: CanvasRenderingContext2D, c: Camera, dpr: number): boolean => {
    const s = st();
    if (preview.length > 0) {
      ctx.setTransform(dpr * c.z, 0, 0, dpr * c.z, dpr * c.x, dpr * c.y);
      if (g.kind === "space") ctx.globalAlpha = 0.55;
      for (const el of preview) deps.renderElement(ctx, el);
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let animate = false;
    if (g.kind === "space") {
      const y = Math.round(worldToScreen(c, { x: 0, y: g.lineY }).y) + 0.5;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(deps.el.clientWidth, y);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 5]);
      ctx.strokeStyle = "#4a5d4e";
      ctx.stroke();
      ctx.restore();
    } else if (g.kind === "lasso" && g.points.length > 1) {
      ctx.save();
      ctx.beginPath();
      g.points.forEach((q, i) => {
        const v = worldToScreen(c, q);
        if (i === 0) ctx.moveTo(v.x, v.y);
        else ctx.lineTo(v.x, v.y);
      });
      ctx.lineWidth = 1.5;
      // Dashed while the loop runs anticlockwise ("touch"), solid while clockwise ("inside").
      ctx.setLineDash(lassoMode(g.points) === "touch" ? [6, 4] : []);
      ctx.strokeStyle = "#4a5d4e";
      ctx.stroke();
      ctx.restore();
    } else if (s.selection.size > 0 && !framedByOverlay(s.elements, s.selection)) {
      // Preview elements replace their originals; locked ones stay where they are.
      const live = new Map(preview.map((e) => [e.id, e]));
      const sel = [...s.selection].map((id) => live.get(id) ?? s.elements.get(id)).filter((e): e is Element => !!e);
      const b = selectionBounds(new Map(sel.map((e) => [e.id, e])), s.selection);
      const lone = sel.length === 1 && sel[0].type === "connector" ? sel[0] : null;
      if (lone) {
        // A lone connector: its route is highlighted and its ends get handles (no bounds box).
        drawConnectorSelection(ctx, lone, c, !isLocked(lone));
      } else if (b) {
        const editable = sel.some((e) => !isLocked(e));
        const locks = sel.filter(isLocked).map(elementBounds);
        if (g.kind === "rotate") {
          // While rotating, the handle stays on the bounds the drag started from, with the angle badge.
          drawSelectionBounds(ctx, b, c, { handles: false, locks });
          drawRotateHandle(ctx, selectionBounds(s.elements, s.selection) ?? b, c, angleLabel(g.angle));
        } else drawSelectionBounds(ctx, b, c, { handles: editable, rotate: editable, locks });
        animate = true;
      }
    }
    // The anchors of the element a connector end is over (while drawing or dragging an end, and on hover with the tool).
    const at =
      g.kind === "connector" || g.kind === "endpoint"
        ? g.at
        : g.kind === "idle" && hover && (s.tempTool ?? s.tool) === "connector"
          ? endAt(screenToWorld(c, hover))
          : null;
    if (at?.over) drawAnchors(ctx, at.over, c, at.snapped);
    if (s.guides.length > 0) drawGuides(ctx, s.guides, c);
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
    const tool = s.tempTool ?? s.tool;
    if (tool === "eraser" || tool === "connector") deps.requestLive();
  };
  const onLeave = () => {
    hover = null;
    deps.requestLive();
  };
  /** Track Ctrl/Cmd and Alt (keyboard and pointer events both carry them). */
  const readMods = (e: KeyboardEvent | PointerEvent) => {
    free = e.ctrlKey || e.metaKey;
    alt = e.altKey;
  };
  /**
   * Escape drops a connector drag (drawing, an endpoint or the label) or a frame drag without changing
   * anything. Capture phase, and the key goes no further: the gesture is cancelled, the selection stays.
   */
  const onEscape = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !(g.kind === "connector" || g.kind === "endpoint" || g.kind === "label" || g.kind === "frame")) return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const onKey = (e: KeyboardEvent) => {
    readMods(e);
    if (shift === e.shiftKey) return;
    shift = e.shiftKey;
    if (g.kind === "shape" && preview.length > 0) {
      preview = shapePreview(g.start, g.end);
      deps.requestLive();
    }
  };
  // Capture phase: the modifiers are known before the pointer adapter starts a gesture.
  const onPointerMods = (e: PointerEvent) => readMods(e);
  deps.el.addEventListener("pointerdown", onPointerMods, true);
  deps.el.addEventListener("pointermove", onPointerMods, true);
  deps.el.addEventListener("pointermove", onHover);
  deps.el.addEventListener("pointerleave", onLeave);
  window.addEventListener("keydown", onEscape, true);
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);

  const autoDragging = () => g.kind === "connector" && !!g.auto;
  const copyMods = (m?: DragModifiers) => {
    if (!m) return;
    free = m.ctrlKey || m.metaKey;
    alt = m.altKey;
    shift = m.shiftKey;
  };
  const driver: AutoCompleteDriver = {
    beginAutoComplete: (p, sourceId, side) => {
      // Any gesture in progress is dropped first (the handle owns this pointer).
      if (g.kind !== "idle") cancel();
      const ok = beginAutoComplete(p, sourceId, side);
      deps.requestLive();
      return ok;
    },
    moveAutoComplete: (p, mods) => {
      if (!autoDragging()) return;
      copyMods(mods);
      move([p]);
    },
    endAutoComplete: (p, mods) => {
      if (!autoDragging()) return;
      copyMods(mods);
      move([p]);
      up();
    },
    cancelAutoComplete: () => {
      if (autoDragging()) cancel();
    },
  };
  autoCompleteDrivers.set(deps.store, driver);

  return {
    hidden: hidden as ReadonlySet<string>,
    down,
    move,
    up,
    cancel,
    draw,
    ...driver,
    dispose() {
      if (autoCompleteDrivers.get(deps.store) === driver) autoCompleteDrivers.delete(deps.store);
      deps.el.removeEventListener("pointerdown", onPointerMods, true);
      deps.el.removeEventListener("pointermove", onPointerMods, true);
      deps.el.removeEventListener("pointermove", onHover);
      deps.el.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    },
  };
}

export interface SelectionDrawOptions {
  /** Corner handles (default true; false when every selected element is locked). */
  handles?: boolean;
  /** The rotate handle above the top-centre (default false). */
  rotate?: boolean;
  /** Bounds of the selected locked elements: each gets a lock glyph at its top-right. */
  locks?: readonly Rect[];
}

/** Marching-ants rectangle plus corner handles, rotate handle and lock glyphs, in screen space (ctx at dpr scale). */
export function drawSelectionBounds(ctx: CanvasRenderingContext2D, b: Rect, c: Camera, opts: SelectionDrawOptions = {}): void {
  const { handles = true, rotate = false, locks = [] } = opts;
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
  if (handles)
    for (const k of CORNERS) {
      const q = cornerPoint({ x: a.x, y: a.y, width: w, height: h }, k);
      ctx.fillRect(q.x - HANDLE_PX, q.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2);
      ctx.strokeRect(q.x - HANDLE_PX + 0.5, q.y - HANDLE_PX + 0.5, HANDLE_PX * 2, HANDLE_PX * 2);
    }
  ctx.restore();
  if (rotate) drawRotateHandle(ctx, b, c, null);
  for (const r of locks) {
    const q = worldToScreen(c, { x: r.x + r.width, y: r.y });
    drawLockGlyph(ctx, q.x, q.y);
  }
}

/** A lone selected connector: its route traced in the accent colour and, when editable, a square handle at each end. */
export function drawConnectorSelection(ctx: CanvasRenderingContext2D, el: Element, c: Camera, handles: boolean): void {
  const route = connectorRoute(el).map((q) => worldToScreen(c, q));
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = ACCENT;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  route.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.fillStyle = "#ffffff";
  if (handles)
    for (const q of [route[0], route[route.length - 1]]) {
      if (!q) continue;
      ctx.fillRect(q.x - ENDPOINT_HANDLE_PX, q.y - ENDPOINT_HANDLE_PX, ENDPOINT_HANDLE_PX * 2, ENDPOINT_HANDLE_PX * 2);
      ctx.strokeRect(q.x - ENDPOINT_HANDLE_PX + 0.5, q.y - ENDPOINT_HANDLE_PX + 0.5, ENDPOINT_HANDLE_PX * 2, ENDPOINT_HANDLE_PX * 2);
    }
  ctx.restore();
  if (!handles) {
    const b = elementBounds(el);
    const q = worldToScreen(c, { x: b.x + b.width, y: b.y });
    drawLockGlyph(ctx, q.x, q.y);
  }
}

/** The four anchors of `el` as small dots, the `hot` one (the snapped anchor) larger and filled. */
export function drawAnchors(ctx: CanvasRenderingContext2D, el: Element, c: Camera, hot: Side | null): void {
  const a = anchors(el);
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = ACCENT;
  for (const side of SIDES) {
    const q = worldToScreen(c, a[side]);
    ctx.beginPath();
    ctx.arc(q.x, q.y, side === hot ? ANCHOR_HOT_PX : ANCHOR_DOT_PX, 0, Math.PI * 2);
    ctx.fillStyle = side === hot ? ACCENT : "#ffffff";
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** The rotate handle of bounds `b` (a stem and a round knob), with the angle badge while dragging. */
export function drawRotateHandle(ctx: CanvasRenderingContext2D, b: Rect, c: Camera, badge: string | null): void {
  const top = worldToScreen(c, { x: b.x + b.width / 2, y: b.y });
  const k = { x: top.x, y: top.y - ROTATE_OFFSET_PX };
  ctx.save();
  ctx.strokeStyle = "#4a5d4e";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(top.x + 0.5, top.y);
  ctx.lineTo(k.x + 0.5, k.y + ROTATE_R_PX);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(k.x, k.y, ROTATE_R_PX, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.stroke();
  if (badge) {
    ctx.font = "12px system-ui, sans-serif";
    const tw = ctx.measureText(badge).width;
    const bx = k.x + ROTATE_R_PX + 6;
    const by = k.y - 9;
    ctx.fillStyle = "rgba(26,29,27,0.85)";
    ctx.fillRect(bx, by, tw + 10, 18);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(badge, bx + 5, by + 9);
  }
  ctx.restore();
}

/** A small padlock just outside the top-right corner at screen (x, y). */
export function drawLockGlyph(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const left = x + 4;
  const top = y - 14;
  ctx.save();
  ctx.fillStyle = "#4a5d4e";
  ctx.strokeStyle = "#4a5d4e";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(left + 5, top + 4, 3, Math.PI, 0);
  ctx.stroke();
  ctx.fillRect(left, top + 4, 10, 8);
  ctx.restore();
}

/** Smart guides in magenta (1 screen px) with end ticks and, on equal-spacing guides, the gap label. */
export function drawGuides(ctx: CanvasRenderingContext2D, guides: readonly Guide[], c: Camera): void {
  const TICK = 3;
  ctx.save();
  ctx.strokeStyle = GUIDE_COLOR;
  ctx.fillStyle = GUIDE_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const gd of guides) {
    const a = worldToScreen(c, gd.axis === "x" ? { x: gd.at, y: gd.from } : { x: gd.from, y: gd.at });
    const e = worldToScreen(c, gd.axis === "x" ? { x: gd.at, y: gd.to } : { x: gd.to, y: gd.at });
    ctx.beginPath();
    if (gd.axis === "x") {
      const x = Math.round(a.x) + 0.5;
      ctx.moveTo(x, a.y);
      ctx.lineTo(x, e.y);
      ctx.moveTo(x - TICK, a.y);
      ctx.lineTo(x + TICK, a.y);
      ctx.moveTo(x - TICK, e.y);
      ctx.lineTo(x + TICK, e.y);
    } else {
      const y = Math.round(a.y) + 0.5;
      ctx.moveTo(a.x, y);
      ctx.lineTo(e.x, y);
      ctx.moveTo(a.x, y - TICK);
      ctx.lineTo(a.x, y + TICK);
      ctx.moveTo(e.x, y - TICK);
      ctx.lineTo(e.x, y + TICK);
    }
    ctx.stroke();
    if (gd.label) {
      const mx = (a.x + e.x) / 2;
      const my = (a.y + e.y) / 2;
      ctx.fillText(gd.label, gd.axis === "x" ? mx + 12 : mx, gd.axis === "x" ? my : my - 9);
    }
  }
  ctx.restore();
}

/** A quick tap: at most this long (ms) and this far (screen px) from where it started. */
export const TAP_MS = 300;
/** Hold the pen still on ink this long (ms) to ask the tutor about it. */
export const HOLD_ASK_MS = 600;
/** Moving further than this (screen px) turns a hold into a normal stroke. */
export const HOLD_SLOP_PX = 6;

/**
 * A pen press that closed the tutor card. Ink always wins: its stroke is drawn and committed like
 * any other; only a contact that ends as a bare tap (≤ TAP_MS, never further than HOLD_SLOP_PX
 * from where it started) is dropped, since that dot was only meant to close the card.
 */
export function createDismissPress(now: () => number = () => performance.now()) {
  let press: { t: number; at: Vec2; moved: boolean } | null = null;
  return {
    down(screen: Vec2): void {
      press = { t: now(), at: screen, moved: false };
    },
    /** True while the current contact is a dismissing press. */
    active: (): boolean => press !== null,
    move(screen: Vec2): void {
      if (press && Math.hypot(screen.x - press.at.x, screen.y - press.at.y) > HOLD_SLOP_PX) press.moved = true;
    },
    /** Pen up: "discard" only for a bare tap that closed the card, else "commit". */
    up(): TutorUp {
      const p = press;
      press = null;
      return p && !p.moved && now() - p.t <= TAP_MS ? "discard" : "commit";
    },
    cancel(): void {
      press = null;
    },
  };
}

export interface TutorGestureDeps {
  /** Consent given, tutor on and a key stored: otherwise every gesture is inert (plain ink). */
  active(): boolean;
  /** The group id of the tutor marker under world point `p`; `slopPx` widens the hit area. */
  markerAt(p: Vec2, slopPx?: number): string | null;
  /** Some ink (any element) lies within a few px of world point `p`. */
  inkAt(p: Vec2): boolean;
  /**
   * The id of a grouped ink element under world point `p`, ignoring `exclude` (dots this gesture
   * left on the page), or null when there is no grouped ink there.
   */
  inkUnder(p: Vec2, exclude: ReadonlySet<string>): string | null;
  /** Two ink elements belong to the same current stroke group (or are the same element). */
  sameGroup(a: string, b: string): boolean;
  openCard(groupId: string): void;
  /** Open Ask for the group of ink element `elementId`, first removing `dots` (one undo entry). */
  openAsk(elementId: string, dots: string[]): void;
  getSettings(): Settings;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
}

/** What to do with the pen contact that just ended. */
export type TutorUp = "commit" | "discard";

/** The first tap of a possible double-tap. */
interface InkTap {
  /** The ink element under the tap (not counting gesture dots). */
  under: string;
  t: number;
  x: number;
  y: number;
  /** The dot the tap left on the page, once committed. */
  dot: string | null;
}

/**
 * Tutor gestures. Ink always wins: every pen contact is committed at once like any stroke, except
 * - a quick tap on blank paper inside a marker's own area (tick, ring, dash, squiggle; no slop),
 *   which opens that group's card instead of leaving a dot;
 * - the second tap of a double-tap on a group's ink (`tutorDoubleTapAsk`): Ask opens, the second
 *   dot is not drawn and the first tap's dot is removed again (one undo entry), so the group keeps
 *   its original ink. Taps match by the ink under them (same element or same group), not by group
 *   id, since the first dot itself changes the group's membership for a moment;
 * - a pen held still on ink (`tutorHoldToAsk`) for 600 ms before drawing anything: the contact is
 *   cancelled (no ink yet, nothing existing is touched) and Ask opens.
 * A contact that moves is always a normal stroke. Select tools open a marker's card on pointer-up
 * when the pointer did not move (over ink only the marker's own area counts); a drag that starts
 * on a marker is a normal selection gesture. Nothing runs for pointers the input adapter rejected.
 */
export function createTutorGestures(deps: TutorGestureDeps) {
  const now = deps.now ?? (() => performance.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  /** The pen contact in progress. */
  let cur: { t: number; screen: Vec2; under: string | null; marker: string | null; moved: boolean } | null = null;
  let lastTap: InkTap | null = null;
  /** A select-tool press on a marker, decided on pointer-up. */
  let sel: { marker: string; screen: Vec2; moved: boolean } | null = null;
  let holdTimer: unknown;

  const stopHold = () => {
    if (holdTimer !== undefined) clearTimer(holdTimer);
    holdTimer = undefined;
  };
  const far = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) > HOLD_SLOP_PX;
  const gestureDots = (): ReadonlySet<string> => new Set(lastTap?.dot ? [lastTap.dot] : []);

  return {
    /** Select tools, pointer-down: true when it is on a marker (wait for up or a move). */
    selectDown(p: Vec2, screen: Vec2): boolean {
      sel = null;
      const marker = !deps.active() ? null : deps.inkAt(p) ? deps.markerAt(p, 0) : deps.markerAt(p);
      if (marker) sel = { marker, screen, moved: false };
      return !!marker;
    },

    /** Select tools: true once the press moved away; the caller then starts its normal gesture. */
    selectMove(screen: Vec2): boolean {
      if (!sel || sel.moved || !far(screen, sel.screen)) return false;
      sel.moved = true;
      return true;
    },

    /** Select tools, pointer-up: a press that never moved opens the marker's card. */
    selectUp(): void {
      const s = sel;
      sel = null;
      if (s && !s.moved) deps.openCard(s.marker);
    },

    /**
     * Pen down at world `p` / screen `screen`. `onHold` is called if the pen then stays still on a
     * group's ink for 600 ms: cancel the contact (Ask opens).
     */
    inkDown(p: Vec2, screen: Vec2, onHold: () => void): void {
      stopHold();
      cur = null;
      if (!deps.active()) return;
      const cfg = deps.getSettings();
      const under = cfg.tutorDoubleTapAsk || cfg.tutorHoldToAsk ? deps.inkUnder(p, gestureDots()) : null;
      const marker = deps.inkAt(p) ? null : deps.markerAt(p, 0);
      cur = { t: now(), screen, under, marker, moved: false };
      if (under && cfg.tutorHoldToAsk) {
        holdTimer = setTimer(() => {
          holdTimer = undefined;
          if (!cur || cur.moved || cur.under !== under) return;
          cur = null;
          lastTap = null;
          onHold();
          deps.openAsk(under, []);
        }, HOLD_ASK_MS);
      }
    },

    inkMove(screen: Vec2): void {
      if (!cur || cur.moved || !far(screen, cur.screen)) return;
      cur.moved = true;
      stopHold();
    },

    /**
     * Pen up: commit the stroke, or drop it (a marker tap or the second tap of a double-tap).
     * `strokeId` is the id the stroke gets when committed (remembered for a first tap's dot).
     */
    inkUp(strokeId?: string): TutorUp {
      stopHold();
      const c = cur;
      cur = null;
      if (!c) return "commit";
      const tap = !c.moved && now() - c.t <= TAP_MS;
      if (!tap) {
        lastTap = null;
        return "commit";
      }
      if (c.marker) {
        lastTap = null;
        deps.openCard(c.marker);
        return "discard";
      }
      if (c.under && deps.getSettings().tutorDoubleTapAsk) {
        const first = lastTap;
        const second = { id: "tap", t: c.t, x: c.screen.x, y: c.screen.y };
        if (first && isDoubleTap({ id: "tap", t: first.t, x: first.x, y: first.y }, second) && deps.sameGroup(first.under, c.under)) {
          lastTap = null;
          deps.openAsk(c.under, first.dot ? [first.dot] : []);
          return "discard";
        }
        lastTap = { under: c.under, t: c.t, x: c.screen.x, y: c.screen.y, dot: strokeId ?? null };
        return "commit";
      }
      lastTap = null;
      return "commit";
    },

    /** The contact was cancelled (pointercancel, page full, shape snap). */
    cancel(): void {
      stopHold();
      cur = null;
      sel = null;
    },

    dispose(): void {
      stopHold();
      cur = null;
      sel = null;
      lastTap = null;
    },
  };
}

export type TutorGestures = ReturnType<typeof createTutorGestures>;
