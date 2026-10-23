import type { ShortcutAction } from "./actions";
import { effectiveMap, shortcutMapFor, type KeyOverride } from "./keybindings";
import { isMacPlatform } from "./platform";
import { useSettingsStore } from "../stores/settings";

export { isMacPlatform };

// Data-driven keyboard shortcuts. `mod` means Ctrl, or Cmd on macOS. Bindings match on `code`
// (physical key: digits, brackets, =/-) or `key` (layout-aware letters, case-insensitive).

export type { ShortcutAction } from "./actions";

export interface ShortcutBinding {
  action: ShortcutAction;
  key?: string;
  code?: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Ignore Shift when matching (shifted symbols such as "?"). */
  anyShift?: boolean;
  /** Extra payload, e.g. the preset slot number (1-based). */
  slot?: number;
  /** Held key: dispatched with phase "down" on keydown and "up" on keyup/blur. */
  hold?: boolean;
}

export type ShortcutMap = ShortcutBinding[];

export interface ShortcutDetail {
  slot?: number;
  phase?: "down" | "up";
  event?: KeyboardEvent;
}

export type ShortcutDispatch = (action: ShortcutAction, detail: ShortcutDetail) => void;

/** The built-in bindings, generated from ACTION_META (see actions.ts). */
export const DEFAULT_SHORTCUTS: ShortcutMap = shortcutMapFor(effectiveMap([]));

/** Overrides from `settings.keybindings`. */
export const readOverrides = (): KeyOverride[] => useSettingsStore.getState().settings.keybindings ?? [];

/** Bindings with the user's overrides applied. */
export const currentShortcuts = (): ShortcutMap => shortcutMapFor(effectiveMap(readOverrides()));

/**
 * Like bindShortcuts, but follows `settings.keybindings`: re-binds whenever the overrides change.
 * `only` restricts the bound actions.
 */
export function bindLiveShortcuts(dispatch: ShortcutDispatch, only?: readonly ShortcutAction[]): () => void {
  const build = () => {
    const map = currentShortcuts();
    return only ? map.filter((b) => only.includes(b.action)) : map;
  };
  let overrides = readOverrides();
  let unbind = bindShortcuts(build(), dispatch);
  const unsub = useSettingsStore.subscribe(() => {
    const next = readOverrides();
    if (next === overrides) return;
    overrides = next;
    unbind();
    unbind = bindShortcuts(build(), dispatch);
  });
  return () => {
    unsub();
    unbind();
  };
}

/** Input types that take typed text; sliders, checkboxes, radios, colour pickers and buttons do not. */
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

/** True for events aimed at text entry (text-like inputs, textareas, selects, contenteditable). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has((t.getAttribute("type") ?? "").toLowerCase());
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  // MathLive's <math-field> keeps its editable surface in a shadow root: events arrive retargeted.
  if (t.localName === "math-field" || t.closest("math-field")) return true;
  const ce = t.closest("[contenteditable]");
  return t.isContentEditable || (ce !== null && ce.getAttribute("contenteditable") !== "false");
}

export function matchShortcut(map: ShortcutMap, e: KeyboardEvent, mac: boolean): ShortcutBinding | null {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  if (otherMod) return null;
  for (const b of map) {
    if (b.code !== undefined ? e.code !== b.code : (e.key ?? "").toLowerCase() !== b.key?.toLowerCase()) continue;
    if (!!b.mod !== mod || (!b.anyShift && !!b.shift !== e.shiftKey) || !!b.alt !== e.altKey) continue;
    return b;
  }
  return null;
}

/** Listen on `window`; returns an unbind function. Platform is detected once at bind time. */
export function bindShortcuts(map: ShortcutMap, dispatch: ShortcutDispatch, target: Window = window): () => void {
  const mac = isMacPlatform();
  const held = new Set<ShortcutBinding>();
  const onDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || isTypingTarget(e.target)) return;
    const b = matchShortcut(map, e, mac);
    if (!b) return;
    e.preventDefault();
    if (b.hold) {
      if (e.repeat || held.has(b)) return;
      held.add(b);
      dispatch(b.action, { phase: "down", event: e });
      return;
    }
    dispatch(b.action, { slot: b.slot, event: e });
  };
  const onUp = (e: KeyboardEvent) => {
    for (const b of held) {
      if (b.code !== undefined ? e.code === b.code : e.key.toLowerCase() === b.key?.toLowerCase()) {
        held.delete(b);
        dispatch(b.action, { phase: "up", event: e });
      }
    }
  };
  const onBlur = () => {
    for (const b of held) dispatch(b.action, { phase: "up" });
    held.clear();
  };
  target.addEventListener("keydown", onDown);
  target.addEventListener("keyup", onUp);
  target.addEventListener("blur", onBlur);
  return () => {
    target.removeEventListener("keydown", onDown);
    target.removeEventListener("keyup", onUp);
    target.removeEventListener("blur", onBlur);
    onBlur();
  };
}
