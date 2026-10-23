import { useEffect, useState } from "react";
import { ACTION_GROUPS, ACTION_META, ACTIONS, type ShortcutAction } from "./actions";
import { findCollision, formatKeys, isReservedCombo, parseKeyEvent, toOverrides, type KeyMap } from "./keybindings";
import { isMacPlatform } from "./platform";
import { saveOverrides, useKeyMap } from "./useKeyMap";
import "./keys.css";

/** Settings section: view, rebind, unbind and reset keyboard shortcuts. */
export default function KeybindingsSection() {
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
      if (!keys) return; // a bare modifier: wait for the rest of the combo
      const shown = formatKeys(keys, mac);
      if (isReservedCombo(keys)) {
        setWarning(`${shown} is reserved and cannot be used. Press another combination.`);
        return;
      }
      const other = findCollision(map, keys, capturing);
      if (other) {
        setWarning(`${shown} is already used by "${ACTION_META[other].label}". Press another combination.`);
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
    <section className="keybindings" aria-label="Keyboard shortcuts">
      <div className="keybindings-toolbar">
        <button type="button" className="btn" onClick={() => void saveOverrides([]).catch(() => {})}>
          Reset all
        </button>
      </div>
      {ACTION_GROUPS.map((group) => (
        <div key={group}>
          <h3>{group}</h3>
          {ACTIONS.filter((a) => ACTION_META[a].group === group).map((a) => {
            const meta = ACTION_META[a];
            const listening = capturing === a;
            return (
              <div key={a} className="keybindings-row" data-action={a}>
                <span>{meta.label}</span>
                <span className="keybindings-keys">
                  {listening
                    ? "Press a key combination…"
                    : map[a].length > 0
                      ? map[a].map((k) => formatKeys(k, mac)).join(", ")
                      : "Not set"}
                </span>
                <span className="keybindings-actions">
                  {meta.rebindable !== false && (
                    <>
                      <button
                        type="button"
                        className="btn"
                        aria-label={`${listening ? "Cancel" : "Change"} ${meta.label}`}
                        onClick={() => {
                          setCapturing(listening ? null : a);
                          setWarning(null);
                        }}
                      >
                        {listening ? "Cancel" : "Change"}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        aria-label={`Unbind ${meta.label}`}
                        disabled={map[a].length === 0}
                        onClick={() => write({ ...map, [a]: [] })}
                      >
                        Unbind
                      </button>
                      <button
                        type="button"
                        className="btn"
                        aria-label={`Reset ${meta.label}`}
                        disabled={!overridden.has(a)}
                        onClick={() => write({ ...map, [a]: ACTION_META[a].defaultKeys })}
                      >
                        Reset
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
