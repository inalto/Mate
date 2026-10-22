import { describe, expect, it } from "vitest";
import { mapInkColor } from "../theme";

describe("mapInkColor", () => {
  it("black_maps_to_white_in_dark", () => {
    expect(mapInkColor("#000000", "dark")).toBe("#FFFFFF");
    expect(mapInkColor("#000000", "high-contrast")).toBe("#FFFFFF");
  });

  it("#C62828_maps_to_#FF3B3B", () => {
    expect(mapInkColor("#C62828", "dark")).toBe("#FF3B3B");
    expect(mapInkColor("#c62828", "dark")).toBe("#FF3B3B");
    expect(mapInkColor("#1565C0", "dark")).toBe("#6AA9FF");
  });

  it("unknown_mid_grey_unchanged", () => {
    expect(mapInkColor("#808080", "dark")).toBe("#808080");
    expect(mapInkColor("red", "dark")).toBe("red");
  });

  it("near_black_flips", () => {
    expect(mapInkColor("#101010", "dark")).toBe("#FFFFFF");
    expect(mapInkColor("#F0F0F0", "dark")).toBe("#000000");
  });

  it("light_is_identity", () => {
    expect(mapInkColor("#000000", "light")).toBe("#000000");
    expect(mapInkColor("#C62828", "light")).toBe("#C62828");
    expect(mapInkColor("#101010", "sepia")).toBe("#101010");
  });
});
