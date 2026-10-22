// Which editor instance toolbars and shortcuts talk to. Pane 0 uses the default store, pane 1 (split
// view) a second instance; the focused pane comes from the active tab.
import { createEditorStore, useEditorStore, type EditorStore } from "./editor";
import { useTabsStore } from "./tabs";
import type { PaneIndex } from "./tabs";

const secondary = createEditorStore();

export const editorForPane = (i: PaneIndex): EditorStore => (i === 1 ? secondary : useEditorStore);

const focusedIndex = (s: ReturnType<typeof useTabsStore.getState>): PaneIndex =>
  s.tabs.find((t) => t.id === s.activeTabId)?.focusedPaneIndex ?? 0;

/** The focused pane's store (non-reactive; for event handlers and shortcuts). */
export const getFocusedEditor = (): EditorStore => editorForPane(focusedIndex(useTabsStore.getState()));

/** The focused pane's store; re-renders when focus moves between panes. */
export function useFocusedEditor(): EditorStore {
  return editorForPane(useTabsStore((s) => focusedIndex(s)));
}
