// Editor command dispatch for keyboard shortcuts (and toolbar zoom buttons).
import { zoomBy } from "../canvas/gestures";
import { elementsQueue } from "../ipc/elementsQueue";
import { isLocked } from "../model/content";
import { clampToPage } from "../stores/editor";
import { getFocusedEditor } from "../stores/focusedEditor";
import { useChromeStore } from "../stores/chrome";
import { useNotebookStore } from "../stores/notebook";
import { focusedPageId, useTabsStore } from "../stores/tabs";
import type { Page } from "../model/types";
import type { ShortcutDispatch } from "./shortcuts";
import { openPageInWindow } from "./windowBridge";
import { noteShortcutUse } from "../components/shortcutHints";
import { modalAllows } from "./modalGuard";
import { isClosedShape } from "../shapes/geometry";
import { isTypingTarget } from "./shortcuts";
import { beginShapeTyping } from "../overlay/ShapeLabelEditor";
import i18n from "../i18n";

export const ZOOM_STEP = 1.2;

/** Zoom by `factor` about the viewport centre; null resets the camera. */
export function zoomStep(factor: number | null): void {
  const s = getFocusedEditor().getState();
  if (factor === null) {
    s.resetCamera();
    return;
  }
  const focus = { x: s.viewport.width / 2, y: s.viewport.height / 2 };
  s.setCamera(zoomBy(s.camera, factor, focus, (c) => clampToPage(c, s)));
}

/** Open a fresh tab: the next page picked (Home, sidebar) lands in a new tab. */
export function startNewTab(navigate: (to: string) => void): void {
  useTabsStore.getState().requestNewTab();
  navigate("/");
}

/** Ctrl+D acts on the page when the sidebar has keyboard focus, else on the canvas selection. */
const sidebarHasFocus = (): boolean =>
  typeof document !== "undefined" && document.activeElement?.closest(".sidebar") != null;

/** Pages of the current page's section in sidebar order (depth first, siblings by orderIndex). */
export function sectionPageOrder(pages: readonly Page[], sectionId: string): string[] {
  const inSection = pages.filter((p) => p.sectionId === sectionId);
  const byParent = new Map<string | null, Page[]>();
  for (const p of inSection) {
    const key = p.parentId && inSection.some((q) => q.id === p.parentId) ? p.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), p]);
  }
  const out: string[] = [];
  const walk = (parent: string | null) => {
    for (const p of (byParent.get(parent) ?? []).sort((a, b) => a.orderIndex - b.orderIndex)) {
      out.push(p.id);
      walk(p.id);
    }
  };
  walk(null);
  return out;
}

/** Open the previous (-1) or next (1) page of the current section in the active tab. */
export function stepPage(dir: -1 | 1): void {
  const tabs = useTabsStore.getState();
  const id = focusedPageId(tabs);
  const pages = useNotebookStore.getState().tree.pages;
  const cur = pages.find((p) => p.id === id);
  if (!cur) return;
  const order = sectionPageOrder(pages, cur.sectionId);
  const next = order[order.indexOf(cur.id) + dir];
  if (next) tabs.openPage(next);
}

/**
 * Page turn from a swipe: 1 opens the next page of the section, or, on its last page, creates a new
 * page at the end of the section (named like the sidebar's "new page") and opens it in the focused
 * pane; -1 opens the previous page and does nothing on the first. While a page is being created
 * further turns do nothing; the created page opens only if the focus is still on the page the swipe
 * started from, and a failed create is ignored.
 */
let turning = false;

export async function turnPage(dir: -1 | 1): Promise<void> {
  if (turning) return;
  const id = focusedPageId(useTabsStore.getState());
  const nb = useNotebookStore.getState();
  const cur = nb.tree.pages.find((p) => p.id === id);
  if (!cur) return;
  const order = sectionPageOrder(nb.tree.pages, cur.sectionId);
  const next = order[order.indexOf(cur.id) + dir];
  if (next) {
    useTabsStore.getState().openPage(next);
    return;
  }
  if (dir === -1) return;
  const count = nb.tree.pages.filter((p) => p.sectionId === cur.sectionId).length;
  turning = true;
  try {
    const created = await nb.createPage(cur.sectionId, i18n.t("common.pageName", { n: count + 1 }));
    if (focusedPageId(useTabsStore.getState()) === cur.id) useTabsStore.getState().openPage(created.id);
  } catch {
    /* create failed (store reports it); the swipe just does nothing */
  } finally {
    turning = false;
  }
}

/** Tab, sidebar and page-tree shortcuts. `tab.new` needs the router: see Editor (startNewTab). */
function runChromeShortcut(action: string): boolean {
  const tabs = useTabsStore.getState();
  const pageId = focusedPageId(tabs);
  const nb = useNotebookStore.getState();
  switch (action) {
    case "tab.close":
      if (tabs.activeTabId) tabs.closeTab(tabs.activeTabId);
      return true;
    case "tab.move.left":
    case "tab.move.right":
      if (tabs.activeTabId) tabs.moveTab(tabs.activeTabId, action === "tab.move.left" ? -1 : 1);
      return true;
    case "sidebar.toggle":
      useChromeStore.getState().toggleSidebar();
      return true;
    case "page.rename":
      if (pageId) {
        useChromeStore.getState().setSidebarOpen(true);
        useChromeStore.getState().setRenaming(pageId);
      }
      return true;
    case "page.move.up":
    case "page.move.down":
      if (pageId) void nb.movePage(pageId, action === "page.move.up" ? -1 : 1);
      return true;
    case "page.promote":
    case "page.demote":
      if (pageId) void nb.indentPage(pageId, action === "page.promote" ? -1 : 1);
      return true;
    case "page.prev":
    case "page.next":
      stepPage(action === "page.prev" ? -1 : 1);
      return true;
    case "page.duplicate":
      if (pageId) void nb.duplicatePage(pageId);
      return true;
    case "window.openPage":
      if (pageId) openPageInWindow(pageId);
      return true;
    case "save":
      void elementsQueue.flushAll();
      return true;
    case "help.shortcuts":
      useChromeStore.getState().setShortcutsOpen(true);
      return true;
    case "tab.new":
      return true;
    case "palette.open":
      useChromeStore.getState().openPalette();
      return true;
  }
  return false;
}

/**
 * "Typing starts editing": a printable key (no Ctrl/Meta/Alt) with exactly one unlocked closed shape
 * selected, nothing being edited and no text field focused opens that shape's text editor with the
 * key already typed. True when the key was taken.
 */
export function startShapeTyping(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  if (e.key.length !== 1 || e.key.trim() === "" || isTypingTarget(e.target)) return false;
  if (!modalAllows("tool.cursor", undefined)) return false;
  const store = getFocusedEditor();
  const s = store.getState();
  if (s.editingId !== null || s.selection.size !== 1) return false;
  const el = s.elements.get([...s.selection][0]);
  if (!el || el.type !== "shape" || !isClosedShape(el.shapeType ?? "rectangle") || isLocked(el)) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  beginShapeTyping(store, el.id, e.key);
  return true;
}

// Capture phase on the window, so the key wins over single-letter tool shortcuts.
if (typeof window !== "undefined") window.addEventListener("keydown", (e) => void startShapeTyping(e), true);

export const runEditorShortcut: ShortcutDispatch = (action, detail) => {
  // While any dialog, overlay, palette or menu is open it owns the keyboard (see modalAllows:
  // only the palette/help toggles and a pan release get through).
  if (!modalAllows(action, detail.phase)) return;
  noteShortcutUse(action);
  if (runChromeShortcut(action)) return;
  const s = getFocusedEditor().getState();
  // Ctrl+D: the page when the sidebar has focus or nothing is selected, else the selection.
  if (action === "duplicate" && (sidebarHasFocus() || s.selection.size === 0)) {
    const id = focusedPageId(useTabsStore.getState());
    if (id) void useNotebookStore.getState().duplicatePage(id);
    return;
  }
  switch (action) {
    case "tool.pen":
      return s.selectInk(s.preset.type === "fountain-pen" ? "fountain-pen" : "pen");
    case "tool.highlighter":
      return s.selectInk("highlighter");
    case "tool.eraser":
      return s.setTool("eraser");
    case "tool.cursor":
      return s.setTool("cursor");
    case "tool.lasso":
      return s.setTool("lasso");
    case "tool.shape":
      return s.setTool("shape");
    case "tool.connector":
      return s.setTool("connector");
    case "tool.text":
      return s.setTool("text");
    case "tool.insertSpace":
      return s.setTool("insert-space");
    case "preset.slot":
      return detail.slot !== undefined ? s.selectSlot(detail.slot) : undefined;
    case "undo":
      return s.undo();
    case "redo":
      return s.redo();
    case "copy":
      return s.copySelection();
    case "cut":
      return s.cutSelection();
    case "paste":
      return s.paste();
    case "duplicate":
      return s.duplicateSelection();
    case "delete":
      return s.deleteSelection();
    case "escape":
    case "deselect":
      return s.select([]);
    case "group":
      return s.groupSelection();
    case "ungroup":
      return s.ungroupSelection();
    case "selectAll":
      return s.selectAll();
    case "arrange.forward":
      return s.bringForward();
    case "arrange.backward":
      return s.sendBackward();
    case "arrange.front":
      return s.toFront();
    case "arrange.back":
      return s.toBack();
    case "arrange.lock": {
      // Toggle: any locked element in the selection unlocks, otherwise the selection locks.
      const anyLocked = [...s.selection].some((id) => {
        const el = s.elements.get(id);
        return el !== undefined && isLocked(el);
      });
      return anyLocked ? s.unlockSelection() : s.lockSelection();
    }
    case "zoom.in":
      return zoomStep(ZOOM_STEP);
    case "zoom.out":
      return zoomStep(1 / ZOOM_STEP);
    case "zoom.reset":
      return zoomStep(null);
    case "zoom.fit":
      return s.fitPage();
    case "zoom.selection":
      return s.fitSelection();
    case "pan":
      return s.setPanHold(detail.phase === "down");
  }
};
