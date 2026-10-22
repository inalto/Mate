// KaTeX rendering of typed math. `renderLatex` never throws: invalid LaTeX comes back as its raw
// source in a red `<span class="math-error">` together with the parser's message.
import katex from "katex";
import { esc } from "../export/svgUtil";

export interface RenderedLatex {
  html: string;
  error?: string;
}

// KaTeX's own `throwOnError:false` paints errors itself and hides them from callers; throwing and
// catching here gives us the message and our own `math-error` rendering.
/** HTML of `latex` in display mode (empty for blank input); `error` is set when it is invalid. */
export function renderLatex(latex: string): RenderedLatex {
  if (latex.trim() === "") return { html: "" };
  try {
    return { html: katex.renderToString(latex, { displayMode: true, output: "html", throwOnError: true, strict: "ignore", trust: false }) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { html: `<span class="math-error" style="color: #cc0000;">${esc(latex)}</span>`, error };
  }
}
