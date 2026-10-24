// Editor top bar: navigation, undo/redo, page title (inline rename) and the "more actions" menu.
import { ArrowArcLeft, ArrowArcRight, DotsThree, House, Plus, SidebarSimple } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { isPageWindow } from "../ipc/windows";
import { startNewTab } from "../keys/editorCommands";
import { useChromeStore } from "../stores/chrome";
import { useFocusedEditor } from "../stores/focusedEditor";
import { useImportStore } from "../stores/importStore";
import { useNotebookStore } from "../stores/notebook";
import { focusedPageId, useTabsStore } from "../stores/tabs";
import AboutDialog from "./AboutDialog";
import ExportDialog from "./ExportDialog";
import { useDismiss } from "./useDismiss";

function MoreMenu({ pageId, onExport }: { pageId: string | null; onExport(): void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const chrome = useChromeStore.getState;
  const updateAvailable = useChromeStore((s) => s.updateAvailable);
  const aboutOpen = useChromeStore((s) => s.aboutOpen);
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="menu-anchor">
      <button ref={trigger} className="icon-btn" aria-label={updateAvailable ? "More actions, update available" : "More actions"} title={updateAvailable ? `Update available: ${updateAvailable}` : undefined} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <DotsThree size={20} weight="bold" />
        {updateAvailable && <span className="update-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="menu menu-right" role="menu">
          <button role="menuitem" disabled={!pageId} onClick={pick(onExport)}>Export page…</button>
          <button role="menuitem" onClick={pick(() => void useImportStore.getState().openDialog())}>Import notes…</button>
          <button role="menuitem" disabled={!pageId} onClick={pick(() => chrome().openPageSettings(pageId))}>Page settings</button>
          <button role="menuitem" disabled={!pageId} onClick={pick(() => chrome().openPalette("title"))}>Suggest title</button>
          <button role="menuitem" onClick={pick(() => chrome().openPalette())}>Search and actions…</button>
          {!isPageWindow() && <button role="menuitem" onClick={pick(() => navigate("/settings"))}>Settings</button>}
          <button role="menuitem" onClick={pick(() => chrome().setShortcutsOpen(true))}>Keyboard shortcuts</button>
          <button role="menuitem" onClick={pick(() => chrome().setAboutOpen(true))}>About Mate</button>
        </div>
      )}
      {aboutOpen && <AboutDialog onClose={() => {
        chrome().setAboutOpen(false);
        // The menu item that opened the dialog is gone: hand focus back to the More button.
        trigger.current?.focus();
      }} />}
    </div>
  );
}

export default function TopBar() {
  const navigate = useNavigate();
  const ed = useFocusedEditor();
  const canUndo = ed((s) => s.canUndo);
  const canRedo = ed((s) => s.canRedo);
  const pageId = useTabsStore((s) => focusedPageId(s));
  const title = useNotebookStore((s) => s.tree.pages.find((p) => p.id === pageId)?.title ?? "");
  const [draft, setDraft] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const cancelled = useRef(false);
  const commit = async () => {
    const next = cancelled.current ? undefined : draft?.trim();
    cancelled.current = false;
    setDraft(null);
    if (pageId && next && next !== title) await useNotebookStore.getState().rename("page", pageId, next);
  };

  // A page window has no home, sidebar or tabs: closing the window is its only exit.
  const pageWindow = isPageWindow();
  return (
    <header className="topbar">
      {!pageWindow && <button className="icon-btn" aria-label="Home" title="Home" onClick={() => navigate("/")}><House size={18} /></button>}
      {!pageWindow && <button className="icon-btn" aria-label="Toggle sidebar" title="Toggle sidebar (Ctrl+\)" onClick={() => useChromeStore.getState().toggleSidebar()}><SidebarSimple size={18} /></button>}
      <button className="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => ed.getState().undo()}><ArrowArcLeft size={18} /></button>
      <button className="icon-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => ed.getState().redo()}><ArrowArcRight size={18} /></button>
      {!pageWindow && <button className="icon-btn" aria-label="New tab" title="New tab (Ctrl+T)" onClick={() => startNewTab(navigate)}><Plus size={18} /></button>}
      <input
        className="input topbar-title"
        aria-label="Page title"
        value={draft ?? title}
        disabled={!pageId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      <MoreMenu pageId={pageId} onExport={() => setExporting(true)} />
      {exporting && pageId && <ExportDialog pageId={pageId} onClose={() => setExporting(false)} />}
    </header>
  );
}
