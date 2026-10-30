// The closed set of keyboard actions, their labels, areas and default key combos.
// Combos are canonical strings, e.g. "Ctrl+Shift+Z" (`Ctrl` is Cmd on macOS): see keybindings.ts.
import i18n, { type TKey } from "../i18n";

export type ShortcutAction =
  | "tool.pen"
  | "tool.highlighter"
  | "tool.eraser"
  | "tool.cursor"
  | "tool.lasso"
  | "tool.shape"
  | "tool.connector"
  | "tool.frame"
  | "tool.note"
  | "tool.mindmap"
  | "tool.text"
  | "tool.insertSpace"
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
  | "deselect"
  | "group"
  | "ungroup"
  | "save"
  | "arrange.forward"
  | "arrange.backward"
  | "arrange.front"
  | "arrange.back"
  | "arrange.lock"
  | "zoom.in"
  | "zoom.out"
  | "zoom.reset"
  | "zoom.fit"
  | "zoom.selection"
  | "present.start"
  | "pan"
  | "page.prev"
  | "page.next"
  | "page.duplicate"
  | "page.rename"
  | "page.move.up"
  | "page.move.down"
  | "page.promote"
  | "page.demote"
  | "tab.new"
  | "tab.close"
  | "tab.move.left"
  | "tab.move.right"
  | "sidebar.toggle"
  | "window.openPage"
  | "palette.open"
  | "help.shortcuts";

export type ActionGroup = "tools" | "edit" | "selection" | "arrange" | "view" | "pages" | "tabs" | "general";

export interface ActionMeta {
  /** Catalogue key of the label (resolved when shown, so it follows the interface language). */
  labelKey: TKey;
  group: ActionGroup;
  defaultKeys: string[];
  /** False for actions whose keys are fixed (a family of combos, or a held key). */
  rebindable?: boolean;
}

export const ACTION_META: Record<ShortcutAction, ActionMeta> = {
  "tool.pen": { labelKey: "keys.actions.pen", group: "tools", defaultKeys: ["P"] },
  "tool.highlighter": { labelKey: "keys.actions.highlighter", group: "tools", defaultKeys: ["H"] },
  "tool.eraser": { labelKey: "keys.actions.eraser", group: "tools", defaultKeys: ["E"] },
  "tool.cursor": { labelKey: "keys.actions.cursor", group: "tools", defaultKeys: ["V"] },
  "tool.lasso": { labelKey: "keys.actions.lasso", group: "tools", defaultKeys: ["L"] },
  "tool.shape": { labelKey: "keys.actions.shape", group: "tools", defaultKeys: ["S"] },
  "tool.connector": { labelKey: "keys.actions.connector", group: "tools", defaultKeys: ["C"] },
  "tool.frame": { labelKey: "keys.actions.frame", group: "tools", defaultKeys: ["F"] },
  "tool.note": { labelKey: "keys.actions.note", group: "tools", defaultKeys: ["Shift+N"] },
  "tool.mindmap": { labelKey: "keys.actions.mindmap", group: "tools", defaultKeys: ["M"] },
  "tool.text": { labelKey: "keys.actions.text", group: "tools", defaultKeys: ["T"] },
  "tool.insertSpace": { labelKey: "keys.actions.insertSpace", group: "tools", defaultKeys: ["N"] },
  "preset.slot": {
    labelKey: "keys.actions.presetSlot",
    group: "tools",
    defaultKeys: Array.from({ length: 9 }, (_, i) => `Alt+${i + 1}`),
    rebindable: false,
  },
  pan: { labelKey: "keys.actions.pan", group: "tools", defaultKeys: ["Space"], rebindable: false },
  undo: { labelKey: "keys.actions.undo", group: "edit", defaultKeys: ["Ctrl+Z"] },
  redo: { labelKey: "keys.actions.redo", group: "edit", defaultKeys: ["Ctrl+Shift+Z", "Ctrl+Y"] },
  copy: { labelKey: "keys.actions.copy", group: "edit", defaultKeys: ["Ctrl+C"] },
  cut: { labelKey: "keys.actions.cut", group: "edit", defaultKeys: ["Ctrl+X"] },
  paste: { labelKey: "keys.actions.paste", group: "edit", defaultKeys: ["Ctrl+V"] },
  duplicate: { labelKey: "keys.actions.duplicate", group: "edit", defaultKeys: ["Ctrl+D"] },
  delete: { labelKey: "keys.actions.delete", group: "edit", defaultKeys: ["Delete", "Backspace"] },
  save: { labelKey: "keys.actions.save", group: "edit", defaultKeys: ["Ctrl+S"] },
  escape: { labelKey: "keys.actions.escape", group: "selection", defaultKeys: ["Escape"], rebindable: false },
  selectAll: { labelKey: "keys.actions.selectAll", group: "selection", defaultKeys: ["Ctrl+A"] },
  deselect: { labelKey: "keys.actions.deselect", group: "selection", defaultKeys: ["Ctrl+Shift+A"] },
  group: { labelKey: "keys.actions.group", group: "selection", defaultKeys: ["Ctrl+G"] },
  ungroup: { labelKey: "keys.actions.ungroup", group: "selection", defaultKeys: ["Ctrl+Shift+G"] },
  "arrange.forward": { labelKey: "keys.actions.bringForward", group: "arrange", defaultKeys: ["Ctrl+]"] },
  "arrange.backward": { labelKey: "keys.actions.sendBackward", group: "arrange", defaultKeys: ["Ctrl+["] },
  "arrange.front": { labelKey: "keys.actions.bringToFront", group: "arrange", defaultKeys: ["Ctrl+Shift+]"] },
  "arrange.back": { labelKey: "keys.actions.sendToBack", group: "arrange", defaultKeys: ["Ctrl+Shift+["] },
  "arrange.lock": { labelKey: "keys.actions.toggleLock", group: "arrange", defaultKeys: ["Ctrl+Shift+L"] },
  "zoom.in": { labelKey: "keys.actions.zoomIn", group: "view", defaultKeys: ["Ctrl+=", "Ctrl+Shift+="] },
  "zoom.out": { labelKey: "keys.actions.zoomOut", group: "view", defaultKeys: ["Ctrl+-"] },
  "zoom.reset": { labelKey: "keys.actions.zoomReset", group: "view", defaultKeys: ["Ctrl+0"] },
  "zoom.fit": { labelKey: "keys.actions.zoomFit", group: "view", defaultKeys: ["Shift+1"] },
  "zoom.selection": { labelKey: "keys.actions.zoomSelection", group: "view", defaultKeys: ["Shift+2"] },
  "present.start": { labelKey: "keys.actions.presentStart", group: "view", defaultKeys: ["Ctrl+Shift+P"] },
  "sidebar.toggle": { labelKey: "keys.actions.toggleSidebar", group: "view", defaultKeys: ["Ctrl+\\"] },
  "page.prev": { labelKey: "keys.actions.prevPage", group: "pages", defaultKeys: ["Ctrl+PageUp"] },
  "page.next": { labelKey: "keys.actions.nextPage", group: "pages", defaultKeys: ["Ctrl+PageDown"] },
  "page.duplicate": { labelKey: "keys.actions.duplicatePage", group: "pages", defaultKeys: [] },
  "page.rename": { labelKey: "keys.actions.renamePage", group: "pages", defaultKeys: ["F2"] },
  "page.move.up": { labelKey: "keys.actions.movePageUp", group: "pages", defaultKeys: ["Alt+ArrowUp"] },
  "page.move.down": { labelKey: "keys.actions.movePageDown", group: "pages", defaultKeys: ["Alt+ArrowDown"] },
  "page.promote": { labelKey: "keys.actions.promotePage", group: "pages", defaultKeys: ["Alt+ArrowLeft"] },
  "page.demote": { labelKey: "keys.actions.demotePage", group: "pages", defaultKeys: ["Alt+ArrowRight"] },
  "tab.new": { labelKey: "keys.actions.newTab", group: "tabs", defaultKeys: ["Ctrl+T"] },
  "tab.close": { labelKey: "keys.actions.closeTab", group: "tabs", defaultKeys: ["Ctrl+W"] },
  "tab.move.left": { labelKey: "keys.actions.moveTabLeft", group: "tabs", defaultKeys: ["Alt+Shift+ArrowLeft"] },
  "tab.move.right": { labelKey: "keys.actions.moveTabRight", group: "tabs", defaultKeys: ["Alt+Shift+ArrowRight"] },
  "window.openPage": { labelKey: "keys.actions.openPageWindow", group: "tabs", defaultKeys: ["Ctrl+Shift+N"] },
  "palette.open": { labelKey: "keys.actions.palette", group: "general", defaultKeys: ["Ctrl+K"] },
  "help.shortcuts": { labelKey: "keys.actions.shortcuts", group: "general", defaultKeys: ["?"] },
};

export const ACTIONS = Object.keys(ACTION_META) as ShortcutAction[];

export const ACTION_GROUPS: ActionGroup[] = ["tools", "edit", "selection", "arrange", "view", "pages", "tabs", "general"];

/** The label of `a` in the interface language. */
export const actionLabel = (a: ShortcutAction): string => i18n.t(ACTION_META[a].labelKey);

/** The heading of a group of actions in the interface language. */
export const groupLabel = (g: ActionGroup): string => i18n.t(`keys.groups.${g}`);

export const isShortcutAction = (v: unknown): v is ShortcutAction =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(ACTION_META, v);
