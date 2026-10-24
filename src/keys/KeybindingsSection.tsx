import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ACTION_GROUPS, ACTION_META, ACTIONS, actionLabel, groupLabel, type ShortcutAction } from "./actions";
import { findCollision, formatKeys, isReservedCombo, parseKeyEvent, toOverrides, type KeyMap } from "./keybindings";
import { isMacPlatform } from "./platform";
import { saveOverrides, useKeyMap } from "./useKeyMap";
import "./keys.css";

/** Settings section: view, rebind, unbind and reset keyboard shortcuts. */
export default function KeybindingsSection() {
  const { t } = useTranslation();
  const map = useKeyMap();
  const mac = isMacPlatform();
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const write = (next: KeyMap) => void saveOverrides(toOverrides(next)).catch(() => {});

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      // Capture mode owns the keyboard: nothing else may react to this press.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        setWarning(null);
        return;
      }
      const keys = parseKeyEvent(e, mac);
      if (!keys) {
        // A bare modifier waits for the rest of the combo; Ctrl on macOS / Meta elsewhere is unsupported.
        if (!["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "OS"].includes(e.key)) {
          setWarning(mac ? t("keys.useCmd") : t("keys.noMeta"));
        }
        return;
      }
      const shown = formatKeys(keys, mac);
      if (isReservedCombo(keys)) {
        setWarning(t("keys.reserved", { keys: shown }));
        return;
      }
      const other = findCollision(map, keys, capturing);
      if (other) {
        setWarning(t("keys.taken", { keys: shown, action: actionLabel(other) }));
        return;
      }
      write({ ...map, [capturing]: [keys] });
      setCapturing(null);
      setWarning(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const overridden = new Set(toOverrides(map).map((o) => o.action));

  return (
    <section className="keybindings" aria-label={t("keys.title")}>
      <div className="keybindings-toolbar">
        <button type="button" className="btn" onClick={() => void saveOverrides([]).catch(() => {})}>
          {t("keys.resetAll")}
        </button>
      </div>
      {ACTION_GROUPS.map((group) => (
        <div key={group}>
          <h3>{groupLabel(group)}</h3>
          {ACTIONS.filter((a) => ACTION_META[a].group === group).map((a) => {
            const meta = ACTION_META[a];
            const label = t(meta.labelKey);
            const listening = capturing === a;
            return (
              <div key={a} className="keybindings-row" data-action={a}>
                <span>{label}</span>
                <span className="keybindings-keys">
                  {listening
                    ? t("keys.pressCombo")
                    : map[a].length > 0
                      ? map[a].map((k) => formatKeys(k, mac)).join(", ")
                      : t("keys.notSet")}
                </span>
                <span className="keybindings-actions">
                  {meta.rebindable !== false && (
                    <>
                      <button
                        type="button"
                        className="btn"
                        aria-label={listening ? t("keys.cancelAction", { action: label }) : t("keys.changeAction", { action: label })}
                        onClick={() => {
                          setCapturing(listening ? null : a);
                          setWarning(null);
                        }}
                      >
                        {listening ? t("common.cancel") : t("common.change")}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        aria-label={t("keys.unbindAction", { action: label })}
                        disabled={map[a].length === 0}
                        onClick={() => write({ ...map, [a]: [] })}
                      >
                        {t("keys.unbind")}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        aria-label={t("keys.resetAction", { action: label })}
                        disabled={!overridden.has(a)}
                        onClick={() => write({ ...map, [a]: ACTION_META[a].defaultKeys })}
                      >
                        {t("common.reset")}
                      </button>
                    </>
                  )}
                </span>
                {listening && warning && (
                  <p className="keybindings-warning" role="alert">
                    {warning}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
