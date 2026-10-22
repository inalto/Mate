import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import CanvasView from "../canvas/CanvasView";
import PageSettingsDialog from "../components/PageSettingsDialog";
import SelectionBar from "../components/SelectionBar";
import Sidebar from "../components/Sidebar";
import TabBar from "../components/TabBar";
import Toolbar from "../components/Toolbar";
import TopBar, { ShortcutsDialog } from "../components/TopBar";
import OverlayLayer from "../overlay/OverlayLayer";
import { preloadBoxEditors } from "../overlay/boxEditors";
import { runEditorShortcut, startNewTab } from "../keys/editorCommands";
import { bindShortcuts, DEFAULT_SHORTCUTS } from "../keys/shortcuts";
import { useChromeStore } from "../stores/chrome";
import { editorForPane } from "../stores/focusedEditor";
import { useNotebookStore } from "../stores/notebook";
import { watchPageLimit } from "../stores/pageLimit";
import { useSettingsStore } from "../stores/settings";
import { focusedPageId, useTabsStore, type PaneIndex } from "../stores/tabs";
import { watchThumbnails } from "../thumbnails";

export default function Editor() {
  const { pageId } = useParams();
  const navigate = useNavigate();
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const pageSettingsFor = useChromeStore((s) => s.pageSettingsFor);
  const settingsPage = useNotebookStore((s) => s.tree.pages.find((p) => p.id === pageSettingsFor));
  const leftHanded = useSettingsStore((s) => s.settings.handedness) === "left";

  // The URL names a page: make sure a tab shows it.
  useEffect(() => {
    if (pageId) useTabsStore.getState().openPage(pageId);
  }, [pageId]);

  // The URL follows the focused page of the active tab; closing the last tab leaves the editor.
  useEffect(
    () =>
      useTabsStore.subscribe((s, prev) => {
        const next = focusedPageId(s);
        if (next === focusedPageId(prev)) return;
        navigate(next === null ? "/" : `/edit/${next}`, { replace: true });
      }),
    [navigate],
  );

  // Drop tabs for pages that were deleted; keep open panes' page records (mode, background) fresh.
  useEffect(() => {
    const sync = (s: ReturnType<typeof useNotebookStore.getState>) => {
      if (!s.loaded) return;
      useTabsStore.getState().prune(new Set(s.tree.pages.map((p) => p.id)));
      for (const i of [0, 1] as const) {
        const ed = editorForPane(i).getState();
        const fresh = s.tree.pages.find((p) => p.id === ed.pageId);
        if (fresh) ed.refreshPage(fresh);
      }
    };
    sync(useNotebookStore.getState());
    return useNotebookStore.subscribe(sync);
  }, []);

  useEffect(
    () =>
      bindShortcuts(DEFAULT_SHORTCUTS, (action, detail) =>
        action === "tab.new" ? startNewTab(navigate) : runEditorShortcut(action, detail),
      ),
    [navigate],
  );
  useEffect(() => watchThumbnails(), []);
  // Box editors are separate chunks: fetch them once the editor is up, ahead of the first edit.
  useEffect(() => preloadBoxEditors(), []);
  // "This page is full" toast when the pen is refused at the element limit (each pane's store).
  useEffect(() => {
    const unsubs = ([0, 1] as const).map((i) => watchPageLimit(editorForPane(i)));
    return () => unsubs.forEach((u) => u());
  }, []);

  if (!pageId || !tab || !tab.panes.some((p) => p.pageId === pageId)) return null;

  return (
    <div className="editor-shell">
      <TopBar />
      <TabBar />
      <div className={leftHanded ? "editor-row reverse" : "editor-row"}>
        <Sidebar />
        <div className="editor">
          <div className={tab.panes.length === 2 ? "panes split" : "panes"}>
            {tab.panes.map((pane, i) => (
              <div
                key={`${i}:${pane.pageId}`}
                className={tab.focusedPaneIndex === i && tab.panes.length === 2 ? "pane focused" : "pane"}
                onPointerDownCapture={() => {
                  if (tab.focusedPaneIndex !== i) useTabsStore.getState().focusPane(tab.id, i as PaneIndex);
                }}
              >
                <CanvasView pageId={pane.pageId} store={editorForPane(i as PaneIndex)} />
                <OverlayLayer store={editorForPane(i as PaneIndex)} />
              </div>
            ))}
          </div>
          <SelectionBar />
          <Toolbar />
        </div>
      </div>
      {settingsPage && (
        <PageSettingsDialog key={settingsPage.id} page={settingsPage} onClose={() => useChromeStore.getState().openPageSettings(null)} />
      )}
      <ShortcutsDialog />
    </div>
  );
}
