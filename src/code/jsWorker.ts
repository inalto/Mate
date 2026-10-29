// Worker running JavaScript code blocks (TypeScript arrives already stripped): see ./jsEval.
// Protocol (./runtime): { type: "run", id, code } → { type: "result", id, stdout, stderr, status };
// { type: "reset" } forgets the globals the runs defined.
import { evaluate } from "./jsEval";

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown): void;
}
const scope = self as unknown as WorkerScope;
/** Globals present before any run: a reset deletes everything else. */
const builtins = new Set(Object.getOwnPropertyNames(globalThis));
let chain: Promise<void> = Promise.resolve();

scope.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; id?: number; code?: string };
  if (msg?.type === "reset") {
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (builtins.has(name)) continue;
      try {
        delete (globalThis as Record<string, unknown>)[name];
      } catch {
        /* non-configurable (top-level var): overwrite instead */
        (globalThis as Record<string, unknown>)[name] = undefined;
      }
    }
    return;
  }
  if (msg?.type !== "run" || typeof msg.code !== "string") return;
  const { id, code } = msg;
  chain = chain.then(async () => {
    const r = await evaluate(code);
    scope.postMessage({ type: "result", id, ...r });
  });
};
