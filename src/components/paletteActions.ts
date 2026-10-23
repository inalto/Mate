// Quick actions for the command palette: what is offered, how it is ranked and how it runs.
// Shortcut-backed actions run through runEditorShortcut, the same path the keyboard uses.
import { screenToWorld } from "../canvas/camera";
import { pickAndInsertImage } from "../images/insert";
import { runEditorShortcut } from "../keys/editorCommands";
import { ACTION_META, type ShortcutAction } from "../keys/actions";
import { getFocusedEditor } from "../stores/focusedEditor";
import { useNotebookStore } from "../stores/notebook";
import { focusedPageId, useTabsStore } from "../stores/tabs";

/** selection: editor with a non-empty selection; editor: needs the editor route; page: needs an open page; global: always available. */
export type QuickScope = "editor" | "selection" | "page" | "global";

export interface QuickAction {
  id: string;
  label: string;
  synonyms: string[];
  scope: QuickScope;
  /** The shortcut whose binding is shown, if any. */
  shortcut?: ShortcutAction;
  run(navigate: (to: string) => void): void;
}

const viaKeys = (a: ShortcutAction) => () => runEditorShortcut(a, {});
const editor = () => getFocusedEditor().getState();

function insert(f: (s: ReturnType<typeof editor>) => unknown) {
  return () => {
    f(editor());
  };
}

function switchTo(a: ShortcutAction, synonyms: string[] = []): QuickAction {
  const name = ACTION_META[a].label.toLowerCase();
  return { id: a, label: `Switch to ${name}`, synonyms: [name, "tool", ...synonyms], scope: "editor", shortcut: a, run: viaKeys(a) };
}

function plain(a: ShortcutAction, scope: QuickScope, synonyms: string[] = []): QuickAction {
  return { id: a, label: ACTION_META[a].label, synonyms, scope, shortcut: a, run: viaKeys(a) };
}

function currentSection(): { sectionId: string; unitId: string } | null {
  const id = focusedPageId(useTabsStore.getState());
  const tree = useNotebookStore.getState().tree;
  const sectionId = tree.pages.find((p) => p.id === id)?.sectionId;
  const section = tree.sections.find((s) => s.id === sectionId);
  return section ? { sectionId: section.id, unitId: section.unitId } : null;
}

export const QUICK_ACTIONS: QuickAction[] = [
  switchTo("tool.pen", ["ink", "draw", "write"]),
  switchTo("tool.highlighter", ["marker"]),
  switchTo("tool.eraser", ["rubber"]),
  switchTo("tool.cursor", ["select", "pointer"]),
  switchTo("tool.lasso", ["select"]),
  switchTo("tool.shape", ["rectangle", "circle", "line"]),
  switchTo("tool.text", ["type"]),
  switchTo("tool.insertSpace", ["gap"]),
  plain("zoom.in", "editor", ["magnify"]),
  plain("zoom.out", "editor", ["shrink"]),
  plain("zoom.reset", "editor", ["100%", "actual size"]),
  plain("selectAll", "editor"),
  plain("group", "selection"),
  plain("ungroup", "selection"),
  plain("save", "editor", ["flush"]),
  {
    id: "insert.text",
    label: "Insert text box",
    synonyms: ["add", "text"],
    scope: "editor",
    run: insert((s) => s.addTextBox(screenToWorld(s.camera, { x: s.viewport.width / 2, y: s.viewport.height / 2 }))),
  },
  { id: "insert.code", label: "Insert code block", synonyms: ["add", "codespace"], scope: "editor", run: insert((s) => s.addCodespace()) },
  { id: "insert.table", label: "Insert table", synonyms: ["add", "grid"], scope: "editor", run: insert((s) => s.addTable()) },
  { id: "insert.graph", label: "Insert graph", synonyms: ["add", "plot", "chart"], scope: "editor", run: insert((s) => s.addGraph()) },
  { id: "insert.image", label: "Insert image", synonyms: ["add", "picture", "photo"], scope: "editor", run: () => void pickAndInsertImage() },
  {
    id: "page.new",
    label: "New page",
    synonyms: ["create", "add page"],
    scope: "page",
    run: (navigate) => {
      const cur = currentSection();
      if (cur) void useNotebookStore.getState().createPage(cur.sectionId, `Page ${useNotebookStore.getState().tree.pages.filter((p) => p.sectionId === cur.sectionId).length + 1}`).then((p) => navigate(`/edit/${p.id}`));
    },
  },
  {
    id: "section.new",
    label: "New section",
    synonyms: ["create", "add section"],
    scope: "page",
    run: (navigate) => {
      const cur = currentSection();
      if (!cur) return;
      const nb = useNotebookStore.getState();
      void nb
        .createSection(cur.unitId, `Section ${useNotebookStore.getState().tree.sections.filter((x) => x.unitId === cur.unitId).length + 1}`)
        .then((sec) => nb.createPage(sec.id, "Page 1"))
        .then((p) => navigate(`/edit/${p.id}`));
    },
  },
  plain("window.openPage", "page", ["window", "detach"]),
  plain("help.shortcuts", "global", ["keys", "keyboard", "help"]),
  { id: "go.settings", label: "Open settings", synonyms: ["preferences", "options"], scope: "global", run: (n) => n("/settings") },
  { id: "go.library", label: "Open library", synonyms: ["books", "notebooks"], scope: "global", run: (n) => n("/library") },
];

/**
 * A page window shows one page: actions that navigate elsewhere (settings, library, a new page or
 * section) or open the page in a window again are not offered there.
 */
const NOT_IN_PAGE_WINDOW = new Set(["page.new", "section.new", "window.openPage", "go.settings", "go.library"]);
export const availableInPageWindow = (a: QuickAction): boolean => !NOT_IN_PAGE_WINDOW.has(a.id);

/** Hint shown on a disabled action. */
export const DISABLED_HINT: Record<Exclude<QuickScope, "global">, string> = {
  editor: "Open a page in the editor first",
  selection: "Select something first",
  page: "Open a page first",
};

/** Fuzzy score of `q` against `text` (higher is better, 0 = no match): prefix > word start > substring > subsequence. */
export function fuzzyScore(q: string, text: string): number {
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 100;
  const at = t.indexOf(q);
  if (at >= 0) return t[at - 1] === " " ? 80 : 60;
  let j = 0;
  for (const c of t) if (c === q[j]) j++;
  return j === q.length ? 20 : 0;
}

/** Best score over the label (full weight) and synonyms (slightly less). */
export function actionScore(q: string, a: QuickAction): number {
  const best = Math.max(fuzzyScore(q, a.label), ...a.synonyms.map((s) => fuzzyScore(q, s) * 0.8));
  return best;
}
