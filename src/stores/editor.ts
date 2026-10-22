// Editor state for the single active page. Element mutations are persisted through elementsQueue.
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { loadElements } from "../ipc/elements";
import { elementsQueue } from "../ipc/elementsQueue";
import type { Element, Page, PenPreset } from "../model/types";
import { DEFAULT_SETTINGS, LIMITS } from "../model/constants";
import { eraseAt } from "../tools/eraser";
import { History, type Action } from "../tools/history";
import { scaleElements, translateElements } from "../tools/lasso";
import { elementBounds, SpatialIndex, withMeta } from "../tools/spatialIndex";
import { reorder, topZ, zOf, type ZOp } from "../tools/zorder";
import {
  clampCamera,
  initialCamera,
  sheetCountFor,
  sheetSize,
  type Camera,
  type SheetStack,
  type Vec2,
  type Viewport,
} from "../canvas/camera";
import { useNotebookStore } from "./notebook";
import { useSettingsStore } from "./settings";

export type ToolId = "pen" | "highlighter" | "fountain-pen" | "eraser" | "cursor" | "lasso";
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
  updateElements(els: Element[]): void;
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
  select(ids: Iterable<string>): void;
  selectAll(): void;
  moveSelection(dx: number, dy: number): void;
  scaleSelection(origin: Vec2, sx: number, sy: number): void;
  restyleSelection(patch: { color?: string; width?: number }): void;
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
    contentBottom: 0,
    tempTool: null,
    panHold: false,
    canUndo: false,
    canRedo: false,
    limitReached: false,

    async loadPage(pageId) {
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

    updateElements(els) {
      const cur = get().elements;
      record(
        "Edit",
        els.filter((e) => cur.has(e.id)).map((after) => ({ type: "update", before: cur.get(after.id)!, after })),
      );
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
      set({ tool, selection: tool === "eraser" ? new Set() : get().selection });
    },
    setPreset: (preset) => set({ preset, tool: preset.type, selection: new Set() }),
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

    select(ids) {
      const els = get().elements;
      set({ selection: new Set([...ids].filter((id) => els.has(id))) });
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
      const key = patch.color === undefined ? `width:${[...get().selection].sort().join(",")}` : undefined;
      transformSelection(
        "Style",
        (els) =>
          els.map((el) => ({
            ...el,
            ...(patch.color !== undefined ? { color: patch.color } : {}),
            ...(patch.width !== undefined && el.type === "stroke" ? { width: patch.width } : {}),
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
        set({ tool: type, selection: new Set() });
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

  /** Apply `actions` and push them as one history entry; refused (false) past the element limit. */
  function record(label: string, actions: Action[], mergeKey?: string): boolean {
    if (actions.length === 0) return false;
    if (exceedsLimit(actions)) {
      store.setState({ limitReached: true });
      return false;
    }
    flushEraseBatch();
    history.push({ label, actions, mergeKey });
    applyActions(actions);
    return true;
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
