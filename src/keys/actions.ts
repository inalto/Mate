// The closed set of keyboard actions, their labels, areas and default key combos.
// Combos are canonical strings, e.g. "Ctrl+Shift+Z" (`Ctrl` is Cmd on macOS): see keybindings.ts.

export type ShortcutAction =
  | "tool.pen"
  | "tool.highlighter"
  | "tool.eraser"
  | "tool.cursor"
  | "tool.lasso"
  | "tool.shape"
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
  | "zoom.in"
  | "zoom.out"
  | "zoom.reset"
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

export type ActionGroup = "Tools" | "Edit" | "Selection" | "Arrange" | "View" | "Pages" | "Tabs and windows" | "General";

export interface ActionMeta {
  label: string;
  group: ActionGroup;
  defaultKeys: string[];
  /** False for actions whose keys are fixed (a family of combos, or a held key). */
  rebindable?: boolean;
}

export const ACTION_META: Record<ShortcutAction, ActionMeta> = {
  "tool.pen": { label: "Pen", group: "Tools", defaultKeys: ["P"] },
  "tool.highlighter": { label: "Highlighter", group: "Tools", defaultKeys: ["H"] },
  "tool.eraser": { label: "Eraser", group: "Tools", defaultKeys: ["E"] },
  "tool.cursor": { label: "Select (cursor)", group: "Tools", defaultKeys: ["V"] },
  "tool.lasso": { label: "Lasso", group: "Tools", defaultKeys: ["L"] },
  "tool.shape": { label: "Shape", group: "Tools", defaultKeys: ["S"] },
  "tool.text": { label: "Text", group: "Tools", defaultKeys: ["T"] },
  "tool.insertSpace": { label: "Insert space", group: "Tools", defaultKeys: ["N"] },
  "preset.slot": {
    label: "Preset 1 to 9",
    group: "Tools",
    defaultKeys: Array.from({ length: 9 }, (_, i) => `Alt+${i + 1}`),
    rebindable: false,
  },
  pan: { label: "Pan (hold)", group: "Tools", defaultKeys: ["Space"], rebindable: false },
  undo: { label: "Undo", group: "Edit", defaultKeys: ["Ctrl+Z"] },
  redo: { label: "Redo", group: "Edit", defaultKeys: ["Ctrl+Shift+Z", "Ctrl+Y"] },
  copy: { label: "Copy", group: "Edit", defaultKeys: ["Ctrl+C"] },
  cut: { label: "Cut", group: "Edit", defaultKeys: ["Ctrl+X"] },
  paste: { label: "Paste", group: "Edit", defaultKeys: ["Ctrl+V"] },
  duplicate: { label: "Duplicate selection (or page)", group: "Edit", defaultKeys: ["Ctrl+D"] },
  delete: { label: "Delete", group: "Edit", defaultKeys: ["Delete", "Backspace"] },
  save: { label: "Save now", group: "Edit", defaultKeys: ["Ctrl+S"] },
  escape: { label: "Clear selection", group: "Selection", defaultKeys: ["Escape"], rebindable: false },
  selectAll: { label: "Select all", group: "Selection", defaultKeys: ["Ctrl+A"] },
  deselect: { label: "Deselect", group: "Selection", defaultKeys: ["Ctrl+Shift+A"] },
  group: { label: "Group", group: "Selection", defaultKeys: ["Ctrl+G"] },
  ungroup: { label: "Ungroup", group: "Selection", defaultKeys: ["Ctrl+Shift+G"] },
  "arrange.forward": { label: "Bring forward", group: "Arrange", defaultKeys: ["Ctrl+]"] },
  "arrange.backward": { label: "Send backward", group: "Arrange", defaultKeys: ["Ctrl+["] },
  "arrange.front": { label: "Bring to front", group: "Arrange", defaultKeys: ["Ctrl+Shift+]"] },
  "arrange.back": { label: "Send to back", group: "Arrange", defaultKeys: ["Ctrl+Shift+["] },
  "zoom.in": { label: "Zoom in", group: "View", defaultKeys: ["Ctrl+=", "Ctrl+Shift+="] },
  "zoom.out": { label: "Zoom out", group: "View", defaultKeys: ["Ctrl+-"] },
  "zoom.reset": { label: "Reset zoom", group: "View", defaultKeys: ["Ctrl+0"] },
  "sidebar.toggle": { label: "Toggle sidebar", group: "View", defaultKeys: ["Ctrl+\\"] },
  "page.prev": { label: "Previous page", group: "Pages", defaultKeys: ["Ctrl+PageUp"] },
  "page.next": { label: "Next page", group: "Pages", defaultKeys: ["Ctrl+PageDown"] },
  "page.duplicate": { label: "Duplicate page", group: "Pages", defaultKeys: [] },
  "page.rename": { label: "Rename page", group: "Pages", defaultKeys: ["F2"] },
  "page.move.up": { label: "Move page up", group: "Pages", defaultKeys: ["Alt+ArrowUp"] },
  "page.move.down": { label: "Move page down", group: "Pages", defaultKeys: ["Alt+ArrowDown"] },
  "page.promote": { label: "Promote page", group: "Pages", defaultKeys: ["Alt+ArrowLeft"] },
  "page.demote": { label: "Demote page", group: "Pages", defaultKeys: ["Alt+ArrowRight"] },
  "tab.new": { label: "New tab", group: "Tabs and windows", defaultKeys: ["Ctrl+T"] },
  "tab.close": { label: "Close tab", group: "Tabs and windows", defaultKeys: ["Ctrl+W"] },
  "tab.move.left": { label: "Move tab left", group: "Tabs and windows", defaultKeys: ["Alt+Shift+ArrowLeft"] },
  "tab.move.right": { label: "Move tab right", group: "Tabs and windows", defaultKeys: ["Alt+Shift+ArrowRight"] },
  "window.openPage": { label: "Open page in new window", group: "Tabs and windows", defaultKeys: ["Ctrl+Shift+N"] },
  "palette.open": { label: "Search and actions", group: "General", defaultKeys: ["Ctrl+K"] },
  "help.shortcuts": { label: "Keyboard shortcuts", group: "General", defaultKeys: ["?"] },
};

export const ACTIONS = Object.keys(ACTION_META) as ShortcutAction[];

export const ACTION_GROUPS: ActionGroup[] = [
  "Tools",
  "Edit",
  "Selection",
  "Arrange",
  "View",
  "Pages",
  "Tabs and windows",
  "General",
];

export const isShortcutAction = (v: unknown): v is ShortcutAction =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(ACTION_META, v);
