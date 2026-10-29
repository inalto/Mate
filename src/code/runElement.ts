// Running a code block element: the stored output record of a run, the element carrying it (the
// box grown to show it), and the canvas path (SelectionBar's Run) that writes it through the store.
import { contentOf, type CodeOutput, type CodespaceContent } from "../model/content";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { codeBoxHeight, codeOf, isRunnable } from "../text/tableCode";
import { getRuntime, type RunResult } from "./runtime";

/** The stored record of a finished run. */
export const outputFrom = (r: RunResult): CodeOutput => ({ ...r, ranAt: new Date().toISOString() });

/** `el` with `output` stored (or removed when undefined), its box grown to show the output. */
export function withOutput(el: Element, code: string, language: string, output: CodeOutput | undefined): Element {
  const { output: _old, ...rest } = contentOf<CodespaceContent>(el);
  void _old;
  const content: CodespaceContent = { ...rest, subtype: "codespace", code, language, ...(output ? { output } : {}) };
  const boxHeight = codeBoxHeight(code, output, el.boxHeight ?? 0);
  return { ...el, content, ...(boxHeight !== el.boxHeight ? { boxHeight } : {}) };
}

/**
 * Run code block `id` of `store`'s page and store its output (one history entry). Nothing is
 * written when the block was deleted or its code changed meanwhile.
 */
export async function runCodeElement(store: EditorStore, id: string): Promise<void> {
  const el = store.getState().elements.get(id);
  if (!el || el.type !== "codespace") return;
  const { code, language } = codeOf(el);
  if (!isRunnable(language)) return;
  const result = await getRuntime(language, el.pageId).run(code);
  const s = store.getState();
  const cur = s.elements.get(id);
  if (!cur || codeOf(cur).code !== code) return;
  s.updateElements([{ ...withOutput(cur, code, codeOf(cur).language, outputFrom(result)), updatedAt: new Date().toISOString() }]);
}
