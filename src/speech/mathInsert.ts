// Dictated maths as an equation: the rewriter's calculator-style text (or the AI tidy-up's LaTeX)
// checked with the Compute Engine, then inserted as a maths box centred in the view.
import { screenToWorld } from "../canvas/camera";
import { engineSync, loadEngine } from "../graph/engine";
import { firstError } from "../graph/expressions";
import { toLatex } from "../graph/plain";
import { mathContent, mathElement } from "../math/mathBox";
import { normalizeLatex } from "../math/normalizeLatex";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";
import { textAttrsOf } from "../text/textBox";
import { withMeta } from "../tools/spatialIndex";
import { topZ } from "../tools/zorder";

/** `latex` when the Compute Engine reads it as a valid, non-empty expression, else null. Never rejects. */
export async function checkLatex(latex: string): Promise<string | null> {
  const src = latex.trim();
  if (src === "") return null;
  try {
    const ce = await loadEngine();
    const e = ce.parse(normalizeLatex(src));
    if (!e || !e.isValid || firstError(e.json) !== null) return null;
    if (engineSync()?.mod.isSymbol(e, "Nothing")) return null;
    return src;
  } catch {
    return null;
  }
}

/** The LaTeX of calculator-style `plain` (`y = x + 10`) when the engine accepts it, else null. */
export async function latexForPlain(plain: string): Promise<string | null> {
  let latex: string;
  try {
    latex = toLatex(plain);
  } catch {
    return null;
  }
  return checkLatex(latex);
}

/** Adds a maths box showing `latex`, centred in the view, and selects it. Null without a page. */
export function insertMathBox(store: EditorStore, latex: string): string | null {
  const s = store.getState();
  if (!s.pageId) return null;
  const color = useSettingsStore.getState().settings.defaultTextColor;
  const vp = s.viewport.width > 0 ? s.viewport : { width: 1280, height: 800 };
  const c = screenToWorld(s.camera, { x: vp.width / 2, y: vp.height / 2 });
  const base = mathElement(s.pageId, crypto.randomUUID(), new Date().toISOString(), c, color);
  const width = base.boxWidth ?? 0;
  const height = base.boxHeight ?? 0;
  const box: Element = {
    ...base,
    points: [{ ...base.points[0], x: c.x - width / 2, y: c.y - height / 2 }],
    content: mathContent({}, latex, textAttrsOf(base)),
  };
  const top = topZ(s.elements.values());
  const el = top > 0 ? withMeta(box, { zIndex: top + 1 }) : box;
  if (!s.addElements("Dictation", [el])) return null;
  store.setState({ selection: new Set([el.id]) });
  return el.id;
}
