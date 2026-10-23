import { Books, Gear, House, ShareNetwork, Trash } from "@phosphor-icons/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { bindLiveShortcuts } from "../keys/shortcuts";
import ShortcutHelp from "../keys/ShortcutHelp";
import { useChromeStore } from "../stores/chrome";
import { isImportPath } from "../ipc/import";
import { useImportStore } from "../stores/importStore";
import CommandPalette from "./CommandPalette";
import ImportDialog from "./ImportDialog";
import { NavLink, Outlet, useLocation } from "react-router";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";

const link = ({ isActive }: { isActive: boolean }) => (isActive ? "nav-link active" : "nav-link");

export default function Shell() {
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
      bindLiveShortcuts(
        (action) =>
          action === "palette.open"
            ? useChromeStore.getState().openPalette()
            : useChromeStore.getState().setShortcutsOpen(true),
        ["palette.open", "help.shortcuts"],
      ),
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
      <nav className="nav-rail" aria-label="Main">
        <NavLink to="/" end className={link} aria-label="Home" title="Home">
          <House size={22} />
        </NavLink>
        <NavLink to="/library" className={link} aria-label="Library" title="Library">
          <Books size={22} />
        </NavLink>
        <NavLink to="/graph" className={link} aria-label="Graph" title="Graph">
          <ShareNetwork size={22} />
        </NavLink>
        <NavLink to="/trash" className={link} aria-label="Trash" title="Trash">
          <Trash size={22} />
        </NavLink>
        <div className="spacer" />
        <NavLink to="/settings" className={link} aria-label="Settings" title="Settings">
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
