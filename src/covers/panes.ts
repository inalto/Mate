// One study run per editor pane, bound to that pane's editor store. A replay opening on the pane
// ends its run: the study bar and the replay bar share the pane's bottom edge.
import type { StoreApi } from "zustand/vanilla";
import { replayForPane } from "../recording/panes";
import type { EditorStore } from "../stores/editor";
import { editorForPane } from "../stores/focusedEditor";
import type { PaneIndex } from "../stores/tabs";
import { createRun, type RunState } from "./run";

const panes = new Map<PaneIndex, StoreApi<RunState>>();
const byEditor = new WeakMap<EditorStore, StoreApi<RunState>>();

/** The run of pane `i` (created on first use). */
export function runForPane(i: PaneIndex): StoreApi<RunState> {
  let run = panes.get(i);
  if (!run) {
    const editor = editorForPane(i);
    const r = createRun(editor);
    run = r;
    panes.set(i, r);
    byEditor.set(editor, r);
    replayForPane(i).subscribe((s, prev) => {
      if (s.markerId !== null && s.markerId !== prev.markerId) r.getState().end();
    });
  }
  return run;
}

/** The run of the pane `editor` belongs to; undefined for a store that is no pane's. */
export function runOf(editor: EditorStore): StoreApi<RunState> | undefined {
  if (!byEditor.has(editor)) for (const i of [0, 1] as const) if (editorForPane(i) === editor) runForPane(i);
  return byEditor.get(editor);
}
