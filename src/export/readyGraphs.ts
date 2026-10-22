// Graphs draw from the lazily loaded math engine: before a page is exported or thumbnailed, wait for
// it so no "Loading…" graph frame is captured.
import { loadEngine } from "../graph/engine";
import type { Element } from "../model/types";

/** Resolve once the math engine has loaded when any of `elements` is a live graph. */
export async function readyGraphs(elements: Iterable<Element>): Promise<void> {
  for (const el of elements) {
    if (el.type === "graph" && !el.deletedAt) {
      await loadEngine();
      return;
    }
  }
}
