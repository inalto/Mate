// Lazy Compute Engine: the engine is a large module, so it lives in its own chunk, loaded on first
// need (`loadEngine`, cached). Synchronous callers use `engineSync`, which is null until it loaded.
import type { ComputeEngine } from "@cortex-js/compute-engine";

export type EngineModule = typeof import("@cortex-js/compute-engine");

export interface Engine {
  ce: ComputeEngine;
  mod: EngineModule;
}

let ready: Engine | null = null;
let loading: Promise<ComputeEngine> | null = null;

/** Load the engine chunk (once) and resolve with the shared engine. */
export function loadEngine(): Promise<ComputeEngine> {
  loading ??= import("@cortex-js/compute-engine").then((mod) => {
    ready = { ce: new mod.ComputeEngine(), mod };
    return ready.ce;
  }).catch((err: unknown) => {
    loading = null; // allow a retry
    throw err;
  });
  return loading;
}

/** The loaded engine, or null while its chunk has not loaded yet. */
export const engineSync = (): Engine | null => ready;
