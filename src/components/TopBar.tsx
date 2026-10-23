// Editor top bar: navigation, undo/redo, page title (inline rename) and the "more actions" menu.
import { ArrowArcLeft, ArrowArcRight, DotsThree, House, Plus, SidebarSimple } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { startNewTab } from "../keys/editorCommands";
import { useChromeStore } from "../stores/chrome";
import { useFocusedEditor } from "../stores/focusedEditor";
import { useImportStore } from "../stores/importStore";
import { useNotebookStore } from "../stores/notebook";
import { focusedPageId, useTabsStore } from "../stores/tabs";
import ExportDialog from "./ExportDialog";
import { useDismiss } from "./useDismiss";

const SHORTCUT_HELP: [string, string][] = [
  ["Search and actions", "Ctrl+K"],
  ["Undo / Redo", "Ctrl+Z / Ctrl+Shift+Z"],
  ["New tab / Close tab", "Ctrl+T / Ctrl+W"],
  ["Move tab", "Alt+Shift+←/→"],
  ["Toggle sidebar", "Ctrl+\\"],
  ["Rename page", "F2"],
  ["Move page up/down", "Alt+↑/↓"],
  ["Promote / demote page", "Alt+←/→"],
  ["Duplicate (sidebar focus: page)", "Ctrl+D"],
  ["Pen, highlighter, eraser", "P, H, E"],
  ["Zoom in / out / reset", "Ctrl+= / Ctrl+- / Ctrl+0"],
];

function MoreMenu({ pageId, onExport }: { pageId: string | null; onExport(): void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const chrome = useChromeStore.getState;
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="menu-anchor">
      <button className="icon-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <DotsThree size={20} weight="bold" />
      </button>
      {open && (
        <div className="menu menu-right" role="menu">
          <button role="menuitem" disabled={!pageId} onClick={pick(onExport)}>Export page…</button>
          <button role="menuitem" onClick={pick(() => void useImportStore.getState().openDialog())}>Import notes…</button>
          <button role="menuitem" disabled={!pageId} onClick={pick(() => chrome().openPageSettings(pageId))}>Page settings</button>
          <button role="menuitem" disabled={!pageId} onClick={pick(() => chrome().openPalette("title"))}>Suggest title</button>
          <button role="menuitem" onClick={pick(() => chrome().openPalette())}>Search and actions…</button>
          <button role="menuitem" onClick={pick(() => navigate("/settings"))}>Settings</button>
          <button role="menuitem" onClick={pick(() => chrome().setShortcutsOpen(true))}>Keyboard shortcuts</button>
        </div>
      )}
    </div>
  );
}

export function ShortcutsDialog() {
  const open = useChromeStore((s) => s.shortcutsOpen);
  if (!open) return null;
  return (
    <div className="backdrop" onClick={() => useChromeStore.getState().setShortcutsOpen(false)}>
      <div className="card dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcut-list">
          {SHORTCUT_HELP.map(([what, keys]) => (
            <div key={what}><dt>{what}</dt><dd>{keys}</dd></div>
          ))}
        </dl>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={() => useChromeStore.getState().setShortcutsOpen(false)}>Close</button>
        </div>
      </div>
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

  return (
    <header className="topbar">
      <button className="icon-btn" aria-label="Home" title="Home" onClick={() => navigate("/")}><House size={18} /></button>
      <button className="icon-btn" aria-label="Toggle sidebar" title="Toggle sidebar (Ctrl+\)" onClick={() => useChromeStore.getState().toggleSidebar()}><SidebarSimple size={18} /></button>
      <button className="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => ed.getState().undo()}><ArrowArcLeft size={18} /></button>
      <button className="icon-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => ed.getState().redo()}><ArrowArcRight size={18} /></button>
      <button className="icon-btn" aria-label="New tab" title="New tab (Ctrl+T)" onClick={() => startNewTab(navigate)}><Plus size={18} /></button>
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
