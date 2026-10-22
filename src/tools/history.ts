// Undo/redo history of element actions. Entries are evicted oldest-first beyond 100 entries or
// 50 MiB (JSON.stringify length as the byte estimate); the newest entry is always kept.
import type { Element } from "../model/types";

export type Action =
  | { type: "add"; el: Element }
  | { type: "delete"; el: Element }
  | { type: "update"; before: Element; after: Element };

export interface HistoryEntry {
  label: string;
  actions: Action[];
  /** Consecutive pushes with the same key merge into one entry (e.g. a width slider drag). */
  mergeKey?: string;
}

export const HISTORY_MAX_ENTRIES = 100;
export const HISTORY_MAX_BYTES = 50 * 1024 * 1024;

interface Stored {
  entry: HistoryEntry;
  bytes: number;
}

const sizeOf = (e: HistoryEntry): number => JSON.stringify(e.actions).length + e.label.length;

export function invertAction(a: Action): Action {
  switch (a.type) {
    case "add":
      return { type: "delete", el: a.el };
    case "delete":
      return { type: "add", el: a.el };
    case "update":
      return { type: "update", before: a.after, after: a.before };
  }
}

/** Merge `next` into `prev`: updates keep the earliest `before` and the latest `after` per id. */
function mergeActions(prev: Action[], next: Action[]): Action[] {
  const out = [...prev];
  for (const a of next) {
    const i = a.type === "update" ? out.findIndex((p) => p.type === "update" && p.after.id === a.before.id) : -1;
    if (i >= 0) out[i] = { type: "update", before: (out[i] as { before: Element }).before, after: (a as { after: Element }).after };
    else out.push(a);
  }
  return out;
}

export class History {
  private undoStack: Stored[] = [];
  private redoStack: Stored[] = [];
  private total = 0;

  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(maxEntries = HISTORY_MAX_ENTRIES, maxBytes = HISTORY_MAX_BYTES) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  /** Entries available to undo. */
  get size(): number {
    return this.undoStack.length;
  }

  /** Estimated bytes held by both stacks. */
  get bytes(): number {
    return this.total;
  }

  push(entry: HistoryEntry): void {
    if (entry.actions.length === 0) return;
    this.clearRedo();
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && entry.mergeKey !== undefined && top.entry.mergeKey === entry.mergeKey) {
      this.undoStack.pop();
      this.total -= top.bytes;
      entry = { ...entry, actions: mergeActions(top.entry.actions, entry.actions) };
    }
    const bytes = sizeOf(entry);
    this.undoStack.push({ entry, bytes });
    this.total += bytes;
    this.evict();
  }

  /** Inverse actions of the newest entry (in reverse order), or null when there is nothing to undo. */
  undo(): Action[] | null {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push(s);
    return s.entry.actions.map(invertAction).reverse();
  }

  /** What `undo()` would return, without changing the stacks. */
  peekUndo(): Action[] | null {
    const s = this.undoStack[this.undoStack.length - 1];
    return s ? s.entry.actions.map(invertAction).reverse() : null;
  }

  /** What `redo()` would return, without changing the stacks. */
  peekRedo(): Action[] | null {
    const s = this.redoStack[this.redoStack.length - 1];
    return s ? [...s.entry.actions] : null;
  }

  /** Actions of the most recently undone entry, or null. */
  redo(): Action[] | null {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push(s);
    return [...s.entry.actions];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.total = 0;
  }

  private clearRedo(): void {
    for (const s of this.redoStack) this.total -= s.bytes;
    this.redoStack = [];
  }

  private evict(): void {
    while (
      this.undoStack.length > 1 &&
      (this.undoStack.length > this.maxEntries || this.total > this.maxBytes)
    ) {
      this.total -= this.undoStack.shift()!.bytes;
    }
  }
}
