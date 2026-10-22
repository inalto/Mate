import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, LIMITS } from "../../model/constants";

describe("constants", () => {
  it("DEFAULT_SETTINGS matches spec", () => {
    expect(DEFAULT_SETTINGS.defaultPenWidth).toBe(4.11);
    expect(Object.keys(DEFAULT_SETTINGS).length).toBeGreaterThanOrEqual(45);
    expect(DEFAULT_SETTINGS.toolbarPresets).toHaveLength(5);
  });
  it("LIMITS", () => {
    expect(LIMITS.MAX_ELEMENTS_PER_PAGE).toBe(5000);
    expect(LIMITS.MAX_POINTS_PER_STROKE).toBe(50000);
  });
});
