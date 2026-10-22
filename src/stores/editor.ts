// Editor state for the single active page. Element mutations are persisted through elementsQueue.
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { loadElements } from "../ipc/elements";
import { elementsQueue } from "../ipc/elementsQueue";
import type { Element, Page, PenPreset } from "../model/types";
import { DEFAULT_SETTINGS, LIMITS } from "../model/constants";
import { contentOf, type TextAttributes, type TextBoxContent } from "../model/content";
import { shapeElement, type ShapeDrag, type ShapeStyle } from "../shapes/geometry";
import { alignToRuledLine, boxHeightFor, measureHtmlHeight, plainText } from "../text/measure";
import { sanitizeHtml, stripInlineStyle } from "../text/sanitize";
import { fitImage } from "../images/fit";
import { imageElement } from "../images/element";
import { codespaceElement, MAX_TABLE_CELLS, tableCells, tableElement } from "../text/tableCode";
import { defaultTextAttributes, sameText, textAttrsOf, textBoxElement } from "../text/textBox";
import { eraseAt } from "../tools/eraser";
import { History, type Action } from "../tools/history";
import { scaleElements, translateElements } from "../tools/lasso";
import { elementBounds, isBoxed, SpatialIndex, withMeta } from "../tools/spatialIndex";
import { reorder, topZ, zOf, type ZOp } from "../tools/zorder";
import {
  clampCamera,
  initialCamera,
  screenToWorld,
  sheetCountFor,
  sheetSize,
  type Camera,
  type SheetStack,
  type Vec2,
  type Viewport,
} from "../canvas/camera";
import { useNotebookStore } from "./notebook";
import { useSettingsStore } from "./settings";

export type ToolId = "pen" | "highlighter" | "fountain-pen" | "eraser" | "cursor" | "lasso" | "shape" | "text";
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
  preset: PenPreset;
  camera: Camera;
  viewport: Viewport;
  selection: Set<string>;
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
  /**
   * Insert an image asset of `natural` pixel size at the viewport centre (or centred on `at`, in
   * page units), scaled to fit 80 % of the visible viewport; one history entry. Its id, or null.
   */
  addImage(assetId: string, natural: { width: number; height: number }, at?: Vec2): string | null;
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
  removeElements(ids: string[]): void;
  setTool(tool: ToolId): void;
  setPreset(preset: PenPreset): void;
  setCamera(camera: Camera): void;
  setViewport(viewport: Viewport): void;
  resetCamera(): void;
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
  moveSelection(dx: number, dy: number): void;
  scaleSelection(origin: Vec2, sx: number, sy: number): void;
  /** Stroke colour applies to all; width to strokes and shapes; fill colour to shapes only. */
  restyleSelection(patch: { color?: string; width?: number; fillColor?: string }): void;
  deleteSelection(): void;
  duplicateSelection(): void;
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
  if (isBoxed(el) || el.type === "shape") {
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
};

export function createEditorStore(): EditorStore {
  let loadToken = 0;
  // Page-scoped helpers (reset by loadPage).
  const history = new History();
  const index = new SpatialIndex();
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
    preset: DEFAULT_SETTINGS.toolbarPresets[0],
    camera: { x: 0, y: 0, z: 1 },
    viewport: { width: 0, height: 0 },
    selection: new Set(),
    editingId: null,
    contentBottom: 0,
    tempTool: null,
    panHold: false,
    canUndo: false,
    canRedo: false,
    limitReached: false,

    async loadPage(pageId) {
      closeEdit();
      freshText = null;
      const token = ++loadToken;
      const preset = defaultPreset();
      history.clear();
      index.clear();
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
      for (const e of els) index.insert(e.id, elementBounds(e));
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
      if (!get().limitReached) set({ limitReached: true });
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

    scribbleErase(ids) {
      const cur = get().elements;
      record("Scribble erase", ids.filter((id) => cur.has(id)).map((id) => ({ type: "delete", el: cur.get(id)! })));
    },

    updateElements(els) {
      const cur = get().elements;
      record(
        "Edit",
        // A table never grows past MAX_TABLE_CELLS: such an update is refused.
        els
          .filter((e) => cur.has(e.id) && !(e.type === "table" && tableCells(e) > MAX_TABLE_CELLS))
          .map((after) => ({ type: "update", before: cur.get(after.id)!, after })),
      );
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

    addTable() {
      return insertBox("Table", tableElement);
    },

    addCodespace() {
      return insertBox("Code", codespaceElement);
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

    commitTextEdit(after) {
      const cur = get().elements.get(after.id);
      const fresh = freshText === after.id;
      if (fresh) freshText = null;
      if (!cur || cur.type !== "text-box") return;
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
        if (cur.type !== "text-box") continue;
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

    removeElements(ids) {
      const cur = get().elements;
      record("Delete", ids.filter((id) => cur.has(id)).map((id) => ({ type: "delete", el: cur.get(id)! })));
    },

    setTool(tool) {
      if (isInkTool(tool)) {
        get().selectInk(tool);
        return;
      }
      if (tool === "eraser" || tool === "shape" || tool === "text") {
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
    resetCamera() {
      const s = get();
      if (!s.page) return;
      const stack = sheetStack(s);
      set({ camera: clampCamera(initialCamera(s.page, s.viewport, stack), s.page, s.viewport, stack) });
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
      appendCompact(eraseBatch, actions);
      applyActions(actions);
    },

    endEraser() {
      flushEraseBatch();
    },

    beginEdit(id) {
      const el = get().elements.get(id);
      if (!el || !isBoxed(el)) return;
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
      const selection = new Set(wanted.filter((id) => s.elements.has(id)));
      const editingId = s.editingId !== null && selection.has(s.editingId) ? s.editingId : null;
      set({ selection, editingId });
    },
    selectAll() {
      set({ selection: new Set(get().elements.keys()) });
    },

    moveSelection(dx, dy) {
      if (dx === 0 && dy === 0) return;
      transformSelection("Move", (els) => translateElements(els, dx, dy));
    },
    scaleSelection(origin, sx, sy) {
      if (sx === 1 && sy === 1) return;
      transformSelection("Scale", (els) => scaleElements(els, origin, sx, sy));
    },
    restyleSelection(patch) {
      // Consecutive width changes (a slider drag) on the same selection merge into one entry.
      const widthOnly = patch.color === undefined && patch.fillColor === undefined;
      const key = widthOnly ? `width:${[...get().selection].sort().join(",")}` : undefined;
      const sized = (el: Element) => el.type === "stroke" || el.type === "shape";
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
    copySelection() {
      const els = selectedElements();
      if (els.length === 0) return;
      clipboard = els;
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
        set({ limitReached: true }); // leave the entry on the stack
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
        set({ limitReached: true });
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

  /** Apply actions to the element map, spatial index and persistence queue (no history). */
  function applyActions(actions: Action[]): void {
    if (actions.length === 0) return;
    const s = S();
    const elements = new Map(s.elements);
    let selection = s.selection;
    let editingId = s.editingId;
    let grewOnly = true;
    let bottom = s.contentBottom;
    for (const a of actions) {
      if (a.type === "delete") {
        elements.delete(a.el.id);
        index.remove(a.el.id);
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
      store.setState({ limitReached: true });
      return false;
    }
    flushEraseBatch();
    history.push({ label, actions, mergeKey });
    applyActions(applied);
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

  function transformSelection(label: string, fn: (els: Element[]) => Element[], mergeKey?: string): void {
    const before = selectedElements();
    if (before.length === 0) return;
    const now = new Date().toISOString();
    const after = fn(before);
    record(
      label,
      before.map((b, i): Action => ({ type: "update", before: b, after: stamp(after[i], now) })),
      mergeKey,
    );
  }

  function pasteElements(src: Element[], offset: number, label: string): void {
    const s = S();
    const pageId = s.pageId;
    if (src.length === 0 || !pageId) return;
    const now = new Date().toISOString();
    const top = topZ(s.elements.values());
    const copies = translateElements(src, offset, offset).map((el, i) => {
      const copy: Element = { ...el, id: crypto.randomUUID(), pageId, createdAt: now, updatedAt: now, version: 0 };
      return top > 0 ? withMeta(copy, { zIndex: top + 1 + i }) : copy;
    });
    if (record(label, copies.map((el): Action => ({ type: "add", el })))) {
      store.setState({ selection: new Set(copies.map((c) => c.id)) });
    }
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

  return Object.assign(store, { spatialIndex: () => index });
}

/** The default instance: first pane, and the one tests and single-pane code use. */
export const useEditorStore = createEditorStore();
