// Editor command dispatch for keyboard shortcuts (and toolbar zoom buttons).
import { zoomBy } from "../canvas/gestures";
import { clampToPage } from "../stores/editor";
import { getFocusedEditor } from "../stores/focusedEditor";
import { useChromeStore } from "../stores/chrome";
import { useNotebookStore } from "../stores/notebook";
import { focusedPageId, useTabsStore } from "../stores/tabs";
import type { ShortcutDispatch } from "./shortcuts";

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

/** Tab, sidebar and page-tree shortcuts. `tab.new` needs the router: see Editor (startNewTab). */
function runChromeShortcut(action: string): boolean {
  const tabs = useTabsStore.getState();
  const pageId = focusedPageId(tabs);
  const nb = useNotebookStore.getState();
  switch (action) {
    case "tab.close":
      if (tabs.activeTabId) tabs.closeTab(tabs.activeTabId);
      return true;
    case "tab.moveLeft":
    case "tab.moveRight":
      if (tabs.activeTabId) tabs.moveTab(tabs.activeTabId, action === "tab.moveLeft" ? -1 : 1);
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
    case "page.moveUp":
    case "page.moveDown":
      if (pageId) void nb.movePage(pageId, action === "page.moveUp" ? -1 : 1);
      return true;
    case "page.promote":
    case "page.demote":
      if (pageId) void nb.indentPage(pageId, action === "page.promote" ? -1 : 1);
      return true;
    case "tab.new":
      return true;
  }
  return false;
}

export const runEditorShortcut: ShortcutDispatch = (action, detail) => {
  if (runChromeShortcut(action)) return;
  if (action === "duplicate" && sidebarHasFocus()) {
    const id = focusedPageId(useTabsStore.getState());
    if (id) void useNotebookStore.getState().duplicatePage(id);
    return;
  }
  const s = getFocusedEditor().getState();
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
      return s.select([]);
    case "selectAll":
      return s.selectAll();
    case "bringForward":
      return s.bringForward();
    case "sendBackward":
      return s.sendBackward();
    case "toFront":
      return s.toFront();
    case "toBack":
      return s.toBack();
    case "zoomIn":
      return zoomStep(ZOOM_STEP);
    case "zoomOut":
      return zoomStep(1 / ZOOM_STEP);
    case "zoomReset":
      return zoomStep(null);
    case "pan":
      return s.setPanHold(detail.phase === "down");
  }
};
