import { Books, Gear, House, Trash } from "@phosphor-icons/react";
import { useEffect } from "react";
import { NavLink, Outlet } from "react-router";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";

const link = ({ isActive }: { isActive: boolean }) => (isActive ? "nav-link active" : "nav-link");

export default function Shell() {
  useEffect(() => {
    void useSettingsStore.getState().load();
    void useNotebookStore.getState().load();
  }, []);

  return (
    <div className="shell">
      <nav className="nav-rail" aria-label="Main">
        <NavLink to="/" end className={link} aria-label="Home" title="Home">
          <House size={22} />
        </NavLink>
        <NavLink to="/library" className={link} aria-label="Library" title="Library">
          <Books size={22} />
        </NavLink>
        <NavLink to="/trash" className={link} aria-label="Trash" title="Trash">
          <Trash size={22} />
        </NavLink>
        <div className="spacer" />
        <NavLink to="/settings" className={link} aria-label="Settings" title="Settings">
          <Gear size={22} />
        </NavLink>
      </nav>
      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  );
}
