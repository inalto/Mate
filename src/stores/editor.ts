// Editor state for the single active page. Element mutations are persisted through elementsQueue.
import { create } from "zustand";
import { loadElements } from "../ipc/elements";
import { elementsQueue } from "../ipc/elementsQueue";
import type { Element, Page, PenPreset } from "../model/types";
import { DEFAULT_SETTINGS } from "../model/constants";
import {
  clampCamera,
  initialCamera,
  sheetCountFor,
  sheetSize,
  type Camera,
  type SheetStack,
  type Viewport,
} from "../canvas/camera";
import { useNotebookStore } from "./notebook";
import { useSettingsStore } from "./settings";

export type ToolId = "pen" | "highlighter" | "fountain-pen" | "eraser" | "cursor" | "lasso";

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
  loadPage(pageId: string): Promise<void>;
  addElement(el: Element): void;
  updateElements(els: Element[]): void;
  removeElements(ids: string[]): void;
  setTool(tool: ToolId): void;
  setPreset(preset: PenPreset): void;
  setCamera(camera: Camera): void;
  setViewport(viewport: Viewport): void;
  resetCamera(): void;
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
export function clampToPage(c: Camera, s: EditorState = useEditorStore.getState()): Camera {
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

let loadToken = 0;

export const useEditorStore = create<EditorState>((set, get) => ({
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

  async loadPage(pageId) {
    const token = ++loadToken;
    const preset = defaultPreset();
    set({
      pageId,
      loadedPageId: null,
      loadError: null,
      elements: new Map(),
      selection: new Set(),
      contentBottom: 0,
      preset,
      tool: preset.type,
    });
    let page: Page | null;
    let els: Element[];
    try {
      [page, els] = await Promise.all([findPage(pageId), loadElements(pageId)]);
    } catch (err) {
      console.error("loading page elements failed", err);
      if (token === loadToken) set({ loadError: String(err) });
      return;
    }
    if (token !== loadToken) return;
    const resolved = page ?? fallbackPage(pageId, "canvas");
    const elements = new Map(els.map((e) => [e.id, e]));
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

  addElement(el) {
    const elements = new Map(get().elements);
    elements.set(el.id, el);
    set({ elements, contentBottom: Math.max(get().contentBottom, maxY(el)) });
    elementsQueue.enqueueUpsert(el);
  },

  updateElements(els) {
    if (els.length === 0) return;
    const elements = new Map(get().elements);
    for (const el of els) {
      elements.set(el.id, el);
      elementsQueue.enqueueUpsert(el);
    }
    set({ elements, contentBottom: bottomOf(elements.values()) });
  },

  removeElements(ids) {
    if (ids.length === 0) return;
    const elements = new Map(get().elements);
    const selection = new Set(get().selection);
    for (const id of ids) {
      elements.delete(id);
      selection.delete(id);
      elementsQueue.enqueueDelete(id);
    }
    set({ elements, selection, contentBottom: bottomOf(elements.values()) });
  },

  setTool: (tool) => set({ tool }),
  setPreset: (preset) => set({ preset, tool: preset.type }),
  setCamera: (camera) => set({ camera }),
  setViewport: (viewport) => set({ viewport }),
  resetCamera() {
    const s = get();
    if (!s.page) return;
    const stack = sheetStack(s);
    set({ camera: clampCamera(initialCamera(s.page, s.viewport, stack), s.page, s.viewport, stack) });
  },
}));
