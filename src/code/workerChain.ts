// The run queue inside a worker: each run waits for the previous one, and a run that throws
// (in the evaluator or while posting its result) still answers with an error result for its id and
// leaves the chain usable, so later runs are not stuck until the time budget.
import type { EvalResult } from "./jsEval";

type Post = (msg: { type: "result"; id: number; stdout: string; stderr: string; status: "ok" | "error" }) => void;

/** `chain` extended with the run `id` of `code`; never rejects. */
export function runQueued(chain: Promise<void>, id: number | undefined, code: string, evaluate: (code: string) => Promise<EvalResult>, post: Post): Promise<void> {
  const rid = typeof id === "number" ? id : -1;
  return chain
    .then(async () => post({ type: "result", id: rid, ...(await evaluate(code)) }))
    .catch((e: unknown) => {
      try {
        post({ type: "result", id: rid, stdout: "", stderr: `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`, status: "error" });
      } catch {
        /* the result cannot be posted (e.g. an uncloneable value): the runtime's budget ends the run */
      }
    });
}
