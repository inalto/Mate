// When the webview's Content Security Policy forbids `new Function`, the engine's compile throws
// an EvalError: the editor must say so instead of the generic "cannot be plotted".
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@cortex-js/compute-engine", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@cortex-js/compute-engine")>();
  return {
    ...mod,
    compile: () => {
      throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source");
    },
  };
});

import { loadEngine } from "../engine";
import { EVAL_BLOCKED, parseExpressionSync } from "../expressions";

describe("parseExpression when eval is blocked", () => {
  beforeAll(async () => {
    await loadEngine();
  });

  it("names_the_security_policy", () => {
    const p = parseExpressionSync("y = x^2");
    expect(p).toEqual({ error: EVAL_BLOCKED });
  });
});
