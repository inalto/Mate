import { useModal } from "../components/useModal";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useChromeStore } from "../stores/chrome";
import { ACTION_GROUPS, ACTION_META, ACTIONS, groupLabel } from "./actions";
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
  useModal();
  const { t } = useTranslation();
  const map = useKeyMap();
  const mac = isMacPlatform();
  const close = () => useChromeStore.getState().setShortcutsOpen(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation(); // closes the overlay only, nothing behind it
        useChromeStore.getState().setShortcutsOpen(false);
      } else if (e.key === "Tab") {
        const focusable = [...(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
        e.preventDefault();
        if (focusable.length === 0) return;
        const i = focusable.indexOf(document.activeElement as HTMLElement);
        focusable[e.shiftKey ? (i <= 0 ? focusable.length - 1 : i - 1) : i === focusable.length - 1 ? 0 : i + 1].focus();
      }
    };
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
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
        aria-label={t("keys.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{t("keys.title")}</h2>
        <div className="shortcut-help-body">
          {ACTION_GROUPS.map((group) => {
            const actions = ACTIONS.filter((a) => ACTION_META[a].group === group);
            if (actions.length === 0) return null;
            return (
              <section key={group}>
                <h3>{groupLabel(group)}</h3>
                <dl className="shortcut-list">
                  {actions.map((a) => (
                    <div key={a}>
                      <dt>{t(ACTION_META[a].labelKey)}</dt>
                      <dd>{map[a].length > 0 ? map[a].map((k) => formatKeys(k, mac)).join(", ") : t("keys.notSet")}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={close}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
