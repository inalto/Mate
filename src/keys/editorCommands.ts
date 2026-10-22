// Editor command dispatch for keyboard shortcuts (and toolbar zoom buttons).
import { zoomBy } from "../canvas/gestures";
import { clampToPage, useEditorStore } from "../stores/editor";
import type { ShortcutDispatch } from "./shortcuts";

export const ZOOM_STEP = 1.2;

/** Zoom by `factor` about the viewport centre; null resets the camera. */
export function zoomStep(factor: number | null): void {
  const s = useEditorStore.getState();
  if (factor === null) {
    s.resetCamera();
    return;
  }
  const focus = { x: s.viewport.width / 2, y: s.viewport.height / 2 };
  s.setCamera(zoomBy(s.camera, factor, focus, (c) => clampToPage(c)));
}

export const runEditorShortcut: ShortcutDispatch = (action, detail) => {
  const s = useEditorStore.getState();
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
