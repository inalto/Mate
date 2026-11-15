import { describe, expect, it } from "vitest";
import { requestRun, takeRun } from "../pendingRun";

describe("pendingRun", () => {
  it("takeRun is true once, then cleared", () => {
    requestRun("p1");
    expect(takeRun("p1")).toBe(true);
    expect(takeRun("p1")).toBe(false);
  });

  it("a request is for its own page only", () => {
    requestRun("p1");
    expect(takeRun("p2")).toBe(false);
    expect(takeRun("p1")).toBe(true);
  });
});
