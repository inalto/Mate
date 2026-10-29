// Worker running Python code blocks in Pyodide (core runtime and standard library only, copied to
// /pyodide/ by scripts/copy-pyodide-assets.mjs; no packages, no network). A module worker:
// Pyodide refuses classic workers. It starts loading at once and posts
// { type: "state", state: "loading" } then "idle" (or { type: "loadError", message }); runs posted
// before that are never sent by ./runtime. Runs share one namespace until { type: "reset" }.
import { cleanTraceback } from "./pyErrors";

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown): void;
  location: { href: string };
}
interface PyProxyLike {
  destroy?: () => void;
}
interface PyodideLike {
  setStdout(o: { batched: (s: string) => void }): void;
  setStderr(o: { batched: (s: string) => void }): void;
  runPythonAsync(code: string, opts?: { globals?: unknown }): Promise<unknown>;
  globals: { get(name: string): (...a: unknown[]) => unknown };
}

const scope = self as unknown as WorkerScope;
const indexURL = new URL("/pyodide/", scope.location.href).href;

let out: string[] = [];
let err: string[] = [];
let namespace: (PyProxyLike & object) | null = null;
let runner: ((...a: unknown[]) => unknown) | null = null;

async function load(): Promise<PyodideLike> {
  scope.postMessage({ type: "state", state: "loading" });
  const mod = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as { loadPyodide(o: { indexURL: string }): Promise<PyodideLike> };
  const py = await mod.loadPyodide({ indexURL });
  py.setStdout({ batched: (s) => void out.push(s) });
  py.setStderr({ batched: (s) => void err.push(s) });
  namespace = py.globals.get("dict")() as PyProxyLike & object;
  await py.runPythonAsync(RUNNER);
  scope.postMessage({ type: "state", state: "idle" });
  return py;
}

// Runs a block in the cells' namespace and returns the repr of a final expression (None → None),
// computed in Python so 2.0 prints as 2.0 (a converted JS number would print 2).
const RUNNER = `
from pyodide.code import eval_code_async as _eval_code_async
async def _mate_run(src, ns):
    r = await _eval_code_async(src, ns)
    return None if r is None else repr(r)
`;

const ready = load();
ready.catch((e: unknown) => scope.postMessage({ type: "loadError", message: e instanceof Error ? e.message : String(e) }));

const text = (lines: string[]) => (lines.length ? `${lines.join("\n")}\n` : "");
let chain: Promise<void> = Promise.resolve();

async function run(py: PyodideLike, id: number, code: string): Promise<void> {
  out = [];
  err = [];
  let status: "ok" | "error" = "ok";
  try {
    // Like a REPL: a final expression's repr is printed (None arrives as undefined).
    runner ??= py.globals.get("_mate_run");
    const repr = await (runner(code, namespace) as Promise<unknown>);
    if (typeof repr === "string") out.push(repr);
  } catch (e) {
    status = "error";
    err.push(cleanTraceback(e instanceof Error ? e.message : String(e)));
  }
  scope.postMessage({ type: "result", id, stdout: text(out), stderr: text(err), status });
}

scope.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; id?: number; code?: string };
  if (msg?.type === "reset") {
    chain = chain.then(async () => {
      const py = await ready;
      namespace?.destroy?.();
      namespace = py.globals.get("dict")() as PyProxyLike & object;
    });
    return;
  }
  if (msg?.type !== "run" || typeof msg.code !== "string" || typeof msg.id !== "number") return;
  const { id, code } = msg;
  chain = chain.then(async () => run(await ready, id, code)).catch(() => {});
};
