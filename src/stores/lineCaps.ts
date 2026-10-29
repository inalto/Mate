// Line ends popover state: which line/arrow (in which pane's editor store) it edits. The popover
// anchors itself at the line's end point in pane screen space (it follows pan and zoom). Closes on
// a canvas pointer-down, Escape, or after LINE_CAPS_IDLE_MS without interaction.
import { create } from "zustand";
import type { EditorStore } from "./editor";

export const LINE_CAPS_IDLE_MS = 5000;

export interface LineCapsTarget {
  editor: EditorStore;
  id: string;
}

interface LineCapsState {
  target: LineCapsTarget | null;
}

export const useLineCapsStore = create<LineCapsState>(() => ({ target: null }));

let idle: ReturnType<typeof setTimeout> | null = null;

function clearIdle(): void {
  if (idle !== null) clearTimeout(idle);
  idle = null;
}

/** Restart the idle timer (any interaction with the popover). */
export function touchLineCaps(): void {
  clearIdle();
  if (useLineCapsStore.getState().target) idle = setTimeout(closeLineCaps, LINE_CAPS_IDLE_MS);
}

/** Open the popover for line/arrow shape `id` of `editor`. */
export function openLineCaps(editor: EditorStore, id: string): void {
  useLineCapsStore.setState({ target: { editor, id } });
  touchLineCaps();
}

export function closeLineCaps(): void {
  clearIdle();
  if (useLineCapsStore.getState().target) useLineCapsStore.setState({ target: null });
}
