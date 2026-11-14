// One replay per editor pane, and what ties it to its pane: opening a marker pressed on the canvas,
// turning the pane's page when the replay follows, telling the replay when the page changed, and
// closing it when its marker is deleted, the pane presents, the tab changes or the pane goes away.
import type { StoreApi } from "zustand/vanilla";
import { showToast } from "../components/Toast";
import i18n from "../i18n";
import type { EditorStore } from "../stores/editor";
import { editorForPane } from "../stores/focusedEditor";
import { useTabsStore, type PaneIndex } from "../stores/tabs";
import { userAction } from "./controls";
import { createReplay, type ReplayState } from "./replay";
import { isRecording } from "./types";

/** The replay each editor store opens markers in. */
const byEditor = new WeakMap<EditorStore, StoreApi<ReplayState>>();
/** The page of the marker a replay has open (for noticing the marker's deletion). */
const markerPage = new WeakMap<StoreApi<ReplayState>, string>();
const panes = new Map<PaneIndex, StoreApi<ReplayState>>();

/** Markers pressed on `editor`'s canvas open in `replay`; returns the detach. */
export function attachReplay(editor: EditorStore, replay: StoreApi<ReplayState>): () => void {
  byEditor.set(editor, replay);
  return () => {
    if (byEditor.get(editor) === replay) byEditor.delete(editor);
  };
}

/** Show `pageId` in pane `i` of the active tab (the replay following the recording's pages). */
function showInPane(i: PaneIndex, pageId: string): void {
  const tabs = useTabsStore.getState();
  const tab = tabs.tabs.find((t) => t.id === tabs.activeTabId);
  if (tab && tab.focusedPaneIndex !== i && i < tab.panes.length) tabs.focusPane(tab.id, i);
  useTabsStore.getState().openPage(pageId);
}

/** The replay of pane `i` (created on first use, bound to that pane's editor store). */
export function replayForPane(i: PaneIndex): StoreApi<ReplayState> {
  let r = panes.get(i);
  if (!r) {
    r = createReplay({
      goToPage: (pageId) => showInPane(i, pageId),
      onMissingSegment: () => showToast(i18n.t("replay.missingSegment")),
      onGapSeek: () => showToast(i18n.t("replay.notRecorded")),
    });
    panes.set(i, r);
    attachReplay(editorForPane(i), r);
  }
  return r;
}

/** What the canvas of `editor` needs to open a pressed recording marker. */
export function markerTargetOf(editor: EditorStore) {
  return {
    isMarker(id: string): boolean {
      const el = editor.getState().elements.get(id);
      return !!el && !el.deletedAt && isRecording(el) && byEditor.has(editor);
    },
    /** Opens marker `id` in the pane's replay (switching from another one; the open one stays as it is). */
    open(id: string): void {
      const replay = byEditor.get(editor);
      const el = editor.getState().elements.get(id);
      if (!replay || !el || !isRecording(el) || replay.getState().markerId === id) return;
      markerPage.set(replay, el.pageId);
      userAction("opening the replay", () => replay.getState().open(editor, id));
    },
  };
}

/**
 * Keeps the replays of both panes in step with the editor while it is mounted; returns the stop,
 * which closes them.
 */
export function watchPaneReplays(): () => void {
  const offs: (() => void)[] = [];
  for (const i of [0, 1] as const) {
    const editor = editorForPane(i);
    const replay = replayForPane(i);
    offs.push(
      editor.subscribe((s, prev) => {
        const r = replay.getState();
        if (r.markerId === null) return;
        if (s.presenting && !prev.presenting) return r.close();
        if (s.pageId !== prev.pageId && s.pageId) r.notePageChanged(s.pageId);
        // The marker's page is loaded without it: the marker was deleted (or moved away).
        const marker = s.elements.get(r.markerId);
        if (s.loadedPageId === markerPage.get(replay) && s.elements !== prev.elements && (!marker || marker.deletedAt)) r.close();
      }),
    );
  }
  offs.push(
    useTabsStore.subscribe((s, prev) => {
      // Another tab: both panes show other pages; the replays belong to the tab that was left.
      if (s.activeTabId !== prev.activeTabId) for (const i of [0, 1] as const) replayForPane(i).getState().close();
      // Split view ended: the second pane is gone.
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      if (!tab || tab.panes.length < 2) replayForPane(1).getState().close();
      if (!tab) replayForPane(0).getState().close();
    }),
  );
  return () => {
    for (const off of offs) off();
    for (const i of [0, 1] as const) replayForPane(i).getState().close();
  };
}
