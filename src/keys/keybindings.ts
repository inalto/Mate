// Key-combo strings ("Ctrl+Shift+Z"), the effective action -> keys map and collision/reserved rules.
// `Ctrl` stands for the platform modifier: Ctrl, or Cmd on macOS.
import { ACTION_META, ACTIONS, isShortcutAction, type ShortcutAction } from "./actions";
import { isMacPlatform } from "./platform";
import type { ShortcutBinding, ShortcutMap } from "./shortcuts";

/**
 * A user override as stored in `settings.keybindings`. `keys` is one combo ("Ctrl+Shift+K") or several
 * separated by spaces; an empty string means "unbound".
 */
export interface KeyOverride {
  action: string;
  keys: string;
}

export type KeyMap = Record<ShortcutAction, string[]>;

const MODS = ["Ctrl", "Alt", "Shift"] as const;

interface Parsed {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function parse(keys: string): Parsed {
  const out: Parsed = { ctrl: false, alt: false, shift: false, key: "" };
  let rest = keys.trim();
  for (;;) {
    const m = /^(ctrl|control|cmd|mod|alt|option|shift)\+(?=.)/i.exec(rest);
    if (!m) break;
    const t = m[1].toLowerCase();
    if (t === "alt" || t === "option") out.alt = true;
    else if (t === "shift") out.shift = true;
    else out.ctrl = true;
    rest = rest.slice(m[0].length);
  }
  out.key = canonicalKey(rest);
  return out;
}

const NAMED: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  del: "Delete",
  delete: "Delete",
  backspace: "Backspace",
  tab: "Tab",
  enter: "Enter",
  return: "Enter",
  space: "Space",
  " ": "Space",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  insert: "Insert",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
};

function canonicalKey(k: string): string {
  const named = NAMED[k.toLowerCase()];
  if (named) return named;
  if (/^f\d{1,2}$/i.test(k)) return k.toUpperCase();
  if (k.length === 1) return k.toUpperCase();
  return k;
}

/** Canonical spelling: modifiers in the order Ctrl, Alt, Shift, then the key. */
export function normalizeKeys(keys: string): string {
  const p = parse(keys);
  return [...MODS.filter((m) => p[m.toLowerCase() as "ctrl" | "alt" | "shift"]), p.key].join("+");
}

const same = (a: string, b: string) => normalizeKeys(a) === normalizeKeys(b);

const isLetterOrDigit = (k: string) => /^[A-Z0-9]$/.test(k);

/**
 * Combos that cannot be bound: Esc, Tab and Enter (they have fixed jobs), Space with no modifier, and
 * any bare letter or digit (it would fire while typing).
 */
export function isReservedCombo(keys: string): boolean {
  const p = parse(keys);
  if (p.key === "Escape" || p.key === "Tab" || p.key === "Enter") return true;
  const bare = !p.ctrl && !p.alt;
  if (p.key === "Space") return true; // Space is the pan key: any combination with it would be taken by pan
  return bare && isLetterOrDigit(p.key);
}

/** Overrides applied over the defaults. Unknown actions are ignored; the last entry per action wins. */
export function effectiveMap(overrides: readonly KeyOverride[] | null | undefined): KeyMap {
  const map = {} as KeyMap;
  for (const a of ACTIONS) map[a] = ACTION_META[a].defaultKeys.map(normalizeKeys);
  for (const o of overrides ?? []) {
    if (!o || !isShortcutAction(o.action) || typeof o.keys !== "string") continue;
    if (ACTION_META[o.action].rebindable === false) continue;
    map[o.action] = o.keys.split(/\s+/).filter((k) => k !== "").map(normalizeKeys);
  }
  return map;
}

/** The action (other than `excludeAction`) that already uses `keys`, or null. */
export function findCollision(map: KeyMap, keys: string, excludeAction?: ShortcutAction): ShortcutAction | null {
  for (const a of ACTIONS) {
    if (a === excludeAction) continue;
    if (map[a].some((k) => same(k, keys))) return a;
  }
  return null;
}

/** Overrides to store: only actions whose keys differ from the defaults. */
export function toOverrides(map: KeyMap): KeyOverride[] {
  const out: KeyOverride[] = [];
  for (const a of ACTIONS) {
    const def = ACTION_META[a].defaultKeys.map(normalizeKeys);
    if (def.length !== map[a].length || def.some((k, i) => k !== map[a][i])) out.push({ action: a, keys: map[a].join(" ") });
  }
  return out;
}

// --- events <-> combos --------------------------------------------------------------------------

/** Physical keys whose token is layout independent (digits and punctuation). */
const CODE_TOKEN: Record<string, string> = {
  BracketRight: "]",
  BracketLeft: "[",
  Equal: "=",
  NumpadAdd: "=",
  Minus: "-",
  NumpadSubtract: "-",
  Backslash: "\\",
  Numpad0: "0",
};
const TOKEN_CODES: Record<string, string[]> = {
  "]": ["BracketRight"],
  "[": ["BracketLeft"],
  "=": ["Equal", "NumpadAdd"],
  "-": ["Minus", "NumpadSubtract"],
  "\\": ["Backslash"],
  "0": ["Digit0", "Numpad0"],
};

/** Characters that need Shift on common layouts: bound by character, whatever Shift says. */
const SHIFTED_CHARS = new Set(["?"]);

const PURE_MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "OS"]);

/** The combo string for a keydown, or null for a bare modifier key (or an unsupported Ctrl on macOS). */
export function parseKeyEvent(e: KeyboardEvent, mac: boolean = isMacPlatform()): string | null {
  if (PURE_MODIFIERS.has(e.key)) return null;
  if (mac ? e.ctrlKey : e.metaKey) return null;
  const ctrl = mac ? e.metaKey : e.ctrlKey;
  const code = e.code ?? "";
  let key: string;
  if (CODE_TOKEN[code]) key = CODE_TOKEN[code];
  else if (/^Digit[1-9]$/.test(code)) key = code.slice(5);
  else if (e.key && e.key.length === 1 && e.key !== " ") key = e.key.toUpperCase();
  else key = canonicalKey(e.key === " " ? "Space" : (e.key ?? ""));
  if (!key) return null;
  const shift = e.shiftKey && !SHIFTED_CHARS.has(key);
  return normalizeKeys([ctrl && "Ctrl", e.altKey && "Alt", shift && "Shift", key].filter(Boolean).join("+") || key);
}

/** Display text: "Ctrl+Shift+Z", or glyphs on macOS ("⇧⌘Z"). */
export function formatKeys(keys: string, mac: boolean): string {
  const p = parse(keys);
  const key = (
    { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc", Delete: "Del" } as Record<string, string>
  )[p.key] ?? p.key;
  if (mac) return `${p.alt ? "⌥" : ""}${p.shift ? "⇧" : ""}${p.ctrl ? "⌘" : ""}${key}`;
  return [p.ctrl && "Ctrl", p.alt && "Alt", p.shift && "Shift", key].filter(Boolean).join("+");
}

// --- combos -> bindings -------------------------------------------------------------------------

/** The matchable bindings for one action's keys (a combo may need several physical codes). */
export function bindingsFor(action: ShortcutAction, keys: readonly string[]): ShortcutBinding[] {
  const out: ShortcutBinding[] = [];
  for (const k of keys) {
    const p = parse(k);
    const base: ShortcutBinding = { action };
    if (p.ctrl) base.mod = true;
    if (p.shift) base.shift = true;
    if (p.alt) base.alt = true;
    if (action === "pan") base.hold = true;
    if (action === "preset.slot") base.slot = Number(p.key);
    if (p.key === "Space") out.push({ ...base, code: "Space" });
    else if (/^[1-9]$/.test(p.key)) out.push({ ...base, code: `Digit${p.key}` });
    else if (TOKEN_CODES[p.key]) for (const code of TOKEN_CODES[p.key]) out.push({ ...base, code });
    else if (SHIFTED_CHARS.has(p.key)) out.push({ ...base, shift: undefined, key: p.key, anyShift: true });
    else out.push({ ...base, key: p.key });
  }
  return out;
}

/** The full matcher list for a key map. */
export function shortcutMapFor(map: KeyMap): ShortcutMap {
  return ACTIONS.flatMap((a) => bindingsFor(a, map[a]));
}
