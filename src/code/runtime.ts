// Code-block runtimes: one Web Worker per runnable language per page (the "scope"), created on the
// first Run. JavaScript and TypeScript run in ./jsWorker (TypeScript stripped first by ./transpile),
// Python in ./pyWorker (Pyodide, bundled under /pyodide/, loaded once on the worker's start).
// Runs are serialised; each has a time budget that starts when the code reaches a ready worker
// (Python's download does not count): past it the worker is terminated and replaced, so an endless
// loop costs one Run. Workers have no DOM, no IPC and no network beyond the app's own files.
import i18n from "../i18n";
import type { RunnableLanguage } from "../text/tableCode";
import { transpileTs } from "./transpile";

export type RunStatus = "ok" | "error" | "timeout";
export interface RunResult {
  stdout: string;
  stderr: string;
  status: RunStatus;
  durationMs: number;
}
export type RuntimeState = "idle" | "loading" | "running";

/** Default time budget of a run. */
export const RUN_TIMEOUT_MS = 10_000;
/** Each stream keeps at most this many trailing characters (a run printing megabytes stays small). */
export const MAX_STREAM_CHARS = 100_000;

/** Messages to a worker. */
export type ToWorker = { type: "run"; id: number; code: string } | { type: "reset" };
/** Messages from a worker. */
export type FromWorker =
  | { type: "result"; id: number; stdout: string; stderr: string; status: "ok" | "error" }
  | { type: "state"; state: "loading" | "idle" }
  | { type: "loadError"; message: string };

/** The part of `Worker` the runtimes use (tests pass a fake). */
export interface WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  postMessage(msg: ToWorker): void;
  terminate(): void;
}
export type WorkerKind = "js" | "python";
type WorkerFactory = (kind: WorkerKind) => WorkerLike;

// `new Worker(new URL(...))` must stay literal for Vite to bundle the worker scripts.
const defaultFactory: WorkerFactory = (kind) =>
  kind === "python"
    ? (new Worker(new URL("./pyWorker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike)
    : (new Worker(new URL("./jsWorker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike);
let factory: WorkerFactory = defaultFactory;

/** Replace how workers are created (tests); null restores the real workers. */
export function setWorkerFactory(f: WorkerFactory | null): void {
  factory = f ?? defaultFactory;
}

export interface Runtime {
  readonly language: RunnableLanguage;
  readonly state: RuntimeState;
  run(code: string, opts?: { timeoutMs?: number }): Promise<RunResult>;
  /** End the current run (and drop queued ones); the worker is replaced. */
  stop(): void;
  /** Forget everything the runs defined. */
  reset(): void;
  /** Called on every state change; returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
  dispose(): void;
}

interface Job {
  code: string;
  timeoutMs: number;
  resolve: (r: RunResult) => void;
}

/** The tail of `s` within MAX_STREAM_CHARS, cut at a line start. */
function clampStream(s: string): string {
  if (s.length <= MAX_STREAM_CHARS) return s;
  const tail = s.slice(-MAX_STREAM_CHARS);
  const nl = tail.indexOf("\n");
  return nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

class WorkerRuntime implements Runtime {
  private worker: WorkerLike | null = null;
  /** True once the worker can take a run (JS at once; Python after its "idle"). */
  private ready = false;
  private queue: Job[] = [];
  private current: { job: Job; id: number; started: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private nextId = 1;
  private listeners = new Set<() => void>();
  private _state: RuntimeState = "idle";
  private disposed = false;

  readonly language: RunnableLanguage;

  constructor(language: RunnableLanguage) {
    this.language = language;
  }

  get state(): RuntimeState {
    return this._state;
  }

  private get kind(): WorkerKind {
    return this.language === "python" ? "python" : "js";
  }

  private setState(s: RuntimeState): void {
    if (s === this._state) return;
    this._state = s;
    for (const fn of [...this.listeners]) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private spawn(): WorkerLike {
    const w = factory(this.kind);
    this.worker = w;
    this.ready = this.kind === "js";
    w.onmessage = (e) => this.onMessage(w, e.data as FromWorker);
    w.onerror = (e) => {
      e.preventDefault?.();
      if (this.worker === w) this.fail(w, e.message || "worker error");
    };
    return w;
  }

  private kill(): void {
    const w = this.worker;
    this.worker = null;
    this.ready = false;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    }
  }

  private finish(r: Omit<RunResult, "durationMs">): void {
    const cur = this.current;
    if (!cur) return;
    clearTimeout(cur.timer);
    this.current = null;
    cur.job.resolve({ stdout: clampStream(r.stdout), stderr: clampStream(r.stderr), status: r.status, durationMs: Math.max(0, Math.round(now() - cur.started)) });
  }

  /** The worker could not load (or crashed): fail the current and queued runs; the next run retries. */
  private fail(w: WorkerLike, message: string): void {
    if (this.worker !== w) return;
    this.kill();
    this.finish({ stdout: "", stderr: `${message}\n`, status: "error" });
    this.dropQueue(`${message}\n`);
    this.setState("idle");
  }

  private dropQueue(stderr: string): void {
    const q = this.queue;
    this.queue = [];
    for (const job of q) job.resolve({ stdout: "", stderr, status: "error", durationMs: 0 });
  }

  private onMessage(w: WorkerLike, msg: FromWorker): void {
    if (this.worker !== w || !msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "state":
        if (msg.state === "idle" && !this.ready) {
          this.ready = true;
          this.pump();
        }
        return;
      case "loadError":
        this.fail(w, msg.message);
        return;
      case "result":
        if (!this.current || msg.id !== this.current.id) return;
        this.finish({ stdout: String(msg.stdout ?? ""), stderr: String(msg.stderr ?? ""), status: msg.status === "ok" ? "ok" : "error" });
        this.pump();
        return;
    }
  }

  /** Start the next queued run when the worker is free and ready; keep the state in step. */
  private pump(): void {
    if (this.disposed) return;
    if (this.current) return this.setState("running");
    if (this.queue.length === 0) return this.setState(this.worker && !this.ready ? "loading" : "idle");
    const w = this.worker ?? this.spawn();
    if (!this.ready) return this.setState("loading");
    const job = this.queue.shift()!;
    const id = this.nextId++;
    const timer = setTimeout(() => this.timeout(), job.timeoutMs);
    this.current = { job, id, started: now(), timer };
    this.setState("running");
    w.postMessage({ type: "run", id, code: job.code });
  }

  private timeout(): void {
    const cur = this.current;
    if (!cur) return;
    this.kill();
    this.finish({ stdout: "", stderr: `${i18n.t("code.timedOut", { seconds: Math.round(cur.job.timeoutMs / 100) / 10 })}\n`, status: "timeout" });
    // Restart at once so the next run finds a fresh worker (Python starts reloading).
    if (!this.disposed) this.spawn();
    this.pump();
  }

  async run(code: string, opts: { timeoutMs?: number } = {}): Promise<RunResult> {
    if (this.disposed) return { stdout: "", stderr: `${i18n.t("code.stopped")}\n`, status: "error", durationMs: 0 };
    let source = code;
    if (this.language === "typescript") {
      try {
        source = await transpileTs(code);
      } catch (err) {
        return { stdout: "", stderr: `${err instanceof Error ? err.message : String(err)}\n`, status: "error", durationMs: 0 };
      }
    }
    return new Promise<RunResult>((resolve) => {
      this.queue.push({ code: source, timeoutMs: opts.timeoutMs ?? RUN_TIMEOUT_MS, resolve });
      this.pump();
    });
  }

  stop(): void {
    const busy = this.current !== null || this.queue.length > 0;
    if (!busy) return;
    const stopped = `${i18n.t("code.stopped")}\n`;
    const wasLoading = !this.current;
    this.kill();
    this.finish({ stdout: "", stderr: stopped, status: "error" });
    this.dropQueue(stopped);
    // A stopped Python download is abandoned; a stopped run gets a fresh worker for the next one.
    if (!wasLoading && !this.disposed) this.spawn();
    this.pump();
  }

  reset(): void {
    if (this.current || this.queue.length > 0) {
      this.stop();
      this.kill();
      this.pump();
      return;
    }
    if (this.worker && this.ready) this.worker.postMessage({ type: "reset" });
  }

  dispose(): void {
    if (this.disposed) return;
    const stopped = `${i18n.t("code.stopped")}\n`;
    this.kill();
    this.finish({ stdout: "", stderr: stopped, status: "error" });
    this.dropQueue(stopped);
    this.disposed = true;
    this._state = "idle";
    for (const fn of [...this.listeners]) fn();
    this.listeners.clear();
  }
}

const registry = new Map<string, WorkerRuntime>();
const keyOf = (language: RunnableLanguage, scope: string) => `${scope}\u0000${language}`;

/** The runtime of `language` for page `scope` (created idle; its worker starts on the first run). */
export function getRuntime(language: RunnableLanguage, scope = ""): Runtime {
  const key = keyOf(language, scope);
  let rt = registry.get(key);
  if (!rt) {
    rt = new WorkerRuntime(language);
    registry.set(key, rt);
  }
  return rt;
}

/** Reset the runtime of `language` for `scope` (when it exists). */
export function resetRuntime(language: RunnableLanguage, scope = ""): void {
  registry.get(keyOf(language, scope))?.reset();
}

/** Terminate and forget every runtime of page `scope`. */
export function disposeScope(scope: string): void {
  for (const [key, rt] of registry) {
    if (key.startsWith(`${scope}\u0000`)) {
      rt.dispose();
      registry.delete(key);
    }
  }
}

/** Terminate and forget every runtime. */
export function disposeAll(): void {
  for (const rt of registry.values()) rt.dispose();
  registry.clear();
}

/** Scopes (pages) that have runtimes. */
export function liveScopes(): string[] {
  return [...new Set([...registry.keys()].map((k) => k.slice(0, k.indexOf("\u0000"))))];
}

/** Dispose the runtimes of every page not in `open` (page ids shown in a tab). */
export function disposeClosedPages(open: ReadonlySet<string>): void {
  for (const scope of liveScopes()) if (!open.has(scope)) disposeScope(scope);
}
