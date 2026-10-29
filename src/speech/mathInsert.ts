// Dictated maths as an equation: the rewriter's calculator-style text (or the AI tidy-up's LaTeX)
// checked with the Compute Engine, then inserted as a maths box sized to it and centred in the view.
import { screenToWorld } from "../canvas/camera";
import { engineSync, loadEngine } from "../graph/engine";
import { firstError } from "../graph/expressions";
import { toLatex } from "../graph/plain";
import { mathContent, mathElement, measureMathSize } from "../math/mathBox";
import { normalizeLatex } from "../math/normalizeLatex";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";
import { DEFAULT_BOX_WIDTH } from "../text/style";
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

/**
 * The LaTeX of calculator-style `plain` (`y = x + 10`) when the engine accepts it, else null. The
 * calculator's `*`, `>=`, `<=` are written as `\cdot`, `\geq`, `\leq` for display.
 */
export async function latexForPlain(plain: string): Promise<string | null> {
  let latex: string;
  try {
    latex = toLatex(plain)
      .replace(/\s*>=\s*/g, String.raw` \geq `)
      .replace(/\s*<=\s*/g, String.raw` \leq `)
      .replace(/\s*\*\s*/g, String.raw`\cdot `);
  } catch {
    return null;
  }
  return checkLatex(latex);
}

/** Breathing room (in font sizes) around the rendered equation, as the maths editor leaves. */
const PAD = 0.6;

/** Adds a maths box showing `latex`, sized to it, centred in the view, and selects it. Null without a page. */
export function insertMathBox(store: EditorStore, latex: string): string | null {
  const s = store.getState();
  if (!s.pageId) return null;
  const color = useSettingsStore.getState().settings.defaultTextColor;
  const vp = s.viewport.width > 0 ? s.viewport : { width: 1280, height: 800 };
  const c = screenToWorld(s.camera, { x: vp.width / 2, y: vp.height / 2 });
  const base = mathElement(s.pageId, crypto.randomUUID(), new Date().toISOString(), c, color);
  const attrs = textAttrsOf(base);
  const content = mathContent({}, latex, attrs);
  const size = measureMathSize(content.contentHtml, attrs);
  const pad = attrs.fontSize * PAD;
  const width = size.width > 0 ? Math.max(DEFAULT_BOX_WIDTH, Math.ceil(size.width + pad)) : (base.boxWidth ?? DEFAULT_BOX_WIDTH);
  const height = size.height > 0 ? Math.max(base.boxHeight ?? 0, Math.ceil(size.height + pad)) : (base.boxHeight ?? 0);
  const box: Element = {
    ...base,
    points: [{ ...base.points[0], x: c.x - width / 2, y: c.y - height / 2 }],
    boxWidth: width,
    boxHeight: height,
    content,
  };
  const top = topZ(s.elements.values());
  const el = top > 0 ? withMeta(box, { zIndex: top + 1 }) : box;
  if (!s.addElements("Dictation", [el])) return null;
  store.setState({ selection: new Set([el.id]) });
  return el.id;
}
