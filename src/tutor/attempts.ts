// Check attempts per revision and the "live checking is blocked" state (rejected key, billing,
// unknown model). Kept free of heavy imports so settings code can clear the block cheaply.
import { useSettingsStore } from "../stores/settings";

export const MAX_ATTEMPTS_PER_REVISION = 3;

export type BlockKind = "auth" | "billing" | "unknownModel";

export interface AttemptLedger {
  count(revision: string): number;
  add(revision: string): number;
  reset(revision: string): void;
  /** No more attempts for this revision (non-retryable failure). */
  exhaust(revision: string): void;
  /** Set while live checking is blocked until the key, provider or model changes. */
  block: { kind: BlockKind; reason: string } | null;
  setBlock(kind: BlockKind, reason: string): void;
  /** Call when the key, provider, model or consent changes. */
  clearAuthBlock(): void;
}

const LEDGER_LIMIT = 2000;

export function createAttemptLedger(): AttemptLedger {
  const counts = new Map<string, number>();
  const set = (rev: string, n: number) => {
    counts.delete(rev);
    counts.set(rev, n);
    if (counts.size > LEDGER_LIMIT) counts.delete(counts.keys().next().value!);
    return n;
  };
  return {
    count: (rev) => counts.get(rev) ?? 0,
    add: (rev) => set(rev, (counts.get(rev) ?? 0) + 1),
    reset: (rev) => void counts.delete(rev),
    exhaust: (rev) => void set(rev, MAX_ATTEMPTS_PER_REVISION),
    block: null,
    setBlock(kind, reason) {
      this.block = { kind, reason };
    },
    clearAuthBlock() {
      this.block = null;
    },
  };
}

/** Shared ledger for the app session (all editor panes use it). */
export const sessionAttempts = createAttemptLedger();

/**
 * A changed provider, model or consent may fix a rejected key: allow checks again. Subscribed once
 * for the app (not per editor), so a fix made in Settings applies even with no page open.
 */
useSettingsStore.subscribe((s, prev) => {
  const a = s.settings;
  const b = prev.settings;
  if (a.aiProvider !== b.aiProvider || a.aiModel !== b.aiModel || a.aiConsent !== b.aiConsent) sessionAttempts.clearAuthBlock();
});

const keyListeners = new Set<() => void>();

/** Run `cb` after an API key is saved or removed. Returns an unsubscribe. */
export function onKeyChanged(cb: () => void): () => void {
  keyListeners.add(cb);
  return () => keyListeners.delete(cb);
}

/** Called by src/ipc/ai after a key was saved or removed. */
export function notifyKeyChanged(): void {
  for (const cb of keyListeners) cb();
}
