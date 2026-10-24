// Editor top bar: navigation, undo/redo, page title (inline rename) and the "more actions" menu.
import { ArrowArcLeft, ArrowArcRight, DotsThree, House, Plus, SidebarSimple } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
      <button ref={trigger} className="icon-btn" aria-label={updateAvailable ? t("topbar.moreUpdate") : t("topbar.more")} title={updateAvailable ? t("topbar.updateAvailable", { version: updateAvailable }) : undefined} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <DotsThree size={20} weight="bold" />
        {updateAvailable && <span className="update-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="menu menu-right" role="menu">
          <button role="menuitem" disabled={!pageId} onClick={pick(onExport)}>{t("topbar.exportPage")}</button>
          <button role="menuitem" onClick={pick(() => void useImportStore.getState().openDialog())}>{t("topbar.importNotes")}</button>
          <button role="menuitem" disabled={!pageId} onClick={pick(() => chrome().openPageSettings(pageId))}>{t("topbar.pageSettings")}</button>
          <button role="menuitem" disabled={!pageId} onClick={pick(() => chrome().openPalette("title"))}>{t("palette.suggestTitle")}</button>
          <button role="menuitem" onClick={pick(() => chrome().openPalette())}>{t("topbar.searchActions")}</button>
          {!isPageWindow() && <button role="menuitem" onClick={pick(() => navigate("/settings"))}>{t("nav.settings")}</button>}
          <button role="menuitem" onClick={pick(() => chrome().setShortcutsOpen(true))}>{t("keys.title")}</button>
          <button role="menuitem" onClick={pick(() => chrome().setAboutOpen(true))}>{t("topbar.about")}</button>
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const withKeys = (label: string, keys: string) => t("toolbar.hintWithKeys", { label, keys });
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
      {!pageWindow && <button className="icon-btn" aria-label={t("nav.home")} title={t("nav.home")} onClick={() => navigate("/")}><House size={18} /></button>}
      {!pageWindow && <button className="icon-btn" aria-label={t("keys.actions.toggleSidebar")} title={withKeys(t("keys.actions.toggleSidebar"), "Ctrl+\\")} onClick={() => useChromeStore.getState().toggleSidebar()}><SidebarSimple size={18} /></button>}
      <button className="icon-btn" aria-label={t("keys.actions.undo")} title={withKeys(t("keys.actions.undo"), "Ctrl+Z")} disabled={!canUndo} onClick={() => ed.getState().undo()}><ArrowArcLeft size={18} /></button>
      <button className="icon-btn" aria-label={t("keys.actions.redo")} title={withKeys(t("keys.actions.redo"), "Ctrl+Shift+Z")} disabled={!canRedo} onClick={() => ed.getState().redo()}><ArrowArcRight size={18} /></button>
      {!pageWindow && <button className="icon-btn" aria-label={t("keys.actions.newTab")} title={withKeys(t("keys.actions.newTab"), "Ctrl+T")} onClick={() => startNewTab(navigate)}><Plus size={18} /></button>}
      <input
        className="input topbar-title"
        aria-label={t("topbar.pageTitle")}
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
