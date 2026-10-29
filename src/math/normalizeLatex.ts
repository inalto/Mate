// LaTeX as written by people and recognisers, normalised for the Compute Engine (pure).
// The engine reads `\mathrm{dx}` (one upright group) as a single symbol named "dx", so an integral
// written that way has an unknown instead of a differential. `dx`, `\,dx` and `\mathrm{d}x` all
// parse as the differential, so upright differentials are unwrapped to plain letters.
// Applied at every engine boundary (graph parser, maths panel) and when a maths box is sent to the
// graph, so stored notation keeps what the user wrote.

const UPRIGHT = String.raw`\\(?:mathrm|text|textrm|operatorname)`;

/** `\mathrm{dx}`, `\text{dx}`, `\operatorname{dx}` (one letter after the d) → `dx`. */
const DIFFERENTIAL = new RegExp(String.raw`${UPRIGHT}\{\s*d\s*([a-zA-Z])\s*\}`, "g");
/** `\mathrm{d}` on its own (followed by the variable) → `d`. */
const UPRIGHT_D = new RegExp(String.raw`${UPRIGHT}\{\s*d\s*\}`, "g");

/** `latex` with notation the engine misreads rewritten; other text is returned unchanged. */
export function normalizeLatex(latex: string): string {
  if (!latex.includes("\\")) return latex;
  return latex.replace(DIFFERENTIAL, "d$1").replace(UPRIGHT_D, "d");
}
