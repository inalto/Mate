// Calculator-style input to LaTeX (pure). The graph editor is a plain text box: users type
// `sin(x)`, `x^10`, `sqrt(x)`, `log2(x)`, `r = 1+cos(theta)`; the Compute Engine reads LaTeX, where
// `sin` is s·i·n and `x^10` is x¹·0. `toLatex` tokenizes the input and rewrites:
// - known function names to commands (`sin` → `\sin`, `asin`/`arcsin` → `\arcsin`, `sign`/`sgn` →
//   `\operatorname{sign}`, `log2`/`log_2`/`log10` → `\log_{2}`/`\log_{10}`; plain `log` is base 10);
// - `sqrt`, `abs`, `floor`, `ceil` applied to a parenthesised group (or one operand) to
//   `\sqrt{…}`, `\left|…\right|`, `\left\lfloor…\right\rfloor`, `\left\lceil…\right\rceil`;
// - `pi`/`π` → `\pi`, `theta`/`θ` → `\theta`, `inf`/`infinity`/`∞` → `\infty`;
// - `^` (or `**`) followed by a multi-character operand (a number of 2+ characters, a parenthesised
//   group, a signed operand, a constant or a function call) → `^{…}` (a group loses its parentheses);
// - a run of letters is split into known names and single letters (`xsin` → x, sin; `2pix` → 2, π, x);
//   other letters pass through unchanged, and `*`, `/`, `|`, `,`, `=` are left as typed (implicit
//   multiplication is left to the engine).
// Input that contains a backslash is already LaTeX and is returned unchanged, and so is input with
// unbalanced parentheses (the engine then reports the error).

type Token =
  | { t: "num"; s: string }
  | { t: "name"; s: string }
  | { t: "letter"; s: string }
  | { t: "ws" }
  | { t: "open" }
  | { t: "close" }
  | { t: "op"; s: string };

/** Plain functions written as a LaTeX command followed by their argument. */
const FUNCTIONS: Record<string, string> = {
  sin: "\\sin",
  cos: "\\cos",
  tan: "\\tan",
  cot: "\\cot",
  sec: "\\sec",
  csc: "\\csc",
  asin: "\\arcsin",
  arcsin: "\\arcsin",
  acos: "\\arccos",
  arccos: "\\arccos",
  atan: "\\arctan",
  arctan: "\\arctan",
  sinh: "\\sinh",
  cosh: "\\cosh",
  tanh: "\\tanh",
  ln: "\\ln",
  log: "\\log",
  exp: "\\exp",
  min: "\\min",
  max: "\\max",
  sign: "\\operatorname{sign}",
  sgn: "\\operatorname{sign}",
};

/** Functions whose argument goes inside delimiters. */
const WRAPPERS: Record<string, [string, string]> = {
  sqrt: ["\\sqrt{", "}"],
  abs: ["\\left|", "\\right|"],
  floor: ["\\left\\lfloor ", "\\right\\rfloor"],
  ceil: ["\\left\\lceil ", "\\right\\rceil"],
};

const CONSTANTS: Record<string, string> = {
  pi: "\\pi",
  theta: "\\theta",
  inf: "\\infty",
  infinity: "\\infty",
};

const SYMBOLS: Record<string, string> = { π: "pi", θ: "theta", "∞": "inf", "√": "sqrt" };
const OPERATORS: Record<string, string> = { "−": "-", "·": "*", "×": "*" };

/** Known names, longest first (so `sinh` wins over `sin`, `asin` over `a` + `sin`). */
const NAMES = [...Object.keys(FUNCTIONS), ...Object.keys(WRAPPERS), ...Object.keys(CONSTANTS)].sort((a, b) => b.length - a.length);

/** A run of letters as known names and single letters. */
function splitLetters(run: string, out: Token[]): void {
  let k = 0;
  while (k < run.length) {
    const name = NAMES.find((n) => run.startsWith(n, k));
    if (name) {
      out.push({ t: "name", s: name });
      k += name.length;
    } else {
      out.push({ t: "letter", s: run[k] });
      k++;
    }
  }
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      while (i < src.length && /\s/.test(src[i])) i++;
      out.push({ t: "ws" });
    } else if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]*/.exec(src.slice(i))![0];
      out.push({ t: "num", s: m });
      i += m.length;
    } else if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z]+/.exec(src.slice(i))![0];
      splitLetters(m, out);
      i += m.length;
    } else if (SYMBOLS[c]) {
      out.push({ t: "name", s: SYMBOLS[c] });
      i++;
    } else if (c === "(") {
      out.push({ t: "open" });
      i++;
    } else if (c === ")") {
      out.push({ t: "close" });
      i++;
    } else if (c === "*" && src[i + 1] === "*") {
      out.push({ t: "op", s: "^" });
      i += 2;
    } else {
      out.push({ t: "op", s: OPERATORS[c] ?? c });
      i++;
    }
  }
  return out;
}

/** Index of each `(`'s matching `)`, or null when the parentheses are unbalanced. */
function matchParens(tokens: Token[]): Map<number, number> | null {
  const match = new Map<number, number>();
  const stack: number[] = [];
  tokens.forEach((tk, i) => {
    if (tk.t === "open") stack.push(i);
    else if (tk.t === "close") {
      const o = stack.pop();
      if (o === undefined) stack.push(-1); // unmatched: flagged below
      else match.set(o, i);
    }
  });
  return stack.length === 0 ? match : null;
}

/** `a` and `b` concatenated, with a space where a command would otherwise run into a letter. */
const cat = (a: string, b: string): string => (/\\[A-Za-z]+$/.test(a) && /^[A-Za-z]/.test(b) ? `${a} ${b}` : a + b);

interface Piece {
  latex: string;
  next: number;
  /** A single character (no braces needed after `^`). */
  simple: boolean;
}

class Converter {
  private readonly tokens: Token[];
  private readonly match: Map<number, number>;

  constructor(tokens: Token[], match: Map<number, number>) {
    this.tokens = tokens;
    this.match = match;
  }

  private skipWs(i: number, end: number): number {
    while (i < end && this.tokens[i].t === "ws") i++;
    return i;
  }

  /** Tokens [from, to) as LaTeX. */
  seq(from: number, to: number): string {
    let out = "";
    let i = from;
    while (i < to) {
      const tk = this.tokens[i];
      if (tk.t === "ws") {
        out += " ";
        i++;
      } else if (tk.t === "op" && tk.s === "^") {
        const p = this.operand(i + 1, to);
        if (!p) {
          out += "^";
          i++;
        } else {
          out += p.simple ? `^${p.latex}` : `^{${p.latex}}`;
          i = p.next;
        }
      } else {
        const p = this.atom(i, to, false);
        out = cat(out, p ? p.latex : tk.t === "op" ? tk.s : "");
        i = p ? p.next : i + 1;
      }
    }
    return out;
  }

  /** The operand of `^` at `i` (after spaces): an atom, or a sign and an atom. */
  private operand(i: number, end: number): Piece | null {
    i = this.skipWs(i, end);
    if (i >= end) return null;
    const tk = this.tokens[i];
    if (tk.t === "op" && (tk.s === "-" || tk.s === "+")) {
      const p = this.operand(i + 1, end);
      return p ? { latex: tk.s + p.latex, next: p.next, simple: false } : null;
    }
    const p = this.atom(i, end, true);
    if (!p) return null;
    if (tk.t === "open") return { ...p, latex: this.seq(i + 1, this.match.get(i)!).trim(), simple: false };
    return p;
  }

  /**
   * One operand starting at `i`: a number, a letter, a parenthesised group, a constant or a function
   * call. With `greedy` (the operand of `^` or of a function written without parentheses) a function
   * takes its argument even when it is not parenthesised.
   */
  private atom(i: number, end: number, greedy: boolean): Piece | null {
    const tk = this.tokens[i];
    switch (tk.t) {
      case "num":
        return { latex: tk.s, next: i + 1, simple: tk.s.length === 1 };
      case "letter":
        return { latex: tk.s, next: i + 1, simple: true };
      case "open": {
        const close = this.match.get(i)!;
        return { latex: `(${this.seq(i + 1, close)})`, next: close + 1, simple: false };
      }
      case "name":
        return this.call(i, end, greedy);
      default:
        return null;
    }
  }

  /** The argument of a function at `i` (after spaces): a group's content, or one operand. */
  private argument(i: number, end: number): { inner: string; parens: boolean; next: number } | null {
    const j = this.skipWs(i, end);
    if (j >= end) return null;
    if (this.tokens[j].t === "open") {
      const close = this.match.get(j)!;
      return { inner: this.seq(j + 1, close).trim(), parens: true, next: close + 1 };
    }
    const p = this.operand(j, end);
    return p ? { inner: p.latex, parens: false, next: p.next } : null;
  }

  private call(i: number, end: number, greedy: boolean): Piece {
    const name = (this.tokens[i] as { s: string }).s;
    if (CONSTANTS[name]) return { latex: CONSTANTS[name], next: i + 1, simple: false };
    const wrap = WRAPPERS[name];
    if (wrap) {
      const arg = this.argument(i + 1, end);
      if (!arg) return { latex: wrap[0] + wrap[1], next: i + 1, simple: false };
      return { latex: wrap[0] + arg.inner + wrap[1], next: arg.next, simple: false };
    }
    let latex = FUNCTIONS[name];
    let next = i + 1;
    // log2(x), log10(x), log_2(x): a base.
    if (name === "log") {
      const a = this.tokens[next];
      if (a?.t === "num") {
        latex += `_{${a.s}}`;
        next++;
      } else if (a?.t === "op" && a.s === "_") {
        const b = this.tokens[next + 1];
        if (b?.t === "num") {
          latex += `_{${b.s}}`;
          next += 2;
        }
      }
    }
    // sin^2(x): a power on the function name.
    const k = this.skipWs(next, end);
    const pow = this.tokens[k];
    if (k < end && pow.t === "op" && pow.s === "^") {
      const p = this.operand(k + 1, end);
      if (p) {
        latex += p.simple ? `^${p.latex}` : `^{${p.latex}}`;
        next = p.next;
      }
    }
    const j = this.skipWs(next, end);
    if (j < end && this.tokens[j].t === "open") {
      const close = this.match.get(j)!;
      return { latex: `${latex}(${this.seq(j + 1, close).trim()})`, next: close + 1, simple: false };
    }
    if (greedy) {
      const arg = this.argument(next, end);
      if (arg) return { latex: cat(`${latex} `, arg.inner), next: arg.next, simple: false };
    }
    return { latex, next, simple: false };
  }
}

/** `input` (calculator-style text or LaTeX) as LaTeX for the Compute Engine and KaTeX. */
export function toLatex(input: string): string {
  if (input.includes("\\")) return input;
  const tokens = tokenize(input);
  const match = matchParens(tokens);
  if (!match) return input;
  return new Converter(tokens, match).seq(0, tokens.length).trim();
}
