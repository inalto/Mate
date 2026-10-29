import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disposeAll, disposeClosedPages, disposeScope, getRuntime, resetRuntime, setWorkerFactory, type WorkerLike } from "../runtime";

/** A Worker stand-in: records what the runtime posts; the test answers with `emit`. */
class FakeWorker implements WorkerLike {
  sent: unknown[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly kind: string;
  constructor(kind: string) {
    this.kind = kind;
  }
  postMessage(msg: unknown) {
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  /** The last run request posted. */
  lastRun() {
    return [...this.sent].reverse().find((m) => (m as { type: string }).type === "run") as { type: "run"; id: number; code: string } | undefined;
  }
  answer(out: { stdout?: string; stderr?: string; status?: "ok" | "error" }) {
    const run = this.lastRun()!;
    this.emit({ type: "result", id: run.id, stdout: out.stdout ?? "", stderr: out.stderr ?? "", status: out.status ?? "ok" });
  }
}

let workers: FakeWorker[] = [];
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("code runtimes", () => {
  beforeEach(() => {
    workers = [];
    setWorkerFactory((kind) => {
      const w = new FakeWorker(kind);
      workers.push(w);
      return w;
    });
  });
  afterEach(() => {
    disposeAll();
    setWorkerFactory(null);
    vi.useRealTimers();
  });

  it("creates_no_worker_until_the_first_run", () => {
    const rt = getRuntime("javascript");
    expect(rt.state).toBe("idle");
    expect(workers).toHaveLength(0);
    expect(getRuntime("javascript")).toBe(rt); // one runtime per language
    expect(getRuntime("python")).not.toBe(rt);
  });

  it("delivers_the_result_of_a_javascript_run", async () => {
    const rt = getRuntime("javascript");
    const p = rt.run("console.log(1); 2");
    expect(rt.state).toBe("running");
    expect(workers).toHaveLength(1);
    expect(workers[0].kind).toBe("js");
    expect(workers[0].lastRun()!.code).toBe("console.log(1); 2");
    workers[0].answer({ stdout: "1\n2\n" });
    const r = await p;
    expect(r).toMatchObject({ stdout: "1\n2\n", stderr: "", status: "ok" });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(rt.state).toBe("idle");
  });

  it("reports_stderr_when_the_code_throws", async () => {
    const rt = getRuntime("javascript");
    const p = rt.run("throw new Error('boom')");
    workers[0].answer({ stderr: "Error: boom\n", status: "error" });
    expect(await p).toMatchObject({ stderr: "Error: boom\n", status: "error" });
  });

  it("transpiles_typescript_before_running_it", async () => {
    const rt = getRuntime("typescript");
    const p = rt.run("const n: number = 1; n");
    // sucrase is imported on the first TypeScript run (slow on a loaded machine).
    await vi.waitFor(() => expect(workers[0]?.lastRun()).toBeDefined(), { timeout: 20000 });
    const sent = workers[0].lastRun()!.code;
    expect(sent).not.toContain(": number");
    expect(sent).toContain("const n = 1");
    workers[0].answer({ stdout: "1\n" });
    expect((await p).status).toBe("ok");
  }, 30000);

  it("typescript_syntax_errors_are_stderr", async () => {
    const r = await getRuntime("typescript").run("const = ;");
    expect(r.status).toBe("error");
    expect(r.stderr).not.toBe("");
    expect(workers).toHaveLength(0);
  }, 30000);

  // Review focus 3.
  it("an_endless_run_times_out_terminates_and_restarts_the_runtime", async () => {
    vi.useFakeTimers();
    const rt = getRuntime("javascript");
    const p = rt.run("while (true) {}", { timeoutMs: 10000 });
    const first = workers[0];
    await vi.advanceTimersByTimeAsync(9999);
    expect(first.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.status).toBe("timeout");
    expect(r.stderr).toMatch(/timed out after 10 s/i);
    expect(first.terminated).toBe(true);
    expect(rt.state).toBe("idle");
    // A fresh worker replaces the terminated one; the next run works on it.
    expect(workers).toHaveLength(2);
    const next = rt.run("1 + 1");
    expect(first.sent.filter((m) => (m as { type: string }).type === "run")).toHaveLength(1);
    workers[1].answer({ stdout: "2\n" });
    expect(await next).toMatchObject({ stdout: "2\n", status: "ok" });
  });

  it("the_default_time_budget_is_ten_seconds", async () => {
    vi.useFakeTimers();
    const p = getRuntime("javascript").run("for (;;) {}");
    await vi.advanceTimersByTimeAsync(10000);
    expect((await p).status).toBe("timeout");
  });

  it("a_late_result_after_a_timeout_is_ignored", async () => {
    vi.useFakeTimers();
    const rt = getRuntime("javascript");
    const p = rt.run("slow()", { timeoutMs: 50 });
    const first = workers[0];
    await vi.advanceTimersByTimeAsync(50);
    expect((await p).status).toBe("timeout");
    const next = rt.run("2");
    first.answer({ stdout: "stale\n" }); // the dead worker cannot answer the new run
    workers[1].answer({ stdout: "2\n" });
    expect((await next).stdout).toBe("2\n");
  });

  it("stop_ends_the_run_and_restarts_the_worker", async () => {
    const rt = getRuntime("javascript");
    const p = rt.run("while (true) {}");
    rt.stop();
    const r = await p;
    expect(r.status).toBe("error");
    expect(r.stderr).toMatch(/stopped/i);
    expect(workers[0].terminated).toBe(true);
    expect(rt.state).toBe("idle");
    const next = rt.run("3");
    workers.at(-1)!.answer({ stdout: "3\n" });
    expect((await next).stdout).toBe("3\n");
  });

  it("reset_of_an_idle_runtime_clears_its_state_in_place", async () => {
    const rt = getRuntime("javascript");
    const p = rt.run("var x = 1");
    workers[0].answer({});
    await p;
    resetRuntime("javascript");
    expect(workers[0].sent.at(-1)).toEqual({ type: "reset" });
    expect(workers[0].terminated).toBe(false);
  });

  it("runs_are_serialised", async () => {
    const rt = getRuntime("javascript");
    const a = rt.run("a");
    const b = rt.run("b");
    expect(workers[0].sent.filter((m) => (m as { type: string }).type === "run")).toHaveLength(1);
    workers[0].answer({ stdout: "A\n" });
    expect((await a).stdout).toBe("A\n");
    await flush();
    expect(workers[0].lastRun()!.code).toBe("b");
    workers[0].answer({ stdout: "B\n" });
    expect((await b).stdout).toBe("B\n");
  });

  // Review focus 4.
  it("python_runs_wait_for_the_runtime_to_load_and_load_it_once", async () => {
    const rt = getRuntime("python");
    const states: string[] = [];
    rt.subscribe(() => states.push(rt.state));
    const first = rt.run("print(1+1)");
    expect(rt.state).toBe("loading");
    expect(workers).toHaveLength(1);
    expect(workers[0].kind).toBe("python");
    workers[0].emit({ type: "state", state: "loading" });
    const second = rt.run("print(3)"); // a second Run while loading: no second download
    expect(workers).toHaveLength(1);
    expect(workers[0].lastRun()).toBeUndefined(); // nothing is posted before the runtime is ready
    workers[0].emit({ type: "state", state: "idle" });
    expect(rt.state).toBe("running");
    expect(workers[0].lastRun()!.code).toBe("print(1+1)");
    workers[0].answer({ stdout: "2\n" });
    expect((await first).stdout).toBe("2\n");
    await flush();
    expect(workers[0].lastRun()!.code).toBe("print(3)");
    workers[0].answer({ stdout: "3\n" });
    expect((await second).stdout).toBe("3\n");
    expect(rt.state).toBe("idle");
    expect(states[0]).toBe("loading");
    expect(workers).toHaveLength(1);
  });

  it("the_python_load_time_does_not_count_against_the_time_budget", async () => {
    vi.useFakeTimers();
    const rt = getRuntime("python");
    const p = rt.run("print(1)", { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(workers[0].terminated).toBe(false);
    workers[0].emit({ type: "state", state: "idle" });
    workers[0].answer({ stdout: "1\n" });
    expect((await p).status).toBe("ok");
  });

  it("a_failed_python_load_fails_the_queued_runs_and_retries_on_the_next_run", async () => {
    const rt = getRuntime("python");
    const p = rt.run("print(1)");
    workers[0].emit({ type: "loadError", message: "fetch failed" });
    const r = await p;
    expect(r.status).toBe("error");
    expect(r.stderr).toContain("fetch failed");
    expect(rt.state).toBe("idle");
    void rt.run("print(2)");
    expect(workers).toHaveLength(2);
  });

  it("dispose_terminates_the_workers_of_a_page", async () => {
    const a = getRuntime("javascript", "page-a");
    const b = getRuntime("javascript", "page-b");
    expect(a).not.toBe(b);
    const pa = a.run("1");
    void b.run("2");
    disposeScope("page-a");
    expect((await pa).status).toBe("error");
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].terminated).toBe(false);
    expect(getRuntime("javascript", "page-a")).not.toBe(a);
    disposeAll();
    expect(workers[1].terminated).toBe(true);
  });

  it("closing_a_page_disposes_only_its_runtimes", () => {
    void getRuntime("javascript", "open").run("1");
    void getRuntime("javascript", "closed").run("2");
    disposeClosedPages(new Set(["open"]));
    expect(workers[0].terminated).toBe(false);
    expect(workers[1].terminated).toBe(true);
  });
});
