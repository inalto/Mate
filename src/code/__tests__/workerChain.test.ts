import { describe, expect, it } from "vitest";
import { TailBuffer } from "../tailBuffer";
import { runQueued } from "../workerChain";

type Msg = { id: number; status: string; stdout: string; stderr: string };

describe("worker run chain", () => {
  it("a_throwing_run_answers_with_an_error_and_later_runs_still_answer", async () => {
    const posted: Msg[] = [];
    const evaluate = async (code: string) => {
      if (code === "boom") throw new Error("evaluator crashed");
      return { stdout: `${code}\n`, stderr: "", status: "ok" as const };
    };
    let chain: Promise<void> = Promise.resolve();
    chain = runQueued(chain, 1, "boom", evaluate, (m) => void posted.push(m));
    chain = runQueued(chain, 2, "two", evaluate, (m) => void posted.push(m));
    await chain;
    expect(posted).toEqual([
      { type: "result", id: 1, stdout: "", stderr: "Error: evaluator crashed\n", status: "error" },
      { type: "result", id: 2, stdout: "two\n", stderr: "", status: "ok" },
    ]);
  });

  it("a_failing_post_does_not_break_the_chain", async () => {
    const posted: Msg[] = [];
    let fail = true;
    const post = (m: Msg) => {
      if (fail) {
        fail = false;
        throw new Error("DataCloneError");
      }
      posted.push(m);
    };
    let chain: Promise<void> = Promise.resolve();
    chain = runQueued(chain, 1, "a", async () => ({ stdout: "a\n", stderr: "", status: "ok" }), post);
    chain = runQueued(chain, 2, "b", async () => ({ stdout: "b\n", stderr: "", status: "ok" }), post);
    await chain;
    // Run 1's result failed to post, so its error result went out instead; run 2 still answered.
    expect(posted.map((m) => [m.id, m.status])).toEqual([
      [1, "error"],
      [2, "ok"],
    ]);
  });
});

describe("TailBuffer", () => {
  it("keeps_the_tail_with_a_marker", () => {
    const b = new TailBuffer(20);
    for (let i = 0; i < 10; i++) b.push(`line${i}`);
    expect(b.text()).toBe("… (truncated)\nline7\nline8\nline9\n"); // 3 lines × 6 chars ≤ 20
    expect(new TailBuffer().text()).toBe("");
    const small = new TailBuffer(100);
    small.push("a");
    expect(small.text()).toBe("a\n");
  });
});
