import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { closeThisWindow, isPageWindow, setThisWindowTitle } from "../ipc/windows";
import CanvasView from "../canvas/CanvasView";
import PageSettingsDialog from "../components/PageSettingsDialog";
import SelectionBar from "../components/SelectionBar";
import Sidebar from "../components/Sidebar";
import TabBar from "../components/TabBar";
import Toolbar from "../components/Toolbar";
import TopBar from "../components/TopBar";
import OverlayLayer from "../overlay/OverlayLayer";
import { preloadBoxEditors } from "../overlay/boxEditors";
import { runEditorShortcut, startNewTab } from "../keys/editorCommands";
import { ignoredInPageWindow } from "../keys/modalGuard";
import { bindLiveShortcuts } from "../keys/shortcuts";
import { useChromeStore } from "../stores/chrome";
import { editorForPane } from "../stores/focusedEditor";
import { useNotebookStore } from "../stores/notebook";
import { watchPageLimit } from "../stores/pageLimit";
import { useSettingsStore } from "../stores/settings";
import { focusedPageId, useTabsStore, type PaneIndex } from "../stores/tabs";
import { watchThumbnails } from "../thumbnails";
import TutorController from "../tutor/TutorController";

export default function Editor() {
  const { pageId } = useParams();
  // `?window=1`: this page has its own window. No sidebar, no tabs; closing the window is the exit.
  const pageWindow = isPageWindow();
  const pageTitle = useNotebookStore((s) => s.tree.pages.find((p) => p.id === pageId)?.title);
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
        if (pageWindow) {
          // The page was deleted: its window has nothing left to show.
          if (next === null) closeThisWindow();
          else navigate(`/edit/${next}?window=1`, { replace: true });
          return;
        }
        navigate(next === null ? "/" : `/edit/${next}`, { replace: true });
      }),
    [navigate, pageWindow],
  );

  // A page window is titled after its page (kept in step with renames).
  useEffect(() => {
    if (pageWindow && pageTitle !== undefined) setThisWindowTitle(pageTitle.trim() || "Untitled");
  }, [pageWindow, pageTitle]);

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
      bindLiveShortcuts((action, detail) =>
        pageWindow && ignoredInPageWindow(action)
          ? undefined
          : action === "tab.new"
            ? startNewTab(navigate)
            : runEditorShortcut(action, detail),
      ),
    [navigate, pageWindow],
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
    <div className={pageWindow ? "editor-shell page-window" : "editor-shell"}>
      <TopBar />
      {!pageWindow && <TabBar />}
      <div className={leftHanded ? "editor-row reverse" : "editor-row"}>
        {!pageWindow && <Sidebar />}
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
                {/* Live tutor (checks only with AI consent and a key); renders nothing. */}
                <TutorController store={editorForPane(i as PaneIndex)} pane={i as PaneIndex} />
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
    </div>
  );
}
