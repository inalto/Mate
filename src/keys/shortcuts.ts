// Data-driven keyboard shortcuts. `mod` means Ctrl, or Cmd on macOS. Bindings match on `code`
// (physical key: digits, brackets, =/-) or `key` (layout-aware letters, case-insensitive).

export type ShortcutAction =
  | "tool.pen"
  | "tool.highlighter"
  | "tool.eraser"
  | "tool.cursor"
  | "tool.lasso"
  | "tool.shape"
  | "tool.text"
  | "preset.slot"
  | "undo"
  | "redo"
  | "copy"
  | "cut"
  | "paste"
  | "duplicate"
  | "delete"
  | "escape"
  | "selectAll"
  | "bringForward"
  | "sendBackward"
  | "toFront"
  | "toBack"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "pan"
  | "tab.new"
  | "tab.close"
  | "tab.moveLeft"
  | "tab.moveRight"
  | "sidebar.toggle"
  | "page.rename"
  | "page.moveUp"
  | "page.moveDown"
  | "page.promote"
  | "page.demote";

export interface ShortcutBinding {
  action: ShortcutAction;
  key?: string;
  code?: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
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

export const DEFAULT_SHORTCUTS: ShortcutMap = [
  { action: "tool.pen", key: "p" },
  { action: "tool.highlighter", key: "h" },
  { action: "tool.eraser", key: "e" },
  { action: "tool.cursor", key: "v" },
  { action: "tool.lasso", key: "l" },
  { action: "tool.shape", key: "s" },
  { action: "tool.text", key: "t" },
  ...Array.from({ length: 9 }, (_, i): ShortcutBinding => ({
    action: "preset.slot",
    code: `Digit${i + 1}`,
    alt: true,
    slot: i + 1,
  })),
  { action: "undo", key: "z", mod: true },
  { action: "redo", key: "z", mod: true, shift: true },
  { action: "redo", key: "y", mod: true },
  { action: "copy", key: "c", mod: true },
  { action: "cut", key: "x", mod: true },
  { action: "paste", key: "v", mod: true },
  { action: "duplicate", key: "d", mod: true },
  { action: "delete", key: "Delete" },
  { action: "delete", key: "Backspace" },
  { action: "escape", key: "Escape" },
  { action: "selectAll", key: "a", mod: true },
  { action: "bringForward", code: "BracketRight", mod: true },
  { action: "sendBackward", code: "BracketLeft", mod: true },
  { action: "toFront", code: "BracketRight", mod: true, shift: true },
  { action: "toBack", code: "BracketLeft", mod: true, shift: true },
  { action: "zoomIn", code: "Equal", mod: true },
  { action: "zoomIn", code: "Equal", mod: true, shift: true },
  { action: "zoomIn", code: "NumpadAdd", mod: true },
  { action: "zoomOut", code: "Minus", mod: true },
  { action: "zoomOut", code: "NumpadSubtract", mod: true },
  { action: "zoomReset", code: "Digit0", mod: true },
  { action: "zoomReset", code: "Numpad0", mod: true },
  { action: "pan", code: "Space", hold: true },
  { action: "tab.new", key: "t", mod: true },
  { action: "tab.close", key: "w", mod: true },
  { action: "tab.moveLeft", key: "ArrowLeft", alt: true, shift: true },
  { action: "tab.moveRight", key: "ArrowRight", alt: true, shift: true },
  { action: "sidebar.toggle", code: "Backslash", mod: true },
  { action: "page.rename", key: "F2" },
  { action: "page.moveUp", key: "ArrowUp", alt: true },
  { action: "page.moveDown", key: "ArrowDown", alt: true },
  { action: "page.promote", key: "ArrowLeft", alt: true },
  { action: "page.demote", key: "ArrowRight", alt: true },
];

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad/i.test(uad?.platform || navigator.platform || "");
}

/** Input types that take typed text; sliders, checkboxes, radios, colour pickers and buttons do not. */
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

/** True for events aimed at text entry (text-like inputs, textareas, selects, contenteditable). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has((t.getAttribute("type") ?? "").toLowerCase());
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  const ce = t.closest("[contenteditable]");
  return t.isContentEditable || (ce !== null && ce.getAttribute("contenteditable") !== "false");
}

export function matchShortcut(map: ShortcutMap, e: KeyboardEvent, mac: boolean): ShortcutBinding | null {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  if (otherMod) return null;
  for (const b of map) {
    if (b.code !== undefined ? e.code !== b.code : (e.key ?? "").toLowerCase() !== b.key?.toLowerCase()) continue;
    if (b.hold) return b; // held keys ignore modifiers
    if (!!b.mod !== mod || !!b.shift !== e.shiftKey || !!b.alt !== e.altKey) continue;
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
