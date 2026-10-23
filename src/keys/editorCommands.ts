// Editor command dispatch for keyboard shortcuts (and toolbar zoom buttons).
import { zoomBy } from "../canvas/gestures";
import { elementsQueue } from "../ipc/elementsQueue";
import { clampToPage } from "../stores/editor";
import { getFocusedEditor } from "../stores/focusedEditor";
import { useChromeStore } from "../stores/chrome";
import { useNotebookStore } from "../stores/notebook";
import { focusedPageId, useTabsStore } from "../stores/tabs";
import type { Page } from "../model/types";
import type { ShortcutDispatch } from "./shortcuts";
import { openPageInWindow } from "./windowBridge";
import { noteShortcutUse } from "../components/shortcutHints";

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

export const runEditorShortcut: ShortcutDispatch = (action, detail) => {
  // While any dialog, overlay, palette or menu is open it owns the keyboard. Only the palette
  // and the shortcut help may be toggled by their own shortcut (Escape is handled by the modal).
  const chrome = useChromeStore.getState();
  if (chrome.modalDepth > 0) {
    const toggles =
      (action === "palette.open" && (chrome.paletteOpen || chrome.shortcutsOpen)) ||
      (action === "help.shortcuts" && chrome.shortcutsOpen);
    if (!toggles) return;
  }
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
    case "zoom.in":
      return zoomStep(ZOOM_STEP);
    case "zoom.out":
      return zoomStep(1 / ZOOM_STEP);
    case "zoom.reset":
      return zoomStep(null);
    case "pan":
      return s.setPanHold(detail.phase === "down");
  }
};
