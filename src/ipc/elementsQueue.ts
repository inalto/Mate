// Write-behind queue for element persistence: coalesces per id, flushes 150 ms after the last
// enqueue (or immediately at 200 pending), serialises flushes, retries a failed write once.
// A batch that still fails is retried page by page, so one bad element cannot block other pages;
// ops that fail even then are parked in `failed`, which regular batches never carry, and retried
// with exponential backoff (1 s, 2 s, 4 s … 60 s) and on every `flushAll()`.
import type { Element } from "../model/types";
import * as ipc from "./elements";

export interface ElementsIpc {
  upsertElements(els: Element[]): Promise<void>;
  deleteElements(ids: string[]): Promise<void>;
}

export type QueuedOp = { op: "upsert"; element: Element } | { op: "delete"; id: string; pageId?: string };

export interface QueueStatus {
  /** Items not yet written (queued, in flight or failed). */
  pending: number;
  /** Items whose writes keep failing (retried with backoff). */
  failed: number;
}

export interface ElementsQueue {
  enqueueUpsert(el: Element): void;
  /** `pageId` lets a failed delete be retried with its page's batch. */
  enqueueDelete(id: string, pageId?: string): void;
  /** Write everything pending now, including failed items; resolves once tried (never rejects). */
  flushAll(): Promise<void>;
  /** Items not yet written (queued, in flight or failed). */
  pending(): number;
  /** Items whose write, retry and per-page retry all failed; retried with backoff. */
  failed(): number;
  /** Unwritten ops: `failed` are those parked after failing, `pending` the rest. */
  snapshot(): { pending: QueuedOp[]; failed: QueuedOp[] };
  /** Called whenever pending/failed counts change; returns an unsubscribe function. */
  onStatus(cb: (s: QueueStatus) => void): () => void;
}

type Op = { kind: "upsert"; el: Element } | { kind: "delete"; pageId: string };
type Entry = [string, Op];

export const FLUSH_DELAY_MS = 150;
export const FLUSH_AT_PENDING = 200;
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 60_000;

const pageOf = (op: Op): string => (op.kind === "upsert" ? op.el.pageId : op.pageId);

export function createElementsQueue(
  io: ElementsIpc = {
    upsertElements: (els) => ipc.upsertElements(els),
    deleteElements: (ids) => ipc.deleteElements(ids),
  },
  opts: { delayMs?: number; maxPending?: number } = {},
): ElementsQueue {
  const delay = opts.delayMs ?? FLUSH_DELAY_MS;
  const maxPending = opts.maxPending ?? FLUSH_AT_PENDING;
  let queued = new Map<string, Op>();
  let inFlight = 0;
  const failedOps = new Map<string, Op>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = RETRY_BASE_MS;
  let chain: Promise<void> = Promise.resolve();
  const listeners = new Set<(s: QueueStatus) => void>();
  let lastStatus = "";

  const pending = () => queued.size + inFlight + failedOps.size;
  const emit = () => {
    const status = { pending: pending(), failed: failedOps.size };
    const key = `${status.pending}:${status.failed}`;
    if (key === lastStatus) return;
    lastStatus = key;
    for (const cb of listeners) cb(status);
  };

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const tryWrite = async (fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (err) {
      console.error("element write failed", err);
      return false;
    }
  };
  const attempt = async (fn: () => Promise<void>): Promise<boolean> =>
    (await tryWrite(fn)) || (await tryWrite(fn));

  /** Write `entries`, deletes first: a net-neutral batch at the per-page element limit (partial
   * erase: delete 1, add 2) must not transiently exceed it in the backend count. */
  const write = async (entries: Entry[], tries: (fn: () => Promise<void>) => Promise<boolean>): Promise<boolean> => {
    const ids = entries.filter(([, op]) => op.kind === "delete").map(([id]) => id);
    const els = entries.flatMap(([, op]) => (op.kind === "upsert" ? [op.el] : []));
    if (ids.length > 0 && !(await tries(() => io.deleteElements(ids)))) return false;
    if (els.length > 0 && !(await tries(() => io.upsertElements(els)))) return false;
    return true;
  };

  const byPage = (entries: Entry[]): Entry[][] => {
    const groups = new Map<string, Entry[]>();
    for (const e of entries) {
      const k = pageOf(e[1]);
      const g = groups.get(k);
      if (g) g.push(e);
      else groups.set(k, [e]);
    }
    return [...groups.values()];
  };

  const scheduleRetry = () => {
    if (failedOps.size === 0) {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      backoff = RETRY_BASE_MS;
      return;
    }
    if (retryTimer !== null) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      chain = chain.then(retryFailed, retryFailed).then(emit);
    }, wait);
  };

  /** Retry parked ops page by page; ops superseded meanwhile (newer enqueue) are dropped. */
  const retryFailed = async () => {
    if (failedOps.size === 0) return;
    for (const group of byPage([...failedOps])) {
      if (await write(group, tryWrite)) {
        for (const [id, op] of group) if (failedOps.get(id) === op) failedOps.delete(id);
      }
    }
    scheduleRetry();
  };

  const flushQueued = async () => {
    if (queued.size === 0) return;
    const batch = [...queued];
    queued = new Map();
    inFlight = batch.length;
    try {
      if (await write(batch, attempt)) return;
      // The batch failed twice: retry each page on its own and park what still fails.
      for (const group of byPage(batch)) {
        if (await write(group, tryWrite)) continue;
        for (const [id, op] of group) if (!queued.has(id)) failedOps.set(id, op);
      }
    } finally {
      inFlight = 0;
    }
    scheduleRetry();
  };

  const run = (job: () => Promise<void>): Promise<void> => {
    chain = chain.then(job, job).then(emit);
    return chain;
  };

  const flush = (): Promise<void> => {
    clearTimer();
    return run(flushQueued);
  };

  const schedule = () => {
    emit();
    if (queued.size >= maxPending) {
      void flush();
      return;
    }
    clearTimer();
    timer = setTimeout(() => void flush(), delay);
  };

  const enqueue = (id: string, op: Op) => {
    failedOps.delete(id); // a newer write supersedes a parked one
    queued.set(id, op);
    schedule();
  };

  return {
    enqueueUpsert: (el) => enqueue(el.id, { kind: "upsert", el }),
    enqueueDelete: (id, pageId = "") => enqueue(id, { kind: "delete", pageId }),
    flushAll() {
      clearTimer();
      // Parked ops are older than anything queued: retry them first.
      return run(async () => {
        await retryFailed();
        await flushQueued();
      });
    },
    pending,
    failed: () => failedOps.size,
    snapshot() {
      const toItem = ([id, o]: Entry): QueuedOp =>
        o.kind === "upsert" ? { op: "upsert", element: o.el } : { op: "delete", id, pageId: o.pageId || undefined };
      return { pending: [...queued].map(toItem), failed: [...failedOps].map(toItem) };
    },
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** The app-wide queue. */
export const elementsQueue: ElementsQueue = createElementsQueue();
