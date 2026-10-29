// The JavaScript evaluator behind ./jsWorker (pure, testable outside a worker): runs code as a
// global (indirect) eval so `var`/function declarations persist on `globalThis` between runs like
// notebook cells, captures console output, and prints the completion value like a REPL.
import { TailBuffer } from "./tailBuffer";

export interface EvalResult {
  stdout: string;
  stderr: string;
  status: "ok" | "error";
}

/** `v` as a console would print it; strings are bare as console arguments (`top`) and quoted as values. */
export function formatValue(v: unknown, top: boolean): string {
  if (typeof v === "string") return top ? v : JSON.stringify(v);
  if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "symbol" || v === undefined) return String(v);
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (v === null || typeof v !== "object") return String(v);
  try {
    const s = JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : typeof x === "function" ? `[Function ${x.name || "anonymous"}]` : x));
    return s ?? String(v);
  } catch {
    return String(v);
  }
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[\w$]/;
/** After one of these (or at the start) a `/` begins a regular expression, not a division. */
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/**
 * `code` with its top-level `let`/`const`/`class` declarations turned into `var`s, so they persist
 * on `globalThis` like notebook cells (a global eval keeps lexical declarations to itself). A small
 * scanner skips strings, template literals (with `${}` nesting), comments and regular expressions,
 * and rewrites only statements at bracket depth 0: declarations inside blocks, loops and functions
 * keep their block scope.
 */
export function hoistTopLevel(code: string): string {
  let out = "";
  let i = 0;
  let depth = 0;
  /** Depths at which an open template literal's `${` was entered. */
  const templates: number[] = [];
  /** Last significant (non-space, non-comment) character, and whether a newline came after it. */
  let prev = "";
  let newline = true;
  const n = code.length;

  const copyString = (q: string) => {
    let j = i + 1;
    while (j < n && code[j] !== q && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
    out += code.slice(i, j + 1);
    i = j + 1;
  };
  /** Copy template text from `i` (just after "`" or "}") up to its end or a `${`. */
  const copyTemplate = () => {
    let j = i;
    while (j < n) {
      if (code[j] === "\\") j += 2;
      else if (code[j] === "`") {
        out += code.slice(i, j + 1);
        i = j + 1;
        prev = "`";
        return;
      } else if (code[j] === "$" && code[j + 1] === "{") {
        out += code.slice(i, j + 2);
        i = j + 2;
        templates.push(depth);
        depth++;
        prev = "{";
        return;
      } else j++;
    }
    out += code.slice(i);
    i = n;
  };

  while (i < n) {
    const c = code[i];
    if (c === "\n") {
      newline = true;
      out += c;
      i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      out += c;
      i++;
    } else if (c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      const j = end < 0 ? n : end;
      out += code.slice(i, j);
      i = j;
    } else if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const j = end < 0 ? n : end + 2;
      out += code.slice(i, j);
      i = j;
    } else if (c === "'" || c === '"') {
      copyString(c);
      prev = c;
      newline = false;
    } else if (c === "`") {
      out += c;
      i++;
      newline = false;
      copyTemplate();
    } else if (c === "/" && REGEX_AFTER.has(prev)) {
      let j = i + 1;
      let cls = false;
      while (j < n && code[j] !== "\n" && (cls || code[j] !== "/")) {
        if (code[j] === "\\") j++;
        else if (code[j] === "[") cls = true;
        else if (code[j] === "]") cls = false;
        j++;
      }
      j++;
      while (j < n && IDENT.test(code[j])) j++;
      out += code.slice(i, j);
      i = j;
      prev = "/";
      newline = false;
    } else if (IDENT_START.test(c) && !IDENT.test(code[i - 1] ?? "")) {
      let j = i;
      while (j < n && IDENT.test(code[j])) j++;
      const word = code.slice(i, j);
      const atStatement = depth === 0 && (prev === "" || prev === ";" || prev === "}" || newline) && prev !== ".";
      const rest = code.slice(j);
      if (atStatement && (word === "let" || word === "const") && /^\s+[[{A-Za-z_$]/.test(rest)) {
        out += "var";
      } else if (atStatement && word === "class") {
        const m = /^\s+([A-Za-z_$][\w$]*)/.exec(rest);
        out += m && m[1] !== "extends" ? `var ${m[1]} = class` : word;
      } else {
        out += word;
      }
      i = j;
      prev = word.at(-1)!;
      newline = false;
    } else {
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
      else if (c === "}") {
        if (templates.length && templates.at(-1) === depth - 1) {
          templates.pop();
          depth--;
          out += c;
          i++;
          copyTemplate();
          newline = false;
          continue;
        }
        depth = Math.max(0, depth - 1);
      }
      out += c;
      i++;
      prev = c;
      newline = false;
    }
  }
  return out;
}

const errorText = (err: unknown): string => {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `Uncaught ${formatValue(err, false)}`;
};

type ConsoleMethod = "log" | "info" | "debug" | "warn" | "error";
const OUT: ConsoleMethod[] = ["log", "info", "debug"];
const ERR: ConsoleMethod[] = ["warn", "error"];

/** Evaluate `code` in the global scope, console captured for the duration of the run. */
export async function evaluate(code: string, cap?: number): Promise<EvalResult> {
  const out = new TailBuffer(cap);
  const err = new TailBuffer(cap);
  const line = (args: unknown[]) => args.map((a) => formatValue(a, true)).join(" ");
  const saved = new Map<ConsoleMethod, (...a: unknown[]) => void>();
  for (const m of [...OUT, ...ERR]) {
    saved.set(m, console[m]);
    console[m] = (...a: unknown[]) => void (OUT.includes(m) ? out : err).push(line(a));
  }
  let status: EvalResult["status"] = "ok";
  try {
    // Indirect eval: global scope, completion value returned. Running the user's code is the point;
    // it runs inside a worker (no DOM, no IPC).
    // Read through globalThis: a bare `const geval = eval` is inlined by the minifier into a direct
    // eval, whose `var`s would stay local to this function.
    // eslint-disable-next-line no-eval -- evaluating the code block is this module's job
    const geval = globalThis.eval;
    let value: unknown = geval(hoistTopLevel(code));
    if (value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<unknown>).then === "function") {
      value = await (value as PromiseLike<unknown>);
    }
    if (value !== undefined) out.push(formatValue(value, false));
  } catch (e) {
    status = "error";
    err.push(errorText(e));
  } finally {
    for (const [m, fn] of saved) console[m] = fn;
  }
  return { stdout: out.text(), stderr: err.text(), status };
}
