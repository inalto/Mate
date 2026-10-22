import { describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ evaluated: false }));
vi.mock("@cortex-js/compute-engine", async (importOriginal) => {
  probe.evaluated = true;
  return importOriginal();
});

import { engineSync, loadEngine } from "../engine";
import { parseExpressionSync } from "../expressions";

describe("engine", () => {
  it("engine_loads_lazily", async () => {
    // Importing the graph modules does not evaluate the Compute Engine.
    expect(probe.evaluated).toBe(false);
    expect(engineSync()).toBeNull();
    // A sync parse before the load answers pending (and starts the load).
    expect(parseExpressionSync("x^2")).toEqual({ pending: true });
    const ce = await loadEngine();
    expect(probe.evaluated).toBe(true);
    expect(engineSync()?.ce).toBe(ce);
    expect(await loadEngine()).toBe(ce); // cached
    expect("kind" in parseExpressionSync("x^2")).toBe(true);
  });
});
