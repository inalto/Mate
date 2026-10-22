// The app's box editors, registered lazily: each module (with Tiptap, CodeMirror, MathLive or the
// graph UI) is a separate chunk loaded on first edit, or ahead of it by preloadBoxEditors once the
// editor route is up. Imported for its side effect by the editor route.
import { lazyEditor, registerEditor } from "./editorRegistry";

const editors = {
  text: lazyEditor(() => import("./TextBoxEditor")),
  math: lazyEditor(() => import("./MathEditor")),
  table: lazyEditor(() => import("./TableEditor")),
  code: lazyEditor(() => import("./CodeEditor")),
  graph: lazyEditor(() => import("./GraphEditor")),
};

registerEditor("text-box", editors.text);
registerEditor("text-box", editors.math, { subtype: "math" });
registerEditor("table", editors.table);
registerEditor("codespace", editors.code);
registerEditor("graph", editors.graph);

/** Start loading every editor in the background (the first edit then opens without a delay). */
export function preloadBoxEditors(): void {
  for (const e of Object.values(editors)) void e.preload();
}
