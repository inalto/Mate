// Toolbar shortcut hints (settings.shortcutHintMode, settings.dismissedHints).
// - "always": the tooltip names the action's current key ("Eraser (E)").
// - "never": the tooltip is the bare label.
// - "adaptive": shown until learned. A hint is learned after HINT_IMPRESSIONS_TO_LEARN impressions
//   (the pointer entering, or keyboard focus reaching, its button) or HINT_KEY_USES_TO_LEARN uses of
//   the shortcut itself; learned hints are recorded in `dismissedHints` (persisted with the
//   settings) and stay hidden while the mode is adaptive. Counting only happens in adaptive mode;
//   the counters live in localStorage (best effort; memory only when storage is unavailable).
//   Only actions with a toolbar button (HINTED_ACTIONS) are counted. Counters are cleared when
//   `dismissedHints` is emptied (settings reset); a counter already at its limit for an action that
//   is not dismissed (stale after a reset done outside the app) starts over.
import { useCallback } from "react";
import i18n from "../i18n";
import type { ShortcutAction } from "../keys/actions";
import { formatKeys } from "../keys/keybindings";
import { isMacPlatform } from "../keys/platform";
import { useKeyMap } from "../keys/useKeyMap";
import { useSettingsStore } from "../stores/settings";

export const HINT_IMPRESSIONS_TO_LEARN = 3;
export const HINT_KEY_USES_TO_LEARN = 2;

/** Actions that have a hinted toolbar button (the only ones whose hints are counted). */
export const HINTED_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  "preset.slot",
  "tool.eraser",
  "tool.shape",
  "tool.connector",
  "tool.text",
  "tool.cursor",
  "tool.lasso",
  "tool.insertSpace",
  "undo",
  "redo",
  "zoom.in",
  "zoom.out",
  "zoom.reset",
]);
const STORAGE_KEY = "mate.shortcutHintCounts";

interface Counts {
  seen: number;
  used: number;
}

let counts: Record<string, Counts> | null = null;

function load(): Record<string, Counts> {
  if (counts) return counts;
  counts = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") counts = parsed as Record<string, Counts>;
  } catch {
    // storage unavailable: count in memory only
  }
  return counts;
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(counts ?? {}));
  } catch {
    // ignore
  }
}

/** Forget the impression/use counters (tests; a settings reset clears `dismissedHints`). */
export function resetHintCounters(): void {
  counts = {};
  save();
}

/** True when the hint for `action` is shown under the given settings. */
export function hintVisible(mode: string, dismissed: Readonly<Record<string, boolean>> | undefined, action: ShortcutAction): boolean {
  if (mode === "never") return false;
  if (mode === "adaptive") return !dismissed?.[action];
  return true;
}

function bump(action: ShortcutAction, field: keyof Counts, limit: number): void {
  const st = useSettingsStore.getState();
  const { shortcutHintMode, dismissedHints } = st.settings;
  if (shortcutHintMode !== "adaptive" || dismissedHints?.[action]) return;
  const all = load();
  let c = (all[action] ??= { seen: 0, used: 0 });
  if (c.seen >= HINT_IMPRESSIONS_TO_LEARN || c.used >= HINT_KEY_USES_TO_LEARN) c = all[action] = { seen: 0, used: 0 };
  c[field] += 1;
  save();
  if (c[field] >= limit) {
    st.update({ dismissedHints: { ...dismissedHints, [action]: true } }).catch((err) =>
      console.error("saving dismissed hints failed", err),
    );
  }
}

/** The hint for `action` was shown (pointer entered or focus reached its button). */
export const noteHintImpression = (action: ShortcutAction): void => bump(action, "seen", HINT_IMPRESSIONS_TO_LEARN);

/** The keyboard shortcut for `action` was used. */
export const noteShortcutUse = (action: ShortcutAction): void => {
  if (HINTED_ACTIONS.has(action)) bump(action, "used", HINT_KEY_USES_TO_LEARN);
};

// A settings reset empties dismissedHints: forget the counters too.
useSettingsStore.subscribe((state, prev) => {
  const next = state.settings.dismissedHints;
  const before = prev.settings.dismissedHints;
  if (next !== before && Object.keys(next ?? {}).length === 0 && Object.keys(before ?? {}).length > 0) resetHintCounters();
});

/** A combo in `aria-keyshortcuts` syntax ("Ctrl+Shift+Z" -> "Control+Shift+Z", Meta on macOS). */
export function ariaKeys(keys: string, mac: boolean = isMacPlatform()): string {
  return keys
    .split("+")
    .map((k) => (k === "Ctrl" ? (mac ? "Meta" : "Control") : k))
    .join("+");
}

/** Tooltip text: `label (keys)` when the hint is visible and the action has a key, else `label`. */
export function hintTitle(label: string, keys: readonly string[] | undefined, visible: boolean, mac: boolean = isMacPlatform()): string {
  const k = keys?.[0];
  return visible && k ? i18n.t("toolbar.hintWithKeys", { label, keys: formatKeys(k, mac) }) : label;
}

/** Props for a toolbar button with a shortcut hint: tooltip, aria-keyshortcuts and impression tracking. */
export function useShortcutHint(
  action: ShortcutAction,
  label: string,
  opts: { decorate?: (title: string) => string; keyIndex?: number } = {},
) {
  const map = useKeyMap();
  const mode = useSettingsStore((s) => s.settings.shortcutHintMode);
  const dismissed = useSettingsStore((s) => s.settings.dismissedHints);
  const visible = hintVisible(mode, dismissed, action);
  const all = map[action];
  const keys = opts.keyIndex !== undefined ? all?.slice(opts.keyIndex, opts.keyIndex + 1) : all;
  const onSeen = useCallback(() => {
    if (visible) noteHintImpression(action);
  }, [visible, action]);
  return {
    title: opts.decorate ? opts.decorate(hintTitle(label, keys, visible)) : hintTitle(label, keys, visible),
    "aria-keyshortcuts": keys?.[0] ? ariaKeys(keys[0]) : undefined,
    onPointerEnter: onSeen,
    onFocus: onSeen,
  };
}
