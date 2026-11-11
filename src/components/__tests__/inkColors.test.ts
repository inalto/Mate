import { describe, expect, it } from "vitest";
import { MAX_SWATCHES, withSwatch } from "../inkColors";

describe("withSwatch", () => {
  it("appends_a_new_hex_in_upper_case", () => {
    expect(withSwatch(["#000000"], "#1b8e3e")).toEqual(["#000000", "#1B8E3E"]);
  });
  it("keeps_the_same_list_for_a_duplicate_a_bad_value_or_a_full_shelf", () => {
    const list = ["#000000"];
    expect(withSwatch(list, "#000000")).toBe(list);
    expect(withSwatch(list, "red")).toBe(list);
    const full = Array.from({ length: MAX_SWATCHES }, (_, i) => `#0000${i.toString(16).padStart(2, "0").toUpperCase()}`);
    expect(withSwatch(full, "#FFFFFF")).toBe(full);
  });
});
