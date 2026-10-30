// Editor state for the single active page. Element mutations are persisted through elementsQueue.
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { loadElements } from "../ipc/elements";
import { elementsQueue } from "../ipc/elementsQueue";
import type { Element, Page, PenPreset } from "../model/types";
import { DEFAULT_SETTINGS, LIMITS, PAGE_GAP } from "../model/constants";
import {
  contentOf,
  isAttachable,
  effectiveCaps,
  isLocked,
  isPdfPlacement,
  type ConnectorContent,
  type ConnectorEnd,
  type LineCaps,
  type ShapeContent,
  type TableContent,
  type TextAttributes,
  type TextBoxContent,
} from "../model/content";
import { shapeElement, type ShapeDrag, type ShapeStyle } from "../shapes/geometry";
import { boundIds, connectorEnds, routeConnector } from "../connectors";
import { connectorCaps, connectorLabel, connectorMode, DEFAULT_CONNECTOR_CAPS, DEFAULT_CONNECTOR_MODE } from "../connectors/geometry";
import { alignToRuledLine, boxHeightFor, measureHtmlHeight, plainText } from "../text/measure";
import { sanitizeHtml, stripInlineStyle } from "../text/sanitize";
import { fitImage } from "../images/fit";
import { imageElement } from "../images/element";
import { MEDIA_DEFAULT_SIZE, mediaElement, type MediaKind } from "../media/element";
import { defaultGraphData, graphElement, inferGraphKind, presetFor } from "../graph/data";
import { lastGraphKind } from "../graph/presets";
import { clampRows, codespaceElement, MAX_TABLE_CELLS, tableCells, tableElement, tableRowsOf } from "../text/tableCode";
import { isMathBox, latexOf, mathElement } from "../math/mathBox";
import { normalizeLatex } from "../math/normalizeLatex";
import { defaultTextAttributes, sameText, textAttrsOf, textBoxElement } from "../text/textBox";
import { alignElements, distributeElements, type AlignMode, type DistributeAxis } from "../tools/align";
import { eraseAt } from "../tools/eraser";
import { clampShift, shiftBelow, type SpaceOptions } from "../tools/insertSpace";
import { History, type Action } from "../tools/history";
import { rotateElements, scaleElements, selectionBounds, translateElements } from "../tools/lasso";
import { elementBounds, isBoxed, SpatialIndex, withMeta, type Rect } from "../tools/spatialIndex";
import { reorder, topZ, zOf, type ZOp } from "../tools/zorder";
import type { ElementsChange } from "../tutor/types";
import type { Guide } from "../tools/smartGuides";
import {
  animateCamera,
  clampCamera,
  fitBounds,
  initialCamera,
  screenToWorld,
  sheetCountFor,
  sheetSize,
  stackBottom,
  type Camera,
  type SheetStack,
  type Vec2,
  type Viewport,
} from "../canvas/camera";
import { useNotebookStore } from "./notebook";
import { useSettingsStore } from "./settings";

export type ToolId = "pen" | "highlighter" | "fountain-pen" | "eraser" | "cursor" | "lasso" | "shape" | "connector" | "text" | "insert-space";
/** Pen button actions (settings.penBarrelButtonAction / penEraserButtonAction). */
export type TempTool = "eraser" | "cursor" | "lasso" | "pan" | "none";
export type InkType = PenPreset["type"];

export const INK_TYPES: readonly InkType[] = ["pen", "highlighter", "fountain-pen"];
export const isInkTool = (t: string): t is InkType => (INK_TYPES as readonly string[]).includes(t);
/** Offset applied by duplicate / paste (world units). */
export const DUPLICATE_OFFSET = 20;

export interface EditorState {
  pageId: string | null;
  page: Page | null;
  /** Page id whose elements are loaded (equals pageId once `loadPage` finished). */
  loadedPageId: string | null;
  /** Message of the last failed `loadPage`, else null. */
  loadError: string | null;
  elements: Map<string, Element>;
  tool: ToolId;
  /** Insert-space tool options: "Remove" only accepts upward drags; "Cut images" moves straddling boxes. */
  spaceMode: "insert" | "remove";
  spaceCutImages: boolean;
  preset: PenPreset;
  camera: Camera;
  viewport: Viewport;
  selection: Set<string>;
  /** Smart guides of the selection move/resize in progress (page units), drawn by the live layer. */
  guides: Guide[];
  /** Boxed element whose DOM editor is open (overlay layer), else null. */
  editingId: string | null;
  /** Largest element y (world units), for the page-mode sheet count. */
  contentBottom: number;
  /** Temporary tool while a pen button / eraser end is held. */
  tempTool: TempTool | null;
  /** Space held: pointer drags pan. */
  panHold: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** True after a change (or a pen-down) was refused because the page would exceed
   * LIMITS.MAX_ELEMENTS_PER_PAGE; cleared when the count drops below the limit or a page loads.
   * The editor route surfaces it as a toast (stores/pageLimit.ts). */
  limitReached: boolean;
  /** What limitReached refers to: the page item limit or a table cell limit. */
  limitKind: "page" | "table";
  loadPage(pageId: string): Promise<void>;
  /** Adopt an edited page record (mode, sheet size, background) without reloading elements. */
  refreshPage(page: Page): void;
  /** Pen-down: false (and `limitReached` set) when the page is full, so no stroke may start. */
  beginStroke(): boolean;
  addElement(el: Element): void;
  /** Add a shape drawn with the shape tool (one history entry); its id, or null when refused. */
  addShape(style: ShapeStyle, drag: ShapeDrag): string | null;
  /**
   * Ink to shape: commit `shape` in place of the uncommitted `stroke` as one history entry "Ink to
   * shape". Undo removes the shape and restores the original stroke; redo swaps them back.
   */
  replaceStrokeWithShape(stroke: Element, shape: Element): boolean;
  /**
   * Add a connector from `start` to `end` (one "Connector" entry), its ends bound to `source` /
   * `target` when given (ignored unless they name attachable elements), routed at once. Style
   * defaults: curve mode, the shape stroke colour, width 2, an arrow at the end. Its id, or null.
   */
  addConnector(input: {
    start: Vec2;
    end: Vec2;
    source?: ConnectorEnd;
    target?: ConnectorEnd;
    mode?: ConnectorContent["mode"];
    color?: string;
    width?: number;
    caps?: LineCaps;
    dash?: "solid" | "dashed";
  }): string | null;
  /**
   * Bind (`end`) or free (null) one end of connector `id`, optionally moving that end's point to
   * `point`, then reroute; one "Connector end" entry. False when nothing changed or it is locked.
   */
  setConnectorEnd(id: string, which: "source" | "target", end: ConnectorEnd | null, point?: Vec2): boolean;
  /** Restyle connector `id` (mode, caps, dash, colour, width) as one "Connector style" entry. */
  setConnectorProps(
    id: string,
    patch: Partial<Pick<ConnectorContent, "mode" | "caps" | "dash">> & { color?: string; width?: number },
  ): boolean;
  /** Set (empty text removes) or remove the label of connector `id`; one "Label" entry (moves of `t` merge). */
  setConnectorLabel(id: string, label: { text: string; t: number } | null): boolean;
  /** Set the end caps of line/arrow shape `id` as one "Line ends" entry; false when not applicable. */
  setLineCaps(id: string, caps: LineCaps): boolean;
  /** Scribble to erase: delete these elements as one history entry "Scribble erase". */
  scribbleErase(ids: string[]): void;
  updateElements(els: Element[]): void;
  /**
   * Text tool: add an empty text box at `at` (first baseline snapped to ruled lines when the
   * setting is on) and open its editor; its id, or null when refused.
   */
  addTextBox(at: Vec2): string | null;
  /** Insert an empty 3x3 table / code block at the viewport centre and edit it (one "Table"/"Code" entry). */
  addTable(): string | null;
  addCodespace(): string | null;
  /** Add an empty equation box centred in the viewport and start editing it. */
  addMathBox(): string | null;
  /** Insert a default graph (480×360, −10..10, one empty expression) at the viewport centre and edit it. */
  addGraph(): string | null;
  /**
   * Insert an image asset of `natural` pixel size at the viewport centre (or centred on `at`, in
   * page units), scaled to fit 80 % of the visible viewport; one history entry. Its id, or null.
   */
  addImage(assetId: string, natural: { width: number; height: number }, at?: Vec2): string | null;
  /**
   * Insert a media asset (audio or video player) at the viewport centre (or centred on `at`), with
   * `size` or the kind's default box, fitted like an image; one history entry "Media". Its id, or null.
   */
  addMedia(assetId: string, kind: MediaKind, size?: { width: number; height: number }, at?: Vec2, title?: string): string | null;
  /**
   * End of a text edit session: persist `after` (HTML sanitised, plain text derived) as one history
   * entry; nothing when unchanged. A new box's creation and first session are one entry; a box
   * left empty is removed (a new one without any history).
   */
  commitTextEdit(after: Element): void;
  /**
   * The open editor's commit, run once when its session ends (before the store moves on, so the
   * entry lands in order). Returns an unbind function.
   */
  bindEditSession(commit: () => void): () => void;
  /** Box-wide text formatting for the selected text boxes (replaces matching inline styles). */
  restyleTextBox(patch: Partial<TextAttributes>): void;
  /** Delete elements as one undo entry (`label` defaults to "Delete"). */
  removeElements(ids: string[], label?: string): void;
  /**
   * Add ready-made elements (already carrying this page's id) as ONE history entry `label`;
   * refused (false, `limitReached` set) when the page would pass the element limit.
   */
  addElements(label: string, els: Element[]): boolean;
  setTool(tool: ToolId): void;
  setPreset(preset: PenPreset): void;
  setCamera(camera: Camera): void;
  setViewport(viewport: Viewport): void;
  /** Publish the smart guides of the drag in progress ([] clears them). */
  setGuides(guides: Guide[]): void;
  resetCamera(): void;
  /**
   * Animate the camera to show the page: canvas mode all elements (reset when empty), page mode the
   * sheet at the viewport centre; 48 px margin.
   */
  fitPage(): void;
  /** Animate the camera to the selection bounds (48 px margin); nothing when the selection is empty. */
  fitSelection(): void;
  pushTempTool(tool: TempTool): void;
  popTempTool(): void;
  setPanHold(held: boolean): void;
  /** Erase at a world point with the settings' eraser; one drag is one history entry (endEraser). */
  eraser(center: Vec2): void;
  endEraser(): void;
  /** Select only `id` and open its editor; ignored unless it is a loaded boxed element. */
  beginEdit(id: string): void;
  endEdit(): void;
  /** Selecting anything that excludes the edited element closes its editor. */
  select(ids: Iterable<string>): void;
  selectAll(): void;
  /**
   * Move the unlocked selected elements; one "Move" entry. `opts` renames the entry and merges it
   * with the newest entry of the same key (an Alt+drag copy and its move are one "Duplicate").
   */
  moveSelection(dx: number, dy: number, opts?: { label?: string; mergeKey?: string }): void;
  setSpaceOptions(patch: { spaceMode?: "insert" | "remove"; spaceCutImages?: boolean }): void;
  /** Insert-space tool: shift everything below `lineY` by `dy` (clamped); one "Insert space" entry, none when it is 0. */
  insertSpace(lineY: number, dy: number): void;
  /** Align (>= 2 selected) or distribute (>= 3 selected) the selection; one history entry each. */
  alignSelection(mode: AlignMode): void;
  distributeSelection(axis: DistributeAxis): void;
  /** Tag >= 2 selected elements with one `uiGroupId` / clear it from the selection; one history entry each. */
  groupSelection(): void;
  ungroupSelection(): void;
  /** Add a graph below the single selected equation, plotting its LaTeX; one "Graph" entry. */
  graphFromSelectedEquation(): string | null;
  scaleSelection(origin: Vec2, sx: number, sy: number): void;
  /** Rotate the selection by `rad` about `centre`; one "Rotate" entry (locked elements skipped). */
  rotateSelection(centre: Vec2, rad: number): void;
  /** Lock the selected elements (`content.locked`); one "Lock" entry. */
  lockSelection(): void;
  /** Unlock the selected locked elements; one "Unlock" entry. */
  unlockSelection(): void;
  /** Stroke colour applies to all; width to strokes and shapes; fill colour to shapes only. */
  restyleSelection(patch: { color?: string; width?: number; fillColor?: string }): void;
  deleteSelection(): void;
  duplicateSelection(): void;
  /**
   * Duplicate the selection with zero offset (Alt+drag) and select the copies; their ids ([] when
   * refused). `mergeKey` lets the following move join the same "Duplicate" entry.
   */
  duplicateSelectionInPlace(mergeKey?: string): string[];
  /** Copies are unlocked. */
  copySelection(): void;
  cutSelection(): void;
  paste(): void;
  undo(): void;
  redo(): void;
  bringForward(): void;
  sendBackward(): void;
  toFront(): void;
  toBack(): void;
  /** Select the preset in toolbar slot `slot` (1-based). */
  selectSlot(slot: number): void;
  /** Switch to an ink tool, keeping the current preset when it has that type. */
  selectInk(type: InkType): void;
  addPreset(type: InkType): void;
  removePreset(id: string): void;
  movePreset(id: string, dir: -1 | 1): void;
  updatePreset(preset: PenPreset): void;
}

const maxY = (el: Element): number => {
  if (isBoxed(el) || el.type === "shape" || el.type === "connector") {
    const b = elementBounds(el);
    return b.y + b.height;
  }
  let m = -Infinity;
  for (const p of el.points) if (p.y > m) m = p.y;
  return m + el.width / 2;
};
const bottomOf = (els: Iterable<Element>): number => {
  let m = 0;
  for (const el of els) m = Math.max(m, maxY(el));
  return m;
};

/** Sheet stack for the current state (page mode). */
export function sheetStack(s: Pick<EditorState, "page" | "contentBottom">): SheetStack {
  const aspect = useSettingsStore.getState().settings.defaultPageAspectRatio;
  const size = s.page ? sheetSize(s.page, aspect) : sheetSize(fallbackPage("", "canvas"), aspect);
  return { ...size, count: sheetCountFor(s.contentBottom, size.height) };
}

/** Options for the insert-space helpers; page mode caps insertion at the stack bottom plus one sheet. */
function spaceOptions(s: EditorState): SpaceOptions {
  const cutImages = s.spaceCutImages;
  if (s.page?.mode !== "page") return { cutImages };
  const stack = sheetStack(s);
  return { cutImages, maxBottom: stackBottom(stack) + PAGE_GAP + stack.height };
}

/** The shift the insert-space tool really applies for a drag of `dy` (mode and bounds respected). */
export function spaceShift(s: EditorState, lineY: number, dy: number): number {
  const d = s.spaceMode === "remove" ? Math.min(dy, 0) : dy;
  const out = clampShift([...s.elements.values()], lineY, d, spaceOptions(s));
  return out === 0 ? 0 : out;
}

/** Clamp a camera to the current page bounds (no overscroll). */
export function clampToPage(c: Camera, s: EditorState): Camera {
  if (!s.page) return c;
  return clampCamera(c, s.page, s.viewport, sheetStack(s));
}

/** Page used when the notebook tree has no record for the id (e.g. a stale link). */
function fallbackPage(id: string, mode: Page["mode"]): Page {
  const stamp = new Date(0).toISOString();
  return {
    id,
    sectionId: "",
    title: "",
    isExpanded: true,
    isFavourite: false,
    depth: 0,
    mode,
    backgroundConfig: { type: "blank", spacing: 40, dotRadius: 1.5 },
    thumbnailVersion: 0,
    orderIndex: 0,
    createdAt: stamp,
    updatedAt: stamp,
    version: 0,
  };
}

/** Resolve the page from the notebook tree, waiting for the tree to load if necessary. */
async function findPage(pageId: string): Promise<Page | null> {
  const nb = useNotebookStore;
  if (!nb.getState().loaded) {
    await new Promise<void>((resolve) => {
      const unsub = nb.subscribe((s) => {
        if (s.loaded) {
          unsub();
          resolve();
        }
      });
      if (nb.getState().loaded) {
        unsub();
        resolve();
      }
    });
  }
  return nb.getState().tree.pages.find((p) => p.id === pageId) ?? null;
}

const defaultPreset = (): PenPreset =>
  useSettingsStore.getState().settings.toolbarPresets[0] ?? DEFAULT_SETTINGS.toolbarPresets[0];

// Shared by all editor instances, so copy in one pane can paste into the other.
let clipboard: Element[] = [];
let pasteCount = 0;

const stamp = (el: Element, now = new Date().toISOString()): Element => ({ ...el, updatedAt: now });

/** `el` without `content.locked` (the same object when it is not locked). */
function unlocked(el: Element): Element {
  if (!isLocked(el)) return el;
  const content = { ...(el.content as Record<string, unknown>) };
  delete content.locked;
  return { ...el, content };
}

/** Append to the erase batch; a delete of an element added earlier in the batch cancels both. */
function appendCompact(batch: Action[], actions: Action[]): void {
  for (const a of actions) {
    if (a.type === "delete") {
      const i = batch.findIndex((b) => b.type === "add" && b.el.id === a.el.id);
      if (i >= 0) {
        batch.splice(i, 1);
        continue;
      }
    }
    batch.push(a);
  }
}

const persistPresets = (toolbarPresets: PenPreset[]) => {
  useSettingsStore
    .getState()
    .update({ toolbarPresets })
    .catch((err) => console.error("saving toolbar presets failed", err));
};
const presets = () => useSettingsStore.getState().settings.toolbarPresets;
const isPenType = (p: PenPreset) => p.type === "pen" || p.type === "fountain-pen";

/** One editor instance: the active page's elements, tools and camera. Split view uses two. */
export type EditorStore = UseBoundStore<StoreApi<EditorState>> & {
  /** Spatial index over the loaded page's elements (kept in sync by the store). */
  spatialIndex(): SpatialIndex;
  /** Subscribe to element mutations (one call per applied batch); returns the unsubscribe. */
  onElementsChanged(cb: (change: ElementsChange) => void): () => void;
};

export function createEditorStore(): EditorStore {
  let loadToken = 0;
  // Page-scoped helpers (reset by loadPage).
  const history = new History();
  const index = new SpatialIndex();
  /** Connector ids bound to each element id, and the element ids each connector is bound to. */
  const bindings = new Map<string, Set<string>>();
  const boundTo = new Map<string, string[]>();
  const changeListeners = new Set<(change: ElementsChange) => void>();
  /** Actions of the eraser drag in progress (pushed as one entry by endEraser). */
  let eraseBatch: Action[] = [];
  /** Text box added by addTextBox whose first edit session is still open. */
  let freshText: string | null = null;
  /** Commit of the open edit session (bindEditSession). */
  let editCommit: (() => void) | null = null;
  const textKey = (id: string) => `text-new:${id}`;
  /** Run the open editor's commit (once) before the edit session ends. */
  const closeEdit = () => {
    const fn = editCommit;
    editCommit = null;
    fn?.();
  };

  const store = create<EditorState>((set, get) => ({
    pageId: null,
    page: null,
    loadedPageId: null,
    loadError: null,
    elements: new Map(),
    tool: "pen",
    spaceMode: "insert",
    spaceCutImages: false,
    preset: DEFAULT_SETTINGS.toolbarPresets[0],
    camera: { x: 0, y: 0, z: 1 },
    viewport: { width: 0, height: 0 },
    selection: new Set(),
    guides: [],
    editingId: null,
    contentBottom: 0,
    tempTool: null,
    panHold: false,
    canUndo: false,
    canRedo: false,
    limitReached: false,
    limitKind: "page",

    async loadPage(pageId) {
      closeEdit();
      freshText = null;
      const token = ++loadToken;
      const preset = defaultPreset();
      history.clear();
      index.clear();
      clearBindings();
      eraseBatch = [];
      set({
        canUndo: false,
        canRedo: false,
        tempTool: null,
        pageId,
        loadedPageId: null,
        loadError: null,
        elements: new Map(),
        selection: new Set(),
        guides: [],
        editingId: null,
        contentBottom: 0,
        limitReached: false,
        preset,
        tool: preset.type,
      });
      let page: Page | null;
      let els: Element[];
      try {
        // Let pending writes (e.g. from the other pane that just showed this page) land first.
        [page, els] = await Promise.all([findPage(pageId), elementsQueue.flushAll().then(() => loadElements(pageId))]);
      } catch (err) {
        console.error("loading page elements failed", err);
        if (token === loadToken) set({ loadError: String(err) });
        return;
      }
      if (token !== loadToken) return;
      const resolved = page ?? fallbackPage(pageId, "canvas");
      const elements = new Map(els.map((e) => [e.id, e]));
      for (const e of els) {
        index.insert(e.id, elementBounds(e));
        bind(e);
      }
      const contentBottom = bottomOf(elements.values());
      const vp = get().viewport;
      const viewport = vp.width > 0 ? vp : { width: 1280, height: 800 };
      const stack = sheetStack({ page: resolved, contentBottom });
      set({
        page: resolved,
        elements,
        contentBottom,
        camera: clampCamera(initialCamera(resolved, viewport, stack), resolved, viewport, stack),
        loadedPageId: pageId,
      });
    },

    refreshPage(page) {
      const cur = get().page;
      if (!cur || cur.id !== page.id) return;
      const layout = (p: Page) => JSON.stringify([p.mode, p.pageWidth, p.pageHeight, p.backgroundConfig]);
      if (layout(cur) === layout(page)) return;
      set({ page });
      if (cur.mode !== page.mode || cur.pageWidth !== page.pageWidth || cur.pageHeight !== page.pageHeight) get().resetCamera();
    },

    beginStroke() {
      if (get().elements.size < LIMITS.MAX_ELEMENTS_PER_PAGE) return true;
      if (!get().limitReached) set({ limitReached: true, limitKind: "page" });
      return false;
    },

    addElement(el) {
      // New elements go on top: inherit the highest zIndex in use (ties render by createdAt).
      const top = topZ(get().elements.values());
      record("Draw", [{ type: "add", el: top > 0 && zOf(el) < top ? withMeta(el, { zIndex: top }) : el }]);
    },

    addShape(style, drag) {
      const pageId = get().pageId;
      if (!pageId) return null;
      const top = topZ(get().elements.values());
      const shape = shapeElement(style, drag, pageId, crypto.randomUUID(), new Date().toISOString());
      const el = top > 0 ? withMeta(shape, { zIndex: top }) : shape;
      return record("Shape", [{ type: "add", el }]) ? el.id : null;
    },

    replaceStrokeWithShape(stroke, shape) {
      const top = topZ(get().elements.values());
      const onTop = (el: Element) => (top > 0 && zOf(el) < top ? withMeta(el, { zIndex: top }) : el);
      const added = onTop(shape);
      // The stroke was never committed: the entry records it (so undo can restore it) but only the
      // shape is applied now.
      const actions: Action[] = [{ type: "delete", el: onTop(stroke) }, { type: "add", el: added }];
      return record("Ink to shape", actions, undefined, [{ type: "add", el: added }]);
    },

    addConnector(input) {
      const s = get();
      if (!s.pageId) return null;
      const cfg = useSettingsStore.getState().settings;
      const now = new Date().toISOString();
      const valid = (end: ConnectorEnd | undefined): ConnectorEnd | undefined => {
        const b = end ? s.elements.get(end.id) : undefined;
        return end && b && isAttachable(b) ? { id: end.id, side: end.side } : undefined;
      };
      const source = valid(input.source);
      const target = valid(input.target);
      const top = topZ(s.elements.values());
      const content: Partial<ConnectorContent> = {
        mode: input.mode ?? DEFAULT_CONNECTOR_MODE,
        caps: { ...(input.caps ?? DEFAULT_CONNECTOR_CAPS) },
        route: [],
        ...(input.dash === "dashed" ? { dash: "dashed" as const } : {}),
        ...(source ? { source } : {}),
        ...(target ? { target } : {}),
        ...(top > 0 ? { zIndex: top } : {}),
      };
      const draft: Element = {
        id: crypto.randomUUID(),
        pageId: s.pageId,
        type: "connector",
        points: [
          { x: input.start.x, y: input.start.y, pressure: 0.5, timestamp: 0 },
          { x: input.end.x, y: input.end.y, pressure: 0.5, timestamp: 1 },
        ],
        color: input.color ?? cfg.defaultShapeStrokeColor,
        width: input.width ?? 2,
        isHighlighter: false,
        content,
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
      const el = routeConnector(draft, (id) => s.elements.get(id));
      return record("Connector", [{ type: "add", el }]) ? el.id : null;
    },

    setConnectorEnd(id, which, end, point) {
      const cur = editableConnector(id);
      if (!cur) return false;
      const els = get().elements;
      const b = end ? els.get(end.id) : undefined;
      if (end && (!b || !isAttachable(b))) return false;
      const content = { ...contentOf<ConnectorContent>(cur) };
      if (end) content[which] = { id: end.id, side: end.side };
      else delete content[which];
      const i = which === "source" ? 0 : 1;
      const points = point ? cur.points.map((p, k) => (k === i ? { ...p, x: point.x, y: point.y } : p)) : cur.points;
      const next = routeConnector({ ...cur, points, content }, (x) => els.get(x));
      if (sameElement(next, cur)) return false;
      return record("Connector end", [{ type: "update", before: cur, after: stamp(next) }]);
    },

    setConnectorProps(id, patch) {
      const cur = editableConnector(id);
      if (!cur) return false;
      const content: Partial<ConnectorContent> = {
        ...contentOf<ConnectorContent>(cur),
        mode: patch.mode ?? connectorMode(cur),
        caps: patch.caps ? { start: patch.caps.start, end: patch.caps.end } : connectorCaps(cur),
      };
      if (patch.dash === "dashed") content.dash = "dashed";
      else if (patch.dash === "solid") delete content.dash;
      const restyled: Element = {
        ...cur,
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.width !== undefined ? { width: patch.width } : {}),
        content,
      };
      const next = routeConnector(restyled, (x) => get().elements.get(x)); // a mode change reroutes
      if (sameElement(next, cur)) return false;
      // Consecutive width changes (a slider drag) merge into one entry.
      const widthOnly = Object.keys(patch).every((k) => k === "width");
      return record("Connector style", [{ type: "update", before: cur, after: stamp(next) }], widthOnly ? `connector-width:${id}` : undefined);
    },

    setConnectorLabel(id, label) {
      const cur = editableConnector(id);
      if (!cur) return false;
      const content = { ...contentOf<ConnectorContent>(cur) };
      const text = label?.text.trim() ?? "";
      if (label && text !== "") content.label = { text, t: Number.isFinite(label.t) ? Math.max(0, Math.min(1, label.t)) : 0.5 };
      else delete content.label;
      const next: Element = { ...cur, content };
      if (sameElement(next, cur)) return false;
      // Dragging the label along the route (same text) merges into one entry.
      const was = connectorLabel(cur);
      const key = was && content.label && was.text === content.label.text ? `label-t:${id}` : undefined;
      return record("Label", [{ type: "update", before: cur, after: stamp(next) }], key);
    },

    setLineCaps(id, caps) {
      const cur = get().elements.get(id);
      if (!cur || cur.type !== "shape" || (cur.shapeType !== "line" && cur.shapeType !== "arrow")) return false;
      if (isLocked(cur)) return false;
      const was = effectiveCaps(cur);
      if (was.start === caps.start && was.end === caps.end) return false;
      const after = stamp({ ...cur, content: { ...contentOf<ShapeContent>(cur), caps: { start: caps.start, end: caps.end } } });
      return record("Line ends", [{ type: "update", before: cur, after }]);
    },

    scribbleErase(ids) {
      const cur = get().elements;
      const ok = (id: string) => cur.has(id) && !isLocked(cur.get(id)!);
      record("Scribble erase", ids.filter(ok).map((id) => ({ type: "delete", el: cur.get(id)! })));
    },

    updateElements(els) {
      const cur = get().elements;
      let clamped = false;
      // A table never grows past MAX_TABLE_CELLS: an over-limit one is cut to the limit and flagged.
      const fit = (e: Element): Element => {
        if (e.type !== "table" || tableCells(e) <= MAX_TABLE_CELLS) return e;
        clamped = true;
        return { ...e, content: { ...contentOf<TableContent>(e), subtype: "table", tableData: { rows: clampRows(tableRowsOf(e)) } } };
      };
      // Locked elements are never edited (only unlockSelection changes them).
      record(
        "Edit",
        els
          .filter((e) => cur.has(e.id) && !isLocked(cur.get(e.id)!))
          .map((e) => fit(e))
          .map((after) => ({ type: "update", before: cur.get(after.id)!, after })),
      );
      if (clamped) set({ limitReached: true, limitKind: "table" });
    },

    addTable() {
      return insertBox("Table", tableElement);
    },

    addCodespace() {
      return insertBox("Code", codespaceElement);
    },

    addMathBox() {
      return insertBox("Equation", mathElement);
    },

    addGraph() {
      // New graphs start from the default preset of the kind last edited (the function kind at first).
      const settings = useSettingsStore.getState().settings;
      const preset = presetFor(lastGraphKind(), settings) ?? presetFor("2d-function", settings);
      return insertBox("Graph", (pageId, id, now, at, color) => graphElement(pageId, id, now, at, color, preset));
    },

    addTextBox(at) {
      closeEdit();
      const s = get();
      if (!s.pageId) return null;
      const cfg = useSettingsStore.getState().settings;
      const attrs = defaultTextAttributes(cfg.defaultTextColor, cfg.defaultTextSize);
      const pos = cfg.alignTextToLines && s.page ? alignToRuledLine(at, attrs.fontSize, s.page, cfg.defaultPageAspectRatio) : at;
      const top = topZ(s.elements.values());
      const box = textBoxElement(s.pageId, crypto.randomUUID(), new Date().toISOString(), pos, attrs);
      const el = top > 0 ? withMeta(box, { zIndex: top }) : box;
      if (!record("Text", [{ type: "add", el }], textKey(el.id))) return null;
      freshText = el.id;
      set({ selection: new Set([el.id]), editingId: el.id });
      return el.id;
    },

    addImage(assetId, natural, at) {
      closeEdit();
      const s = get();
      if (!s.pageId) return null;
      const vp = s.viewport.width > 0 ? s.viewport : { width: 1280, height: 800 };
      const tl = screenToWorld(s.camera, { x: 0, y: 0 });
      const br = screenToWorld(s.camera, { x: vp.width, y: vp.height });
      const box = fitImage(natural, { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y }, at);
      const top = topZ(s.elements.values());
      const img = imageElement(s.pageId, crypto.randomUUID(), new Date().toISOString(), assetId, box);
      const el = top > 0 ? withMeta(img, { zIndex: top }) : img;
      if (!record("Image", [{ type: "add", el }])) return null;
      set({ tool: "cursor", selection: new Set([el.id]), editingId: null });
      return el.id;
    },

    addMedia(assetId, kind, size, at, title) {
      closeEdit();
      const s = get();
      if (!s.pageId) return null;
      const vp = s.viewport.width > 0 ? s.viewport : { width: 1280, height: 800 };
      const tl = screenToWorld(s.camera, { x: 0, y: 0 });
      const br = screenToWorld(s.camera, { x: vp.width, y: vp.height });
      const box = fitImage(size ?? MEDIA_DEFAULT_SIZE[kind], { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y }, at);
      const top = topZ(s.elements.values());
      const content = title ? { kind, title } : { kind };
      const media = mediaElement(s.pageId, crypto.randomUUID(), new Date().toISOString(), assetId, box, content);
      const el = top > 0 ? withMeta(media, { zIndex: top }) : media;
      if (!record("Media", [{ type: "add", el }])) return null;
      set({ tool: "cursor", selection: new Set([el.id]), editingId: null });
      return el.id;
    },

    commitTextEdit(after) {
      const cur = get().elements.get(after.id);
      const fresh = freshText === after.id;
      if (fresh) freshText = null;
      if (!cur || cur.type !== "text-box" || isLocked(cur)) return; // locked boxes are never edited or deleted
      const c = contentOf<TextBoxContent>(after);
      const contentHtml = sanitizeHtml(c.contentHtml);
      const rawContent = plainText(contentHtml);
      const textAttributes = textAttrsOf(after);
      const next: Element = { ...after, color: textAttributes.color, content: { ...c, contentHtml, rawContent, textAttributes } };
      if (rawContent.trim() === "") {
        // A new box left empty disappears with its creation entry; an emptied box is deleted.
        if (fresh && history.discardTop(textKey(cur.id))) {
          applyActions([{ type: "delete", el: cur }]);
          syncHistoryFlags();
          return;
        }
        record("Delete", [{ type: "delete", el: cur }]);
        return;
      }
      if (sameText(cur, next)) return;
      record("Text", [{ type: "update", before: cur, after: stamp(next) }], fresh ? textKey(cur.id) : undefined);
    },

    bindEditSession(commit) {
      editCommit = commit;
      return () => {
        if (editCommit === commit) editCommit = null;
      };
    },

    restyleTextBox(patch) {
      const now = new Date().toISOString();
      const actions: Action[] = [];
      for (const cur of selectedElements()) {
        if (cur.type !== "text-box" || isLocked(cur)) continue;
        const before = textAttrsOf(cur);
        const attrs = { ...before, ...patch };
        let html = sanitizeHtml(contentOf<TextBoxContent>(cur).contentHtml);
        if (patch.color !== undefined) html = stripInlineStyle(html, "color");
        if (patch.fontFamily !== undefined) html = stripInlineStyle(html, "font-family");
        if (patch.fontSize !== undefined) html = stripInlineStyle(html, "font-size");
        const scaled = ((cur.boxHeight ?? 0) * attrs.fontSize) / before.fontSize;
        const boxHeight = boxHeightFor(measureHtmlHeight(html, attrs, cur.boxWidth ?? 0), attrs.fontSize, scaled);
        const content = { ...contentOf<TextBoxContent>(cur), contentHtml: html, textAttributes: attrs };
        const after: Element = { ...cur, content, color: attrs.color, boxHeight };
        if (!sameText(cur, after)) actions.push({ type: "update", before: cur, after: stamp(after, now) });
      }
      record("Style", actions);
    },

    removeElements(ids, label = "Delete") {
      const cur = get().elements;
      const ok = (id: string) => cur.has(id) && !isLocked(cur.get(id)!); // locked elements are never deleted
      const gone = new Set(ids.filter(ok));
      const actions: Action[] = [...gone].map((id) => ({ type: "delete", el: cur.get(id)! }));
      // Connectors bound to a deleted element keep their end at its last point, freed.
      record(label, [...actions, ...freeEnds(gone)]);
    },

    addElements(label, els) {
      if (els.length === 0) return false;
      closeEdit();
      return record(label, els.map((el): Action => ({ type: "add", el })));
    },

    setTool(tool) {
      if (isInkTool(tool)) {
        get().selectInk(tool);
        return;
      }
      if (tool === "eraser" || tool === "shape" || tool === "connector" || tool === "text" || tool === "insert-space") {
        closeEdit();
        set({ tool, selection: new Set(), editingId: null });
      } else set({ tool });
    },
    setPreset: (preset) => {
      closeEdit();
      set({ preset, tool: preset.type, selection: new Set(), editingId: null });
    },
    setCamera: (camera) => set({ camera }),
    setViewport: (viewport) => set({ viewport }),
    setGuides(guides) {
      if (guides.length === 0 && get().guides.length === 0) return;
      set({ guides });
    },
    resetCamera() {
      const s = get();
      if (!s.page) return;
      const stack = sheetStack(s);
      set({ camera: clampCamera(initialCamera(s.page, s.viewport, stack), s.page, s.viewport, stack) });
    },
    fitPage() {
      const s = get();
      if (!s.page) return;
      let bounds: Rect | null;
      if (s.page.mode === "page") {
        const stack = sheetStack(s);
        const pitch = stack.height + PAGE_GAP;
        const centreY = screenToWorld(s.camera, { x: 0, y: s.viewport.height / 2 }).y;
        const i = Math.max(0, Math.min(stack.count - 1, Math.floor(centreY / pitch)));
        bounds = { x: 0, y: i * pitch, width: stack.width, height: stack.height };
      } else bounds = selectionBounds(s.elements, s.elements.keys());
      if (!bounds) {
        s.resetCamera();
        return;
      }
      animateCamera(store, clampToPage(fitBounds(bounds, s.viewport), s));
    },
    fitSelection() {
      const s = get();
      const bounds = selectionBounds(s.elements, s.selection);
      if (!bounds) return;
      animateCamera(store, clampToPage(fitBounds(bounds, s.viewport), s));
    },

    pushTempTool: (tempTool) => set({ tempTool }),
    popTempTool: () => {
      if (get().tempTool !== null) set({ tempTool: null });
    },
    setPanHold: (panHold) => {
      if (get().panHold !== panHold) set({ panHold });
    },

    eraser(center) {
      const s = get();
      const cfg = useSettingsStore.getState().settings;
      const radius = cfg.defaultEraserWidth / 2 / s.camera.z;
      const mode = cfg.defaultEraserType === "partial" ? "partial" : "stroke";
      const r = eraseAt(s.elements, index, center, radius, mode, {
        eraseShapes: cfg.eraserEraseShapes,
        eraseImages: cfg.eraserEraseImages,
      });
      let actions: Action[] = r.removed.map((id) => ({ type: "delete", el: s.elements.get(id)! }));
      for (const { removedId, parts } of r.replaced) {
        actions.push({ type: "delete", el: s.elements.get(removedId)! });
        for (const el of parts) actions.push({ type: "add", el });
      }
      if (actions.length === 0) return;
      if (exceedsLimit(actions)) {
        // Splitting would push the page past the element limit: erase the touched strokes whole.
        actions = [...r.removed, ...r.replaced.map((x) => x.removedId)].map(
          (id): Action => ({ type: "delete", el: s.elements.get(id)! }),
        );
      }
      // Connectors bound to an erased element keep their end at its last point, freed (as removeElements).
      actions.push(...freeEnds(new Set([...r.removed, ...r.replaced.map((x) => x.removedId)])));
      appendCompact(eraseBatch, actions);
      applyActions(actions);
    },

    endEraser() {
      flushEraseBatch();
    },

    beginEdit(id) {
      const el = get().elements.get(id);
      if (!el || !isBoxed(el) || isPdfPlacement(el) || isLocked(el)) return;
      if (get().editingId !== id) closeEdit();
      set({ selection: new Set([id]), editingId: id });
    },
    endEdit() {
      closeEdit();
      if (get().editingId !== null) set({ editingId: null });
    },
    select(ids) {
      const wanted = [...ids];
      const prev = get().editingId;
      if (prev !== null && !wanted.includes(prev)) closeEdit(); // may remove an empty box
      const s = get();
      const selectable = (id: string) => {
        const el = s.elements.get(id);
        return !!el && !isPdfPlacement(el); // PDF page placements are locked
      };
      const selection = new Set(wanted.filter(selectable));
      const editingId = s.editingId !== null && selection.has(s.editingId) ? s.editingId : null;
      set({ selection, editingId });
    },
    selectAll() {
      set({ selection: new Set([...get().elements.values()].filter((el) => !isPdfPlacement(el)).map((el) => el.id)) });
    },

    moveSelection(dx, dy, opts) {
      if (dx === 0 && dy === 0) return;
      transformSelection(opts?.label ?? "Move", (els) => translateElements(els, dx, dy), opts?.mergeKey);
    },
    setSpaceOptions(patch) {
      set(patch);
    },
    insertSpace(lineY, dy) {
      const s = get();
      const d = spaceShift(s, lineY, dy);
      if (d === 0) return;
      const now = new Date().toISOString();
      const all = [...s.elements.values()];
      const after = shiftBelow(all, lineY, d, spaceOptions(s));
      const actions: Action[] = [];
      all.forEach((before, i) => {
        if (after[i] !== before && !isLocked(before)) actions.push({ type: "update", before, after: stamp(after[i], now) });
      });
      record("Insert space", actions);
    },
    alignSelection(mode) {
      if (unlockedSelection().length < 2) return;
      transformSelection("Align", (els) => alignElements(els, mode));
    },
    distributeSelection(axis) {
      if (unlockedSelection().length < 3) return;
      transformSelection("Distribute", (els) => distributeElements(els, axis));
    },
    groupSelection() {
      if (unlockedSelection().length < 2) return;
      const uiGroupId = crypto.randomUUID();
      transformSelection("Group", (els) => els.map((el) => ({ ...el, uiGroupId })));
    },
    ungroupSelection() {
      if (!selectedElements().some((el) => el.uiGroupId)) return;
      transformSelection("Ungroup", (els) => els.map((el) => ({ ...el, uiGroupId: undefined })));
    },
    graphFromSelectedEquation() {
      const s = get();
      const sel = selectedElements();
      if (!s.pageId || sel.length !== 1 || !isMathBox(sel[0])) return null;
      const math = sel[0];
      const b = elementBounds(math);
      const top = topZ(s.elements.values());
      const base = graphElement(s.pageId, crypto.randomUUID(), new Date().toISOString(), { x: b.x, y: b.y + b.height + DUPLICATE_OFFSET }, math.color);
      const data = defaultGraphData();
      // Recogniser notation the graph parser would misread (`\mathrm{dx}`) is cleaned up on the way.
      const latex = normalizeLatex(latexOf(math));
      data.kind = inferGraphKind(latex);
      data.expressions = [{ ...data.expressions[0], latex }];
      const graph = { ...base, content: { ...(base.content as object), graphData: data } };
      const el = top > 0 ? withMeta(graph, { zIndex: top + 1 }) : graph;
      if (!record("Graph", [{ type: "add", el }])) return null;
      set({ selection: new Set([el.id]) });
      return el.id;
    },
    scaleSelection(origin, sx, sy) {
      if (sx === 1 && sy === 1) return;
      transformSelection("Scale", (els) => scaleElements(els, origin, sx, sy));
    },
    rotateSelection(centre, rad) {
      if (rad === 0) return;
      transformSelection("Rotate", (els) => rotateElements(els, centre, rad));
    },
    lockSelection() {
      transformSelection("Lock", (els) => els.map((el) => withMeta(el, { locked: true })));
    },
    unlockSelection() {
      const locked = selectedElements().filter(isLocked);
      if (locked.length === 0) return;
      const now = new Date().toISOString();
      record("Unlock", locked.map((before): Action => ({ type: "update", before, after: stamp(unlocked(before), now) })));
    },
    restyleSelection(patch) {
      // Consecutive width changes (a slider drag) on the same selection merge into one entry.
      const widthOnly = patch.color === undefined && patch.fillColor === undefined;
      const key = widthOnly ? `width:${[...get().selection].sort().join(",")}` : undefined;
      const sized = (el: Element) => el.type === "stroke" || el.type === "shape" || el.type === "connector";
      transformSelection(
        "Style",
        (els) =>
          els.map((el) => ({
            ...el,
            ...(patch.color !== undefined ? { color: patch.color } : {}),
            ...(patch.width !== undefined && sized(el) ? { width: patch.width } : {}),
            ...(patch.fillColor !== undefined && el.type === "shape" ? { fillColor: patch.fillColor } : {}),
          })),
        key,
      );
    },

    deleteSelection() {
      get().removeElements([...get().selection]);
    },

    duplicateSelection() {
      pasteElements(selectedElements(), DUPLICATE_OFFSET, "Duplicate");
    },
    duplicateSelectionInPlace(mergeKey) {
      return pasteElements(selectedElements(), 0, "Duplicate", mergeKey);
    },
    copySelection() {
      const els = selectedElements();
      if (els.length === 0) return;
      clipboard = els.map(unlocked);
      pasteCount = 0;
    },
    cutSelection() {
      get().copySelection();
      get().deleteSelection();
    },
    paste() {
      if (clipboard.length === 0) return;
      pasteCount++;
      pasteElements(clipboard, DUPLICATE_OFFSET * pasteCount, "Paste");
    },

    undo() {
      flushEraseBatch();
      const peek = history.peekUndo();
      if (peek && exceedsLimit(peek)) {
        set({ limitReached: true, limitKind: "page" }); // leave the entry on the stack
        return;
      }
      const actions = history.undo();
      if (actions) applyActions(actions);
      syncHistoryFlags();
    },
    redo() {
      flushEraseBatch();
      const peek = history.peekRedo();
      if (peek && exceedsLimit(peek)) {
        set({ limitReached: true, limitKind: "page" });
        return;
      }
      const actions = history.redo();
      if (actions) applyActions(actions);
      syncHistoryFlags();
    },

    bringForward: () => arrange("forward"),
    sendBackward: () => arrange("backward"),
    toFront: () => arrange("front"),
    toBack: () => arrange("back"),

    selectSlot(slot) {
      const p = presets()[slot - 1];
      if (p) get().setPreset(p);
    },
    selectInk(type) {
      const s = get();
      if (s.preset.type === type) {
        closeEdit();
        set({ tool: type, selection: new Set(), editingId: null });
        return;
      }
      const found = presets().find((p) => p.type === type);
      if (found) {
        s.setPreset(found);
        return;
      }
      s.setPreset({ ...newPreset(type), id: `transient-${type}` });
    },
    addPreset(type) {
      const preset = newPreset(type);
      persistPresets([...presets(), preset]);
      get().setPreset(preset);
    },
    removePreset(id) {
      const list = presets();
      if (!list.some((p) => p.id === id)) return;
      const rest = list.filter((p) => p.id !== id);
      if (!rest.some(isPenType)) return; // keep at least one pen-type preset
      persistPresets(rest);
      if (get().preset.id === id) get().setPreset(rest[0]);
    },
    movePreset(id, dir) {
      const list = [...presets()];
      const i = list.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      persistPresets(list);
    },
    updatePreset(preset) {
      persistPresets(presets().map((p) => (p.id === preset.id ? preset : p)));
      if (get().preset.id === preset.id) set({ preset });
    },
  }));

  // ---- internal mutation helpers (operate on this store) ----

  const S = () => store.getState();

  function newPreset(type: InkType): PenPreset {
    const cfg = useSettingsStore.getState().settings;
    const hl = type === "highlighter";
    return {
      id: `preset-${crypto.randomUUID()}`,
      type,
      color: hl ? cfg.defaultHighlighterColor : cfg.defaultPenColor,
      width: hl ? cfg.defaultHighlighterWidth : cfg.defaultPenWidth,
    };
  }

  function syncHistoryFlags(): void {
    const canUndo = history.canUndo() || eraseBatch.length > 0;
    const canRedo = history.canRedo();
    const s = S();
    if (s.canUndo !== canUndo || s.canRedo !== canRedo) store.setState({ canUndo, canRedo });
  }

  function clearBindings(): void {
    bindings.clear();
    boundTo.clear();
  }

  /** Drop connector `id` from the bindings index. */
  function unbind(id: string): void {
    for (const target of boundTo.get(id) ?? []) {
      const set = bindings.get(target);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) bindings.delete(target);
    }
    boundTo.delete(id);
  }

  /** Index the ends of `el` (a no-op for non-connectors). */
  function bind(el: Element): void {
    if (el.type !== "connector") return;
    unbind(el.id);
    const ids = boundIds(el);
    if (ids.length === 0) return;
    boundTo.set(el.id, ids);
    for (const target of ids) {
      let set = bindings.get(target);
      if (!set) bindings.set(target, (set = new Set()));
      set.add(el.id);
    }
  }

  const sameElement = (a: Element, b: Element): boolean => JSON.stringify(a) === JSON.stringify(b);

  /** Connector `id` when it exists and is not locked. */
  function editableConnector(id: string): Element | null {
    const el = S().elements.get(id);
    return el && el.type === "connector" && !isLocked(el) ? el : null;
  }

  /**
   * Updates freeing the ends of connectors (outside `gone`) bound to an element in `gone`; each end
   * keeps its last absolute point and the connector is rerouted without it.
   */
  function freeEnds(gone: ReadonlySet<string>): Action[] {
    const els = S().elements;
    const touched = new Set<string>();
    for (const id of gone) for (const c of bindings.get(id) ?? []) if (!gone.has(c)) touched.add(c);
    const now = new Date().toISOString();
    const out: Action[] = [];
    for (const cid of touched) {
      const cur = els.get(cid);
      if (!cur) continue;
      const content = { ...contentOf<ConnectorContent>(cur) };
      const { source, target } = connectorEnds(cur);
      if (source && gone.has(source.id)) delete content.source;
      if (target && gone.has(target.id)) delete content.target;
      const next = routeConnector({ ...cur, content }, (x) => (gone.has(x) ? undefined : els.get(x)));
      out.push({ type: "update", before: cur, after: stamp(next, now) });
    }
    return out;
  }

  /**
   * Reroute connectors bound to an element changed by `actions` (connectors the actions already
   * carry are left alone); their updates, for the same history entry.
   */
  function rerouteBound(actions: readonly Action[]): Action[] {
    const inEntry = new Set<string>();
    for (const a of actions) inEntry.add(a.type === "update" ? a.after.id : a.el.id);
    const conns = new Set<string>();
    for (const id of inEntry) for (const c of bindings.get(id) ?? []) if (!inEntry.has(c)) conns.add(c);
    if (conns.size === 0) return [];
    const els = S().elements;
    const now = new Date().toISOString();
    const out: Action[] = [];
    for (const cid of conns) {
      const cur = els.get(cid);
      if (!cur) continue;
      const next = routeConnector(cur, (x) => els.get(x));
      if (next !== cur) out.push({ type: "update", before: cur, after: stamp(next, now) });
    }
    return out;
  }

  /** Apply actions to the element map, spatial index and persistence queue (no history). */
  function applyActions(actions: Action[]): void {
    if (actions.length === 0) return;
    const s = S();
    const elements = new Map(s.elements);
    let selection = s.selection;
    let editingId = s.editingId;
    let grewOnly = true;
    let bottom = s.contentBottom;
    const added = new Set<string>();
    const updated = new Set<string>();
    const removed = new Set<string>();
    for (const a of actions) {
      const id = a.type === "update" ? a.after.id : a.el.id;
      if (a.type === "delete") {
        if (!added.delete(id)) removed.add(id);
        updated.delete(id);
      } else if (a.type === "add" && !removed.delete(id)) added.add(id);
      else if (!added.has(id)) updated.add(id);
      if (a.type === "delete") {
        elements.delete(a.el.id);
        index.remove(a.el.id);
        if (a.el.type === "connector") unbind(a.el.id);
        elementsQueue.enqueueDelete(a.el.id, a.el.pageId);
        if (selection.has(a.el.id)) {
          selection = new Set(selection);
          selection.delete(a.el.id);
        }
        if (editingId === a.el.id) editingId = null;
        grewOnly = false;
      } else {
        const el = a.type === "add" ? a.el : a.after;
        if (a.type === "update") grewOnly = false;
        elements.set(el.id, el);
        index.insert(el.id, elementBounds(el));
        bind(el);
        elementsQueue.enqueueUpsert(el);
        bottom = Math.max(bottom, maxY(el));
      }
    }
    store.setState({
      elements,
      selection,
      editingId,
      contentBottom: grewOnly ? bottom : bottomOf(elements.values()),
      ...(s.limitReached && elements.size < LIMITS.MAX_ELEMENTS_PER_PAGE ? { limitReached: false } : {}),
    });
    syncHistoryFlags();
    if (changeListeners.size > 0 && added.size + updated.size + removed.size > 0) {
      const change: ElementsChange = { added: [...added], updated: [...updated], removed: [...removed] };
      for (const cb of [...changeListeners]) cb(change);
    }
  }

  function flushEraseBatch(): void {
    if (eraseBatch.length === 0) return;
    history.push({ label: "Erase", actions: eraseBatch });
    eraseBatch = [];
    syncHistoryFlags();
  }

  /** Live element count after applying `actions` to the current page. */
  function countAfter(actions: Action[]): number {
    const els = S().elements;
    const live = new Map<string, boolean>();
    let n = els.size;
    for (const a of actions) {
      const id = a.type === "update" ? a.after.id : a.el.id;
      const was = live.get(id) ?? els.has(id);
      const now = a.type !== "delete";
      n += Number(now) - Number(was);
      live.set(id, now);
    }
    return n;
  }

  /** True when applying `actions` would grow the page past the backend element limit. */
  function exceedsLimit(actions: Action[]): boolean {
    const n = countAfter(actions);
    return n > LIMITS.MAX_ELEMENTS_PER_PAGE && n > S().elements.size;
  }

  /**
   * Apply `actions` and push them as one history entry; refused (false) past the element limit.
   * `applied` (default `actions`) is what changes now, when the entry also records a state that was
   * never committed (ink to shape: the stroke replaced before it was added).
   */
  function record(label: string, actions: Action[], mergeKey?: string, applied: Action[] = actions): boolean {
    if (actions.length === 0) return false;
    if (exceedsLimit(applied)) {
      store.setState({ limitReached: true, limitKind: "page" });
      return false;
    }
    flushEraseBatch();
    applyActions(applied);
    // Connectors bound to anything that changed follow it, in the same entry (undo restores their rows).
    const rerouted = rerouteBound(applied);
    if (rerouted.length > 0) applyActions(rerouted);
    history.push({ label, actions: rerouted.length > 0 ? [...actions, ...rerouted] : actions, mergeKey });
    syncHistoryFlags();
    return true;
  }

  /** Add a default-sized box centred in the viewport (top of the stack) and start editing it. */
  function insertBox(label: string, make: typeof tableElement): string | null {
    closeEdit();
    const s = S();
    if (!s.pageId) return null;
    const vp = s.viewport.width > 0 ? s.viewport : { width: 1280, height: 800 };
    const c = screenToWorld(s.camera, { x: vp.width / 2, y: vp.height / 2 });
    const color = useSettingsStore.getState().settings.defaultTextColor;
    const probe = make(s.pageId, crypto.randomUUID(), new Date().toISOString(), c, color);
    const at = { x: c.x - (probe.boxWidth ?? 0) / 2, y: c.y - (probe.boxHeight ?? 0) / 2 };
    const top = topZ(s.elements.values());
    const box = { ...probe, points: [{ ...probe.points[0], ...at }] };
    const el = top > 0 ? withMeta(box, { zIndex: top }) : box;
    if (!record(label, [{ type: "add", el }])) return null;
    store.setState({ tool: "cursor", selection: new Set([el.id]), editingId: el.id });
    return el.id;
  }

  function selectedElements(): Element[] {
    const s = S();
    return [...s.selection].map((id) => s.elements.get(id)).filter((e): e is Element => !!e);
  }

  /** Selected elements that are not locked (the ones transforms may change). */
  function unlockedSelection(): Element[] {
    return selectedElements().filter((el) => !isLocked(el));
  }

  /** Apply `fn` to the unlocked selected elements as one history entry. */
  function transformSelection(label: string, fn: (els: Element[]) => Element[], mergeKey?: string): void {
    const before = unlockedSelection();
    if (before.length === 0) return;
    const now = new Date().toISOString();
    const after = settleConnectors(fn(before));
    record(
      label,
      before.map((b, i): Action => ({ type: "update", before: b, after: stamp(after[i], now) })),
      mergeKey,
    );
  }

  /**
   * Reroute the connectors among transformed elements `els`: free ends keep their transformed
   * points, bound ends follow their element (moved with `els` or not). A connector whose ends are
   * both in the set (or free) therefore just translates with a move.
   */
  function settleConnectors(els: Element[]): Element[] {
    if (!els.some((e) => e.type === "connector")) return els;
    const moved = new Map(els.map((e) => [e.id, e]));
    const cur = S().elements;
    const resolve = (id: string) => moved.get(id) ?? cur.get(id);
    return els.map((e) => (e.type === "connector" ? routeConnector(e, resolve) : e));
  }

  /** Add unlocked copies of `src` shifted by `offset` on both axes and select them; their ids ([] when refused). */
  function pasteElements(src: Element[], offset: number, label: string, mergeKey?: string): string[] {
    const s = S();
    const pageId = s.pageId;
    if (src.length === 0 || !pageId) return [];
    const now = new Date().toISOString();
    const top = topZ(s.elements.values());
    const ids = new Map(src.map((el) => [el.id, crypto.randomUUID()]));
    const placed = translateElements(src.map(unlocked), offset, offset).map((el, i) => {
      const copy: Element = { ...el, id: ids.get(el.id)!, pageId, createdAt: now, updatedAt: now, version: 0 };
      return top > 0 ? withMeta(copy, { zIndex: top + 1 + i }) : copy;
    });
    const copies = rebindCopies(placed, ids);
    if (!record(label, copies.map((el): Action => ({ type: "add", el })), mergeKey)) return [];
    const added = copies.map((c) => c.id);
    store.setState({ selection: new Set(added) });
    return added;
  }

  /**
   * Copied connectors bind to the copies of their elements; an end whose element was not copied is
   * freed at its (shifted) point. Then they are rerouted among the copies.
   */
  function rebindCopies(copies: Element[], ids: ReadonlyMap<string, string>): Element[] {
    if (!copies.some((e) => e.type === "connector")) return copies;
    const byId = new Map(copies.map((e) => [e.id, e]));
    return copies.map((el) => {
      if (el.type !== "connector") return el;
      const content = { ...contentOf<ConnectorContent>(el) };
      for (const which of ["source", "target"] as const) {
        const end = connectorEnds(el)[which];
        const to = end ? ids.get(end.id) : undefined;
        if (end && to) content[which] = { id: to, side: end.side };
        else delete content[which];
      }
      return routeConnector({ ...el, content }, (x) => byId.get(x));
    });
  }

  function arrange(op: ZOp): void {
    const s = S();
    const changed = reorder(s.elements.values(), s.selection, op);
    if (changed.length === 0) return;
    const now = new Date().toISOString();
    record(
      "Arrange",
      changed.map((after): Action => ({ type: "update", before: s.elements.get(after.id)!, after: stamp(after, now) })),
    );
  }

  return Object.assign(store, {
    spatialIndex: () => index,
    onElementsChanged(cb: (change: ElementsChange) => void): () => void {
      changeListeners.add(cb);
      return () => {
        changeListeners.delete(cb);
      };
    },
  });
}

/** The default instance: first pane, and the one tests and single-pane code use. */
export const useEditorStore = createEditorStore();
