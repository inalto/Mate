// The JavaScript evaluator behind ./jsWorker (pure, testable outside a worker): runs code as a
// global (indirect) eval so `var`/function declarations persist on `globalThis` between runs like
// notebook cells, captures console output, and prints the completion value like a REPL.

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

/**
 * `code` with its unindented top-level `let`/`const`/`class` declarations turned into `var`s, so
 * they persist on `globalThis` like notebook cells (a global eval keeps lexical declarations to
 * itself). A heuristic on line starts: indented declarations (inside blocks) are left alone.
 */
export function hoistTopLevel(code: string): string {
  return code.replace(/^(?:const|let)(?=\s+[[{A-Za-z_$])/gm, "var").replace(/^class\s+([A-Za-z_$][\w$]*)/gm, "var $1 = class $1");
}

const errorText = (err: unknown): string => {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `Uncaught ${formatValue(err, false)}`;
};

type ConsoleMethod = "log" | "info" | "debug" | "warn" | "error";
const OUT: ConsoleMethod[] = ["log", "info", "debug"];
const ERR: ConsoleMethod[] = ["warn", "error"];

/** Evaluate `code` in the global scope, console captured for the duration of the run. */
export async function evaluate(code: string): Promise<EvalResult> {
  const out: string[] = [];
  const err: string[] = [];
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
  const text = (lines: string[]) => (lines.length ? `${lines.join("\n")}\n` : "");
  return { stdout: text(out), stderr: text(err), status };
}
