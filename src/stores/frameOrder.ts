// Which editor's frame order panel is open (FrameOrderPanel, mounted once by the editor route).
import { create } from "zustand";
import type { EditorStore } from "./editor";

export const useFrameOrderStore = create<{ store: EditorStore | null }>(() => ({ store: null }));

/** Open the frame order panel for the frames of `store`'s page. */
export const openFrameOrder = (store: EditorStore): void => useFrameOrderStore.setState({ store });
export const closeFrameOrder = (): void => useFrameOrderStore.setState({ store: null });

/** `ids` with the item at `from` moved to position `to` (clamped). */
export function moveId(ids: readonly string[], from: number, to: number): string[] {
  const out = [...ids];
  if (from < 0 || from >= out.length) return out;
  const [id] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, id);
  return out;
}
