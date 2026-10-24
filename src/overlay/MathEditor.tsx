// DOM editor of typed math (MathLive `<math-field>`), mounted by OverlayLayer in the slot of a
// text-box with `content.subtype:"math"`. Edits stay local until the session ends (Esc, a click
// outside, or the store moving editingId on); the session then commits once through
// useEditSession as ONE history entry: the LaTeX, its KaTeX HTML (regenerated, sanitised) and the
// box grown to the rendered size. Nothing is recorded when the LaTeX is unchanged.
// Registered lazily for the "math" subtype of "text-box" by ./boxEditors.
import { MathfieldElement } from "mathlive";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import i18n from "../i18n";
import { currentLanguage } from "../i18n/language";
import { mapInkColor } from "../ink/theme";
import { contentOf, type TextBoxContent } from "../model/content";
import type { Element } from "../model/types";
import { latexOf, mathContent, measureMathSize } from "../math/mathBox";
import { useSettingsStore } from "../stores/settings";
import { boxCss } from "../text/style";
import { textAttrsOf } from "../text/textBox";
import type { BoxEditorProps } from "./editorRegistry";
import { useEditSession } from "./useEditSession";

/** Where MathLive finds its fonts (copied from the package into public/). */
export const MATHLIVE_FONTS_DIR = "/mathlive-fonts";

/** Breathing room (in font sizes) added around the rendered equation when the box grows. */
const PAD = 0.6;

const styleOf = (decls: Record<string, string>): CSSProperties =>
  Object.fromEntries(Object.entries(decls).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]));

export default function MathEditor({ el, store }: BoxEditorProps) {
  const theme = useSettingsStore((s) => s.settings.theme);
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [initial] = useState(() => ({ latex: latexOf(el), attrs: textAttrsOf(el) }));
  const latest = useRef(initial.latex);

  useEditSession(el.id, store, rootRef, (cur: Element) => {
    const latex = latest.current;
    if (latex === latexOf(cur)) return cur;
    const attrs = textAttrsOf(cur);
    const content = mathContent(contentOf<TextBoxContent>(cur), latex, attrs);
    const size = measureMathSize(content.contentHtml, attrs);
    const pad = attrs.fontSize * PAD;
    return {
      ...cur,
      content,
      boxWidth: size.width > 0 ? Math.max(cur.boxWidth ?? 0, Math.ceil(size.width + pad)) : cur.boxWidth,
      boxHeight: size.height > 0 ? Math.max(cur.boxHeight ?? 0, Math.ceil(size.height + pad)) : cur.boxHeight,
    };
  });

  // Mount the math field once for this session.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    MathfieldElement.fontsDirectory = MATHLIVE_FONTS_DIR;
    MathfieldElement.soundsDirectory = null;
    MathfieldElement.locale = currentLanguage(); // later changes are applied by applyLanguage
    const mf = document.createElement("math-field") as MathfieldElement;
    mf.mathVirtualKeyboardPolicy = "manual"; // no on-screen keyboard unless asked for
    mf.smartMode = true;
    mf.setAttribute("aria-label", i18n.t("math.equation"));
    mf.value = initial.latex;
    const onInput = () => {
      latest.current = mf.value;
    };
    mf.addEventListener("input", onInput);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      store.getState().endEdit();
    };
    mf.addEventListener("keydown", onKey, true);
    host.appendChild(mf);
    mf.focus();
    return () => {
      mf.removeEventListener("input", onInput);
      mf.removeEventListener("keydown", onKey, true);
      mf.remove();
    };
  }, [initial, store]);

  const css = boxCss(initial.attrs, mapInkColor(initial.attrs.color, theme));
  return (
    <div ref={rootRef} className="math-editor" style={styleOf(css)}>
      <div ref={hostRef} className="math-editor-host" />
    </div>
  );
}

