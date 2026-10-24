import { Books, Gear, House, ShareNetwork, Trash } from "@phosphor-icons/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { bindLiveShortcuts } from "../keys/shortcuts";
import ShortcutHelp from "../keys/ShortcutHelp";
import { runGlobalShortcut } from "../keys/modalGuard";
import { isImportPath } from "../ipc/import";
import { useImportStore } from "../stores/importStore";
import CommandPalette from "./CommandPalette";
import ImportDialog from "./ImportDialog";
import { NavLink, Outlet, useLocation } from "react-router";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";

const link = ({ isActive }: { isActive: boolean }) => (isActive ? "nav-link active" : "nav-link");

export default function Shell() {
  const { t } = useTranslation();
  // The editor has its own chrome (top bar, sidebar), so the app rail steps aside there.
  const inEditor = useLocation().pathname.startsWith("/edit/");
  useEffect(() => {
    void useSettingsStore.getState().load();
    void useNotebookStore.getState().load();
  }, []);
  // Ctrl/Cmd+K works on every route. In the editor its own shortcut binding opens the palette
  // first and marks the event handled, so this only fires elsewhere.
  useEffect(
    () =>
      // Behind the same modal check as the editor: an open dialog or menu owns the keyboard.
      bindLiveShortcuts((action) => runGlobalShortcut(action), ["palette.open", "help.shortcuts"]),
    [],
  );

  // Notebook files from other apps dropped anywhere open the import dialog (PDFs and images are
  // handled by the canvas and window drop handlers).
  useEffect(() => {
    let detached = false;
    let unlisten: (() => void) | null = null;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          const paths = event.payload.paths.filter(isImportPath);
          if (paths.length === 0) return;
          void useImportStore.getState().openDialog({ paths });
        })
        .then((fn) => (detached ? fn() : (unlisten = fn)))
        .catch(() => {});
    } catch {
      /* not running inside the Tauri shell */
    }
    return () => {
      detached = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="shell">
      {!inEditor && (
      <nav className="nav-rail" aria-label={t("nav.main")}>
        <NavLink to="/" end className={link} aria-label={t("nav.home")} title={t("nav.home")}>
          <House size={22} />
        </NavLink>
        <NavLink to="/library" className={link} aria-label={t("nav.library")} title={t("nav.library")}>
          <Books size={22} />
        </NavLink>
        <NavLink to="/graph" className={link} aria-label={t("nav.graph")} title={t("nav.graph")}>
          <ShareNetwork size={22} />
        </NavLink>
        <NavLink to="/trash" className={link} aria-label={t("nav.trash")} title={t("nav.trash")}>
          <Trash size={22} />
        </NavLink>
        <div className="spacer" />
        <NavLink to="/settings" className={link} aria-label={t("nav.settings")} title={t("nav.settings")}>
          <Gear size={22} />
        </NavLink>
      </nav>
      )}
      <main className="shell-main">
        <Outlet />
      </main>
      <CommandPalette />
      <ImportDialog />
      <ShortcutHelp />
    </div>
  );
}
