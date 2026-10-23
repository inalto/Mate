import { useEffect, useRef } from "react";
import { useChromeStore } from "../stores/chrome";
import { ACTION_GROUPS, ACTION_META, ACTIONS } from "./actions";
import { formatKeys } from "./keybindings";
import { isMacPlatform } from "./platform";
import { useKeyMap } from "./useKeyMap";
import "./keys.css";

/** Keyboard shortcut overlay: every action grouped by area with its current binding. */
export default function ShortcutHelp() {
  const open = useChromeStore((s) => s.shortcutsOpen);
  return open ? <Overlay /> : null;
}

function Overlay() {
  const map = useKeyMap();
  const mac = isMacPlatform();
  const close = () => useChromeStore.getState().setShortcutsOpen(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      useChromeStore.getState().setShortcutsOpen(false);
    };
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, []);
  return (
    <div className="backdrop" onClick={close}>
      <div
        ref={ref}
        tabIndex={-1}
        className="card dialog shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Keyboard shortcuts</h2>
        <div className="shortcut-help-body">
          {ACTION_GROUPS.map((group) => {
            const actions = ACTIONS.filter((a) => ACTION_META[a].group === group);
            if (actions.length === 0) return null;
            return (
              <section key={group}>
                <h3>{group}</h3>
                <dl className="shortcut-list">
                  {actions.map((a) => (
                    <div key={a}>
                      <dt>{ACTION_META[a].label}</dt>
                      <dd>{map[a].length > 0 ? map[a].map((k) => formatKeys(k, mac)).join(", ") : "Not set"}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
