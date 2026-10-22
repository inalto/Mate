// Write-behind queue for element persistence: coalesces per id, flushes 150 ms after the last
// enqueue (or immediately at 200 pending), serialises flushes, retries a failed write once.
import type { Element } from "../model/types";
import * as ipc from "./elements";

export interface ElementsIpc {
  upsertElements(els: Element[]): Promise<void>;
  deleteElements(ids: string[]): Promise<void>;
}

export interface ElementsQueue {
  enqueueUpsert(el: Element): void;
  enqueueDelete(id: string): void;
  /** Write everything pending now; resolves once written (never rejects). */
  flushAll(): Promise<void>;
  /** Items not yet written (queued or in flight). */
  pending(): number;
  /** Items whose write and retry both failed; they stay queued for the next flush. */
  failed(): number;
}

type Op = { kind: "upsert"; el: Element } | { kind: "delete" };

export const FLUSH_DELAY_MS = 150;
export const FLUSH_AT_PENDING = 200;

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
  const failedIds = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const attempt = async (fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch {
      try {
        await fn();
        return true;
      } catch (err) {
        console.error("element write failed after retry", err);
        return false;
      }
    }
  };

  /** Put failed ops back unless a newer op for the same id was queued meanwhile. */
  const requeue = (ops: [string, Op][]) => {
    for (const [id, op] of ops) {
      if (!queued.has(id)) queued.set(id, op);
      failedIds.add(id);
    }
  };

  const flushOnce = async () => {
    if (queued.size === 0) return;
    const batch = queued;
    queued = new Map();
    inFlight = batch.size;
    const upserts: [string, Op][] = [];
    const deletes: [string, Op][] = [];
    for (const entry of batch) (entry[1].kind === "upsert" ? upserts : deletes).push(entry);
    try {
      // Deletes first: a net-neutral batch at the per-page element limit (partial erase: delete 1,
      // add 2) must not transiently exceed it in the backend count.
      if (deletes.length > 0) {
        const ids = deletes.map(([id]) => id);
        if (await attempt(() => io.deleteElements(ids))) ids.forEach((id) => failedIds.delete(id));
        else requeue(deletes);
      }
      if (upserts.length > 0) {
        const els = upserts.map(([, op]) => (op as { el: Element }).el);
        if (await attempt(() => io.upsertElements(els))) upserts.forEach(([id]) => failedIds.delete(id));
        else requeue(upserts);
      }
    } finally {
      inFlight = 0;
    }
  };

  const flush = (): Promise<void> => {
    clearTimer();
    chain = chain.then(flushOnce, flushOnce);
    return chain;
  };

  const schedule = () => {
    if (queued.size >= maxPending) {
      void flush();
      return;
    }
    clearTimer();
    timer = setTimeout(() => void flush(), delay);
  };

  return {
    enqueueUpsert(el) {
      queued.set(el.id, { kind: "upsert", el });
      schedule();
    },
    enqueueDelete(id) {
      queued.set(id, { kind: "delete" });
      schedule();
    },
    flushAll: () => flush(),
    pending: () => queued.size + inFlight,
    failed: () => failedIds.size,
  };
}

/** The app-wide queue. */
export const elementsQueue: ElementsQueue = createElementsQueue();
